import { fundamentalAnalyst } from '../../pipeline/analysts/index.js';
import { NO_DATA_MARKER, NOOP_ANALYST_TELEMETRY } from '../../pipeline/analysts/types.js';
import type { LlmClient, LlmRequest, SpendCap } from '../../pipeline/debate-engine/index.js';
import type { Clock, LogEntry, Logger } from '../../shared/index.js';
import { AlwaysOpenCalendar } from '../market-data-service/index.js';
import { MiArchiveStore } from './archive/mi-archive-store.js';
import { MI_SOURCES } from './archive/mi-sources.js';
import { MarketIntelligenceStore } from './index.js';
import { MiIngestAgent } from './mi-ingest-agent.js';
import type { AlpacaNewsArticle, AlpacaNewsClient } from './sources/alpaca-news-client.js';

const NOW = new Date('2026-08-15T12:00:00Z');
const clock: Clock = { now: () => NOW };
const WINDOW = 24 * 60 * 60 * 1000;

const ADMITS: SpendCap = {
  check: () => ({ admitted: true, spent_usd: 1, budget_usd: 50 }),
};
const REFUSES: SpendCap = {
  check: () => ({
    admitted: false,
    spent_usd: 50,
    budget_usd: 50,
    reason: 'budget exhausted',
    kind: 'budget',
  }),
};

function recordingLogger(): Logger & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { entries, log: (entry) => entries.push(entry) };
}

function article(overrides: Partial<AlpacaNewsArticle> = {}): AlpacaNewsArticle {
  return {
    id: '1001',
    headline: 'Apple beats on revenue',
    summary: 'Q3 revenue above consensus.',
    symbols: ['AAPL'],
    source: 'benzinga',
    url: 'https://example.test/1',
    created_at: new Date('2026-08-15T11:30:00Z'),
    updated_at: new Date('2026-08-15T11:30:00Z'),
    payload: '{"id":1001}',
    ...overrides,
  };
}

function stubLlmClient(buildRaw: (prompt: string) => string): LlmClient {
  return {
    async complete<T>(request: LlmRequest<T>) {
      const raw = buildRaw(request.prompt);
      const parsed = request.parseResponse(raw);
      if (!parsed.valid) {
        throw new Error(parsed.reason);
      }
      return { data: parsed.data, raw_text: raw, latency_ms: 1 };
    },
  };
}

function scoringClient(sentiment: 1 | 0 | -1 = 1, confidence = 0.8) {
  const calls: string[] = [];
  return {
    calls,
    client: stubLlmClient((prompt) => {
      calls.push(prompt);
      const indices = [...prompt.matchAll(/^(\d+)\. /gm)].map((match) => Number(match[1]));
      return JSON.stringify({
        scores: indices.map((index) => ({ index, sentiment, confidence })),
      });
    }),
  };
}

function newsClient(articles: AlpacaNewsArticle[]) {
  return {
    fetchNews: vi.fn(async () => articles),
  } as unknown as AlpacaNewsClient;
}

function failingScoringClient(message = 'llm down') {
  return { complete: async () => Promise.reject(new Error(message)) };
}

function build(
  articles: AlpacaNewsArticle[],
  sentiment: 1 | 0 | -1 = 1,
  options: { spendCap?: SpendCap; logger?: Logger } = {},
) {
  const archive = new MiArchiveStore();
  const store = new MarketIntelligenceStore(clock);
  const scorer = scoringClient(sentiment);
  const news = newsClient(articles);
  const agent = new MiIngestAgent({
    archive,
    store,
    newsClient: news,
    llmClient: scorer.client,
    clock,
    assetClasses: ['stocks', 'crypto'],
    spendCap: options.spendCap ?? ADMITS,
    logger: options.logger,
  });
  return { agent, archive, store, scorer, news };
}

describe('MiIngestAgent', () => {
  it('fetches, scores, archives and serves in one refresh', async () => {
    const { agent, archive, store } = build([article()]);

    await agent.refresh('t', 'AAPL', 'stocks');

    expect(archive.rawRows('alpaca-news')).toHaveLength(1);
    const context = store.getContext('stocks', WINDOW, 't');
    expect(context.news).toHaveLength(1);
    expect(context.news[0]?.headline).toBe('Apple beats on revenue');
    expect(context.news[0]?.sentiment).toBe(1);
  });

  it('logs a wider article count than item count when the fetch returns an article for another instrument', async () => {
    const logger = recordingLogger();
    const { agent } = build(
      [
        article({ id: '1001', symbols: ['AAPL'] }),
        article({ id: '1002', symbols: ['TSLA'], headline: 'Tesla recalls vehicles' }),
      ],
      1,
      { logger },
    );

    await agent.refresh('t', 'AAPL', 'stocks');

    const entry = logger.entries.find(
      (e) => e.message === 'market intelligence: ingested scored news items',
    );
    expect(entry?.payload).toMatchObject({ articles: 2, items: 1 });
  });

  it('stops the fundamental analyst reporting NO DATA', async () => {
    const { agent, store } = build([article()]);

    const marketData = {
      getMark: async () => ({
        price: 100,
        observed_at: NOW,
        asset_class: 'stocks' as const,
        source: 'fixture',
      }),
    } as unknown as Parameters<typeof fundamentalAnalyst.run>[0]['market_data'];

    const input = {
      trace_id: 't',
      signal: { asset: 'AAPL', asset_class: 'stocks' as const },
      clock,
      bar: NOW,
      market_intelligence: store,
      market_data: marketData,
      calendar: new AlwaysOpenCalendar(),
      telemetry: NOOP_ANALYST_TELEMETRY,
    };

    const before = await fundamentalAnalyst.run(input);
    expect(before.key_points.join(' ')).toContain(NO_DATA_MARKER);
    expect(before.direction).toBe('neutral');
    expect(before.confidence).toBe(0.05);

    await agent.refresh('t', 'AAPL', 'stocks');

    const after = await fundamentalAnalyst.run(input);

    expect(after.key_points.join(' ')).not.toContain(NO_DATA_MARKER);
    expect(after.direction).toBe('bullish');
    expect(after.confidence).toBeGreaterThan(0.05);
  });

  it('attributes a multi-symbol article to the instrument being refreshed', async () => {
    const { agent, store } = build([article({ symbols: ['AAPL', 'NVDA'] })]);

    await agent.refresh('t', 'AAPL', 'stocks');

    expect(store.getContext('stocks', WINDOW, 't').news.map((item) => item.entity)).toEqual([
      'AAPL',
    ]);
  });

  it('scores a shared multi-symbol article separately for a second instrument that covers it', async () => {
    const shared = article({ symbols: ['AAPL', 'NVDA'] });
    const { agent, store, scorer } = build([shared]);

    await agent.refresh('t', 'AAPL', 'stocks');
    expect(scorer.calls).toHaveLength(1);
    expect(store.getContext('stocks', WINDOW, 't').news.map((item) => item.entity)).toEqual([
      'AAPL',
    ]);

    await agent.refresh('t', 'NVDA', 'stocks');
    expect(scorer.calls).toHaveLength(2);
    expect(
      store
        .getContext('stocks', WINDOW, 't')
        .news.map((item) => item.entity)
        .sort(),
    ).toEqual(['AAPL', 'NVDA']);
  });

  it('archives a market-wide roundup but neither scores it nor serves it as name news', async () => {
    const roundup = article({
      id: '2001',
      headline: 'Stock Market Today: futures drop',
      symbols: ['AAPL', 'AMD', 'AVGO', 'MU', 'NVDA', 'SMCI'],
    });
    const { agent, archive, store, scorer } = build([roundup], -1);

    expect(await agent.refresh('t', 'AAPL', 'stocks')).toBe(false);

    expect(archive.rawRows('alpaca-news')).toHaveLength(1);
    expect(scorer.calls).toHaveLength(0);
    expect(store.getContext('stocks', WINDOW, 't', undefined, 'AAPL').news).toEqual([]);
  });

  it('still scores an article tagging as many symbols as the name-news cap allows', async () => {
    const { agent, store } = build([article({ symbols: ['AAPL', 'AMD', 'AVGO', 'MU', 'NVDA'] })]);

    expect(await agent.refresh('t', 'AAPL', 'stocks')).toBe(true);

    expect(store.getContext('stocks', WINDOW, 't', undefined, 'AAPL').news).toHaveLength(1);
  });

  it('serves the name-specific article when a roundup arrives in the same fetch', async () => {
    const { agent, store } = build([
      article({ id: '1001', symbols: ['AAPL'] }),
      article({
        id: '2001',
        headline: 'Why Is Marvell Stock Falling Monday?',
        symbols: ['AAPL', 'AMD', 'AVGO', 'MRVL', 'MU', 'NVDA', 'SMCI'],
      }),
    ]);

    await agent.refresh('t', 'AAPL', 'stocks');

    expect(
      store.getContext('stocks', WINDOW, 't', undefined, 'AAPL').news.map((item) => item.headline),
    ).toEqual(['Apple beats on revenue']);
  });

  it('converts a dash-form crypto id to the wire symbol', async () => {
    const { agent, news } = build([article({ symbols: ['BTCUSD'] })]);

    await agent.refresh('t', 'BTC-USD', 'crypto');

    expect(news.fetchNews).toHaveBeenCalledWith(['BTCUSD'], expect.any(Date), expect.any(Date));
  });

  it('resolves an LSE ETP instrument to its screening_instrument before fetching news, and tags items with the resolved entity', async () => {
    const { agent, store, news } = build([article({ symbols: ['SPY'] })]);

    await agent.refresh('t', '3USL', 'stocks');

    expect(news.fetchNews).toHaveBeenCalledWith(['SPY'], expect.any(Date), expect.any(Date));
    expect(store.getContext('stocks', WINDOW, 't').news.map((item) => item.entity)).toEqual([
      'SPY',
    ]);
  });

  it('does not re-score an article it already holds', async () => {
    const { agent, scorer, store } = build([article()]);

    await agent.refresh('t', 'AAPL', 'stocks');
    expect(scorer.calls).toHaveLength(1);

    await agent.refresh('t', 'AAPL', 'stocks');
    expect(scorer.calls).toHaveLength(1);
    expect(store.getContext('stocks', WINDOW, 't').news).toHaveLength(1);
  });

  it('treats a vendor revision as new work, not a duplicate', async () => {
    const revised = article({
      headline: 'Apple beats on revenue (corrected)',
      updated_at: new Date('2026-08-15T11:45:00Z'),
    });
    const { agent, archive, scorer } = build([article()]);

    await agent.refresh('t', 'AAPL', 'stocks');
    (
      agent as unknown as { deps: { newsClient: { fetchNews: () => Promise<unknown> } } }
    ).deps.newsClient.fetchNews = async () => [revised];
    await agent.refresh('t', 'AAPL', 'stocks');

    expect(scorer.calls).toHaveLength(2);
    expect(archive.rawRows('alpaca-news')).toHaveLength(2);
  });

  it('refuses to score BEFORE calling the LLM when the spend cap is exhausted', async () => {
    const logger = recordingLogger();
    const { agent, scorer, store } = build([article()], 1, { spendCap: REFUSES, logger });

    await expect(agent.refresh('t', 'AAPL', 'stocks')).resolves.toBe(false);

    expect(scorer.calls).toHaveLength(0);
    expect(store.getContext('stocks', WINDOW, 't').news).toEqual([]);
    expect(
      logger.entries.some(
        (entry) => entry.level === 'warn' && entry.event === 'mi_ingest_refused_spend_cap',
      ),
    ).toBe(true);
  });

  it('survives a vendor outage without throwing', async () => {
    const { agent, store } = build([]);
    (
      agent as unknown as { deps: { newsClient: { fetchNews: () => Promise<unknown> } } }
    ).deps.newsClient.fetchNews = async () => {
      throw new Error('alpaca down');
    };

    await expect(agent.refresh('t', 'AAPL', 'stocks')).resolves.toBe(false);
    expect(store.getContext('stocks', WINDOW, 't').news).toEqual([]);
  });

  it('archives the raw bytes but not a scored item, and logs the cause, when scoring fails', async () => {
    const logger = recordingLogger();
    const archive = new MiArchiveStore();
    const store = new MarketIntelligenceStore(clock);
    const agent = new MiIngestAgent({
      archive,
      store,
      newsClient: newsClient([article()]),
      llmClient: failingScoringClient(),
      clock,
      assetClasses: ['stocks'],
      spendCap: ADMITS,
      logger,
    });

    await expect(agent.refresh('t', 'AAPL', 'stocks')).resolves.toBe(false);

    expect(archive.rawRows('alpaca-news')).toHaveLength(1);
    expect(store.getContext('stocks', WINDOW, 't').news).toEqual([]);
    expect(
      logger.entries.some(
        (entry) => entry.level === 'warn' && entry.event === 'mi_ingest_scoring_degraded',
      ),
    ).toBe(true);
  });

  it('retries the same article on the next refresh after a scoring outage, once scoring recovers', async () => {
    const archive = new MiArchiveStore();
    const store = new MarketIntelligenceStore(clock);
    const agent = new MiIngestAgent({
      archive,
      store,
      newsClient: newsClient([article()]),
      llmClient: failingScoringClient(),
      clock,
      assetClasses: ['stocks'],
      spendCap: ADMITS,
    });

    await expect(agent.refresh('t', 'AAPL', 'stocks')).resolves.toBe(false);
    expect(store.getContext('stocks', WINDOW, 't').news).toEqual([]);

    (agent as unknown as { deps: { llmClient: unknown } }).deps.llmClient = scoringClient().client;

    await expect(agent.refresh('t', 'AAPL', 'stocks')).resolves.toBe(true);
    expect(store.getContext('stocks', WINDOW, 't').news).toHaveLength(1);
  });

  it('skips the scoring attempt on the third straight refresh after two consecutive failures, then retries on the fourth', async () => {
    const archive = new MiArchiveStore();
    const store = new MarketIntelligenceStore(clock);
    const failing = failingScoringClient();
    const agent = new MiIngestAgent({
      archive,
      store,
      newsClient: newsClient([article()]),
      llmClient: failing,
      clock,
      assetClasses: ['stocks'],
      spendCap: ADMITS,
    });

    await expect(agent.refresh('t', 'AAPL', 'stocks')).resolves.toBe(false);
    await expect(agent.refresh('t', 'AAPL', 'stocks')).resolves.toBe(false);

    const scorer = scoringClient();
    (agent as unknown as { deps: { llmClient: unknown } }).deps.llmClient = scorer.client;

    await expect(agent.refresh('t', 'AAPL', 'stocks')).resolves.toBe(false);
    expect(scorer.calls).toHaveLength(0);
    expect(archive.rawRows('alpaca-news')).toHaveLength(1);

    await expect(agent.refresh('t', 'AAPL', 'stocks')).resolves.toBe(true);
    expect(scorer.calls).toHaveLength(1);
    expect(store.getContext('stocks', WINDOW, 't').news).toHaveLength(1);
  });

  it('logs when the consecutive-failure streak skips a scoring attempt', async () => {
    const archive = new MiArchiveStore();
    const store = new MarketIntelligenceStore(clock);
    const logger = recordingLogger();
    const agent = new MiIngestAgent({
      archive,
      store,
      newsClient: newsClient([article()]),
      llmClient: failingScoringClient(),
      clock,
      assetClasses: ['stocks'],
      spendCap: ADMITS,
      logger,
    });

    await agent.refresh('t', 'AAPL', 'stocks');
    await agent.refresh('t', 'AAPL', 'stocks');
    logger.entries.length = 0;

    await expect(agent.refresh('t', 'AAPL', 'stocks')).resolves.toBe(false);

    expect(
      logger.entries.some(
        (entry) => entry.level === 'warn' && entry.event === 'mi_ingest_scoring_skipped',
      ),
    ).toBe(true);
  });

  it('does not carry a stale skip cooldown across a refresh with nothing new to score', async () => {
    const archive = new MiArchiveStore();
    const store = new MarketIntelligenceStore(clock);
    const news = newsClient([article()]);
    const agent = new MiIngestAgent({
      archive,
      store,
      newsClient: news,
      llmClient: failingScoringClient(),
      clock,
      assetClasses: ['stocks'],
      spendCap: ADMITS,
    });

    await agent.refresh('t', 'AAPL', 'stocks');
    await agent.refresh('t', 'AAPL', 'stocks');

    (agent as unknown as { deps: { newsClient: unknown } }).deps.newsClient = newsClient([]);
    await expect(agent.refresh('t', 'AAPL', 'stocks')).resolves.toBe(false);

    const scorer = scoringClient();
    (agent as unknown as { deps: { newsClient: unknown; llmClient: unknown } }).deps.newsClient =
      news;
    (agent as unknown as { deps: { llmClient: unknown } }).deps.llmClient = scorer.client;

    await expect(agent.refresh('t', 'AAPL', 'stocks')).resolves.toBe(true);
    expect(scorer.calls).toHaveLength(1);
  });

  it("bounds a sustained outage to a handful of scoring attempts across a full lookback window, not the flat rule's ~20-of-30", async () => {
    const archive = new MiArchiveStore();
    const store = new MarketIntelligenceStore(clock);
    let now = NOW;
    const movingClock: Clock = { now: () => now };
    let attempts = 0;
    const countingFailingClient = {
      complete: async () => {
        attempts++;
        throw new Error('llm down');
      },
    };
    const agent = new MiIngestAgent({
      archive,
      store,
      newsClient: newsClient([article()]),
      llmClient: countingFailingClient,
      clock: movingClock,
      assetClasses: ['stocks'],
      spendCap: ADMITS,
    });

    const TICK_MS = 2 * 60_000;
    const REFRESHES_PER_LOOKBACK_WINDOW = 30;

    for (let i = 0; i < REFRESHES_PER_LOOKBACK_WINDOW; i++) {
      await agent.refresh('t', 'AAPL', 'stocks');
      now = new Date(now.getTime() + TICK_MS);
    }

    expect(attempts).toBe(7);
  });

  it('keeps widening the backoff after a quiet refresh interrupts a sustained outage', async () => {
    const archive = new MiArchiveStore();
    const store = new MarketIntelligenceStore(clock);
    let now = NOW;
    const movingClock: Clock = { now: () => now };
    let attempts = 0;
    const countingFailingClient = {
      complete: async () => {
        attempts++;
        throw new Error('llm down');
      },
    };
    const agent = new MiIngestAgent({
      archive,
      store,
      newsClient: newsClient([article()]),
      llmClient: countingFailingClient,
      clock: movingClock,
      assetClasses: ['stocks'],
      spendCap: ADMITS,
    });
    const TICK_MS = 2 * 60_000;
    const tick = async () => {
      await agent.refresh('t', 'AAPL', 'stocks');
      now = new Date(now.getTime() + TICK_MS);
    };

    await tick();
    await tick();

    (agent as unknown as { deps: { newsClient: unknown } }).deps.newsClient = newsClient([]);
    await agent.refresh('t', 'AAPL', 'stocks');
    now = new Date(now.getTime() + TICK_MS);
    (agent as unknown as { deps: { newsClient: unknown } }).deps.newsClient = newsClient([
      article(),
    ]);

    for (let i = 0; i < 8; i++) {
      await tick();
    }

    expect(attempts).toBe(4);
  });

  it('decays a streak once LOOKBACK_MS has passed since the last failure, so a later lone blip is not skipped', async () => {
    const archive = new MiArchiveStore();
    const store = new MarketIntelligenceStore(clock);
    let now = NOW;
    const movingClock: Clock = { now: () => now };
    let attempts = 0;
    const failingClient = {
      complete: async () => {
        attempts++;
        throw new Error('llm down');
      },
    };
    const agent = new MiIngestAgent({
      archive,
      store,
      newsClient: newsClient([article()]),
      llmClient: failingClient,
      clock: movingClock,
      assetClasses: ['stocks'],
      spendCap: ADMITS,
    });
    const TICK_MS = 2 * 60_000;
    const advance = () => {
      now = new Date(now.getTime() + TICK_MS);
    };

    await agent.refresh('t', 'AAPL', 'stocks');
    advance();
    await agent.refresh('t', 'AAPL', 'stocks');
    advance();
    expect(attempts).toBe(2);

    (agent as unknown as { deps: { newsClient: unknown } }).deps.newsClient = newsClient([]);
    for (let i = 0; i < 30; i++) {
      await agent.refresh('t', 'AAPL', 'stocks');
      advance();
    }

    (agent as unknown as { deps: { newsClient: unknown } }).deps.newsClient = newsClient([
      article(),
    ]);
    await agent.refresh('t', 'AAPL', 'stocks');
    advance();
    expect(attempts).toBe(3);

    await agent.refresh('t', 'AAPL', 'stocks');
    expect(attempts).toBe(4);
  });

  it('hydrate() restores a fresh store from the archive after a restart', async () => {
    const { agent, archive } = build([article()]);
    await agent.refresh('t', 'AAPL', 'stocks');

    const restarted = new MarketIntelligenceStore(clock);
    const afterRestart = new MiIngestAgent({
      archive,
      store: restarted,
      newsClient: newsClient([]),
      llmClient: scoringClient().client,
      clock,
      assetClasses: ['stocks'],
      spendCap: ADMITS,
    });

    expect(restarted.getContext('stocks', WINDOW, 't').news).toEqual([]);
    afterRestart.hydrate();
    expect(restarted.getContext('stocks', WINDOW, 't').news).toHaveLength(1);
  });

  it('hydrate() replays observation sources and skips archive-only ones (#835)', async () => {
    const { agent, archive } = build([article()]);
    await agent.refresh('t', 'AAPL', 'stocks');

    const at = new Date('2026-08-15T11:45:00Z');
    archive.write(
      [
        {
          source: MI_SOURCES.polymarket,
          native_id: 'FOMC-2026-09:2026-08-15T11:00:00.000Z',
          updated_at: at,
          payload: '{}',
          ingested_at: at,
          fidelity: 'live',
        },
      ],
      [
        {
          source: MI_SOURCES.polymarket,
          native_id: 'FOMC-2026-09:2026-08-15T11:00:00.000Z',
          updated_at: at,
          entity: 'FOMC-2026-09',
          asset_class: 'stocks',
          ingested_at: at,
          item: {
            id: 'polymarket:FOMC-2026-09:2026-08-15T11:00:00.000Z',
            source: MI_SOURCES.polymarket,
            type: 'news',
            timestamp: at,
            entity: 'FOMC-2026-09',
            headline: 'Fed holds in September: 0.295 -> 0.440 over 24h',
            sentiment: 1,
            confidence: 0.7,
          },
        },
      ],
    );

    const restarted = new MarketIntelligenceStore(clock);
    new MiIngestAgent({
      archive,
      store: restarted,
      newsClient: newsClient([]),
      llmClient: scoringClient().client,
      clock,
      assetClasses: ['stocks'],
      spendCap: ADMITS,
    }).hydrate();

    const news = restarted.getContext('stocks', WINDOW, 't').news;
    expect(news).toHaveLength(1);
    expect(news[0]?.source).toBe('benzinga');
    expect(news.some((entry) => entry.source === MI_SOURCES.polymarket)).toBe(false);
  });

  it('archives the raw bytes but withholds an item the model omitted from its response, leaving it a scoring candidate', async () => {
    const archive = new MiArchiveStore();
    const store = new MarketIntelligenceStore(clock);
    const omittedArticle = article({ id: '1002', headline: 'Apple faces antitrust probe' });
    const omitsSecondIndex = stubLlmClient(() =>
      JSON.stringify({ scores: [{ index: 0, sentiment: 1, confidence: 0.8 }] }),
    );
    const agent = new MiIngestAgent({
      archive,
      store,
      newsClient: newsClient([
        article({ id: '1001', headline: 'Apple beats on revenue' }),
        omittedArticle,
      ]),
      llmClient: omitsSecondIndex,
      clock,
      assetClasses: ['stocks'],
      spendCap: ADMITS,
    });

    await expect(agent.refresh('t', 'AAPL', 'stocks')).resolves.toBe(true);

    const news = store.getContext('stocks', WINDOW, 't').news;
    expect(news).toHaveLength(1);
    expect(news[0]).toMatchObject({
      headline: 'Apple beats on revenue',
      sentiment: 1,
      confidence: 0.8,
    });

    expect(
      archive.hasItem(MI_SOURCES.alpacaNews, omittedArticle.id, omittedArticle.updated_at),
    ).toBe(true);
    expect(
      archive.hasScoredItem(
        MI_SOURCES.alpacaNews,
        omittedArticle.id,
        omittedArticle.updated_at,
        'AAPL',
      ),
    ).toBe(false);
  });

  it('rescoring an article the model previously omitted on a later refresh replaces the withheld gap with a real score', async () => {
    const archive = new MiArchiveStore();
    const store = new MarketIntelligenceStore(clock);
    const omittedArticle = article({ id: '1002', headline: 'Apple faces antitrust probe' });
    const omitsSecondIndex = stubLlmClient(() =>
      JSON.stringify({ scores: [{ index: 0, sentiment: 1, confidence: 0.8 }] }),
    );
    const agent = new MiIngestAgent({
      archive,
      store,
      newsClient: newsClient([
        article({ id: '1001', headline: 'Apple beats on revenue' }),
        omittedArticle,
      ]),
      llmClient: omitsSecondIndex,
      clock,
      assetClasses: ['stocks'],
      spendCap: ADMITS,
    });

    await expect(agent.refresh('t', 'AAPL', 'stocks')).resolves.toBe(true);
    expect(
      archive.hasScoredItem(
        MI_SOURCES.alpacaNews,
        omittedArticle.id,
        omittedArticle.updated_at,
        'AAPL',
      ),
    ).toBe(false);

    (agent as unknown as { deps: { llmClient: unknown } }).deps.llmClient = scoringClient(
      -1,
      0.9,
    ).client;

    await expect(agent.refresh('t', 'AAPL', 'stocks')).resolves.toBe(true);

    expect(
      archive.hasScoredItem(
        MI_SOURCES.alpacaNews,
        omittedArticle.id,
        omittedArticle.updated_at,
        'AAPL',
      ),
    ).toBe(true);
    const news = store.getContext('stocks', WINDOW, 't').news;
    const rescored = news.find((item) => item.headline === 'Apple faces antitrust probe');
    expect(rescored).toMatchObject({ sentiment: -1, confidence: 0.9 });
  });

  it('serves nothing for a refresh where every item was omitted, leaving the window uncovered', async () => {
    const archive = new MiArchiveStore();
    const store = new MarketIntelligenceStore(clock);
    const articleA = article({ id: '1001', headline: 'Apple faces antitrust probe' });
    const articleB = article({ id: '1002', headline: 'Apple supplier disruption' });
    const answersOutOfRangeIndexOnly = stubLlmClient(() =>
      JSON.stringify({ scores: [{ index: 99, sentiment: 1, confidence: 0.8 }] }),
    );
    const agent = new MiIngestAgent({
      archive,
      store,
      newsClient: newsClient([articleA, articleB]),
      llmClient: answersOutOfRangeIndexOnly,
      clock,
      assetClasses: ['stocks'],
      spendCap: ADMITS,
    });

    await expect(agent.refresh('t', 'AAPL', 'stocks')).resolves.toBe(true);

    const context = store.getContext('stocks', WINDOW, 't');
    expect(context.news).toHaveLength(0);
    expect(context.news.some((item) => item.entity === 'AAPL')).toBe(false);
    expect(archive.hasItem(MI_SOURCES.alpacaNews, articleA.id, articleA.updated_at)).toBe(true);
    expect(archive.hasItem(MI_SOURCES.alpacaNews, articleB.id, articleB.updated_at)).toBe(true);
    expect(
      archive.hasScoredItem(MI_SOURCES.alpacaNews, articleA.id, articleA.updated_at, 'AAPL'),
    ).toBe(false);
    expect(
      archive.hasScoredItem(MI_SOURCES.alpacaNews, articleB.id, articleB.updated_at, 'AAPL'),
    ).toBe(false);

    const marketData = {
      getMark: async () => ({
        price: 150,
        observed_at: NOW,
        asset_class: 'stocks' as const,
        source: 'fixture',
      }),
    } as unknown as Parameters<typeof fundamentalAnalyst.run>[0]['market_data'];

    const view = await fundamentalAnalyst.run({
      trace_id: 't',
      signal: { asset: 'AAPL', asset_class: 'stocks' as const },
      clock,
      bar: NOW,
      market_intelligence: store,
      market_data: marketData,
      calendar: new AlwaysOpenCalendar(),
      telemetry: NOOP_ANALYST_TELEMETRY,
    });
    expect(view.key_points[0]).toContain(NO_DATA_MARKER);
  });
});
