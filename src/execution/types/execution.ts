/**
 * The Execution stage itself (#308): its config, its inputs and results, and
 * the reconcile report. See `broker.ts` for the venue seam underneath and
 * `store.ts` for what it persists through.
 */
import type { CostModel } from '../../cost-model-backtest/index.js';
import type {
  BarWindow,
  IndicatorSpec,
  MarketDataService,
} from '../../market-data-service/index.js';
import type { Clock, OrderState } from '../../shared/index.js';
import type { VerdictDecision } from '../../verdict/index.js';
import type { FlattenOverfillAlertChannel } from '../flatten-overfill-alert.js';
import type { FlattenReconcileAlertChannel } from '../flatten-reconcile-alert.js';
import type { ResidualExposureAlertChannel } from '../residual-exposure-alert.js';
import type { BrokerAdapter } from './broker.js';
import type { SharedStore } from './store.js';

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
}

/** Injected dependencies (constructor / DI). */
export interface ExecutionInput {
  /** Cross-cutting correlation ID threaded from the Orchestrator's tick — not business data. */
  trace_id: string;
  /** Wall-clock live, simulated T in replay. */
  clock: Clock;
  broker: BrokerAdapter;
  /** Execution is the sole writer of positions/fills/closed-trades. */
  store: SharedStore;
  /** Consumed by the Simulated adapter only — real adapters never call it. */
  costModel: CostModel;
  /** Consumed by the Simulated adapter to assemble `MarketState`. */
  marketData: MarketDataService;
  config: ExecutionConfig;
  mode: 'live' | 'paper' | 'backtest';
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
   * or a venue contradiction on an already-acked row (see `resolveUnresolvedFlattens`,
   * reconcile.ts, for both paths). Required, for the same "no silent default"
   * reason `residualExposureAlerts`/`flattenOverfillAlerts` above are: an
   * unresolved flatten is a lot stuck in genuine ambiguity about whether it
   * is still held, and an omitted channel would make that invisible again.
   */
  flattenReconcileAlerts: FlattenReconcileAlertChannel;
}

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
 * generically and neither branches on WHICH kind of record it is. A reader
 * that needs to tell them apart can: a flatten's `idempotency_key` never
 * matches an `open_positions` row (exits write no `OpenPosition` —
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
   *   `resolveUnresolvedFlattens` (reconcile.ts).
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
   * (#519, #526) — see `resolveUnresolvedFlattens` (reconcile.ts) — which is
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
}
