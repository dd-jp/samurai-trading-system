import { seededRandom } from './fixture.js';
import type { TrialConfig } from './grid.js';
import { gridForVenue, trialHash } from './grid.js';
import type { SimulationResult } from './simulate.js';
import {
  CAPITAL_CEILING_DRAWDOWN_MULTIPLE,
  equityFromReturns,
  MAX_PBO,
  MIN_DEFLATED_SHARPE,
  MINBTL_TARGET_SHARPE,
  SHARPE_HAIRCUT_MULTIPLIER,
  subBookVerdict,
  US_DELISTING_SHARPE_HAIRCUT,
  US_MAX_MISSING_COVERAGE,
  YEARLY_LOSS_LIMIT_GBP,
} from './verdict.js';

const SESSIONS = 2_520;

function dates(): string[] {
  const out: string[] = [];
  const cursor = new Date('2016-01-04T00:00:00Z');
  while (out.length < SESSIONS + 1) {
    if (cursor.getUTCDay() !== 0 && cursor.getUTCDay() !== 6)
      out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

const DATES = dates();

function result(seed: number, drift: number, volatility = 0.01): SimulationResult {
  const random = seededRandom(seed);
  const returns = Array.from({ length: SESSIONS }, () => drift + (random() - 0.5) * volatility * 2);
  return {
    dates: DATES,
    equity: equityFromReturns(returns, 1_000),
    returns,
    fills: [],
    stopHits: 0,
    skippedFills: 0,
    zeroShareTargets: 0,
    totalCost: 0,
    custodyCost: 0,
    budgetDays: { half: 0, quarter: 0, halted: 0, capBlocked: 0 },
    rebalances: 0,
  };
}

function trials(venue: 'us' | 'lse', drifts: readonly number[]) {
  return gridForVenue(venue).map((config: TrialConfig, index) => ({
    config,
    hash: trialHash(config),
    result: result(100 + index, drifts[index] as number),
  }));
}

describe('subBookVerdict', () => {
  it('passes a strong, consistent strategy against a flat benchmark', () => {
    const verdict = subBookVerdict({
      venue: 'lse',
      startCapitalGbp: 1_000,
      wholeShares: true,
      trials: trials('lse', [0.003, 0.001, 0.0005, 0]),
      benchmark: result(9, 0),
      totalTrialsCounted: 8,
      missingCoverageFraction: 0,
    });
    expect(verdict.selectedTrial).toBe(1);
    expect(verdict.walkForward.selectedByFold.every((trial) => trial === 1)).toBe(true);
    expect(verdict.checks).toEqual({
      beatsBenchmarkAfterHaircut: true,
      dsrAtLeast095: true,
      pboAtMost010: true,
      coverageWithinStop: true,
    });
    expect(verdict.pass).toBe(true);
    expect(verdict.delistingHaircutApplied).toBe(0);
    expect(verdict.walkForward.strategySharpeHaircut).toBeCloseTo(
      verdict.walkForward.strategySharpe * SHARPE_HAIRCUT_MULTIPLIER,
    );
    expect(verdict.trials.map((trial) => trial.trial)).toEqual([1, 2, 3, 4]);
    expect(verdict.evaluatedYears).toBeGreaterThan(9.5);
    expect(verdict.minbtl.distinct_configs).toBe(8);
    expect(verdict.minbtl.exceeded).toBe(false);
  });

  it('fails noise against a rising benchmark and reports why', () => {
    const verdict = subBookVerdict({
      venue: 'us',
      startCapitalGbp: 1_000,
      wholeShares: false,
      trials: trials('us', [0, 0, 0, 0]),
      benchmark: result(9, 0.001),
      totalTrialsCounted: 8,
      missingCoverageFraction: 0.01,
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.checks.beatsBenchmarkAfterHaircut).toBe(false);
    expect(verdict.checks.dsrAtLeast095).toBe(false);
    expect(verdict.delistingHaircutApplied).toBe(US_DELISTING_SHARPE_HAIRCUT);
    expect(verdict.walkForward.strategySharpeAfterDelistingHaircut).toBeCloseTo(
      verdict.walkForward.strategySharpe - US_DELISTING_SHARPE_HAIRCUT,
    );
  });

  it('fails the US coverage stop above 2% missing even when everything else passes', () => {
    const verdict = subBookVerdict({
      venue: 'us',
      startCapitalGbp: 5_000,
      wholeShares: true,
      trials: trials('us', [0.003, 0.001, 0.0005, 0]),
      benchmark: result(9, 0),
      totalTrialsCounted: 8,
      missingCoverageFraction: US_MAX_MISSING_COVERAGE + 0.001,
    });
    expect(verdict.checks.beatsBenchmarkAfterHaircut).toBe(true);
    expect(verdict.checks.dsrAtLeast095).toBe(true);
    expect(verdict.checks.pboAtMost010).toBe(true);
    expect(verdict.coverageStopFailed).toBe(true);
    expect(verdict.checks.coverageWithinStop).toBe(false);
    expect(verdict.pass).toBe(false);
  });

  it('flags PBO above 0.10 when the trials are interchangeable noise', () => {
    const verdict = subBookVerdict({
      venue: 'lse',
      startCapitalGbp: 1_000,
      wholeShares: true,
      trials: trials('lse', [0.0005, 0.0005, 0.0005, 0.0005]),
      benchmark: result(9, 0),
      totalTrialsCounted: 8,
      missingCoverageFraction: 0,
    });
    expect(verdict.pbo).toBeGreaterThan(MAX_PBO);
    expect(verdict.checks.pboAtMost010).toBe(false);
  });

  it('derives the capital ceiling from the selected trial max drawdown', () => {
    const verdict = subBookVerdict({
      venue: 'lse',
      startCapitalGbp: 1_000,
      wholeShares: true,
      trials: trials('lse', [0.002, 0.001, 0.0005, 0]),
      benchmark: result(9, 0),
      totalTrialsCounted: 8,
      missingCoverageFraction: 0,
    });
    const selected = verdict.trials.find((trial) => trial.trial === verdict.selectedTrial);
    expect(verdict.capitalCeilingGbp).toBeCloseTo(
      YEARLY_LOSS_LIMIT_GBP /
        ((selected?.maxDrawdown as number) * CAPITAL_CEILING_DRAWDOWN_MULTIPLE),
    );
  });

  it('pins the gate constants', () => {
    expect(MIN_DEFLATED_SHARPE).toBe(0.95);
    expect(MAX_PBO).toBe(0.1);
    expect(SHARPE_HAIRCUT_MULTIPLIER).toBe(0.6);
    expect(MINBTL_TARGET_SHARPE).toBe(0.6);
    expect(US_DELISTING_SHARPE_HAIRCUT).toBe(0.05);
    expect(US_MAX_MISSING_COVERAGE).toBe(0.02);
  });

  it('rejects fewer than two trials', () => {
    expect(() =>
      subBookVerdict({
        venue: 'lse',
        startCapitalGbp: 1_000,
        wholeShares: true,
        trials: trials('lse', [0.001, 0.001, 0.001, 0.001]).slice(0, 1),
        benchmark: result(9, 0),
        totalTrialsCounted: 8,
        missingCoverageFraction: 0,
      }),
    ).toThrow(/>= 2 trials/);
  });
});

describe('equityFromReturns', () => {
  it('compounds from the start value', () => {
    expect(equityFromReturns([0.1, -0.5], 100)).toEqual([
      100, 110.00000000000001, 55.00000000000001,
    ]);
  });
});
