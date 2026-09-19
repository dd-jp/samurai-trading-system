import { crc32, inflateRawSync } from 'node:zlib';
import { TokenBucket } from '../../../shared/index.js';
import { allWatchedThemes } from './gdelt-themes.js';

const DEFAULT_BASE_URL = 'https://data.gdeltproject.org/gdeltv2';

const REQUEST_TIMEOUT_MS = 90_000;

function requestInit(): RequestInit {
  return { redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
}

const DEFAULT_PACING = { capacity: 2, refillPerSecond: 0.2 } as const;

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

const MAX_INFLATED_BYTES = 512 * 1024 * 1024;

const MAX_MANIFEST_BYTES = 64 * 1024;

const COL = {
  recordId: 0,
  date: 1,
  sourceName: 3,
  documentUrl: 4,
  themes: 7,
  tone: 15,
} as const;

const MIN_COLUMNS = COL.tone + 1;

export interface GdeltGkgRecord {
  native_id: string;
  batch_time: Date;
  source_name: string;
  document_url: string;
  themes: string[];
  tone: number;
  payload: string;
}

export const PROJECTED_COLUMNS = [
  COL.recordId,
  COL.date,
  COL.sourceName,
  COL.documentUrl,
  COL.themes,
  COL.tone,
] as const;

export interface GdeltGkgBatch {
  batch_time: Date;
  file_url: string;
  records: GdeltGkgRecord[];
  scanned: number;
}

export interface GdeltGkgClientOptions {
  baseUrl?: string | undefined;
  fetchImpl?: typeof fetch;
  rateLimiter?: TokenBucket;
  themes?: readonly string[] | undefined;
}

function isValidCivilComponents(
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  return hour <= 23 && minute <= 59 && second <= 59;
}

function parseGdeltStamp(stamp: string): Date | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(stamp);
  if (match === null) return undefined;
  const [, y, mo, d, h, mi, s] = match;
  const [year, month, day, hour, minute, second] = [y, mo, d, h, mi, s].map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (!isValidCivilComponents(month, day, hour, minute, second)) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : undefined;
}

export function batchTimeFromUrl(fileUrl: string): Date | undefined {
  const stamp = /(\d{14})\.gkg\.csv\.zip$/.exec(fileUrl)?.[1];
  return stamp === undefined ? undefined : parseGdeltStamp(stamp);
}

const DATA_DESCRIPTOR_FLAG = 0x0008;

function unzipFirstEntry(buffer: Buffer): string {
  if (buffer.length < 30 || buffer.readUInt32LE(0) !== 0x04034b50) {
    throw new Error('GdeltGkgClient: response is not a zip archive (bad local file header).');
  }
  const generalPurposeFlag = buffer.readUInt16LE(6);
  if ((generalPurposeFlag & DATA_DESCRIPTOR_FLAG) !== 0) {
    throw new Error(
      'GdeltGkgClient: zip entry uses a streaming data descriptor (general purpose bit 3); ' +
        'this decoder does not read the trailing descriptor, so the local header carries no ' +
        'CRC-32 to verify against.',
    );
  }
  const method = buffer.readUInt16LE(8);
  const declaredCrc = buffer.readUInt32LE(14);
  const nameLength = buffer.readUInt16LE(26);
  const extraLength = buffer.readUInt16LE(28);
  const body = buffer.subarray(30 + nameLength + extraLength);

  let inflated: Buffer;
  if (method === 8) {
    inflated = inflateRawSync(body, { maxOutputLength: MAX_INFLATED_BYTES });
  } else if (method === 0) {
    const compressedSize = buffer.readUInt32LE(18);
    if (compressedSize === 0) {
      throw new Error(
        'GdeltGkgClient: stored zip entry declares no compressed size (streamed data descriptor).',
      );
    }
    if (compressedSize > body.length) {
      throw new Error(
        `GdeltGkgClient: stored zip entry declares ${compressedSize} bytes but only ` +
          `${body.length} remain — the archive is truncated.`,
      );
    }
    inflated = body.subarray(0, compressedSize);
  } else {
    throw new Error(
      `GdeltGkgClient: unsupported zip compression method ${method} (expected 8 deflate or 0 stored).`,
    );
  }

  const actualCrc = crc32(inflated);
  if (actualCrc !== declaredCrc) {
    throw new Error(
      `GdeltGkgClient: inflated entry's CRC-32 (0x${actualCrc.toString(16)}) does not match the ` +
        `zip local header's declared CRC-32 (0x${declaredCrc.toString(16)}) — the archive is ` +
        'corrupt — truncated or mangled in transit. NOT a tamper check: a CRC-32 is ' +
        'recomputable, so an attacker who could rewrite the bytes could rewrite this too. ' +
        'Authenticity is the host pin’s job (`pinToBaseUrl`), not this comparison’s.',
    );
  }

  return inflated.toString('utf8');
}

function fieldAt(fields: readonly string[], column: number): string {
  return fields[column] ?? '';
}

function themesOf(rawThemes: string): string[] {
  return rawThemes.split(';').filter((theme) => theme.length > 0);
}

function matchesWatchedTheme(lineThemes: readonly string[], themes: ReadonlySet<string>): boolean {
  return lineThemes.some((theme) => themes.has(theme));
}

function parseTone(rawTone: string): number {
  return Number.parseFloat(rawTone.split(',')[0] ?? '');
}

function payloadOf(fields: readonly string[]): string {
  return PROJECTED_COLUMNS.map((column) => fieldAt(fields, column)).join('\t');
}

function parseGkgLine(
  line: string,
  themes: ReadonlySet<string>,
  batchTime: Date,
): GdeltGkgRecord | null {
  const fields = line.split('\t');
  if (fields.length < MIN_COLUMNS) return null;

  const lineThemes = themesOf(fieldAt(fields, COL.themes));
  if (!matchesWatchedTheme(lineThemes, themes)) return null;

  const tone = parseTone(fieldAt(fields, COL.tone));
  if (!Number.isFinite(tone)) return null;

  const nativeId = fieldAt(fields, COL.recordId);
  if (nativeId.length === 0) return null;

  return {
    native_id: nativeId,
    batch_time: batchTime,
    source_name: fieldAt(fields, COL.sourceName),
    document_url: fieldAt(fields, COL.documentUrl),
    themes: lineThemes,
    tone,
    payload: payloadOf(fields),
  };
}

export class GdeltGkgClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly rateLimiter: TokenBucket;
  private readonly themes: Set<string>;

  constructor(options: GdeltGkgClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.rateLimiter = options.rateLimiter ?? new TokenBucket(DEFAULT_PACING);
    this.themes = new Set(options.themes ?? allWatchedThemes());
  }

  async latestBatchUrl(signal?: AbortSignal): Promise<string> {
    await this.rateLimiter.acquire(signal);
    const response = await this.fetchImpl(`${this.baseUrl}/lastupdate.txt`, requestInit());
    if (!response.ok) {
      throw new Error(
        `GdeltGkgClient: lastupdate.txt returned HTTP ${response.status} ${response.statusText}.`,
      );
    }
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_MANIFEST_BYTES) {
      throw new Error(
        `GdeltGkgClient: lastupdate.txt declares ${declaredLength} bytes, above the ` +
          `${MAX_MANIFEST_BYTES} ceiling — refusing to read it.`,
      );
    }
    const text = await response.text();
    const textBytes = Buffer.byteLength(text, 'utf8');
    if (textBytes > MAX_MANIFEST_BYTES) {
      throw new Error(
        `GdeltGkgClient: lastupdate.txt is ${textBytes} bytes, above the ${MAX_MANIFEST_BYTES} ` +
          'ceiling — refusing to parse it.',
      );
    }
    for (const line of text.split('\n')) {
      const url = line.trim().split(/\s+/).at(2);
      if (url?.endsWith('.gkg.csv.zip') === true) return this.pinToBaseUrl(url);
    }
    throw new Error(
      `GdeltGkgClient: lastupdate.txt carried no .gkg.csv.zip entry. Got: ${text.slice(0, 200)}`,
    );
  }

  private pinToBaseUrl(fileUrl: string): string {
    const base = new URL(this.baseUrl);
    let named: URL;
    try {
      named = new URL(fileUrl);
    } catch {
      throw new Error(`GdeltGkgClient: lastupdate.txt named an unparseable URL: ${fileUrl}`);
    }
    if (named.host !== base.host) {
      throw new Error(
        `GdeltGkgClient: lastupdate.txt named host ${named.host}, expected ${base.host} — ` +
          'refusing to download a batch from a host we did not configure.',
      );
    }
    return `${base.protocol}//${base.host}${named.pathname}`;
  }

  async fetchBatch(fileUrl: string, signal?: AbortSignal): Promise<GdeltGkgBatch> {
    const url = this.pinToBaseUrl(fileUrl);
    const batchTime = batchTimeFromUrl(url);
    if (batchTime === undefined) {
      throw new Error(`GdeltGkgClient: cannot read a batch timestamp from ${url}.`);
    }

    await this.rateLimiter.acquire(signal);
    const response = await this.fetchImpl(url, requestInit());
    if (!response.ok) {
      throw new Error(
        `GdeltGkgClient: ${url} returned HTTP ${response.status} ${response.statusText}.`,
      );
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_ARCHIVE_BYTES) {
      throw new Error(
        `GdeltGkgClient: ${url} declares ${declared} bytes, above the ${MAX_ARCHIVE_BYTES} ` +
          'ceiling — refusing to download it inside a tick.',
      );
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_ARCHIVE_BYTES) {
      throw new Error(
        `GdeltGkgClient: ${url} is ${buffer.length} bytes, above the ${MAX_ARCHIVE_BYTES} ` +
          'ceiling — refusing to buffer it inside a tick.',
      );
    }

    const csv = unzipFirstEntry(buffer);
    return this.parseBatch(csv, batchTime, url);
  }

  async fetchLatestBatch(signal?: AbortSignal): Promise<GdeltGkgBatch> {
    return this.fetchBatch(await this.latestBatchUrl(signal), signal);
  }

  parseBatch(csv: string, batchTime: Date, fileUrl: string): GdeltGkgBatch {
    const records: GdeltGkgRecord[] = [];
    let scanned = 0;

    for (const line of csv.split('\n')) {
      if (line.length === 0) continue;
      scanned++;
      const record = parseGkgLine(line, this.themes, batchTime);
      if (record !== null) records.push(record);
    }

    return { batch_time: batchTime, file_url: fileUrl, records, scanned };
  }
}
