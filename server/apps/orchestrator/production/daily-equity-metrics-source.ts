/**
 * The real `DailyMetricsSource` — the first thing in this repo that can
 * actually produce the `MetricsSuite` `computeMetrics` evaluates.
 *
 * `DailyMetricsSource`'s own doc records why it shipped as a supplied port:
 * the validation library needs a `ReturnSeries` of evenly spaced periodic
 * equity returns, and nothing persisted one until `daily_equity` (migration
 * 0011) did.
 *
 * Returning a suite is not free — a breach makes `autoTighten` write every
 * risk threshold toward its extreme. So below `MIN_RETURN_OBSERVATIONS` this
 * returns `undefined` (the port's first-class "no suite this cycle" answer)
 * rather than compute a Sharpe too early: equity not recorded on the day is
 * unrecoverable so sampling starts immediately, but a threshold decision made
 * off a premature estimate is worse than none.
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
 * 365, not 252: the series is anchored to the portfolio's UTC-day boundary,
 * which advances every calendar day including weekends because the account
 * holds crypto that trades through them. 252 (the trading-day count) would
 * over-annualize a series that genuinely has 365 bars a year.
 */
const PERIODS_PER_YEAR = 365;

/**
 * The minimum number of RETURNS (not observations — n observations yield n−1
 * returns) below which the suite is not computed at all.
 *
 * Per Lo (2002), "The Statistics of Sharpe Ratios", eq. 8 (also Jobson &
 * Korkie 1981), the annualized Sharpe's standard error is governed by the
 * sample length in YEARS, not the count of observations — sampling more
 * often does not tighten it. At n = 60 (P = 365) SE(S_ann) is still ~2.5, so
 * this is a floor of meaninglessness, not a precision guarantee: below n =
 * 30 the asymptotic-normal approximation itself becomes unreliable, and at
 * n = 60 a strategy with a true Sharpe of 2 is statistically indistinguishable
 * from one of −2.
 *
 * Anyone wanting a decision-grade estimate should raise the threshold toward
 * 365 via `minReturnObservations`, which can only be raised (see the
 * constructor) — lowering it would defeat the kill-line safety property this
 * floor protects.
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
   * The frozen Stage 2 selections. Absent means the three revalidation
   * kill-lines stay inert — the right answer for a deployment that has never
   * run Stage 2.
   */
  stage2Selections?: { getLatestPerAssetClass(): Stage2Selection[] };
  /** Needed to age a selection out; defaults to the system clock */
  clock?: Clock;
}

/**
 * 90 days — one quarter of regime, matching `docs/research/02-staged-deployment-plan.md`'s
 * Stage 4 revisit horizon. Erring long rather than short is deliberate:
 * expiring too eagerly silences kill-lines that were working.
 *
 * Not configurable: this source (`revalidation`) and the composition root
 * (divergence baseline) both read the same frozen selection, and a knob on
 * one would let the two disagree about freshness — some kill-lines could go
 * inert while others kept firing off the same row.
 */
export const DEFAULT_STAGE2_MAX_AGE_DAYS = 90;

/**
 * The selections a revalidation snapshot may be built from: fresh (within
 * `DEFAULT_STAGE2_MAX_AGE_DAYS`) AND with both statistics computed — PBO or
 * DSR null is a typed refusal, and the snapshot's shape has no room for one.
 *
 * Exported because the startup line in `production.ts` reports this exact
 * decision; a re-implemented predicate there risks silently diverging from it.
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
   * Called once per feedback cycle by the orchestrator, so the skip-reason
   * below is logged unconditionally — once per cycle is once per day, not
   * per tick. The per-tick sampler in `BrokerAccountStateProvider` logs
   * nothing at all.
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
   * `DailyMetricsSample.revalidation`, read from the frozen Stage 2 selection
   * rather than computed here — PBO, out-of-sample Sharpe and the deflated
   * Sharpe are walk-forward/CSCV statistics over a trial grid that a live
   * paper run cannot compute about itself.
   *
   * Absent whenever there is nothing honest to report: Stage 2 has never
   * persisted a selection; the selection is older than `stage2MaxAgeMs`; or
   * the run refused to compute PBO or DSR.
   *
   * When both asset classes have a selection, the worse one (higher PBO) is
   * reported — a portfolio is only as validated as its weaker half.
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
   * Once, not once per cycle: this is a standing state of the deployment,
   * not an event, and a line repeated daily is a line nobody reads.
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
 * Walks backwards from the newest row and stops at the first violation, so
 * the result is always the freshest usable window. A spacing gap (a process
 * down across a midnight) would otherwise book two days of PnL as one daily
 * return, flattering the Sharpe on exactly the days the system was broken. A
 * non-positive equity is the denominator of the next return and would make
 * it Infinity or NaN, which then compares false against every kill
 * threshold — silently disarming the lines rather than failing loudly.
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
 * `(E_t − E_{t−1}) / E_{t−1}`. Fractional because the suite's drawdown and
 * profit-factor fields are currency-denominated; mixing log returns in would
 * make them incommensurable.
 *
 * These are equity returns, not `ClosedTrade` PnL divided by capital — that
 * alternative has the wrong denominator, is unevenly spaced, and books an
 * open position's entire move on the day it closes rather than as it
 * happens. Equity includes unrealized positions, so a drawdown shows up
 * while it is happening.
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
