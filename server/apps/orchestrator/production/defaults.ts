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
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15 * 60_000;
export const DEFAULT_FILL_POLL_INTERVAL_MS = 15_000;
export const DEFAULT_GDELT_POLL_INTERVAL_MS = 5 * 60_000;
export const DEFAULT_POLYMARKET_POLL_INTERVAL_MS = 15 * 60_000;
export const DEFAULT_VOLATILITY_INDICATOR: IndicatorSpec = {
  indicator: 'atr',
  params: { period: 14 },
  timeframe: '1h',
  lookback: recommendedWarmupFor({
    indicator: 'atr',
    params: { period: 14 },
    timeframe: '1h',
    lookback: 15,
  }),
};
export const DEFAULT_FEEDBACK_INTERVAL_MS = 24 * 60 * 60 * 1_000;

const DEFAULT_LLM_RETRY = { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 2_000 } as const;

const DEBATE_BUDGET_MS = LATENCY_BUDGET_MS.stocks;

const DEFAULT_LLM_TIMEOUT_MS =
  DEBATE_BUDGET_MS / llmCallsPerDebate(MAX_ROUNDS_BY_ASSET_CLASS.stocks);

export const DEFAULT_LLM_CLIENT_CONFIG: Omit<AnthropicLlmClientConfig, 'model'> = {
  max_tokens: 1024,
  timeoutMs: DEFAULT_LLM_TIMEOUT_MS,
  retry: DEFAULT_LLM_RETRY,
};

export function buildDefaultLlmClient(
  logger: Logger,
  gate: LlmInFlightGate,
  spendSink?: LlmSpendSink,
): LlmClient {
  const { apiKey, baseUrl, model } = nousCredentials('debate');
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
          failure_cause: classifyFailureCause(report.error),
        },
      );
    },
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
  const client = new NousMessagesClient({ apiKey, baseUrl, gate, gateBudgetMs: config.timeoutMs });
  return new AnthropicLlmClient(client, config, spendSink);
}

export const DEFAULT_LLM_RATE_LIMIT_CONFIG: RateLimiterConfig = {
  default: {
    windowMs: 60_000,
    maxDebates: 30,
    maxLlmCalls: 30 * WORST_CASE_LLM_CALLS_PER_DEBATE,
  },
};

export const DEFAULT_MAX_IN_FLIGHT_LLM_CALLS = 1;

export const DEFAULT_EXPECTED_NOUS_CALL_MS = 13_000;

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

  if (overrideHost === 'paper' && mode === 'live') {
    throw new Error(
      `ALPACA_BASE_URL points at Alpaca's PAPER trading host ('${override}') but SAMURAI_MODE ` +
        "is 'live'. Refusing to start: a live run filling into a paper account produces " +
        'trades, fills and PnL that are not real while every log line says live. Unset ' +
        'ALPACA_BASE_URL to use the live host, or set SAMURAI_MODE=paper.',
    );
  }

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

function buildDefaultAlpacaDataClient(
  assetClass: 'crypto' | 'stocks',
  rateLimiter?: TokenBucket,
): AlpacaMarketDataClient {
  return new AlpacaHttpDataClient({ assetClass, rateLimiter });
}

export function universeAssetClasses(universe: readonly UniverseInstrument[]): AssetClass[] {
  return (['crypto', 'stocks'] as const).filter((assetClass) =>
    universe.some((instrument) => instrument.asset_class === assetClass),
  );
}

export const LSE_TICKERS: ReadonlySet<string> = new Set(buildRoutingMap().keys());
const LSE_SCREENING_INSTRUMENTS: ReadonlySet<string> = new Set(
  LSE_ETP_POOL.map((row) => row.screening_instrument),
);

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
    declaredCurrencies: new Map(
      LSE_ETP_POOL.filter((row) => lseHeld.some((held) => held.asset === row.lse_ticker)).map(
        (row) => [row.lse_ticker, row.currency],
      ),
    ),
  });
}

export function buildAlpacaDataSource(
  config: Pick<ProductionConfig, 'alpacaDataClient' | 'dataSourceAssetClass' | 'lseMarkClient'>,
  universe: readonly UniverseInstrument[],
  tradingCalendar: TradingCalendar,
  rateLimiter?: TokenBucket,
): DataSource {
  const lseSource = buildLseMarkSourceIfNeeded(config, universe);
  if (lseSource !== undefined) return lseSource;

  const present = universeAssetClasses(universe);
  const classes: AssetClass[] =
    present.length > 0 ? present : [config.dataSourceAssetClass ?? 'crypto'];

  const sourceFor = (assetClass: AssetClass): DataSource =>
    createDataSource({
      kind: 'alpaca',
      client: config.alpacaDataClient ?? buildDefaultAlpacaDataClient(assetClass, rateLimiter),
      asset_class: assetClass,
      calendar: tradingCalendar,
    });

  const single = classes.length === 1 ? classes[0] : undefined;
  if (single !== undefined) {
    const override = config.dataSourceAssetClass;
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

export function buildBenchmarkDataSource(options: {
  rateLimiter?: TokenBucket;
  dataClient?: AlpacaMarketDataClient;
}): DataSource {
  return new LazyDataSource(() =>
    createDataSource({
      kind: 'alpaca',
      client: options.dataClient ?? buildDefaultAlpacaDataClient('stocks', options.rateLimiter),
      asset_class: 'stocks',
    }),
  );
}
