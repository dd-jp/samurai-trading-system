/**
 * GDELT ingestion — the archive half (#556, map #552).
 *
 * ## What this does, and what it deliberately does not
 *
 * It fetches each 15-minute GKG batch, theme-filters it, and writes the
 * matching rows to `mi_archive_raw`. It writes **no `mi_items`**, ingests
 * nothing into `MarketIntelligenceStore`, and therefore reaches no analyst.
 * Nothing downstream can see this data yet.
 *
 * That is the point, not an unfinished edge. #556 scores GDELT as
 * `sentiment = sign(toneDelta)` where `toneDelta` is a **1-hour signal window
 * against a trailing 24-hour baseline**. On a cold archive there is no
 * baseline. A partial one is worse than none: 90 minutes of history yields a
 * large `toneDelta` off almost no data, and since `confidence = f(|toneDelta|)`
 * that lands as a *high-confidence* signal built out of nothing, on the first
 * day of the soak, in the analyst path. That is the same class of defect as
 * `no-caller-defect-pattern` — an unknown silently coerced into a number.
 *
 * So the archive leads the signal by a full baseline window. This agent starts
 * accruing history immediately and safely; the scoring pass (which must refuse
 * to emit until it holds a minimum baseline coverage, and log the refusal)
 * lands on top of an archive that already has 24 hours in it. Splitting them
 * also means a scoring change landing mid-soak cannot alter what the run is
 * measuring, because this half emits nothing to alter.
 *
 * ## Cursor and idempotency
 *
 * Batches are immutable and timestamped, so `updated_at` IS the batch time and
 * `latestUpdatedAt(SOURCE_GDELT)` is an exact cursor: a batch at or before it
 * is already held and is skipped without downloading. `INSERT OR IGNORE` on the
 * natural key absorbs anything that slips past. Unlike the Alpaca path there is
 * no pre-scoring dedup to do here, because nothing in this half costs tokens.
 */

import type { Clock, Logger } from '../../shared/index.js';
import type { MiArchiveStore, RawArchiveRow } from './archive/mi-archive-store.js';
import {
  batchTimeFromUrl,
  type GdeltGkgBatch,
  type GdeltGkgClient,
} from './sources/gdelt-gkg-client.js';

/** The archive `source` key for every GDELT row. */
export const SOURCE_GDELT = 'gdelt-gkg';

export interface GdeltIngestAgentDeps {
  archive: MiArchiveStore;
  client: GdeltGkgClient;
  clock: Clock;
  logger?: Logger | undefined;
}

export class GdeltIngestAgent {
  /**
   * The in-flight poll, if there is one.
   *
   * `production.ts` fires this on an interval as `void refresh(...)`, so a poll
   * that outlasts its interval — a stalled 3.4MB download — would otherwise have
   * a second poll start beside it, pass the same cursor check (the first has not
   * written yet) and re-download the same batch. `INSERT OR IGNORE` makes that
   * harmless but not free.
   *
   * Held as the promise rather than a boolean so `whenIdle` can let shutdown
   * drain it, instead of leaving a download racing a closing store.
   */
  private current: Promise<boolean> | undefined;

  /**
   * The most recent batch this process has *decoded*, held or not.
   *
   * The archive cursor only knows about batches that produced rows, so a batch
   * matching no watched theme leaves it unmoved. In memory rather than
   * persisted, deliberately: it costs one redundant download per restart, and
   * the alternative — a marker row in `mi_archive_raw` — would put rows that are
   * not vendor data into the table whose whole contract is that they are.
   */
  private seenBatch: Date | undefined;

  constructor(private readonly deps: GdeltIngestAgentDeps) {}

  /** The later of the persisted write cursor and this process's seen-batch mark. */
  private effectiveCursor(): Date | undefined {
    const written = this.deps.archive.latestUpdatedAt(SOURCE_GDELT);
    if (written === undefined) return this.seenBatch;
    if (this.seenBatch === undefined) return written;
    return this.seenBatch > written ? this.seenBatch : written;
  }

  private noteSeen(batchTime: Date): void {
    if (this.seenBatch === undefined || batchTime > this.seenBatch) this.seenBatch = batchTime;
  }

  /**
   * One poll: fetch the latest batch, archive its watched rows.
   *
   * Returns whether anything new was archived. **Never throws** — same contract
   * as `MiIngestAgent.refresh`, for the same reason: a GDELT batch is a ~3.4MB
   * download over a residential link, so timeouts are routine, and a failed
   * fetch must degrade to "no new intelligence" rather than take down a tick
   * that would otherwise have traded on the technical analyst alone. The
   * contract covers the archive write too, not just the fetch — see the write
   * site for why that distinction is not academic.
   *
   * Concurrent calls do not stack: a call made while a poll is in flight returns
   * `false` immediately rather than starting a second download.
   */
  async refresh(trace_id = 'gdelt-ingest'): Promise<boolean> {
    if (this.current !== undefined) return false;
    const run = this.poll(trace_id);
    this.current = run;
    try {
      return await run;
    } finally {
      this.current = undefined;
    }
  }

  /**
   * Resolves when no poll is in flight. Never rejects.
   *
   * Shutdown clears the timer, which stops the NEXT poll but not the one already
   * downloading — and that one ends in an archive write, potentially against a
   * store the shutdown has since closed. The write is guarded, so this is a
   * cleaner shutdown rather than a correctness fix, but "degrades to a warn" is
   * a worse contract than "does not happen".
   */
  async whenIdle(): Promise<void> {
    await this.current?.catch(() => undefined);
  }

  private async poll(trace_id: string): Promise<boolean> {
    const now = this.deps.clock.now();

    let batch: GdeltGkgBatch;
    try {
      const url = await this.deps.client.latestBatchUrl();
      const candidate = batchTimeFromUrl(url);
      if (candidate === undefined) {
        // The cursor check below cannot run, so this poll — and every poll after
        // it — downloads the full batch. Silent degradation looks identical to a
        // steady stream of fresh batches, so it is logged rather than inferred.
        this.deps.logger?.log({
          trace_id,
          stage: 'market_intelligence',
          level: 'warn',
          message:
            'market intelligence: GDELT batch URL carries no readable timestamp; the skip-if-held ' +
            'cursor is disabled and every poll will download the full batch. Vendor URL drift?',
          payload: { source: SOURCE_GDELT, batch: url },
        });
      }
      // Checked BEFORE the download, not after: at a 15-minute tick against a
      // 15-minute publication cadence, a restart or a fast tick will often see
      // the batch it already holds, and re-downloading 3.4MB to discard it is
      // the whole saving the cursor exists for.
      const cursor = this.effectiveCursor();
      if (cursor !== undefined && candidate !== undefined && candidate <= cursor) return false;
      batch = await this.deps.client.fetchBatch(url);
    } catch (error) {
      this.deps.logger?.log({
        trace_id,
        stage: 'market_intelligence',
        level: 'warn',
        message:
          'market intelligence: GDELT batch fetch failed; no macro rows archived this poll. ' +
          'Not fatal — the tick continues on whatever the archive already holds.',
        payload: {
          source: SOURCE_GDELT,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return false;
    }

    if (batch.records.length === 0) {
      // Not an error — a 15-minute window genuinely can carry no macro news.
      // Logged with the scan count because a filter that has started matching
      // nothing at all looks identical to a quiet news window from the outside,
      // and only the ratio tells them apart.
      this.deps.logger?.log({
        trace_id,
        stage: 'market_intelligence',
        level: 'info',
        message: 'market intelligence: GDELT batch matched no watched themes',
        payload: { source: SOURCE_GDELT, scanned: batch.scanned, batch: batch.file_url },
      });
      // Recorded even though nothing was written. The archive cursor is derived
      // from written rows, so a batch that matched nothing would leave it where
      // it was and every poll for the next 15 minutes would re-download the same
      // ~3.4MB file and re-log this line — the opposite of what the cursor is
      // for. `seenBatch` closes that gap.
      this.noteSeen(batch.batch_time);
      return false;
    }

    const raws: RawArchiveRow[] = batch.records.map((record) => ({
      source: SOURCE_GDELT,
      native_id: record.native_id,
      updated_at: record.batch_time,
      payload: record.payload,
      ingested_at: now,
      // 'live' even though the row is a batch file: GDELT's batch timestamp IS
      // the knowledge timestamp, so the row asserts nothing we did not know.
      // `mi-archive-store.ts:48` sets out this distinction — Alpaca backfill is
      // 'backfill' precisely because its stamp is publisher time.
      fidelity: 'live',
    }));

    // Raw rows only, no items — see this module's header.
    //
    // Inside the try for the same reason the fetch is: `production.ts` calls
    // this as `void refresh(...)`, so anything that escapes here is an unhandled
    // rejection in a process that is meant to run unattended for fourteen days.
    // A SQLite write can fail on SQLITE_BUSY or a full disk, and neither is a
    // reason to lose the tick — the cursor is unmoved, so the next poll retries
    // this same batch.
    try {
      this.deps.archive.write(raws, []);
    } catch (error) {
      this.deps.logger?.log({
        trace_id,
        stage: 'market_intelligence',
        level: 'warn',
        message:
          'market intelligence: GDELT archive write failed; batch not stored. ' +
          'The cursor is unmoved, so the next poll retries this batch.',
        payload: {
          source: SOURCE_GDELT,
          batch: batch.file_url,
          rows: raws.length,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return false;
    }

    this.deps.logger?.log({
      trace_id,
      stage: 'market_intelligence',
      level: 'info',
      message: 'market intelligence: archived GDELT macro rows',
      payload: {
        source: SOURCE_GDELT,
        batch: batch.file_url,
        scanned: batch.scanned,
        archived: raws.length,
      },
    });

    return true;
  }
}
