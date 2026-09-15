/**
 * Composition of falsifier arm 2 (#753) — the control arm's own step set, built
 * from the SAME builders the live arm's is.
 *
 * Read `server/apps/orchestrator/control-arm.ts` first: it explains what the
 * control arm is (the live arm's tick runner with the debate step replaced by
 * the deterministic axis vote) and what has to be per-arm (the book, the broker,
 * the breakers, the progress row). This module is where that is actually wired.
 *
 * ## Why this is a function of the LIVE deps, not a second config
 *
 * Every field below that is not explicitly per-arm is passed through from the
 * live arm's own dependency set — the same `TraderConfig` (so the same
 * conviction floor, the same frozen ADR-0018 D3 bracket and stop, the same
 * flatten window), the same `RiskConfig` and thresholds, the same
 * `VerdictConfig`, the same `MarketDataService` (so literally the same tape),
 * the same session calendars, the same `SetupStore`.
 *
 * The `AccountStateProvider` is NOT one of them, and it used to be. Passing the
 * live arm's through made the control's D5 sizing and its drawdown-halt timing
 * a function of the live arm's realized cash — the live provider reads
 * `GET /v2/account`, and the control never places an order there. So the arms
 * share every RULE and no BALANCE: see `control-account-state.ts`.
 *
 * That pass-through is the mechanism behind #753's "asserted, not configured
 * twice". There is no control-arm bracket table, no control-arm stop, no
 * control-arm conviction floor to keep in step, because the control arm is
 * handed the live arm's. A test can therefore assert the two arms move together
 * by perturbing ONE config and observing both — which is a stronger statement
 * than comparing two constants that happen to be equal today.
 */
import type {
  BrokerAdapter,
  ExecutionConfig,
  SharedStore as ExecutionSharedStore,
} from '../../../pipeline/execution/index.js';
import {
  FilledZeroSizeThrottle,
  UnrecordedVenuePositionThrottle,
} from '../../../pipeline/execution/index.js';
import type {
  BreakerStatePersistence,
  CircuitBreakers,
  PersistedBreakerState,
} from '../../../pipeline/risk-manager/index.js';
import type { MarketDataService } from '../../../providers/market-data-service/index.js';
import type { Logger } from '../../../shared/index.js';
import type { CostModel } from '../../../tools/backtest/index.js';
import {
  AnalystViewRelay,
  buildControlAnalystsStep,
  buildControlArmStep,
  buildControlDebateStep,
  type ControlArmStep,
  InMemoryCurrentTickStore,
} from '../control-arm.js';
import { SequentialTickRunner } from '../tick-runner.js';
import type { TickSteps } from '../types.js';
import {
  type AccountStateProvider,
  buildExecutionStep,
  buildExecutionSurface,
  buildRiskStep,
  buildTraderSteps,
  buildVerdictStep,
  type ExecutionStepDeps,
  type PortfolioSnapshot,
  type RiskStepDeps,
  type TraderStepDeps,
  type VerdictStepDeps,
} from './direct-bind.js';

/**
 * The control arm's breaker-state home.
 *
 * In-memory, and that is a decision rather than a shortcut. `CircuitBreakers`
 * must be a separate INSTANCE per arm — `evaluate()` persists the sticky tiers,
 * so one shared instance would let a control-arm drawdown trip a breaker that
 * halts the live book, which would make the measurement change the thing it is
 * measuring. Given a separate instance, its state has to land somewhere, and
 * durability buys nothing here: a control arm's latched breaker is not
 * operationally load-bearing (no real money is behind it), while a durable one
 * would need a second `breaker_state` key space to avoid clobbering the live
 * arm's single row.
 *
 * What it deliberately does NOT do is disarm the control's breakers. The arms
 * must be matched on REFUSALS as well as on entries: a control that keeps
 * trading through a drawdown the live arm's breakers stopped is not measuring
 * the same strategy. Within a process, this behaves exactly as the durable one
 * does.
 */
export class InMemoryBreakerStatePersistence implements BreakerStatePersistence {
  #states: readonly PersistedBreakerState[] = [];

  /** What was last saved. Not on the port — exposed so a test can read it back. */
  load(): readonly PersistedBreakerState[] {
    return this.#states;
  }

  save(states: readonly PersistedBreakerState[]): void {
    this.#states = states;
  }
}

export interface ControlArmWiringDeps {
  /**
   * The live arm's Trader deps, verbatim. `getOpenPositions`,
   * `getExitFillSizes`, `getUnresolvedFlattens` and the breaker fields are
   * overridden below; everything else — config, calendars, setup store, capital
   * ceiling — is shared, which is what makes the two arms' entry, sizing and
   * exit rules one rule.
   *
   * Every one of those overrides is a BOOK read, and an omitted one is
   * invisible: the spread supplies the live arm's binding, the field is still
   * present so `tsc` is satisfied, and nothing downstream can restore the
   * arm-scoping (`SqliteExecutionStore` scopes on the instance, not the
   * caller). `flatten-guard-arm-wiring.test.ts` is the standing proof for the
   * one that shipped that way.
   */
  trader: TraderStepDeps;
  /** The live arm's Risk deps, verbatim, with the breaker fields overridden. */
  risk: RiskStepDeps;
  /** The live arm's Verdict deps, verbatim, with the breaker fields and store overridden. */
  verdict: VerdictStepDeps;
  /** The live arm's Execution deps, verbatim, with the broker and store overridden. */
  execution: ExecutionStepDeps;

  /** The control arm's own book — a `SqliteExecutionStore` constructed with `arm: 'control'`. */
  store: ExecutionSharedStore;
  /** The control arm's own venue — a `SimulatedBrokerAdapter`, never the live one. */
  broker: BrokerAdapter;
  /** The control arm's own breaker instance, over `InMemoryBreakerStatePersistence`. */
  circuitBreakers: CircuitBreakers;
  breakerState: BreakerStatePersistence;
  /**
   * The control arm's own `cash` / `peak_equity` / `daily_basis` /
   * `consecutive_losses` — a `ControlArmAccountStateProvider`, never the live
   * arm's `BrokerAccountStateProvider`.
   *
   * Required rather than defaulted, and typed on this interface rather than
   * left to fall through from `deps.trader`/`deps.risk`/`deps.verdict`: an
   * omitted override here is invisible (the spread supplies the live arm's) and
   * silently re-couples the control's sizing and halting to the live book. A
   * required field makes that omission a compile error.
   */
  accountState: AccountStateProvider;
  /** Shared with the live arm on purpose: the control prices its fills the same way. */
  costModel: CostModel;
  marketData: MarketDataService;
  executionConfig: ExecutionConfig;
  logger: Logger;
}

/** What the composition root needs back: the tick hook, and the control arm's fill poller. */
export interface ControlArmWiring {
  /** Bound onto `TickSteps.controlArm`. Runs on every tick, both cadences. */
  controlArm: ControlArmStep;
  /**
   * The control arm's `ingestFills()` / `reconcile()` surface.
   *
   * The control arm needs its OWN fill-sync loop for the same reason the live
   * arm has one at all: `writeClosedTrade` is reached only from `ingestFills`,
   * so without a poller the control's lots stop dead at `submitted`, no
   * `ClosedTrade` is ever emitted, and #753's comparison report would find the
   * control arm with zero trades — a result indistinguishable from a control
   * that never found a setup. That is the "one missing caller, four silent
   * failures" shape `fill-sync.ts` documents, and it would be re-created here by
   * omission.
   */
  fillSyncExecution: ReturnType<typeof buildExecutionSurface>;
  /** The control arm's startup reconcile surface — same reasoning, at boot. */
  reconcileExecution: ReturnType<typeof buildExecutionSurface>;
  /**
   * The control arm's own book (`deps.store`, `arm: 'control'`), exposed for
   * the reason `executionDeps` is: #1390's held-first tail priority reads
   * `getOpenPositions()` to build the current tick's held set, and the live
   * arm's own store (`ProductionComponents.executionStore`) only ever holds
   * `arm: 'live'` rows (#753's `WHERE arm = ?` scoping). A held set built from
   * the live store alone silently excludes every control-arm lot — the same
   * one-store-per-arm split this field exists everywhere else to respect.
   */
  store: ExecutionSharedStore;
}

/**
 * `control-arm-` prefix, not the `:control` suffix `CONTROL_TRACE_SUFFIX`
 * (axis-vote-decision.ts) uses for tick traces. Harmless today — these two
 * IDs never reach `audit_log` (only tick-runner.ts's traces do) — but if
 * fill-sync/reconcile traces are ever routed into `audit_log`, neither arm's
 * `trace_id` operator (#1319, made arm-dependent by #1594) handles them
 * correctly: a live read's `NOT LIKE '%:control'` would still wrongly include
 * them (they carry no `:control` suffix for it to exclude), and a control
 * read's `LIKE '%:control'` would miss them entirely. See #1331.
 */
export const CONTROL_FILL_SYNC_TRACE_ID = 'control-arm-fill-sync';
export const CONTROL_RECONCILE_TRACE_ID = 'control-arm-reconcile';

export function buildControlArmWiring(deps: ControlArmWiringDeps): ControlArmWiring {
  const relay = new AnalystViewRelay();

  const executionDeps: ExecutionStepDeps = {
    ...deps.execution,
    // `clock` is NOT overridden below (#1348) — deliberately: one wall clock
    // for both arms, not per-arm state. The alert channels are inherited too;
    // each alert carries its own `trace_id` to name the arm that raised it —
    // see those alerts' docs.
    //
    // The two things a shadow arm may not share. See `control-arm.ts`: a second
    // arm placing real orders at ADR-0018 D5's 35%/25% envelope doubles
    // deployment against a £1,000 book, which no ADR authorises.
    broker: deps.broker,
    store: deps.store,
    costModel: deps.costModel,
    marketData: deps.marketData,
    config: deps.executionConfig,
    logger: deps.logger,
    // #1087: an OWN throttle, not the spread-in live arm's. The Map is keyed
    // by `idempotency_key`, and `arm` is itself an input to that key (#753,
    // `computeIdempotencyKey`), so live/control keys never collide even if
    // one instance were shared — this isn't guarding against cross-arm
    // leakage. It's process-scoped state matching the live root's own
    // instance lifetime: this arm gets its own `Execution` built fresh here
    // (`fillSyncExecution` below is distinct from the live root's), so it
    // gets its own throttle too, same as `broker`/`store`/`costModel`/
    // `marketData`/`config` above.
    filledZeroSizeThrottle: new FilledZeroSizeThrottle(),
    // #1550: an OWN throttle, and unlike `filledZeroSizeThrottle` above this
    // one IS guarding against cross-arm leakage. Its key is the bare
    // INSTRUMENT — a venue position no lot explains carries no idempotency key
    // by construction, which is the finding — and both arms scan the same
    // venue, so a shared instance would let whichever arm polled first take
    // the page and leave the other silent for half an hour. The channel is
    // inherited from the spread above and drops the control arm's post on its
    // `page` predicate, so in practice this keeps the LIVE arm's page from
    // being swallowed by the control arm's scan.
    unrecordedVenuePositionThrottle: new UnrecordedVenuePositionThrottle(),
  };

  // Per-arm breaker plumbing, spread into all three stage builders exactly as
  // the live root spreads its own `breakerStateDeps` — one object, so a stage
  // cannot silently end up reading the OTHER arm's book.
  const breakerOverrides = {
    circuitBreakers: deps.circuitBreakers,
    breakerState: deps.breakerState,
    // The control's OWN account scalars. `computeCurrentPortfolioAndBreakers`
    // combines `getOpenPositions()` with `accountState.getAccountState()`, so
    // overriding only the first leaves the control valuing its own positions
    // against the LIVE arm's cash and peak equity — its sizing and its
    // drawdown halt would then track the live arm's fills, which is precisely
    // the independence #753 measures.
    accountState: deps.accountState,
    // Its own per-tick memo. Sharing the live arm's map would not COLLIDE (the
    // control pass runs under a suffixed trace id) but it would fill the live
    // arm's bounded cache with entries the live arm never reads, evicting its
    // own — a per-tick memo that silently stops memoizing.
    portfolioSnapshots: new Map<string, PortfolioSnapshot>(),
    getOpenPositions: () => deps.store.getOpenPositions(),
  };

  const traderSteps = buildTraderSteps({
    ...deps.trader,
    ...breakerOverrides,
    // #753: the control arm's `OrderIntent`s carry `arm: 'control'`, which is a
    // HASH INPUT to the idempotency key. Without it the two arms would produce
    // one key on every bar they agree on and Execution would dedupe the second
    // away — see `computeIdempotencyKey`.
    arm: 'control',
    getExitFillSizes: (keys) => deps.store.getExitFillSizes(keys),
    // #1389: the in-flight flatten guard must ask the CONTROL book. Left to the
    // spread it inherits the live arm's binding, and a live flatten stuck
    // unresolved — a lost ack, or one that never fills and so is never swept —
    // makes the control arm skip its own flatten for that instrument on every
    // later tick and every future close. In a matched control that is every
    // instrument both arms hold, so the falsifier baseline is the arm that
    // carries lots past the bell.
    getUnresolvedFlattens: () => deps.store.getUnresolvedFlattens(),
    // Deliberately NOT `withOnTradeClose`-wrapped upstream: the control arm
    // writes its setup vectors into the shared `cosine_setups` table under its
    // own `control:`-prefixed decision ids, and never labels them. Unlabelled
    // setups are inert — `findNeighbors` returns only closed-outcome rows — so
    // the control reads the SAME precedent pool the live arm does (matching the
    // arms' sizing) while contributing nothing to it (leaving the live arm's
    // learning signal uncontaminated).
  });

  const controlSteps: TickSteps = {
    exitCheck: traderSteps.exitCheck,
    trader: traderSteps.trader,
    // The relay and the axis vote — the ONLY two steps that are not the live
    // arm's own. Neither holds an LLM client, a debate engine or a
    // market-intelligence agent; see `control-arm.ts`.
    analysts: buildControlAnalystsStep(relay),
    debate: buildControlDebateStep(relay),
    risk: buildRiskStep({
      ...deps.risk,
      ...breakerOverrides,
      /**
       * The ONE place the two arms deliberately differ, and #753 is what makes
       * it mandatory rather than optional.
       *
       * The live arm's Risk stage carries the red-team critic (#957,
       * check-pipeline step 7), which is an LLM call on every intent that
       * reaches it. Passing `deps.risk` through verbatim would therefore put a
       * model call squarely inside the control arm's path — measured, and
       * caught, by `production.test.ts`'s zero-LLM-call case. ADR-0014
       * amendment 2's control is *entry by indicator alone, no LLM anywhere in
       * the path*; a control arm that consulted a red-team model would be
       * controlling for nothing.
       *
       * `undefined` is the critic's own documented absent state, not a special
       * case invented here: every control decision keeps the explicit
       * `risk_critic: skipped` reason `evaluate()` already writes when no
       * producer is supplied, on the same branch, with no second code path.
       *
       * The cost is real and accepted: the arms are matched on every
       * MECHANICAL refusal (the caps, the breakers, the concentration and
       * correlation gates — all of which come through `deps.risk` unchanged)
       * but not on a critic veto. A live-arm trade the critic vetoes has no
       * control counterpart. That is the same trade-off the whole ticket is
       * built on — the control measures the system WITHOUT its model layer, and
       * the critic is part of that layer.
       */
      critic: undefined,
    }),
    verdict: buildVerdictStep({
      ...deps.verdict,
      ...breakerOverrides,
      // Verdict's `findByKey` gate must see the CONTROL book: pointed at the
      // live store it would look for a control lot among live rows, never find
      // one, and mis-answer its duplicate check.
      positionStore: deps.store,
    }),
    execution: buildExecutionStep(executionDeps),
    // No `controlArm` member: the control arm does not control for itself.
    // Its absence here is what terminates the recursion, and it is why the
    // member is optional on `TickSteps`.
  };

  return {
    controlArm: buildControlArmStep({
      runner: new SequentialTickRunner(controlSteps),
      relay,
      currentTickStore: new InMemoryCurrentTickStore(),
      logger: deps.logger,
    }),
    fillSyncExecution: buildExecutionSurface(executionDeps, CONTROL_FILL_SYNC_TRACE_ID),
    reconcileExecution: buildExecutionSurface(executionDeps, CONTROL_RECONCILE_TRACE_ID),
    store: deps.store,
  };
}
