/**
 * GDELT GKG 2.1 — the 15-minute macro tone fetcher (#556, map #552).
 *
 * ## Why GDELT, and why the GKG files rather than the DOC API
 *
 * `alpaca-news-client.ts` documents its own measured hole: the Benzinga wire
 * returns **zero items for 3USL, 3LDE and SGLN**, the LSE-listed ETPs
 * [ADR-0016](../../../../docs/adr/0016-universe-leveraged-etps-ungated.md)
 * actually trades. A 3x FTSE ETP has no company news; what moves it is macro.
 * That is this module's job.
 *
 * #556 banned the GDELT **DOC API** in production: it is an undocumented,
 * unversioned, rate-limited query endpoint with no stability contract. The
 * 15-minute **GKG batch files** are the opposite — flat files at a
 * deterministic timestamped URL, published on a fixed cadence, permanently
 * retrievable. That permanence is what lets `gdelt-themes.ts` filter at fetch
 * without destroying re-derivability.
 *
 * ## Format, verified against a live batch rather than the codebook
 *
 * `lastupdate.txt` returns three `size md5 url` lines (export / mentions /
 * gkg); we take the gkg one. The zip carries **exactly one deflate entry**
 * (verified: EOCD entry count 1, method 8), so `inflateRawSync` past the local
 * header is sufficient and pulls in no dependency — the repo has no zip library
 * and this did not justify adding one. The header's name and extra-field
 * lengths are **read**, not assumed: they were 22 and 28 in the sampled batch
 * and both are variable.
 *
 * The TSV carries 27 columns. The four this reads: `0` GKGRECORDID, `1`
 * V2.1DATE, `7` V1THEMES (semicolon-delimited), `15` V1.5TONE (comma-delimited,
 * tone first). Columns 3 and 4 (source name, document URL) are carried through
 * for provenance. Those six are what gets archived — see `payload` on
 * `GdeltGkgRecord` for the measured storage reason and why re-derivability
 * survives the projection.
 *
 * ## What this module does NOT do
 *
 * It does not score, aggregate, or emit an `IntelligenceItem`. It returns
 * records; `GdeltIngestAgent` archives the bytes. Tone windowing and the
 * `sign(toneDelta)` scoring #556 specified are a separate, later step, kept
 * apart on purpose — see that agent's header for why the archive has to lead
 * the signal by a full baseline window.
 */

import { inflateRawSync } from 'node:zlib';
import { TokenBucket } from '../../../shared/index.js';
import { allWatchedThemes } from './gdelt-themes.js';

const DEFAULT_BASE_URL = 'http://data.gdeltproject.org/gdeltv2';

/**
 * GDELT publishes one batch per 15 minutes and asks politely for no hammering.
 * Our tick is 15 minutes too, so this only ever has to pass one download.
 */
const DEFAULT_PACING = { capacity: 2, refillPerSecond: 0.2 } as const;

/**
 * Refuse a response larger than this rather than parsing it.
 *
 * A sampled batch is 3.4MB compressed / 10.5MB raw. 64MB is ~19x the observed
 * compressed size, so anything above it is a mis-routed response rather than a
 * batch. Note what this does NOT do: the check runs after `arrayBuffer()` has
 * already materialised the body, so it bounds what gets *inflated and parsed*,
 * not what gets allocated. Bounding the allocation would need a streaming read
 * with a running byte count; `MAX_INFLATED_BYTES` is the guard that actually
 * refuses before allocating, because `inflateRawSync` enforces it internally.
 */
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

/** Guards a decompression bomb: 10.5MB observed, 512MB refused. */
const MAX_INFLATED_BYTES = 512 * 1024 * 1024;

/** GKG 2.1 column indices, named once. */
const COL = {
  recordId: 0,
  date: 1,
  sourceName: 3,
  documentUrl: 4,
  themes: 7,
  tone: 15,
} as const;

/** The row is unusable below this many columns. */
const MIN_COLUMNS = COL.tone + 1;

/** One GKG document that matched the theme watchlist. */
export interface GdeltGkgRecord {
  /** GKGRECORDID, e.g. `20260815153000-0`. Unique within GDELT. */
  native_id: string;
  /**
   * The batch this row was published in — GDELT's knowledge time AND ours,
   * which is why the archive stamps GDELT rows `fidelity: 'live'` even when
   * backfilled (`mi-archive-store.ts:48`).
   */
  batch_time: Date;
  source_name: string;
  document_url: string;
  /** V1THEMES, split. Retains every theme on the row, not just matched ones. */
  themes: string[];
  /** V1.5TONE's first field: average tone, roughly [-100, +100], usually ±10. */
  tone: number;
  /**
   * What the archive stores: the six read columns, tab-joined in column order
   * (`PROJECTED_COLUMNS`), NOT the verbatim 27-column line.
   *
   * This is a measured deviation from #554's "store the vendor's bytes
   * untouched", taken on evidence. Against a real batch, 200 of 797 rows match
   * the watchlist (25.1%) and a full GKG line averages **14.9KB** — almost all
   * of it the V2ENHANCED* columns nothing here reads. At 96 batches a day that
   * is **~4.0GB over a 14-day soak**, on the MacBook running the live system.
   * The projection is ~1.1KB a row: **~288MB** for the same run.
   *
   * Re-derivability survives intact, which is the only reason this is
   * acceptable. `native_id` carries the batch stamp as its prefix
   * (`20260815153000-23`), so the exact source file URL is reconstructible from
   * any stored row, and GDELT keeps every batch permanently retrievable at that
   * deterministic URL — the same permanence `gdelt-themes.ts` leans on to
   * justify filtering at fetch. The dropped columns are re-fetchable in full;
   * they are not lost, just not carried.
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
  /** Rows matching the watchlist. */
  records: GdeltGkgRecord[];
  /** Rows in the file before filtering — lets a caller see the match rate. */
  scanned: number;
}

export interface GdeltGkgClientOptions {
  baseUrl?: string | undefined;
  fetchImpl?: typeof fetch;
  rateLimiter?: TokenBucket;
  /** Overrides the watchlist; defaults to `allWatchedThemes()`. */
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
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  return Number.isNaN(ms) ? undefined : new Date(ms);
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
 * The single entry of a one-entry zip.
 *
 * Deliberately narrow: this rejects a multi-entry archive rather than silently
 * reading the first member, because a GDELT file that suddenly carried two
 * entries would mean the format changed and the parser's column assumptions are
 * no longer safe either.
 */
function unzipSingleEntry(buffer: Buffer): string {
  if (buffer.length < 30 || buffer.readUInt32LE(0) !== 0x04034b50) {
    throw new Error('GdeltGkgClient: response is not a zip archive (bad local file header).');
  }
  const method = buffer.readUInt16LE(8);
  const nameLength = buffer.readUInt16LE(26);
  const extraLength = buffer.readUInt16LE(28);
  const body = buffer.subarray(30 + nameLength + extraLength);

  let inflated: Buffer;
  if (method === 8) {
    inflated = inflateRawSync(body, { maxOutputLength: MAX_INFLATED_BYTES });
  } else if (method === 0) {
    inflated = body;
  } else {
    throw new Error(
      `GdeltGkgClient: unsupported zip compression method ${method} (expected 8 deflate or 0 stored).`,
    );
  }
  return inflated.toString('utf8');
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
   * The URL of the most recent GKG batch.
   *
   * No credentials anywhere in this module — GDELT is open data, so unlike the
   * Alpaca client there is nothing to check in the constructor.
   */
  async latestBatchUrl(): Promise<string> {
    await this.rateLimiter.acquire();
    const response = await this.fetchImpl(`${this.baseUrl}/lastupdate.txt`);
    if (!response.ok) {
      throw new Error(
        `GdeltGkgClient: lastupdate.txt returned HTTP ${response.status} ${response.statusText}.`,
      );
    }
    const text = await response.text();
    // Three lines — export, mentions, gkg — each `size md5 url`. Matching on the
    // suffix rather than the line index: the order is conventional, not
    // contractual, and picking the wrong file would parse a totally different
    // schema against GKG column indices.
    for (const line of text.split('\n')) {
      const url = line.trim().split(/\s+/).at(2);
      if (url !== undefined && url.endsWith('.gkg.csv.zip')) return url;
    }
    throw new Error(
      `GdeltGkgClient: lastupdate.txt carried no .gkg.csv.zip entry. Got: ${text.slice(0, 200)}`,
    );
  }

  /** Downloads, inflates, parses and theme-filters one batch file. */
  async fetchBatch(fileUrl: string): Promise<GdeltGkgBatch> {
    const batchTime = batchTimeFromUrl(fileUrl);
    if (batchTime === undefined) {
      throw new Error(`GdeltGkgClient: cannot read a batch timestamp from ${fileUrl}.`);
    }

    await this.rateLimiter.acquire();
    const response = await this.fetchImpl(fileUrl);
    if (!response.ok) {
      throw new Error(
        `GdeltGkgClient: ${fileUrl} returned HTTP ${response.status} ${response.statusText}.`,
      );
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_ARCHIVE_BYTES) {
      throw new Error(
        `GdeltGkgClient: ${fileUrl} is ${buffer.length} bytes, above the ${MAX_ARCHIVE_BYTES} ` +
          'ceiling — refusing to buffer it inside a tick.',
      );
    }

    const csv = unzipSingleEntry(buffer);
    return this.parseBatch(csv, batchTime, fileUrl);
  }

  /** Convenience: whatever GDELT published most recently. */
  async fetchLatestBatch(): Promise<GdeltGkgBatch> {
    return this.fetchBatch(await this.latestBatchUrl());
  }

  /**
   * Exported through the class so the parser is testable without a fetch.
   *
   * A malformed row is SKIPPED, not thrown on — the opposite of
   * `AlpacaNewsClient.validateArticle`, and deliberately so. There, one bad
   * article means a broken vendor contract on a small, fully-structured page.
   * Here a batch is ~800 rows of scraped worldwide text where a stray tab or an
   * unparseable tone is routine, and failing the batch would discard 799 good
   * rows over one. The count of skipped rows is returned so the caller can log
   * a filter that has silently started rejecting everything.
   */
  parseBatch(csv: string, batchTime: Date, fileUrl: string): GdeltGkgBatch {
    const records: GdeltGkgRecord[] = [];
    let scanned = 0;

    for (const line of csv.split('\n')) {
      if (line.length === 0) continue;
      scanned++;
      const fields = line.split('\t');
      if (fields.length < MIN_COLUMNS) continue;

      const themes = (fields[COL.themes] ?? '').split(';').filter((theme) => theme.length > 0);
      if (!themes.some((theme) => this.themes.has(theme))) continue;

      // V1.5TONE is `tone,positive,negative,polarity,…`; only the first field is
      // the average tone #556 scores on.
      const tone = Number.parseFloat((fields[COL.tone] ?? '').split(',')[0] ?? '');
      if (!Number.isFinite(tone)) continue;

      const nativeId = fields[COL.recordId] ?? '';
      if (nativeId.length === 0) continue;

      // Column 1 is the row's own stamp. It equals the file stamp in every
      // sampled batch; the FILE's stamp wins when they disagree, because that
      // is the one the archive's cursor and the replay window are keyed on.
      records.push({
        native_id: nativeId,
        batch_time: batchTime,
        source_name: fields[COL.sourceName] ?? '',
        document_url: fields[COL.documentUrl] ?? '',
        themes,
        tone,
        payload: PROJECTED_COLUMNS.map((column) => fields[column] ?? '').join('\t'),
      });
    }

    return { batch_time: batchTime, file_url: fileUrl, records, scanned };
  }
}
