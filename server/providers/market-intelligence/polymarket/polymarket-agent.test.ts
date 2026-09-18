import { describe, expect, it, vi } from 'vitest';
import type { Clock, Logger } from '../../../shared/index.js';
import { MiArchiveStore } from '../archive/mi-archive-store.js';
import { MarketIntelligenceStore } from '../index.js';
import type { CuratedMacroMarket } from './curated-markets.js';
import {
  POLYMARKET_ASSET_CLASS,
  PolymarketAgent,
  SOURCE_POLYMARKET,
  toArchivedItem,
} from './polymarket-agent.js';
import type { PolymarketMarket, PolymarketPricePoint } from './polymarket-client.js';

const NOW = new Date('2026-08-17T12:00:00Z');
const clock: Clock = { now: () => NOW };

const ENTRY: CuratedMacroMarket = {
  id: 'fed-2026-09',
  eventSlug: 'fed-decision-in-september-762',
  marketSlug: 'will-the-fed-increase-rates-25bps-september',
  bullishOutcome: 'No',
  entity: 'FOMC-2026-09',
  label: 'P(no 25bp hike at the September 2026 FOMC)',
  rationale: 'A hike is bearish for a levered long book.',
};

function market(overrides: Partial<PolymarketMarket> = {}): PolymarketMarket {
  return {
    slug: ENTRY.marketSlug,
    question: 'Will the Fed increase interest rates by 25 bps?',
    outcomes: ['Yes', 'No'],
    outcomePrices: [0.295, 0.705],
    tokenIds: ['token-yes', 'token-no'],
    bestBid: 0.7,
    bestAsk: 0.71,
    spread: 0.01,
    volume24hr: 533_307,
    liquidity: 2_149_190,
    updatedAt: new Date('2026-08-17T11:55:00Z'),
    closed: false,
    payload: '{"slug":"m"}',
    ...overrides,
  };
}

function history(from: number, to: number, hours = 24): PolymarketPricePoint[] {
  const points: PolymarketPricePoint[] = [];
  for (let index = 0; index <= hours; index += 1) {
    const at = new Date(NOW.getTime() - (hours - index) * 60 * 60 * 1000);
    const probability = from + ((to - from) * index) / hours;
    points.push({ at, probability });
  }
  return points;
}

function agentWith(options: {
  market?: PolymarketMarket | undefined;
  history?: PolymarketPricePoint[];
  marketError?: Error;
  historyError?: Error;
  table?: readonly CuratedMacroMarket[];
  archive?: MiArchiveStore;
  logger?: Logger;
}) {
  const store = new MarketIntelligenceStore(clock);
  const fetchEventMarket = vi.fn(async () => {
    if (options.marketError) throw options.marketError;
    return 'market' in options ? options.market : market();
  });
  const fetchPriceHistory = vi.fn(async () => {
    if (options.historyError) throw options.historyError;
    return options.history ?? history(0.67, 0.705);
  });
  const agent = new PolymarketAgent({
    client: { fetchEventMarket, fetchPriceHistory },
    store,
    clock,
    table: options.table ?? [ENTRY],
    ...(options.archive === undefined ? {} : { archive: options.archive }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  return { agent, store, fetchEventMarket, fetchPriceHistory };
}

function intelFor(store: MarketIntelligenceStore) {
  return store.getContext(POLYMARKET_ASSET_CLASS, 24 * 60 * 60 * 1000, 'test').intel;
}

describe('PolymarketAgent.refresh', () => {
  it('ingests one news item per curated event, signed by the 24h delta', async () => {
    const { agent, store } = agentWith({ history: history(0.67, 0.705) });

    await expect(agent.refresh('t1')).resolves.toBe(true);

    const intel = intelFor(store);
    expect(intel).toHaveLength(1);
    expect(intel[0]).toMatchObject({
      source: SOURCE_POLYMARKET,
      type: 'news',
      entity: 'FOMC-2026-09',
      sentiment: 1,
    });
    expect(intel[0]?.confidence).toBeCloseTo(0.175, 6);
    expect(intel[0]?.headline).toContain('0.670');
    expect(intel[0]?.headline).toContain('0.705');
  });

  it('reaches an ENTITY-SCOPED read, the only kind an analyst performs', async () => {
    const { agent, store } = agentWith({});

    await agent.refresh('t1');

    const scoped = store.getContext(
      POLYMARKET_ASSET_CLASS,
      24 * 60 * 60 * 1000,
      'test',
      undefined,
      'SPY',
    );

    expect(scoped.intel.map((item) => item.entity)).toEqual(['FOMC-2026-09']);
  });

  it('reads the delta on the BULLISH outcome token, not the first one', async () => {
    const { agent, fetchPriceHistory } = agentWith({});

    await agent.refresh('t1');

    expect(fetchPriceHistory).toHaveBeenCalledWith('token-no');
  });

  it('signs a falling bullish probability as bearish', async () => {
    const { agent, store } = agentWith({ history: history(0.705, 0.5) });

    await agent.refresh('t1');

    expect(intelFor(store)[0]?.sentiment).toBe(-1);
    expect(intelFor(store)[0]?.confidence).toBe(0.95);
  });

  it('emits sentiment 0 inside the dead band — "we looked and it did not move"', async () => {
    const { agent, store } = agentWith({ history: history(0.7, 0.71) });

    await agent.refresh('t1');

    expect(intelFor(store)[0]?.sentiment).toBe(0);
    expect(intelFor(store)[0]?.confidence).toBeCloseTo(0.05, 6);
  });

  it('stamps the item at the INGEST INSTANT, not the floored bucket (#782)', async () => {
    const { agent, store } = agentWith({});

    await agent.refresh('t1');

    expect(intelFor(store)[0]?.timestamp).toEqual(NOW);
  });

  it('is invisible for the rest of the bar it was ingested into (#782)', async () => {
    const midBar = new Date('2026-08-17T10:11:00Z');
    let asOf = midBar;
    const movingClock: Clock = { now: () => asOf };
    const store = new MarketIntelligenceStore(movingClock);
    const agent = new PolymarketAgent({
      client: {
        fetchEventMarket: async () => market({ updatedAt: new Date('2026-08-17T10:08:00Z') }),
        fetchPriceHistory: async () =>
          Array.from({ length: 25 }, (_, index) => ({
            at: new Date(midBar.getTime() - (24 - index) * 60 * 60 * 1000),
            probability: 0.67 + (0.035 * index) / 24,
          })),
      },
      store,
      clock: movingClock,
      table: [ENTRY],
    });

    await expect(agent.refresh('t1')).resolves.toBe(true);

    const stored = store.getContext(POLYMARKET_ASSET_CLASS, 24 * 60 * 60 * 1000, 'test');
    expect(stored.last_updated).toEqual(midBar);

    expect(
      store.getContext(POLYMARKET_ASSET_CLASS, 24 * 60 * 60 * 1000, 'test').intel,
    ).toHaveLength(0);

    asOf = new Date('2026-08-17T10:59:59Z');
    expect(
      store.getContext(POLYMARKET_ASSET_CLASS, 24 * 60 * 60 * 1000, 'test').intel,
    ).toHaveLength(0);

    asOf = new Date('2026-08-17T11:00:00Z');
    expect(
      store.getContext(POLYMARKET_ASSET_CLASS, 24 * 60 * 60 * 1000, 'test').intel,
    ).toHaveLength(1);
  });

  it('does not re-fetch inside the same hourly bucket', async () => {
    const { agent, fetchEventMarket } = agentWith({});

    await agent.refresh('t1');
    await expect(agent.refresh('t2')).resolves.toBe(false);

    expect(fetchEventMarket).toHaveBeenCalledTimes(1);
  });

  it('archives the raw market bytes AND the derived items (#835)', async () => {
    const archive = new MiArchiveStore();
    const { agent } = agentWith({ archive });

    await agent.refresh('t1');

    expect(archive.rawRows(SOURCE_POLYMARKET)).toHaveLength(1);
    const archived = archive.itemsKnownAt(POLYMARKET_ASSET_CLASS, NOW, [SOURCE_POLYMARKET]);
    expect(archived).toHaveLength(1);
    expect(archived[0]?.source).toBe(SOURCE_POLYMARKET);
    archive.close();
  });

  it('keys the archived item to its own raw row, so provenance links', async () => {
    const archive = new MiArchiveStore();
    const { agent } = agentWith({ archive });

    await agent.refresh('t1');

    const raw = archive.rawRows(SOURCE_POLYMARKET)[0];
    const served = archive.itemsKnownAt(POLYMARKET_ASSET_CLASS, NOW, [SOURCE_POLYMARKET])[0];
    expect(raw).toBeDefined();
    expect(served).toBeDefined();
    if (raw === undefined || served === undefined) return;

    const archived = toArchivedItem(served, raw);
    expect(archived.source).toBe(raw.source);
    expect(archived.native_id).toBe(raw.native_id);
    expect(archived.updated_at.toISOString()).toBe(raw.updated_at.toISOString());
    expect(archived.ingested_at.toISOString()).toBe(raw.ingested_at.toISOString());
    archive.close();
  });
});

describe('PolymarketAgent fail-closed guards (#504 scope item 7)', () => {
  it('ingests nothing when the curated slug has rotted, and says so loudly', async () => {
    const log = vi.fn();
    const { agent, store } = agentWith({ market: undefined, logger: { log } });

    await expect(agent.refresh('t1')).resolves.toBe(false);

    expect(intelFor(store)).toHaveLength(0);
    const warned = log.mock.calls.map(([entry]) => entry).filter((e) => e.level === 'warn');
    expect(warned.some((e) => String(e.message).includes('fed-2026-09'))).toBe(true);
  });

  it('ingests nothing when the fetch fails, and retries on the next refresh', async () => {
    const { agent, store, fetchEventMarket } = agentWith({
      marketError: new Error('ECONNRESET'),
    });

    await expect(agent.refresh('t1')).resolves.toBe(false);
    expect(intelFor(store)).toHaveLength(0);

    await agent.refresh('t2');
    expect(fetchEventMarket).toHaveBeenCalledTimes(2);
  });

  it('retries after a CLOB outage rather than marking the hour answered', async () => {
    const { agent, store, fetchEventMarket } = agentWith({
      historyError: new Error('clob 503'),
    });

    await expect(agent.refresh('t1')).resolves.toBe(false);
    expect(intelFor(store)).toHaveLength(0);

    await agent.refresh('t2');
    expect(fetchEventMarket).toHaveBeenCalledTimes(2);
  });

  it('still marks the hour answered when every row was refused on book quality', async () => {
    const { agent, fetchEventMarket } = agentWith({ market: market({ volume24hr: 5 }) });

    await expect(agent.refresh('t1')).resolves.toBe(false);

    await agent.refresh('t2');
    expect(fetchEventMarket).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a closed market', { closed: true }],
    ['a wide spread', { spread: 0.3, bestBid: 0.5, bestAsk: 0.8 }],
    ['thin 24h volume', { volume24hr: 5 }],
    ['absent 24h volume', { volume24hr: undefined }],
    ['thin liquidity', { liquidity: 10 }],
    ['a stale vendor stamp', { updatedAt: new Date('2026-08-16T00:00:00Z') }],
    ['no vendor stamp at all', { updatedAt: undefined }],
    ['no live book', { bestBid: undefined, bestAsk: undefined, spread: undefined }],
  ])('refuses to ingest on %s', async (_name, overrides) => {
    const { agent, store } = agentWith({ market: market(overrides) });

    await agent.refresh('t1');

    expect(intelFor(store)).toHaveLength(0);
  });

  it('escalates a permanently-refused row from info to warn after a day of passes', async () => {
    const log = vi.fn();
    let at = new Date('2026-08-17T00:00:00Z');
    const store = new MarketIntelligenceStore({ now: () => at });
    const agent = new PolymarketAgent({
      client: {
        fetchEventMarket: async () => market({ volume24hr: 5, updatedAt: at }),
        fetchPriceHistory: async () => [],
      },
      store,
      clock: { now: () => at },
      table: [ENTRY],
      logger: { log },
    });

    const levelsPerPass: string[] = [];
    for (let pass = 0; pass < 24; pass += 1) {
      at = new Date(at.getTime() + 60 * 60 * 1000);
      log.mockClear();
      await agent.refresh(`t${pass}`);
      const refusal = log.mock.calls
        .map(([entry]) => entry)
        .find((entry) => String(entry.message).includes(ENTRY.id));
      levelsPerPass.push(String(refusal?.level));
    }

    expect(levelsPerPass.slice(0, 23).every((level) => level === 'info')).toBe(true);
    expect(levelsPerPass[23]).toBe('warn');
  });

  it('resets the refusal streak once the row answers again', async () => {
    const log = vi.fn();
    let at = new Date('2026-08-17T00:00:00Z');
    let thin = true;
    const store = new MarketIntelligenceStore({ now: () => at });
    const agent = new PolymarketAgent({
      client: {
        fetchEventMarket: async () =>
          thin ? market({ volume24hr: 5, updatedAt: at }) : market({ updatedAt: at }),
        fetchPriceHistory: async () =>
          history(0.67, 0.705).map((point) => ({
            ...point,
            at: new Date(point.at.getTime() + (at.getTime() - NOW.getTime())),
          })),
      },
      store,
      clock: { now: () => at },
      table: [ENTRY],
      logger: { log },
    });

    for (let pass = 0; pass < 23; pass += 1) {
      at = new Date(at.getTime() + 60 * 60 * 1000);
      await agent.refresh(`t${pass}`);
    }
    thin = false;
    at = new Date(at.getTime() + 60 * 60 * 1000);
    await agent.refresh('healthy');
    thin = true;
    at = new Date(at.getTime() + 60 * 60 * 1000);
    log.mockClear();
    await agent.refresh('again');

    const refusal = log.mock.calls
      .map(([entry]) => entry)
      .find((entry) => String(entry.message).includes(ENTRY.id));
    expect(refusal?.level).toBe('info');
  });

  it('resumes a refusal streak from the archive after a simulated restart', async () => {
    const archive = new MiArchiveStore();
    let at = new Date('2026-08-17T00:00:00Z');
    const store = new MarketIntelligenceStore({ now: () => at });
    const client = {
      fetchEventMarket: async () => market({ volume24hr: 5, updatedAt: at }),
      fetchPriceHistory: async () => [],
    };

    const beforeRestart = new PolymarketAgent({
      client,
      store,
      clock: { now: () => at },
      table: [ENTRY],
      archive,
    });
    for (let pass = 0; pass < 12; pass += 1) {
      at = new Date(at.getTime() + 60 * 60 * 1000);
      await beforeRestart.refresh(`before-${pass}`);
    }
    expect(archive.refusalStreak(SOURCE_POLYMARKET, ENTRY.id)).toBe(12);

    const log = vi.fn();
    const afterRestart = new PolymarketAgent({
      client,
      store,
      clock: { now: () => at },
      table: [ENTRY],
      archive,
      logger: { log },
    });
    for (let pass = 0; pass < 12; pass += 1) {
      at = new Date(at.getTime() + 60 * 60 * 1000);
      log.mockClear();
      await afterRestart.refresh(`after-${pass}`);
    }

    expect(archive.refusalStreak(SOURCE_POLYMARKET, ENTRY.id)).toBe(24);
    const refusal = log.mock.calls
      .map(([entry]) => entry)
      .find((entry) => String(entry.message).includes(ENTRY.id));
    expect(refusal?.level).toBe('warn');
    expect(refusal?.payload).toMatchObject({ consecutive_refusals: 24 });
    archive.close();
  });

  it('clears the persisted streak once a row answers again, across a restart', async () => {
    const archive = new MiArchiveStore();
    let at = new Date('2026-08-17T00:00:00Z');
    const store = new MarketIntelligenceStore({ now: () => at });

    const beforeRestart = new PolymarketAgent({
      client: {
        fetchEventMarket: async () => market({ volume24hr: 5, updatedAt: at }),
        fetchPriceHistory: async () => [],
      },
      store,
      clock: { now: () => at },
      table: [ENTRY],
      archive,
    });
    at = new Date(at.getTime() + 60 * 60 * 1000);
    await beforeRestart.refresh('t1');
    expect(archive.refusalStreak(SOURCE_POLYMARKET, ENTRY.id)).toBe(1);

    const log = vi.fn();
    const afterRestart = new PolymarketAgent({
      client: {
        fetchEventMarket: async () => market({ updatedAt: at }),
        fetchPriceHistory: async () =>
          history(0.67, 0.705).map((point) => ({
            ...point,
            at: new Date(point.at.getTime() + (at.getTime() - NOW.getTime())),
          })),
      },
      store,
      clock: { now: () => at },
      table: [ENTRY],
      archive,
      logger: { log },
    });
    at = new Date(at.getTime() + 60 * 60 * 1000);
    await afterRestart.refresh('t2');

    expect(archive.refusalStreak(SOURCE_POLYMARKET, ENTRY.id)).toBe(0);
    archive.close();
  });

  it('refuses when the price history does not span a full 24h', async () => {
    const { agent, store } = agentWith({ history: history(0.4, 0.7, 3) });

    await agent.refresh('t1');

    expect(intelFor(store)).toHaveLength(0);
  });

  it('refuses when the latest history point is stale', async () => {
    const stale = history(0.67, 0.705).map((point) => ({
      ...point,
      at: new Date(point.at.getTime() - 5 * 60 * 60 * 1000),
    }));
    const { agent, store } = agentWith({ history: stale });

    await agent.refresh('t1');

    expect(intelFor(store)).toHaveLength(0);
  });

  it('refuses when the curated bullish outcome is not one of the market outcomes', async () => {
    const { agent, store } = agentWith({ market: market({ outcomes: ['Up', 'Down'] }) });

    await agent.refresh('t1');

    expect(intelFor(store)).toHaveLength(0);
  });

  it('refuses a row whose bullish outcome is pinned near certainty, before the CLOB call', async () => {
    const { agent, store, fetchPriceHistory } = agentWith({
      market: market({ outcomePrices: [0.0055, 0.9945], bestBid: 0.99, bestAsk: 0.995 }),
      history: history(0.97, 0.9945),
    });

    await expect(agent.refresh('t1')).resolves.toBe(false);

    expect(intelFor(store)).toHaveLength(0);
    expect(fetchPriceHistory).not.toHaveBeenCalled();
  });

  it('refuses at 0.075 of headroom and ingests at 0.10 — the bound itself, not just the extremes', async () => {
    const marginal = agentWith({
      market: market({ outcomePrices: [0.075, 0.925], bestBid: 0.92, bestAsk: 0.93 }),
      history: history(0.88, 0.925),
    });
    await marginal.agent.refresh('t1');
    expect(intelFor(marginal.store)).toHaveLength(0);

    const atBound = agentWith({
      market: market({ outcomePrices: [0.1, 0.9], bestBid: 0.89, bestAsk: 0.9 }),
      history: history(0.86, 0.9),
    });
    await expect(atBound.agent.refresh('t2')).resolves.toBe(true);
    expect(intelFor(atBound.store)).toHaveLength(1);
  });

  it('applies the pinned guard to the SHIPPED table, with no table override', async () => {
    const store = new MarketIntelligenceStore(clock);
    const fetchPriceHistory = vi.fn(async () => history(0.97, 0.9945));
    const agent = new PolymarketAgent({
      client: {
        fetchEventMarket: async (_eventSlug: string, marketSlug: string) =>
          market({
            slug: marketSlug,
            outcomePrices: [0.0055, 0.9945],
            bestBid: 0.99,
            bestAsk: 0.995,
          }),
        fetchPriceHistory,
      },
      store,
      clock,
    });

    await expect(agent.refresh('t1')).resolves.toBe(false);

    expect(intelFor(store)).toHaveLength(0);
    expect(fetchPriceHistory).not.toHaveBeenCalled();
  });

  it('keeps the surviving rows when one curated row fails', async () => {
    const second: CuratedMacroMarket = { ...ENTRY, id: 'second', entity: 'US-CPI-YOY' };
    const store = new MarketIntelligenceStore(clock);
    const fetchEventMarket = vi.fn(async (_eventSlug: string, marketSlug: string) => {
      if (marketSlug === 'rotted') return undefined;
      return market();
    });
    const agent = new PolymarketAgent({
      client: { fetchEventMarket, fetchPriceHistory: async () => history(0.67, 0.705) },
      store,
      clock,
      table: [{ ...ENTRY, marketSlug: 'rotted' }, second],
    });

    await expect(agent.refresh('t1')).resolves.toBe(true);

    expect(intelFor(store).map((item) => item.entity)).toEqual(['US-CPI-YOY']);
  });

  it('never throws when the store write itself fails', async () => {
    const store = new MarketIntelligenceStore(clock);
    vi.spyOn(store, 'ingest').mockImplementation(() => {
      throw new Error('store closed');
    });
    const agent = new PolymarketAgent({
      client: {
        fetchEventMarket: async () => market(),
        fetchPriceHistory: async () => history(0.67, 0.705),
      },
      store,
      clock,
      table: [ENTRY],
    });

    await expect(agent.refresh('t1')).resolves.toBe(false);
  });
});

describe('PolymarketAgent.whenIdle', () => {
  it('resolves after an in-flight refresh settles', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = new MarketIntelligenceStore(clock);
    const agent = new PolymarketAgent({
      client: {
        fetchEventMarket: async () => {
          await gate;
          return market();
        },
        fetchPriceHistory: async () => history(0.67, 0.705),
      },
      store,
      clock,
      table: [ENTRY],
    });

    const running = agent.refresh('t1');
    const idle = agent.whenIdle();
    release();
    await Promise.all([running, idle]);

    expect(intelFor(store)).toHaveLength(1);
  });

  it('does not start a second pass while one is in flight', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchEventMarket = vi.fn(async () => {
      await gate;
      return market();
    });
    const store = new MarketIntelligenceStore(clock);
    const agent = new PolymarketAgent({
      client: { fetchEventMarket, fetchPriceHistory: async () => history(0.67, 0.705) },
      store,
      clock,
      table: [ENTRY],
    });

    const first = agent.refresh('t1');
    await expect(agent.refresh('t2')).resolves.toBe(false);
    release();
    await first;

    expect(fetchEventMarket).toHaveBeenCalledTimes(1);
  });
});
