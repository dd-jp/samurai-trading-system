import { SAXO_CHART_PAGE } from '../../providers/saxo-bars/index.js';
import {
  type Arm2BacktestDeps,
  arm2BacktestSleeve,
  VOL_TARGET_TRIAL_START_CAPITAL_GBP,
} from './arm2-backtest.js';
import type { BacktestTrial } from './backtest.js';
import {
  type BookSeries,
  deflatedSharpeOfReturns,
  SHARPE_HAIRCUT_MULTIPLIER,
  type TrialSeries,
} from './backtest-verdict.js';
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
import { PAGE_SHRINK_SLACK_BARS } from './saxo-bar-refresh.js';
import {
  ARM2_ENTRY_THRESHOLDS,
  ARM2_SLEEVE_ID,
  ARM2_UK_POOL_SLEEVE_ID,
  averageDollarVolume,
  CFD_SHORT_MAX_BORROW_RATE_PER_YEAR,
  coveredHistory,
  isSet,
  LSE_ETF_ONLY_RESERVED_SLOTS,
  LSE_RESERVED_SLOTS,
  type Parameter,
  requireSet,
} from './signal/index.js';
import { type ArmSummary, armSummary } from './vol-target-verdict.js';

export const ARM2_UK_POOL_CANDIDATE_ID = 'arm2-uk-pool';
// David 2026-10-15 (#2143 (a), (b)) and 2026-10-18 (window end): from the start of the ~4.7 years
// Saxo holds, measured on the Mac's bar store on 2026-10-16 (106 of the 109 stored UK stock series
// start 2022-01-14), to 2025-09-24, so the 12-month locked holdout stays clean as in every
// earlier trial; both ends are in the trial hash, so they are pinned, not read from the store
export const ARM2_UK_POOL_FROM = '2022-01-14';
export const ARM2_UK_POOL_TO = '2025-09-24';
// David 2026-10-18 (#2143), pinned in the trial hash
export const ARM2_UK_POOL_OUT_OF_SAMPLE_FROM = '2024-01-01';
// #2143 (a): "today's surviving names" are the first snapshot holding UK stock rows, pinned so the
// name list, and with it the trial hash, does not move with each daily snapshot
export const ARM2_UK_POOL_NAMES_AS_OF = '2026-10-15';
// David 2026-10-19 (#2143): both arms' books start at £3,000, arm 2's 30% share of this £10,000
// paper book, the vol-target trial's
export const ARM2_UK_POOL_START_CAPITAL_GBP = VOL_TARGET_TRIAL_START_CAPITAL_GBP;
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

export function ukPoolCatalogue(archive: CfdCatalogueArchive, namesAsOf: string): CfdCatalogue {
  const today = archive.inForceOn(namesAsOf);
  if (today === undefined || poolNames(today).length === 0) {
    throw new Error(
      `arm 2 UK pool: no archived CFD catalogue in force on ${namesAsOf} holds a tradable UK stock CFD`,
    );
  }
  return today;
}

// A name holding at least a full chart/v3 page that starts after the pinned start lost the
// window's head before the refresh kept history (#2143); a shorter series is all Saxo holds for a
// name listed later (HLN, SUNB), so its start is its own
const FULL_UK_PAGE_BARS = SAXO_CHART_PAGE - PAGE_SHRINK_SLACK_BARS;

function shortOfWindow(bars: readonly { date: string }[], from: string, to: string): boolean {
  const first = bars[0]?.date;
  const last = bars.at(-1)?.date;
  if (first === undefined || last === undefined) return false;
  return last < to || (first > from && bars.length >= FULL_UK_PAGE_BARS);
}

export function assertUkBarsReach(
  bars: BarsSource,
  today: CfdCatalogue,
  window: { readonly from: string; readonly to: string },
): void {
  const stored = poolNames(today).filter((symbol) => bars.load(symbol) !== undefined);
  const short = stored.filter((symbol) =>
    shortOfWindow(bars.load(symbol)?.bars ?? [], window.from, window.to),
  );
  if (stored.length === 0 || short.length > 0) {
    throw new Error(
      `arm 2 UK pool: the stored UK stock bars do not span the pinned ${window.from} to ${window.to} (${short.length > 0 ? short.join(', ') : 'none stored'}); the rolling chart/v3 page has aged out the trial's window (postmortem §2)`,
    );
  }
}

// David 2026-10-18 (#2143): no counted run until CFD dividend cash (ruling (e)) is modelled
export function assertArm2UkPoolRunReady(parameter: Parameter<boolean>): void {
  if (isSet(parameter) && parameter.value === true) return;
  throw new Error(
    `arm 2 UK pool: ${parameter.name} is unset (${parameter.ticket}); phase 2 sets it once CFD dividend cash is modelled, and no trial is recorded before then`,
  );
}

export interface Arm2UkPoolDeps
  extends Omit<Arm2BacktestDeps, 'ukStocks' | 'assumedBeforeArchive'> {
  readonly today: CfdCatalogue;
  readonly screens: UkStockScreens;
  readonly outOfSampleFrom: string;
}

export interface Arm2UkPoolArms {
  readonly trial: BacktestTrial;
  readonly baseline: BacktestTrial;
  readonly ukStocks: (tradingDate: string) => readonly string[];
  readonly ukStockCfdOpen: true;
}

// #2143 (c): the same pre-archive route policy for both arms, so the ETF-only baseline is not
// held long-only where the trial can short (the asymmetry #2105 ruling 4 rejected)
export function arm2UkPoolArms(deps: Arm2UkPoolDeps): Arm2UkPoolArms {
  const { today, screens, outOfSampleFrom, ...arm2 } = deps;
  const catalogue = { asOf: today.asOf, sha256: today.sha256 };
  const routesBeforeArchive = {
    catalogue,
    borrow_per_year: CFD_SHORT_MAX_BORROW_RATE_PER_YEAR,
  };
  const ukStockCfdOpen = true;
  const shared = { ...arm2, assumedBeforeArchive: today, ukStockCfdOpen };
  const ukStocks = ukStockPoolFromBars(arm2.bars, today, screens);
  return {
    ukStocks,
    ukStockCfdOpen,
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
        out_of_sample_from: outOfSampleFrom,
      },
      sleeve: arm2BacktestSleeve({ ...shared, ukStocks }, ARM2_UK_POOL_SLEEVE_ID),
    },
    baseline: {
      config: {
        benchmark: ARM2_SLEEVE_ID,
        universe: 'lse_etf_only',
        reserved_lse_slots: LSE_ETF_ONLY_RESERVED_SLOTS,
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

export interface Arm2UkPoolVerdict {
  readonly from: string;
  readonly to: string;
  readonly outOfSampleFrom: string;
  readonly sessionsInSample: number;
  readonly sessionsOutOfSample: number;
  readonly trial: number;
  readonly trialsCounted: number;
  readonly ukPoolStartGbp: number;
  readonly etfOnlyStartGbp: number;
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
    ukPoolStartGbp: input.trial.equity[0] as number,
    etfOnlyStartGbp: input.baseline.equity[0] as number,
    ukPool: armSummary(input.trial, input.dates, split, input.lossCapGbp),
    etfOnly: armSummary(input.baseline, input.dates, split, input.lossCapGbp),
    deflatedSharpe: deflatedSharpeOfReturns(input.trial.returns, input.trialsCounted),
  };
}

export interface Arm2UkPoolLeg {
  readonly ukPoolSharpeOutOfSample: number;
  readonly ukPoolSharpeAfterHaircut: number;
  readonly etfOnlySharpeOutOfSample: number;
  readonly beatsBeforeHaircut: boolean;
  readonly beatsAfterHaircut: boolean;
}

export interface Arm2UkPoolPassRule {
  readonly afterHaircut: Arm2UkPoolLeg;
  readonly atDoubledCost: Arm2UkPoolLeg;
  readonly pass: boolean;
}

function passRuleLeg(verdict: Arm2UkPoolVerdict): Arm2UkPoolLeg {
  const ukPool = verdict.ukPool.sharpeOutOfSample;
  const etfOnly = verdict.etfOnly.sharpeOutOfSample;
  const haircut = ukPool * SHARPE_HAIRCUT_MULTIPLIER;
  return {
    ukPoolSharpeOutOfSample: ukPool,
    ukPoolSharpeAfterHaircut: haircut,
    etfOnlySharpeOutOfSample: etfOnly,
    beatsBeforeHaircut: ukPool > etfOnly,
    beatsAfterHaircut: haircut > etfOnly,
  };
}

// David 2026-10-20 (#2143): beat ETF-only arm 2 after the 40% haircut, and still beat it with both
// arms at 2x modelled cost. One trial has no fold selection, so its walk-forward Sharpe is the
// out-of-sample Sharpe past the pinned split, as the vol-target trial's verdict reads it. The 2x
// leg keeps the haircut, so the stricter reading of "still beats" can only withhold a pass
export function arm2UkPoolPassRule(
  base: Arm2UkPoolVerdict,
  stressed: Arm2UkPoolVerdict,
): Arm2UkPoolPassRule {
  const afterHaircut = passRuleLeg(base);
  const atDoubledCost = passRuleLeg(stressed);
  return {
    afterHaircut,
    atDoubledCost,
    pass: afterHaircut.beatsAfterHaircut && atDoubledCost.beatsAfterHaircut,
  };
}
