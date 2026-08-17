import { describe, expect, it, vi } from 'vitest';
import type { Clock, Logger } from '../../../shared/index.js';
import { MiArchiveStore } from '../archive/mi-archive-store.js';
import { MarketIntelligenceStore } from '../index.js';
import type { CuratedMacroMarket } from './curated-markets.js';
import { POLYMARKET_ASSET_CLASS, PolymarketAgent, SOURCE_POLYMARKET } from './polymarket-agent.js';
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

/** A 24h hourly series ending `at` NOW, running from `from` to `to`. */
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

function newsFor(store: MarketIntelligenceStore) {
  return store.getContext(POLYMARKET_ASSET_CLASS, 24 * 60 * 60 * 1000, 'test').news;
}

describe('PolymarketAgent.refresh', () => {
  it('ingests one news item per curated event, signed by the 24h delta', async () => {
    const { agent, store } = agentWith({ history: history(0.67, 0.705) });

    await expect(agent.refresh('t1')).resolves.toBe(true);

    const news = newsFor(store);
    expect(news).toHaveLength(1);
    expect(news[0]).toMatchObject({
      source: SOURCE_POLYMARKET,
      type: 'news',
      entity: 'FOMC-2026-09',
      sentiment: 1,
    });
    // 0.035 delta * 5 = 0.175.
    expect(news[0]?.confidence).toBeCloseTo(0.175, 6);
    expect(news[0]?.headline).toContain('0.670');
    expect(news[0]?.headline).toContain('0.705');
  });

  it('reads the delta on the BULLISH outcome token, not the first one', async () => {
    const { agent, fetchPriceHistory } = agentWith({});

    await agent.refresh('t1');

    expect(fetchPriceHistory).toHaveBeenCalledWith('token-no');
  });

  it('signs a falling bullish probability as bearish', async () => {
    const { agent, store } = agentWith({ history: history(0.705, 0.5) });

    await agent.refresh('t1');

    expect(newsFor(store)[0]?.sentiment).toBe(-1);
    // |delta| = 0.205 -> 1.025, clamped to the 0.95 ceiling.
    expect(newsFor(store)[0]?.confidence).toBe(0.95);
  });

  it('emits sentiment 0 inside the dead band — "we looked and it did not move"', async () => {
    const { agent, store } = agentWith({ history: history(0.7, 0.71) });

    await agent.refresh('t1');

    expect(newsFor(store)[0]?.sentiment).toBe(0);
    expect(newsFor(store)[0]?.confidence).toBeCloseTo(0.05, 6);
  });

  it('stamps the item at the floored refresh bucket so the debate bar can see it', async () => {
    const { agent, store } = agentWith({});

    await agent.refresh('t1');

    expect(newsFor(store)[0]?.timestamp).toEqual(new Date('2026-08-17T12:00:00Z'));
  });

  it('does not re-fetch inside the same hourly bucket', async () => {
    const { agent, fetchEventMarket } = agentWith({});

    await agent.refresh('t1');
    await expect(agent.refresh('t2')).resolves.toBe(false);

    expect(fetchEventMarket).toHaveBeenCalledTimes(1);
  });

  it('archives the raw market bytes and NO archived items', async () => {
    const archive = new MiArchiveStore();
    const { agent } = agentWith({ archive });

    await agent.refresh('t1');

    expect(archive.rawRows(SOURCE_POLYMARKET)).toHaveLength(1);
    // Items are deliberately not archived — see the agent header.
    expect(archive.itemsKnownAt(POLYMARKET_ASSET_CLASS, NOW)).toHaveLength(0);
  });
});

describe('PolymarketAgent fail-closed guards (#504 scope item 7)', () => {
  it('ingests nothing when the curated slug has rotted, and says so loudly', async () => {
    const log = vi.fn();
    const { agent, store } = agentWith({ market: undefined, logger: { log } });

    await expect(agent.refresh('t1')).resolves.toBe(false);

    expect(newsFor(store)).toHaveLength(0);
    const warned = log.mock.calls.map(([entry]) => entry).filter((e) => e.level === 'warn');
    expect(warned.some((e) => String(e.message).includes('fed-2026-09'))).toBe(true);
  });

  it('ingests nothing when the fetch fails, and retries on the next refresh', async () => {
    const { agent, store, fetchEventMarket } = agentWith({
      marketError: new Error('ECONNRESET'),
    });

    await expect(agent.refresh('t1')).resolves.toBe(false);
    expect(newsFor(store)).toHaveLength(0);

    // The bucket is NOT marked, so a transient failure does not buy an hour of
    // silence.
    await agent.refresh('t2');
    expect(fetchEventMarket).toHaveBeenCalledTimes(2);
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

    expect(newsFor(store)).toHaveLength(0);
  });

  it('refuses when the price history does not span a full 24h', async () => {
    // Three hours of history: a large move over it would otherwise land as a
    // HIGH-confidence signal built on almost no data.
    const { agent, store } = agentWith({ history: history(0.4, 0.7, 3) });

    await agent.refresh('t1');

    expect(newsFor(store)).toHaveLength(0);
  });

  it('refuses when the latest history point is stale', async () => {
    const stale = history(0.67, 0.705).map((point) => ({
      ...point,
      at: new Date(point.at.getTime() - 5 * 60 * 60 * 1000),
    }));
    const { agent, store } = agentWith({ history: stale });

    await agent.refresh('t1');

    expect(newsFor(store)).toHaveLength(0);
  });

  it('refuses when the curated bullish outcome is not one of the market outcomes', async () => {
    const { agent, store } = agentWith({ market: market({ outcomes: ['Up', 'Down'] }) });

    await agent.refresh('t1');

    expect(newsFor(store)).toHaveLength(0);
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

    expect(newsFor(store).map((item) => item.entity)).toEqual(['US-CPI-YOY']);
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

    expect(newsFor(store)).toHaveLength(1);
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
