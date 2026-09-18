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
    expect(rows[0]?.updated_at.getTime()).toBe(BATCH_TIME.getTime());
    expect(rows[0]?.ingested_at.getTime()).toBe(NOW.getTime());
    archive.close();
  });

  it("stamps GDELT rows 'live', because the batch time IS the knowledge time", async () => {
    const archive = new MiArchiveStore();
    const agent = new GdeltIngestAgent({ archive, client: stubClient({}), clock });

    await agent.refresh();

    expect(archive.rawRows(SOURCE_GDELT)[0]?.fidelity).toBe('live');
    archive.close();
  });

  it('emits NO items, so nothing reaches an analyst yet', async () => {
    const archive = new MiArchiveStore();
    const agent = new GdeltIngestAgent({ archive, client: stubClient({}), clock });

    await agent.refresh();

    expect(archive.itemsKnownAt('stocks', NOW, [SOURCE_GDELT])).toEqual([]);
    expect(archive.itemsKnownAt('crypto', NOW, [SOURCE_GDELT])).toEqual([]);
    archive.close();
  });

  it('skips a batch it already holds WITHOUT downloading it', async () => {
    const archive = new MiArchiveStore();
    const client = stubClient({});
    const agent = new GdeltIngestAgent({ archive, client, clock });

    await agent.refresh();
    expect(client.fetchBatch).toHaveBeenCalledTimes(1);

    await expect(agent.refresh()).resolves.toBe(false);
    expect(client.fetchBatch).toHaveBeenCalledTimes(1);
    expect(archive.rawRows(SOURCE_GDELT)).toHaveLength(1);
    archive.close();
  });

  it('archives the next batch once GDELT publishes one', async () => {
    const archive = new MiArchiveStore();
    const agent = new GdeltIngestAgent({ archive, client: stubClient({}), clock });
    await agent.refresh();

    const nextTime = new Date('2026-08-15T15:45:00Z');
    const later = new GdeltIngestAgent({
      archive,
      client: stubClient({
        url: LATER_BATCH_URL,
        batch: batch([record({ native_id: 'n-1', batch_time: nextTime })], LATER_BATCH_URL),
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

    await expect(agent.refresh()).resolves.toBe(false);
    expect(archive.rawRows(SOURCE_GDELT)).toEqual([]);
    expect(logger.entries).toContainEqual(expect.objectContaining({ level: 'warn' }));
    expect(archive.latestUpdatedAt(SOURCE_GDELT)).toBeUndefined();

    const retry = new GdeltIngestAgent({ archive, client: stubClient({}), clock });
    await expect(retry.refresh()).resolves.toBe(true);
    expect(archive.latestUpdatedAt(SOURCE_GDELT)?.getTime()).toBe(BATCH_TIME.getTime());
    archive.close();
  });

  it(
    'warns under its own cause, not "batch fetch failed", when the cursor read hits a closed ' +
      'store (#713 item 5)',
    async () => {
      const archive = new MiArchiveStore();
      archive.close();
      const logger = collectingLogger();
      const client = stubClient({});
      const agent = new GdeltIngestAgent({ archive, client, clock, logger });

      await expect(agent.refresh()).resolves.toBe(false);
      const warns = logger.entries.filter((entry) => entry.level === 'warn');
      expect(warns).toHaveLength(1);
      expect(warns[0]?.message).not.toMatch(/GDELT batch fetch failed/);
      expect(warns[0]?.message).toMatch(/outside the fetch\/write paths/);
      expect(client.latestBatchUrl).not.toHaveBeenCalled();
    },
  );

  it('resolves false and warns rather than crashing when the clock throws (#713 item 6)', async () => {
    const archive = new MiArchiveStore();
    const logger = collectingLogger();
    const throwingClock: Clock = {
      now: () => {
        throw new Error('injected clock failure');
      },
    };
    const agent = new GdeltIngestAgent({
      archive,
      client: stubClient({ batch: batch([record()]) }),
      clock: throwingClock,
      logger,
    });

    await expect(agent.refresh()).resolves.toBe(false);
    expect(archive.rawRows(SOURCE_GDELT)).toEqual([]);
    const warns = logger.entries.filter((entry) => entry.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0]?.message).toMatch(/outside the fetch\/write paths/);
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

    await expect(agent.refresh()).resolves.toBe(false);
    expect(logger.entries).toContainEqual(expect.objectContaining({ level: 'warn' }));

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

    const first = agent.refresh();
    await expect(agent.refresh()).resolves.toBe(false);
    expect(client.fetchBatch).toHaveBeenCalledTimes(1);

    release();
    await expect(first).resolves.toBe(true);
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

    expect(drained).toBe(false);
    release();
    await Promise.all([polling, draining]);
    expect(drained).toBe(true);
    expect(archive.rawRows(SOURCE_GDELT)).toHaveLength(1);

    await expect(agent.whenIdle()).resolves.toBeUndefined();
    archive.close();
  });

  it(
    'abandons a poll parked on the rate limiter instead of waiting it out, unlike a poll ' +
      'already mid-download (#702)',
    async () => {
      const archive = new MiArchiveStore();
      const logger = collectingLogger();
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
      await agent.whenIdle();

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

    const laterClient = stubClient({
      url: LATER_BATCH_URL,
      batch: batch(rows, LATER_BATCH_URL),
    });
    const later = new GdeltIngestAgent({ archive, client: laterClient, clock });

    await expect(later.refresh()).resolves.toBe(true);
    expect(laterClient.fetchBatch).toHaveBeenCalledOnce();
    expect(archive.rawRows(SOURCE_GDELT)).toHaveLength(2);
    archive.close();
  });

  it('stamps ingested_at after the download, not before it', async () => {
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
      advancing.now();
      return batch([record()]);
    });
    const agent = new GdeltIngestAgent({ archive, client, clock: advancing });

    await agent.refresh();

    const row = archive.rawRows(SOURCE_GDELT)[0];
    expect(row?.ingested_at.getTime()).toBeGreaterThan(NOW.getTime() + 60_000);
    archive.close();
  });

  it('abandons a poll whose batch URL carries no timestamp, without fetching', async () => {
    const archive = new MiArchiveStore();
    const logger = collectingLogger();
    const client = stubClient({ url: 'http://data.gdeltproject.org/gdeltv2/latest.gkg.csv.zip' });
    const agent = new GdeltIngestAgent({ archive, client, clock, logger });

    await expect(agent.refresh()).resolves.toBe(false);

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
        throw new Error('EPIPE');
      },
    } as unknown as Logger;
    const agent = new GdeltIngestAgent({
      archive,
      client: stubClient({ batch: batch([record()]) }),
      clock,
      logger: throwing,
    });

    await expect(agent.refresh()).resolves.toBe(true);
    expect(archive.rawRows(SOURCE_GDELT)).toHaveLength(1);
    archive.close();
  });
});
