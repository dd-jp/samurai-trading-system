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
import { CostModelImpl } from '../cost-model-backtest/index.js';
import type {
  LlmClient,
  LlmRequest,
  LlmResponse,
  RateLimiterSnapshot,
} from '../debate-engine/index.js';
import { RateLimiter } from '../debate-engine/index.js';
import type { AlpacaClient } from '../execution/index.js';
import { SimulatedBrokerAdapter } from '../execution/index.js';
import type { Bar } from '../market-data-service/index.js';
import {
  FixtureDataSource,
  MarketDataServiceImpl,
  SqliteMarketDataStore,
} from '../market-data-service/index.js';
import type { SessionBasisByClass } from '../risk-manager/index.js';
import { SimulatedClock } from '../shared/index.js';
import { openSharedStore, type SharedStore as SqliteHandle } from '../shared/store/index.js';
import {
  LoggingAnalystSkipAlertChannel,
  LoggingBreachAlertChannel,
  LoggingHeartbeatChannel,
  LoggingLoosenApprovalChannel,
  LoggingOrphanAlertChannel,
  LoggingUnpricedFillAlertChannel,
} from './console-channels.js';
import { startFromEnvironment } from './index.js';
import { JsonLogger } from './logger.js';
import { paperStartingProfile } from './paper-profile.js';
import type { AccountStateProvider } from './production/direct-bind.js';
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

  async cancelOrder(): Promise<never> {
    return this.refuse('cancelOrder');
  }

  async getPositions(): Promise<never> {
    return this.refuse('getPositions');
  }
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
  /** From `closed_trades`. Always empty offline — see `SMOKE_CLOSED_TRADE_NOTE`. */
  closedTrades: { idempotency_key: string; realized_pnl_net: number; close_reason: string }[];
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
}

/**
 * Why a passing smoke run still reports zero `ClosedTrade`s, stated in the
 * output rather than left to be rediscovered.
 *
 * `SimulatedBrokerAdapter.submitBracket` models exactly one `entry` fill and
 * parks it; `resizeProtectiveLegs` records a quantity and nothing more. No
 * stop/target/exit fill is ever produced, so `ingestFills()`'s
 * round-trip-to-flat branch is never taken and `writeClosedTrade` is never
 * called. `intent_type: 'exit'` is separately unimplemented (#82/#83). A
 * `ClosedTrade` is therefore not reachable offline today, and the gate does
 * not require one — inventing exit-fill modelling in the simulated adapter to
 * satisfy a smoke run would be the tail wagging the dog.
 */
export const SMOKE_CLOSED_TRADE_NOTE =
  'closed trades: 0 — expected offline. SimulatedBrokerAdapter models only the entry fill (no ' +
  'stop/target/exit legs), so ingestFills() never reaches round-trip-to-flat and no ClosedTrade ' +
  'can be produced. Not a gate failure; see #82/#83.';

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
    // #430. Each of these is a mechanism that was, at some point, fully built,
    // fully unit-tested and called by nothing in production. The table row is
    // the only evidence that a caller exists.
    cosineSetups: db
      .prepare('SELECT debate_id, instrument FROM cosine_setups')
      .all() as SmokeObservations['cosineSetups'],
    riskThresholds: db
      .prepare('SELECT threshold_name AS name, value FROM risk_thresholds')
      .all() as SmokeObservations['riskThresholds'],
    analystWeights: db
      .prepare('SELECT analyst_id FROM analyst_weights')
      .all() as SmokeObservations['analystWeights'],
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
 * A `ClosedTrade` is NOT required: see `SMOKE_CLOSED_TRADE_NOTE`.
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

  if (observations.analystWeights.length === 0) {
    failures.push(
      'no row in analyst_weights — the startup seeder did not run, so `runDailyCycle` skips ' +
        'every analyst it cannot find a row for and the loop attributes nothing while reporting ' +
        'a clean run. This is the #371 defect',
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

  lines.push('');
  lines.push(
    observations.closedTrades.length === 0
      ? SMOKE_CLOSED_TRADE_NOTE
      : `closed trades: ${observations.closedTrades.length}`,
  );
  for (const trade of observations.closedTrades) {
    lines.push(
      `  ${trade.close_reason} realized_pnl_net=${trade.realized_pnl_net} [${trade.idempotency_key}]`,
    );
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

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
      breachAlerts: new LoggingBreachAlertChannel(logger),
      loosenApprovals: new LoggingLoosenApprovalChannel(logger),
      analystSkipAlerts: new LoggingAnalystSkipAlertChannel(logger),
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

    const observations = readSmokeObservations(db);
    const gate = evaluateSmokeGate(observations, {
      minTicks: targetTicks,
      alpacaWireClientReached: alpacaBrokerClient.reached,
      llmRateLimiterSnapshot: llmRateLimiter.snapshot(),
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
