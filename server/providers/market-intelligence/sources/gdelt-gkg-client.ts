/**
 * GDELT GKG 2.1 — the 15-minute macro tone fetcher. A 3x FTSE ETP has no
 * company news (the Benzinga wire returns zero items for it); what moves it
 * is macro, which is this module's job.
 *
 * Fetches the 15-minute GKG batch files rather than GDELT's DOC API: the DOC
 * API is undocumented, unversioned and rate-limited with no stability
 * contract, while GKG batches are flat files at a deterministic timestamped
 * URL, published on a fixed cadence, permanently retrievable.
 *
 * Format verified against a live batch rather than the codebook: the zip
 * carries exactly one deflate entry, so `inflateRawSync` past the local
 * header is sufficient with no zip library dependency. The header's CRC-32
 * is checked against the inflated bytes (`unzipFirstEntry`) — chosen over
 * the manifest's md5, which travels the same untrusted channel
 * `pinToBaseUrl` already refuses to trust.
 *
 * Does not score, aggregate, or emit an `IntelligenceItem` — it returns
 * records, and `GdeltIngestAgent` archives the bytes; tone scoring lives in
 * `gdelt-scorer.ts`.
 *
 * `latestBatchUrl`/`fetchBatch`'s `AbortSignal` is threaded ONLY into
 * `this.rateLimiter.acquire(signal)`, never into the request itself: a poll
 * parked on the token bucket can be abandoned for free, but a poll already
 * mid-request is the one whose archive write `GdeltIngestAgent.whenIdle`'s
 * drain exists to order, so it is left to settle on its own. `fetch` cannot
 * distinguish "waiting for headers" from "streaming the body", so composing
 * the two signals would abort an in-flight download too.
 */

import { crc32, inflateRawSync } from 'node:zlib';
import { TokenBucket } from '../../../shared/index.js';
import { allWatchedThemes } from './gdelt-themes.js';

/**
 * HTTPS, not the plain HTTP `lastupdate.txt` itself advertises. GDELT is
 * open data with no credentials to leak, but this feed reaches an analyst
 * and therefore an order — over plain HTTP an on-path attacker rewrites
 * `lastupdate.txt` and chooses both the bytes we score and the host we
 * fetch from. GDELT serves the identical files over TLS, so this costs nothing.
 */
const DEFAULT_BASE_URL = 'https://data.gdeltproject.org/gdeltv2';

/**
 * How long any single GDELT request may stall before it is abandoned. A
 * 3.4MB download is slow but not this slow — without a timeout a half-open
 * connection sits until the OS TCP timeout (minutes), holding a poll open
 * across many ticks. Failing at 90s loses one batch; hanging loses the day's.
 */
const REQUEST_TIMEOUT_MS = 90_000;

/**
 * The request options every GDELT fetch shares: a timeout, and a refusal to
 * follow redirects. `redirect: 'error'` is what keeps `pinToBaseUrl`
 * meaningful — `fetch` follows 3xx by default, so a single redirect from the
 * pinned host would re-target the download anywhere the pin never sees.
 *
 * Built per call, never hoisted to a module constant: `AbortSignal.timeout`
 * starts counting when CREATED, so one shared signal would begin at import
 * and every request after the first 90 seconds of process life would abort
 * instantly.
 */
function requestInit(): RequestInit {
  return { redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
}

/**
 * GDELT publishes one batch per 15 minutes and asks politely for no hammering.
 * Our tick is 15 minutes too, so this only ever has to pass one download.
 */
const DEFAULT_PACING = { capacity: 2, refillPerSecond: 0.2 } as const;

/**
 * Refuse a response larger than this rather than parsing it. A sampled
 * batch is 3.4MB compressed; 64MB is ~19x that, so anything above it is a
 * mis-routed response. Enforced against `content-length` before
 * `arrayBuffer()`, and again against the materialised buffer after, to
 * catch a missing or understated header.
 */
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

/** Guards a decompression bomb: 10.5MB observed, 512MB refused */
const MAX_INFLATED_BYTES = 512 * 1024 * 1024;

/**
 * Refuse a `lastupdate.txt` response larger than this rather than parsing
 * it — mirrors the batch path's two-step guard (`content-length`, then the
 * materialised buffer). The manifest is three `size md5 url` lines in
 * practice (a few hundred bytes), so 64KB is generous.
 */
const MAX_MANIFEST_BYTES = 64 * 1024;

/** GKG 2.1 column indices, named once */
const COL = {
  recordId: 0,
  date: 1,
  sourceName: 3,
  documentUrl: 4,
  themes: 7,
  tone: 15,
} as const;

/** The row is unusable below this many columns */
const MIN_COLUMNS = COL.tone + 1;

/** One GKG document that matched the theme watchlist */
export interface GdeltGkgRecord {
  /** GKGRECORDID, e.g. `20260815153000-0`. Unique within GDELT. */
  native_id: string;
  /**
   * The batch this row was published in — GDELT's knowledge time AND ours,
   * which is why the archive stamps GDELT rows `fidelity: 'live'` even when
   * backfilled (`mi-archive-store.ts:48`)
   */
  batch_time: Date;
  source_name: string;
  document_url: string;
  /** V1THEMES, split. Retains every theme on the row, not just matched ones. */
  themes: string[];
  /** V1.5TONE's first field: average tone, roughly [-100, +100], usually ±10 */
  tone: number;
  /**
   * What the archive stores: the six read columns, tab-joined in column
   * order (`PROJECTED_COLUMNS`), NOT the verbatim 27-column line — a full
   * GKG line averages ~14.9KB (almost all V2ENHANCED* columns nothing here
   * reads) versus ~1.1KB for the projection. Re-derivability survives
   * intact: `native_id` carries the batch stamp as its prefix, so the source
   * file is reconstructible and the dropped columns are re-fetchable.
   */
  payload: string;
}

/**
 * The columns kept in `payload`, in file order. Recorded as a constant because
 * anything re-parsing a stored row must know the projection's shape — the
 * indices here are NOT the GKG indices in `COL`.
 */
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
  /** The timestamped file URL. Recorded so a wider re-derivation can re-fetch. */
  file_url: string;
  /** Rows matching the watchlist */
  records: GdeltGkgRecord[];
  /** Rows in the file before filtering — lets a caller see the match rate */
  scanned: number;
}

export interface GdeltGkgClientOptions {
  baseUrl?: string | undefined;
  fetchImpl?: typeof fetch;
  rateLimiter?: TokenBucket;
  /** Overrides the watchlist; defaults to `allWatchedThemes()` */
  themes?: readonly string[] | undefined;
}

/**
 * `YYYYMMDDHHMMSS` in UTC, GDELT's stamp format for both the file name and
 * column 1. GDELT publishes in UTC and says so; parsing it as local time would
 * shift every timestamp by the host's offset, which on a UK MacBook is a silent
 * one-hour lookahead error for half the year.
 */
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
  // Range-checked BEFORE `Date.UTC`, because `Date.UTC` normalises rather than
  // rejecting: a corrupt stamp would otherwise silently roll forward into a
  // valid but wrong date — a cursor that skips real batches
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(ms);
  // Catches day 31 in a 30-day month, which the coarse range check above lets
  // through and `Date.UTC` rolls into the 1st of the next month
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : undefined;
}

/**
 * The batch time a GKG file URL encodes, or undefined if it encodes none.
 *
 * Exported because the ingest agent needs it to compare a candidate batch
 * against its archive cursor BEFORE paying for the download.
 */
export function batchTimeFromUrl(fileUrl: string): Date | undefined {
  const stamp = /(\d{14})\.gkg\.csv\.zip$/.exec(fileUrl)?.[1];
  return stamp === undefined ? undefined : parseGdeltStamp(stamp);
}

/**
 * The FIRST entry of the zip, which for a GKG batch is the only entry. Reads
 * the local file header and stops — it does not verify the archive holds
 * exactly one member, since a GDELT batch that grew a second member would
 * mean the format changed, and `parseBatch`'s `MIN_COLUMNS` guard is what
 * actually catches a changed schema.
 */
/**
 * General-purpose bit flag bit 3: "sizes and CRC-32 are in a trailing data
 * descriptor, not the local header". When set, the local header's CRC-32
 * field is 0 by construction and would fail every real batch if compared
 * naively, so a set bit has to be refused explicitly. Confirmed unset
 * against a live batch.
 */
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
    // Deflate is self-terminating, so running the subarray past this member's
    // end is harmless — the inflater stops at the stream's end marker
    inflated = inflateRawSync(body, { maxOutputLength: MAX_INFLATED_BYTES });
  } else if (method === 0) {
    // Stored data is NOT self-terminating: `body` runs to the end of the whole
    // buffer, so returning it verbatim appends the central directory and EOCD
    // as binary garbage. The local header's compressed size bounds it; zero
    // there means the size is in a trailing descriptor this decoder can't read.
    const compressedSize = buffer.readUInt32LE(18);
    if (compressedSize === 0) {
      throw new Error(
        'GdeltGkgClient: stored zip entry declares no compressed size (streamed data descriptor).',
      );
    }
    // `subarray` CLAMPS rather than throwing, so a truncated download would
    // otherwise yield a short CSV `parseBatch` reads as complete with rows
    // silently missing — worse than an error, since a batch is allowed to be small.
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

  // This module's byte-integrity check. The manifest's md5 was considered
  // and declined: it travels the SAME channel `pinToBaseUrl` already treats
  // as untrusted, so a hostile manifest could name a matching hostile md5
  // too. The zip's own CRC-32 is checked against the bytes actually inflated
  // instead.
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

function parseGkgLine(
  line: string,
  themes: ReadonlySet<string>,
  batchTime: Date,
): GdeltGkgRecord | null {
  const fields = line.split('\t');
  if (fields.length < MIN_COLUMNS) return null;

  const lineThemes = (fields[COL.themes] ?? '').split(';').filter((theme) => theme.length > 0);
  if (!lineThemes.some((theme) => themes.has(theme))) return null;

  // V1.5TONE is `tone,positive,negative,polarity,…`; only the first field is
  // the average tone this module scores on
  const tone = Number.parseFloat((fields[COL.tone] ?? '').split(',')[0] ?? '');
  if (!Number.isFinite(tone)) return null;

  const nativeId = fields[COL.recordId] ?? '';
  if (nativeId.length === 0) return null;

  // Column 1 is the row's own stamp. It equals the file stamp in every
  // sampled batch; the FILE's stamp wins when they disagree, because that
  // is the one the archive's cursor and the replay window are keyed on
  return {
    native_id: nativeId,
    batch_time: batchTime,
    source_name: fields[COL.sourceName] ?? '',
    document_url: fields[COL.documentUrl] ?? '',
    themes: lineThemes,
    tone,
    payload: PROJECTED_COLUMNS.map((column) => fields[column] ?? '').join('\t'),
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

  /**
   * The URL of the most recent GKG batch. `signal` bounds only the
   * rate-limiter wait, not the request that follows — see the class doc for
   * why the two are treated differently on shutdown.
   */
  async latestBatchUrl(signal?: AbortSignal): Promise<string> {
    await this.rateLimiter.acquire(signal);
    const response = await this.fetchImpl(`${this.baseUrl}/lastupdate.txt`, requestInit());
    if (!response.ok) {
      throw new Error(
        `GdeltGkgClient: lastupdate.txt returned HTTP ${response.status} ${response.statusText}.`,
      );
    }
    // Refused BEFORE `text()` where the server declares a length, mirroring
    // `fetchBatch`'s two-step guard on `MAX_ARCHIVE_BYTES`.
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
    // Three lines — export, mentions, gkg. Matched on suffix rather than line
    // index: the order is conventional, not contractual.
    for (const line of text.split('\n')) {
      const url = line.trim().split(/\s+/).at(2);
      if (url?.endsWith('.gkg.csv.zip') === true) return this.pinToBaseUrl(url);
    }
    throw new Error(
      `GdeltGkgClient: lastupdate.txt carried no .gkg.csv.zip entry. Got: ${text.slice(0, 200)}`,
    );
  }

  /**
   * Confines a URL named by `lastupdate.txt` to the host we configured. The
   * manifest names an absolute URL, so whoever serves it chooses the
   * download host — over plain HTTP that's anyone on the path. Only the
   * origin is replaced (so a manifest still advertising `http://` is fetched
   * over TLS anyway); the path, and with it the batch stamp, is the vendor's.
   */
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
    // Query string dropped, not carried: `batchTimeFromUrl` anchors its stamp
    // on `.gkg.csv.zip$`, so preserving a `?` would produce a URL this pins
    // happily and then can't stamp. GDELT's batch URLs carry no query anyway.
    return `${base.protocol}//${base.host}${named.pathname}`;
  }

  /**
   * Downloads, inflates, parses and theme-filters one batch file. `signal`
   * can abandon this call while parked on the rate limiter, but once the
   * download is under way it is not consulted again —
   * `GdeltIngestAgent.whenIdle` relies on a started download being left to
   * finish, since its archive write is what the shutdown drain exists to
   * order. Composing `signal` into the request's own timeout (`AbortSignal.any`)
   * was rejected for the same reason: it would cancel a mid-flight download.
   */
  async fetchBatch(fileUrl: string, signal?: AbortSignal): Promise<GdeltGkgBatch> {
    // Pinned here too, since this method is public and a caller-assembled URL
    // must not reach a host we never configured. Re-pinning is a no-op.
    // `url`, not `fileUrl`, in every diagnostic below: the request goes to
    // the pinned rewrite, so citing the pre-pin argument would be wrong.
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
    // Refused BEFORE `arrayBuffer()` where the server declares a length, so
    // an oversized body is never materialised. A missing/lying header falls
    // through to the post-allocation check below.
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
    // `url`, not `fileUrl`: the batch's recorded provenance must be the URL we
    // actually downloaded, not the one a manifest suggested
    return this.parseBatch(csv, batchTime, url);
  }

  /** Convenience: whatever GDELT published most recently */
  async fetchLatestBatch(signal?: AbortSignal): Promise<GdeltGkgBatch> {
    return this.fetchBatch(await this.latestBatchUrl(signal), signal);
  }

  /**
   * Exported through the class so the parser is testable without a fetch. A
   * malformed row is SKIPPED, not thrown on — unlike
   * `AlpacaNewsClient.validateArticle`, since a batch is ~800 rows of scraped
   * text where a stray tab or unparseable tone is routine, and failing the
   * batch would discard 799 good rows over one. `scanned` is rows SEEN, not
   * skipped (skipped is `scanned - records.length`).
   */
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
