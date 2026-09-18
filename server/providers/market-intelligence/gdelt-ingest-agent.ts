
import type { Clock, LogEntry, LogEntryTemplate, Logger } from '../../shared/index.js';
import { logCaughtFailure, safeLog } from '../../shared/index.js';
import type { MiArchiveStore, RawArchiveRow } from './archive/mi-archive-store.js';
import { MI_SOURCES } from './archive/mi-sources.js';
import {
  batchTimeFromUrl,
  type GdeltGkgBatch,
  type GdeltGkgClient,
} from './sources/gdelt-gkg-client.js';

export const SOURCE_GDELT = MI_SOURCES.gdeltGkg;

export interface GdeltIngestAgentDeps {
  archive: MiArchiveStore;
  client: GdeltGkgClient;
  clock: Clock;
  logger?: Logger | undefined;
}

export class GdeltIngestAgent {
  private current: Promise<boolean> | undefined;

  private currentAbort: AbortController | undefined;

  private seenBatch: Date | undefined;

  constructor(private readonly deps: GdeltIngestAgentDeps) {}

  private log(entry: LogEntry): void {
    const logger = this.deps.logger;
    if (logger !== undefined) safeLog(logger, entry);
  }

  private logFailure(
    template: LogEntryTemplate,
    error: unknown,
    payload: Record<string, unknown>,
  ): void {
    const logger = this.deps.logger;
    if (logger !== undefined) logCaughtFailure(logger, template, error, payload);
  }

  private effectiveCursor(): Date | undefined {
    const written = this.deps.archive.latestUpdatedAt(SOURCE_GDELT);
    if (written === undefined) return this.seenBatch;
    if (this.seenBatch === undefined) return written;
    return this.seenBatch > written ? this.seenBatch : written;
  }

  private noteSeen(batchTime: Date): void {
    if (this.seenBatch === undefined || batchTime > this.seenBatch) this.seenBatch = batchTime;
  }

  async refresh(trace_id = 'gdelt-ingest'): Promise<boolean> {
    if (this.current !== undefined) return false;
    const abortController = new AbortController();
    this.currentAbort = abortController;
    const run = this.poll(trace_id, abortController.signal).catch((error: unknown) => {
      this.logFailure(
        {
          trace_id,
          stage: 'market_intelligence',
          event: 'gdelt_poll_failed',
          level: 'warn',
          message:
            'market intelligence: GDELT poll failed outside the fetch/write paths (cursor read ' +
            'or clock); no macro rows archived this poll. Not fatal — the tick continues on ' +
            'whatever the archive already holds.',
        },
        error,
        { source: SOURCE_GDELT },
      );
      return false;
    });
    this.current = run;
    try {
      return await run;
    } finally {
      this.current = undefined;
      this.currentAbort = undefined;
    }
  }

  async whenIdle(): Promise<void> {
    this.currentAbort?.abort();
    await this.current?.catch(() => undefined);
  }

  private async poll(trace_id: string, signal: AbortSignal): Promise<boolean> {
    const cursor = this.effectiveCursor();
    let batch: GdeltGkgBatch;
    try {
      const url = await this.deps.client.latestBatchUrl(signal);
      const candidate = batchTimeFromUrl(url);
      if (candidate === undefined) {
        this.log({
          trace_id,
          stage: 'market_intelligence',
          event: 'gdelt_batch_timestamp_unreadable',
          level: 'warn',
          message:
            'market intelligence: GDELT batch URL carries no readable timestamp; the batch cannot ' +
            'be stamped or cursor-checked, so this poll is abandoned. Vendor URL drift?',
          payload: { source: SOURCE_GDELT, batch: url },
        });
        return false;
      }
      if (cursor !== undefined && candidate <= cursor) return false;
      batch = await this.deps.client.fetchBatch(url, signal);
    } catch (error) {
      this.logFailure(
        {
          trace_id,
          stage: 'market_intelligence',
          event: 'gdelt_batch_fetch_failed',
          level: 'warn',
          message:
            'market intelligence: GDELT batch fetch failed; no macro rows archived this poll. ' +
            'Not fatal — the tick continues on whatever the archive already holds.',
        },
        error,
        { source: SOURCE_GDELT },
      );
      return false;
    }

    if (batch.records.length === 0) {
      this.log({
        trace_id,
        stage: 'market_intelligence',
        level: 'info',
        message: 'market intelligence: GDELT batch matched no watched themes',
        payload: { source: SOURCE_GDELT, scanned: batch.scanned, batch: batch.file_url },
      });
      this.noteSeen(batch.batch_time);
      return false;
    }

    const now = this.deps.clock.now();
    const raws: RawArchiveRow[] = batch.records.map((record) => ({
      source: SOURCE_GDELT,
      native_id: record.native_id,
      updated_at: record.batch_time,
      payload: record.payload,
      ingested_at: now,
      fidelity: 'live',
    }));

    try {
      this.deps.archive.write(raws, []);
    } catch (error) {
      this.logFailure(
        {
          trace_id,
          stage: 'market_intelligence',
          event: 'gdelt_archive_write_failed',
          level: 'warn',
          message:
            'market intelligence: GDELT archive write failed; batch not stored. ' +
            'The cursor is unmoved, so the next poll retries this batch.',
        },
        error,
        { source: SOURCE_GDELT, batch: batch.file_url, rows: raws.length },
      );
      return false;
    }

    this.log({
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
