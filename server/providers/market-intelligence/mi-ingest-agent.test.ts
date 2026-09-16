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
/** The window `fundamental-analyst.ts` itself asks for (MI_CONTEXT_WINDOW_MS) */
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

/**
 * Builds an `LlmClient` whose `complete` answers with `buildRaw(prompt)`'s
 * text, narrowed through the caller's own `parseResponse` — the real
 * `LlmClient` contract, not a cast past it
 */
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

/** Returns a fixed score for every item, in input order */
function scoringClient(sentiment: 1 | 0 | -1 = 1, confidence = 0.8) {
  const calls: string[] = [];
  return {
    calls,
    client: stubLlmClient((prompt) => {
      calls.push(prompt);
      // Score every numbered line the prompt contains
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

/** A client whose `complete` always throws — the shape a provider outage takes */
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

  // #1392 review round 1 self-review: `articles` and `items` on the
  // `ingested scored news items` log record must stay distinct — `articles`
  // is every fetched/archived row (pre-symbol-filter, matching the old
  // `fresh.length`), `items` is only what got scored. Regressed once this
  // round when `articles` was briefly wired to `unscored.length`, which is
  // always equal to `items.length` (both are 1:1 maps of the same `pairs`),
  // collapsing the field into a duplicate
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

    /** The one MarketDataService member `fundamental-analyst.ts` reaches for */
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
    // average and produced #625's 0.5478 ceiling
    expect(after.confidence).toBeGreaterThan(0.05);
  });

  it('attributes a multi-symbol article to the instrument being refreshed', async () => {
    // Refresh is per instrument (the `MarketIntelligenceRefresh` contract), so
    // an article tagged AAPL and NVDA becomes one item for AAPL. Scoring is
    // per entity because a headline can be bullish for one ticker and bearish
    // for another — asking once per instrument is what keeps that honest
    const { agent, store } = build([article({ symbols: ['AAPL', 'NVDA'] })]);

    await agent.refresh('t', 'AAPL', 'stocks');

    expect(store.getContext('stocks', WINDOW, 't').news.map((item) => item.entity)).toEqual([
      'AAPL',
    ]);
  });

  /**
   * #1392 review round 2, finding 3: eligibility moved from `hasItem`
   * (`mi_archive_raw`, entity-agnostic) to `hasScoredItem` (`mi_items`,
   * entity in its key). Under the old `hasItem` gate, a shared article was
   * scored for whichever instrument's refresh saw it FIRST — a second
   * instrument covered by the same article never got its own entity-scoped
   * score, because the raw row already "existed" and the second refresh's
   * `newRaws` filter (which used to double as the scoring gate) skipped it.
   * `hasScoredItem` fixes that latent bug: each covering instrument now gets
   * its own scoring pass over the shared article, at the cost of one more
   * billed LLM call per additional instrument that shares an article — priced
   * in the PR body, not built out further here.
   */
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

  it('converts a dash-form crypto id to the wire symbol', async () => {
    // The repo carries crypto as `BTC-USD`; Alpaca expects `BTCUSD`. The same
    // mismatch made every crypto order reject with 'asset not found' in #585
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

    // Fetched the underlying's wire symbol, not the wrapper's
    expect(news.fetchNews).toHaveBeenCalledWith(['SPY'], expect.any(Date), expect.any(Date));
    // Filed under the resolved subject, not the traded ticker
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
    // Second poll returns the corrected article
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
    // nothing", the same guarantee `GrokAgent` gives
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
    // have traded on the technical analyst alone
    await expect(agent.refresh('t', 'AAPL', 'stocks')).resolves.toBe(false);
    expect(store.getContext('stocks', WINDOW, 't').news).toEqual([]);
  });

  /**
   * #1392: `scoreItems` used to fall back to `UNSCORED` (sentiment 0,
   * confidence 0.05 — a genuine-looking neutral read) on ANY failure, and
   * this method archived that fallback exactly like a real score. A provider
   * outage was then indistinguishable from a neutral news day, on the store
   * and on the dashboard, and it reinstated #625's conviction ceiling
   * invisibly.
   *
   * Review round 1 (F2) changed the fix's shape: the raw bytes are archived
   * regardless (the fetch succeeded — losing them would mean re-fetching
   * something already in hand, or losing it outright if the outage outlasts
   * LOOKBACK_MS), but no scored item is written, so the analysts still see
   * NO_DATA_MARKER like an outage should, not a fabricated neutral opinion.
   */
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

  /**
   * The counterpart to the archiving assertion above: no scored item was
   * written for the failed article, so `hasScoredItem` does not yet know it,
   * and the very next refresh — still inside the overlapping LOOKBACK_MS
   * window — gets to try scoring it again rather than being poisoned at
   * UNSCORED forever. A single failure (streak 1) must not trip the
   * consecutive-failure bound below.
   */
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

  /**
   * #1392 review round 1, F1: the cheap bound on a SUSTAINED outage's billed
   * calls. Two straight degraded refreshes trip it; the third skips the
   * scoring attempt entirely (no LLM call — raw bytes stay archived, from the
   * first refresh, regardless), then the fourth tries again.
   */
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

  /**
   * #1392 review round 2, finding 4: the streak skip was the only `return
   * false` in `refresh` that withheld intelligence with no log line — an
   * operator watching for `mi_ingest_scoring_degraded` would see the outage
   * start, then silence, with no record of the two further refreshes it kept
   * suppressing
   */
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

  /**
   * #1392 review round 2, finding 5: `#degradedStreak` reset only inside the
   * scoring path, so a streak left at 2 by a since-resolved outage survived a
   * refresh with nothing new to score (the `unscored.length === 0` early
   * return) and then wrongly skipped the NEXT refresh that finally had new
   * work, even though scoring itself never failed a third time
   */
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

    // A refresh with nothing new to score — the fetch returns no articles at
    // all, so `unscored.length === 0` and `refresh` returns early, well
    // before the streak-skip check. A fresh client, not a mutation of `news`
    // above — mutating the shared object's `fetchNews` would still be in
    // effect below when `news` is restored
    (agent as unknown as { deps: { newsClient: unknown } }).deps.newsClient = newsClient([]);
    await expect(agent.refresh('t', 'AAPL', 'stocks')).resolves.toBe(false);

    // New work arrives, and scoring itself has recovered. Without the reset,
    // the stale streak of 2 would skip this attempt with no LLM call
    const scorer = scoringClient();
    (agent as unknown as { deps: { newsClient: unknown; llmClient: unknown } }).deps.newsClient =
      news;
    (agent as unknown as { deps: { llmClient: unknown } }).deps.llmClient = scorer.client;

    await expect(agent.refresh('t', 'AAPL', 'stocks')).resolves.toBe(true);
    expect(scorer.calls).toHaveLength(1);
  });

  /**
   * #1421: the flat "skip 1 in 3" rule (#1392) only shaves a sustained
   * outage's scoring-attempt count by a third — ~30 refreshes/LOOKBACK_MS
   * window (2-minute paper-profile cadence, 60-minute LOOKBACK_MS) still cost
   * ~20 attempts. Exponential backoff on the same per-instrument streak
   * should push that down to a handful, spread across the window rather than
   * every third refresh.
   */
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

    // Mirrors the ticket's premise: paper-profile.ts tickIntervalMs (2 min)
    // against this file's own LOOKBACK_MS (60 min) — a sustained outage stays
    // inside the lookback window for this many refreshes
    const TICK_MS = 2 * 60_000;
    const REFRESHES_PER_LOOKBACK_WINDOW = 30;

    for (let i = 0; i < REFRESHES_PER_LOOKBACK_WINDOW; i++) {
      await agent.refresh('t', 'AAPL', 'stocks');
      now = new Date(now.getTime() + TICK_MS);
    }

    // Flat rule (#1392): ~20 of 30. Backoff: exactly 7 — attempts fall on
    // refreshes 1, 2, 4, 7, 12, 21, 30 (streak 1..6, skip widening 0, 1, 2, 4,
    // 8, 8 — the last two capped by `MAX_DEGRADED_SKIP`). An exact count, not
    // a range: dropping the `MAX_DEGRADED_SKIP` cap from `degradedSkip` would
    // still satisfy "under 10" (uncapped gives 6, since streak 6's uncapped
    // gap of 16 refreshes doesn't fit before the window ends) — only a pinned
    // count catches that the cap itself is exercised and load-bearing
    expect(attempts).toBe(7);
  });

  /**
   * #1421: a refresh with nothing new to score (`unscored.length === 0`)
   * must clear a pending skip cooldown — #1392 review round 2, finding 5,
   * still applies — but must NOT reset `streak`. A sustained outage can have
   * a quiet tick with no matching articles in the middle of it; resetting
   * `streak` there would restart backoff from scratch on the very next
   * failure, so a quiet-interleaved outage would cost close to the old flat
   * rule's rate again instead of continuing to escalate.
   */
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

    // Two straight failures: streak 2, one skip queued (degradedSkip(2) = 1)
    await tick();
    await tick();

    // A quiet refresh — nothing to score this cycle, not a resolved outage
    (agent as unknown as { deps: { newsClient: unknown } }).deps.newsClient = newsClient([]);
    await agent.refresh('t', 'AAPL', 'stocks');
    now = new Date(now.getTime() + TICK_MS);
    (agent as unknown as { deps: { newsClient: unknown } }).deps.newsClient = newsClient([
      article(),
    ]);

    // 8 more refreshes, still failing. If the quiet tick had reset `streak`
    // to 0, this would re-run the slow 0,0,1,2,4... climb from scratch and
    // attempt far more than twice more here; preserving `streak` keeps the
    // climb where the pre-quiet outage left it
    for (let i = 0; i < 8; i++) {
      await tick();
    }

    expect(attempts).toBe(4);
  });

  /**
   * #1421 review round 1, finding 1: `streak` had no decay — nothing but a
   * SUCCESSFUL scoring attempt reset it, and a quiet refresh (the case
   * above) only clears `skipRemaining`, by design. So a streak an outage
   * left at, say, 2 sat there indefinitely once the outage ended (no more
   * matching articles at all — the realistic "scoring recovered and life
   * moved on" case, not just one quiet tick). The FIRST unrelated failure
   * hours later then inherited that stale streak's widened skip instead of
   * being treated as the lone blip it is. Once `now - lastFailureAt` has
   * passed a full `LOOKBACK_MS`, the streak must read back as 0.
   */
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

    // Two straight failures: streak 2, one skip queued
    await agent.refresh('t', 'AAPL', 'stocks');
    advance();
    await agent.refresh('t', 'AAPL', 'stocks');
    advance();
    expect(attempts).toBe(2);

    // The outage ends for good — no more matching articles for well over a
    // full LOOKBACK_MS (30 refreshes at this 2-min cadence). Each quiet
    // refresh clears `skipRemaining` but, absent decay, `streak` would sit
    // at 2 forever
    (agent as unknown as { deps: { newsClient: unknown } }).deps.newsClient = newsClient([]);
    for (let i = 0; i < 30; i++) {
      await agent.refresh('t', 'AAPL', 'stocks');
      advance();
    }

    // A single new headline arrives, well past LOOKBACK_MS since the last
    // failure — the streak must have decayed to 0, so this is a fresh
    // streak-1 blip, not a streak-3 continuation
    (agent as unknown as { deps: { newsClient: unknown } }).deps.newsClient = newsClient([
      article(),
    ]);
    await agent.refresh('t', 'AAPL', 'stocks');
    advance();
    expect(attempts).toBe(3);

    // Streak 1 always retries on the very next refresh (degradedSkip(1) ===
    // 0). Without decay, the stale streak-2 would have carried into this
    // blip as streak 3 (skip 2), and this refresh would be skipped
    await agent.refresh('t', 'AAPL', 'stocks');
    expect(attempts).toBe(4);
  });

  /**
   * `MarketIntelligenceStore` is in-memory, so before the archive a soak
   * restart lost every item ingested up to that point and the run silently
   * measured less than it appeared to
   */
  it('hydrate() restores a fresh store from the archive after a restart', async () => {
    const { agent, archive } = build([article()]);
    await agent.refresh('t', 'AAPL', 'stocks');

    // A restart: brand-new store, same archive on disk
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
    // a Polymarket item in the first place
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

  /**
   * #1420: narrower than the batch-wide outage above — the batch answers
   * fine, but the model's response omits one item's index. Round 1 of this
   * ticket's review found that tagging the fallback `omitted: true` and
   * archiving it anyway broke `unscored`'s own contract above: `write`'s
   * `INSERT OR IGNORE` on the `mi_items` primary key means a row, once
   * written, can never later be upgraded to a real score, so a "marked"
   * item was actually WORSE than a plain neutral — permanently exempt from
   * every future scoring attempt while inside the lookback window. The fix
   * withholds the omitted item entirely: raw bytes stay archived (from the
   * unconditional `newRaws` write, above), but no `mi_items` row and no
   * live-store item, so it remains a scoring candidate for the next refresh
   * — exactly #1392's degraded-batch shape, just for one item instead of
   * the whole batch.
   */
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

  /**
   * Withholding a `mi_items` row only fixes the bug if the article is
   * actually retried, not merely never permanently marked. Mirrors the
   * #1392 batch-outage retry test above (`retries the same article on the
   * next refresh after a scoring outage, once scoring recovers`), but for
   * the narrower per-item omission path: same article, same instrument,
   * second refresh with a client that actually answers for it.
   */
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

  /**
   * #1420 review round 1, consequence 2: `hasCoverageFor` (mi-coverage.ts)
   * counts any item matching the instrument in `MarketContext.news`/`.social`
   * — it never inspects a per-item marker. Tagging-and-archiving an omitted
   * item would have made it read as "covered" while `fundamental-analyst.ts`
   * reported `NO_DATA_MARKER` for the same window, so #752's coverage alert
   * would never fire. Withholding the item (this ticket's fix) closes that
   * gap structurally: when every item in the batch is omitted, nothing is
   * archived or served this refresh, so the window is indistinguishable from
   * one where nothing was fetched at all — the exact case `hasCoverageFor`
   * and `fundamental-analyst.ts`'s existing `NO_DATA_MARKER` branch already
   * handle correctly.
   */
  it('serves nothing for a refresh where every item was omitted, leaving the window uncovered', async () => {
    const archive = new MiArchiveStore();
    const store = new MarketIntelligenceStore(clock);
    const articleA = article({ id: '1001', headline: 'Apple faces antitrust probe' });
    const articleB = article({ id: '1002', headline: 'Apple supplier disruption' });
    // A response with zero entries fails shape validation outright (`valid.length
    // === 0`) and takes #1392's WHOLE-BATCH degraded path instead — a different
    // failure this ticket does not touch. To stay on the PER-ITEM path
    // (`degraded: false`) while still omitting every supplied index, the model
    // must answer with at least one shape-valid entry for an index outside the
    // batch — `isScore` checks shape, not bounds — so neither index 0 nor 1
    // finds a match in `byIndex`
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
