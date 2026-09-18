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

const MS_PER_DAY = 24 * 60 * 60 * 1_000;

const PERIODS_PER_YEAR = 365;

export const MIN_RETURN_OBSERVATIONS = 60;

export interface DailyEquityMetricsSourceInput {
  equity: SqliteDailyEquityStore;
  trades: { getClosedTradesBetween(from: Date, to: Date): ClosedTrade[] };
  logger: Logger;
  minReturnObservations?: number;
  stage2Selections?: { getLatestPerAssetClass(): Stage2Selection[] };
  clock?: Clock;
}

export const DEFAULT_STAGE2_MAX_AGE_DAYS = 90;

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
      start: run[0]?.session_start as Date,
      end: run[run.length - 1]?.session_start as Date,
    };

    const averageCapital = run.reduce((sum, o) => sum + o.equity, 0) / run.length;

    const returnSeries: ReturnSeries = { returns, periodsPerYear: PERIODS_PER_YEAR };
    const tradeSeries: TradeSeries = {
      trades: this.input.trades.getClosedTradesBetween(window.start, window.end).map((trade) => ({
        instrument: trade.instrument,
        pnl: trade.realized_pnl_net,
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
      this.skip(
        'the daily equity series could not be reduced to a metrics suite: ' +
          `${error instanceof Error ? error.message : String(error)}`,
        { usable_returns: returns.length },
      );
      return undefined;
    }
  }

  private revalidation(): RevalidationSnapshot | undefined {
    const selections = this.input.stage2Selections?.getLatestPerAssetClass() ?? [];
    if (selections.length === 0) {
      this.noteInert('Stage 2 has never persisted a selected config');
      return undefined;
    }

    const now = (this.input.clock ?? new SystemClock()).now();
    const usable = usableRevalidationSelections(selections, now);
    if (usable.length === 0) {
      const anyFresh = selections.some(
        (selection) => now.getTime() - selection.selected_at.getTime() <= this.stage2MaxAgeMs,
      );
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

  const run = observations.slice(start);
  return run.every((o) => o.equity > 0) ? run : [];
}

function periodicReturns(run: readonly DailyEquityObservation[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < run.length; i += 1) {
    const previous = (run[i - 1] as DailyEquityObservation).equity;
    const current = (run[i] as DailyEquityObservation).equity;
    returns.push((current - previous) / previous);
  }
  return returns;
}
