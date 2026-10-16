import { type Arm2BacktestDeps, arm2BacktestSleeve } from './arm2-backtest.js';
import type { BacktestTrial } from './backtest.js';
import { type BookSeries, deflatedSharpeOfReturns, type TrialSeries } from './backtest-verdict.js';
import {
  type BarsSource,
  type CfdCatalogue,
  type CfdCatalogueArchive,
  type CfdInstrument,
  calendarReferenceFor,
  isUkStock,
  PENCE_PER_POUND,
  sessionsBefore,
  type UkStockScreens,
} from './data/index.js';
import {
  ARM2_ENTRY_THRESHOLDS,
  ARM2_SLEEVE_ID,
  ARM2_UK_POOL_SLEEVE_ID,
  averageDollarVolume,
  CFD_SHORT_MAX_BORROW_RATE_PER_YEAR,
  coveredHistory,
  LSE_RESERVED_SLOTS,
  requireSet,
} from './signal/index.js';
import { type ArmSummary, armSummary } from './vol-target-verdict.js';

export const ARM2_UK_POOL_CANDIDATE_ID = 'arm2-uk-pool';
// David 2026-10-15 (#2143 (a), (b)): the ~4.7 years Saxo holds, measured on the Mac's bar store
// on 2026-10-16, where 106 of the 109 stored UK stock series start 2022-01-14 and all end
// 2026-10-15; both ends are in the trial hash, so they are pinned, not read from the rolling store
export const ARM2_UK_POOL_FROM = '2022-01-14';
export const ARM2_UK_POOL_TO = '2026-10-15';
// Build choice awaiting David (#2143): the vol-target trial's 2023-01-01 boundary. It is not in
// the trial hash, so a ruling can move it without counting a new trial
export const ARM2_UK_POOL_OUT_OF_SAMPLE_FROM = '2023-01-01';
// The £10,000 paper start capital of 2026-09-30, as the vol-target trial (#1860)
export const ARM2_UK_POOL_START_CAPITAL_GBP = 10_000;
// David 2026-10-15 (#2143 ruling of the short window): 20-session ADV and price from bars
export const UK_POOL_ADV_SESSIONS = 20;

function inTodaysPool(instrument: CfdInstrument): boolean {
  return (
    isUkStock(instrument.symbol) && instrument.assetType === 'CfdOnStock' && instrument.tradable
  );
}

function poolNames(today: CfdCatalogue): readonly string[] {
  return today.instruments.filter(inTodaysPool).map((instrument) => instrument.symbol);
}

// #2143 (a), (d): today's survivors, screened on each date from bars before it only, with no
// spread screen; survivorship and look-ahead in the name list are recorded biases
export function ukStockPoolFromBars(
  bars: BarsSource,
  today: CfdCatalogue,
  screens: UkStockScreens,
): (tradingDate: string) => readonly string[] {
  const names = poolNames(today);
  return (tradingDate) => {
    const sessions = sessionsBefore(bars, tradingDate, calendarReferenceFor('saxo'));
    return names.filter((symbol) => {
      const history = coveredHistory(bars, symbol, tradingDate, sessions, UK_POOL_ADV_SESSIONS);
      const adv = averageDollarVolume(history, UK_POOL_ADV_SESSIONS);
      const last = history.at(-1);
      if (adv === undefined || last === undefined) return false;
      return last.rawClose * PENCE_PER_POUND >= screens.minPricePence && adv >= screens.minAdvGbp;
    });
  };
}

export function ukPoolCatalogue(archive: CfdCatalogueArchive, to: string): CfdCatalogue {
  const today = archive.inForceOn(to);
  if (today === undefined || poolNames(today).length === 0) {
    throw new Error(
      `arm 2 UK pool: no archived CFD catalogue in force on ${to} holds a tradable UK stock CFD`,
    );
  }
  return today;
}

// The UK refresh stores a rolling 1,200-bar page and drops what ages out, so a store that no
// longer reaches the pinned start would run the same trial hash over a shorter UK history
export function assertUkBarsReach(bars: BarsSource, today: CfdCatalogue, from: string): void {
  const starts = poolNames(today)
    .map((symbol) => bars.load(symbol)?.bars[0]?.date)
    .filter((date): date is string => date !== undefined)
    .sort();
  const earliest = starts[0];
  if (earliest === undefined || earliest > from) {
    throw new Error(
      `arm 2 UK pool: the stored UK stock bars start ${earliest ?? 'nowhere'}, after the pinned ${from}; the rolling chart/v3 page has aged out the trial's window (postmortem §2)`,
    );
  }
}

export interface Arm2UkPoolDeps
  extends Omit<Arm2BacktestDeps, 'ukStocks' | 'assumedBeforeArchive'> {
  readonly today: CfdCatalogue;
  readonly screens: UkStockScreens;
}

export interface Arm2UkPoolArms {
  readonly trial: BacktestTrial;
  readonly baseline: BacktestTrial;
  readonly ukStocks: (tradingDate: string) => readonly string[];
}

// #2143 (c): the same pre-archive route policy for both arms, so the ETF-only baseline is not
// held long-only where the trial can short (the asymmetry #2105 ruling 4 rejected)
export function arm2UkPoolArms(deps: Arm2UkPoolDeps): Arm2UkPoolArms {
  const { today, screens, ...arm2 } = deps;
  const catalogue = { asOf: today.asOf, sha256: today.sha256 };
  const routesBeforeArchive = {
    catalogue,
    borrow_per_year: CFD_SHORT_MAX_BORROW_RATE_PER_YEAR,
  };
  const shared = { ...arm2, assumedBeforeArchive: today, ukStockCfdOpen: true };
  const ukStocks = ukStockPoolFromBars(arm2.bars, today, screens);
  return {
    ukStocks,
    trial: {
      config: {
        entries: ARM2_SLEEVE_ID,
        arm2_entry_thresholds: requireSet(ARM2_ENTRY_THRESHOLDS),
        universe: {
          reserved_lse_slots: LSE_RESERVED_SLOTS,
          uk_stock_pool: {
            names: catalogue,
            adv_sessions: UK_POOL_ADV_SESSIONS,
            min_adv_gbp: screens.minAdvGbp,
            min_price_pence: screens.minPricePence,
            spread_screen: false,
          },
        },
        cfd_routes_before_archive: routesBeforeArchive,
        cfd_dividends: 'not_modelled',
      },
      sleeve: arm2BacktestSleeve({ ...shared, ukStocks }, ARM2_UK_POOL_SLEEVE_ID),
    },
    baseline: {
      config: {
        benchmark: ARM2_SLEEVE_ID,
        universe: 'lse_etf_only',
        cfd_routes_before_archive: routesBeforeArchive,
      },
      sleeve: arm2BacktestSleeve(shared, ARM2_SLEEVE_ID),
    },
  };
}

export interface Arm2UkPoolVerdictInput {
  readonly dates: readonly string[];
  readonly trial: TrialSeries;
  readonly baseline: BookSeries;
  readonly outOfSampleFrom: string;
  readonly trialsCounted: number;
  readonly lossCapGbp: number;
}

// #2143 sets arm 2 paper's band; no pass rule is ruled, so the verdict reports and never passes
export interface Arm2UkPoolVerdict {
  readonly from: string;
  readonly to: string;
  readonly outOfSampleFrom: string;
  readonly sessionsInSample: number;
  readonly sessionsOutOfSample: number;
  readonly trial: number;
  readonly trialsCounted: number;
  readonly ukPool: ArmSummary;
  readonly etfOnly: ArmSummary;
  readonly deflatedSharpe: number;
}

export function arm2UkPoolVerdict(input: Arm2UkPoolVerdictInput): Arm2UkPoolVerdict {
  const length = input.dates.length;
  for (const series of [input.trial, input.baseline]) {
    if (series.returns.length !== length || series.equity.length !== length + 1) {
      throw new Error('arm2UkPoolVerdict: every series must cover the same dates');
    }
  }
  const split = input.dates.findIndex((date) => date >= input.outOfSampleFrom);
  if (split < 2 || length - split < 2) {
    throw new Error(
      `arm2UkPoolVerdict: ${input.outOfSampleFrom} leaves fewer than 2 sessions on one side of the split`,
    );
  }
  return {
    from: input.dates[0] as string,
    to: input.dates.at(-1) as string,
    outOfSampleFrom: input.dates[split] as string,
    sessionsInSample: split,
    sessionsOutOfSample: length - split,
    trial: input.trial.trial,
    trialsCounted: input.trialsCounted,
    ukPool: armSummary(input.trial, input.dates, split, input.lossCapGbp),
    etfOnly: armSummary(input.baseline, input.dates, split, input.lossCapGbp),
    deflatedSharpe: deflatedSharpeOfReturns(input.trial.returns, input.trialsCounted),
  };
}
