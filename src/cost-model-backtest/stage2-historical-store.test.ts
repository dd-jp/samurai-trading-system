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
