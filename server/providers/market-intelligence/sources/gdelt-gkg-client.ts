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
 * and both are variable. The header's CRC-32 is checked against the inflated
 * bytes (`unzipFirstEntry`) — this module's byte-integrity control, chosen
 * over the manifest's md5 because the manifest is the untrusted channel
 * `pinToBaseUrl` already refuses to trust; see the check site for the fuller
 * argument.
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
 * `sign(toneDelta)` scoring #556 specified live in `gdelt-scorer.ts`, which
 * reads them back out of the archive (#1086) — kept apart on purpose, see
 * that agent's header for why the archive has to lead the signal by a full
 * baseline window.
 *
 * ## Shutdown, and why the abort signal stops at the rate limiter (#702)
 *
 * `latestBatchUrl` and `fetchBatch` both accept an optional `AbortSignal`, but
 * it is threaded ONLY into `this.rateLimiter.acquire(signal)`, never into the
 * request itself. That is a deliberate asymmetry, not a partial job: a poll
 * parked on the token bucket has done no work and ordered nothing, so
 * abandoning it costs nothing; a poll already mid-request is the one whose
 * archive write `GdeltIngestAgent.whenIdle`'s drain exists to order, so it is
 * left to settle on its own (bounded, as before, by
 * `AbortSignal.timeout(REQUEST_TIMEOUT_MS)`). Composing the shutdown signal
 * into the request's own signal via `AbortSignal.any` would abort that
 * download too — `fetch` cannot distinguish "waiting for headers" from
 * "streaming the body", so there is no way to compose the two signals without
 * losing the distinction the whole design turns on.
 */

import { crc32, inflateRawSync } from 'node:zlib';
import { TokenBucket } from '../../../shared/index.js';
import { allWatchedThemes } from './gdelt-themes.js';

/**
 * HTTPS, not the plain HTTP that `lastupdate.txt` itself advertises.
 *
 * GDELT is open data with no credentials to leak, so the usual argument for TLS
 * does not apply — but this feed reaches an analyst and therefore an order. Over
 * plain HTTP an on-path attacker rewrites `lastupdate.txt` and chooses both the
 * bytes we score and the host we fetch them from. GDELT serves the identical
 * files over TLS, so the mitigation costs nothing.
 */
const DEFAULT_BASE_URL = 'https://data.gdeltproject.org/gdeltv2';

/**
 * How long any single GDELT request may stall before it is abandoned.
 *
 * A 3.4MB download over a residential link is slow but not this slow. Without a
 * timeout a half-open connection sits until the OS TCP timeout — minutes to
 * tens of minutes — holding a poll open across many 15-minute ticks. Failing at
 * 90s and retrying on the next tick loses one batch; hanging loses the day's.
 */
const REQUEST_TIMEOUT_MS = 90_000;

/**
 * The request options every GDELT fetch shares: a timeout, and a refusal to
 * follow redirects.
 *
 * `redirect: 'error'` is what keeps `pinToBaseUrl` meaningful. That method is
 * this module's cited byte-integrity control — it refuses a manifest naming a
 * host we did not configure — but `fetch` follows 3xx by default, so a single
 * redirect from the pinned host re-targets the download anywhere and the pin
 * never sees it. Checking the host of a URL we then let the server rewrite is
 * a control that reads as present and is not. GDELT serves these files
 * directly, so a redirect is a change of behaviour worth failing on rather
 * than absorbing.
 *
 * Built per call, never hoisted to a module constant: `AbortSignal.timeout`
 * starts counting when it is CREATED, so one shared signal would begin at
 * import and every request after the first 90 seconds of process life would
 * abort instantly.
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
 * Refuse a response larger than this rather than parsing it.
 *
 * A sampled batch is 3.4MB compressed / 10.5MB raw. 64MB is ~19x the observed
 * compressed size, so anything above it is a mis-routed response rather than a
 * batch. Enforced twice: against `content-length` before `arrayBuffer()`, which
 * bounds the allocation whenever the server declares a length, and against the
 * materialised buffer after, which catches a missing or understated header.
 * Note what even that does NOT do — a server streaming an undeclared body still
 * allocates it in full before the second check fires. Closing that would need a
 * streaming read with a running byte count; `MAX_INFLATED_BYTES` is the guard
 * that refuses before allocating, because `inflateRawSync` enforces it
 * internally.
 */
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

/** Guards a decompression bomb: 10.5MB observed, 512MB refused */
const MAX_INFLATED_BYTES = 512 * 1024 * 1024;

/**
 * Refuse a `lastupdate.txt` response larger than this rather than parsing it.
 *
 * `response.text()` in `latestBatchUrl` is otherwise this module's only
 * uncapped read — the batch path caps twice (`content-length`, then the
 * materialised buffer), and this mirrors that shape. The manifest is three
 * `size md5 url` lines in practice (a few hundred bytes), so 64KB is
 * generous; nothing enforces the three-line shape, hence the cap. Note what
 * this does NOT do, the same admitted limit `MAX_ARCHIVE_BYTES` carries:
 * `response.text()` still materialises the whole body before the post-read
 * check can fire, whatever the header claims. Refusing the RESULT is enough
 * to stop an oversized manifest being parsed; a true streaming bound would
 * need a running byte count, which three lines of text does not justify.
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
  // rejecting: month 99 rolls forward into a later year and returns a perfectly
  // valid number, so a NaN guard alone never fires and a corrupt stamp becomes a
  // silently shifted `batch_time` — which is a cursor that skips real batches
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
 * The FIRST entry of the zip, which for a GKG batch is the only entry.
 *
 * It reads the local file header and stops; it does not read the end-of-central-
 * directory record, so it cannot and does not verify the archive holds exactly
 * one member — a two-entry archive would inflate member one and ignore the rest.
 * That is a deliberate limit, not an oversight: a GDELT batch that grew a second
 * member would mean the format changed, and the column-count guard in
 * `parseBatch` (`MIN_COLUMNS`) is what actually catches a changed schema. Naming
 * it `unzipFirstEntry` keeps the code honest about which of those two things is
 * true; an earlier docblock here claimed a rejection this function never made.
 */
/**
 * General-purpose bit flag bit 3: "sizes and CRC-32 are in a trailing data
 * descriptor, not the local header". When set, the local header's CRC-32
 * field is 0 by construction and would fail every real batch if compared naively —
 * this decoder does not read the trailing descriptor, so a set bit 3 has to
 * be refused explicitly rather than silently compared against a meaningless
 * zero. Confirmed unset against a live batch fetched 2026-08-17 (general
 * purpose flag `0x0000`); GDELT's files are static and not streamed, so this
 * is not expected to fire, but nothing upstream enforces it.
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
    // buffer, so returning it verbatim appends the central directory and EOCD to
    // the CSV as binary garbage. The local header's compressed size bounds it.
    // Zero there means the size lives in a trailing data descriptor, which this
    // decoder does not read — refuse rather than guess
    const compressedSize = buffer.readUInt32LE(18);
    if (compressedSize === 0) {
      throw new Error(
        'GdeltGkgClient: stored zip entry declares no compressed size (streamed data descriptor).',
      );
    }
    // `subarray` CLAMPS rather than throwing, so a truncated download would
    // yield a short CSV that `parseBatch` reads as a complete batch with rows
    // silently missing — the one failure mode worse than an error here, because
    // a batch is allowed to be small and nothing downstream could tell
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

  // The byte-integrity check this module's own docs name as its job (#713 item
  // 3). The manifest's md5 (`lastupdate.txt`, `size md5 url`) was considered
  // instead and declined: it travels the SAME channel `pinToBaseUrl` already
  // treats as untrusted — a manifest that could name a hostile host could name
  // a matching hostile md5 just as easily, so verifying it adds nothing over
  // the host pin. Transit corruption is TLS's job (AEAD), not this module's.
  // The zip local header's CRC-32 is a better fit: it costs nothing extra to
  // wire in (no plumbing across `latestBatchUrl`/`fetchBatch`, unlike the
  // manifest md5, which is fetched in a separate call from the batch and would
  // need threading through both public methods to compare), it is CHECKED
  // against the bytes actually inflated rather than a value fetched
  // separately, and `crc32` on a ~10.5MB buffer is sub-millisecond — the
  // measured cost this item asked to weigh is negligible either way
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

/**
 * One GKG line, parsed into a record — or `null` for a line that is malformed,
 * off the theme watchlist, or carries no usable tone.
 *
 * Split out of `parseBatch` so the loop there stays about counting rows
 * (`scanned`) and collecting the ones this returns non-null for; this function
 * owns every per-row rejection reason.
 */
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
  // the average tone #556 scores on
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
   * The URL of the most recent GKG batch.
   *
   * No credentials anywhere in this module — GDELT is open data, so unlike the
   * Alpaca client there is nothing to check in the constructor.
   *
   * `signal` (#702) bounds only the rate-limiter wait, not the request that
   * follows — see the class doc for why the two are treated differently on
   * shutdown.
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
    // `fetchBatch`'s two-step guard on `MAX_ARCHIVE_BYTES` — see
    // `MAX_MANIFEST_BYTES` for why neither check is a true streaming bound
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
    // Three lines — export, mentions, gkg — each `size md5 url`. Matching on the
    // suffix rather than the line index: the order is conventional, not
    // contractual, and picking the wrong file would parse a totally different
    // schema against GKG column indices
    for (const line of text.split('\n')) {
      const url = line.trim().split(/\s+/).at(2);
      if (url?.endsWith('.gkg.csv.zip') === true) return this.pinToBaseUrl(url);
    }
    throw new Error(
      `GdeltGkgClient: lastupdate.txt carried no .gkg.csv.zip entry. Got: ${text.slice(0, 200)}`,
    );
  }

  /**
   * Confines a URL named by `lastupdate.txt` to the host we configured.
   *
   * The manifest names an absolute URL, so whoever serves the manifest chooses
   * the download host — and over plain HTTP that is anyone on the path. The host
   * must match `baseUrl`'s, and the returned URL is rebuilt on `baseUrl`'s
   * origin so a manifest that still advertises `http://` (GDELT's does) is
   * fetched over TLS anyway. Only the origin is replaced; the path, and with it
   * the batch stamp the cursor reads, is the vendor's.
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
    // The query string is dropped, not carried. `batchTimeFromUrl` anchors its
    // stamp on `.gkg.csv.zip$`, so preserving a `?` would produce a URL this
    // module pins happily and then cannot stamp — the two methods have to agree
    // on what a batch URL looks like. GDELT's batch URLs carry no query, so
    // there is nothing real to lose
    return `${base.protocol}//${base.host}${named.pathname}`;
  }

  /**
   * Downloads, inflates, parses and theme-filters one batch file.
   *
   * `signal` (#702), same shape as `latestBatchUrl`: it can abandon this call
   * while it is parked on the rate limiter, but once the download itself is
   * under way `signal` is not consulted again. `GdeltIngestAgent.whenIdle`
   * relies on that: a poll that has actually started downloading is worth
   * letting finish, because its archive write is the thing the shutdown drain
   * exists to order — see that class's header and `TokenBucket.acquire`'s doc
   * comment for the fuller argument. Composing `signal` into the request's own
   * `AbortSignal.timeout` (via `AbortSignal.any`) was considered and rejected
   * for exactly that reason: it would cancel a download that is already
   * mid-flight, which is the one state #702 says must be left alone.
   */
  async fetchBatch(fileUrl: string, signal?: AbortSignal): Promise<GdeltGkgBatch> {
    // Pinned here as well as in `latestBatchUrl`, because this method is public
    // and a caller that assembled a URL some other way must not reach a host we
    // never configured. Re-pinning an already-pinned URL is a no-op.
    // `url`, not `fileUrl`, in every diagnostic below: the request actually
    // goes to the pinned rewrite — different protocol, query dropped — so
    // citing the pre-pin argument would name a URL we never fetched. This
    // module's whole point is that the two are different things
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
    // Refused BEFORE `arrayBuffer()` where the server declares a length, so the
    // oversized body is never materialised. A missing or lying `content-length`
    // falls through to the post-allocation check below — this bounds the honest
    // case, which is the one that actually threatens us (GDELT publishing a
    // batch an order of magnitude larger), not a hostile server
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
   * Exported through the class so the parser is testable without a fetch.
   *
   * A malformed row is SKIPPED, not thrown on — the opposite of
   * `AlpacaNewsClient.validateArticle`, and deliberately so. There, one bad
   * article means a broken vendor contract on a small, fully-structured page.
   * Here a batch is ~800 rows of scraped worldwide text where a stray tab or an
   * unparseable tone is routine, and failing the batch would discard 799 good
   * rows over one. What comes back is `scanned` — rows SEEN, not rows skipped
   * (skipped is `scanned - records.length`) — so a caller wiring the
   * silently-rejecting-filter alarm compares the two rather than logging one as
   * if it were the other.
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
