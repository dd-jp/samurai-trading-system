import { fundamentalAnalyst } from '../../pipeline/analysts/index.js';
import { NO_DATA_MARKER, NOOP_ANALYST_TELEMETRY } from '../../pipeline/analysts/types.js';
import type { SpendCap } from '../../pipeline/debate-engine/index.js';
import type { Clock, Logger } from '../../shared/index.js';
import type { LogEntry } from '../../shared/types.js';
import { AlwaysOpenCalendar } from '../market-data-service/index.js';
import { MiArchiveStore } from './archive/mi-archive-store.js';
import { MI_SOURCES } from './archive/mi-sources.js';
import { MarketIntelligenceStore } from './index.js';
import { MiIngestAgent } from './mi-ingest-agent.js';
import type { AlpacaNewsArticle, AlpacaNewsClient } from './sources/alpaca-news-client.js';

const NOW = new Date('2026-08-15T12:00:00Z');
const clock: Clock = { now: () => NOW };
/** The window `fundamental-analyst.ts` itself asks for (MI_CONTEXT_WINDOW_MS). */
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

/** Returns a fixed score for every item, in input order. */
function scoringClient(sentiment: 1 | 0 | -1 = 1, confidence = 0.8) {
  const calls: string[] = [];
  return {
    calls,
    client: {
      async complete(request: { prompt: string; parseResponse: (raw: string) => unknown }) {
        calls.push(request.prompt);
        // Score every numbered line the prompt contains.
        const indices = [...request.prompt.matchAll(/^(\d+)\. /gm)].map((match) =>
          Number(match[1]),
        );
        const raw = JSON.stringify({
          scores: indices.map((index) => ({ index, sentiment, confidence })),
        });
        const parsed = request.parseResponse(raw) as { valid: boolean; data: unknown };
        return { data: parsed.data, raw_text: raw, latency_ms: 1 };
      },
    },
  };
}

function newsClient(articles: AlpacaNewsArticle[]) {
  return {
    fetchNews: vi.fn(async () => articles),
  } as unknown as AlpacaNewsClient;
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
    // biome-ignore lint/suspicious/noExplicitAny: minimal LlmClient stand-in.
    llmClient: scorer.client as any,
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

  /**
   * The whole point of map #552, asserted end to end against the real analyst.
   *
   * Before this path, `MarketIntelligenceStore` ingested `[]` on every refresh,
   * so `fundamental` returned `NO_DATA_MARKER` at confidence 0.05 on every
   * production tick. #625 then measured the consequence: with the two news-fed
   * analysts pinned at 0.05, the stocks conviction ceiling was 0.5478 against a
   * 0.55 floor — a stock could never trade, at any RSI, in any market.
   */
  it('stops the fundamental analyst reporting NO DATA', async () => {
    const { agent, store } = build([article()]);

    /** The one MarketDataService member `fundamental-analyst.ts` reaches for. */
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
    // Real confidence rather than the 0.05 floor that pinned the evidence
    // average and produced #625's 0.5478 ceiling.
    expect(after.confidence).toBeGreaterThan(0.05);
  });

  it('attributes a multi-symbol article to the instrument being refreshed', async () => {
    // Refresh is per instrument (the `MarketIntelligenceRefresh` contract), so
    // an article tagged AAPL and NVDA becomes one item for AAPL. Scoring is
    // per entity because a headline can be bullish for one ticker and bearish
    // for another — asking once per instrument is what keeps that honest.
    const { agent, store } = build([article({ symbols: ['AAPL', 'NVDA'] })]);

    await agent.refresh('t', 'AAPL', 'stocks');

    expect(store.getContext('stocks', WINDOW, 't').news.map((item) => item.entity)).toEqual([
      'AAPL',
    ]);
  });

  it('converts a dash-form crypto id to the wire symbol', async () => {
    // The repo carries crypto as `BTC-USD`; Alpaca expects `BTCUSD`. The same
    // mismatch made every crypto order reject with 'asset not found' in #585.
    const { agent, news } = build([article({ symbols: ['BTCUSD'] })]);

    await agent.refresh('t', 'BTC-USD', 'crypto');

    expect(news.fetchNews).toHaveBeenCalledWith(['BTCUSD'], expect.any(Date), expect.any(Date));
  });

  /**
   * #914/#960: the ingestion-side half of the MI-wide rule. An LSE-listed
   * leveraged ETP generates no headlines of its own — the wire only carries
   * news for the US underlying it tracks. Before this, `refresh` fetched and
   * tagged items under the raw traded instrument (`3USL`), so an LSE row's MI
   * items were filed under a symbol the wire never mentions and an
   * entity-scoped read for the underlying (`SPY`) would never find them.
   */
  it('resolves an LSE ETP instrument to its screening_instrument before fetching news, and tags items with the resolved entity', async () => {
    const { agent, store, news } = build([article({ symbols: ['SPY'] })]);

    await agent.refresh('t', '3USL', 'stocks');

    // Fetched the underlying's wire symbol, not the wrapper's.
    expect(news.fetchNews).toHaveBeenCalledWith(['SPY'], expect.any(Date), expect.any(Date));
    // Filed under the resolved subject, not the traded ticker.
    expect(store.getContext('stocks', WINDOW, 't').news.map((item) => item.entity)).toEqual([
      'SPY',
    ]);
  });

  /**
   * The refresh window overlaps the previous one on purpose, so most of what a
   * poll returns is already held. Re-scoring it would bill tokens for an answer
   * on disk AND mint a second, different score for one article — the
   * non-determinism #558 banned from replay.
   */
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
    // Second poll returns the corrected article.
    (
      agent as unknown as { deps: { newsClient: { fetchNews: () => Promise<unknown> } } }
    ).deps.newsClient.fetchNews = async () => [revised];
    await agent.refresh('t', 'AAPL', 'stocks');

    expect(scorer.calls).toHaveLength(2);
    expect(archive.rawRows('alpaca-news')).toHaveLength(2);
  });

  /**
   * #1106: `MiIngestAgent` scored through the shared `LlmClient`, which meters
   * into `llm_spend` but reads no cap of its own — the composition root's
   * `MiRefreshQueue` check was the only ceiling this path had, and only
   * because ingest happened to run first in one array literal. Gating here
   * too is what makes the array order stop being load-bearing.
   */
  it('refuses to score BEFORE calling the LLM when the spend cap is exhausted', async () => {
    const logger = recordingLogger();
    const { agent, scorer, store } = build([article()], 1, { spendCap: REFUSES, logger });

    await expect(agent.refresh('t', 'AAPL', 'stocks')).resolves.toBe(false);

    // No scoring call, no item — the analysts fall back to NO_DATA_MARKER, so
    // "could not afford to look" stays distinguishable from "looked and saw
    // nothing", the same guarantee `GrokAgent` gives.
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

    // `false`, not a throw: an outage degrades the desk to NO DATA, a state the
    // analysts already handle, rather than failing a tick that would otherwise
    // have traded on the technical analyst alone.
    await expect(agent.refresh('t', 'AAPL', 'stocks')).resolves.toBe(false);
    expect(store.getContext('stocks', WINDOW, 't').news).toEqual([]);
  });

  /**
   * `MarketIntelligenceStore` is in-memory, so before the archive a soak
   * restart lost every item ingested up to that point and the run silently
   * measured less than it appeared to.
   */
  it('hydrate() restores a fresh store from the archive after a restart', async () => {
    const { agent, archive } = build([article()]);
    await agent.refresh('t', 'AAPL', 'stocks');

    // A restart: brand-new store, same archive on disk.
    const restarted = new MarketIntelligenceStore(clock);
    const afterRestart = new MiIngestAgent({
      archive,
      store: restarted,
      newsClient: newsClient([]),
      // biome-ignore lint/suspicious/noExplicitAny: minimal LlmClient stand-in.
      llmClient: scoringClient().client as any,
      clock,
      assetClasses: ['stocks'],
      spendCap: ADMITS,
    });

    expect(restarted.getContext('stocks', WINDOW, 't').news).toEqual([]);
    afterRestart.hydrate();
    expect(restarted.getContext('stocks', WINDOW, 't').news).toHaveLength(1);
  });

  /**
   * #835. Polymarket archives its items so the source is replayable, and its
   * item is a trailing 24h delta — replaying it at boot would re-serve a stale
   * measurement as current, and compound the time-axis inflation
   * `polymarket-agent.ts`'s limitation 3 records. `MI_SOURCE_HYDRATION` is
   * where that is decided; this is the boot read honouring it.
   */
  it('hydrate() replays observation sources and skips archive-only ones (#835)', async () => {
    const { agent, archive } = build([article()]);
    await agent.refresh('t', 'AAPL', 'stocks');

    // Seeded directly, so the assertion cannot pass just because nothing wrote
    // a Polymarket item in the first place.
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
      // biome-ignore lint/suspicious/noExplicitAny: minimal LlmClient stand-in.
      llmClient: scoringClient().client as any,
      clock,
      assetClasses: ['stocks'],
      spendCap: ADMITS,
    }).hydrate();

    const news = restarted.getContext('stocks', WINDOW, 't').news;
    expect(news).toHaveLength(1);
    expect(news[0]?.source).toBe('benzinga');
    expect(news.some((entry) => entry.source === MI_SOURCES.polymarket)).toBe(false);
  });
});
