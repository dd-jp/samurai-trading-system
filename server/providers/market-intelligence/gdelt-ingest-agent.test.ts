import { describe, expect, it, vi } from 'vitest';
import type { Clock, Logger } from '../../shared/index.js';
import { MiArchiveStore } from './archive/mi-archive-store.js';
import { GdeltIngestAgent, SOURCE_GDELT } from './gdelt-ingest-agent.js';
import type { GdeltGkgBatch, GdeltGkgClient, GdeltGkgRecord } from './sources/gdelt-gkg-client.js';

const NOW = new Date('2026-08-15T15:32:00Z');
const clock: Clock = { now: () => NOW };

const BATCH_URL = 'http://data.gdeltproject.org/gdeltv2/20260815153000.gkg.csv.zip';
const BATCH_TIME = new Date('2026-08-15T15:30:00Z');

function record(overrides: Partial<GdeltGkgRecord> = {}): GdeltGkgRecord {
  return {
    native_id: '20260815153000-23',
    batch_time: BATCH_TIME,
    source_name: 'reuters.com',
    document_url: 'https://example.test/a',
    themes: ['ECON_STOCKMARKET', 'EPU_ECONOMY'],
    tone: 1.2,
    payload: 'raw\ttsv\tline',
    ...overrides,
  };
}

function batch(records: GdeltGkgRecord[], url = BATCH_URL, scanned = 800): GdeltGkgBatch {
  const time = records[0]?.batch_time ?? BATCH_TIME;
  return { batch_time: time, file_url: url, records, scanned };
}

function stubClient(options: {
  url?: string;
  batch?: GdeltGkgBatch;
  urlError?: Error;
  batchError?: Error;
}) {
  const latestBatchUrl = vi.fn(async () => {
    if (options.urlError) throw options.urlError;
    return options.url ?? BATCH_URL;
  });
  const fetchBatch = vi.fn(async () => {
    if (options.batchError) throw options.batchError;
    return options.batch ?? batch([record()]);
  });
  return { latestBatchUrl, fetchBatch } as unknown as GdeltGkgClient & {
    latestBatchUrl: typeof latestBatchUrl;
    fetchBatch: typeof fetchBatch;
  };
}

function collectingLogger(): Logger & { entries: { level: string; message: string }[] } {
  const entries: { level: string; message: string }[] = [];
  return {
    entries,
    log: (entry: { level: string; message: string }) => {
      entries.push({ level: entry.level, message: entry.message });
    },
  } as unknown as Logger & { entries: { level: string; message: string }[] };
}

describe('GdeltIngestAgent', () => {
  it('archives the raw rows of a fresh batch', async () => {
    const archive = new MiArchiveStore();
    const client = stubClient({ batch: batch([record(), record({ native_id: 'b-2' })]) });
    const agent = new GdeltIngestAgent({ archive, client, clock });

    await expect(agent.refresh()).resolves.toBe(true);

    const rows = archive.rawRows(SOURCE_GDELT);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.payload).toBe('raw\ttsv\tline');
    // The vendor's batch time is the revision stamp; our clock is when we
    // learned it. They differ by the poll lag and both are recorded.
    expect(rows[0]?.updated_at.getTime()).toBe(BATCH_TIME.getTime());
    expect(rows[0]?.ingested_at.getTime()).toBe(NOW.getTime());
    archive.close();
  });

  it("stamps GDELT rows 'live', because the batch time IS the knowledge time", async () => {
    const archive = new MiArchiveStore();
    const agent = new GdeltIngestAgent({ archive, client: stubClient({}), clock });

    await agent.refresh();

    // Unlike Alpaca, whose stamp is publisher time and whose backfill must be
    // marked 'backfill' to avoid asserting we saw an article the instant it
    // published (mi-archive-store.ts:48).
    expect(archive.rawRows(SOURCE_GDELT)[0]?.fidelity).toBe('live');
    archive.close();
  });

  it('emits NO items, so nothing reaches an analyst yet', async () => {
    const archive = new MiArchiveStore();
    const agent = new GdeltIngestAgent({ archive, client: stubClient({}), clock });

    await agent.refresh();

    // The deliberate half-build. Scoring needs a 24h trailing baseline, and a
    // partial baseline yields a large toneDelta off almost no data — which
    // `confidence = f(|toneDelta|)` would then read as HIGH confidence, on day
    // one of the soak. The archive has to lead the signal by a full window, so
    // this half writes bytes and emits nothing.
    expect(archive.itemsKnownAt('stocks', NOW)).toEqual([]);
    expect(archive.itemsKnownAt('crypto', NOW)).toEqual([]);
    archive.close();
  });

  it('skips a batch it already holds WITHOUT downloading it', async () => {
    const archive = new MiArchiveStore();
    const client = stubClient({});
    const agent = new GdeltIngestAgent({ archive, client, clock });

    await agent.refresh();
    expect(client.fetchBatch).toHaveBeenCalledTimes(1);

    await expect(agent.refresh()).resolves.toBe(false);
    // The cursor is checked against the URL's stamp before the fetch: at a
    // 15-minute tick on a 15-minute publication cadence, re-downloading 3.4MB
    // to discard it is exactly what this avoids.
    expect(client.fetchBatch).toHaveBeenCalledTimes(1);
    expect(archive.rawRows(SOURCE_GDELT)).toHaveLength(1);
    archive.close();
  });

  it('archives the next batch once GDELT publishes one', async () => {
    const archive = new MiArchiveStore();
    const agent = new GdeltIngestAgent({ archive, client: stubClient({}), clock });
    await agent.refresh();

    const nextUrl = 'http://data.gdeltproject.org/gdeltv2/20260815154500.gkg.csv.zip';
    const nextTime = new Date('2026-08-15T15:45:00Z');
    const later = new GdeltIngestAgent({
      archive,
      client: stubClient({
        url: nextUrl,
        batch: batch([record({ native_id: 'n-1', batch_time: nextTime })], nextUrl),
      }),
      clock,
    });

    await expect(later.refresh()).resolves.toBe(true);
    expect(archive.rawRows(SOURCE_GDELT)).toHaveLength(2);
    expect(archive.latestUpdatedAt(SOURCE_GDELT)?.getTime()).toBe(nextTime.getTime());
    archive.close();
  });

  it('returns false and warns when the fetch fails, rather than throwing into the tick', async () => {
    const archive = new MiArchiveStore();
    const logger = collectingLogger();
    const agent = new GdeltIngestAgent({
      archive,
      client: stubClient({ batchError: new Error('socket hang up') }),
      clock,
      logger,
    });

    // A 3.4MB download over a residential link times out routinely. A throw
    // here would take down a tick that would otherwise have traded on the
    // technical analyst alone.
    await expect(agent.refresh()).resolves.toBe(false);
    expect(archive.rawRows(SOURCE_GDELT)).toEqual([]);
    expect(logger.entries).toContainEqual(expect.objectContaining({ level: 'warn' }));
    // The cursor is only advanced by a successful write, so a mid-publication
    // 404 or a truncated download leaves it where it was and the next poll
    // retries the same batch rather than skipping it forever.
    expect(archive.latestUpdatedAt(SOURCE_GDELT)).toBeUndefined();

    const retry = new GdeltIngestAgent({ archive, client: stubClient({}), clock });
    await expect(retry.refresh()).resolves.toBe(true);
    expect(archive.latestUpdatedAt(SOURCE_GDELT)?.getTime()).toBe(BATCH_TIME.getTime());
    archive.close();
  });

  it('survives lastupdate.txt failing too', async () => {
    const archive = new MiArchiveStore();
    const agent = new GdeltIngestAgent({
      archive,
      client: stubClient({ urlError: new Error('ENOTFOUND') }),
      clock,
    });

    await expect(agent.refresh()).resolves.toBe(false);
    archive.close();
  });

  it('logs the scan count when a batch matches no watched theme', async () => {
    const archive = new MiArchiveStore();
    const logger = collectingLogger();
    const agent = new GdeltIngestAgent({
      archive,
      client: stubClient({ batch: batch([], BATCH_URL, 812) }),
      clock,
      logger,
    });

    await expect(agent.refresh()).resolves.toBe(false);
    // A quiet news window and a filter that has silently stopped matching look
    // identical from the outside; only the scanned-vs-archived ratio separates
    // them, so the empty case has to log rather than return in silence.
    expect(logger.entries.some((entry) => /matched no watched themes/.test(entry.message))).toBe(
      true,
    );
    archive.close();
  });

  it('warns instead of rejecting when the archive write fails', async () => {
    const archive = new MiArchiveStore();
    const logger = collectingLogger();
    const write = vi.spyOn(archive, 'write').mockImplementationOnce(() => {
      throw new Error('SQLITE_BUSY: database is locked');
    });
    const agent = new GdeltIngestAgent({ archive, client: stubClient({}), clock, logger });

    // `production.ts` fires this as `void refresh(...)`, so a rejection here is
    // an unhandled rejection in a process meant to run unattended for fourteen
    // days — the write has to degrade exactly like a failed fetch does.
    await expect(agent.refresh()).resolves.toBe(false);
    expect(logger.entries).toContainEqual(expect.objectContaining({ level: 'warn' }));

    // The cursor never moved, so the batch is retried rather than lost.
    expect(archive.latestUpdatedAt(SOURCE_GDELT)).toBeUndefined();
    const retry = new GdeltIngestAgent({ archive, client: stubClient({}), clock });
    await expect(retry.refresh()).resolves.toBe(true);
    expect(archive.rawRows(SOURCE_GDELT)).toHaveLength(1);
    write.mockRestore();
    archive.close();
  });

  it('does not start a second poll while one is in flight', async () => {
    const archive = new MiArchiveStore();
    const client = stubClient({});
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = client.fetchBatch.getMockImplementation();
    client.fetchBatch.mockImplementation(async () => {
      await gate;
      return (await slow?.()) ?? batch([record()]);
    });
    const agent = new GdeltIngestAgent({ archive, client, clock });

    // A stalled 3.4MB download outlasting the 5-minute interval would otherwise
    // have the next tick start a second poll beside it, pass the same cursor
    // check (the first has not written yet) and re-download the same batch.
    const first = agent.refresh();
    await expect(agent.refresh()).resolves.toBe(false);
    expect(client.fetchBatch).toHaveBeenCalledTimes(1);

    release();
    await expect(first).resolves.toBe(true);
    // And the guard clears: a later poll is not locked out forever. It returns
    // false on the cursor now, having actually asked GDELT what the latest is.
    await expect(agent.refresh()).resolves.toBe(false);
    expect(client.latestBatchUrl).toHaveBeenCalledTimes(2);
    archive.close();
  });

  it('is idempotent on a re-run of the same batch', async () => {
    const archive = new MiArchiveStore();
    const rows = [record(), record({ native_id: 'b-2' })];
    const agent = new GdeltIngestAgent({
      archive,
      client: stubClient({ batch: batch(rows) }),
      clock,
    });

    await agent.refresh();
    // Bypasses the cursor to exercise the archive's own INSERT OR IGNORE — the
    // backstop for a clock skew or a cursor reset re-offering held rows.
    const bypass = new GdeltIngestAgent({
      archive,
      client: stubClient({ batch: batch(rows) }),
      clock,
    });
    await bypass.refresh();

    expect(archive.rawRows(SOURCE_GDELT)).toHaveLength(2);
    archive.close();
  });
});
