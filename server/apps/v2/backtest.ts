import type { MarketData, Sleeve, SleeveContext } from '../../../contracts/index.js';
import type { Logger } from '../../shared/index.js';
import { SimulatedClock } from '../../shared/index.js';
import { guardedStore, openSharedStore } from '../../shared/store/index.js';
import { type BacktestVerdict, type BookSeries, backtestVerdict } from './backtest-verdict.js';
import { composeCycle } from './compose.js';
import { runCycle } from './cycle.js';
import { addDays, CALENDAR_REFERENCE } from './data/index.js';
import { CapitalConfigStore, sleeveAllocationGbp } from './risk/index.js';
import type { TrialConfig, TrialLedger } from './trial-ledger.js';

export interface BacktestTrial {
  readonly config: TrialConfig;
  readonly sleeve: Sleeve;
}

export interface BacktestInput {
  readonly candidate: string;
  readonly trials: readonly BacktestTrial[];
  readonly benchmark: Sleeve;
  readonly from: string;
  readonly to: string;
  readonly startCapitalGbp: number;
  readonly lossCapGbp: number;
  readonly market: MarketData;
  readonly halfSpreadBps: (instrument: string) => number;
  readonly ledger: TrialLedger;
  readonly logger: Logger;
  readonly folds?: number | undefined;
}

export interface BacktestResult {
  readonly dates: readonly string[];
  readonly trials: readonly (BookSeries & { readonly trial: number; readonly sleeve: string })[];
  readonly benchmark: BookSeries;
  readonly verdict: BacktestVerdict;
}

function refuseForwardPaper(sleeves: readonly Sleeve[]): void {
  for (const sleeve of sleeves) {
    if (sleeve.spec.validation !== 'backtest') {
      throw new Error(
        `backtest refuses sleeve '${sleeve.id}': it is validated by forward paper only (doc 66 Q15, S7)`,
      );
    }
  }
}

function rulesOnly(sleeve: Sleeve): Sleeve {
  return {
    id: sleeve.id,
    spec: sleeve.spec,
    universe: (context: SleeveContext) => sleeve.universe(context),
    decide: async (context, instruments) => {
      const output = await sleeve.decide(context, instruments);
      if (output.decisions.some((decision) => decision.veto !== undefined)) {
        throw new Error(
          `backtest refuses sleeve '${sleeve.id}': a veto cannot be backtested, only its rules (doc 66 S7)`,
        );
      }
      return output;
    },
  };
}

export function backtestSessions(market: MarketData, from: string, to: string): string[] {
  return market
    .barsBefore(CALENDAR_REFERENCE, addDays(to, 1), Number.MAX_SAFE_INTEGER)
    .map((bar) => bar.date)
    .filter((date) => date >= from);
}

function seriesFrom(startEquity: number, marks: readonly number[]): BookSeries {
  const equity = [startEquity, ...marks];
  return {
    equity,
    returns: marks.map((mark, index) => mark / (equity[index] as number) - 1),
  };
}

export async function runBacktest(input: BacktestInput): Promise<BacktestResult> {
  const sleeves = [...input.trials.map((trial) => trial.sleeve), input.benchmark];
  refuseForwardPaper(sleeves);
  const dates = backtestSessions(input.market, input.from, input.to);
  const first = dates[0];
  if (first === undefined)
    throw new Error(`backtest: no sessions from ${input.from} to ${input.to}`);
  const trialNumbers = input.trials.map((trial) =>
    input.ledger.record(input.candidate, { ...trial.config, spec: trial.sleeve.spec }),
  );
  const db = openSharedStore(':memory:');
  try {
    const clock = new SimulatedClock(new Date(`${first}T00:00:00.000Z`));
    const capital = new CapitalConfigStore(guardedStore(db, 'v2'), clock);
    for (let year = Number(first.slice(0, 4)); year <= Number(input.to.slice(0, 4)); year += 1) {
      capital.setYear(year, input.startCapitalGbp, input.lossCapGbp);
    }
    const opening = capital.inForce(first);
    let current = first;
    const cycle = composeCycle({
      db,
      clock,
      logger: input.logger,
      market: input.market,
      sleeves: sleeves.map(rulesOnly),
      openingDate: first,
      tradingDate: () => current,
      dryRun: true,
      halfSpreadBps: input.halfSpreadBps,
    });
    const marks = new Map<string, number[]>(sleeves.map((sleeve) => [sleeve.id, []]));
    for (const date of dates) {
      current = date;
      clock.advanceTo(new Date(`${date}T00:00:00.000Z`));
      const report = await runCycle(cycle, date);
      if (report.submitted_orders > 0) {
        throw new Error(
          `backtest: ${date} submitted ${report.submitted_orders} orders to a broker`,
        );
      }
      for (const sleeve of sleeves) {
        const book = report.books.find((row) => row.book_id === `${sleeve.id}/primary`);
        if (book === undefined)
          throw new Error(`backtest: ${sleeve.id} has no primary book on ${date}`);
        marks.get(sleeve.id)?.push(book.equity_gbp);
      }
    }
    const series = (sleeve: Sleeve) =>
      seriesFrom(
        opening === undefined ? 0 : sleeveAllocationGbp(sleeve.spec, opening),
        marks.get(sleeve.id) ?? [],
      );
    const trials = input.trials.map((trial, index) => ({
      trial: trialNumbers[index] as number,
      sleeve: trial.sleeve.id,
      ...series(trial.sleeve),
    }));
    const benchmark = series(input.benchmark);
    return {
      dates,
      trials,
      benchmark,
      verdict: backtestVerdict({
        dates,
        trials,
        benchmark,
        trialsCounted: input.ledger.count(),
        lossCapGbp: input.lossCapGbp,
        folds: input.folds,
      }),
    };
  } finally {
    db.close();
  }
}
