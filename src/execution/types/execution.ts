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
}

export interface ExecutionResult {
  status: 'submitted' | 'deduped' | 'rejected' | 'error';
  idempotency_key: string;
  /** Entry + attached legs; null when nothing reached the broker. */
  broker_order_ids: string[] | null;
  /**
   * State of the lot after `execute()` returns — usually 'submitted'. Null
   * when this call wrote no record and so has no state to report: a dedup
   * (the prior call owns the lot), a refused exit, or a non-`go`. Reporting
   * a state here would be fabricating one.
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
   *   matches it.
   * - `rejected` — the venue authoritatively has no such order, so the
   *   write-ahead never landed and the lot is marked `rejected`.
   * - `undetermined` — the adapter could not answer. The record is left
   *   EXACTLY as it was and reported for operator attention: guessing here
   *   either buries a live position or resurrects a dead one.
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
  /** In-flight (`pending`/`submitted`) lots examined this pass. */
  checked: number;
  /** Lots whose store record reconcile wrote to. */
  corrected: number;
  /** One entry per lot where store and broker disagreed. */
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
   */
  ingestFills(): Promise<void>;
  /**
   * Settle every in-flight (`pending`/`submitted`) lot against the venue,
   * which is the tie-break authority: adopt its state, or mark the lot
   * `rejected` where it authoritatively never received the order. This is
   * what makes a crash between write-ahead and broker-ack recoverable.
   *
   * Run on startup. Idempotent — a second pass over a store reconcile has
   * already corrected finds nothing left to disagree about.
   */
  reconcile(): Promise<ReconcileReport>;
}
