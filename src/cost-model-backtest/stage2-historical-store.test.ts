import type { PolygonAggregate, PolygonClient } from './stage2-historical-store.js';
import { Stage2HistoricalStore } from './stage2-historical-store.js';
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

  it('skips the fetch entirely when the window is already covered (warm cache, A4)', async () => {
    const start = Date.UTC(2020, 0, 1);
    const days = 30;
    const fetchAggregates = vi.fn(async () => aggregates(days, start, 100));
    const store = new Stage2HistoricalStore({ fetchAggregates });
    const window = { start: new Date(start), end: new Date(start + days * DAY_MS) };

    await store.ingest('SPY', window);
    await store.ingest('SPY', window);

    expect(fetchAggregates).toHaveBeenCalledTimes(1);
    expect(store.bars('SPY', window)).toHaveLength(days);
  });

  it('still fetches when existing coverage is partial (a 2-year cache asked for 5)', async () => {
    const start = Date.UTC(2020, 0, 1);
    const shortDays = 40;
    const fullDays = 100;
    let respondWith = aggregates(shortDays, start + (fullDays - shortDays) * DAY_MS, 100);
    const fetchAggregates = vi.fn(async () => respondWith);
    const store = new Stage2HistoricalStore({ fetchAggregates });
    const fullWindow = { start: new Date(start), end: new Date(start + fullDays * DAY_MS) };

    // First ingest covers only the recent tail; the deeper request must refetch.
    await store.ingest('SPY', {
      start: new Date(start + (fullDays - shortDays) * DAY_MS),
      end: new Date(start + fullDays * DAY_MS),
    });
    respondWith = aggregates(fullDays, start, 100);
    await store.ingest('SPY', fullWindow);

    expect(fetchAggregates).toHaveBeenCalledTimes(2);
    expect(store.bars('SPY', fullWindow)).toHaveLength(fullDays);
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
