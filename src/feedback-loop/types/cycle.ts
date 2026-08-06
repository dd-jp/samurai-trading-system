/**
 * The Feedback Loop stage's own surface (#308): the daily cycle's inputs and
 * results, the trade-close hook, and the port itself. See `tuning.ts` for the
 * dials it moves and `metrics.ts` for what it measures.
 */
import type {
  Clock,
  ClosedTrade,
  ClosedTradeStore,
  DebateLogStore,
  SetupStore,
  TuningStore,
} from '../../shared/index.js';
import type {
  AdjustmentLog,
  FeedbackConfig,
  LoosenApprovalChannel,
  TuningProposal,
} from './tuning.js';

/**
 * The subset of the spec's `FeedbackInput` that `runDailyCycle` actually
 * consumes. `portfolio` (PortfolioView) is absent because it feeds
 * `computeMetrics` (#93), not attribution; `store` is split into the two
 * narrow ports the cycle needs rather than one god-object `SharedStore`.
 */
export interface DailyCycleInput {
  /** Wall-clock live, simulated T in replay — the cycle reads time only through this. */
  clock: Clock;
  /** Outcomes to attribute. */
  trades: ClosedTradeStore;
  /** FL's system-of-record for per-analyst attribution, joined by `debate_id`. */
  debate_log: DebateLogStore;
  /** The three dials, read and written. */
  tuning: TuningStore;
  /** Where every applied move is recorded. */
  adjustments: AdjustmentLog;
  config: FeedbackConfig;
  approvals: LoosenApprovalChannel;
  /** Param/threshold moves requested this cycle. Weights are not proposed — they are attributed. */
  proposals: TuningProposal[];
  /**
   * Backtest auto-handles loosening approvals (like Verdict's HITL bypass)
   * and records them, so a replay exercises the same code path as live.
   * Paper takes the same gated approval path as live.
   */
  mode: 'live' | 'paper' | 'backtest';
}

/** Shape frozen by feedback-loop-spec.md ("Key Interfaces"). */
export interface DailyCycleResult {
  /** Per `analyst_id`, bounded. */
  weight_updates: Record<string, { from: number; to: number }>;
  /** Strategy params AND risk thresholds, keyed by name. */
  param_updates: Record<string, { from: number; to: number; direction: 'tighten' | 'loosen' }>;
  /** Risk-threshold loosenings awaiting human OK — proposed, NOT written. */
  loosen_pending_approval: string[];
  /** True if the cycle wrote at least one dial. */
  applied: boolean;
}

/**
 * The subset of the spec's `FeedbackInput` that `onTradeClose` actually
 * consumes: just the setup store it labels. Narrower than `DailyCycleInput`
 * for the same reason that one is narrower than the spec's `FeedbackInput` —
 * this event-driven path touches none of the daily cycle's dials/log/config.
 */
export interface OnTradeCloseInput {
  /** The cosine setup store FL owns and labels on trade close. */
  setup_store: SetupStore;
}

/** Single test seam. Deterministic given its clock-scoped inputs. */
export interface FeedbackLoop {
  runDailyCycle(input: DailyCycleInput): DailyCycleResult;
  /**
   * Event-driven R-labelling of the setup store (#92). `trace_id` is the
   * correlation id of the tick that produced this trade close (spec's Key
   * Interfaces note: this is the one FL entry point tied to a single trace,
   * unlike the daily-batch methods) — threaded for future audit-log wiring,
   * not consumed by the labelling logic itself.
   */
  onTradeClose(trade: ClosedTrade, trace_id: string, input: OnTradeCloseInput): void;
}
