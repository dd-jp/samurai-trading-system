import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PolygonAggregate, PolygonClient } from './stage2-historical-store.js';
import { Stage2HistoricalStore, uncoveredRanges } from './stage2-historical-store.js';
import type { DateRange } from './universe.js';
import { assertSurvivorshipFree } from './universe.js';

const DAY_MS = 86_400_000;

/** A fake `PolygonClient` returning `count` daily aggregates starting at `startMs`. */
function fakeClient(bySymbol: Record<string, PolygonAggregate[]>): PolygonClient {
  return {
    async fetchAggregates(symbol) {
      return bySymbol[symbol] ?? [];
    },
  };
}

function aggregates(count: number, startMs: number, startPrice: number): PolygonAggregate[] {
  const out: PolygonAggregate[] = [];
  let price = startPrice;
  for (let i = 0; i < count; i++) {
    const t = startMs + i * DAY_MS;
    out.push({ t, o: price, h: price + 1, l: price - 1, c: price, v: 1000 });
    price += 1;
  }
  return out;
}

describe('Stage2HistoricalStore', () => {
  it('ingests and reads back bars for a symbol within a window', async () => {
    const start = Date.UTC(2020, 0, 1);
    const client = fakeClient({ SPY: aggregates(5, start, 100) });
    const store = new Stage2HistoricalStore(client);

    await store.ingest('SPY', { start: new Date(start), end: new Date(start + 10 * DAY_MS) });

    const bars = store.bars('SPY', { start: new Date(start), end: new Date(start + 10 * DAY_MS) });

    expect(bars).toHaveLength(5);
    const first = bars[0];
    expect(first).toBeDefined();
    expect(first?.close).toBe(100);
    expect(first?.instrument).toBe('SPY');
    expect(first?.timeframe).toBe('1d');
    // close_time is open_time + 1 day, never trusted from the source.
    expect(first?.close_time.getTime()).toBe((first?.open_time.getTime() ?? 0) + DAY_MS);
  });

  it('re-ingesting the same symbol/window is idempotent (no duplicate bars)', async () => {
    const start = Date.UTC(2020, 0, 1);
    const client = fakeClient({ SPY: aggregates(3, start, 100) });
    const store = new Stage2HistoricalStore(client);
    const window = { start: new Date(start), end: new Date(start + 10 * DAY_MS) };

    await store.ingest('SPY', window);
    await store.ingest('SPY', window);

    expect(store.bars('SPY', window)).toHaveLength(3);
  });

  it('filters bars to the requested window only', async () => {
    const start = Date.UTC(2020, 0, 1);
    const client = fakeClient({ SPY: aggregates(10, start, 100) });
    const store = new Stage2HistoricalStore(client);
    const fullWindow = { start: new Date(start), end: new Date(start + 20 * DAY_MS) };

    await store.ingest('SPY', fullWindow);

    const narrow = store.bars('SPY', {
      start: new Date(start + 2 * DAY_MS),
      end: new Date(start + 4 * DAY_MS),
    });

    expect(narrow.length).toBeGreaterThan(0);
    for (const bar of narrow) {
      expect(bar.close_time.getTime()).toBeGreaterThanOrEqual(start + 2 * DAY_MS);
      expect(bar.close_time.getTime()).toBeLessThanOrEqual(start + 4 * DAY_MS);
    }
  });

  it('barTimestamps returns the ascending, de-duplicated union across ingested instruments', async () => {
    const start = Date.UTC(2020, 0, 1);
    const client = fakeClient({
      SPY: aggregates(3, start, 100),
      QQQ: aggregates(3, start, 200),
    });
    const store = new Stage2HistoricalStore(client);
    const window = { start: new Date(start), end: new Date(start + 10 * DAY_MS) };

    await store.ingest('SPY', window);
    await store.ingest('QQQ', window);

    const timestamps = await store.barTimestamps(window);

    expect(timestamps).toHaveLength(3);
    const times = timestamps.map((t) => t.getTime());
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeGreaterThan(times[i - 1] as number);
    }
  });

  describe('timelineFor — the per-asset-class scope (#420)', () => {
    /**
     * The defect this closes: stock and crypto daily bars close at different
     * UTC times, so the unscoped union is close to their *sum*. A stock replay
     * driven off it steps every crypto bar too, and the return series gets a
     * zero in each of those slots.
     */
    async function twoClassStore(): Promise<{
      store: Stage2HistoricalStore;
      window: { start: Date; end: Date };
    }> {
      const start = Date.UTC(2020, 0, 1);
      // Crypto closes 12h off the stock close, so no timestamp coincides.
      const client = fakeClient({
        SPY: aggregates(3, start, 100),
        QQQ: aggregates(3, start, 200),
        'BTC-USD': aggregates(3, start + DAY_MS / 2, 300),
      });
      const store = new Stage2HistoricalStore(client);
      const window = { start: new Date(start), end: new Date(start + 10 * DAY_MS) };

      await store.ingest('SPY', window);
      await store.ingest('QQQ', window);
      await store.ingest('BTC-USD', window);

      return { store, window };
    }

    it('returns only the scoped symbols close times, not the whole-store union', async () => {
      const { store, window } = await twoClassStore();

      const union = await store.barTimestamps(window);
      const stocks = await store.timelineFor(['SPY', 'QQQ']).barTimestamps(window);
      const crypto = await store.timelineFor(['BTC-USD']).barTimestamps(window);

      // 3 stock closes + 3 crypto closes, none coinciding — the union really is
      // the sum, which is exactly why the unscoped timeline was wrong.
      expect(union).toHaveLength(6);
      expect(stocks).toHaveLength(3);
      expect(crypto).toHaveLength(3);
      expect(stocks.length + crypto.length).toBe(union.length);
    });

    it('de-duplicates across symbols within the scope and returns ascending times', async () => {
      const { store, window } = await twoClassStore();

      // SPY and QQQ share all three close times.
      const stocks = await store.timelineFor(['SPY', 'QQQ']).barTimestamps(window);

      expect(stocks).toHaveLength(3);
      const times = stocks.map((t) => t.getTime());
      for (let index = 1; index < times.length; index++) {
        expect(times[index]).toBeGreaterThan(times[index - 1] as number);
      }
    });

    it('honours the window bounds', async () => {
      const { store } = await twoClassStore();
      const start = Date.UTC(2020, 0, 1);

      const narrow = await store
        .timelineFor(['SPY'])
        .barTimestamps({ start: new Date(start), end: new Date(start + DAY_MS + 1) });

      // Only the first bar closes inside a window ending just after day 1.
      expect(narrow).toHaveLength(1);
    });

    it('refuses an empty scope rather than yielding an empty timeline', async () => {
      const { store } = await twoClassStore();

      expect(() => store.timelineFor([])).toThrow(/at least one symbol/);
    });

    it('names the un-ingested symbol instead of failing four layers up', async () => {
      const { store, window } = await twoClassStore();

      // Without this, the failure surfaces as `toReturnSeries: no bars in the
      // sample` with no clue which symbol was missing (pitfall P3).
      await expect(store.timelineFor(['ETH-USD']).barTimestamps(window)).rejects.toThrow(
        /Never ingested: \[ETH-USD\]/,
      );
    });

    it('distinguishes an un-ingested symbol from an empty window', async () => {
      const { store } = await twoClassStore();
      const farFuture = {
        start: new Date(Date.UTC(2030, 0, 1)),
        end: new Date(Date.UTC(2030, 1, 1)),
      };

      await expect(store.timelineFor(['SPY']).barTimestamps(farFuture)).rejects.toThrow(
        /ingested but have no bars inside this window/,
      );
    });
  });

  it('reports every ingested symbol as currently listed (no fabricated delisting data)', async () => {
    const start = Date.UTC(2020, 0, 1);
    const client = fakeClient({ SPY: aggregates(3, start, 100) });
    const store = new Stage2HistoricalStore(client);
    const window = { start: new Date(start), end: new Date(start + 10 * DAY_MS) };

    await store.ingest('SPY', window);

    const membership = await store.membershipDuring(window);

    expect(membership).toEqual([{ symbol: 'SPY' }]);
  });

  it('satisfies assertSurvivorshipFree as an InstrumentRegistry for its own ingested universe', async () => {
    const start = Date.UTC(2020, 0, 1);
    const client = fakeClient({ SPY: aggregates(3, start, 100), QQQ: aggregates(3, start, 200) });
    const store = new Stage2HistoricalStore(client);
    const window = { start: new Date(start), end: new Date(start + 10 * DAY_MS) };

    await store.ingest('SPY', window);
    await store.ingest('QQQ', window);

    await expect(assertSurvivorshipFree(['SPY', 'QQQ'], window, store)).resolves.toBeUndefined();
  });

  it('does not expose bars past the window end, so LookaheadAuditor wrapping this read stays honest', async () => {
    const start = Date.UTC(2020, 0, 1);
    const client = fakeClient({ SPY: aggregates(10, start, 100) });
    const store = new Stage2HistoricalStore(client);

    await store.ingest('SPY', { start: new Date(start), end: new Date(start + 20 * DAY_MS) });

    const cutoff = start + 3 * DAY_MS;
    const bars = store.bars('SPY', { start: new Date(start), end: new Date(cutoff) });

    for (const bar of bars) {
      expect(bar.close_time.getTime()).toBeLessThanOrEqual(cutoff);
    }
  });
});

describe('ingest reuses what is already stored instead of re-fetching (#495)', () => {
  const START = Date.UTC(2020, 0, 1);

  /** A client that records every window it was asked for. */
  function recordingClient(bars: PolygonAggregate[]) {
    const asked: DateRange[] = [];
    const client: PolygonClient = {
      async fetchAggregates(_symbol, window) {
        asked.push(window);
        // A real vendor serves only what falls inside the requested range.
        return bars.filter(({ t }) => t >= window.start.getTime() && t <= window.end.getTime());
      },
    };
    return { client, asked };
  }

  it('issues no vendor call at all on a re-run of the same window', async () => {
    const window = { start: new Date(START), end: new Date(START + 10 * DAY_MS) };
    const vendor = recordingClient(aggregates(5, START, 100));
    const store = new Stage2HistoricalStore(vendor.client);

    await store.ingest('SPY', window);
    expect(vendor.asked).toHaveLength(1);

    await store.ingest('SPY', window);

    // Pre-#495 this was 2 — the full window re-fetched, deduped only on write.
    expect(vendor.asked).toHaveLength(1);
    expect(store.bars('SPY', window)).toHaveLength(5);
  });

  it("stays a no-op even though no daily bar opens at the window's intraday end", async () => {
    // The shape `STAGE2_PINNED_WINDOW` actually has: an end at 18:17, while
    // bars open at midnight. Coverage inferred from stored bars alone would
    // see a permanent tail gap here and re-request on every run.
    const window = {
      start: new Date(START),
      end: new Date(START + 4 * DAY_MS + 65_827_694),
    };
    const vendor = recordingClient(aggregates(5, START, 100));
    const store = new Stage2HistoricalStore(vendor.client);

    await store.ingest('SPY', window);
    await store.ingest('SPY', window);
    await store.ingest('SPY', window);

    expect(vendor.asked).toHaveLength(1);
  });

  it('tops up only the uncovered tail when a later run extends the window', async () => {
    const vendor = recordingClient(aggregates(10, START, 100));
    const store = new Stage2HistoricalStore(vendor.client);
    const first = { start: new Date(START), end: new Date(START + 4 * DAY_MS) };
    const extended = { start: new Date(START), end: new Date(START + 9 * DAY_MS) };
    // `bars()` filters on close_time (open + 1 day), so a read that ends with
    // the last bar's OPEN would drop it.
    const readAll = { start: new Date(START), end: new Date(START + 10 * DAY_MS) };

    await store.ingest('SPY', first);
    await store.ingest('SPY', extended);

    expect(vendor.asked).toHaveLength(2);
    // Starts at the last stored bar, not at the window start: the whole point
    // is that the first four days are never asked for twice.
    expect(vendor.asked[1]?.start.getTime()).toBe(START + 4 * DAY_MS);
    expect(vendor.asked[1]?.end.getTime()).toBe(extended.end.getTime());
    expect(store.bars('SPY', readAll)).toHaveLength(10);
  });

  it('fetches the head when a later run asks for an EARLIER start', async () => {
    const vendor = recordingClient(aggregates(10, START, 100));
    const store = new Stage2HistoricalStore(vendor.client);
    const late = { start: new Date(START + 5 * DAY_MS), end: new Date(START + 9 * DAY_MS) };
    const earlier = { start: new Date(START), end: new Date(START + 9 * DAY_MS) };
    const readAll = { start: new Date(START), end: new Date(START + 10 * DAY_MS) };

    await store.ingest('SPY', late);
    expect(store.bars('SPY', readAll)).toHaveLength(5);

    await store.ingest('SPY', earlier);

    // A tail-only cache would have called this covered and served 5 bars
    // forever — silent truncation moved from the vendor into the cache.
    expect(vendor.asked[1]?.start.getTime()).toBe(START);
    expect(store.bars('SPY', readAll)).toHaveLength(10);
  });

  it('re-reads the last stored bar so a provisional one is corrected, not frozen', async () => {
    const asked: DateRange[] = [];
    let close = 100;
    const client: PolygonClient = {
      async fetchAggregates(_symbol, window) {
        asked.push(window);
        // The bar at START is provisional on the first read and settles later.
        return [{ t: START, o: 100, h: 100, l: 100, c: close, v: 1 }].filter(
          ({ t }) => t >= window.start.getTime() && t <= window.end.getTime(),
        );
      },
    };
    const store = new Stage2HistoricalStore(client);

    await store.ingest('SPY', { start: new Date(START), end: new Date(START + DAY_MS) });
    close = 137; // the settled close
    await store.ingest('SPY', { start: new Date(START), end: new Date(START + 2 * DAY_MS) });

    const bars = store.bars('SPY', { start: new Date(START), end: new Date(START + 2 * DAY_MS) });
    expect(bars).toHaveLength(1);
    // INSERT OR IGNORE would have kept 100 here, forever.
    expect(bars[0]?.close).toBe(137);
  });

  it('does not record coverage when the vendor call fails, so the next run retries', async () => {
    let failing = true;
    const asked: DateRange[] = [];
    const client: PolygonClient = {
      async fetchAggregates(_symbol, window) {
        asked.push(window);
        if (failing) throw new Error('vendor 503');
        return aggregates(5, START, 100);
      },
    };
    const store = new Stage2HistoricalStore(client);
    const window = { start: new Date(START), end: new Date(START + 10 * DAY_MS) };

    await expect(store.ingest('SPY', window)).rejects.toThrow('vendor 503');
    failing = false;
    await store.ingest('SPY', window);

    expect(asked).toHaveLength(2);
    expect(store.bars('SPY', window)).toHaveLength(5);
  });

  it('survives a restart against the same file, re-reading bars rather than the vendor', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'stage2-store-')), 'nested', 'bars.sqlite');
    const window = { start: new Date(START), end: new Date(START + 10 * DAY_MS) };
    const vendor = recordingClient(aggregates(5, START, 100));

    // `nested/` does not exist: SQLite creates the file, never the directory.
    await new Stage2HistoricalStore(vendor.client, dbPath).ingest('SPY', window);
    const reopened = new Stage2HistoricalStore(vendor.client, dbPath);
    await reopened.ingest('SPY', window);

    expect(vendor.asked).toHaveLength(1);
    expect(reopened.bars('SPY', window)).toHaveLength(5);
  });
});

describe('uncoveredRanges', () => {
  const d = (ms: number) => new Date(START + ms * DAY_MS);
  const START = Date.UTC(2020, 0, 1);

  it('asks for the whole window when nothing has been ingested', () => {
    expect(uncoveredRanges({ start: d(0), end: d(10) }, undefined)).toEqual([
      { start: d(0), end: d(10) },
    ]);
  });

  it('asks for nothing when the window sits inside what was already requested', () => {
    const coverage = { requestedFrom: d(0), requestedTo: d(10), firstBar: d(0), lastBar: d(9) };

    expect(uncoveredRanges({ start: d(2), end: d(8) }, coverage)).toEqual([]);
  });

  it('returns head and tail in order when the window overhangs both ends', () => {
    const coverage = { requestedFrom: d(4), requestedTo: d(6), firstBar: d(4), lastBar: d(6) };

    expect(uncoveredRanges({ start: d(0), end: d(10) }, coverage)).toEqual([
      { start: d(0), end: d(4) },
      { start: d(6), end: d(10) },
    ]);
  });

  it('starts the tail at the requested boundary when no bar came back at all', () => {
    const coverage = {
      requestedFrom: d(0),
      requestedTo: d(5),
      firstBar: undefined,
      lastBar: undefined,
    };

    expect(uncoveredRanges({ start: d(0), end: d(10) }, coverage)).toEqual([
      { start: d(5), end: d(10) },
    ]);
  });
});
