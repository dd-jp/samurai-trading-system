import type {
  AnthropicLlmClientConfig,
  LlmClient,
  LlmSpendSink,
  RateLimiterConfig,
} from '../../../pipeline/debate-engine/index.js';
import {
  AnthropicLlmClient,
  classifyFailureCause,
  LATENCY_BUDGET_MS,
  llmCallsPerDebate,
  MAX_ROUNDS_BY_ASSET_CLASS,
  NousMessagesClient,
} from '../../../pipeline/debate-engine/index.js';
import type {
  AlpacaBrokerClient,
  AlpacaTradingEnvironment,
} from '../../../pipeline/execution/index.js';
import {
  AlpacaHttpBrokerClient,
  classifyAlpacaTradingHost,
} from '../../../pipeline/execution/index.js';
import type {
  AlpacaMarketDataClient,
  Bar,
  BarWindow,
  DataSource,
  IndicatorSpec,
  Mark,
} from '../../../providers/market-data-service/index.js';
import {
  AlpacaHttpDataClient,
  AssetClassRoutingDataSource,
  createDataSource,
  recommendedWarmupFor,
  type TradingCalendar,
} from '../../../providers/market-data-service/index.js';
import { buildRoutingMap, LSE_ETP_POOL } from '../../../providers/universe-pool/index.js';
import { type AssetClass, logCaughtFailure, type TokenBucket } from '../../../shared/index.js';
import type { LlmInFlightGate } from '../../../shared/llm/index.js';
import { nousCredentials } from '../../../shared/llm/index.js';
import type { Logger, UniverseInstrument } from '../types.js';
import type { ProductionConfig } from './config.js';
import { WORST_CASE_LLM_CALLS_PER_DEBATE } from './debate-adapter.js';

export const DEFAULT_TICK_INTERVAL_MS = 60_000;
/**
 * 15 minutes (#342), not the 60s this shipped with. This is the external
 * watchdog's staleness threshold, not a volume target — 60s cost ~20,000
 * heartbeats over a 14-day soak, into the same chat as real alerts, until muted.
 */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15 * 60_000;
export const DEFAULT_FILL_POLL_INTERVAL_MS = 15_000;
/**
 * GDELT publishes one GKG batch per 15 min; polling faster buys nothing.
 * 5 min (not 15) so poll and publish cadence don't stay in phase and drift
 * into lagging a full batch forever.
 */
export const DEFAULT_GDELT_POLL_INTERVAL_MS = 5 * 60_000;
/**
 * How often the Polymarket poller is OFFERED a chance to run (#504) — the
 * agent's own hourly epoch-floored bucket enforces the real cadence, so this
 * only bounds how promptly a bucket rollover is noticed
 */
export const DEFAULT_POLYMARKET_POLL_INTERVAL_MS = 15 * 60_000;
/**
 * ATR(14). `lookback` sits on the CONVERGED warm-up (`recommendedWarmupFor`),
 * not the `period + 1` arity floor (#757) — at the floor, ATR's Wilder
 * smoothing loop runs zero times and the value is a plain mean wearing
 * Wilder's name. Measured floor-vs-converged shift: median 3.0%, p90 6.9%
 * (#757) — cleared the declared gate.
 */
export const DEFAULT_VOLATILITY_INDICATOR: IndicatorSpec = {
  indicator: 'atr',
  params: { period: 14 },
  // 1h, matching every other indicator in the live path (#315 made this explicit
  // rather than hardcoded in getIndicator)
  timeframe: '1h',
  lookback: recommendedWarmupFor({
    indicator: 'atr',
    params: { period: 14 },
    timeframe: '1h',
    lookback: 15,
  }),
};
/**
 * The Feedback Loop's daily-batch cadence. Exported (#366) so `paperStartingProfile`
 * can express `attribution_window_ms` as a multiple of it — a shorter window
 * drops trades that closed in between.
 */
export const DEFAULT_FEEDBACK_INTERVAL_MS = 24 * 60 * 60 * 1_000;

const DEFAULT_LLM_RETRY = { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 2_000 } as const;

/**
 * The wall-clock ceiling a whole debate may occupy (#1080). `LATENCY_BUDGET_MS.stocks`,
 * not crypto — Samurai is equities-only (crypto left scope, ADR-0015). Knowingly
 * out of bounds against the crypto budget; a crypto system re-entering scope
 * inherits that as an open problem, not a constant to copy.
 */
const DEBATE_BUDGET_MS = LATENCY_BUDGET_MS.stocks;

/**
 * DERIVED from the budget above, not chosen — the invariant
 * `llmCallsPerDebate(maxRounds) * timeoutMs <= DEBATE_BUDGET_MS` is pinned by a
 * test, not by this expression. Resolves to 28,000ms, just above the measured
 * p95 of a returning debate call (#1080: 27,510ms over 113 rows).
 */
const DEFAULT_LLM_TIMEOUT_MS =
  DEBATE_BUDGET_MS / llmCallsPerDebate(MAX_ROUNDS_BY_ASSET_CLASS.stocks);

/**
 * Debate/disagreement-detection's LLM knobs aren't yet exposed on `ProductionConfig` —
 * mirrored by hand in `disagreement-detector.integration.test.ts`, so #1080 moved
 * `timeoutMs` in both places
 */
/** Exported for `production.test.ts` (PR #284 review) — asserts the actual retry/timeout budget, not just the startup warn log */
export const DEFAULT_LLM_CLIENT_CONFIG: Omit<AnthropicLlmClientConfig, 'model'> = {
  max_tokens: 1024,
  timeoutMs: DEFAULT_LLM_TIMEOUT_MS,
  retry: DEFAULT_LLM_RETRY,
};

/**
 * `NousMessagesClient` (real fetch client, retargeted at Nous by ADR-0009) wrapped
 * in `AnthropicLlmClient`. `nousCredentials('debate')` throws naming the missing
 * var if the key/URL are absent or the model is unpriced — an unpriced call would
 * silently remove ADR-0008's spend ceiling (null `cost_usd` sums as zero).
 */
/** Exported for `production.test.ts` (PR #284 review) — asserts the constructed client's actual shape, not just the startup warn log */
export function buildDefaultLlmClient(
  logger: Logger,
  gate: LlmInFlightGate,
  spendSink?: LlmSpendSink,
): LlmClient {
  const { apiKey, baseUrl, model } = nousCredentials('debate');
  // Loud, not silent: omitting `ProductionConfig.llmClient` means a real, billed
  // API call per debate round, not a mock (kimi-3-review, #284)
  logger.log({
    trace_id: 'startup',
    stage: 'orchestrator',
    event: 'llm_client_default_built',
    level: 'warn',
    message: 'ProductionConfig.llmClient not supplied — building live NousMessagesClient default',
    payload: { model },
  });
  const config: AnthropicLlmClientConfig = {
    ...DEFAULT_LLM_CLIENT_CONFIG,
    model,
    // #1080: the only line a retried attempt produces (see RetryAttemptReport)
    // logCaughtFailure, not logger.log, since a throw here runs inside the retry
    // loop's own observer guard and would otherwise be swallowed
    onRetryAttempt: (report) => {
      logCaughtFailure(
        logger,
        {
          trace_id: report.trace_id ?? 'llm',
          stage: 'debate',
          event: 'llm_attempt_retried',
          level: 'warn',
          message:
            `llm retry: ${report.model} attempt ${report.attempt} of ${report.maxAttempts} ` +
            `failed after ${Math.round(report.elapsed_ms)}ms and is being retried in ` +
            `${Math.round(report.delay_ms)}ms. THIS ATTEMPT IS NOT IN llm_spend — it never ` +
            "completed, so its tokens are missing from the spend cap's sum and its wall time " +
            'is missing from every latency figure derived from that table, while still ' +
            "counting against the caller's latency budget (#1080)",
        },
        report.error,
        {
          model: report.model,
          attempt: report.attempt,
          max_attempts: report.maxAttempts,
          elapsed_ms: Math.round(report.elapsed_ms),
          delay_ms: Math.round(report.delay_ms),
          debate_id: report.debate_id,
          llm_stage: report.stage,
          // #1394: names what was retried — a rate limit and a malformed draw
          // used to log identically
          failure_cause: classifyFailureCause(report.error),
        },
      );
    },
    // #1394: terminal per-call line after the retry budget is spent — every
    // downstream caller fails open or re-renders in its own words, so this is
    // the only session-wide failure-cause count
    onCallFailed: (report) => {
      logCaughtFailure(
        logger,
        {
          trace_id: report.trace_id ?? 'llm',
          stage: 'debate',
          event: 'llm_call_failed',
          level: 'warn',
          message:
            `llm call failed: ${report.model} gave up with cause "${report.failure_cause}". ` +
            'Group this event by payload.failure_cause for a session count of LLM failures ' +
            'by cause (#1394) — a refusal, a truncation, an unreadable answer and a dead ' +
            'socket are all reported here, and the caller below may swallow it to fail open',
        },
        report.error,
        {
          model: report.model,
          debate_id: report.debate_id,
          llm_stage: report.stage,
          failure_cause: report.failure_cause,
        },
      );
    },
  };
  // `gateBudgetMs` = `config.timeoutMs`, not NousMessagesClient's own wider
  // network backstop — the gate wait happens inside the outer race in
  // `callWithTimeout`, which is the clock a queue wait actually eats into (#1080)
  // Equal, no margin subtracted: the gate's own queue timer already fires a full
  // expected call before the budget
  const client = new NousMessagesClient({ apiKey, baseUrl, gate, gateBudgetMs: config.timeoutMs });
  // `spendSink` is only ever supplied here — an overridden client is a test
  // double/other provider, and metering it against the Nous price table would
  // show a confidently wrong dollar figure
  return new AnthropicLlmClient(client, config, spendSink);
}

/**
 * Backstop for a programmatic caller (#388) when `rateLimiterConfig` is omitted —
 * not the soak's real numbers (`paperStartingProfile` supplies its own).
 * Deliberately generous: a ceiling against misconfiguration, not a scheduler,
 * so it sits well above what one tick can reach.
 */
export const DEFAULT_LLM_RATE_LIMIT_CONFIG: RateLimiterConfig = {
  default: {
    windowMs: 60_000,
    maxDebates: 30,
    maxLlmCalls: 30 * WORST_CASE_LLM_CALLS_PER_DEBATE,
  },
};

/**
 * Default 1 (#1080) — measured 2026-09-14: p50 5,764ms uncontended vs p50
 * 18,912ms/max 25,687ms at 4 in flight, no throughput gain from a second
 * concurrent call. The queue is per ACCOUNT, not per key (a 3-key spread
 * measured equal-or-worse than one key). Ships with admission control
 * (`gateRefusedDebateResult`, debate-adapter.ts) rather than alone: a refused
 * instrument costs one `warn` line and no retry, which is deliberately cheaper
 * than a fast pass that produces zero synthesis.
 */
export const DEFAULT_MAX_IN_FLIGHT_LLM_CALLS = 1;

/**
 * Used only to estimate a queue wait in the gate's admission check, never as a
 * timeout. 13,000ms, from the SOAK itself (not the out-of-process probe's
 * uncontended 5,764ms p50, which doesn't match what the orchestrator sees) —
 * the soak's own `llm_spend` rows center on ~13s at in-flight 1 (n=4).
 * Deliberately the pessimistic end: an under-estimate burns a full 28,000ms
 * deadline for nothing.
 */
export const DEFAULT_EXPECTED_NOUS_CALL_MS = 13_000;

/**
 * Alpaca environment is DERIVED from `mode`, not left to the client's own
 * default (#293) — `mode` is the one control an operator sets, so a mismatch
 * (paper client trading live, or vice versa) becomes impossible rather than
 * unlikely. Credentials follow environment too (#511): non-live never reads
 * the live key pair, and live never falls back to paper's.
 */
export function buildDefaultAlpacaBrokerClient(
  mode: ProductionConfig['mode'],
  logger: Logger,
): AlpacaBrokerClient {
  const environment: AlpacaTradingEnvironment = mode === 'live' ? 'live' : 'paper';
  const override = process.env.ALPACA_BASE_URL;
  const overrideHost = override === undefined ? undefined : classifyAlpacaTradingHost(override);

  if (overrideHost === 'live' && mode !== 'live') {
    throw new Error(
      `ALPACA_BASE_URL points at Alpaca's LIVE trading host ('${override}') but SAMURAI_MODE ` +
        `is '${mode}'. Refusing to start: this combination spends real money from a process ` +
        'the operator asked to be non-live. Set SAMURAI_MODE=live if that is genuinely intended.',
    );
  }

  // The mirror of the check above (#511). The client's own resolveBaseUrl
  // already refuses this pairing, but by then the override is just a baseUrl
  // argument, so only this can name which env var and mode disagree
  if (overrideHost === 'paper' && mode === 'live') {
    throw new Error(
      `ALPACA_BASE_URL points at Alpaca's PAPER trading host ('${override}') but SAMURAI_MODE ` +
        "is 'live'. Refusing to start: a live run filling into a paper account produces " +
        'trades, fills and PnL that are not real while every log line says live. Unset ' +
        'ALPACA_BASE_URL to use the live host, or set SAMURAI_MODE=paper.',
    );
  }

  // Constructed before the log line: the client re-checks environment/host
  // agreement and can still throw, so a startup log naming an unreached host
  // would be worse than no log at all
  const client = new AlpacaHttpBrokerClient(
    override === undefined ? { environment } : { environment, baseUrl: override },
  );

  logger.log({
    trace_id: 'startup',
    stage: 'orchestrator',
    event: 'broker_client_built',
    level: environment === 'live' ? 'warn' : 'info',
    message:
      environment === 'live'
        ? 'building LIVE Alpaca broker client — orders will spend real money'
        : 'building paper Alpaca broker client',
    payload: { mode, environment, baseUrl: client.baseUrl },
  });

  return client;
}

/**
 * No mode branch: Alpaca serves market data from one host for paper and live
 * alike, so there's no money-safety decision here
 */
function buildDefaultAlpacaDataClient(
  assetClass: 'crypto' | 'stocks',
  /**
   * The account's shared outbound bucket (#391). Optional so existing callers/tests
   * stay unpaced; the composition root passes the same instance it gave the broker
   * adapter — Alpaca's 200 req/min is per ACCOUNT.
   */
  rateLimiter?: TokenBucket,
): AlpacaMarketDataClient {
  return new AlpacaHttpDataClient({ assetClass, rateLimiter });
}

/**
 * Derived rather than configured (#358) — `dataSourceAssetClass` used to
 * default to `'crypto'` with no way to say "both"; reading it off the universe
 * means market-data wiring can't disagree with the tick plan
 */
export function universeAssetClasses(universe: readonly UniverseInstrument[]): AssetClass[] {
  return (['crypto', 'stocks'] as const).filter((assetClass) =>
    universe.some((instrument) => instrument.asset_class === assetClass),
  );
}

/**
 * Tradeable `lse_ticker`s and the `screening_instrument`s that must never be
 * marked in their place (#734), derived from `lse-etp-pool.ts` so a new row
 * needs no second edit. "Tradeable" means ROUTABLE, not #1220's sterling-only
 * universe — do NOT narrow this to `tradeableUniverse()`.
 */
export const LSE_TICKERS: ReadonlySet<string> = new Set(buildRoutingMap().keys());
const LSE_SCREENING_INSTRUMENTS: ReadonlySet<string> = new Set(
  LSE_ETP_POOL.map((row) => row.screening_instrument),
);

/**
 * The LSE mark source (#734), only when the universe actually holds LSE ETPs —
 * refuses to boot on a mixed venue or a missing vendor client rather than let a
 * tick silently 404 or mis-price. Full rationale is carried in this function's
 * own thrown Error messages.
 */
function buildLseMarkSourceIfNeeded(
  config: Pick<ProductionConfig, 'lseMarkClient'>,
  universe: readonly UniverseInstrument[],
): DataSource | undefined {
  const lseHeld = universe.filter((instrument) => LSE_TICKERS.has(instrument.asset));
  if (lseHeld.length === 0) return undefined;

  if (lseHeld.length !== universe.length) {
    const others = universe
      .filter((instrument) => !LSE_TICKERS.has(instrument.asset))
      .map((instrument) => instrument.asset);
    throw new Error(
      `Orchestrator cannot start: the universe mixes LSE leveraged ETPs (${lseHeld
        .map((instrument) => instrument.asset)
        .join(', ')}) with instruments served by another venue (${others.join(', ')}). ` +
        'Both are asset_class "stocks", so there is no asset class to route on and every LSE ' +
        'symbol would be sent to Alpaca, which does not list it (verified: /v2/stocks/bars for ' +
        '3USL answers "invalid symbol"). Per-venue routing is #751/#826 work; until then, ' +
        'configure a single-venue universe or inject ProductionConfig.dataSource yourself.',
    );
  }

  if (config.lseMarkClient === undefined) {
    throw new Error(
      'Orchestrator cannot start: the universe holds LSE leveraged ETPs ' +
        `(${lseHeld.map((instrument) => instrument.asset).join(', ')}) but no ` +
        'ProductionConfig.lseMarkClient was supplied, so nothing can produce a mark for them. ' +
        'No source this repo integrates serves the LSE (verified 2026-08-18: Alpaca answers ' +
        '"invalid symbol", Polygon lists no XLON), and marking an LSE 3x ETP off its US ' +
        "underlying is inadmissible (#734), so there is no fallback to take — Verdict's " +
        "stale_feed gate (#641) and the Risk Manager's valuation bound (#640) would never pass " +
        'and the book could not be valued at all. Which vendor may serve this is an OPEN OWNER ' +
        'DECISION (#895): see docs/research/34-lse-mark-source-options.md, which recommends ' +
        'IBKR LSE UK Level 1 (~GBP 1/month non-professional) as the only retail-priced ' +
        "real-time LSE feed with bid/ask found. Trading 212's own API cannot supply one either, " +
        'on mechanical grounds: its published OpenAPI bundle exposes no quote endpoint at all, ' +
        'and its only price field (Position.currentPrice) exists solely for instruments already ' +
        'held and carries no observation timestamp, so no honest Mark.observed_at can be derived ' +
        'from it. Moot regardless as of 2026-08-30: #896 (closed) found Trading 212 bars ' +
        'algorithmic trading outright, so it is no longer a candidate venue at all — the live ' +
        "equity leg is a Saxo Capital Markets UK GIA (ADR-0015's 2026-08-30 amendment). This " +
        'sentence said "open and NOT settled" until #946.',
    );
  }

  return createDataSource({
    kind: 'lse',
    client: config.lseMarkClient,
    tradeable: LSE_TICKERS,
    screeningInstruments: LSE_SCREENING_INSTRUMENTS,
    // Only the HELD lines: a USD-quoted pool row nobody trades is fine; one in
    // this universe is a mark the orchestrator must produce and can't
    declaredCurrencies: new Map(
      LSE_ETP_POOL.filter((row) => lseHeld.some((held) => held.asset === row.lse_ticker)).map(
        (row) => [row.lse_ticker, row.currency],
      ),
    ),
  });
}

/**
 * One `AlpacaDataSource` per asset class held (#381), routed per instrument, or
 * the LSE mark source (#734) for the live equity leg. A single source can't
 * serve a mixed universe since `AlpacaHttpDataClient` fixes its API path root
 * at construction.
 */
export function buildAlpacaDataSource(
  config: Pick<ProductionConfig, 'alpacaDataClient' | 'dataSourceAssetClass' | 'lseMarkClient'>,
  universe: readonly UniverseInstrument[],
  tradingCalendar: TradingCalendar,
  /** The account's shared outbound bucket (#391) — see `buildDefaultAlpacaDataClient` */
  rateLimiter?: TokenBucket,
): DataSource {
  // #734, runs FIRST — an LSE ETP is asset_class 'stocks' exactly like SPY, so
  // every check below would happily hand it to Alpaca, which doesn't list it
  // (verified 2026-08-18)
  const lseSource = buildLseMarkSourceIfNeeded(config, universe);
  if (lseSource !== undefined) return lseSource;

  const present = universeAssetClasses(universe);
  // An empty universe has no class to derive — `'crypto'` remains the
  // historical default there rather than throwing on a degenerate-but-harmless
  // config
  const classes: AssetClass[] =
    present.length > 0 ? present : [config.dataSourceAssetClass ?? 'crypto'];

  const sourceFor = (assetClass: AssetClass): DataSource =>
    createDataSource({
      kind: 'alpaca',
      client: config.alpacaDataClient ?? buildDefaultAlpacaDataClient(assetClass, rateLimiter),
      asset_class: assetClass,
      // Authoritative for equities only: `AlpacaDataSource` substitutes
      // `AlwaysOpenCalendar` for a crypto source regardless of what is passed
      // (alpaca-source.ts), because a 24/7 venue has no session to gate on
      calendar: tradingCalendar,
    });

  const single = classes.length === 1 ? classes[0] : undefined;
  if (single !== undefined) {
    const override = config.dataSourceAssetClass;
    // A dataSourceAssetClass that CONTRADICTS the universe is refused, not
    // obeyed — obeying it would send every request to the wrong API root and
    // 404 silently (#358). Stays useful for an EMPTY universe, which asserts
    // nothing to contradict
    if (override !== undefined && present.length > 0 && override !== single) {
      throw new Error(
        `Orchestrator cannot start: ProductionConfig.dataSourceAssetClass is '${override}', but ` +
          `the configured universe holds only '${single}' instruments. Market-data endpoints are ` +
          'per asset class (/v2/stocks vs /v1beta3/crypto/us), so honouring the override would ' +
          'send every request to the wrong API root and 404 silently, which is issue #358. Drop ' +
          'the override — it is derived from the universe — or change the universe to match it.',
      );
    }
    return sourceFor(single);
  }

  if (config.alpacaDataClient !== undefined) {
    throw new Error(
      'Orchestrator cannot start: ProductionConfig.alpacaDataClient was supplied for a universe ' +
        'spanning both crypto and stocks. That client is built against ONE Alpaca market-data ' +
        'path root (/v2/stocks vs /v1beta3/crypto/us), so one instance cannot serve both — ' +
        'applying it to both halves would send one asset class to the wrong endpoint and 404 ' +
        'silently, which is issue #358. Inject ProductionConfig.dataSource (an ' +
        'AssetClassRoutingDataSource, or your own) to control a mixed universe, or narrow the ' +
        'universe to a single asset class.',
    );
  }

  return new AssetClassRoutingDataSource({
    sources: { crypto: sourceFor('crypto'), stocks: sourceFor('stocks') },
    assetClassOf: new Map(universe.map((i) => [i.asset, i.asset_class])),
  });
}

/**
 * Defers construction to first read (#981) — `AlpacaHttpDataClient`'s constructor
 * throws without credentials, and the LSE cutover (#751) needs no Alpaca client
 * at all for the live universe. Deferred, a missing benchmark credential surfaces
 * as one unmeasured benchmark, not a down trading loop (#636).
 */
class LazyDataSource implements DataSource {
  private delegate: DataSource | undefined;

  constructor(private readonly build: () => DataSource) {}

  private resolve(): DataSource {
    this.delegate ??= this.build();
    return this.delegate;
  }

  async fetchBars(instrument: string, window: BarWindow, asOf: Date): Promise<Bar[]> {
    return this.resolve().fetchBars(instrument, window, asOf);
  }

  async fetchMark(instrument: string, asOf: Date, mode: 'live' | 'backtest'): Promise<Mark> {
    return this.resolve().fetchMark(instrument, asOf, mode);
  }
}

/**
 * The market-data source for OUTSIDE BENCHMARKS (#981, under #636) — deliberately
 * separate from the live trading path. Takes no universe/config/calendar: the
 * moment #751 puts LSE tickers into the live universe, `buildAlpacaDataSource`
 * would route SPY through the LSE mark source, which refuses it (#734) — this
 * builder must stay provably independent of that.
 */
export function buildBenchmarkDataSource(options: {
  /** The account's shared outbound bucket (#391) — see `buildDefaultAlpacaDataClient` */
  rateLimiter?: TokenBucket;
  /** A STOCKS-rooted wire client. Omitted in production (built on first read); supplied by tests. */
  dataClient?: AlpacaMarketDataClient;
}): DataSource {
  return new LazyDataSource(() =>
    createDataSource({
      kind: 'alpaca',
      client: options.dataClient ?? buildDefaultAlpacaDataClient('stocks', options.rateLimiter),
      // NO calendar, deliberately — AlpacaDataSource then defaults to
      // UsEquityRegularHoursCalendar, the session SPY/AGG actually trade in
      // Accepting one would re-couple this to the live path's calendar
      // (LseRegularHoursCalendar in live mode) through the back door; the
      // signature has none, so the coupling can't recur structurally
      asset_class: 'stocks',
    }),
  );
}
