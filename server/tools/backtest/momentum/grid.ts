import { createHash } from 'node:crypto';

export type Venue = 'lse' | 'us';

export type Family = 'time-series-trend' | 'cross-sectional-top-k';

export interface StopConfig {
  readonly atrWindow: number;
  readonly atrMultiple: number;
}

export interface TrialConfig {
  readonly trial: number;
  readonly venue: Venue;
  readonly family: Family;
  readonly lookbackDays: number;
  readonly skipDays: number;
  readonly stop: StopConfig | null;
  readonly topK: number | null;
  readonly volWindowDays: number | null;
  readonly targetVolatility: number | null;
  readonly grossCap: number;
  readonly rebalance: 'monthly-last-session';
  readonly executionLagBars: 1;
}

export const FIXED_PARAMETERS = {
  skipDays: 21,
  stop: { atrWindow: 20, atrMultiple: 2 } satisfies StopConfig,
  topK: 10,
  volWindowDays: 60,
  targetVolatility: 0.1,
  grossCap: 1,
} as const;

const LOOKBACKS = [252, 126] as const;

function trialsFor(venue: Venue, firstTrial: number): TrialConfig[] {
  const trials: TrialConfig[] = [];
  for (const lookbackDays of LOOKBACKS) {
    for (const stop of [null, FIXED_PARAMETERS.stop] as const) {
      trials.push(trialConfig(venue, firstTrial + trials.length, lookbackDays, stop));
    }
  }
  return trials;
}

function trialConfig(
  venue: Venue,
  trial: number,
  lookbackDays: number,
  stop: StopConfig | null,
): TrialConfig {
  const shared = {
    trial,
    venue,
    lookbackDays,
    skipDays: FIXED_PARAMETERS.skipDays,
    stop,
    grossCap: FIXED_PARAMETERS.grossCap,
    rebalance: 'monthly-last-session',
    executionLagBars: 1,
  } as const;
  return venue === 'lse'
    ? {
        ...shared,
        family: 'time-series-trend',
        topK: null,
        volWindowDays: FIXED_PARAMETERS.volWindowDays,
        targetVolatility: FIXED_PARAMETERS.targetVolatility,
      }
    : {
        ...shared,
        family: 'cross-sectional-top-k',
        topK: FIXED_PARAMETERS.topK,
        volWindowDays: null,
        targetVolatility: null,
      };
}

export const GRID_A: readonly TrialConfig[] = [...trialsFor('lse', 1), ...trialsFor('us', 5)];

export const GRID_A_TRIAL_COUNT = GRID_A.length;

export function gridForVenue(venue: Venue): readonly TrialConfig[] {
  return GRID_A.filter((trial) => trial.venue === venue);
}

export function trialHash(config: TrialConfig): string {
  const { trial: _trial, ...identity } = config;
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 16);
}

export function maxWarmupDays(trials: readonly TrialConfig[]): number {
  return Math.max(...trials.map((trial) => trial.lookbackDays));
}
