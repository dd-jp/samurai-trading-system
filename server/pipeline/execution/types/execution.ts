/**
 * The Execution stage itself (#308): its config, its inputs and results, and
 * the reconcile report. See `broker.ts` for the venue seam underneath and
 * `store.ts` for what it persists through.
 */
import type {
  BarWindow,
  IndicatorSpec,
  MarketDataService,
} from '../../../providers/market-data-service/index.js';
import type { Clock, Logger, OrderState } from '../../../shared/index.js';
import type { CostModel, CostVenue } from '../../../tools/backtest/index.js';
import type { VerdictDecision } from '../../verdict/index.js';
import type { FilledZeroSizeThrottle } from '../filled-zero-size-throttle.js';
import type { FlattenOverfillAlertChannel } from '../flatten-overfill-alert.js';
import type { FlattenReconcileAlertChannel } from '../flatten-reconcile-alert.js';
import type { NonSterlingFeeAlertChannel } from '../non-sterling-fee-alert.js';
import type { ResidualExposureAlertChannel } from '../residual-exposure-alert.js';
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
 * Cadence/retry/throttle knobs from the spec's full `ExecutionConfig` are
 * absent: they belong to polling, reconciliation and resilience, none of
 * which #82 performs. The Simulated adapter raises no transient errors, so
 * there is no backoff for `execute()` to read.
 */
export interface ExecutionConfig {
  /** Market context the Simulated adapter prices fills against. */
  simulated: SimulatedAdapterConfig;
}

/**
 * How the Simulated adapter sources the two `MarketState` fields that aren't
 * a plain mark lookup. Config, not constants — exact values are tuned in
 * paper trading (execution-spec.md "Out of Scope: Exact values").
 */
export interface SimulatedAdapterConfig {
  /** Indicator read for `MarketState.volatility` (e.g. ATR at the bar). */
  volatility_indicator: IndicatorSpec;
  /** Bars window aggregated into `MarketState.adv` (the liquidity proxy). */
  adv_window: BarWindow;
  /**
   * Stamped onto every `MarketState` built from this config so
   * `CostConfig.venues[venue]` binds (#1032 item 2). Omitted = plain
   * asset-class pricing. Set to `'saxo'` where the modelled leg is the live
   * Saxo book (ADR-0015's 2026-08-30 amendment).
   */
  venue?: CostVenue;
}

/**
 * Every dependency any Execution surface reads — the one bag a composition
 * root builds (`buildExecutionStep`/`buildExecutionSurface`,
 * orchestrator/production/direct-bind.ts) and hands to `ExecutionImpl`, which
 * serves all five surfaces off it. Each surface's own signature names the
 * `Pick` of this it actually reads (`SubmitInput` et al. below), so a field
 * only one surface consumes cannot be read by another without widening that
 * surface's type first.
 */
export interface ExecutionInput {
  /** Cross-cutting correlation ID threaded from the Orchestrator's tick — not business data. */
  trace_id: string;
  /** Wall-clock live, simulated T in replay. */
  clock: Clock;
  broker: BrokerAdapter;
  /** Execution is the sole writer of positions/fills/closed-trades. */
  store: SharedStore;
  /**
   * Read only by `execute()`'s submit-time snapshot (#1001, `readSubmitSnapshot`,
   * execute.ts), which prices the modelled cost breakdown the same way the
   * Simulated adapter prices a fill. The adapter itself holds its own handles
   * (`SimulatedBrokerAdapterInput`), not these.
   */
  costModel: CostModel;
  /** Same single reader as `costModel`: the quote and `MarketState` inputs of the submit snapshot. */
  marketData: MarketDataService;
  /** `config.simulated` feeds the submit snapshot's `MarketState`, alongside `marketData`. */
  config: ExecutionConfig;
  /**
   * The #525 fallback — posted only when `ingestFills()` fails to re-arm a
   * partially-flattened lot's protective legs. Required, not optional: an
   * omitted channel is exactly the silent-degradation-by-omission bug #322
   * fixed for the other operator escalations, so every caller (production
   * and test) must say explicitly where this goes rather than have it
   * default away.
   */
  residualExposureAlerts: ResidualExposureAlertChannel;
  /**
   * #527: a genuine over-fill on a flatten's attribution split — the excess
   * past its named lots' journalled share, which is always dropped rather
   * than guessed onto a lot (see `redistributeOneFlatten`, ingest-fills.ts).
   * Required for the same "no silent default" reason `residualExposureAlerts`
   * above is: an omitted channel would make that drop invisible again, which
   * is the exact defect this ticket exists to close.
   */
  flattenOverfillAlerts: FlattenOverfillAlertChannel;
  /**
   * #519: where a `flatten_submissions` row `reconcile()`'s sweep could not
   * settle is escalated — genuine ignorance (the adapter could not answer)
   * or a venue contradiction on an already-acked row (see `reconcileFlatten`,
   * reconcile.ts, for both paths). Required, for the same "no silent default"
   * reason `residualExposureAlerts`/`flattenOverfillAlerts` above are: an
   * unresolved flatten is a lot stuck in genuine ambiguity about whether it
   * is still held, and an omitted channel would make that invisible again.
   */
  flattenReconcileAlerts: FlattenReconcileAlertChannel;
  /**
   * #573's recorded decision: the execution port DOES carry a `Logger`, for
   * a LOCAL diagnostic trace — "what actually failed" — that is distinct
   * from every alert channel above.
   *
   * The three `*AlertChannel` fields are OUTBOUND capabilities the domain
   * already reasons about (broker, store, alerts) and each carries a
   * CREDENTIALS boundary that forbids a caught error's own text in its
   * payload (`ResidualExposureAlert`'s doc). A `Logger` is a different kind
   * of dependency — it has no domain meaning and no such boundary — but the
   * alternative the ticket raised, a typed field on the alert (or a
   * dedicated diagnostic channel per failure kind), was rejected: that adds
   * a channel per NEW failure kind forever, where a `Logger` this module can
   * already reach handles every kind uniformly, including ones with no alert
   * of their own at all (`markFlattenFillsSwept`'s catch, ingest-fills.ts,
   * is exactly this — a best-effort store write with no channel to escalate
   * through, which is why it "resolved quietly" before this ticket).
   *
   * Required, not optional: an omitted dependency dropped at a composition
   * root is this repo's dominant defect class (#322 fixed the same hole for
   * `residualExposureAlerts` et al. above), and making this field required
   * turns a dropped wiring into a `tsc` error at every composition root
   * rather than a silent gap discovered during an unattended soak.
   *
   * `LogEntry.trace_id` needs no new plumbing: `ExecutionInput.trace_id`
   * above is already the per-surface synthetic id
   * (`buildExecutionSurface`'s `FILL_SYNC_TRACE_ID`/`RECONCILE_TRACE_ID`,
   * production/direct-bind.ts) or the per-order `idempotency_key` on the
   * `execute()` path — every call site already has the right trace_id in
   * hand.
   *
   * SAFE INSIDE A CATCH is the hard requirement, not a nicety:
   * `JsonLogger.log` survives a failing sink but still throws in one case —
   * when NO sink is left that could record the failure (#714,
   * orchestrator/logger.ts), and any foreign `Logger` may throw for any
   * reason — so every call site on this
   * field goes through `shared/safe-log.ts`'s `safeLog`/`logCaughtFailure`
   * (the same helper orchestrator/tick-loop.ts's `safeLog` was extracted
   * from, #573) — never `logger.log` directly — so a throwing logger can
   * never turn a handled failure into an unhandled one.
   */
  logger: Logger;
  /**
   * #1087's `FILLED_WITH_ZERO_SIZE` per-lot throttle (filled-zero-size-
   * throttle.ts) — required for the same "no silent default" reason
   * `residualExposureAlerts` et al. above are: an omitted throttle would
   * mean either no warning ever fires (silently, if the caller guarded on
   * its presence) or an unthrottled flood (if it did not) — both are the
   * defect this ticket exists to close, not an acceptable default. One
   * instance per composition root, constructed once and threaded here, not
   * a module-level singleton — see the class doc for why.
   */
  filledZeroSizeThrottle: FilledZeroSizeThrottle;
  /**
   * #1465: where a fill fee reported outside book currency is escalated —
   * `warnOnNonSterlingFee` (ingest-fills.ts) posts here after writing its own
   * `error`-level `safeLog` line. OPTIONAL, unlike `residualExposureAlerts`
   * et al. above, and deliberately with no log-only default: that
   * `safeLog` line already carries this alert's fields at `error`, so a
   * logging implementation behind this port would emit every trip twice —
   * the same reasoning `ThresholdClampAlertChannel`/
   * `TraderDiagnosticAlertChannel` document for their own absence of one.
   * Absent means "no second, audible copy", never "silent": the durable
   * record is the log line and the `fee_currency` column on the booked fill.
   */
  nonSterlingFeeAlerts?: NonSterlingFeeAlertChannel;
}

/**
 * `execute()` (execute.ts): the submit path — dedup, write-ahead, bracket or
 * flatten submission, plus the #1001 submit-time snapshot that reads
 * `marketData`/`costModel`/`config`. A refused flatten marks lots through
 * `markResidualsUnprotected` (store/logger/trace_id); nothing on this path
 * posts to an alert channel or touches the fill throttle.
 *
 * Each surface's `store` names only the roles (types/store.ts) its own file
 * and the helpers it calls read, so a method one surface persists through
 * cannot be reached by another without widening its type here.
 */
export type SubmitInput = Pick<
  ExecutionInput,
  'trace_id' | 'clock' | 'broker' | 'costModel' | 'marketData' | 'config' | 'logger'
> & {
  store: LotJournal & PositionReader & FlattenJournal & ResidualMarkers;
};

/**
 * `ingestFills()` (ingest-fills.ts): the fill poll and everything it re-arms
 * through `maybeRearmResidual` (residual-protection.ts), which is where
 * `residualExposureAlerts` is read.
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
> & {
  store: PositionReader & FillReader & FillJournal & ResidualMarkers;
};

/**
 * `reconcile()` (reconcile.ts): the startup/periodic settle, which also runs
 * both sweeps below inside its pass — so this is the union of their inputs
 * plus its own `flattenReconcileAlerts`. Likewise its `store`: its own
 * `PositionReader & LotJournal & FlattenJournal & LotRetirement`, plus the
 * two sweeps' roles.
 */
export type ReconcileInput = Pick<
  ExecutionInput,
  'trace_id' | 'clock' | 'broker' | 'residualExposureAlerts' | 'flattenReconcileAlerts' | 'logger'
> & {
  store: PositionReader &
    LotJournal &
    FlattenJournal &
    LotRetirement &
    FillReader &
    ResidualMarkers;
};

/** `sweepResidualProtection()` (residual-protection-sweep.ts): the #549 re-arm retry. */
export type ResidualSweepInput = Pick<
  ExecutionInput,
  'trace_id' | 'clock' | 'broker' | 'residualExposureAlerts' | 'logger'
> & {
  store: FillReader & ResidualMarkers;
};

/**
 * `sweepWedgedZeroFillLots()` (wedged-zero-fill-sweep.ts): store evidence
 * only — no `broker` here is the type-level form of that file's "no venue
 * call, ever" rule.
 */
export type WedgedSweepInput = Pick<ExecutionInput, 'trace_id' | 'clock' | 'logger'> & {
  store: PositionReader & LotRetirement;
};

export interface ExecutionResult {
  status: 'submitted' | 'deduped' | 'rejected' | 'error';
  idempotency_key: string;
  /** Entry + attached legs; null when nothing reached the broker. */
  broker_order_ids: string[] | null;
  /**
   * State of the lot after `execute()` returns — usually 'submitted'. Null
   * when this call wrote no record and so has no state to report: a dedup
   * (the prior call owns the lot), a non-`go`, or an exit whose
   * `submitFlatten` call errored (an exit writes no record either way, so
   * there is no 'pending' to fall back on the way the bracket path's error
   * branch does). Reporting a state here would be fabricating one.
   */
  order_state: OrderState | null;
  /** Rejection / error / dedup detail. */
  reason: string | null;
  timestamp: Date;
}

/**
 * What reconcile did about one in-flight lot whose store state did not match
 * the broker's — the structured record of the spec's "log/alert the
 * divergence" (#86). Emitted only on divergence: a lot the broker agrees
 * with produces no entry.
 *
 * **WIDENED, not a sibling type, to also carry a `flatten_submissions` row's
 * divergence (#519's shape decision).** Reused verbatim rather than a second
 * `FlattenReconcileDivergence` type: the fields already fit — a flatten row
 * has its own `idempotency_key`/`instrument`, its `status` maps onto
 * `OrderState` cleanly (`'submitting'` -> `'pending'`, the same "written
 * ahead, not yet confirmed" meaning `pending` already carries for a bracket;
 * `'submitted'` passes through as-is), and the same four `action` values
 * mean the same thing for either row shape (see below). A sibling type would
 * fork both of `ReconcileReport.divergences`' consumers
 * (`orchestrator/fill-sync.ts`'s per-divergence log, and `reconcile()`'s own
 * `corrected` tally) for zero new information — each already treats `action`
 * generically. **This no longer holds for `fill-sync.ts`'s per-divergence
 * log** (#1122 review round 3): `reconcileDivergenceLevel()` branches on
 * `kind` to decide whether a bracket adopt demotes to `debug` (see `kind`
 * below), so that consumer now IS kind-aware — `reconcile()`'s own
 * `corrected` tally is the one that stays generic. The `idempotency_key`
 * heuristic below is superseded by `kind` wherever `kind` is present; it
 * remains true only as a fallback for code written before `kind` existed.
 * A reader that needs to tell rows apart can: a flatten's `idempotency_key`
 * never matches an `open_positions` row (exits write no `OpenPosition` —
 * `OrderIntent`'s own "exits close a lot; they never create one"), the same
 * distinguishing convention `unrecorded`'s `idempotency_key: ''` already
 * uses below.
 */
export interface ReconcileDivergence {
  idempotency_key: string;
  instrument: string;
  /** What the store believed before reconcile ran. */
  store_state: OrderState;
  /**
   * What the venue says. Null in the two cases where the venue named no
   * state: `rejected` (the venue has no such order) and `undetermined` (the
   * adapter could not answer).
   */
  broker_state: OrderState | null;
  /**
   * - `adopted` — the venue has the order in a different state; the store now
   *   matches it. For a flatten row, this also covers a fresher (but still
   *   non-terminal) venue answer on an already-`'submitted'` row — see
   *   `reconcileFlatten` (reconcile.ts).
   * - `rejected` — the venue authoritatively has no such order, so the
   *   write-ahead never landed and the lot is marked `rejected` (or, for a
   *   flatten still at `'submitting'`, the journal row is resolved `'error'`
   *   the same way).
   * - `undetermined` — the adapter could not answer, OR (flatten-specific)
   *   answered null for a row the venue had ALREADY acked once. The record
   *   is left EXACTLY as it was and reported for operator attention (also
   *   posted to `flattenReconcileAlerts` for a flatten row — #519): guessing
   *   here either buries a live position or resurrects a dead one.
   * - `unrecorded` — the VENUE holds a position the store has no open lot for
   *   (#429): a write-ahead that died before persisting, or an order placed by
   *   hand. Nothing is written; see `reconcile()` for why adoption is not
   *   automatic. Until an operator acts, this exposure is invisible to Risk's
   *   caps, which is the whole reason it is reported.
   */
  action: 'adopted' | 'rejected' | 'undetermined' | 'unrecorded';
  /** Operator-facing detail — the adapter's error on `undetermined`. */
  reason: string;
  /**
   * `'bracket'` for a `reconcileLot` row, keyed to an `OpenPosition`.
   * `'flatten'` for a `reconcileFlatten` row. `'unrecorded'` for
   * `findUnrecordedVenuePositions`'s rows — a venue position the store never
   * wrote. `'sweep'` for `residual-protection-sweep.ts`'s (#549) and
   * `wedged-zero-fill-sweep.ts`'s (#1186) rows — DIFFERENT reconciliation
   * passes that happen to read (and, for #1186, also write) the same
   * `OpenPosition` row shape `reconcileLot` does. Sweep rows DO reach
   * `reconcileDivergenceLevel()`: `reconcile()` merges them into
   * `report.divergences` (reconcile.ts), and both `runPoll` and
   * `runStartupReconcile` (fill-sync.ts) map every entry of that array
   * through it. What never happens is a sweep row *demoting* — the
   * predicate requires `kind === 'bracket'` AND a non-null `broker_state`,
   * and a sweep row is `kind: 'sweep'` with `broker_state: null`, so it
   * always falls to the `info` branch. Kept distinct from `'bracket'` so
   * that stays true by construction rather than by every sweep site
   * happening to leave `broker_state` unset (#1122 review round 1, doc
   * corrected review round 3).
   * Required, not optional: every construction site must declare one, so a
   * future site that forgets is a `tsc` error, not a silently-missing
   * classification (#1122 review round 1).
   *
   * Needed by #1122's noise reduction: only a bracket lot's `adopted` lands
   * on the `OpenPosition` that `FilledZeroSizeThrottle`
   * (filled-zero-size-throttle.ts, #1087) watches, so only that case has an
   * independent backstop a consumer can safely quiet against — a flatten
   * adopt writes no such row, so there is nothing else watching it.
   */
  kind: 'bracket' | 'flatten' | 'unrecorded' | 'sweep';
}

/**
 * One #549 residual-protection sweep pass's outcome — see
 * residual-protection-sweep.ts for the mechanism. `checked` counts markers
 * examined (the same meaning `ReconcileReport.checked` gives its rows);
 * `divergences` reuses `ReconcileDivergence` for the widening reason that
 * type's own doc records — `adopted` means protection was confirmed and the
 * marker cleared, `undetermined` means it could not be and the marker stays.
 */
export interface ResidualProtectionSweepResult {
  checked: number;
  divergences: ReconcileDivergence[];
}

/** What one `reconcile()` pass examined and corrected. */
export interface ReconcileReport {
  /**
   * In-flight (`pending`/`submitted`) lots PLUS unresolved `flatten_submissions`
   * rows (`SharedStore.getUnresolvedFlattens()`) examined this pass — both
   * counted here (#519's `checked`/`corrected` decision) rather than only
   * the former: a startup log reading "checked 0, corrected 3" because three
   * flatten divergences landed uncounted would misstate what the pass
   * actually visited.
   */
  checked: number;
  /** Lots and flatten rows whose store record reconcile wrote to. */
  corrected: number;
  /** One entry per lot or flatten row where store and broker disagreed. */
  divergences: ReconcileDivergence[];
  /**
   * #1088: terminal, size-0 `open_positions` rows (`rejected`/`cancelled`/
   * `expired`, old enough — see `sweepTerminalPositions`, types/store.ts)
   * deleted this pass. Counted separately from `checked`/`corrected`: a
   * sweep is neither an in-flight lot examined nor a store/broker
   * divergence corrected, and folding it into either would misstate what
   * those two already mean (see `ReconcileReport.checked`'s own doc).
   */
  swept: number;
  timestamp: Date;
}

/**
 * The primary test seam. Deterministic given the injected adapter + clock +
 * store.
 */
export interface Execution {
  /** Acts only on a `go`; records the submission, does not block until filled. */
  execute(verdict: VerdictDecision): Promise<ExecutionResult>;
  /**
   * Advance every live lot on the fills that have landed since it opened:
   * persist each new `Fill`, resize the protective legs to cumulative filled
   * quantity, and emit a `ClosedTrade` on round-trip-to-flat. Idempotent —
   * polling it twice ingests each fill once and closes each lot once.
   *
   * A failure confined to one unit of work — one flatten's journal row, one
   * lot's advance — is contained to that unit (#575): every OTHER lot in the
   * poll is still advanced, and the pass then rejects with an
   * `AggregateError` naming the records it could not resolve. So a rejection
   * here means "some of this poll did not land", never "none of it did", and
   * the caller's job is to log it and poll again rather than to stop.
   *
   * One exception (#519/#526): a failure to mark a flatten's fills swept
   * (`SharedStore.markFlattenFillsSwept`, the bound on `reconcile()`'s own
   * rescan) does NOT reject this promise when it is the only thing that
   * failed — every lot still advanced correctly, and the row's own
   * unresolved state is its designed recovery, not data this call lost.
   */
  ingestFills(): Promise<void>;
  /**
   * Settle every in-flight (`pending`/`submitted`) lot against the venue,
   * which is the tie-break authority: adopt its state, or mark the lot
   * `rejected` where it authoritatively never received the order. This is
   * what makes a crash between write-ahead and broker-ack recoverable.
   *
   * Also settles every unresolved `flatten_submissions` row the same way
   * (#519, #526) — see `reconcileFlatten` (reconcile.ts) — which is
   * what re-populates a live adapter's process-local flatten-sweep worklist
   * (`AlpacaBrokerAdapter.flattens`) across a restart, via
   * `BrokerAdapter.resumeFlatten`'s side effect.
   *
   * Run on startup. Idempotent — a second pass over a store reconcile has
   * already corrected finds nothing left to disagree about. No recurring
   * cadence exists in this codebase today (orchestrator/fill-sync.ts's file
   * doc); this method behaves correctly under one if it is ever added, but
   * none is added by #519/#526 — see reconcile.ts's file doc.
   */
  reconcile(): Promise<ReconcileReport>;
  /**
   * One pass of the #549 residual-protection sweep on its own — see
   * residual-protection-sweep.ts. `reconcile()` above already runs it as
   * part of its pass (so startup is covered without a second wiring); this
   * standalone surface exists for the WITHIN-PROCESS cadence: `startFillSync`
   * (orchestrator/fill-sync.ts) calls it after every fill poll, because no
   * recurring `reconcile()` schedule exists and a re-arm failure the process
   * survives must not wait for the next restart to be retried. Idempotent
   * and cheap when healthy — an empty marker worklist makes no broker call.
   */
  sweepResidualProtection(): Promise<ResidualProtectionSweepResult>;
}
