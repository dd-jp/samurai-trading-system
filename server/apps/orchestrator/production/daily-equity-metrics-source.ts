/**
 * The real `DailyMetricsSource` (#345) — the first thing in this repo that can
 * actually produce the `MetricsSuite` `computeMetrics` evaluates.
 *
 * `DailyMetricsSource`'s own doc records why it shipped as a supplied port: the
 * validation library needs a `ReturnSeries` of evenly spaced periodic EQUITY
 * returns, and nothing persisted one. `daily_equity` (migration 0011) does now,
 * so this class derives the series from it rather than asking the operator for
 * a number nobody can compute.
 *
 * ## The gate is the substance of this class
 *
 * Returning a suite is not free. A breach does not merely report — `autoTighten`
 * WRITES every risk threshold toward its extreme and appends to the
 * `AdjustmentLog`. So the interesting behaviour here is the refusal: below
 * `MIN_RETURN_OBSERVATIONS` this returns `undefined`, which the port already
 * defines as the first-class "no suite this cycle" answer, and the orchestrator
 * already announces at `warn`.
 *
 * That split — capture from day one, evaluate only when the sample can carry a
 * conclusion — is deliberate and asymmetric. Equity not recorded on the day is
 * unrecoverable, so sampling must start immediately; a Sharpe computed too early
 * is worse than no Sharpe, because it moves real risk configuration. Hence a
 * sampler with no threshold and a reader with a strict one.
 */

import type {
  DailyMetricsSample,
  DailyMetricsSource,
  RevalidationSnapshot,
} from '../../../pipeline/feedback-loop/index.js';
import type { Clock, ClosedTrade } from '../../../shared/index.js';
import { SystemClock } from '../../../shared/index.js';
import type { ReturnSeries, Stage2Selection, TradeSeries } from '../../../tools/backtest/index.js';
import { computeMetrics } from '../../../tools/backtest/index.js';
import type {
  DailyEquityObservation,
  SqliteDailyEquityStore,
} from '../sqlite-daily-equity-store.js';
import type { Logger } from '../types.js';

/** Consecutive portfolio sessions are UTC midnights — exactly this far apart */
const MS_PER_DAY = 24 * 60 * 60 * 1_000;

/**
 * 365, not 252: the series is anchored to the portfolio's UTC-day boundary
 * (migration 0011), which advances every calendar day including weekends,
 * because the account holds crypto that trades through them. 252 is the trading-
 * day count and would over-annualize a series that genuinely has 365 bars a
 * year. `ReturnSeries.periodsPerYear` is explicit precisely so this cannot be
 * guessed wrong silently.
 */
const PERIODS_PER_YEAR = 365;

/**
 * The minimum number of RETURNS (not observations — n observations yield n−1
 * returns) below which the suite is not computed at all.
 *
 * ## Why 60, stated honestly
 *
 * For an IID sample the standard error of a Sharpe estimate is
 * (Lo 2002, "The Statistics of Sharpe Ratios", eq. 8; Jobson & Korkie 1981):
 *
 *     SE(Ŝ_period) ≈ sqrt( (1 + Ŝ_period² / 2) / n )
 *
 * The suite reports an ANNUALIZED Sharpe, S_ann = S_period·√P. Substituting,
 * and writing T = n/P for the sample length in years:
 *
 *     SE(S_ann) ≈ sqrt( 1 + S_ann²/(2P) ) / √T   ≈  1/√T  for small S_ann
 *
 * The load-bearing consequence: **precision is governed by the number of YEARS,
 * not the number of observations.** Sampling more often does not buy a tighter
 * Sharpe. At P = 365 that gives, for a strategy whose true annualized Sharpe is
 * near zero:
 *
 *     n =  10  (T = 0.027 yr)  →  SE(S_ann) ≈ 6.0
 *     n =  30  (T = 0.082 yr)  →  SE(S_ann) ≈ 3.5
 *     n =  60  (T = 0.164 yr)  →  SE(S_ann) ≈ 2.5
 *     n = 120  (T = 0.329 yr)  →  SE(S_ann) ≈ 1.7
 *     n = 365  (T = 1.0   yr)  →  SE(S_ann) ≈ 1.0
 *
 * So the ~10 observations a 14-day soak yields (#238) carry a 95% interval
 * roughly ±12 wide on the annualized Sharpe. That is not a weak measurement, it
 * is no measurement: a strategy with a true Sharpe of 2 and one with a true
 * Sharpe of −2 are indistinguishable at n = 10. Feeding it to a detector that
 * writes risk thresholds is strictly worse than the honest silence #327 shipped.
 *
 * 60 is chosen as the floor for three reasons, none of which is "60 is enough":
 *
 * 1. It is the smallest n at which the asymptotic-normal SE above is a fair
 *    approximation at all. Below roughly n = 30 the Sharpe estimator's
 *    small-sample bias and the t-correction are material, so the numbers in the
 *    table stop being even a conservative guide — the gate would be reasoning
 *    with a formula outside its own validity.
 * 2. It puts a full calendar quarter between the start of a run and the first
 *    time the kill-lines can move anything, which is longer than any planned
 *    paper soak. `autoTighten` therefore cannot fire during the soak this system
 *    is about to run, which is the specific outcome #345 asks for.
 * 3. `computeMetrics` applies Lo's autocorrelation correction with lags up to
 *    `min(P − 1, n − 1)`. At n = 60 the highest lags are estimated from a
 *    handful of pairs and are mostly noise; the Bartlett weights keep the
 *    variance-of-sum non-negative so it cannot blow up, but the correction is
 *    doing little real work. Below 60 it is doing none.
 *
 * **This is a floor of meaninglessness, NOT a precision guarantee.** At n = 60
 * the annualized Sharpe still carries SE ≈ 2.5. Anyone setting
 * `max_live_backtest_divergence` should size it against that number, and anyone
 * wanting a decision-grade estimate should raise the threshold toward 365 via
 * `minReturnObservations` — which is why that option exists and why it can only
 * be raised (see the constructor).
 */
export const MIN_RETURN_OBSERVATIONS = 60;

export interface DailyEquityMetricsSourceInput {
  equity: SqliteDailyEquityStore;
  /** The closed trades behind the suite's trade-derived fields */
  trades: { getClosedTradesBetween(from: Date, to: Date): ClosedTrade[] };
  logger: Logger;
  /**
   * Raise the gate above `MIN_RETURN_OBSERVATIONS`. Lowering it is refused —
   * the floor is a safety property of the kill-line path, not a preference, and
   * a config that could switch it off would defeat the whole ticket.
   */
  minReturnObservations?: number;
  /**
   * The frozen Stage 2 selections (#375, #384). Absent means the three
   * revalidation kill-lines stay inert — which is what they were before this
   * existed, and still the right answer for a deployment that has never run
   * Stage 2.
   */
  stage2Selections?: { getLatestPerAssetClass(): Stage2Selection[] };
  /** Needed to age a selection out; defaults to the system clock */
  clock?: Clock;
}

/**
 * 90 days.
 *
 * docs/research/02-staged-deployment-plan.md's Stage 4 requires re-running the
 * Stage 2 validation checks periodically "as new data accumulates (edges decay;
 * what passed six months ago may not still hold)". A verdict has to expire for
 * that to mean anything, and 90 days is the same horizon #182 uses for its
 * WorldMonitor revisit — one quarter of regime, rather than a number invented
 * here.
 *
 * Erring long rather than short is deliberate: expiring too eagerly silences
 * kill-lines that were working, which is the failure #384 is about.
 *
 * **Not configurable, on purpose** (PR #446 review). Two consumers read the
 * same frozen selection — this source, for `revalidation`, and the composition
 * root, for the divergence baseline — and a knob on one of them would let the
 * two disagree about whether a selection is fresh, so three kill-lines could
 * go inert while the fourth kept firing off the same row. Nothing configures
 * it, and a knob that can desynchronise two halves of one verdict is worse
 * than no knob.
 */
export const DEFAULT_STAGE2_MAX_AGE_DAYS = 90;

/**
 * The selections a revalidation snapshot may be built from: fresh (within
 * `DEFAULT_STAGE2_MAX_AGE_DAYS`) AND with both statistics computed — PBO or
 * DSR null is a typed refusal, and the snapshot's shape has no room for one.
 *
 * Exported because the startup line in `production.ts` reports this exact
 * decision; a re-implemented predicate there is how the pre-#579 warning came
 * to describe a producer that no longer existed.
 */
export function usableRevalidationSelections(
  selections: readonly Stage2Selection[],
  now: Date,
): Stage2Selection[] {
  const maxAgeMs = DEFAULT_STAGE2_MAX_AGE_DAYS * MS_PER_DAY;
  return selections.filter(
    (selection) =>
      now.getTime() - selection.selected_at.getTime() <= maxAgeMs &&
      selection.pbo !== null &&
      selection.dsr !== null,
  );
}

export class SqliteDailyEquityMetricsSource implements DailyMetricsSource {
  private readonly minReturnObservations: number;
  private readonly stage2MaxAgeMs = DEFAULT_STAGE2_MAX_AGE_DAYS * MS_PER_DAY;
  private inertNoted = false;

  constructor(private readonly input: DailyEquityMetricsSourceInput) {
    const requested = input.minReturnObservations ?? MIN_RETURN_OBSERVATIONS;
    if (requested < MIN_RETURN_OBSERVATIONS) {
      throw new Error(
        `SqliteDailyEquityMetricsSource: minReturnObservations must be at least ` +
          `${MIN_RETURN_OBSERVATIONS} (got ${requested}). Below that the annualized Sharpe is ` +
          'dominated by sampling noise, and a breach auto-tightens every risk threshold — so the ' +
          'floor may be raised but never lowered.',
      );
    }
    this.minReturnObservations = requested;
  }

  /**
   * Called once per feedback cycle by the orchestrator, which is why the
   * skip-reason below is logged unconditionally: once per cycle is once per day,
   * not the ~20,000 lines a per-tick log would put into an unattended soak. The
   * per-tick side of this feature — the sampler in `BrokerAccountStateProvider`
   * — logs nothing at all.
   */
  getDailyMetrics(): DailyMetricsSample | undefined {
    const run = usableRun(this.input.equity.all());
    const returns = periodicReturns(run);

    if (returns.length < this.minReturnObservations) {
      this.skip(
        `insufficient observations: the daily equity series yields ${returns.length} usable ` +
          `return(s), below the ${this.minReturnObservations} required. A Sharpe over this many ` +
          'observations is dominated by sampling noise, and a breach WRITES every risk threshold ' +
          '(autoTighten), so no suite is computed and no kill-line is evaluated. The series is ' +
          'still being recorded daily — this resolves itself by waiting, not by configuration.',
        { usable_returns: returns.length, required: this.minReturnObservations },
      );
      return undefined;
    }

    const window = {
      // The first observation is consumed as the base of the first return, so
      // the returns cover `(run[0], run[last]]` — a half-open window matching
      // `ClosedTradeStore.getClosedTradesBetween`'s own convention exactly
      start: run[0]?.session_start as Date,
      end: run[run.length - 1]?.session_start as Date,
    };

    /**
     * Mean equity over the run. This is the turnover/exposure denominator
     * `TradeSeries` requires, and it is a real figure rather than an assumed
     * account size — the same observations the returns are computed from.
     */
    const averageCapital = run.reduce((sum, o) => sum + o.equity, 0) / run.length;

    const returnSeries: ReturnSeries = { returns, periodsPerYear: PERIODS_PER_YEAR };
    const tradeSeries: TradeSeries = {
      trades: this.input.trades.getClosedTradesBetween(window.start, window.end).map((trade) => ({
        instrument: trade.instrument,
        pnl: trade.realized_pnl_net,
        // Entry + exit legs, matching `toTradeSeries` (trade-derivation.ts) so
        // the live turnover figure and the backtest one mean the same thing
        notional: trade.entry * trade.filled_size * 2,
        opened_at: trade.opened_at,
        closed_at: trade.closed_at,
      })),
      averageCapital,
      window,
    };

    try {
      const daily = computeMetrics(returnSeries, tradeSeries);
      const revalidation = this.revalidation();
      return revalidation === undefined ? { daily } : { daily, revalidation };
    } catch (error) {
      // `computeMetrics` throws rather than return a degenerate number — a
      // zero-variance series has no Sharpe, and a flat account produces exactly
      // that. Caught here rather than allowed to propagate because the port's
      // contract is `undefined` for "no suite this cycle", and an exception
      // escaping into the daily timer would be logged as a failed feedback
      // cycle when nothing failed
      this.skip(
        'the daily equity series could not be reduced to a metrics suite: ' +
          `${error instanceof Error ? error.message : String(error)}`,
        { usable_returns: returns.length },
      );
      return undefined;
    }
  }

  /**
   * `DailyMetricsSample.revalidation` (#384), read from the frozen Stage 2
   * selection rather than computed here.
   *
   * PBO, out-of-sample Sharpe and the deflated Sharpe are walk-forward / CSCV
   * statistics over a trial grid — a live paper run cannot compute them about
   * itself, which is exactly why the three kill-lines they feed had no producer
   * and could never fire. #384 named this resolution in advance.
   *
   * Absent (`undefined`) whenever there is nothing honest to report, which
   * keeps those lines inert rather than fabricating a snapshot:
   * - Stage 2 has never been run and persisted anything;
   * - the selection is older than `stage2MaxAgeMs` (below);
   * - the run refused to compute PBO or DSR, so a snapshot would have to
   *   invent one of the two numbers the kill-lines test.
   *
   * When BOTH asset classes have a selection, the WORSE one is reported: the
   * higher PBO. A portfolio holding crypto and stocks is only as validated as
   * its weaker half, and averaging two verdicts would hide a failed one behind
   * a passing one.
   */
  private revalidation(): RevalidationSnapshot | undefined {
    const selections = this.input.stage2Selections?.getLatestPerAssetClass() ?? [];
    if (selections.length === 0) {
      this.noteInert('Stage 2 has never persisted a selected config');
      return undefined;
    }

    const now = (this.input.clock ?? new SystemClock()).now();
    // The DECISION is the shared predicate (also behind the startup line in
    // production.ts); the staged checks below only pick the inert message
    const usable = usableRevalidationSelections(selections, now);
    if (usable.length === 0) {
      const anyFresh = selections.some(
        (selection) => now.getTime() - selection.selected_at.getTime() <= this.stage2MaxAgeMs,
      );
      // Both statistics are required: the snapshot's shape has no room for
      // "PBO was refused", and a zero would read as a perfect result
      this.noteInert(
        anyFresh
          ? 'the persisted Stage 2 selection refused to compute PBO or DSR, so no honest ' +
              'revalidation snapshot exists'
          : `every persisted Stage 2 selection is older than ${
              this.stage2MaxAgeMs / MS_PER_DAY
            } days — a verdict about an old sample says nothing about today's regime`,
      );
      return undefined;
    }

    const worst = usable.reduce((a, b) => ((a.pbo as number) >= (b.pbo as number) ? a : b));

    return {
      walk_forward_sharpe_distribution: worst.fold_sharpes,
      deflated_sharpe: worst.dsr as number,
      pbo: worst.pbo as number,
    };
  }

  /**
   * Says once per process why the three revalidation kill-lines stay inert.
   *
   * Once, not once per cycle: this is a standing state of the deployment, not
   * an event, and #342's lesson is that a line repeated daily for 14 days is a
   * line nobody reads.
   */
  private noteInert(reason: string): void {
    if (this.inertNoted) return;
    this.inertNoted = true;
    this.input.logger.log({
      trace_id: 'feedback-cycle',
      stage: 'feedback-loop',
      event: 'revalidation_snapshot_absent',
      level: 'warn',
      message:
        `no revalidation snapshot — ${reason}. The pbo_over_max, oos_sharpe_under_min and ` +
        'dsr_insignificant kill-lines cannot fire until one exists (#384).',
      payload: { revalidation: 'inert' },
    });
  }

  private skip(reason: string, payload: Record<string, unknown>): void {
    this.input.logger.log({
      trace_id: 'feedback-cycle',
      stage: 'feedback-loop',
      event: 'daily_metrics_suite_absent',
      level: 'warn',
      message: `no daily MetricsSuite — ${reason}`,
      payload,
    });
  }
}

/**
 * The longest run of observations ending at the most recent one that is both
 * evenly spaced and usable as a return denominator.
 *
 * Walks BACKWARDS from the newest row and stops at the first violation, so the
 * result is always the freshest usable window rather than some stale stretch
 * from months ago. Two things end a run:
 *
 * - **A spacing gap.** A process down across a midnight leaves no row for that
 *   session, and the surviving neighbours are 48h apart while still looking
 *   adjacent. Treating that step as one period would book two days of PnL as a
 *   single daily return — inflating the mean, understating the variance, and
 *   flattering the Sharpe on exactly the days the system was broken.
 *   `ReturnSeries` requires even spacing (validation-types.ts) and this is the
 *   only place that can enforce it.
 * - **A non-positive equity.** It is the denominator of the next return, and a
 *   zero or negative base makes that return Infinity or NaN. NaN then compares
 *   false against every kill threshold, so the lines would silently stop firing
 *   rather than fail — the same trap `sessionBasisFor` guards for the daily-loss
 *   breaker.
 */
function usableRun(observations: readonly DailyEquityObservation[]): DailyEquityObservation[] {
  if (observations.length === 0) return [];

  let start = observations.length - 1;
  for (let i = observations.length - 1; i > 0; i -= 1) {
    const current = observations[i] as DailyEquityObservation;
    const previous = observations[i - 1] as DailyEquityObservation;

    const evenlySpaced =
      current.session_start.getTime() - previous.session_start.getTime() === MS_PER_DAY;
    if (!evenlySpaced || !(previous.equity > 0)) break;

    start = i - 1;
  }

  // A single trailing observation whose own equity is unusable yields no
  // returns anyway, but a non-positive newest row would otherwise sit at the
  // end of an otherwise fine run and produce one NaN return
  const run = observations.slice(start);
  return run.every((o) => o.equity > 0) ? run : [];
}

/**
 * Simple (not log) fractional returns between consecutive observations —
 * `(E_t − E_{t−1}) / E_{t−1}`.
 *
 * Fractional because `ReturnSeries` says so, and it says so because the suite's
 * drawdown and profit-factor fields are defined over realized equity and its
 * expectancy is a currency quantity; mixing log returns into that set would make
 * the fields incommensurable (validation-types.ts).
 *
 * These are EQUITY returns, which is the whole point of #345. The obvious
 * alternative — dividing each day's realized `ClosedTrade` PnL by capital — has
 * the wrong denominator and is unevenly spaced, and it books an open position's
 * entire move on the day it happens to close rather than as it happens. Equity
 * includes open, unrealized positions, so a drawdown shows up while it is
 * happening instead of only once someone closes out of it.
 */
function periodicReturns(run: readonly DailyEquityObservation[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < run.length; i += 1) {
    const previous = (run[i - 1] as DailyEquityObservation).equity;
    const current = (run[i] as DailyEquityObservation).equity;
    returns.push((current - previous) / previous);
  }
  return returns;
}
