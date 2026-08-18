import type {
  AnthropicLlmClientConfig,
  LlmClient,
  LlmSpendSink,
  RateLimiterConfig,
} from '../../../pipeline/debate-engine/index.js';
import { AnthropicLlmClient, NousMessagesClient } from '../../../pipeline/debate-engine/index.js';
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
  DataSource,
  IndicatorSpec,
} from '../../../providers/market-data-service/index.js';
import {
  AlpacaDataSource,
  AlpacaHttpDataClient,
  AssetClassRoutingDataSource,
  recommendedWarmupFor,
  type TradingCalendar,
} from '../../../providers/market-data-service/index.js';
import type { AssetClass, TokenBucket } from '../../../shared/index.js';
import { nousCredentials } from '../../../shared/llm/index.js';
import type { Logger, UniverseInstrument } from '../types.js';
import type { ProductionConfig } from './config.js';
import { WORST_CASE_LLM_CALLS_PER_DEBATE } from './debate-adapter.js';

export const DEFAULT_TICK_INTERVAL_MS = 60_000;
/**
 * 15 minutes (#342), not the 60s this shipped with.
 *
 * The number is the **external watchdog's staleness threshold**, not a volume
 * target: the heartbeat's whole purpose is that something outside this process
 * notices its silence, so the cadence only has to be tight enough that "no beat
 * for 2 intervals" is still a timely alarm. Half an hour of undetected death on
 * an unattended paper soak (#238) is well inside a useful detection window, and
 * a tighter beat buys detection latency nobody is awake to use.
 *
 * What 60s cost, by contrast, was the alerting channel itself: ~20,000
 * heartbeats over the 14-day soak into the chat that also carries the orphaned
 * go verdict, the stuck unpriced lot and the kill-threshold breach — until the
 * operator mutes it. 15 minutes plus the separate destination
 * `TELEGRAM_HEARTBEAT_CHAT_ID` gives (alert-transport.ts) is the pair that fixes
 * that; neither alone is sufficient.
 *
 * Still a default, not a constant: `ProductionConfig.heartbeatIntervalMs`
 * overrides it, and the smoke gate (smoke-run.ts) sets its own 100ms so the
 * timer actually fires inside a one-second run.
 */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15 * 60_000;
export const DEFAULT_FILL_POLL_INTERVAL_MS = 15_000;
/**
 * GDELT publishes one GKG batch every 15 minutes, so polling faster buys
 * nothing but bandwidth — `GdeltIngestAgent`'s cursor would skip the repeat
 * anyway, having already paid for `lastupdate.txt`.
 *
 * Five minutes rather than fifteen so the poll and the publication cadence do
 * not have to stay in phase: at exactly 15 minutes a poller that drifts to just
 * before each publication lags a full batch forever. Three chances per batch
 * makes the phase irrelevant, and two of the three cost one 200-byte request.
 */
export const DEFAULT_GDELT_POLL_INTERVAL_MS = 5 * 60_000;
/**
 * How often the Polymarket poller is OFFERED a chance to run (#504).
 *
 * The cadence itself is `POLYMARKET_REFRESH_MS` (1h) and the agent's own
 * epoch-floored bucket enforces it: a poll inside a bucket already fetched
 * returns immediately, making no request at all. So this timer only decides
 * how promptly a bucket rollover is noticed. Fifteen minutes rather than a
 * matching hour for `DEFAULT_GDELT_POLL_INTERVAL_MS`'s phase argument — a
 * poller ticking at exactly the bucket width, started just after an hour
 * boundary, would lag every bucket by almost the full hour forever. The extra
 * polls are free: three of the four make no network call.
 */
export const DEFAULT_POLYMARKET_POLL_INTERVAL_MS = 15 * 60_000;
/**
 * ATR(14): the conventional realized-volatility read, and the same shape
 * `SimulatedAdapterConfig.volatility_indicator` carries for
 * `MarketState.volatility`. `'atr'` is one of the four indicators
 * `computeIndicator` dispatches on (indicators.ts) — an unrecognized name
 * would throw per instrument and leave the volatility breaker tier wired but
 * permanently reading its failure fallback, which is worse than leaving it a
 * required seam because it looks live.
 *
 * `lookback` sits on the CONVERGED warm-up (`recommendedWarmupFor` =
 * `4 x period + 1` = 57), not the `period + 1` = 15 arity floor (#757,
 * `docs/reviews/indicator-characterisation-2026-08-16.md` F1). At the floor
 * `atr`'s Wilder smoothing loop runs zero times and the value is a plain
 * mean of the 14 true ranges wearing Wilder's name — the same shape #722
 * fixed for `RSI_SPEC`. `getIndicator` builds its fetch window from this
 * field (service.ts), so this line alone is what makes the breaker's input
 * read the converged series rather than the seed.
 *
 * Measured before adopting (#757): relative shift floor-vs-converged over
 * `indicator-golden.json`'s ordinary region, median 3.0%, p90 6.9%, near-zero
 * signed bias (+0.46%) — cleared the declared gate (median <=15%, p90 <=30%).
 * `minimumBarsFor` (15) is unchanged: a cold instrument still gets a
 * (less-warm) ATR reading rather than a permanently `FAILURE_READING`
 * breaker.
 */
export const DEFAULT_VOLATILITY_INDICATOR: IndicatorSpec = {
  indicator: 'atr',
  params: { period: 14 },
  // 1h, matching every other indicator in the live path. Explicit since #315:
  // `getIndicator` used to hardcode this and now reads it from the spec.
  timeframe: '1h',
  lookback: recommendedWarmupFor({
    indicator: 'atr',
    params: { period: 14 },
    timeframe: '1h',
    lookback: 15,
  }),
};
/**
 * The Feedback Loop's cadence — "daily batch" (feedback-loop-spec.md § Cadence
 * & Scope).
 *
 * Exported since #366 so `paperStartingProfile` can express
 * `FeedbackConfig.attribution_window_ms` as a multiple of it rather than as an
 * unrelated literal. The two are coupled: a window shorter than the gap between
 * cycles drops the trades that closed in between, and nothing else in the
 * config records that relationship.
 */
export const DEFAULT_FEEDBACK_INTERVAL_MS = 24 * 60 * 60 * 1_000;

/**
 * Debate/disagreement-detection's LLM knobs (max tokens, per-attempt
 * timeout, retry budget) are not yet exposed as their own `ProductionConfig`
 * field — no ticket has asked for them to be tuned independently of these
 * defaults, which match the values `disagreement-detector.integration.test.ts`
 * already exercises against the real API. `model` is the one knob threaded
 * from the environment (#274 AC), since a stale/rotated model id is the one
 * failure mode ops needs to fix without a redeploy.
 */
/** Exported for `production.test.ts` — asserts the actual retry/timeout budget wired into the live default, not just the model threaded through the startup warn log (PR #284 review). */
export const DEFAULT_LLM_CLIENT_CONFIG: Omit<AnthropicLlmClientConfig, 'model'> = {
  max_tokens: 1024,
  timeoutMs: 30_000,
  retry: { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 2_000 },
};

/**
 * The default `LlmClient`: `NousMessagesClient` (#274, real `fetch`-based
 * `AnthropicMessagesClient`, retargeted at Nous by ADR-0009) wrapped in the
 * pre-existing `AnthropicLlmClient` (retry/timeout/error-classification/
 * prompt-safety unchanged). Key, model and base URL come from
 * `nousCredentials('debate')`, which throws — naming the variable that would
 * fix it — when the key or base URL is absent, or when the model has no rate
 * in `MODEL_RATES`. That last one is not fussiness: an unpriced call records a
 * null `cost_usd`, and the spend cap sums nulls as zero, so an unrecognised
 * model would silently remove ADR-0008's ceiling.
 *
 * `NousMessagesClient` keeps its own default `fetchWithTimeout`
 * budget rather than being handed `config.timeoutMs` here: that value already
 * governs the outer race in `AnthropicLlmClient.callWithTimeout`, which starts
 * its timer strictly before `createMessage()` is even called, so it is the
 * one that actually decides a slow call's `LlmTimeoutError`. Threading the
 * same number into the inner `fetchWithTimeout` as well would invite exactly
 * that ambiguity — two timers racing on an identical deadline — for no
 * observable benefit; the inner timeout stays a wider, independent backstop
 * so an in-flight request is not left dangling after the outer race settles.
 */
/** Exported for `production.test.ts` — lets the test assert the constructed client's actual shape (instance type, model, retry/timeout config) rather than only the startup warn log's side effect (PR #284 review). */
export function buildDefaultLlmClient(logger: Logger, spendSink?: LlmSpendSink): LlmClient {
  const { apiKey, baseUrl, model } = nousCredentials('debate');
  // Loud, not silent: omitting `ProductionConfig.llmClient` now means a real,
  // billed API call per debate round rather than a required seam
  // (kimi-3-review on #284) — this is the one signal that the live default
  // was built instead of a test/mock override. The model is in the payload
  // because it is the field that decides both the bill and the behaviour.
  logger.log({
    trace_id: 'startup',
    stage: 'orchestrator',
    level: 'warn',
    message: 'ProductionConfig.llmClient not supplied — building live NousMessagesClient default',
    payload: { model },
  });
  const config: AnthropicLlmClientConfig = {
    ...DEFAULT_LLM_CLIENT_CONFIG,
    model,
  };
  const client = new NousMessagesClient({ apiKey, baseUrl });
  // `spendSink` is only ever supplied on this default path, and deliberately
  // so: a `ProductionConfig.llmClient` override is a test double or another
  // provider, and metering one against the Nous price table would produce a
  // confidently wrong dollar figure. An overridden client
  // meters nothing, and the dashboard's spend tile reads $0 — visibly empty
  // rather than quietly fictional.
  return new AnthropicLlmClient(client, config, spendSink);
}

/**
 * The LLM budget used when `ProductionConfig.rateLimiterConfig` is omitted
 * (#388) — a backstop for a programmatic caller, NOT the soak's numbers.
 * `paperStartingProfile` supplies its own, sized against the real universe,
 * and that is what `yarn orchestrator` and `yarn smoke` run on.
 *
 * Deliberately generous rather than tight. This limiter is a CEILING that
 * catches a misconfiguration or a runaway loop, not a scheduler: a budget that
 * bites during normal operation would shed debates the operator wanted, and
 * the tick cadence is what paces ordinary spend. So the default is set well
 * above what a single-instrument process can reach in a minute (a 60s tick
 * chain cannot start more than a handful of debates per window) while still
 * being finite, which is the whole difference from today's `undefined`.
 *
 * `maxLlmCalls` is `maxDebates * WORST_CASE_LLM_CALLS_PER_DEBATE` exactly: any
 * less and the call budget, not the debate budget, becomes the binding
 * constraint, which would refuse debates while reporting the wrong reason.
 */
export const DEFAULT_LLM_RATE_LIMIT_CONFIG: RateLimiterConfig = {
  default: {
    windowMs: 60_000,
    maxDebates: 30,
    maxLlmCalls: 30 * WORST_CASE_LLM_CALLS_PER_DEBATE,
  },
};

/**
 * The default broker wire client, with the Alpaca environment DERIVED FROM
 * `mode` rather than left to `AlpacaHttpBrokerClient`'s own default (#293).
 *
 * The class defaults to paper, which is the safe direction, but a default is
 * still the wrong mechanism here: it means the single most consequential fact
 * about a running process — whether its orders spend real money — is decided
 * by a constant nobody passed rather than by the `mode` the operator
 * explicitly set. Deriving it makes `mode` the one control, and makes a
 * mismatch impossible rather than unlikely.
 *
 * `backtest` is paper too: that mode is meant to run against
 * `SimulatedBrokerAdapter`, so if it ever reaches a real client at all, the
 * harmless account is the one to reach.
 *
 * `ALPACA_BASE_URL` can still override the host, because a staging/mock
 * endpoint is a legitimate need — but naming Alpaca's live host from a
 * non-live mode throws rather than being honoured, and the reverse (a live
 * mode silently filling paper orders) is refused by the client. An override
 * that silently upgrades a paper process to real money is the exact accident
 * #293 exists to prevent.
 *
 * Host classification is `classifyAlpacaTradingHost` from the execution
 * barrel, not a local string comparison: the original `startsWith` check here
 * was case- and whitespace-sensitive, so `https://API.ALPACA.MARKETS` walked
 * straight past it. One classifier means one set of rules to be right about.
 *
 * ## Credentials follow the environment, and this function does not touch them (#511)
 *
 * Alpaca issues DIFFERENT key pairs for paper and live accounts. Until #511
 * this function selected the HOST from `mode` while the client underneath read
 * one pair from the environment, so flipping to live would have authenticated
 * against `api.alpaca.markets` with a paper key.
 *
 * The fix lives at the option site rather than here: `environment` now selects
 * the pair (`ALPACA_CREDENTIAL_ENV_VARS`, execution/adapters/alpaca-http-client.ts),
 * so this build function passes `environment` and reads no credential at all.
 * That keeps the rule in one place for every construction path — the dashboard
 * builds the same client off the same variable — and keeps composition code out
 * of `process.env` (coding-standards.md). The two properties it buys:
 *
 * - **Non-live modes never read the live pair.** The lookup is keyed by
 *   `environment`, so a garbage value in a live-only variable cannot fail a
 *   paper boot.
 * - **Live never falls back to the paper pair.** A missing live key is a
 *   refusal to construct, not a silent downgrade to credentials that would
 *   authenticate against the wrong account.
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

  // The mirror of the check above (#511). `AlpacaHttpBrokerClient`'s own
  // `resolveBaseUrl` already refuses this pairing, so the client is the
  // authority and this does not replace it — it names the ENVIRONMENT VARIABLE
  // and the mode that disagree, which the client cannot, because by then the
  // override is just a `baseUrl` argument. Both directions matter for the same
  // reason: the operator's belief about which account they are trading and the
  // account the orders land in must not be allowed to differ, and a live run
  // silently filling into a paper account is a fortnight of fake fills that
  // look real.
  if (overrideHost === 'paper' && mode === 'live') {
    throw new Error(
      `ALPACA_BASE_URL points at Alpaca's PAPER trading host ('${override}') but SAMURAI_MODE ` +
        "is 'live'. Refusing to start: a live run filling into a paper account produces " +
        'trades, fills and PnL that are not real while every log line says live. Unset ' +
        'ALPACA_BASE_URL to use the live host, or set SAMURAI_MODE=paper.',
    );
  }

  // Constructed before the log line, not after: the client re-checks the
  // environment/host agreement and can still throw, and a startup log naming a
  // host the process never reached is worse than no log at all. `environment`
  // is also what selects the credential pair (#511) — see the doc comment.
  const client = new AlpacaHttpBrokerClient(
    override === undefined ? { environment } : { environment, baseUrl: override },
  );

  logger.log({
    trace_id: 'startup',
    stage: 'orchestrator',
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
 * The default market-data wire client. No mode branch: Alpaca serves market
 * data from one host for paper and live accounts alike, so there is no
 * money-safety decision to make here — only the asset-class path root, which
 * `AlpacaDataSource` needs fixed at construction.
 */
export function buildDefaultAlpacaDataClient(
  assetClass: 'crypto' | 'stocks',
  /**
   * The account's shared outbound bucket (#391). Optional so existing callers
   * and tests keep working unpaced; the composition root always passes the
   * same instance it gave the broker adapter, because Alpaca's 200 req/min is
   * per ACCOUNT — two buckets would be two budgets against one limit.
   */
  rateLimiter?: TokenBucket,
): AlpacaMarketDataClient {
  return new AlpacaHttpDataClient({ assetClass, rateLimiter });
}

/**
 * The asset classes a universe actually spans, in a stable order.
 *
 * Derived rather than configured: `dataSourceAssetClass` used to be the
 * operator's answer to "which endpoint root?", defaulted to `'crypto'` to match
 * `SMOKE_TEST_UNIVERSE`, and had no way to say "both". Reading it off the
 * universe means the market-data wiring cannot disagree with the tick plan
 * about what is being traded — which is the disagreement #358 was.
 */
export function universeAssetClasses(universe: readonly UniverseInstrument[]): AssetClass[] {
  return (['crypto', 'stocks'] as const).filter((assetClass) =>
    universe.some((instrument) => instrument.asset_class === assetClass),
  );
}

/**
 * The market-data source for `universe`, which is one `AlpacaDataSource` per
 * asset class the universe holds — routed per instrument when it holds both
 * (#381).
 *
 * A single source cannot serve a mixed universe: `AlpacaDataSource` fixes its
 * asset class and calendar at construction, and `AlpacaHttpDataClient` fixes
 * the API path root there too (`/v2/stocks/...` vs `/v1beta3/crypto/us/...`).
 * See `AssetClassRoutingDataSource` for the full rationale and for why an
 * unroutable instrument throws instead of defaulting.
 *
 * `config.alpacaDataClient` is refused for a mixed universe rather than
 * silently applied to both halves. It is a single-asset-class wire client by
 * construction, so honouring it would mean sending four equities to whichever
 * root that one client was built with — the exact silent-404 shape this
 * function exists to prevent. A caller wanting full control over a mixed
 * universe injects `config.dataSource` instead, which is checked first and
 * never reaches here.
 */
export function buildAlpacaDataSource(
  config: Pick<ProductionConfig, 'alpacaDataClient' | 'dataSourceAssetClass'>,
  universe: readonly UniverseInstrument[],
  tradingCalendar: TradingCalendar,
  /** The account's shared outbound bucket (#391) — see `buildDefaultAlpacaDataClient`. */
  rateLimiter?: TokenBucket,
): DataSource {
  const present = universeAssetClasses(universe);
  // An empty universe has no class to derive — `'crypto'` remains the
  // historical default there rather than throwing on a degenerate-but-harmless
  // config.
  const classes: AssetClass[] =
    present.length > 0 ? present : [config.dataSourceAssetClass ?? 'crypto'];

  const sourceFor = (assetClass: AssetClass): AlpacaDataSource =>
    new AlpacaDataSource(
      config.alpacaDataClient ?? buildDefaultAlpacaDataClient(assetClass, rateLimiter),
      {
        asset_class: assetClass,
        // Authoritative for equities only: `AlpacaDataSource` substitutes
        // `AlwaysOpenCalendar` for a crypto source regardless of what is passed
        // (alpaca-source.ts), because a 24/7 venue has no session to gate on.
        calendar: tradingCalendar,
      },
    );

  const single = classes.length === 1 ? classes[0] : undefined;
  if (single !== undefined) {
    const override = config.dataSourceAssetClass;
    // A `dataSourceAssetClass` that CONTRADICTS the universe is refused, not
    // obeyed. Obeying it is the same misroute the mixed-universe branch below
    // throws on — an all-equity universe forced to `'crypto'` sends every bars
    // request to `/v1beta3/crypto/us/...` and 404s silently (#358) — and this
    // function's whole premise is that the market-data wiring cannot disagree
    // with the tick plan. The override stays useful for the case it was added
    // for: an EMPTY universe, which asserts nothing to contradict.
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
