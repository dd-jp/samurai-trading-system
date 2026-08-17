import { describe, expect, it, vi } from 'vitest';
import type { Clock, Logger } from '../../shared/index.js';
import { TokenBucket } from '../../shared/index.js';
import { MiArchiveStore } from './archive/mi-archive-store.js';
import { GdeltIngestAgent, SOURCE_GDELT } from './gdelt-ingest-agent.js';
import {
  type GdeltGkgBatch,
  GdeltGkgClient,
  type GdeltGkgRecord,
} from './sources/gdelt-gkg-client.js';

const NOW = new Date('2026-08-15T15:32:00Z');
const clock: Clock = { now: () => NOW };

const BATCH_URL = 'http://data.gdeltproject.org/gdeltv2/20260815153000.gkg.csv.zip';
const BATCH_TIME = new Date('2026-08-15T15:30:00Z');
/** The next 15-minute batch file — a newer cursor stamp, same records. */
const LATER_BATCH_URL = 'http://data.gdeltproject.org/gdeltv2/20260815154500.gkg.csv.zip';

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

  it('does not re-download a batch that matched nothing', async () => {
    const archive = new MiArchiveStore();
    const client = stubClient({ batch: batch([], BATCH_URL, 812) });
    const agent = new GdeltIngestAgent({ archive, client, clock });

    await expect(agent.refresh()).resolves.toBe(false);
    await expect(agent.refresh()).resolves.toBe(false);

    // The archive cursor is derived from WRITTEN rows, so a zero-match batch
    // leaves it unmoved — without a separate seen-batch mark, every poll for
    // the next 15 minutes re-downloads and re-parses the same ~3.4MB file.
    expect(client.fetchBatch).toHaveBeenCalledTimes(1);
    archive.close();
  });

  it('warns when the batch URL carries no readable timestamp', async () => {
    const archive = new MiArchiveStore();
    const logger = collectingLogger();
    const stampless = 'http://data.gdeltproject.org/gdeltv2/latest.gkg.csv.zip';
    const agent = new GdeltIngestAgent({
      archive,
      client: stubClient({ url: stampless, batch: batch([record()], stampless) }),
      clock,
      logger,
    });

    await agent.refresh();

    // With no stamp the skip-if-held check cannot run and every poll downloads
    // the full batch. That degradation is indistinguishable from a healthy
    // stream of fresh batches unless it says so.
    expect(
      logger.entries.some(
        (entry) => entry.level === 'warn' && /no readable timestamp/.test(entry.message),
      ),
    ).toBe(true);
    archive.close();
  });

  it('lets a shutdown drain an in-flight poll', async () => {
    const archive = new MiArchiveStore();
    const client = stubClient({});
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    client.fetchBatch.mockImplementation(async () => {
      await gate;
      return batch([record()]);
    });
    const agent = new GdeltIngestAgent({ archive, client, clock });

    const polling = agent.refresh();
    let drained = false;
    const draining = agent.whenIdle().then(() => {
      drained = true;
    });

    // Clearing the interval stops the NEXT poll, not this one — whose archive
    // write would otherwise land after the store is closed.
    expect(drained).toBe(false);
    release();
    await Promise.all([polling, draining]);
    expect(drained).toBe(true);
    expect(archive.rawRows(SOURCE_GDELT)).toHaveLength(1);

    // Idle when nothing is running, rather than hanging.
    await expect(agent.whenIdle()).resolves.toBeUndefined();
    archive.close();
  });

  it(
    'abandons a poll parked on the rate limiter instead of waiting it out, unlike a poll ' +
      'already mid-download (#702)',
    async () => {
      const archive = new MiArchiveStore();
      const logger = collectingLogger();
      // Real GdeltGkgClient + real TokenBucket, not the stub the other tests
      // use — a mock `latestBatchUrl` would happily "accept" a signal argument
      // it never looks at, which would prove nothing about the actual wiring
      // from GdeltIngestAgent through GdeltGkgClient into TokenBucket.acquire.
      //
      // The refill rate is nowhere near real: with capacity 1 and one token
      // already spent, the next acquire needs a token that takes roughly
      // 2,700 hours to mint. If `whenIdle` did not abort the wait, this test
      // would hang until vitest's per-test timeout killed it — there is no
      // fake-timer trick used here, the abort itself is what has to be fast.
      const rateLimiter = new TokenBucket({ capacity: 1, refillPerSecond: 0.0001 });
      await rateLimiter.acquire();
      const client = new GdeltGkgClient({
        rateLimiter,
        fetchImpl: (() => {
          throw new Error(
            'must not reach the network — the poll should be abandoned at the rate limiter',
          );
        }) as unknown as typeof fetch,
      });
      const agent = new GdeltIngestAgent({ archive, client, clock, logger });

      const polling = agent.refresh();
      // No `await` between `refresh()` and `whenIdle()`: the poll has not had
      // a chance to run past `rateLimiter.acquire()` yet, which is exactly the
      // "parked on a token" state #702 is about.
      await agent.whenIdle();

      // Settles to `false` — the abort lands in `poll`'s own catch, same as
      // any other fetch failure, not a hang and not a rejection out of
      // `refresh()`.
      await expect(polling).resolves.toBe(false);
      expect(archive.rawRows(SOURCE_GDELT)).toEqual([]);
      expect(
        logger.entries.some(
          (entry) => entry.level === 'warn' && /GDELT batch fetch failed/.test(entry.message),
        ),
      ).toBe(true);
      archive.close();
    },
  );

  it('is idempotent when a later batch re-offers rows already held', async () => {
    const archive = new MiArchiveStore();
    const rows = [record(), record({ native_id: 'b-2' })];
    const agent = new GdeltIngestAgent({
      archive,
      client: stubClient({ batch: batch(rows) }),
      clock,
    });

    await agent.refresh();

    // A LATER batch file carrying the same records — the shape a vendor
    // re-publication or a rewound cursor actually takes. The URL stamp is what
    // the cursor compares, so a newer one gets past the skip-if-held check and
    // the rows reach `write`, where the archive's own INSERT OR IGNORE is the
    // thing under test. A second agent over the same archive does NOT do this:
    // it reads the same persisted cursor, skips the download, and the write is
    // never reached — the assertion then passes on the first refresh's rows
    // alone, testing nothing.
    const laterClient = stubClient({
      url: LATER_BATCH_URL,
      batch: batch(rows, LATER_BATCH_URL),
    });
    const later = new GdeltIngestAgent({ archive, client: laterClient, clock });

    await expect(later.refresh()).resolves.toBe(true);
    // The download must actually have happened, or this is the vacuous test again.
    expect(laterClient.fetchBatch).toHaveBeenCalledOnce();
    expect(archive.rawRows(SOURCE_GDELT)).toHaveLength(2);
    archive.close();
  });

  it('stamps ingested_at after the download, not before it', async () => {
    // `ingested_at` is the visibility gate replay filters on. Stamping it at the
    // top of the poll would claim we held the bytes before the (up to 90-second)
    // download finished — lookahead, in the direction that flatters a backtest.
    const archive = new MiArchiveStore();
    let ticks = 0;
    const advancing: Clock = {
      now: () => {
        ticks += 1;
        return new Date(NOW.getTime() + ticks * 60_000);
      },
    };
    const client = stubClient({});
    client.fetchBatch.mockImplementation(async () => {
      // A slow download: the clock moves while it runs.
      advancing.now();
      return batch([record()]);
    });
    const agent = new GdeltIngestAgent({ archive, client, clock: advancing });

    await agent.refresh();

    const row = archive.rawRows(SOURCE_GDELT)[0];
    // Strictly after the reading taken during the download, so it cannot have
    // been captured before the fetch began.
    expect(row?.ingested_at.getTime()).toBeGreaterThan(NOW.getTime() + 60_000);
    archive.close();
  });

  it('abandons a poll whose batch URL carries no timestamp, without fetching', async () => {
    const archive = new MiArchiveStore();
    const logger = collectingLogger();
    const client = stubClient({ url: 'http://data.gdeltproject.org/gdeltv2/latest.gkg.csv.zip' });
    const agent = new GdeltIngestAgent({ archive, client, clock, logger });

    await expect(agent.refresh()).resolves.toBe(false);

    // Not fetched: `fetchBatch` needs the same stamp for `batch_time` and would
    // throw, producing a second warn blaming the network for a URL-format fault.
    expect(client.fetchBatch).not.toHaveBeenCalled();
    const warns = logger.entries.filter((entry) => entry.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0]?.message).toContain('no readable timestamp');
    archive.close();
  });

  it('survives a logger that throws, because production calls this as void refresh()', async () => {
    const archive = new MiArchiveStore();
    const throwing: Logger = {
      log: () => {
        // What a `JsonLogger` with no sink left to record on looks like (#714),
        // and what any injected `Logger` is free to do.
        throw new Error('EPIPE');
      },
    } as unknown as Logger;
    const agent = new GdeltIngestAgent({
      archive,
      client: stubClient({ batch: batch([record()]) }),
      clock,
      logger: throwing,
    });

    // Rejecting here would surface as an unhandled rejection in the orchestrator
    // and take down a fourteen-day unattended run.
    await expect(agent.refresh()).resolves.toBe(true);
    expect(archive.rawRows(SOURCE_GDELT)).toHaveLength(1);
    archive.close();
  });
});
