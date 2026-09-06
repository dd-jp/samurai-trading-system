import type {
  AnthropicLlmClientConfig,
  LlmClient,
  LlmSpendSink,
  RateLimiterConfig,
} from '../../../pipeline/debate-engine/index.js';
import {
  AnthropicLlmClient,
  LATENCY_BUDGET_MS,
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
  AlpacaDataSource,
  AlpacaHttpDataClient,
  AssetClassRoutingDataSource,
  LseMarkDataSource,
  recommendedWarmupFor,
  type TradingCalendar,
} from '../../../providers/market-data-service/index.js';
import { buildRoutingMap, LSE_ETP_POOL } from '../../../providers/universe-pool/index.js';
import { type AssetClass, logCaughtFailure, type TokenBucket } from '../../../shared/index.js';
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

const DEFAULT_LLM_RETRY = { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 2_000 } as const;

/**
 * The wall-clock ceiling ONE LOGICAL LLM CALL may occupy: the latency budget of
 * the debate that issues it (#1080).
 *
 * `LATENCY_BUDGET_MS.stocks`, not the crypto entry, because Samurai is an
 * equities system — crypto left scope 2026-08-16 (ADR-0015's amendment) and
 * `DEFAULT_UNIVERSE` is all-stocks, so no production tick runs the crypto
 * budget. The crypto branch is not dead code (`SMOKE_TEST_UNIVERSE` is BTC/ETH
 * and `MAX_ROUNDS_BY_ASSET_CLASS.crypto` is still read), so state the gap
 * plainly: against the 30s crypto budget this timeout is KNOWINGLY out of
 * bounds, at `2 * (28,000 + 2,000)` = 200% of it, and the invariant test
 * asserts the stocks budget alone. That is not an oversight to be tightened
 * later — solving the arithmetic below for 30s admits only a 13s per-attempt
 * timeout, which is under the measured p90 of an UNCONTENDED debate call
 * (#1080: 17.0s). No retry schedule fits a 30s budget at this model's latency.
 * A crypto system re-entering scope inherits that as an open problem, not as a
 * constant to copy.
 */
const LOGICAL_LLM_CALL_BUDGET_MS = LATENCY_BUDGET_MS.stocks;

/**
 * The per-attempt timeout, DERIVED from the budget above rather than chosen.
 *
 * #1080 measured what the previous constant (30,000ms) meant in production: a
 * single logical call could consume `maxAttempts * (timeoutMs + maxDelayMs)` =
 * 2 * 32,000 = 64,000ms — MORE than the whole 60s stocks budget it runs inside,
 * and more than twice the crypto budget. That is incoherent by construction:
 * the retry loop was free to blow, on its own, the deadline it was supposed to
 * be helping the caller meet, and it did so invisibly (see
 * `AnthropicLlmClientConfig.onRetryAttempt`). Nine of the 26 timed-out debates
 * in the 2026-09-03 session contained at least one such attempt.
 *
 * The invariant is `maxAttempts * (timeoutMs + maxDelayMs) <=
 * LOGICAL_LLM_CALL_BUDGET_MS`, pinned by a test so the two cannot drift apart
 * again — a retry schedule and the budget it runs inside are one decision, the
 * same coupling `LATENCY_BUDGET_MS` and `MAX_ROUNDS_BY_ASSET_CLASS` already
 * carry for the round cap.
 *
 * What this does NOT claim: that 28,000ms makes the budget reachable. It does
 * not, and no per-attempt timeout can — #1080 measured an uncontended debate
 * call at a 7.4s median, and a three-round debate is nine sequential calls, so
 * the 60s budget is marginal at zero contention before any retry exists. That
 * is a round-cap-versus-budget question, deliberately left open on #1080 for a
 * session that can measure it. This constant only removes the case where the
 * retry alone is allowed to exceed the budget.
 *
 * What it DOES cost, stated rather than hidden: attempts between 28s and 30s
 * used to succeed and will now time out and be retried — 9 of the 61 debate
 * calls in that session (14.8%) sat in that band. The trade is still right on
 * the measurement, because every one of those 9 belonged to a debate that timed
 * out anyway: a call that has already spent 47% of a 60s budget cannot be
 * followed by the eight others a three-round debate needs. Under 30,000ms the
 * retry those calls would have earned could not have landed inside the budget
 * either — the race would have discarded it at 60s. The band is a real cost;
 * it bought nothing in the one session that has been measured.
 */
const DEFAULT_LLM_TIMEOUT_MS =
  LOGICAL_LLM_CALL_BUDGET_MS / DEFAULT_LLM_RETRY.maxAttempts - DEFAULT_LLM_RETRY.maxDelayMs;

/**
 * Debate/disagreement-detection's LLM knobs (max tokens, per-attempt
 * timeout, retry budget) are not yet exposed as their own `ProductionConfig`
 * field — no ticket has asked for them to be tuned independently of these
 * defaults, which are mirrored by `disagreement-detector.integration.test.ts`
 * so the one suite that talks to the real API exercises the shipped numbers.
 * That mirror is by hand: moving `timeoutMs` here means moving it there too
 * (#1080 moved both). `model` is the one knob threaded
 * from the environment (#274 AC), since a stale/rotated model id is the one
 * failure mode ops needs to fix without a redeploy.
 */
/** Exported for `production.test.ts` — asserts the actual retry/timeout budget wired into the live default, not just the model threaded through the startup warn log (PR #284 review). */
export const DEFAULT_LLM_CLIENT_CONFIG: Omit<AnthropicLlmClientConfig, 'model'> = {
  max_tokens: 1024,
  timeoutMs: DEFAULT_LLM_TIMEOUT_MS,
  retry: DEFAULT_LLM_RETRY,
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
    event: 'llm_client_default_built',
    level: 'warn',
    message: 'ProductionConfig.llmClient not supplied — building live NousMessagesClient default',
    payload: { model },
  });
  const config: AnthropicLlmClientConfig = {
    ...DEFAULT_LLM_CLIENT_CONFIG,
    model,
    // #1080. The only line a retried attempt produces anywhere — see
    // `RetryAttemptReport` (shared/http/retry.ts) for why the loop was
    // otherwise silent. `warn`, not `info`: a retried attempt is the system
    // paying twice and halving the budget it had left, which an operator
    // reading a soak log should see without filtering for it.
    // `logCaughtFailure`, not a bare `logger.log`: this runs inside the retry
    // loop's own observer guard, and a throw from here — a hostile
    // `toString` on the provider's rejection value, or an injected logger
    // whose sink is gone — would be swallowed there, losing the line this
    // whole mechanism exists to emit. The shared helper renders and
    // sanitizes the thrown value behind its own try/catch, so the failure
    // degrades to `[unrenderable error]` in the payload instead.
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
        },
      );
    },
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
 * The `lse_ticker` values the checked-in pool declares tradeable, and the
 * `screening_instrument` values that must never be marked in their place
 * (#734). Both derived from `lse-etp-pool.ts` rather than restated, so a row
 * added there reaches the mark path without a second edit.
 */
const LSE_TICKERS: ReadonlySet<string> = new Set(buildRoutingMap().keys());
const LSE_SCREENING_INSTRUMENTS: ReadonlySet<string> = new Set(
  LSE_ETP_POOL.map((row) => row.screening_instrument),
);

/**
 * The LSE mark source (#734), when — and only when — the configured universe
 * actually holds LSE ETPs.
 *
 * ## Why this is a boot-time decision
 *
 * Until #734 there was NO producer writing a `latest_mark` row keyed by
 * `lse_ticker`, so Verdict's `stale_feed` no-go (#641) and the Risk Manager's
 * valuation bound (#640) could never pass on the live equity leg. The fix has
 * two halves and only one of them is decidable in code: the source (this) and
 * the vendor (`ProductionConfig.lseMarkClient`, an open owner decision — see
 * `docs/research/34-lse-mark-source-options.md`).
 *
 * So an LSE universe with no vendor client REFUSES TO BOOT. The alternative is
 * the failure this repo has already had twice (#358, and the missing-producer
 * hole #734 itself describes): every tick reaching a source that cannot serve
 * the symbol, 404-ing, and surfacing as an instrument that simply never found a
 * setup. A startup error naming the missing seam is the same posture
 * `AssetClassRoutingDataSource` takes for a missing asset class.
 *
 * ## Why a MIXED venue universe is refused rather than routed
 *
 * `AssetClassRoutingDataSource` cannot split this one: an LSE ETP and SPY are
 * both `asset_class: 'stocks'`, so there is no class to route on. A per-venue
 * router is real work with a real design question behind it (which vendor
 * fails over to which), and #751 — the ticket that actually puts LSE tickers
 * into a running universe — has not landed, so no caller needs it yet.
 * Refusing loudly is honest; silently sending `3USL` to Alpaca is not.
 *
 * Returns `undefined` when the universe holds no LSE ticker, which is every
 * shipped profile today.
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

  return new LseMarkDataSource(config.lseMarkClient, {
    tradeable: LSE_TICKERS,
    screeningInstruments: LSE_SCREENING_INSTRUMENTS,
    // Only the HELD lines, not the whole pool: a USD-quoted row nobody is
    // trading is a fact about the pool, whereas a USD-quoted row in this
    // universe is an instrument the orchestrator is about to be asked to mark
    // and cannot. The first must not block a boot; the second must.
    declaredCurrencies: new Map(
      LSE_ETP_POOL.filter((row) => lseHeld.some((held) => held.asset === row.lse_ticker)).map(
        (row) => [row.lse_ticker, row.currency],
      ),
    ),
  });
}

/**
 * The market-data source for `universe`, which is one `AlpacaDataSource` per
 * asset class the universe holds — routed per instrument when it holds both
 * (#381) — or the LSE mark source (#734) when the universe is the live equity
 * leg's LSE leveraged ETPs.
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
  config: Pick<ProductionConfig, 'alpacaDataClient' | 'dataSourceAssetClass' | 'lseMarkClient'>,
  universe: readonly UniverseInstrument[],
  tradingCalendar: TradingCalendar,
  /** The account's shared outbound bucket (#391) — see `buildDefaultAlpacaDataClient`. */
  rateLimiter?: TokenBucket,
): DataSource {
  // #734, and it runs FIRST because it is a venue question, not an asset-class
  // one. An LSE leveraged ETP is `asset_class: 'stocks'` exactly like SPY, so
  // every check below this point would happily hand it to Alpaca — which does
  // not list it. Re-probed with this project's own keys on 2026-08-18:
  // `/v2/stocks/bars?symbols=3USL` answers `{"message":"invalid symbol: 3USL"}`
  // and Polygon's exchange list contains no `XLON`. See
  // `docs/research/34-lse-mark-source-options.md`.
  const lseSource = buildLseMarkSourceIfNeeded(config, universe);
  if (lseSource !== undefined) return lseSource;

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

/**
 * Defers construction of the underlying source to the first read (#981).
 *
 * The benchmark path must not be able to fail a boot. `AlpacaHttpDataClient`'s
 * constructor throws when `ALPACA_API_KEY`/`ALPACA_API_SECRET` are absent, and
 * on the LSE cutover (#751) the live universe needs NO Alpaca client at all —
 * `buildAlpacaDataSource` returns the LSE mark source before ever building
 * one. Constructing a stocks client eagerly for a SECONDARY, read-only,
 * context-only measurement would therefore make a missing benchmark credential
 * take the whole trading loop down, which inverts #636's own ordering (an
 * outside benchmark can never raise a verdict).
 *
 * Deferred, the same absence surfaces where it belongs: as one benchmark
 * landing in `OutsideBenchmarkCycleResult.unmeasured` with the client's own
 * message, logged at `warn`, with the trading path untouched.
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
 * The market-data source for the OUTSIDE BENCHMARKS (#981, under #636) — and
 * deliberately not the one the live trading path uses.
 *
 * ## Why this exists at all
 *
 * It takes no `universe` and no `ProductionConfig`. That is the whole point,
 * and it is a correctness property rather than a style preference:
 * `buildAlpacaDataSource` is universe-derived end to end, and the moment #751
 * puts LSE tickers into the configured universe it returns `LseMarkDataSource`
 * EXCLUSIVELY. That source refuses `'SPY'` on purpose — SPY is a
 * `screening_instrument` in `lse-etp-pool.ts`, the US underlying a 3x LSE ETP
 * tracks, and marking the wrapper off the underlying is inadmissible (#734), so
 * the substitution is refused at the source rather than warned about.
 *
 * Routing the benchmarks through that same seam would therefore mean: on the
 * day the live universe becomes LSE-only, every SPY and AGG lookup throws
 * `NonTradeableInstrumentError`, `runOutsideBenchmarkCycle` catches it
 * per-benchmark, and BOTH benchmarks (60/40 has a SPY leg too) go permanently
 * `unmeasured` — with the panel reading "Absent, not zero", nothing crashing,
 * and nobody noticing. #636 requires FL to keep computing an outside benchmark
 * on its own cadence regardless of what the live universe is doing, so the
 * benchmark series needs a path that is *provably* independent of it. Hence a
 * separate builder with no universe in its signature, not a conditional branch
 * inside the universe-derived one.
 *
 * The signature takes no session calendar either, for the same reason: the live
 * one is `equityCalendarFor(config)`, which is LSE in live mode, and passing it
 * would smuggle the live configuration back in — see the call below.
 *
 * ## Why a fixed stocks root is right
 *
 * SPY and AGG are ordinary US-listed instruments on Alpaca's `/v2/stocks` root
 * (verified 2026-09-01 on the free-tier `iex` feed this repo defaults to), and
 * they are REFERENCE SERIES, never order targets — no venue restriction (ADR-0016's
 * GBP LSE ETP rule) reaches them, because nothing ever places an order against
 * a benchmark. `config.alpacaDataClient` is deliberately NOT consulted: it is a
 * single-asset-class wire client whose path root is fixed at construction, so a
 * crypto-rooted one would send SPY to `/v1beta3/crypto/us/...` and 404 silently
 * (#358). A caller who wants control injects `dataClient` here, or replaces the
 * whole port via `ProductionConfig.benchmarkSeriesSource`.
 */
export function buildBenchmarkDataSource(options: {
  /** The account's shared outbound bucket (#391) — see `buildDefaultAlpacaDataClient`. */
  rateLimiter?: TokenBucket;
  /**
   * A STOCKS-rooted wire client. Omitted in production, where the default
   * stocks client is built on first read; supplied by tests, which must not
   * need Alpaca credentials to prove the routing.
   */
  dataClient?: AlpacaMarketDataClient;
}): DataSource {
  return new LazyDataSource(
    () =>
      new AlpacaDataSource(
        options.dataClient ?? buildDefaultAlpacaDataClient('stocks', options.rateLimiter),
        // NO `calendar`, deliberately — `AlpacaDataSource` then defaults to
        // `UsEquityRegularHoursCalendar`, the session SPY and AGG actually
        // trade in. The live path's calendar is `equityCalendarFor(config)`,
        // which returns `LseRegularHoursCalendar` in live mode, so accepting
        // one would re-couple this builder to the live configuration through
        // the back door — the independence would hold for the signature only.
        // `NormalizingDataSource` resolves session boundaries and holidays
        // against whatever calendar it is handed, and `LSE_HOLIDAYS` is not the
        // US table, so US bars normalized on a London session is simply the
        // wrong normalization for these instruments — and this is not merely
        // theoretical: `LSE_HOLIDAYS` and `US_HOLIDAYS` (trading-calendar.ts)
        // disagree on several civil dates (MLK Day, Washington's Birthday,
        // Juneteenth, Independence Day, Labor Day and Thanksgiving are
        // US-only; Easter Monday, the Early May and Summer bank holidays and
        // the Boxing Day substitute are LSE-only), each one a `daily` bar
        // `isTradingDay` would keep under one calendar and drop under the
        // other. The signature simply has no `calendar` parameter
        // to pass, so this coupling cannot recur no matter which calendar the
        // live path is on — closed structurally, not by empirical agreement.
        { asset_class: 'stocks' },
      ),
  );
}
