/**
 * Offline end-to-end smoke run (ticket #350) — the pre-soak gate. See
 * [ADR-0004](../../docs/adr/0004-production-composition-root.md) §5 and
 * docs/specs/orchestrator-spec.md (story 19, "Testing Decisions" §
 * "Composition root seam").
 *
 * ## Where this sits against the spec's two done-bars
 *
 * ADR-0004 §5 and orchestrator-spec.md story 19 define two: **wiring
 * validated** (one clean automated tick end-to-end through all six stages
 * against real Alpaca paper, correctly audit-logged) and **paper trading
 * achieved** (the 14-day unattended soak, #238). The spec's Testing Decisions
 * are explicit that the first is "the manual/CI-gated E2E check, not a unit
 * test ... run once per environment, not on every commit".
 *
 * This run does **not** replace that bar and must not be read as clearing it:
 * it never touches Alpaca, so it proves nothing about credentials, venue
 * semantics or live market data. What it does is make the same six-stage
 * assertion — every stage reached, a `go` recorded, an order submitted, a fill
 * ingested — cheaply, offline, and on every commit, so the credentialed run
 * and the soak start from a process that has already been seen to transact.
 * It also satisfies the spec's determinism story ("same injected simulated
 * clock + fixed universe -> byte-identical rows across two runs") at the
 * composition-root level rather than the tick-runner level; see
 * `smoke-run.test.ts`.
 *
 * ## The exit path (#576)
 *
 * The six-stage assertion above only ever exercises ENTRY — nothing about a
 * fixed bullish fixture makes the pipeline reach an `exit` intent honestly.
 * Six merged fixes (#508/#516/#517/#525/#568/#571) live entirely in
 * `Execution`'s exit path, downstream of that intent, and this gate could
 * pass with every one of them regressed. `runExitPathScenarios` closes that
 * gap by composing `ExecutionImpl` directly (via the same production binding
 * helper the tick loop itself uses) and driving three scenarios — a full
 * exit, a partial flatten, and a two-lot flatten — against a deterministic
 * offline broker. See that function's own doc for why it does not go through
 * `startFromEnvironment`, and `evaluateSmokeGate`'s "The exit path" section
 * for what it now requires.
 *
 * ## What this is for
 *
 * Before #350 there was no way to run the pipeline **as a process** without
 * live credentials. `yarn orchestrator` needs Alpaca + Anthropic keys, spends
 * money per debate round, and depends on live market conditions to reach an
 * interesting branch — observed with dummy credentials it reaches
 * `analysts: quorum_skip` on tick 1 and goes no further, so every stage after
 * Analysts is unexercised at process level. `yarn test`'s
 * `composed tick chain (integration)` case does drive one instrument through
 * all six steps, but inside vitest with hand-built parts: it proves the stage
 * wiring, not the shipped binary's composition root, timers, shutdown path,
 * logging or store round-trip over repeated ticks.
 *
 * This module closes that gap. It starts the REAL entrypoint assembly —
 * `startFromEnvironment` -> `buildProductionOrchestrator` — over fixtures and a
 * simulated broker, runs a bounded number of ticks, reads back what the
 * pipeline actually did from the shared store, prints it, and exits non-zero
 * if the pipeline never transacted. Run it before starting the 14-day soak
 * (#238): starting that soak without ever having seen the pipeline transact
 * end to end in a real process means discovering a wiring gap on day 1, and —
 * since alerting depends on config that is easy to omit — possibly not
 * discovering it at all.
 *
 * ## No second composition root
 *
 * The one constraint that makes this evidence rather than decoration: it calls
 * `startFromEnvironment` (orchestrator/index.ts), which builds the config the
 * shipped entrypoint builds and hands it to `buildProductionOrchestrator`. A
 * smoke run that assembled its own parallel wiring would prove nothing about
 * what ships. Everything below is supplied through `ProductionConfig`'s
 * already-documented override seams (`broker`, `dataSource`, `llmClient`,
 * `accountState`, the four alert channels) — the same seams whose doc comments
 * name `SimulatedBrokerAdapter` and `FixtureDataSource` as the intended
 * bindings. Nothing here is a new branch inside the composition root.
 *
 * Two things are unavoidably constructed here rather than reached through the
 * root, both noted where they appear: a second `MarketDataServiceImpl` for the
 * simulated broker (the broker is a constructor argument to the root, so it
 * cannot be handed the root's own instance), and an `AccountStateProvider`
 * (the only in-repo implementation is Alpaca-backed).
 *
 * ## Safety posture (#293/#320/#324)
 *
 * The fake/simulated mode is explicitly named and is **not reachable by
 * omission from the real entrypoint**:
 *
 * - This is a separate module with its own entrypoint guard and its own npm
 *   script (`yarn smoke`). `orchestrator/index.ts` does not import it, and it
 *   is not on the package's export surface, so no path from
 *   `yarn orchestrator` can select fixtures or the simulated broker.
 * - `mode` is hard-coded to `'paper'`. `SAMURAI_MODE` is never read, so this
 *   process cannot be steered towards `live`.
 * - The Alpaca wire client is injected as `UnreachableAlpacaClient`, which
 *   throws on every method. There is no code path from here to a broker, a
 *   market-data feed, or an LLM provider: no `fetch` is reachable at all.
 * - Alerting is named as log-only by injecting the four log stand-ins
 *   directly, which is exactly what `SAMURAI_ALERTS=log-only` resolves to
 *   (alert-transport.ts). It is not read from the environment, so a supervised
 *   offline gate can neither page anyone nor fall back to silence by omission.
 *
 * ## Determinism
 *
 * The clock is a `SimulatedClock` frozen at `SMOKE_RUN_INSTANT`, and every
 * fixture bar, mark and quote is anchored to that same instant, so the run
 * reproduces byte for byte. The tick loop, fill poll, heartbeat and shutdown
 * still run on real `setTimeout`/`setInterval` wall-clock timers — those are
 * precisely the process-level behaviours this run exists to exercise; only
 * `Clock.now()` is frozen.
 *
 * Freezing it is also load-bearing, not just tidy. `SimulatedBrokerAdapter`
 * dates its modelled entry fill at the MARK's observation time
 * (`MarketState.timestamp`), while `ExecutionImpl` stamps `OpenPosition.opened_at`
 * with `clock.now()` at submit time, and `ingestFills()` only asks the venue
 * for fills at or after the earliest `opened_at`. Against a fixture whose mark
 * is a fixed instant and a running wall clock, every modelled fill would be
 * dated strictly before the lot that owns it and would be filtered out
 * forever — the run would submit orders and never ingest a fill. One frozen
 * instant for both collapses that gap to zero.
 */
import { pathToFileURL } from 'node:url';
import type { CostConfig } from '../cost-model-backtest/index.js';
import { CostModelImpl } from '../cost-model-backtest/index.js';
import type {
  AssetClass,
  LlmClient,
  LlmRequest,
  LlmResponse,
  RateLimiterSnapshot,
} from '../debate-engine/index.js';
import { MAX_ROUNDS_BY_ASSET_CLASS, RateLimiter } from '../debate-engine/index.js';
import type {
  AlpacaClient,
  AlpacaLimitOrderRequest,
  AlpacaOrder,
  AlpacaStopLimitOrderRequest,
  BrokerAck,
  BrokerAdapter,
  ExecutionConfig,
  ExecutionResult,
  FlattenReconcileAlert,
  FlattenReconcileAlertChannel,
  NativeBracketRequest,
  NormalizedFill,
  NormalizedOrder,
  ReconcileReport,
  ResidualExposureAlert,
  ResidualExposureAlertChannel,
} from '../execution/index.js';
import {
  AlpacaBrokerAdapter,
  SimulatedBrokerAdapter,
  SqliteBrokerStateStore,
  SqliteExecutionStore,
} from '../execution/index.js';
import type { Bar } from '../market-data-service/index.js';
import {
  FixtureDataSource,
  MarketDataServiceImpl,
  SqliteMarketDataStore,
} from '../market-data-service/index.js';
import type { SessionBasisByClass } from '../risk-manager/index.js';
import { delay } from '../shared/http/delay.js';
import type { OrderIntent } from '../shared/index.js';
import { SimulatedClock, TokenBucket } from '../shared/index.js';
import { openSharedStore, type SharedStore as SqliteHandle } from '../shared/store/index.js';
import type { VerdictDecision } from '../verdict/index.js';
import {
  LoggingAnalystSkipAlertChannel,
  LoggingBreachAlertChannel,
  LoggingFlattenReconcileAlertChannel,
  LoggingHeartbeatChannel,
  LoggingLoosenApprovalChannel,
  LoggingOcoDoubleFillAlertChannel,
  LoggingOrphanAlertChannel,
  LoggingResidualExposureAlertChannel,
  LoggingUnpricedFillAlertChannel,
} from './console-channels.js';
import { startFromEnvironment } from './index.js';
import { JsonLogger } from './logger.js';
import { paperStartingProfile } from './paper-profile.js';
import { worstCaseLlmCallsForAssetClass } from './production/debate-adapter.js';
import type { AccountStateProvider } from './production/direct-bind.js';
import { buildExecutionSurface } from './production/direct-bind.js';
import { SMOKE_TEST_UNIVERSE } from './production.js';
import type { Logger } from './types.js';

/**
 * The instant the whole run is frozen at — clock, bars, mark and quote alike.
 * A fixed literal rather than `new Date()` so two runs of `yarn smoke` produce
 * identical fixtures and identical decisions; nothing in the offline path
 * compares against real wall-clock time (crypto bypasses
 * `UniverseScheduler`'s calendar gate entirely, per `SMOKE_TEST_UNIVERSE`).
 */
export const SMOKE_RUN_INSTANT = new Date('2026-08-04T12:00:00.000Z');

/** The instrument the fixtures describe — `SMOKE_TEST_UNIVERSE`'s single entry. */
const SMOKE_INSTRUMENT = SMOKE_TEST_UNIVERSE[0]?.asset ?? 'BTC-USD';

/**
 * The fixture bar series, per timeframe. Each count is a floor forced by
 * something downstream, not a round number:
 *
 * - `1h` x 60 — the Trader's ATR stop (`atr_timeframe: '1h'`,
 *   `atr_lookback: 14`) and the volatility breaker's ATR(14). #319's
 *   minimum-length guard in `computeIndicator` rejects a window shorter than
 *   `period + 1`, because `atr()` spends the first bar seeding
 *   `previousClose`, so 14 periods need 15 bars. 60 clears it with room for
 *   the `lookback: 15` spec and any warm-up a future indicator wants.
 * - `1m` x 60 — the short-timeframe reads the Analysts take.
 * - `1d` x 40 — the widest daily consumers: `adv_window` (`{'1d', 20}`,
 *   `executionConfig.simulated`) and `correlationConfig` (`{'1d', 30}` with
 *   `min_bars: 20`). 30 would satisfy both; 40 leaves headroom.
 *
 * Short-changing any of these does not produce a loud failure — it produces a
 * stage that quietly degrades and a smoke run that skips instead of trading,
 * which is exactly what the gate below exists to catch. `smoke-run.test.ts`
 * pins these against the profile's own lookbacks so a profile change that
 * outgrows the fixtures fails a test rather than the gate.
 */
const SMOKE_BAR_SERIES: readonly { timeframe: string; count: number; stepMs: number }[] = [
  { timeframe: '1h', count: 60, stepMs: 60 * 60 * 1_000 },
  { timeframe: '1m', count: 60, stepMs: 60_000 },
  { timeframe: '1d', count: 40, stepMs: 24 * 60 * 60 * 1_000 },
];

/** The mark, and the last fixture close, the run trades against. */
const SMOKE_MARK_PRICE = 160;

/**
 * A monotonically rising fixture series, ending just under `SMOKE_MARK_PRICE`.
 *
 * The trend is deliberate and is what lets the run reach a `go` at all: the
 * Analysts have to agree directionally for `computeConvictionScore`'s
 * disagreement term to clear `traderConfig.conviction_floor` (0.55 via
 * `DEFAULT_TRADER_CONFIG`), and a flat or noisy series produces a split view
 * set, a sub-floor conviction and a `trader: no_trade` short-circuit. Same
 * shape as the `composed tick chain (integration)` fixtures in
 * `production.test.ts`, re-anchored to `SMOKE_RUN_INSTANT`.
 *
 * The `+/- 2` high/low band around each close gives a true range of 2 and a
 * non-degenerate ATR, so the Trader's stop distance (`atr_k * ATR`) is a real
 * number rather than a floor artefact.
 */
export function buildSmokeFixtureBars(instrument: string = SMOKE_INSTRUMENT): Bar[] {
  return SMOKE_BAR_SERIES.flatMap(({ timeframe, count, stepMs }) =>
    Array.from({ length: count }, (_, index) => {
      const close_time = new Date(SMOKE_RUN_INSTANT.getTime() - (count - index) * stepMs);
      const close = SMOKE_MARK_PRICE - count + index;
      return {
        instrument,
        timeframe,
        open_time: new Date(close_time.getTime() - stepMs),
        close_time,
        open: close,
        high: close + 2,
        low: close - 2,
        close,
        volume: 1_000,
        source: 'smoke-fixture',
      };
    }),
  );
}

/**
 * The deterministic stub LLM.
 *
 * Constant rather than queue-based, which is the whole difference from
 * `MockLlmClient` (debate-engine/llm/mock-client.ts): that one dequeues per
 * call and throws once exhausted, so it cannot back a run whose call count
 * depends on how many ticks reach Debate. This answers the same text forever.
 *
 * One payload serves bull, bear, mediator and `detectDisagreements` alike —
 * each call site brings its own `parseResponse`, and this shape satisfies all
 * of them (the same string the composed-chain integration test enqueues).
 * `converged: true` terminates the debate on round 1, which bounds the run's
 * work and keeps every tick's stage sequence identical.
 *
 * `stance: 'bullish'` is what makes a GO reachable: a bearish or neutral
 * mediator would produce a `sell`/no-trade branch and the gate could never
 * pass, which the issue calls out explicitly.
 */
export const SMOKE_LLM_RESPONSE = JSON.stringify({
  stance: 'bullish',
  rationale: 'offline smoke fixture: uptrend intact, structure supports a long entry',
  converged: true,
});

export class ConstantResponseLlmClient implements LlmClient {
  /** How many times the debate stage called out — reported so a run that never debated is legible. */
  calls = 0;

  constructor(private readonly rawText: string = SMOKE_LLM_RESPONSE) {}

  async complete<T>(request: LlmRequest<T>): Promise<LlmResponse<T>> {
    this.calls += 1;
    const parsed = request.parseResponse(this.rawText);
    if (!parsed.valid) {
      throw new Error(
        `ConstantResponseLlmClient: the fixture response does not satisfy this call site's ` +
          `parser (${parsed.reason}). The stub payload and the debate schema have drifted apart.`,
      );
    }
    return { data: parsed.data, raw_text: this.rawText, latency_ms: 0 };
  }
}

/**
 * The account scalars, fixed.
 *
 * Injected rather than composed because the only in-repo `AccountStateProvider`
 * is `AlpacaAccountStateProvider`, which reads `GET /v2/account` — a network
 * call, and therefore out of bounds here. The numbers match
 * `PAPER_ACCOUNT_EQUITY_ANCHOR`, which is what every `riskConfig` cap in the
 * paper profile is expressed as a fraction of, so the caps bind at the sizes
 * they were written for.
 *
 * All four values are the "healthy account" case on purpose: a tripped circuit
 * breaker halts entries, and a smoke run that halts is indistinguishable at a
 * glance from a run that decided not to trade. Breaker behaviour has its own
 * suite; this run is testing that the pipeline transacts.
 */
export class FixedAccountStateProvider implements AccountStateProvider {
  constructor(private readonly equity: number = 100_000) {}

  async getAccountState(): Promise<{
    cash: number;
    peak_equity: number;
    daily_basis: SessionBasisByClass;
    consecutive_losses: number;
  }> {
    // A flat session, stated as such: `open_equity` equals current equity and
    // nothing has realized, so every class's daily PnL computes to exactly 0.
    // Deliberately `known`, not unknown — an unknown figure arms
    // `daily_pnl_unknown` and would make a healthy smoke run look degraded.
    const flat = { known: true, open_equity: this.equity, realized_pnl: 0 } as const;

    return {
      cash: this.equity,
      peak_equity: this.equity,
      daily_basis: { crypto: flat, stocks: flat, portfolio: flat },
      consecutive_losses: 0,
    };
  }
}

/**
 * The Alpaca wire client, as a tripwire.
 *
 * `buildProductionComponents` resolves `config.alpacaBrokerClient ??
 * buildDefaultAlpacaBrokerClient(...)` eagerly, before it knows whether
 * `broker` and `accountState` were both overridden — and
 * `AlpacaHttpBrokerClient`'s constructor throws without `ALPACA_API_KEY`. So a
 * credential-free run must inject *something* here even though, with both of
 * those overridden, this object has no call sites at all.
 *
 * Given that, the honest object is one that throws rather than one that
 * pretends to answer: if a future change gives the composition root a reason
 * to call the wire client, this run fails loudly instead of silently
 * exercising a fabricated Alpaca. `smoke-run.test.ts` asserts it was never
 * touched.
 */
export class UnreachableAlpacaClient implements AlpacaClient {
  /** Set if anything ever reached this client — asserted against in tests. */
  reached = false;

  private refuse(method: string): never {
    this.reached = true;
    throw new Error(
      `UnreachableAlpacaClient.${method} was called during the offline smoke run. This run is ` +
        'credential-free and must make no network call; reaching the Alpaca wire client means ' +
        'the composition root now needs it for something the smoke run overrides. Fix the ' +
        'wiring or supply a real client deliberately — do not soften this into a stub.',
    );
  }

  async submitOrder(): Promise<never> {
    return this.refuse('submitOrder');
  }

  async getOrder(): Promise<never> {
    return this.refuse('getOrder');
  }

  async getOrderByClientOrderId(): Promise<never> {
    return this.refuse('getOrderByClientOrderId');
  }

  async getAccount(): Promise<never> {
    return this.refuse('getAccount');
  }

  async submitMarketOrder(): Promise<never> {
    return this.refuse('submitMarketOrder');
  }

  async submitOcoOrder(): Promise<never> {
    return this.refuse('submitOcoOrder');
  }

  async submitLimitOrder(): Promise<never> {
    return this.refuse('submitLimitOrder');
  }

  async submitStopLimitOrder(): Promise<never> {
    return this.refuse('submitStopLimitOrder');
  }

  async cancelOrder(): Promise<never> {
    return this.refuse('cancelOrder');
  }

  async getPositions(): Promise<never> {
    return this.refuse('getPositions');
  }
}

/**
 * The exit path (#576) — the pre-soak gate's other half.
 *
 * Everything above this point exercises ENTRY: the real six-stage tick loop,
 * through `startFromEnvironment`, on a fixture engineered to make Analysts
 * agree bullish. There is no equivalent way to make the same loop reach an
 * `exit` intent: the Trader only produces one when Debate resolves opposite
 * the held lot's side (`production.test.ts`'s `#568` wiring test drives this
 * by hand-feeding the Trader step a bearish `DebateResult` — nobody drives it
 * through Analysts and a real LLM, because nothing about this fixture's fixed
 * uptrend would ever make that resolution happen honestly). Six merged fixes
 * (#508/#516/#517/#525/#568/#571) live entirely downstream of that intent, in
 * `Execution`, and none of them needed Analysts, Debate, Trader, Risk or
 * Verdict to be exercised to be regressed or fixed.
 *
 * So this harness composes Execution directly, the same way the SIX-STAGE
 * run composes the whole pipeline: `buildExecutionSurface`
 * (production/direct-bind.ts) is the identical function
 * `buildProductionComponents` calls to bind the tick loop's own `execution`
 * step and the fill-sync loop's `ingestFills`/`reconcile` surfaces — reusing
 * it here is not a second composition root, it is calling the production
 * binding helper for the one layer these six fixes actually live in.
 * `VerdictDecision`s are hand-built (skipping Analysts/Debate/Trader/Risk/
 * Verdict, all already proven reachable by the entry-path run above) and fed
 * straight to `ExecutionImpl.execute()`/`.ingestFills()` against the SAME
 * `:memory:` store `readSmokeObservations` reads back.
 *
 * Three instruments, one per invariant, so no scenario's lots ever appear in
 * another's `heldLots` filter (`executeExit`, execute.ts, filters
 * `getOpenPositions()` by instrument alone) — sharing one would mean a
 * still-open residual from an earlier phase silently joining a later phase's
 * flatten:
 *
 * 1. `EXIT_PATH_INSTRUMENTS.fullExit` — open, exit, assert `closed` +
 *    `ClosedTrade`, assert cancel-before-flatten ORDERING (#508/#516/#517).
 * 2. `EXIT_PATH_INSTRUMENTS.partialFlatten` — a flatten that fills only
 *    partially, asserting the residual is re-armed, not left naked (#525).
 * 3. `EXIT_PATH_INSTRUMENTS.twoLot` — an older lot with a prior partial exit
 *    (itself produced the same way as scenario 2) plus a fresh second lot,
 *    flattened together, asserting NEITHER is left phantom-open (#571).
 * 4. `EXIT_PATH_INSTRUMENTS.crashRestart` — a flatten that acks but whose
 *    fill is not ingested before a "restart" (a second `buildExecutionSurface`
 *    over the SAME store + SAME broker, `reconcile.test.ts`'s own definition
 *    of one): asserts `reconcile()`'s flatten sweep finds the unresolved
 *    journal row, resolves it against the venue, and the lot still reaches
 *    `closed` afterward (#519, #526).
 */
const EXIT_PATH_INSTRUMENTS = {
  fullExit: 'ETH-USD',
  partialFlatten: 'SOL-USD',
  twoLot: 'AVAX-USD',
  crashRestart: 'DOGE-USD',
} as const;

/**
 * `CostModelImpl.fill()` (cost-model.ts) always returns
 * `filled_size: request.size` — there is no partial-fill modelling anywhere
 * in the real cost model or `SimulatedBrokerAdapter`, so a genuinely partial
 * flatten cannot be produced by the unmodified production adapter (verified
 * by reading cost-model.ts before building this — it is the reason this
 * harness exists rather than just calling `runSmoke` with a bigger fixture).
 * `ExitPathBrokerAdapter` below truncates a NAMED flatten's fill to this
 * fraction of what was requested, deterministically, entirely on this side
 * of the `BrokerAdapter` seam — `execution/` is untouched.
 */
const PARTIAL_FLATTEN_FRACTION = 0.4;
/** Scenario 3's setup fraction — see the class docs above for why it reuses this technique. */
const PRIOR_EXIT_FRACTION = 0.3;

/** Every entry lot this harness opens, before any exit. */
const EXIT_PATH_LOT_SIZE = 10;

/**
 * Records every alert `ingestFills()`'s `maybeRearmResidual` posts
 * (ingest-fills.ts), on any of its three paths — a failed store read, a
 * non-finite/non-positive residual, or the broker rejecting the re-arm
 * itself. All three mean the same thing from a smoke run's chair: the #525
 * re-arm did not happen, because `ResidualExposureAlert` (residual-exposure-
 * alert.ts) is explicitly documented as "the FALLBACK for when that re-arm
 * itself fails, never the primary mechanism ... a successful re-arm posts
 * nothing here". A healthy smoke run, against a deterministic offline
 * broker, should therefore produce zero of these, ever — see
 * `evaluateSmokeGate`'s check for the reasoning this feeds.
 */
export class RecordingResidualExposureAlertChannel implements ResidualExposureAlertChannel {
  readonly alerts: ResidualExposureAlert[] = [];

  constructor(private readonly inner?: ResidualExposureAlertChannel) {}

  async postResidualExposureAlert(alert: ResidualExposureAlert): Promise<void> {
    this.alerts.push(alert);
    await this.inner?.postResidualExposureAlert(alert);
  }
}

/**
 * Records every flatten-reconcile alert posted (#519) — a healthy scenario 4
 * (below) resolves cleanly against the deterministic Simulated venue, so this
 * should stay empty; `evaluateSmokeGate` asserts exactly that, the same
 * shape `RecordingResidualExposureAlertChannel` above already establishes for
 * a different escalation.
 */
export class RecordingFlattenReconcileAlertChannel implements FlattenReconcileAlertChannel {
  readonly alerts: FlattenReconcileAlert[] = [];

  async postFlattenReconcileAlert(alert: FlattenReconcileAlert): Promise<void> {
    this.alerts.push(alert);
  }
}

/**
 * Decorates a real `SimulatedBrokerAdapter` for the exit-path harness (#576).
 * Adds exactly two things neither the real adapter nor a change to
 * `execution/` (out of this ticket's scope) is needed for:
 *
 * 1. **Call-sequence recording.** `executeExit` cancels every held lot
 *    BEFORE calling `submitFlatten` (#516) — an ordering property no store
 *    row observes; `flatten_submissions` and `open_positions` both look
 *    identical whether the cancel happened first or never happened at all.
 *    `callSequence` is the only way to assert the ORDERING the ticket asks
 *    for, not merely that both calls occurred.
 * 2. **A deterministic partial flatten fill.** See `PARTIAL_FLATTEN_FRACTION`
 *    above for why the real adapter cannot produce one. `truncateFlattenFill`
 *    opts a specific flatten's `clientOrderId` into a fixed-fraction fill;
 *    `fetchNewFills` rewrites that one fill's `qty`/`fee` on the way out,
 *    leaving `broker_fill_id` untouched — `ingestFills()` dedups on that id
 *    globally (ingest-fills.ts) and `redistributeFlattenFills` derives a
 *    per-lot id FROM it, so renaming it would silently break that contract
 *    in a way that would look like a #571 regression rather than what it is.
 *
 * `getOpenPositions()` is passed straight through to the delegate and is
 * DELIBERATELY not reconciled against the truncated feed above: the
 * delegate's own netting still sees its full-size internal fill, so the two
 * disagree by construction once a truncation is in effect. Nothing in this
 * harness (or the gate) reads `getOpenPositions()` — it exists on this class
 * only because `BrokerAdapter` requires it. This is a fixed-scenario smoke
 * fixture, not a general-purpose adapter; a caller with a different need
 * must not assume this method is trustworthy here.
 */
export class ExitPathBrokerAdapter implements BrokerAdapter {
  /** Every `cancel`/`submitBracket`/`submitFlatten`/`rearmProtectiveLegs` call, in call order. */
  readonly callSequence: string[] = [];
  private readonly partialFlattenFraction = new Map<string, number>();

  /**
   * `delegate` is deliberately typed as the concrete `SimulatedBrokerAdapter`,
   * not the `BrokerAdapter` interface: `getProtectedQty` below is not part of
   * that interface, and this class's only caller (`runExitPathScenarios`)
   * needs it to read back scenario 2's residual. Widening this parameter to
   * `BrokerAdapter` would compile but break `getProtectedQty` silently at the
   * one call site that matters.
   */
  constructor(private readonly delegate: SimulatedBrokerAdapter) {}

  /** Opts `clientOrderId`'s flatten into a truncated fill — see the class docs. */
  truncateFlattenFill(clientOrderId: string, fraction: number): void {
    this.partialFlattenFraction.set(clientOrderId, fraction);
  }

  /** Appends `action:clientOrderId` to `callSequence` — the one thing every recorded call shares. */
  private record(action: string, clientOrderId: string): void {
    this.callSequence.push(`${action}:${clientOrderId}`);
  }

  async submitBracket(order: NativeBracketRequest): Promise<BrokerAck> {
    this.record('submitBracket', order.client_order_id);
    return this.delegate.submitBracket(order);
  }

  async getOrder(clientOrderId: string, instrument: string): Promise<NormalizedOrder | null> {
    return this.delegate.getOrder(clientOrderId, instrument);
  }

  /** #519/#526's reconcile-driven flatten sweep — recorded like every other call for scenario 4. */
  async resumeFlatten(clientOrderId: string, instrument: string): Promise<NormalizedOrder | null> {
    this.record('resumeFlatten', clientOrderId);
    return this.delegate.resumeFlatten(clientOrderId, instrument);
  }

  async fetchNewFills(since: Date): Promise<NormalizedFill[]> {
    const fills = await this.delegate.fetchNewFills(since);
    if (this.partialFlattenFraction.size === 0) return fills;

    return fills.map((fill) => {
      // A flatten's fill id is always `${clientOrderId}:flatten` (simulated-adapter.ts).
      const clientOrderId = fill.broker_fill_id.endsWith(':flatten')
        ? fill.broker_fill_id.slice(0, -':flatten'.length)
        : undefined;
      const fraction =
        clientOrderId === undefined ? undefined : this.partialFlattenFraction.get(clientOrderId);
      if (fraction === undefined) return fill;
      // `broker_fill_id` is left untouched — see the class docs' dedup note.
      return { ...fill, qty: fill.qty * fraction, fee: fill.fee * fraction };
    });
  }

  async resizeProtectiveLegs(clientOrderId: string, filledQty: number): Promise<void> {
    this.record('resizeProtectiveLegs', clientOrderId);
    return this.delegate.resizeProtectiveLegs(clientOrderId, filledQty);
  }

  async rearmProtectiveLegs(
    clientOrderId: string,
    instrument: string,
    side: 'buy' | 'sell',
    qty: number,
    stop: number,
    target: number,
  ): Promise<void> {
    this.record('rearmProtectiveLegs', clientOrderId);
    return this.delegate.rearmProtectiveLegs(clientOrderId, instrument, side, qty, stop, target);
  }

  async submitFlatten(
    instrument: string,
    side: 'buy' | 'sell',
    size: number,
    clientOrderId: string,
  ): Promise<BrokerAck> {
    this.record('submitFlatten', clientOrderId);
    return this.delegate.submitFlatten(instrument, side, size, clientOrderId);
  }

  async cancel(clientOrderId: string, instrument: string): Promise<void> {
    this.record('cancel', clientOrderId);
    return this.delegate.cancel(clientOrderId, instrument);
  }

  /** Passed straight through — see the class docs for why this is deliberately unreconciled. */
  async getOpenPositions(): ReturnType<BrokerAdapter['getOpenPositions']> {
    return this.delegate.getOpenPositions();
  }

  /** The quantity `rearmProtectiveLegs`/`resizeProtectiveLegs` last set for this lot. */
  getProtectedQty(clientOrderId: string): number | null {
    return this.delegate.getProtectedQty(clientOrderId);
  }
}

/**
 * A minimal, internally-consistent `OrderIntent` for the exit-path harness.
 * Every field the Trader would normally compute (sizing rationale, cosine
 * precedent, conviction) is a fixed placeholder — `execute()`'s exit branch
 * reads none of them, and the entry branch only reads `entry`/`stop`/
 * `target` to expand the bracket, so any internally-consistent numbers serve.
 */
function exitPathOrder(
  instrument: string,
  idempotencyKey: string,
  side: 'buy' | 'sell',
  intentType: 'entry' | 'exit',
  size: number,
  decisionTime: Date,
): OrderIntent {
  return {
    idempotency_key: idempotencyKey,
    instrument,
    asset_class: 'crypto',
    side,
    intent_type: intentType,
    size,
    entry: SMOKE_MARK_PRICE,
    stop: SMOKE_MARK_PRICE - 10,
    target: SMOKE_MARK_PRICE + 20,
    time_in_force: 'gtc',
    decision_timestamp: decisionTime,
    metadata: {
      debate_id: `debate-${idempotencyKey}`,
      conviction: 0.7,
      converged: true,
      sizing: {
        base_risk_fraction: 0.01,
        conviction_multiplier: 1,
        vol_floor_factor: 1,
        non_converged_haircut: 1,
        cosine_multiplier: 1,
      },
      cosine_precedent: { neighbor_count: 0, weighted_mean_r: null, no_precedent: true },
    },
  };
}

/** A `go` verdict wrapping `order` — the only status `Execution.execute()` acts on. */
function exitPathVerdict(order: OrderIntent, timestamp: Date): VerdictDecision {
  return {
    status: 'go',
    order,
    no_go_reason: null,
    approval_path: 'automated',
    would_require_approval: false,
    idempotency_key: order.idempotency_key,
    timestamp,
  };
}

/** Throws with the harness step named, rather than letting a silent no-op reach the gate. */
function assertSubmitted(result: ExecutionResult, step: string): void {
  if (result.status !== 'submitted') {
    throw new Error(
      `smoke exit-path harness: '${step}' did not submit (status=${result.status}, ` +
        `reason=${result.reason ?? 'none'}) — a scenario precondition is wrong, not the gate`,
    );
  }
}

/** What `evaluateSmokeGate` needs from the exit-path harness beyond the store. */
export interface ExitPathEvidence {
  /** `ExitPathBrokerAdapter.callSequence` — the #516 ordering evidence. */
  brokerCallSequence: readonly string[];
  /** Every residual-exposure alert posted anywhere during the run (harness + tick loop). */
  residualAlerts: readonly ResidualExposureAlert[];
  /**
   * Scenario 1's lot (#508/#517): named so the gate can check THIS lot
   * specifically reached `closed`, not merely that the aggregate
   * `closed_trades` count is nonzero. Scoped for the same reason the #571
   * check below is scoped to its own two lots — an aggregate-only check
   * would keep passing if scenario 1 alone regressed (e.g. a reintroduced
   * #517 misattribution on ETH-USD) as long as scenario 3 still closed its
   * two lots, since the aggregate count would stay nonzero either way.
   */
  fullExit: { lotKey: string };
  /** Scenario 2's residual (#525): what was expected vs. what the broker actually protected. */
  partialFlatten: {
    idempotencyKey: string;
    expectedResidual: number;
    protectedQty: number | null;
  };
  /** Scenario 3's two lots (#571): named here so the gate can check neither is phantom-open. */
  twoLotFlatten: { lotKeys: readonly string[] };
  /**
   * Scenario 4's crash-restart (#519, #526): the lot the gate checks reached
   * `closed`, the flatten's OWN idempotency key (`ReconcileDivergence`s key
   * off the flatten, never the lot — a flatten writes no `OpenPosition`), and
   * the `ReconcileReport` the RESTARTED `Execution` produced — what proves
   * `reconcile()`'s flatten sweep, not merely `ingestFills()`, is what
   * recovered it.
   */
  crashRestart: { lotKey: string; flattenKey: string; reconcileReport: ReconcileReport };
  /** Every flatten-reconcile alert posted anywhere during the run — a healthy scenario 4 posts none. */
  flattenReconcileAlerts: readonly FlattenReconcileAlert[];
}

/**
 * Drives the three scenarios documented above against `db`, using `clock`
 * (advanced deterministically between phases — see `SimulatedClock.advanceTo`)
 * and the given cost/execution config. Returns everything `evaluateSmokeGate`
 * needs that is not itself a store row.
 */
async function runExitPathScenarios(input: {
  db: SqliteHandle;
  clock: SimulatedClock;
  costConfig: CostConfig;
  executionConfig: ExecutionConfig;
  logger: Logger;
}): Promise<ExitPathEvidence> {
  const { db, clock, costConfig, executionConfig, logger } = input;

  const bars = Object.values(EXIT_PATH_INSTRUMENTS).flatMap((instrument) =>
    buildSmokeFixtureBars(instrument),
  );
  const dataSource = new FixtureDataSource(
    bars,
    { price: SMOKE_MARK_PRICE, observed_at: SMOKE_RUN_INSTANT, source: 'smoke-fixture' },
    'crypto',
    { bid: SMOKE_MARK_PRICE - 0.5, ask: SMOKE_MARK_PRICE + 0.5, observed_at: SMOKE_RUN_INSTANT },
  );
  const marketData = new MarketDataServiceImpl(
    dataSource,
    clock,
    'live',
    new SqliteMarketDataStore(db),
  );
  const costModel = new CostModelImpl(costConfig);
  const innerBroker = new SimulatedBrokerAdapter({
    clock,
    costModel,
    marketData,
    config: executionConfig.simulated,
  });
  const broker = new ExitPathBrokerAdapter(innerBroker);
  const residualAlerts = new RecordingResidualExposureAlertChannel();
  const flattenReconcileAlerts = new RecordingFlattenReconcileAlertChannel();
  const execution = buildExecutionSurface(
    {
      clock,
      broker,
      store: new SqliteExecutionStore(db),
      costModel,
      marketData,
      config: executionConfig,
      mode: 'paper',
      residualExposureAlerts: residualAlerts,
      // #527: not recorded/gated like `residualAlerts` above — no scenario
      // here is expected to over-fill a flatten, and wiring a gate check for
      // it is out of this ticket's scope (see `FlattenOverfillAlertChannel`'s
      // doc for why this channel has no phone-reaching counterpart yet
      // either).
      flattenOverfillAlerts: { postFlattenOverfillWarning: async () => {} },
      flattenReconcileAlerts,
      logger,
    },
    'smoke-exit-path',
  );

  const tick = (): Date => {
    clock.advanceTo(new Date(clock.now().getTime() + 1_000));
    return clock.now();
  };

  /** Submits `order` as a `go`, asserting it actually reached the broker. */
  const submit = async (order: OrderIntent, step: string): Promise<void> => {
    assertSubmitted(await execution.execute(exitPathVerdict(order, clock.now())), step);
  };

  // --- Scenario 1 (#508/#516/#517): open, exit in full. ------------------
  // `evaluateSmokeGate` reads the cancel-before-flatten ORDERING off
  // `broker.callSequence` and the `ClosedTrade` off `closed_trades` —
  // nothing scenario-specific has to be returned for this one.
  const lot1 = 'smoke-exit-full-lot';
  await submit(
    exitPathOrder(EXIT_PATH_INSTRUMENTS.fullExit, lot1, 'buy', 'entry', EXIT_PATH_LOT_SIZE, tick()),
    'scenario 1 entry',
  );
  await execution.ingestFills();
  await submit(
    exitPathOrder(
      EXIT_PATH_INSTRUMENTS.fullExit,
      'smoke-exit-full-exit',
      'sell',
      'exit',
      EXIT_PATH_LOT_SIZE,
      tick(),
    ),
    'scenario 1 exit',
  );
  await execution.ingestFills();

  // --- Scenario 2 (#525): a flatten that fills only partially. -----------
  const lot2 = 'smoke-exit-partial-lot';
  const lot2ExitKey = 'smoke-exit-partial-exit';
  await submit(
    exitPathOrder(
      EXIT_PATH_INSTRUMENTS.partialFlatten,
      lot2,
      'buy',
      'entry',
      EXIT_PATH_LOT_SIZE,
      tick(),
    ),
    'scenario 2 entry',
  );
  await execution.ingestFills();
  broker.truncateFlattenFill(lot2ExitKey, PARTIAL_FLATTEN_FRACTION);
  await submit(
    exitPathOrder(
      EXIT_PATH_INSTRUMENTS.partialFlatten,
      lot2ExitKey,
      'sell',
      'exit',
      EXIT_PATH_LOT_SIZE,
      tick(),
    ),
    'scenario 2 exit',
  );
  await execution.ingestFills();
  // Matches ingest-fills.ts's own `filledSize - exitQty`, not an algebraic
  // rearrangement of it — the two are not guaranteed to be the same float64
  // bit pattern (ADR-0005), only the SAME expression is.
  const scenario2ExitFillQty = EXIT_PATH_LOT_SIZE * PARTIAL_FLATTEN_FRACTION;
  const scenario2ExpectedResidual = EXIT_PATH_LOT_SIZE - scenario2ExitFillQty;

  // --- Scenario 3 (#571): an older lot with a prior partial exit, plus a --
  // fresh sibling, flattened TOGETHER. The older lot's "prior exit" is built
  // with the same partial-fill technique as scenario 2 (a full-size exit
  // that only partially fills) — that is the only way to leave it holding
  // less than its entry size, since `executeExit` refuses any exit whose
  // size does not exactly equal what is currently held (execute.ts).
  const lot3Older = 'smoke-exit-twolot-older';
  const lot3PriorExitKey = 'smoke-exit-twolot-older-prior-exit';
  await submit(
    exitPathOrder(
      EXIT_PATH_INSTRUMENTS.twoLot,
      lot3Older,
      'buy',
      'entry',
      EXIT_PATH_LOT_SIZE,
      tick(),
    ),
    'scenario 3 older-lot entry',
  );
  await execution.ingestFills();
  broker.truncateFlattenFill(lot3PriorExitKey, PRIOR_EXIT_FRACTION);
  await submit(
    exitPathOrder(
      EXIT_PATH_INSTRUMENTS.twoLot,
      lot3PriorExitKey,
      'sell',
      'exit',
      EXIT_PATH_LOT_SIZE,
      tick(),
    ),
    'scenario 3 older-lot prior exit',
  );
  await execution.ingestFills();

  const lot3Newer = 'smoke-exit-twolot-newer';
  await submit(
    exitPathOrder(
      EXIT_PATH_INSTRUMENTS.twoLot,
      lot3Newer,
      'buy',
      'entry',
      EXIT_PATH_LOT_SIZE,
      tick(),
    ),
    'scenario 3 newer-lot entry',
  );
  await execution.ingestFills();

  // Both lots' held quantity, summed: the older one already gave up
  // `PRIOR_EXIT_FRACTION` of its size (same `filledSize - exitQty` form as
  // above), the newer one is untouched.
  const olderPriorExitFillQty = EXIT_PATH_LOT_SIZE * PRIOR_EXIT_FRACTION;
  const olderHeld = EXIT_PATH_LOT_SIZE - olderPriorExitFillQty;
  const twoLotFlattenSize = olderHeld + EXIT_PATH_LOT_SIZE;
  await submit(
    exitPathOrder(
      EXIT_PATH_INSTRUMENTS.twoLot,
      'smoke-exit-twolot-flatten',
      'sell',
      'exit',
      twoLotFlattenSize,
      tick(),
    ),
    'scenario 3 two-lot flatten',
  );
  await execution.ingestFills();

  // --- Scenario 4 (#519/#526): a flatten that acks but is never swept for --
  // fills before a "restart" — reconcile()'s flatten-journal sweep, not
  // ingestFills() alone, is what recovers it.
  const lot4 = 'smoke-exit-restart-lot';
  const lot4ExitKey = 'smoke-exit-restart-exit';
  await submit(
    exitPathOrder(
      EXIT_PATH_INSTRUMENTS.crashRestart,
      lot4,
      'buy',
      'entry',
      EXIT_PATH_LOT_SIZE,
      tick(),
    ),
    'scenario 4 entry',
  );
  await execution.ingestFills();
  await submit(
    exitPathOrder(
      EXIT_PATH_INSTRUMENTS.crashRestart,
      lot4ExitKey,
      'sell',
      'exit',
      EXIT_PATH_LOT_SIZE,
      tick(),
    ),
    'scenario 4 exit',
  );
  // Deliberately NO `execution.ingestFills()` here — the flatten's journal
  // row is acked ('submitted') but its fill has not been redistributed, so
  // `fills_swept_at` is still NULL: exactly the row
  // `SharedStore.getUnresolvedFlattens()` exists to find, and exactly what a
  // restart would otherwise strand if a live adapter's process-local
  // `flattens` map (`AlpacaBrokerAdapter`) were the only record of it.

  // --- restart: a SECOND `Execution` over the SAME store + SAME broker,
  // `buildExecutionSurface` (the real composition-root binding function)
  // called again — `reconcile.test.ts`'s own definition of "a restart".
  const restarted = buildExecutionSurface(
    {
      clock,
      broker,
      store: new SqliteExecutionStore(db),
      costModel,
      marketData,
      config: executionConfig,
      mode: 'paper',
      residualExposureAlerts: residualAlerts,
      flattenOverfillAlerts: { postFlattenOverfillWarning: async () => {} },
      flattenReconcileAlerts,
      logger,
    },
    'smoke-exit-path-restart',
  );
  const restartReconcile = await restarted.reconcile();
  await restarted.ingestFills();

  return {
    brokerCallSequence: broker.callSequence,
    residualAlerts: residualAlerts.alerts,
    fullExit: { lotKey: lot1 },
    partialFlatten: {
      idempotencyKey: lot2,
      expectedResidual: scenario2ExpectedResidual,
      protectedQty: broker.getProtectedQty(lot2),
    },
    twoLotFlatten: { lotKeys: [lot3Older, lot3Newer] },
    crashRestart: { lotKey: lot4, flattenKey: lot4ExitKey, reconcileReport: restartReconcile },
    flattenReconcileAlerts: flattenReconcileAlerts.alerts,
  };
}

/**
 * The crypto-emulation scenario (#586) — the pre-soak gate's third leg,
 * beside the six-stage entry run and the exit-path harness.
 *
 * Alpaca rejects every advanced order class for crypto (verified live, #550:
 * `422` code `42210000`), so `AlpacaBrokerAdapter` emulates the protective
 * pair for crypto: plain entry, plain stop_limit/limit legs armed by the
 * fill sweep, sibling cancelled by hand, every transition journalled in
 * `broker_brackets`. None of that is reachable by the six-stage run (it
 * overrides the broker with `SimulatedBrokerAdapter`) or by the exit-path
 * harness (same), and the smoke universe is crypto — so a soak's entire
 * bracket path runs on this mechanism while nothing else in this gate can
 * see it. Wiring a new mechanism means adding its enforcement assertion
 * here (#430), so this scenario composes the REAL `AlpacaBrokerAdapter`
 * over a REAL `SqliteBrokerStateStore` on the shared `:memory:` store, with
 * only the wire client scripted — and the script mirrors the verified venue
 * posture: any advanced order class for crypto is refused, exactly as the
 * live API does, so a regression back to `order_class: 'bracket'` fails
 * this run the same way it would fail the soak.
 */
class CryptoEmulationScenarioClient implements AlpacaClient {
  private readonly orders = new Map<string, AlpacaOrder>();
  private readonly idsByClientOrderId = new Map<string, string>();
  /** Every venue order id a cancel reached — the sibling-cancel evidence. */
  readonly cancelledOrderIds: string[] = [];
  private nextId = 1;

  private accept(request: {
    symbol: string;
    side: 'buy' | 'sell';
    qty: string;
    client_order_id: string;
  }): AlpacaOrder {
    // #585/#588: the adapter boundary must have converted to slash form
    // before the wire — the live venue 422s dash form as "asset not found".
    if (!request.symbol.endsWith('/USD')) {
      throw new Error(
        `smoke crypto-emulation scenario: order for '${request.symbol}' reached the wire in ` +
          'dash form — the adapter boundary stopped converting (#585); the live venue rejects ' +
          'this with 422 "asset not found"',
      );
    }
    const order: AlpacaOrder = {
      id: `scenario-alpaca-${this.nextId++}`,
      client_order_id: request.client_order_id,
      symbol: request.symbol,
      side: request.side,
      qty: request.qty,
      order_class: '',
      status: 'accepted',
      filled_qty: '0',
      filled_avg_price: null,
      filled_at: null,
    };
    this.orders.set(order.id, order);
    this.idsByClientOrderId.set(request.client_order_id, order.id);
    return { ...order };
  }

  /** The #550-verified posture, scripted: crypto + advanced order class = 422. */
  private rejectAdvancedOrderClass(method: string): never {
    throw new Error(
      `smoke crypto-emulation scenario: ${method} sent an advanced order_class for crypto — ` +
        'the live venue rejects this with 422 {"code":42210000,"message":"crypto orders not ' +
        'allowed for advanced order_class"} (verified #550). The adapter must take the ' +
        'emulated path (#586), never this one.',
    );
  }

  async submitOrder(): Promise<never> {
    this.rejectAdvancedOrderClass('submitOrder (order_class: bracket)');
  }

  async submitOcoOrder(): Promise<never> {
    this.rejectAdvancedOrderClass('submitOcoOrder (order_class: oco)');
  }

  async submitLimitOrder(request: AlpacaLimitOrderRequest): Promise<AlpacaOrder> {
    return this.accept(request);
  }

  async submitStopLimitOrder(request: AlpacaStopLimitOrderRequest): Promise<AlpacaOrder> {
    return this.accept(request);
  }

  async submitMarketOrder(): Promise<never> {
    throw new Error('smoke crypto-emulation scenario: no flatten is scripted here');
  }

  async cancelOrder(alpacaOrderId: string): Promise<void> {
    this.cancelledOrderIds.push(alpacaOrderId);
    const order = this.orders.get(alpacaOrderId);
    if (order !== undefined && order.status !== 'filled') order.status = 'canceled';
  }

  async getOrder(alpacaOrderId: string): Promise<AlpacaOrder> {
    const order = this.orders.get(alpacaOrderId);
    if (order === undefined) {
      throw new Error(`smoke crypto-emulation scenario: unknown order id '${alpacaOrderId}'`);
    }
    return { ...order };
  }

  async getOrderByClientOrderId(clientOrderId: string): Promise<AlpacaOrder | null> {
    const id = this.idsByClientOrderId.get(clientOrderId);
    return id === undefined ? null : this.getOrder(id);
  }

  async getPositions(): Promise<never> {
    throw new Error('smoke crypto-emulation scenario: getPositions is not scripted here');
  }

  async getAccount(): Promise<never> {
    throw new Error('smoke crypto-emulation scenario: getAccount is not scripted here');
  }

  /** The scripted market: marks an order fully filled at `price`. */
  fillByClientOrderId(clientOrderId: string, price: number, filledAt: string): void {
    const id = this.idsByClientOrderId.get(clientOrderId);
    const order = id === undefined ? undefined : this.orders.get(id);
    if (order === undefined) {
      throw new Error(
        `smoke crypto-emulation scenario: cannot fill unknown client order id '${clientOrderId}'`,
      );
    }
    order.status = 'filled';
    order.filled_qty = order.qty;
    order.filled_avg_price = String(price);
    order.filled_at = filledAt;
  }

  venueOrderId(clientOrderId: string): string | undefined {
    return this.idsByClientOrderId.get(clientOrderId);
  }
}

/** What `evaluateSmokeGate` needs from the crypto-emulation scenario (#586). */
export interface CryptoEmulationEvidence {
  /** The lot's `broker_brackets` row after the full drive, or undefined if none was journalled. */
  journalRow:
    | {
        phase: string;
        asset_class: string | null;
        stop_order_id: string | null;
        target_order_id: string | null;
      }
    | undefined;
  /** The entry fill came back through the emulation's sweep. */
  entryFillSeen: boolean;
  /** The stop leg's fill came back through the sweep after it fired. */
  stopFillSeen: boolean;
  /** The surviving take-profit leg's cancel reached the venue after the stop filled. */
  siblingCancelled: boolean;
}

const CRYPTO_EMULATION_LOT_KEY = 'smoke-crypto-emulated-lot';

/**
 * Drives one emulated crypto bracket end to end against the scripted venue:
 * submit (must NOT be an advanced order class — the script 422s that), fill
 * the entry, sweep (arms the legs), fill the stop, sweep (cancels the
 * sibling), then read the journal back off the SAME db the gate reads.
 */
async function runCryptoEmulationScenario(db: SqliteHandle): Promise<CryptoEmulationEvidence> {
  const client = new CryptoEmulationScenarioClient();
  const adapter = new AlpacaBrokerAdapter({
    client,
    rateLimiter: new TokenBucket({ capacity: 1_000, refillPerSecond: 1_000 }),
    state: new SqliteBrokerStateStore(db),
    unpricedFillAlerts: {
      postUnpricedFillAlert: async () => {},
    },
    // A double fill is impossible in this script (the target is cancelled
    // before it could ever fill), so an alert here is itself a defect —
    // thrown rather than swallowed, failing the run loudly.
    ocoDoubleFillAlerts: {
      postOcoDoubleFillAlert: async (alert) => {
        throw new Error(
          `smoke crypto-emulation scenario: unexpected double-fill alert for ` +
            `'${alert.client_order_id}'`,
        );
      },
    },
  });

  const ack = await adapter.submitBracket({
    client_order_id: CRYPTO_EMULATION_LOT_KEY,
    instrument: 'BTC-USD',
    asset_class: 'crypto',
    side: 'buy',
    size: 0.5,
    entry: 60_000,
    stop: 57_000,
    target: 66_000,
    time_in_force: 'gtc',
  });
  if (ack.order_state !== 'submitted') {
    throw new Error(
      `smoke crypto-emulation scenario: entry ack was '${ack.order_state}', not 'submitted' — ` +
        'a scenario precondition is wrong, not the gate',
    );
  }

  client.fillByClientOrderId(CRYPTO_EMULATION_LOT_KEY, 60_000, '2026-01-02T00:00:00Z');
  const armSweep = await adapter.fetchNewFills(new Date(0));

  // The emulation's deterministic first-episode leg id (#586) — the stop
  // firing is the OCO edge under test.
  client.fillByClientOrderId(`${CRYPTO_EMULATION_LOT_KEY}:stop`, 57_000, '2026-01-02T00:01:00Z');
  const exitSweep = await adapter.fetchNewFills(new Date(0));

  const journalRow = db
    .prepare(
      'SELECT phase, asset_class, stop_order_id, target_order_id FROM broker_brackets ' +
        "WHERE venue = 'alpaca' AND client_order_id = ?",
    )
    .get(CRYPTO_EMULATION_LOT_KEY) as CryptoEmulationEvidence['journalRow'];

  const targetVenueId = client.venueOrderId(`${CRYPTO_EMULATION_LOT_KEY}:target`);
  return {
    journalRow,
    entryFillSeen: armSweep.some(
      (fill) => fill.leg === 'entry' && fill.client_order_id === CRYPTO_EMULATION_LOT_KEY,
    ),
    stopFillSeen: exitSweep.some(
      (fill) => fill.leg === 'stop' && fill.client_order_id === CRYPTO_EMULATION_LOT_KEY,
    ),
    siblingCancelled:
      targetVenueId !== undefined && client.cancelledOrderIds.includes(targetVenueId),
  };
}

/** One tick's audit trail: the stages it reached and what each decided. */
export interface SmokeTick {
  trace_id: string;
  stages: { stage: string; decision: string }[];
}

/**
 * What the run observably did, read back from the shared store after the loop
 * has drained.
 *
 * Read with SQL against the same handle the process wrote through, rather than
 * from log strings: the gate has to assert on effects, and a log line is a
 * description of an effect. This is a read-only observer over the production
 * schema, not a second composition root.
 */
export interface SmokeObservations {
  /** From `audit_log`, grouped by trace, ordered as the tick runner wrote them. */
  ticks: SmokeTick[];
  /**
   * From `debate_log` — the row `feedback-loop/attribution.ts` joins on to
   * credit analysts (#364). Observed here because a store with no caller is
   * invisible to every other check in this file: the tick's `audit_log` line
   * says `debate: bullish` whether or not a row was ever written.
   */
  debates: { debate_id: string; instrument: string; direction: string; rounds: number }[];
  /** From `verdict_log` — the row `OrphanVerdictScanner` reads at restart. */
  verdicts: { trace_id: string; instrument: string; status: string; no_go_reason: string | null }[];
  /** From `open_positions` — written ahead by `ExecutionImpl` before the broker call. */
  positions: {
    idempotency_key: string;
    instrument: string;
    side: string;
    requested_size: number;
    filled_size: number;
    avg_entry_price: number;
    order_state: string;
  }[];
  /** From `fills` — appended by `ingestFills()` on the fill-sync poll. */
  fills: { idempotency_key: string; leg: string; price: number; qty: number; fee: number }[];
  /**
   * From `closed_trades` — written by `ingestFills()`'s round-trip-to-flat
   * branch (#82/#83). Empty until #576's exit-path harness (`runExitPathScenarios`
   * below) started driving `intent_type: 'exit'` through `execute()`; before
   * that this table was unreachable offline, because
   * `SimulatedBrokerAdapter.submitBracket` models only the entry fill and
   * nothing ever submitted a flatten. See `evaluateSmokeGate`'s check.
   */
  closedTrades: { idempotency_key: string; realized_pnl_net: number; close_reason: string }[];
  /**
   * From `flatten_submissions` (#508/#516 review, migration 0019) — the
   * write-ahead journal `executeExit` writes BEFORE cancelling a held lot's
   * bracket and BEFORE calling `submitFlatten`. A row here is the durable
   * proof an exit reached that path at all; its `status` proves whether the
   * broker call resolved (`'submitted'`) or was refused/left ambiguous.
   */
  flattenSubmissions: { idempotency_key: string; instrument: string; status: string }[];
  /**
   * From `cosine_setups` — the row `Trader.decide` writes at decision time
   * (#432). Observed here for `debates`' reason and from the same defect: the
   * retrieval mechanism (#75) and the store (#198) both existed and `decide()`
   * called neither, so every position took a permanent 0.75x haircut and the
   * table stayed empty for the life of the process. Nothing else in this file
   * can see that — the `audit_log` line reads `trader: intent` either way.
   */
  cosineSetups: { debate_id: string; instrument: string }[];
  /**
   * From `risk_thresholds` — the dials the composition root seeds at startup
   * and `RiskManagerImpl.evaluate` reads live (#433). An empty table means
   * `autoTighten` has nothing to step from, so a kill-line breach tightens
   * nothing: the defensive response writes a row nobody reads, which is the
   * defect #433 closed.
   */
  riskThresholds: { name: string; value: number }[];
  /**
   * From `analyst_weights` — seeded at startup (#371) so the daily cycle has a
   * row to step per analyst. Zero rows is the shape that let a soak "run
   * cleanly" while attributing nothing.
   */
  analystWeights: { analyst_id: string }[];
  /**
   * From `trader_log` / `risk_log` — the decision records (#328). Empty means
   * the two stages that decide WHAT to trade and HOW BIG left nothing behind
   * but an `audit_log` digest, so a soak's surprises are unreconstructable
   * afterwards. Both write on a skip/rejection too, so a run that traded
   * nothing must still produce rows: zero is always a wiring failure, never a
   * quiet market.
   */
  traderDecisions: { trace_id: string; instrument: string; intent_type: string | null }[];
  riskDecisions: { trace_id: string; instrument: string; status: string }[];
  /**
   * From `breaker_state` — the sticky breakers' durable home (#203, review
   * 2026-08-06 B1). Two rows (one per tier) exist only if the tick path's
   * breaker evaluation persisted its state; an empty table means a tripped
   * kill switch silently re-arms on restart — the exact gap the table was
   * created to close and then sat unwritten behind for the life of the
   * project.
   */
  breakerStates: { tier: string; tripped: number }[];
}

/** Reads everything the gate and the report need, in one pass over the store. */
export function readSmokeObservations(db: SqliteHandle): SmokeObservations {
  const auditRows = db
    .prepare('SELECT trace_id, stage, decision FROM audit_log ORDER BY rowid')
    .all() as { trace_id: string; stage: string; decision: string }[];

  const byTrace = new Map<string, SmokeTick>();
  for (const row of auditRows) {
    const tick = byTrace.get(row.trace_id) ?? { trace_id: row.trace_id, stages: [] };
    tick.stages.push({ stage: row.stage, decision: row.decision });
    byTrace.set(row.trace_id, tick);
  }

  return {
    ticks: [...byTrace.values()],
    debates: db
      .prepare('SELECT debate_id, instrument, direction, rounds FROM debate_log ORDER BY rowid')
      .all() as SmokeObservations['debates'],
    verdicts: db
      .prepare('SELECT trace_id, instrument, status, no_go_reason FROM verdict_log ORDER BY rowid')
      .all() as SmokeObservations['verdicts'],
    positions: db
      .prepare(
        'SELECT idempotency_key, instrument, side, requested_size, filled_size, avg_entry_price, ' +
          'order_state FROM open_positions ORDER BY rowid',
      )
      .all() as SmokeObservations['positions'],
    fills: db
      .prepare('SELECT idempotency_key, leg, price, qty, fee FROM fills ORDER BY rowid')
      .all() as SmokeObservations['fills'],
    closedTrades: db
      .prepare('SELECT idempotency_key, realized_pnl_net, close_reason FROM closed_trades')
      .all() as SmokeObservations['closedTrades'],
    flattenSubmissions: db
      .prepare('SELECT idempotency_key, instrument, status FROM flatten_submissions ORDER BY rowid')
      .all() as SmokeObservations['flattenSubmissions'],
    // #430. Each of these is a mechanism that was, at some point, fully built,
    // fully unit-tested and called by nothing in production. The table row is
    // the only evidence that a caller exists.
    cosineSetups: db
      .prepare('SELECT debate_id, instrument FROM cosine_setups')
      .all() as SmokeObservations['cosineSetups'],
    riskThresholds: db
      .prepare('SELECT threshold_name AS name, value FROM risk_thresholds')
      .all() as SmokeObservations['riskThresholds'],
    traderDecisions: db
      .prepare('SELECT trace_id, instrument, intent_type FROM trader_log')
      .all() as SmokeObservations['traderDecisions'],
    riskDecisions: db
      .prepare('SELECT trace_id, instrument, status FROM risk_log')
      .all() as SmokeObservations['riskDecisions'],
    analystWeights: db
      .prepare('SELECT analyst_id FROM analyst_weights')
      .all() as SmokeObservations['analystWeights'],
    breakerStates: db
      .prepare('SELECT tier, tripped FROM breaker_state')
      .all() as SmokeObservations['breakerStates'],
  };
}

export interface SmokeGateResult {
  passed: boolean;
  /** One line per unmet requirement, in the order they are checked. Empty on a pass. */
  failures: string[];
}

/**
 * The gate. Pure over observations so every branch is unit-testable without
 * starting a process — a gate that passes when nothing transacted is worse
 * than no gate.
 *
 * "Transacted" is deliberately a conjunction of independently-observable
 * effects rather than one summary flag, because each is a different wiring
 * defect:
 *
 * 1. the loop ran at all (timers, scheduler, shutdown);
 * 2. some tick got past Analysts — the literal condition #350 names, and the
 *    one a credentialed run against a 401ing data feed fails;
 * 3. a resolved debate reached `debate_log` (#364 — the store was constructed
 *    and never called, so a whole paper run of converged debates left the
 *    Feedback Loop's attribution input at zero rows);
 * 4. a `go` reached `verdict_log` (Verdict's gates, the HITL path, and the row
 *    `OrphanVerdictScanner` reads at restart);
 * 5. Execution accepted the `go` and reported `submitted`;
 * 6. a lot was written ahead to `open_positions` and reached the broker;
 * 7. a fill came back through the fill-sync poll — the only thing that proves
 *    `ingestFills()` is actually scheduled and draining.
 *
 * Requirement 3 asks for at least ONE row, not one per tick: the smoke clock
 * is frozen at `SMOKE_RUN_INSTANT` and the fixture views are identical every
 * tick, so all three ticks hash to the same `debate_id` and the writer's
 * first-write-wins guard (debate-adapter.ts) correctly collapses them to one
 * row rather than duplicating that debate's analysts in attribution.
 *
 * ## The exit path (#576)
 *
 * A `ClosedTrade` IS now required — see `options.exitPath` and
 * `runExitPathScenarios`. Six merged fixes (#508/#516/#517/#525/#568/#571)
 * live entirely in `Execution`'s exit path and none of them were reachable
 * from anything above; this gate could pass with every one of them
 * regressed, which was #576's entire finding. The checks below are a
 * conjunction for the same reason requirements 1-7 above are: each names a
 * different one of the six.
 */
export function evaluateSmokeGate(
  observations: SmokeObservations,
  options: {
    minTicks: number;
    /**
     * Whether anything reached `UnreachableAlpacaClient`. Checked here rather
     * than left to the throw, because `startTickLoop` catches everything a tick
     * throws and logs it — so a run that tried to reach the network would
     * otherwise fail the gate for a downstream symptom (no verdict, no fill)
     * and never name the cause.
     */
    alpacaWireClientReached?: boolean;
    /**
     * `RateLimiter.snapshot()` after the run — how many LLM calls the process's
     * limiter actually metered (#388).
     *
     * Checked here, alongside `alpacaWireClientReached`, and for the same
     * reason: it is an effect of the run that no table records. #388 WAS a
     * fully-implemented, fully-unit-tested component with no production
     * caller, and every one of 1800+ unit tests passed throughout — the same
     * shape as #364, whose `debate_log` assertion in this gate is the only
     * check that has ever caught it. A limiter that metered nothing while
     * debates were resolving is that defect, exactly.
     *
     * **REQUIRED, unlike `alpacaWireClientReached` above.** That asymmetry is
     * the point and was found by mutation: with this optional, deleting the
     * one line in `runSmoke` that passes it left the check vacuously true —
     * `yarn smoke` exited 0 and the entire suite stayed green. A backstop that
     * can be switched off by omitting an argument is #388's own defect class
     * reproduced inside the fix for #388. Required makes forgetting it a
     * COMPILE error, the same structural argument that makes `RateLimiter` a
     * required positional on `buildDebateStep`.
     */
    llmRateLimiterSnapshot: RateLimiterSnapshot;
    /**
     * The exit-path harness's evidence (#576) — required for the same
     * "compile error, not a silent no-op" reason `llmRateLimiterSnapshot`
     * above is: `runExitPathScenarios` always runs as part of `runSmoke`, so
     * an omitted argument here would be a caller that stopped wiring it in,
     * not a run that legitimately has nothing to report.
     */
    exitPath: ExitPathEvidence;
    /**
     * The crypto-emulation scenario's evidence (#586) — required for the
     * same "compile error, not a silent no-op" reason the two above are:
     * `runCryptoEmulationScenario` always runs as part of `runSmoke`, and
     * the smoke universe is crypto, so the soak's entire bracket path runs
     * on the mechanism this gates.
     */
    cryptoEmulation: CryptoEmulationEvidence;
  },
): SmokeGateResult {
  const failures: string[] = [];
  const { ticks, debates, verdicts, positions, fills } = observations;

  if (options.alpacaWireClientReached === true) {
    failures.push(
      'the Alpaca wire client was reached during an offline run — this run is credential-free ' +
        'and must make no network call. The composition root now needs the wire client for ' +
        'something the smoke run overrides; see UnreachableAlpacaClient',
    );
  }

  if (ticks.length < options.minTicks) {
    failures.push(
      `the tick loop completed ${ticks.length} of ${options.minTicks} expected ticks — the ` +
        'loop, the scheduler or the shutdown drain did not behave over repeated ticks',
    );
  }

  const pastAnalysts = ticks.filter((tick) =>
    tick.stages.some((entry) => entry.stage !== 'analysts'),
  );
  if (pastAnalysts.length === 0) {
    failures.push(
      'no tick got past Analysts — every pass short-circuited at the quorum gate, so Debate, ' +
        'Trader, Risk, Verdict and Execution were never exercised at all (this is exactly what ' +
        'a credential-less real run does today, and the reason #350 exists)',
    );
  }

  if (debates.length === 0) {
    failures.push(
      'no row in debate_log — a tick got past Analysts but no resolved debate was persisted, so ' +
        "the Feedback Loop's weight attribution (attribution.ts joins closed_trades.debate_id " +
        'against debate_log) has no input and the debate itself is unreconstructable after the ' +
        'fact (audit_log holds digests only). This is the #364 defect exactly',
    );
  }

  // Requirement 3b (#388): the debate that produced that row went through the
  // rate limiter. Hung off `debates.length` rather than standing alone so that
  // a run which never debated fails on the check above, naming the real cause.
  if (debates.length > 0) {
    const totals = Object.values(options.llmRateLimiterSnapshot);
    const llmCallsUsed = totals.reduce((sum, entry) => sum + entry.llmCallsUsed, 0);
    const debatesUsed = totals.reduce((sum, entry) => sum + entry.debatesUsed, 0);
    if (debatesUsed === 0 || llmCallsUsed === 0) {
      failures.push(
        `debates resolved (${debates.length} row(s) in debate_log) but the LLM RateLimiter ` +
          `metered ${debatesUsed} debate(s) and ${llmCallsUsed} call(s) — so it is constructed ` +
          'beside the LLM path rather than in it. This is the #388 defect exactly: the ' +
          'component was implemented, tested and exported while nothing in production ever ' +
          'called it, and the whole unit suite passed the entire time',
      );
    }
  }

  // #581 — the per-asset-class round cap is wired through the composition
  // root. Each `debate_log` row is checked against ITS instrument's cap
  // (looked up through `SMOKE_TEST_UNIVERSE`, so widening the smoke universe
  // to stocks keeps healthy 3-round debates passing); a row above its cap
  // means `buildDebateStep` stopped threading the cap into `runDebate`.
  // Paired with a per-class call-accounting bound that is TIGHT under the
  // stub (a converged crypto debate spends exactly its worst case: 3 persona
  // calls + 1 disagreement call), so one extra LLM call per debate — an
  // unwired cap, a second disagreement pass — fails the gate rather than
  // passing unseen.
  const smokeAssetClass = new Map<string, AssetClass>(
    SMOKE_TEST_UNIVERSE.map((entry) => [entry.asset, entry.asset_class]),
  );
  const overCap = debates.filter((debate) => {
    const assetClass = smokeAssetClass.get(debate.instrument) ?? 'crypto';
    return debate.rounds > MAX_ROUNDS_BY_ASSET_CLASS[assetClass];
  });
  if (overCap.length > 0) {
    failures.push(
      `${overCap.length} debate_log row(s) ran more rounds than their asset class's cap ` +
        '(#581) — the per-asset-class round cap is no longer reaching `runDebate` from the ' +
        'composition root, so live crypto debates are back to blowing their latency budget ' +
        'on every tick',
    );
  }
  // Iterated over the closed AssetClass set rather than Object.entries, so a
  // malformed snapshot key can never produce an undefined cap (whose NaN
  // bound would compare false everywhere and silently pass the gate).
  for (const assetClass of ['crypto', 'stocks'] as const satisfies readonly AssetClass[]) {
    const entry = options.llmRateLimiterSnapshot[assetClass];
    if (entry === undefined) continue;
    const perDebateBound = worstCaseLlmCallsForAssetClass(assetClass);
    if (entry.debatesUsed > 0 && entry.llmCallsUsed > entry.debatesUsed * perDebateBound) {
      failures.push(
        `the ${assetClass} limiter metered ${entry.llmCallsUsed} LLM call(s) across ` +
          `${entry.debatesUsed} debate(s), above the per-debate worst case of ` +
          `${perDebateBound} (#581) — a debate is spending calls its reservation never ` +
          'booked, so admission control is under-reserving',
      );
    }
  }

  // #430 — one assertion per wired mechanism, aimed at ENFORCEMENT.
  //
  // The repo's dominant defect class is a complete, tested mechanism with no
  // production caller: #327, #364, #366, #371, #374, #379, #388, #432, #433 —
  // at least nine times. Each instance is individually correct code, the gap is
  // always at the composition root, and unit tests cannot see it by
  // construction. These checks are the convention that answer: WIRING A NEW
  // MECHANISM MEANS ADDING ITS ENFORCEMENT ASSERTION HERE.
  //
  // "Aimed at enforcement" is the part that matters. Each check asserts the
  // mechanism's own durable EFFECT — a row only that mechanism writes — not
  // that an object was constructed and not that a log line was emitted. A
  // check on construction passes for a component nothing calls, which is the
  // defect itself.
  if (debates.length > 0 && observations.cosineSetups.length === 0) {
    failures.push(
      'a debate resolved and reached the Trader, but no row in cosine_setups — `decide()` did ' +
        'not write the setup it embedded, so cosine retrieval has nothing to find and every ' +
        'position takes the permanent 0.75x no-precedent haircut. This is the #432 defect ' +
        'exactly: retrieval (#75) and the store (#198) both existed and `decide()` called ' +
        'neither, while the whole unit suite passed',
    );
  }

  if (observations.riskThresholds.length === 0) {
    failures.push(
      'no row in risk_thresholds — the composition root did not seed the dials, so ' +
        "`autoTighten` has no current value to step from and the Feedback Loop's defensive " +
        'response to a kill-line breach tightens nothing. This is the #433 defect: the write ' +
        'end existed and the read end did not, and nothing failed',
    );
  }

  // #328. Anchored on `debates.length > 0` for the same reason the
  // cosine_setups check is: a run where no debate resolved never reached the
  // Trader, and demanding a row then would fail for a reason that is not this
  // one. Once a debate HAS resolved, a row is unconditional — the Trader
  // writes on a skip and Risk on a rejection, so "nothing traded" is not an
  // explanation for an empty table.
  if (debates.length > 0 && observations.traderDecisions.length === 0) {
    failures.push(
      'a debate resolved and reached the Trader, but no row in trader_log — the decision ' +
        'record is not wired, so why a size came out at N (or why nothing traded at all) is ' +
        'reconstructable only from an `audit_log` digest and ephemeral stdout. Note the ' +
        'Trader writes on a SKIP too, so this cannot be explained by a quiet tick',
    );
  }

  if (observations.traderDecisions.length > 0 && observations.riskDecisions.length === 0) {
    failures.push(
      'the Trader produced an intent but no row in risk_log — Risk evaluated it and left no ' +
        'record of what portfolio state it sized against or which gate bound. A rejected ' +
        'intent never reaches Verdict, so with this unwired a rejection has no durable ' +
        'record anywhere in the system',
    );
  }

  if (observations.analystWeights.length === 0) {
    failures.push(
      'no row in analyst_weights — the startup seeder did not run, so `runDailyCycle` skips ' +
        'every analyst it cannot find a row for and the loop attributes nothing while reporting ' +
        'a clean run. This is the #371 defect',
    );
  }

  const breakerTiers = new Set(observations.breakerStates.map((row) => row.tier));
  if (!breakerTiers.has('portfolio_drawdown') || !breakerTiers.has('kill_switch')) {
    failures.push(
      'breaker_state is missing a tier row — the tick path never persisted the sticky ' +
        "breakers' state, so a tripped hard-drawdown breaker or kill switch re-arms itself on " +
        'restart. Under ADR-0007 the breakers are the only remaining stop; this table sat ' +
        'unwritten behind a doc comment claiming "the caller persists this" (review 2026-08-06 B1)',
    );
  }

  if (!verdicts.some((verdict) => verdict.status === 'go')) {
    failures.push(
      `no GO verdict was recorded in verdict_log (${verdicts.length} verdict row(s): ` +
        `${summariseVerdicts(verdicts)}) — the pipeline never authorised a trade`,
    );
  }

  const submitted = ticks.flatMap((tick) =>
    tick.stages.filter((entry) => entry.stage === 'execution' && entry.decision === 'submitted'),
  );
  if (submitted.length === 0) {
    failures.push(
      'no tick reached Execution with a `submitted` result — nothing was ever handed to the ' +
        'broker adapter',
    );
  }

  if (positions.length === 0) {
    failures.push(
      'no row in open_positions — Execution never wrote a lot ahead of the broker call, so ' +
        'there is nothing for reconcile() or the fill poll to advance',
    );
  }

  if (!fills.some((fill) => fill.leg === 'entry')) {
    failures.push(
      'no entry fill in fills — the order was submitted but no fill was ever ingested, so the ' +
        'fill-sync poll (ingestFills) is not draining the venue feed',
    );
  }

  // #576 — the exit path, unconditional: `runExitPathScenarios` always runs,
  // so every one of these is expected on every healthy smoke run, the same
  // way `positions`/`fills` above are.

  // #508/#516: the write-ahead journal must exist and every row must have
  // resolved — an unresolved row means an exit was journalled and then the
  // broker call was refused or left ambiguous.
  if (observations.flattenSubmissions.length === 0) {
    failures.push(
      "no row in flatten_submissions — no exit ever reached executeExit()'s write-ahead journal " +
        "(#508), so #516's cancel-before-flatten guard was never exercised",
    );
  } else {
    const unresolved = observations.flattenSubmissions.filter((row) => row.status !== 'submitted');
    if (unresolved.length > 0) {
      failures.push(
        `flatten_submissions has ${unresolved.length} row(s) not resolved to 'submitted' ` +
          `(${unresolved.map((row) => `${row.idempotency_key}:${row.status}`).join(', ')}) — an ` +
          'exit was journalled but its flatten never reached, or was refused by, the broker',
      );
    }
  }

  // #516 — ORDERING, not merely that both calls happened: every `submitFlatten`
  // must have a `cancel` recorded FRESH since the previous `submitFlatten` (or
  // the start of the run), not merely "somewhere earlier in the sequence" —
  // that weaker form would report the FIRST flatten's own missing cancel and
  // then stop, because every later flatten's window contains SOME earlier
  // cancel and (wrongly) reads as satisfied.
  //
  // What this window scoping does NOT do: verify the cancel it finds belongs
  // to the SAME lot the flatten is closing. A resting bracket leg cancelled
  // after the flatten (or never) can fire into the now-flat position and open
  // a reverse one, and this check catches that for the FIRST flatten a
  // regression touches — sufficient in practice because `executeExit` cancels
  // and flattens through one uniform code path applied to every exit, so a
  // real regression of #516's ordering shows up on the first flatten, not
  // selectively on a later one.
  const { brokerCallSequence } = options.exitPath;
  let sincePreviousFlatten = 0;
  const flattensWithoutPriorCancel: string[] = [];
  for (const [index, call] of brokerCallSequence.entries()) {
    if (!call.startsWith('submitFlatten:')) continue;
    const window = brokerCallSequence.slice(sincePreviousFlatten, index);
    if (!window.some((entry) => entry.startsWith('cancel:'))) {
      flattensWithoutPriorCancel.push(call);
    }
    sincePreviousFlatten = index + 1;
  }
  if (flattensWithoutPriorCancel.length > 0) {
    failures.push(
      `broker call(s) ${flattensWithoutPriorCancel.join(', ')} have no 'cancel' call recorded ` +
        `before them (full sequence: ${brokerCallSequence.join(' -> ') || '(empty)'}) — a resting ` +
        'bracket leg cancelled after the flatten (or never) can fire into the now-flat position ' +
        'and open a reverse one (#516)',
    );
  }
  if (!brokerCallSequence.some((call) => call.startsWith('submitFlatten:'))) {
    failures.push(
      'the exit-path harness recorded no submitFlatten call at all — exits never reached ' +
        'submitFlatten (#508)',
    );
  }

  // #508/#517: every exit must eventually round-trip a lot to `closed` with
  // a `ClosedTrade` — see `SmokeObservations.closedTrades`'s doc for why this
  // was NOT required before #576.
  if (observations.closedTrades.length === 0) {
    failures.push(
      'no row in closed_trades — the exit-path scenarios never round-tripped a lot to flat, so ' +
        "either a flatten's fill was never attributed back to the lot it closed (#517) or " +
        'ingestFills() never reached its round-trip-to-flat branch at all',
    );
  }

  // Scoped to scenario 1's OWN lot, not just the aggregate above: scenario 3
  // alone closes two lots, so an aggregate-only check stays green if
  // scenario 1 regresses in isolation (e.g. a reintroduced #517
  // misattribution confined to its instrument) while scenario 3 still
  // closes normally. Same pattern the #571 check below uses for its own lots.
  const fullExitLot = positions.find(
    (position) => position.idempotency_key === options.exitPath.fullExit.lotKey,
  );
  if (fullExitLot === undefined || fullExitLot.order_state !== 'closed') {
    failures.push(
      `lot '${options.exitPath.fullExit.lotKey}' (scenario 1's full exit) never reached ` +
        `order_state 'closed' (${
          fullExitLot === undefined
            ? 'no row in open_positions'
            : `state=${fullExitLot.order_state}`
        }) — the #508/#517 exit path did not round-trip it to flat`,
    );
  }

  // #525 — the residual left by a partial flatten must be RE-ARMED (not left
  // naked), and re-arming must not have needed the fallback alert: a
  // successful re-arm posts nothing (residual-exposure-alert.ts).
  const { partialFlatten, residualAlerts } = options.exitPath;
  if (partialFlatten.protectedQty === null) {
    failures.push(
      `lot '${partialFlatten.idempotencyKey}' has no protective legs armed after its partial ` +
        "flatten — the #525 residual re-arm never ran, leaving the lot's residual naked",
    );
  } else if (partialFlatten.protectedQty !== partialFlatten.expectedResidual) {
    failures.push(
      `lot '${partialFlatten.idempotencyKey}' has ${partialFlatten.protectedQty} protected after ` +
        `its partial flatten, expected the residual ${partialFlatten.expectedResidual} — the ` +
        're-arm (#525) sized the wrong quantity',
    );
  }
  if (residualAlerts.length > 0) {
    failures.push(
      `${residualAlerts.length} residual-exposure alert(s) fired during the smoke run ` +
        `(lot(s): ${residualAlerts.map((alert) => alert.idempotency_key).join(', ')}) — a ` +
        'successful re-arm posts nothing (residual-exposure-alert.ts); an alert here means the ' +
        '#525 re-arm failed on a deterministic offline broker',
    );
  }

  // #571 — neither lot named by a multi-lot flatten may be left phantom-open:
  // both must have reached `order_state: 'closed'` in `open_positions`.
  const phantomOpen = options.exitPath.twoLotFlatten.lotKeys.filter((key) => {
    const row = positions.find((position) => position.idempotency_key === key);
    return row === undefined || row.order_state !== 'closed';
  });
  if (phantomOpen.length > 0) {
    failures.push(
      `lot(s) ${phantomOpen.join(', ')} were named by a two-lot flatten but never reached ` +
        "order_state 'closed' — the #571 fill split left quantity unaccounted for on at least " +
        'one sibling lot',
    );
  }

  // #519/#526 — the ENFORCEMENT assertions for the flatten-journal sweep
  // (#430's convention: a durable EFFECT only the new mechanism produces,
  // not that an object was constructed). A regression that deletes
  // `reconcile()`'s flatten sweep, or reverts `resumeFlatten` to a no-op,
  // leaves scenario 4's lot open forever — `ingestFills()` alone never polls
  // an order the process-local `flattens` map has forgotten, so nothing
  // short of the sweep itself can close it.
  const { crashRestart, flattenReconcileAlerts: flattenReconcileAlertsFired } = options.exitPath;
  const crashRestartDivergence = crashRestart.reconcileReport.divergences.find(
    (divergence) => divergence.idempotency_key === crashRestart.flattenKey,
  );
  if (crashRestartDivergence === undefined) {
    failures.push(
      `the restarted Execution's reconcile() report named no divergence for scenario 4's ` +
        `flatten '${crashRestart.flattenKey}' (lot '${crashRestart.lotKey}') — ` +
        'SharedStore.getUnresolvedFlattens() found nothing to resolve, so the journal sweep ' +
        '(#519) either never ran or the row was not recognised as unresolved ' +
        `(checked=${crashRestart.reconcileReport.checked}, ` +
        `divergences=${crashRestart.reconcileReport.divergences.length})`,
    );
  } else if (crashRestartDivergence.action !== 'adopted') {
    failures.push(
      `the restarted Execution's reconcile() settled scenario 4's flatten with action ` +
        `'${crashRestartDivergence.action}', not 'adopted' (reason: ` +
        `${crashRestartDivergence.reason}) — the venue genuinely acked this flatten, so anything ` +
        "other than 'adopted' means reconcile() mis-settled a row it should have resolved cleanly",
    );
  }
  const crashRestartLot = positions.find(
    (position) => position.idempotency_key === crashRestart.lotKey,
  );
  if (crashRestartLot === undefined || crashRestartLot.order_state !== 'closed') {
    failures.push(
      `lot '${crashRestart.lotKey}' (scenario 4's crash-restart flatten) never reached ` +
        `order_state 'closed' after the restarted Execution's reconcile() + ingestFills() ` +
        `(${crashRestartLot === undefined ? 'no row in open_positions' : `state=${crashRestartLot.order_state}`}) ` +
        "— reconcile()'s flatten sweep did not re-establish the fill-sweep worklist the way " +
        '#519/#526 require',
    );
  }
  if (flattenReconcileAlertsFired.length > 0) {
    failures.push(
      `${flattenReconcileAlertsFired.length} flatten-reconcile alert(s) fired during the smoke ` +
        `run (flatten(s): ${flattenReconcileAlertsFired.map((alert) => alert.idempotency_key).join(', ')}) ` +
        "— scenario 4's flatten resolves cleanly against a deterministic offline broker; an " +
        'alert here means reconcile() could not settle a row it should have',
    );
  }

  // #586 — the emulated crypto protective legs, unconditional for #430's
  // reason: `runCryptoEmulationScenario` always runs, the smoke universe is
  // crypto, and no other check in this gate can see the emulation at all
  // (the six-stage run and the exit-path harness both override the broker
  // with `SimulatedBrokerAdapter`). Each check names a different way the
  // mechanism can silently stop being wired.
  const emulation = options.cryptoEmulation;
  if (emulation.journalRow === undefined || emulation.journalRow.asset_class !== 'crypto') {
    failures.push(
      "the emulated-leg journal (broker_brackets, venue 'alpaca') has no crypto row for the " +
        "crypto-emulation scenario's lot — submitBracket stopped journalling the emulated " +
        'bracket (#586), so a crash between the entry and its protective legs leaves a live ' +
        'crypto position nothing knows to protect',
    );
  } else {
    if (
      emulation.journalRow.stop_order_id === null ||
      emulation.journalRow.target_order_id === null
    ) {
      failures.push(
        "the crypto-emulation scenario's journal row is missing protective-leg order ids after " +
          'the entry filled — the legs were never submitted as plain crypto orders (#586), so ' +
          'the filled lot sat naked',
      );
    }
    if (emulation.journalRow.phase !== 'resolved') {
      failures.push(
        `the crypto-emulation scenario's journal row ended in phase ` +
          `'${emulation.journalRow.phase}', expected 'resolved' — the emulated OCO edge ` +
          '(leg fill -> sibling cancel) did not complete (#586)',
      );
    }
  }
  if (!emulation.entryFillSeen) {
    failures.push(
      "the crypto-emulation scenario's entry fill never came back through fetchNewFills — the " +
        'emulation sweep is not polling its plain entry order (#586), so ingestFills would ' +
        'never learn a crypto entry filled',
    );
  }
  if (!emulation.stopFillSeen) {
    failures.push(
      "the crypto-emulation scenario's stop-leg fill never came back through fetchNewFills — " +
        'the emulation sweep is not polling its resting legs (#586), so a stop-out would go ' +
        'unbooked',
    );
  }
  if (!emulation.siblingCancelled) {
    failures.push(
      'the surviving take-profit leg was never cancelled after the stop leg filled — the ' +
        'emulated one-cancels-other edge is not firing (#586), leaving a resting order that ' +
        'can fire into a flat position and open a reverse one',
    );
  }

  return { passed: failures.length === 0, failures };
}

function summariseVerdicts(verdicts: SmokeObservations['verdicts']): string {
  if (verdicts.length === 0) return 'none';
  return verdicts
    .map((verdict) => `${verdict.status}${verdict.no_go_reason ? `:${verdict.no_go_reason}` : ''}`)
    .join(', ');
}

/**
 * The human-readable run report — the thing a person reads to believe the
 * pipeline transacted rather than skipped. Returned as lines so tests can
 * assert on it without capturing stdout.
 */
export function formatSmokeReport(
  observations: SmokeObservations,
  gate: SmokeGateResult,
): string[] {
  const lines: string[] = [
    '',
    '=== Samurai offline end-to-end smoke run (#350) ===',
    'mode=paper  broker=SimulatedBrokerAdapter  data=FixtureDataSource  llm=ConstantResponseLlmClient',
    `no credentials, no network, no money. Clock frozen at ${SMOKE_RUN_INSTANT.toISOString()}`,
    '',
    `ticks completed: ${observations.ticks.length}`,
  ];

  for (const [index, tick] of observations.ticks.entries()) {
    const reached = tick.stages.map((entry) => `${entry.stage}:${entry.decision}`).join(' -> ');
    lines.push(`  tick ${index + 1} [${tick.trace_id}] ${reached}`);
  }

  lines.push('', `debates logged: ${observations.debates.length}`);
  for (const debate of observations.debates) {
    lines.push(
      `  ${debate.instrument} ${debate.direction} rounds=${debate.rounds} [${debate.debate_id}]`,
    );
  }

  lines.push('', `verdicts recorded: ${observations.verdicts.length}`);
  for (const verdict of observations.verdicts) {
    lines.push(
      `  ${verdict.instrument} ${verdict.status}${
        verdict.no_go_reason ? ` (${verdict.no_go_reason})` : ''
      } [${verdict.trace_id}]`,
    );
  }

  lines.push('', `lots submitted to the broker: ${observations.positions.length}`);
  for (const position of observations.positions) {
    lines.push(
      `  ${position.instrument} ${position.side} requested=${position.requested_size} ` +
        `filled=${position.filled_size} @ ${position.avg_entry_price} ` +
        `state=${position.order_state} [${position.idempotency_key}]`,
    );
  }

  lines.push('', `fills ingested: ${observations.fills.length}`);
  for (const fill of observations.fills) {
    lines.push(
      `  ${fill.leg} qty=${fill.qty} @ ${fill.price} fee=${fill.fee} [${fill.idempotency_key}]`,
    );
  }

  lines.push('', `closed trades: ${observations.closedTrades.length}`);
  for (const trade of observations.closedTrades) {
    lines.push(
      `  ${trade.close_reason} realized_pnl_net=${trade.realized_pnl_net} [${trade.idempotency_key}]`,
    );
  }

  lines.push('', `flatten submissions journalled: ${observations.flattenSubmissions.length}`);
  for (const row of observations.flattenSubmissions) {
    lines.push(`  ${row.instrument} status=${row.status} [${row.idempotency_key}]`);
  }

  lines.push('');
  if (gate.passed) {
    lines.push('GATE: PASS — the pipeline transacted end to end in a real process.');
  } else {
    lines.push('GATE: FAIL — the pipeline did not transact end to end:');
    for (const failure of gate.failures) lines.push(`  - ${failure}`);
  }
  lines.push('');

  return lines;
}

export interface SmokeRunOptions {
  /** How many ticks must complete before the run is allowed to stop. Default 3. */
  ticks?: number;
  /**
   * Gap between ticks. Default 250ms — fast enough for a pre-commit gate, and
   * `ticks * tickIntervalMs` must stay far below
   * `verdictConfig.max_signal_age.crypto` (5 minutes), since the fixture mark's
   * `observed_at` is frozen and Verdict's staleness gate measures against it.
   * Raising either constant materially is what would silently start no-going
   * the later ticks.
   */
  tickIntervalMs?: number;
  /**
   * Gap between fill polls. Default 100ms — deliberately tighter than the tick
   * interval, because the entry fill only lands when `ingestFills()` runs, and
   * a run that stopped before the first poll would fail the gate spuriously.
   */
  fillPollIntervalMs?: number;
  /**
   * Heartbeat cadence. Default 100ms, so the dead-man's-switch timer actually
   * fires several times inside a ~1s run rather than being wired but inert.
   */
  heartbeatIntervalMs?: number;
  /**
   * Hard wall-clock ceiling. Default 30s. The run stops and reports whatever it
   * reached rather than hanging — a gate that can hang is a gate nobody runs.
   */
  deadlineMs?: number;
  logger?: Logger;
}

const DEFAULT_SMOKE_TICKS = 3;
const DEFAULT_SMOKE_TICK_INTERVAL_MS = 250;
const DEFAULT_SMOKE_FILL_POLL_INTERVAL_MS = 100;
const DEFAULT_SMOKE_HEARTBEAT_INTERVAL_MS = 100;
const DEFAULT_SMOKE_DEADLINE_MS = 30_000;
/** How long to keep waiting for the fill poll once the tick target is met. */
const FILL_GRACE_MS = 2_000;
/** Store-polling granularity for the two waits below. */
const OBSERVE_INTERVAL_MS = 25;

/** Polls the store until `done` or the deadline — never a fixed sleep. */
async function waitUntil(check: () => boolean, deadline: number): Promise<void> {
  while (Date.now() < deadline && !check()) {
    await delay(OBSERVE_INTERVAL_MS);
  }
}

export interface SmokeRunResult {
  observations: SmokeObservations;
  gate: SmokeGateResult;
  /** The human-readable report lines. Printed by the entrypoint, not by `runSmoke` itself. */
  report: string[];
}

/**
 * Starts the real entrypoint assembly over fixtures, runs a bounded number of
 * ticks, drains, and evaluates the gate.
 *
 * Every dependency below goes in through a documented `ProductionConfig`
 * override; none of it is a branch inside the composition root.
 */
export async function runSmoke(options: SmokeRunOptions = {}): Promise<SmokeRunResult> {
  const targetTicks = options.ticks ?? DEFAULT_SMOKE_TICKS;
  const tickIntervalMs = options.tickIntervalMs ?? DEFAULT_SMOKE_TICK_INTERVAL_MS;
  const fillPollIntervalMs = options.fillPollIntervalMs ?? DEFAULT_SMOKE_FILL_POLL_INTERVAL_MS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_SMOKE_HEARTBEAT_INTERVAL_MS;
  const deadlineMs = options.deadlineMs ?? DEFAULT_SMOKE_DEADLINE_MS;
  // Plain `JsonLogger` (stdout), never `buildEntrypointLogger()`: that one
  // opens the rotating file sink and creates `logs/`, and a gate should leave
  // no artefacts behind. The store is `:memory:` for the same reason — no
  // `data/*.sqlite` to clean up, and no chance of a smoke run polluting a real
  // paper run's history.
  const logger = options.logger ?? new JsonLogger();
  const db = openSharedStore(':memory:');

  try {
    const clock = new SimulatedClock(SMOKE_RUN_INSTANT);
    const profile = paperStartingProfile('paper');
    const dataSource = new FixtureDataSource(
      buildSmokeFixtureBars(),
      { price: SMOKE_MARK_PRICE, observed_at: SMOKE_RUN_INSTANT, source: 'smoke-fixture' },
      'crypto',
      {
        bid: SMOKE_MARK_PRICE - 0.5,
        ask: SMOKE_MARK_PRICE + 0.5,
        observed_at: SMOKE_RUN_INSTANT,
      },
    );

    // The one instance this module has to build rather than reach through the
    // root: `SimulatedBrokerAdapter` needs a `MarketDataService` at
    // construction, and the broker is itself a constructor input to
    // `buildProductionOrchestrator`, so the root's own instance does not exist
    // yet. Same data source, same store, same 'live' mode the root derives for
    // `mode: 'paper'` — so the two instances cannot disagree about a fixture.
    const marketDataForBroker = new MarketDataServiceImpl(
      dataSource,
      clock,
      'live',
      new SqliteMarketDataStore(db),
    );
    const broker = new SimulatedBrokerAdapter({
      clock,
      costModel: new CostModelImpl(profile.costConfig),
      marketData: marketDataForBroker,
      config: profile.executionConfig.simulated,
    });
    const alpacaBrokerClient = new UnreachableAlpacaClient();
    // Built here rather than left to the composition root for one reason: the
    // gate has to READ it afterwards (#388). Same config the root would have
    // used — `profile.rateLimiterConfig` — so this override changes who holds
    // the reference, not what the limiter permits.
    const llmRateLimiter = new RateLimiter(clock, profile.rateLimiterConfig);
    // #576: the tick loop's own residual-exposure channel, recorded rather
    // than left at the `LoggingResidualExposureAlertChannel` default — the
    // gate has to see whether the SIX-STAGE run ever posted one too, not
    // only the exit-path harness below.
    const tickLoopResidualAlerts = new RecordingResidualExposureAlertChannel(
      new LoggingResidualExposureAlertChannel(logger),
    );

    const orchestrator = await startFromEnvironment({
      // The same checked-in tuning values `yarn orchestrator` runs on, at the
      // same `mode: 'paper'` — so the HITL gate resolves through
      // `automation_level: 'auto'` exactly as it will during the soak.
      // `mode: 'backtest'` was the alternative and was rejected deliberately:
      // it bypasses Verdict's gate 6 outright (verdict/index.ts), which would
      // leave the pre-soak gate validating a path the soak never takes.
      //
      // **This is now the enforcement check for ADR-0007, and it works by
      // omission.** No `approvals` is injected here, so the composition root
      // installs its `UnwiredApprovalChannel` default — which THROWS if gate 6
      // is ever reached. A smoke run that transacts is therefore positive
      // evidence that the `auto` dial short-circuits before any approval is
      // requested, on the real composition root rather than in a unit test.
      // Flip either class off `auto` without wiring a transport and this gate
      // fails loudly instead of auto-approving, which is exactly the failure
      // mode `ConsoleApprovalChannel` used to hide here.
      ...profile,
      db,
      clock,
      logger,
      universe: SMOKE_TEST_UNIVERSE,
      // The three overrides `ProductionConfig`'s own doc comments name as the
      // intended offline bindings.
      broker,
      dataSource,
      llmClient: new ConstantResponseLlmClient(),
      llmRateLimiter,
      // See the class docs: both of these exist because the composition root's
      // defaults reach Alpaca over the network.
      accountState: new FixedAccountStateProvider(),
      alpacaBrokerClient,
      // Naming log-only alerting explicitly. Injecting all of
      // `ALERT_CHANNEL_FIELDS` is also what makes `resolveAlertsMode` return
      // `undefined` (alert-transport.ts), so this run neither reads
      // `SAMURAI_ALERTS` nor falls back by omission. Miss one and the gate
      // starts demanding an environment variable of every developer who runs
      // it — which is why the list is derived, not remembered.
      heartbeatChannel: new LoggingHeartbeatChannel(logger),
      orphanAlerts: new LoggingOrphanAlertChannel(logger),
      unpricedFillAlerts: new LoggingUnpricedFillAlertChannel(logger),
      // #586 — the ninth `ALERT_CHANNEL_FIELDS` member; injected so this
      // run stays exempt from SAMURAI_ALERTS (see the derived-list comment
      // below).
      ocoDoubleFillAlerts: new LoggingOcoDoubleFillAlertChannel(logger),
      breachAlerts: new LoggingBreachAlertChannel(logger),
      loosenApprovals: new LoggingLoosenApprovalChannel(logger),
      analystSkipAlerts: new LoggingAnalystSkipAlertChannel(logger),
      // #576: recorded, not just logged — see `tickLoopResidualAlerts` above.
      // Became an `ALERT_CHANNEL_FIELDS` member in #551 (the eighth channel);
      // this injection already covered it before that landed, so `resolveAlertsMode`'s
      // exemption logic (below) needed no change here — see the next comment.
      residualExposureAlerts: tickLoopResidualAlerts,
      // #519 — the ninth channel (`ALERT_CHANNEL_FIELDS`, alert-transport.ts).
      // The six-stage tick loop above never reaches a flatten (no exit intent
      // is ever driven through it — see `runExitPathScenarios`'s own file doc
      // for why), so there is nothing here for the gate to read back; a
      // plain log-only instance is enough to keep this injection list
      // exhaustive against `ALERT_CHANNEL_FIELDS`, the same posture
      // `orphanAlerts`/`unpricedFillAlerts`/etc. already take below.
      flattenReconcileAlerts: new LoggingFlattenReconcileAlertChannel(logger),
      // #465 — the seventh channel; #551 later added an eighth
      // (`residualExposureAlerts`, above). `resolveAlertsMode` exempts a
      // caller that supplies EVERY field in `ALERT_CHANNEL_FIELDS` from
      // needing SAMURAI_ALERTS, so adding a field to that list makes this
      // injection incomplete and the smoke run demands the variable. A
      // log-only notifier keeps the offline run self-contained.
      verdictAlerts: { notify: async () => {} },
      tickIntervalMs,
      fillPollIntervalMs,
      // Fast enough to fire several times inside a ~1s run. The heartbeat is a
      // dead-man's switch and this process is attended, so it is not what the
      // gate asserts on — but it is one of the process-level timers #350 names,
      // and a smoke run in which it never fired would leave `Heartbeat.emit`
      // and its channel unexercised. Log-only here (see the channels above), so
      // firing it costs nothing and pages nobody.
      heartbeatIntervalMs,
      maxConcurrentInstruments: 1,
    });

    const deadline = Date.now() + deadlineMs;
    try {
      await waitUntil(() => readSmokeObservations(db).ticks.length >= targetTicks, deadline);
      // Then a bounded grace period for the fill poll to follow the submit —
      // the fill lands on `ingestFills()`, not on the tick that submitted.
      await waitUntil(
        () => readSmokeObservations(db).fills.length > 0,
        Math.min(Date.now() + FILL_GRACE_MS, deadline),
      );
    } finally {
      // Always drained, including on the deadline path: `stop()` awaits the
      // in-flight tick, and abandoning one mid-pipeline manufactures exactly
      // the orphaned verdict #209 exists to detect.
      await orchestrator.stop();
    }

    // #576: the exit path. Run AFTER the tick loop has stopped and drained —
    // it shares `db` and `clock` with the six-stage run above, but drives its
    // own instruments (`EXIT_PATH_INSTRUMENTS`), so the two cannot contend
    // for the same lots or the same `heldLots` filter (execute.ts).
    const exitPathHarnessResult = await runExitPathScenarios({
      db,
      clock,
      costConfig: profile.costConfig,
      executionConfig: profile.executionConfig,
      logger,
    });

    // #586: the emulated crypto protective legs, on the REAL AlpacaBrokerAdapter
    // over the same db — its own lot key and its own scripted client, so it
    // contends with nothing above.
    const cryptoEmulation = await runCryptoEmulationScenario(db);

    const observations = readSmokeObservations(db);
    const gate = evaluateSmokeGate(observations, {
      minTicks: targetTicks,
      alpacaWireClientReached: alpacaBrokerClient.reached,
      llmRateLimiterSnapshot: llmRateLimiter.snapshot(),
      cryptoEmulation,
      exitPath: {
        ...exitPathHarnessResult,
        // Alerts from BOTH the six-stage tick loop and the exit-path harness —
        // a residual alert is a defect wherever it fires during a smoke run.
        residualAlerts: [...tickLoopResidualAlerts.alerts, ...exitPathHarnessResult.residualAlerts],
      },
    });
    return { observations, gate, report: formatSmokeReport(observations, gate) };
  } finally {
    db.close();
  }
}

// Entrypoint guard, matching orchestrator/index.ts's. `yarn smoke` runs this
// file directly; importing it (from its own test) must not start a run.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { report, gate } = await runSmoke();
    process.stdout.write(`${report.join('\n')}\n`);
    // The exit code is the gate. A run where every tick quorum-skips, or where
    // no order is ever submitted, must fail — otherwise this is decoration
    // rather than a pre-soak gate.
    process.exit(gate.passed ? 0 : 1);
  } catch (error) {
    // Message only, matching orchestrator/index.ts: nothing here holds a
    // credential, but the posture should not differ between the two
    // entrypoints.
    process.stderr.write(
      `offline smoke run failed to complete: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exit(1);
  }
}
