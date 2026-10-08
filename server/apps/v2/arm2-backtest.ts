import type { Sleeve, SleeveSpec } from '../../../contracts/index.js';
import { SimulatedClock } from '../../shared/index.js';
import type { BacktestTrial, SleeveFactory } from './backtest.js';
import type { BarsSource } from './data/index.js';
import { venueOf } from './index.js';
import type { VolTargetSizing } from './risk/index.js';
import {
  ARM2_ENTRY_THRESHOLDS,
  ARM2_SLEEVE_ID,
  ARM2_SLEEVE_SPEC,
  createArm2Sleeve,
  requireSet,
} from './signal/index.js';

export const ARM2_BACKTEST_SPEC: SleeveSpec = { ...ARM2_SLEEVE_SPEC, validation: 'backtest' };

export const VOL_TARGET_TRIAL_CANDIDATE_ID = 'vol-target-sizing';
export const VOL_TARGET_TRIAL_SLEEVE_ID = 'arm2-vol-target';
// David 2026-10-07 (#1860 rulings 1-2): each entry's own realised vol, 25% a year over 20 days
export const VOL_TARGET_TRIAL_SIZING: VolTargetSizing = {
  annualTargetVol: 0.25,
  windowBars: 20,
  sleeveIds: [VOL_TARGET_TRIAL_SLEEVE_ID],
};
// Build defaults outside the #1860 rulings, each awaiting David before the run (doc 66,
// 2026-10-07): in sample 2016-2022 from Alpaca SIP's first session, out of sample from 2023 to the
// day before the 12-month locked holdout as for candidates 1-3, the £10,000 paper start capital of
// 2026-09-30, and CSCV in 16 folds embargoed by arm 2's time stop. All but the out-of-sample split
// are in the trial hash, so changing one after a run counts a new trial
export const VOL_TARGET_TRIAL_FROM = '2016-01-04';
export const VOL_TARGET_TRIAL_TO = '2025-09-24';
export const VOL_TARGET_TRIAL_OUT_OF_SAMPLE_FROM = '2023-01-01';
export const VOL_TARGET_TRIAL_START_CAPITAL_GBP = 10_000;
export const VOL_TARGET_TRIAL_FOLDS = 16;
export const VOL_TARGET_TRIAL_EMBARGO = ARM2_SLEEVE_SPEC.sizing.timeStopTradingDays;

export interface Arm2BacktestDeps {
  readonly bars: BarsSource;
  readonly constituents: (tradingDate: string) => readonly string[];
}

export function arm2BacktestSleeve(deps: Arm2BacktestDeps, id: string): SleeveFactory {
  return (market): Sleeve => {
    // The clock only stamps the technical view, which neither the inputs hash nor sizing reads
    const clock = new SimulatedClock(new Date(0));
    const inner = createArm2Sleeve({ ...deps, venueFor: venueOf, market, clock });
    return {
      id,
      spec: ARM2_BACKTEST_SPEC,
      universe: (context) => inner.universe(context),
      decide: async (context, instruments) => {
        const output = await inner.decide(context, instruments);
        return {
          ...output,
          decisions: output.decisions.map((decision) => ({ ...decision, sleeve_id: id })),
        };
      },
    };
  };
}

export interface VolTargetTrialArms {
  readonly trial: BacktestTrial;
  readonly baseline: BacktestTrial;
}

export function volTargetTrialArms(deps: Arm2BacktestDeps): VolTargetTrialArms {
  return {
    trial: {
      config: {
        entries: ARM2_SLEEVE_ID,
        arm2_entry_thresholds: requireSet(ARM2_ENTRY_THRESHOLDS),
      },
      sleeve: arm2BacktestSleeve(deps, VOL_TARGET_TRIAL_SLEEVE_ID),
    },
    baseline: {
      config: { benchmark: ARM2_SLEEVE_ID },
      sleeve: arm2BacktestSleeve(deps, ARM2_SLEEVE_ID),
    },
  };
}
