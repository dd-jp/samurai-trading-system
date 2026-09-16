/**
 * The Feedback Loop stage's own surface (#308): the daily cycle's inputs and
 * results, the trade-close hook, and the port itself. See `tuning.ts` for the
 * dials it moves and `metrics.ts` for what it measures.
 */
import type {
  Clock,
  ClosedTradeStore,
  DebateLogStore,
  SetupStore,
  TuningStore,
} from '../../../shared/index.js';
import type {
  AdjustmentLog,
  FeedbackConfig,
  LoosenNotificationChannel,
  TuningProposal,
} from './tuning.js';

/**
 * The subset of the spec's `FeedbackInput` that `runDailyCycle` actually
 * consumes. `portfolio` (PortfolioView) is absent because it feeds
 * `computeMetrics` (#93), not attribution; `store` is split into the two
 * narrow ports the cycle needs rather than one god-object `SharedStore`.
 */
export interface DailyCycleInput {
  /** Wall-clock live, simulated T in replay — the cycle reads time only through this */
  clock: Clock;
  /** Outcomes to attribute */
  trades: ClosedTradeStore;
  /** FL's system-of-record for per-analyst attribution, joined by `debate_id` */
  debate_log: DebateLogStore;
  /** The three dials, read and written */
  tuning: TuningStore;
  /** Where every applied move is recorded */
  adjustments: AdjustmentLog;
  config: FeedbackConfig;
  /**
   * Where an APPLIED risk-threshold loosening is announced. Not a gate: the
   * cycle does not wait on it and does not read anything back.
   */
  loosen_notices: LoosenNotificationChannel;
  /** Param/threshold moves requested this cycle. Weights are not proposed — they are attributed. */
  proposals: TuningProposal[];
  /*
   * `mode: 'live' | 'paper' | 'backtest'` was removed by #736. It existed for
   * one expression — `const gate = isThreshold && mode !== 'backtest'`, which
   * auto-applied a loosening in replay and queued it for a human in paper and
   * live. ADR-0013 Decision 2 removed the gate, which left `mode` read by
   * nothing; a field carried "for completeness" that no code consults is the
   * same shape of lie the gate was. All three modes now run one path. Left as
   * a note so a profile that still passes `mode` fails to compile rather than
   * setting a knob nothing reads.
   */
}

/** Shape frozen by feedback-loop-spec.md ("Key Interfaces") */
export interface DailyCycleResult {
  /** Per `analyst_id`, bounded */
  weight_updates: Record<string, { from: number; to: number }>;
  /**
   * Strategy params AND risk thresholds, keyed by name — every one of them
   * WRITTEN. Since #736 an applied loosening appears here with
   * `direction: 'loosen'`; the old sibling field `loosen_pending_approval`
   * is gone, because nothing is pending and the queue it named never drained.
   */
  param_updates: Record<string, { from: number; to: number; direction: 'tighten' | 'loosen' }>;
  /** True if the cycle wrote at least one dial */
  applied: boolean;
}

/**
 * The subset of the spec's `FeedbackInput` that `onTradeClose` actually
 * consumes: just the setup store it labels. Narrower than `DailyCycleInput`
 * for the same reason that one is narrower than the spec's `FeedbackInput` —
 * this event-driven path touches none of the daily cycle's dials/log/config.
 */
export interface OnTradeCloseInput {
  /** The cosine setup store FL owns and labels on trade close */
  setup_store: SetupStore;
}
