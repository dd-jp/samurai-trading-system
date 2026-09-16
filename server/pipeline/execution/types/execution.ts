import type {
  BarWindow,
  IndicatorSpec,
  MarketDataService,
  TradingCalendar,
} from '../../../providers/market-data-service/index.js';
import type { AssetClass, Clock, Logger, OrderState } from '../../../shared/index.js';
import type { CostModel, CostVenue } from '../../../tools/backtest/index.js';
import type { VerdictDecision } from '../../verdict/index.js';
import type { FilledZeroSizeThrottle } from '../filled-zero-size-throttle.js';
import type { FlattenOverfillAlertChannel } from '../flatten-overfill-alert.js';
import type { FlattenReconcileAlertChannel } from '../flatten-reconcile-alert.js';
import type { NonSterlingFeeAlertChannel } from '../non-sterling-fee-alert.js';
import type { ResidualExposureAlertChannel } from '../residual-exposure-alert.js';
import type { UnattributedFlattenFillAlertChannel } from '../unattributed-flatten-fill-alert.js';
import type { UnrecordedVenuePositionAlertChannel } from '../unrecorded-venue-position-alert.js';
import type { UnrecordedVenuePositionThrottle } from '../unrecorded-venue-position-throttle.js';
import type { BrokerAdapter } from './broker.js';
import type {
  FillJournal,
  FillReader,
  FlattenJournal,
  LotJournal,
  LotRetirement,
  PositionReader,
  ResidualMarkers,
  SharedStore,
} from './store.js';

/**
 * Deliberately omits the spec's cadence/retry/throttle knobs: the Simulated
 * adapter raises no transient errors, so `execute()` has nothing to back off from
 */
export interface ExecutionConfig {
  simulated: SimulatedAdapterConfig;
}

/** Config, not hardcoded constants — exact values are tuned in paper trading */
export interface SimulatedAdapterConfig {
  /** Indicator read for `MarketState.volatility` (e.g. ATR at the bar). */
  volatility_indicator: IndicatorSpec;
  /** Bars window aggregated into `MarketState.adv` (the liquidity proxy) */
  adv_window: BarWindow;
  /**
   * Stamped onto every `MarketState` so `CostConfig.venues[venue]` binds.
   * Omitted = plain asset-class pricing; `'saxo'` for the live book (ADR-0015, 2026-08-30).
   */
  venue?: CostVenue;
}

/**
 * The one dependency bag every Execution surface reads from. Each surface's own
 * signature names the `Pick` of this it actually consumes (`SubmitInput` et al.
 * below), so a field only one surface uses can't be read by another without
 * widening that surface's type first.
 */
export interface ExecutionInput {
  /** Cross-cutting correlation ID threaded from the Orchestrator's tick — not business data */
  trace_id: string;
  /** Wall-clock live, simulated T in replay */
  clock: Clock;
  broker: BrokerAdapter;
  /** Execution is the sole writer of positions/fills/closed-trades */
  store: SharedStore;
  /**
   * Read only by `execute()`'s submit-time snapshot (#1001) to price the same way
   * the Simulated adapter prices a fill; the adapter itself holds its own handles, not this
   */
  costModel: CostModel;
  /** Same single reader as `costModel`: the quote and `MarketState` inputs of the submit snapshot */
  marketData: MarketDataService;
  /** `config.simulated` feeds the submit snapshot's `MarketState`, alongside `marketData` */
  config: ExecutionConfig;
  /**
   * Posted when `ingestFills()` fails to re-arm a partially-flattened lot's
   * protective legs (#525). Required, not optional — an omitted channel
   * reintroduces the silent-degradation bug #322 fixed.
   */
  residualExposureAlerts: ResidualExposureAlertChannel;
  /**
   * A flatten's over-fill past its lots' journalled share, always dropped rather
   * than guessed onto a lot (#527, see `redistributeOneFlatten`). Required for the
   * same no-silent-default reason as `residualExposureAlerts`.
   */
  flattenOverfillAlerts: FlattenOverfillAlertChannel;
  /**
   * A `flatten_submissions` row `reconcile()`'s sweep could not settle (#519) —
   * see `reconcileFlatten`. Required for the same no-silent-default reason.
   */
  flattenReconcileAlerts: FlattenReconcileAlertChannel;
  /**
   * A venue-held position no open lot explains (#1550, `findUnrecordedVenuePositions`).
   * Required — this is the one exposure the Risk Manager structurally cannot see,
   * since it computes exposure from the store and the store has no row for it.
   */
  unrecordedVenuePositionAlerts: UnrecordedVenuePositionAlertChannel;
  /**
   * Per-instrument page throttle for the above (#1550). The unrecorded shape
   * re-derives fresh every 15s reconcile pass, so omitting this means ~240
   * pages/hour until someone acts.
   */
  unrecordedVenuePositionThrottle: UnrecordedVenuePositionThrottle;
  /**
   * LOCAL diagnostic trace, distinct from the alert channels above (#573).
   * Required so a dropped wiring is a `tsc` error, not a silent gap. Every call
   * site must go through `shared/safe-log.ts`'s `safeLog`, never `logger.log`
   * directly, since a foreign `Logger` may throw.
   */
  logger: Logger;
  /**
   * Per-lot throttle for `FILLED_WITH_ZERO_SIZE` warnings (#1087). Required for
   * the same no-silent-default reason as the alert channels above.
   */
  filledZeroSizeThrottle: FilledZeroSizeThrottle;
  /**
   * Same calendar pair the Trader uses (#1214), so residual-reflatten never fires
   * a market order into a shut venue. Required — an optional calendar dropped
   * silently would look identical in logs to a venue that's simply shut.
   */
  sessionCalendars: Record<AssetClass, TradingCalendar>;
  /**
   * A fee reported outside book currency (#1465, `warnOnNonSterlingFee`). Optional
   * with deliberately no log-only default — the `safeLog` line already carries
   * this at `error`, so a default would double-log.
   */
  nonSterlingFeeAlerts?: NonSterlingFeeAlertChannel;
  /**
   * A flatten split booked against an already-closed lot (#1506, `redistributeOneFlatten`).
   * Optional for the same reason as `nonSterlingFeeAlerts`.
   */
  unattributedFlattenFillAlerts?: UnattributedFlattenFillAlertChannel;
}

/**
 * `execute()`'s submit path — dedup, write-ahead, bracket/flatten submission,
 * plus the #1001 pricing snapshot. Nothing on this path posts to an alert
 * channel or touches the fill throttle.
 */
export type SubmitInput = Pick<
  ExecutionInput,
  'trace_id' | 'clock' | 'broker' | 'costModel' | 'marketData' | 'config' | 'logger'
> & {
  store: LotJournal & PositionReader & FlattenJournal & ResidualMarkers;
};

/**
 * `reflattenResidual()`'s #1214 remedy for a venue that can't arm entry-less
 * legs — the only surface that reads `sessionCalendars`. Not a top-level surface
 * of its own; reached only through `FillIngestInput`/`ReconcileInput`/`ResidualSweepInput`.
 */
export type ResidualReflattenInput = Pick<
  ExecutionInput,
  'trace_id' | 'broker' | 'sessionCalendars' | 'logger'
> & {
  store: LotJournal & FlattenJournal;
};

/**
 * `ingestFills()`'s fill poll and everything `maybeRearmResidual` re-arms through,
 * including `reflattenResidual` when a venue can't re-arm at all
 */
export type FillIngestInput = Pick<
  ExecutionInput,
  | 'trace_id'
  | 'clock'
  | 'broker'
  | 'residualExposureAlerts'
  | 'flattenOverfillAlerts'
  | 'logger'
  | 'filledZeroSizeThrottle'
  | 'nonSterlingFeeAlerts'
  | 'unattributedFlattenFillAlerts'
> &
  ResidualReflattenInput & {
    store: PositionReader & FillReader & FillJournal & ResidualMarkers;
  };

/**
 * `reconcile()`'s startup/periodic settle, which also runs both sweeps below
 * inside its pass — this is the union of their inputs plus its own `flattenReconcileAlerts`
 */
export type ReconcileInput = Pick<
  ExecutionInput,
  | 'trace_id'
  | 'clock'
  | 'broker'
  | 'residualExposureAlerts'
  | 'flattenReconcileAlerts'
  | 'unrecordedVenuePositionAlerts'
  | 'unrecordedVenuePositionThrottle'
  | 'logger'
> &
  ResidualReflattenInput & {
    store: PositionReader &
      LotJournal &
      FlattenJournal &
      LotRetirement &
      FillReader &
      ResidualMarkers;
  };

/**
 * `sweepResidualProtection()`'s #549 re-arm retry, plus #1214's re-flatten when
 * the venue can't re-arm at all
 */
export type ResidualSweepInput = Pick<
  ExecutionInput,
  'trace_id' | 'clock' | 'broker' | 'residualExposureAlerts' | 'logger'
> &
  ResidualReflattenInput & {
    store: FillReader & ResidualMarkers;
  };

/** `sweepWedgedZeroFillLots()`: no `broker` here is the type-level form of "no venue call, ever" */
export type WedgedSweepInput = Pick<ExecutionInput, 'trace_id' | 'clock' | 'logger'> & {
  store: PositionReader & LotRetirement;
};

export interface ExecutionResult {
  status: 'submitted' | 'deduped' | 'rejected' | 'error';
  idempotency_key: string;
  /** Entry + attached legs; null when nothing reached the broker */
  broker_order_ids: string[] | null;
  /**
   * State after `execute()` returns, usually 'submitted'. Null when this call
   * wrote no record — a dedup, a non-`go`, or an exit whose `submitFlatten`
   * errored — never fabricated.
   */
  order_state: OrderState | null;
  /** Rejection / error / dedup detail */
  reason: string | null;
  timestamp: Date;
}

/**
 * Widened rather than forked into a sibling type to also carry a
 * `flatten_submissions` row's divergence (#519) — the fields already fit
 * (a flatten's `status` maps onto `OrderState` cleanly), so a second type
 * would add nothing
 */

/**
 * Named escalation events behind `ReconcileDivergence.escalation` (#1577/#1585/#1609) —
 * a bare boolean collided distinct outcomes that share the same `action`/`kind`
 * (e.g. two sweep failure modes both `undetermined`/`sweep`) under the same dedup
 * key (`reconcileDedupState`, fill-sync.ts).
 */
export type ReconcileEscalation =
  | 'wedge_cancelled'
  | 'never_confirmed_throttled'
  | 'never_confirmed_cancel_failed'
  | 'never_confirmed_coverage_short'
  | 'sweep_shape_mismatch'
  | 'sweep_abandon_failed'
  | 'residual_sweep_lot_unsettled'
  | 'residual_sweep_size_read_failed'
  | 'residual_sweep_garbage_residual'
  | 'residual_sweep_reflatten_in_flight'
  | 'residual_sweep_reflatten_submitted'
  | 'residual_sweep_rearm_unsupported'
  | 'residual_sweep_rearm_retry_failed';

export interface ReconcileDivergence {
  idempotency_key: string;
  instrument: string;
  /** What the store believed before reconcile ran */
  store_state: OrderState;
  /**
   * What the venue says. Null when it named no state: `rejected` (no such order)
   * or `undetermined` (adapter couldn't answer).
   */
  broker_state: OrderState | null;
  /**
   * `undetermined` leaves the record untouched — never guess, since that could
   * bury a live position or resurrect a dead one (#519). `unrecorded` means the
   * venue holds a position no open lot explains (#429) — the one exposure invisible
   * to Risk's caps until an operator acts.
   */
  action: 'adopted' | 'rejected' | 'undetermined' | 'unrecorded';
  /** Operator-facing detail — the adapter's error on `undetermined` */
  reason: string;
  /**
   * Which escalation produced this row, when one did. Naming the event (rather
   * than a bare `escalated: true`) is what lets `runPoll`'s dedup (fill-sync.ts)
   * tell rows apart that share the same `action`/`kind` but mean different things.
   */
  escalation?: ReconcileEscalation;
  /**
   * Required on every construction site so a future one that forgets is a `tsc`
   * error, not a silent misclassification (#1122). Only `kind: 'bracket'` rows
   * with a non-null `broker_state` ever demote to `info` in `reconcileDivergenceLevel()` —
   * kept distinct from `'sweep'` so that holds by construction.
   */
  kind: 'bracket' | 'flatten' | 'unrecorded' | 'sweep';
}

/**
 * One #549 residual-protection sweep pass's outcome. `divergences` reuses
 * `ReconcileDivergence` — `adopted` means the marker cleared, `undetermined` means it stays.
 */
export interface ResidualProtectionSweepResult {
  checked: number;
  divergences: ReconcileDivergence[];
}

/** What one `reconcile()` pass examined and corrected */
export interface ReconcileReport {
  /**
   * Includes unresolved `flatten_submissions` rows alongside in-flight lots (#519) —
   * otherwise a startup log could read "checked 0" while divergences landed uncounted
   */
  checked: number;
  /** Lots and flatten rows whose store record reconcile wrote to */
  corrected: number;
  /** One entry per lot or flatten row where store and broker disagreed */
  divergences: ReconcileDivergence[];
  /**
   * Terminal, size-0 `open_positions` rows deleted this pass (#1088). Counted
   * separately since it's neither an examined lot nor a corrected divergence.
   */
  swept: number;
  timestamp: Date;
}

/**
 * The primary test seam. Deterministic given the injected adapter + clock +
 * store.
 */
export interface Execution {
  /** Acts only on a `go`; records the submission, does not block until filled */
  execute(verdict: VerdictDecision): Promise<ExecutionResult>;
  /**
   * Advances every live lot on new fills; idempotent. A failure confined to one
   * lot/row (#575) doesn't block the rest — rejects with an `AggregateError`
   * naming what failed. One exception: a failed `markFlattenFillsSwept` alone
   * (#519) does not reject, since the row's unresolved state is its own recovery.
   */
  ingestFills(): Promise<void>;
  /**
   * Settles every in-flight lot and unresolved `flatten_submissions` row against
   * the venue (the tie-break authority) — adopt its state, or mark `rejected`
   * where it never received the order. Run on startup; idempotent.
   */
  reconcile(): Promise<ReconcileReport>;
  /**
   * One pass of the #549 residual-protection sweep. `reconcile()` already runs it
   * at startup; this exists for the within-process cadence after each fill poll
   * (fill-sync.ts). Idempotent and cheap when healthy.
   */
  sweepResidualProtection(): Promise<ResidualProtectionSweepResult>;
}
