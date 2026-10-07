import type {
  CapitalYear,
  MarketData,
  Sleeve,
  SleeveContext,
  SleeveDecision,
} from '../../../contracts/index.js';
import type { Logger } from '../../shared/index.js';
import { SimulatedClock } from '../../shared/index.js';
import { guardedStore, openSharedStore } from '../../shared/store/index.js';
import { type BacktestVerdict, type BookSeries, backtestVerdict } from './backtest-verdict.js';
import type { CanaryLog } from './canary-log.js';
import { type CycleComposition, composeCycle } from './compose.js';
import { type CycleReport, runCycle } from './cycle.js';
import { addDays, CALENDAR_REFERENCE } from './data/index.js';
import {
  CapitalConfigStore,
  ENTRY_LIMIT_OFFSET,
  type EntryLimitOffset,
  sleeveAllocationGbp,
  type VolTargetSizing,
} from './risk/index.js';
import { declaredVolTarget } from './signal/index.js';
import { type TrialConfig, type TrialLedger, trialHash } from './trial-ledger.js';

export type SleeveFactory = (market: MarketData) => Sleeve;

export interface BacktestTrial {
  readonly config: TrialConfig;
  readonly sleeve: SleeveFactory;
}

export interface ShiftCanaryInput {
  readonly trials: readonly BacktestTrial[];
  readonly log: CanaryLog;
}

export interface BacktestInput {
  readonly candidate: string;
  readonly trials: readonly BacktestTrial[];
  readonly benchmark: BacktestTrial;
  readonly from: string;
  readonly to: string;
  readonly startCapitalGbp: number;
  readonly lossCapGbp: number;
  readonly market: MarketData;
  readonly halfSpreadBps: (instrument: string) => number;
  readonly ledger: TrialLedger;
  readonly logger: Logger;
  readonly folds?: number | undefined;
  // #1515: folds.ts's fold-boundary purge width. Omitted from recordTrials' run info when unset,
  // not defaulted to 0/null there, so a sleeve that never declares one hashes identically to
  // before this field existed
  readonly embargo?: number | undefined;
  readonly calendarReference?: string | undefined;
  // Never part of recordTrials' run info: a cost-sensitivity rerun (doc 67 "2x modelled cost")
  // must resolve to the SAME trial hash as its 1x baseline, not a new permanent ledger entry
  readonly costMultiple?: number | undefined;
  readonly volTarget?: VolTargetSizing | undefined;
  // The input's trials, in their order, one bar later (doc 66, 2026-10-07 rulings on #1747)
  readonly shiftCanary?: ShiftCanaryInput | undefined;
}

export interface BacktestSimulation {
  readonly dates: readonly string[];
  readonly trials: readonly (BookSeries & { readonly trial: number; readonly sleeve: string })[];
  readonly benchmark: BookSeries;
  readonly trialsShare: number;
}

export interface BacktestResult extends Omit<BacktestSimulation, 'trialsShare'> {
  readonly verdict: BacktestVerdict;
}

const MAX_SESSION_GAP_CALENDAR_DAYS = 5;

export function fencedMarket(market: MarketData, today: () => string): MarketData {
  const fence = (tradingDate: string) => {
    if (tradingDate > today()) {
      throw new Error(
        `backtest: a sleeve read bars before ${tradingDate} on ${today()} (lookahead)`,
      );
    }
  };
  return {
    lastBarBefore: (instrument, tradingDate) => {
      fence(tradingDate);
      return market.lastBarBefore(instrument, tradingDate);
    },
    barsBefore: (instrument, tradingDate, count) => {
      fence(tradingDate);
      return market.barsBefore(instrument, tradingDate, count);
    },
    gbpUsdAtYearStart: (year) => {
      fence(`${year}-01-01`);
      return market.gbpUsdAtYearStart(year);
    },
    gbpUsdYearStartFixDate: (year) => {
      fence(`${year}-01-01`);
      return market.gbpUsdYearStartFixDate?.(year);
    },
  };
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

function trialsShare(trials: readonly Sleeve[]): number {
  const shares = new Set(trials.map((sleeve) => sleeve.spec.capitalShare));
  if (shares.size !== 1) {
    throw new Error(
      `backtest: trials declare capital shares ${[...shares].join(', ')}; one grid takes one share`,
    );
  }
  return [...shares][0] as number;
}

function assertBacktestable(
  sleeve: Sleeve,
  decision: SleeveDecision,
  market: MarketData,
  tradingDate: string,
): void {
  if (decision.veto !== undefined) {
    throw new Error(
      `backtest refuses sleeve '${sleeve.id}': a veto cannot be backtested, only its rules (doc 66 S7)`,
    );
  }
  if (decision.action !== 'enter_long' && decision.action !== 'enter_short') return;
  const quoted = market.lastBarBefore(decision.instrument, tradingDate)?.rawClose;
  if (decision.price !== quoted) {
    throw new Error(
      `backtest refuses sleeve '${sleeve.id}': ${decision.instrument} entry at ${decision.price} is not the last raw close ${quoted}; bars are dividend-adjusted, fills are at quoted prices`,
    );
  }
}

function rulesOnly(sleeve: Sleeve, market: MarketData): Sleeve {
  return {
    id: sleeve.id,
    spec: sleeve.spec,
    universe: (context: SleeveContext) => sleeve.universe(context),
    decide: async (context, instruments) => {
      const output = await sleeve.decide(context, instruments);
      for (const decision of output.decisions) {
        assertBacktestable(sleeve, decision, market, context.tradingDate);
      }
      return output;
    },
  };
}

function assertSessionsCover(
  dates: readonly string[],
  from: string,
  to: string,
  calendarReference: string,
): void {
  const gaps: [string, string][] = [
    [from, dates[0] ?? to],
    ...dates.slice(1).map((date, index): [string, string] => [dates[index] as string, date]),
    [dates.at(-1) ?? from, to],
  ];
  for (const [before, after] of gaps) {
    if (addDays(before, MAX_SESSION_GAP_CALENDAR_DAYS) < after) {
      throw new Error(
        `backtest: ${calendarReference} has no session from ${before} to ${after}; the calendar does not cover ${from} to ${to} (postmortem §2)`,
      );
    }
  }
}

export function backtestSessions(
  market: MarketData,
  from: string,
  to: string,
  calendarReference: string = CALENDAR_REFERENCE,
): string[] {
  const dates = market
    .barsBefore(calendarReference, addDays(to, 1), Number.MAX_SAFE_INTEGER)
    .map((bar) => bar.date)
    .filter((date) => date >= from);
  if (dates.length === 0) throw new Error(`backtest: no sessions from ${from} to ${to}`);
  assertSessionsCover(dates, from, to, calendarReference);
  return dates;
}

function seriesFrom(startEquity: number, marks: readonly number[]): BookSeries {
  const equity = [startEquity, ...marks];
  return {
    equity,
    returns: marks.map((mark, index) => mark / (equity[index] as number) - 1),
  };
}

// Arm 2's only book is 'technical-only' (#1773), so a backtest marks the sleeve's first
// instantiated book rather than assuming 'primary'
function markedEquity(report: CycleReport, sleeve: Sleeve, date: string): number {
  if (report.submitted_orders > 0) {
    throw new Error(`backtest: ${date} submitted ${report.submitted_orders} orders to a broker`);
  }
  const variant = sleeve.spec.books.find((book) => book.instantiated)?.variant;
  const book = report.books.find((row) => row.book_id === `${sleeve.id}/${variant}`);
  if (book === undefined) throw new Error(`backtest: ${sleeve.id} has no marked book on ${date}`);
  return book.equity_gbp;
}

function seedCapital(
  capital: CapitalConfigStore,
  input: BacktestInput,
  first: string,
): CapitalYear {
  const opening = capital.setYear(
    Number(first.slice(0, 4)),
    input.startCapitalGbp,
    input.lossCapGbp,
  );
  for (let year = opening.year + 1; year <= Number(input.to.slice(0, 4)); year += 1) {
    capital.setYear(year, input.startCapitalGbp, input.lossCapGbp);
  }
  return opening;
}

async function replay(
  cycle: CycleComposition,
  clock: SimulatedClock,
  sleeves: readonly Sleeve[],
  dates: readonly string[],
  today: { current: string },
): Promise<number[][]> {
  const deps: CycleComposition = { ...cycle, closeEndedSeries: true };
  const marks = sleeves.map((): number[] => []);
  for (const date of dates) {
    today.current = date;
    clock.advanceTo(new Date(`${date}T00:00:00.000Z`));
    const report = await runCycle(deps, date);
    sleeves.forEach((sleeve, index) => {
      (marks[index] as number[]).push(markedEquity(report, sleeve, date));
    });
  }
  return marks;
}

// David ruled 2026-09-30 on #1815: the entry offset is part of the trial identity. A 0 bps offset
// is omitted so a run at 0 bps keeps the hash every trial recorded before the ruling carries
export function entryOffsetIdentity(offset: EntryLimitOffset): { entryOffset?: EntryLimitOffset } {
  return offset.capBps === 0 ? {} : { entryOffset: offset };
}

// #1860: the cycle sizes with the declared vol target, so a set one is part of every trial it
// touches; unset, it is omitted so the trials recorded before #1860 keep their hashes
export function volTargetIdentity(sizing: VolTargetSizing | undefined): {
  volTarget?: VolTargetSizing;
} {
  return sizing === undefined ? {} : { volTarget: sizing };
}

function volTargetOf(input: BacktestInput): VolTargetSizing | undefined {
  return input.volTarget ?? declaredVolTarget();
}

function trialConfigs(
  input: BacktestInput,
  trials: readonly Sleeve[],
  benchmark: Sleeve,
): TrialConfig[] {
  const run = {
    from: input.from,
    to: input.to,
    folds: input.folds ?? null,
    ...(input.embargo === undefined ? {} : { embargo: input.embargo }),
    startCapitalGbp: input.startCapitalGbp,
    lossCapGbp: input.lossCapGbp,
    ...entryOffsetIdentity(ENTRY_LIMIT_OFFSET),
    ...volTargetIdentity(volTargetOf(input)),
    benchmark: { id: benchmark.id, spec: benchmark.spec, config: input.benchmark.config },
  };
  return input.trials.map((trial, index) => ({
    ...trial.config,
    spec: (trials[index] as Sleeve).spec,
    run,
  }));
}

interface Fenced {
  readonly market: MarketData;
  readonly today: { current: string };
}

function fenced(input: BacktestInput): Fenced {
  const today = { current: input.from };
  return { market: fencedMarket(input.market, () => today.current), today };
}

interface Simulation {
  readonly opening: CapitalYear;
  readonly marks: readonly (readonly number[])[];
}

async function simulate(
  input: BacktestInput,
  sleeves: readonly Sleeve[],
  today: { current: string },
  dates: readonly string[],
): Promise<Simulation> {
  const first = dates[0] as string;
  const db = openSharedStore(':memory:');
  try {
    const clock = new SimulatedClock(new Date(`${first}T00:00:00.000Z`));
    const opening = seedCapital(
      new CapitalConfigStore(guardedStore(db, 'v2'), clock),
      input,
      first,
    );
    const cycle = composeCycle({
      db,
      clock,
      logger: input.logger,
      market: input.market,
      sleeves: sleeves.map((sleeve) => rulesOnly(sleeve, input.market)),
      openingDate: first,
      tradingDate: () => today.current,
      dryRun: true,
      brokerMode: 'paper',
      halfSpreadBps: input.halfSpreadBps,
      costMultiple: input.costMultiple,
      volTarget: volTargetOf(input),
    });
    return { opening, marks: await replay(cycle, clock, sleeves, dates, today) };
  } finally {
    db.close();
  }
}

function seriesOf(simulation: Simulation, sleeves: readonly Sleeve[]): BookSeries[] {
  return sleeves.map((sleeve, index) =>
    seriesFrom(
      sleeveAllocationGbp(sleeve.spec, simulation.opening),
      simulation.marks[index] as number[],
    ),
  );
}

async function delayedSeries(
  input: BacktestInput,
  canary: ShiftCanaryInput,
  dates: readonly string[],
): Promise<BookSeries[]> {
  const view = fenced(input);
  const sleeves = canary.trials.map((trial) => trial.sleeve(view.market));
  refuseForwardPaper(sleeves);
  return seriesOf(await simulate(input, sleeves, view.today, dates), sleeves);
}

function assertShiftCoversTrials(input: BacktestInput): void {
  if (input.shiftCanary !== undefined && input.shiftCanary.trials.length !== input.trials.length) {
    throw new Error('backtest: the shift canary must delay every trial of the run');
  }
}

function logShift(
  input: BacktestInput,
  configs: readonly TrialConfig[],
  verdict: BacktestVerdict,
): void {
  input.shiftCanary?.log.record({
    candidate: input.candidate,
    candidateHash: trialHash(input.candidate, {
      trials: configs.map((config) => trialHash(input.candidate, config)),
    }),
    kind: 'shift',
    seed: undefined,
    result: { ...verdict.oneBarDelay },
  });
}

interface RecordedSimulation extends BacktestSimulation {
  readonly configs: readonly TrialConfig[];
}

async function simulateRecorded(input: BacktestInput): Promise<RecordedSimulation> {
  const view = fenced(input);
  const trialSleeves = input.trials.map((trial) => trial.sleeve(view.market));
  const benchmarkSleeve = input.benchmark.sleeve(view.market);
  const sleeves = [...trialSleeves, benchmarkSleeve];
  refuseForwardPaper(sleeves);
  const share = trialsShare(trialSleeves);
  const dates = backtestSessions(
    input.market,
    input.from,
    input.to,
    input.calendarReference ?? CALENDAR_REFERENCE,
  );
  const configs = trialConfigs(input, trialSleeves, benchmarkSleeve);
  const trialNumbers = configs.map((config) => input.ledger.record(input.candidate, config));
  const books = seriesOf(await simulate(input, sleeves, view.today, dates), sleeves);
  const trials = trialSleeves.map((sleeve, index) => ({
    trial: trialNumbers[index] as number,
    sleeve: sleeve.id,
    ...(books[index] as BookSeries),
  }));
  const benchmark = books[trialSleeves.length] as BookSeries;
  return { dates, trials, benchmark, trialsShare: share, configs };
}

export function simulateBacktest(input: BacktestInput): Promise<BacktestSimulation> {
  return simulateRecorded(input);
}

export async function runBacktest(input: BacktestInput): Promise<BacktestResult> {
  assertShiftCoversTrials(input);
  const canary = input.shiftCanary;
  const { dates, trials, benchmark, trialsShare: share, configs } = await simulateRecorded(input);
  const verdict = backtestVerdict({
    dates,
    trials,
    benchmark,
    trialsCounted: input.ledger.count(),
    lossCapGbp: input.lossCapGbp * share,
    folds: input.folds,
    embargo: input.embargo,
    delayed: canary === undefined ? undefined : await delayedSeries(input, canary, dates),
  });
  logShift(input, configs, verdict);
  return { dates, trials, benchmark, verdict };
}
