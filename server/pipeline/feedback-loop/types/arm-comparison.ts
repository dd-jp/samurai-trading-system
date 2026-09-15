/**
 * The matched-control comparison, as the Feedback Loop's own measurement
 * (#971, under #636 and #913).
 *
 * #636 put the falsifier-arm-2 comparison in FL rather than in a reporting tool
 * of its own: it is "additional columns in the Feedback Loop's existing
 * daily/weekly Metrics & Revalidation suite", with no new scheduling primitive.
 * #913 then asked for BOTH surfaces — an alert on divergence over the existing
 * trade channel, and a dashboard panel — which is what these ports carry.
 *
 * The derivation itself is NOT here and is not reimplemented: `buildArmComparison`
 * (pipeline/control-arm/arm-comparison.ts) already computes both arms' return and
 * drawdown off one window, and its `ArmPerformance.max_drawdown_pct` is a REQUIRED
 * field precisely so that a return-only view of an arm cannot be constructed. That
 * type discipline is `docs/research/12-edge-hypothesis-critique.md` D4 made
 * structural, and every shape below preserves it by carrying whole
 * `ArmPerformance` values rather than picking columns off them.
 */
import type { Clock } from '../../../shared/index.js';
import type {
  ArmComparison,
  ArmPerformance,
  ArmRefusedPassCounts,
  ClosedTradeWindow,
  ExitClassDropCounts,
} from '../../control-arm/index.js';

/**
 * Both arms' closed trades over ONE window, in one query — the property doc 12
 * gate 4 makes a correctness condition (two arms measured over different windows
 * are not a comparison).
 *
 * A port rather than a direct dependency on `SqliteArmComparisonSource` for the
 * reason every other FL input is one: the composition root injects the real
 * reader (which selects `arm` rather than filtering on it, so the single window
 * is structural), and tests inject a fake. It is deliberately NOT
 * `DailyCycleInput.trades` — that store is scoped to `arm = 'live'` so the loop
 * never tunes on control outcomes, and a reader that returns both arms is a
 * different question with a different answer.
 */
export interface ArmComparisonSource {
  /**
   * The window's trades AND what the shared-cost-basis exclusion removed from
   * it (#1546), together — one read, because they are two readings of the same
   * rows and a source that could answer them separately could answer them over
   * different windows.
   */
  getClosedTradeWindowBetween(from: Date, to: Date): ClosedTradeWindow;
  /**
   * Passes each arm refused over the SAME window (#1099) — a second read
   * against `trader_log`, because a refusal writes no `closed_trades` row and
   * is therefore invisible to the query above.
   *
   * On the port rather than only on the SQLite class so the cycle cannot be
   * wired to a source that has no refusal reading: the count is a required
   * field on `ArmPerformance`, and a fake that could omit the method would
   * force the cycle to invent a zero.
   */
  getRefusedPassCountsBetween(from: Date, to: Date): ArmRefusedPassCounts;
}

/**
 * When the gap between the arms is worth waking a human for.
 *
 * Config rather than constants in the check for `KillThresholds`' reason: the
 * numbers are the operator's, and the defaults are stated (with their
 * derivation) at `DEFAULT_ARM_DIVERGENCE_THRESHOLDS`.
 */
export interface ArmDivergenceThresholds {
  /**
   * How far ahead of the live arm the control must be, in return over the
   * window, before the gap counts. A fraction of the basis, matching
   * `ArmPerformance.return_pct`.
   */
  min_return_gap_pct: number;
  /**
   * Closed trades EACH arm must have before the comparison is allowed to fire
   * at all. A guard, not a power calculation — see its default's doc.
   */
  min_trades_per_arm: number;
}

/** Whether this cycle's comparison crossed the divergence line, and why. */
export interface ArmDivergenceVerdict {
  diverged: boolean;
  /** Operator-facing sentence naming both columns. `null` exactly when `diverged` is false. */
  reason: string | null;
  /**
   * The `thresholds.min_trades_per_arm` this verdict was actually evaluated
   * against (#982) — carried on every branch of `evaluateArmDivergence`, so a
   * `diverged: false` verdict can be read against the floor that produced it
   * rather than against whatever `MIN_TRADES_PER_ARM_FOR_DIVERGENCE` happens to
   * be when the row is later read back.
   */
  min_trades_per_arm: number;
}

/** One cycle's comparison, as computed, evaluated and persisted. */
export interface ArmComparisonSample {
  /** The FL cycle instant, read through the injected `Clock`. */
  computed_at: Date;
  comparison: ArmComparison;
  divergence: ArmDivergenceVerdict;
}

/**
 * What `arm_comparison_samples` can actually give back — every column migration
 * 0034/0035/0057/0065 defines, and nothing else.
 *
 * `refused_pass_count` (#1099) has a column since migration 0057 (#1483), but
 * a NULLABLE one: every row written before that migration was computed before
 * the concept of a refused pass existed, and there is no `trader_log` join
 * this table ever ran to recover the count after the fact for those rows. This
 * field stays required (unlike `ArmPerformance`, which forbids optionality on
 * it outright) so a caller cannot forget to handle the historical case, but its
 * value narrows to `number | null` rather than being omitted the way it was
 * pre-0057 — `null` means "computed before this column existed", never "zero
 * refusals". A fabricated `0` here would assert "no refusals in this window"
 * on every historical row, reproducing on the durable surface the exact
 * silence #1099/#1483 exist to break.
 *
 * `append` always writes a real, non-null count on both arms — the value the
 * Feedback Loop passes in is a required `number` on `ArmPerformance` itself,
 * so a write can never itself be the source of a NULL. Only pre-0057 rows read
 * back NULL.
 *
 * `cost_basis_drops` (#1546) has a column since migration 0066 and reads back
 * the same way, for the same reason: a row computed before it was written by a
 * cycle that never counted the per-class exclusion, and there is no after-the-
 * fact recovery — the `closed_trades` rows a historical window covered are
 * still there, but re-counting them today would answer a different question
 * (today's filter over yesterday's window) and present it as what FL saw.
 * `null` means "computed before this column existed"; all-zero counts mean "FL
 * counted, and nothing was excluded".
 */
export type PersistedArmPerformance = Omit<
  ArmPerformance,
  'refused_pass_count' | 'cost_basis_drops'
> & {
  refused_pass_count: number | null;
  cost_basis_drops: ExitClassDropCounts | null;
};

export interface PersistedArmComparison extends Omit<ArmComparison, 'live' | 'control'> {
  live: PersistedArmPerformance;
  control: PersistedArmPerformance;
}

export interface PersistedArmComparisonSample extends Omit<ArmComparisonSample, 'comparison'> {
  comparison: PersistedArmComparison;
}

/**
 * Where each cycle's sample is written, and read back from.
 *
 * The dashboard panel (#913 surface 2) reads FL's persisted samples rather than
 * recomputing the comparison at snapshot time: recomputing would move the
 * computation out of FL, which is the one thing #636 decided, and would show a
 * number FL never saw and never alerted on. It also gives the panel a trend
 * across cycles, which a single recompute cannot.
 */
export interface ArmComparisonSampleStore {
  append(sample: ArmComparisonSample): void;
  /** Most-recently-computed first. Empty means no cycle has computed one yet. */
  getRecent(limit: number, asOf: Date): PersistedArmComparisonSample[];
}

/**
 * One divergence escalation. Carries the WHOLE comparison, not the gap: an
 * operator reading this on a phone must see both arms' return and drawdown
 * together, for the same D4 reason `formatArmComparison` prints them on one row.
 */
export interface ArmDivergenceAlert {
  comparison: ArmComparison;
  /** `ArmDivergenceVerdict.reason`, non-null by construction at the post site. */
  reason: string;
  reported_at: Date;
}

/**
 * Fire-and-forget human alert on arm divergence — the existing trade channel
 * (#913), a slot of its own on `AlertChannelSlots` rather than a reuse of
 * `BreachAlertChannel`.
 *
 * Deliberately NOT `BreachAlertChannel`, on two counts. Its formatter states
 * "KILL-THRESHOLD BREACH … every risk threshold has been defensively
 * auto-tightened", neither of which is true here; and routing divergence through
 * `MetricsReport.breaches` would trip `computeMetrics`' `autoTighten`, so the
 * control arm out-performing the debate arm would defensively tighten every risk
 * threshold — a move that changes the LIVE arm's sizing and not the control's,
 * degrading the very matching this comparison depends on.
 */
export interface ArmDivergenceAlertChannel {
  postArmDivergenceAlert(alert: ArmDivergenceAlert): void;
}

/** Everything `runArmComparisonCycle` consumes. */
export interface ArmComparisonCycleInput {
  /** Wall-clock live, simulated T in replay — read only through this. */
  clock: Clock;
  trades: ArmComparisonSource;
  samples: ArmComparisonSampleStore;
  alerts: ArmDivergenceAlertChannel;
  /**
   * The denominator BOTH arms are divided by — the declared book in the
   * account's currency (`LIVE_BOOK_SIZING_USD` since #1180, matching the
   * broker-reported `realized_pnl_net` above it), never live equity, which is a
   * per-arm quantity and would make the two `return_pct` figures incomparable.
   */
  basis: number;
  /** How far back the comparison window reaches from `clock.now()`. */
  window_ms: number;
  thresholds: ArmDivergenceThresholds;
}
