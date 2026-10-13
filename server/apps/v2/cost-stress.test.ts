import { describe, expect, it } from 'vitest';
import type { BacktestResult } from './backtest.js';
import {
  baselinePicksAt,
  type CostStress,
  candidateOutcome,
  costStress,
  trialOutcome,
  withCostStress,
} from './cost-stress.js';
import { annualisedSharpe, type FoldRange } from './evidence/index.js';
import type { VolTargetVerdict } from './vol-target-verdict.js';

const outcome = (sharpeOutOfSample: number, totalReturn: number) => ({
  sharpeOutOfSample,
  totalReturn,
});

const RANGES: readonly FoldRange[] = [
  { fold: 0, start: 0, end: 3 },
  { fold: 1, start: 3, end: 6 },
  { fold: 2, start: 6, end: 9 },
];
const DATES = Array.from({ length: 9 }, (_, day) => `2024-01-${String(day + 1).padStart(2, '0')}`);

interface Trial {
  readonly returns: readonly number[];
  readonly equity: readonly number[];
}

interface RunShape {
  readonly trials: readonly [Trial, Trial];
  readonly selectedTrial: number;
  readonly selectedByFold: readonly number[];
  readonly strategySharpe: number;
}

function run(shape: RunShape): BacktestResult {
  return {
    dates: DATES,
    benchmark: { equity: [], returns: [] },
    trials: shape.trials.map((series, index) => ({
      trial: index + 1,
      sleeve: `s${index}`,
      ...series,
    })),
    verdict: {
      selectedTrial: shape.selectedTrial,
      walkForward: { selectedByFold: shape.selectedByFold, strategySharpe: shape.strategySharpe },
      checks: { beatsBenchmarkAfterHaircut: true },
      pass: true,
    },
  } as unknown as BacktestResult;
}

const RISING: Trial = {
  returns: [0.01, 0.02, 0.01, 0.02, 0.01, 0.03, 0.02, 0.01, 0.02],
  equity: [1_000, 1_150],
};
const FALLING: Trial = {
  returns: [-0.01, -0.02, -0.01, -0.02, -0.01, -0.03, -0.02, -0.01, -0.02],
  equity: [1_000, 850],
};
const MIXED: Trial = {
  returns: [0.5, -0.5, 0.5, 0.04, 0.01, 0.03, -0.04, -0.01, -0.03],
  equity: [1_000, 1_000],
};

function gate(base: BacktestResult, stressed: BacktestResult): CostStress {
  return costStress(
    candidateOutcome(base),
    candidateOutcome(stressed),
    baselinePicksAt(base, stressed, RANGES),
  );
}

describe('costStress', () => {
  const positive = outcome(0.4, 0.1);

  it.each([
    ['own picks Sharpe', outcome(0, 0.1), positive, 'ownPicks', 'sharpeOutOfSample'],
    ['own picks return', outcome(0.4, -0.01), positive, 'ownPicks', 'totalReturn'],
    ['1x picks Sharpe', positive, outcome(-0.2, 0.1), 'baselinePicks', 'sharpeOutOfSample'],
    ['1x picks return', positive, outcome(0.4, 0), 'baselinePicks', 'totalReturn'],
  ])('names %s when it flips alone', (_case, ownPicks, baselinePicks, picks, measure) => {
    const stress = costStress(positive, ownPicks, baselinePicks);
    expect(stress).toEqual({
      base: positive,
      ownPicks,
      baselinePicks,
      flipped: [{ picks, measure }],
    });
  });

  it('lists every reading that flips', () => {
    const flipped = costStress(positive, outcome(-1, -1), outcome(0, 0)).flipped;
    expect(flipped).toEqual([
      { picks: 'ownPicks', measure: 'sharpeOutOfSample' },
      { picks: 'ownPicks', measure: 'totalReturn' },
      { picks: 'baselinePicks', measure: 'sharpeOutOfSample' },
      { picks: 'baselinePicks', measure: 'totalReturn' },
    ]);
  });

  it('flags nothing when both readings stay just above zero', () => {
    const tiny = outcome(Number.EPSILON, Number.EPSILON);
    expect(costStress(positive, tiny, tiny).flipped).toEqual([]);
  });

  it('never flags a reading already at or below zero at 1x', () => {
    expect(costStress(outcome(0, 0), outcome(-1, -1), outcome(-1, -1)).flipped).toEqual([]);
    expect(costStress(outcome(-0.1, -0.1), outcome(0.1, 0.1), outcome(-1, -1)).flipped).toEqual([]);
  });
});

describe('withCostStress', () => {
  const held = costStress(outcome(1, 1), outcome(1, 1), outcome(1, 1));
  const flipped = costStress(outcome(1, 1), outcome(1, 1), outcome(0, 1));

  it('fails a passing verdict on a flip and records the readings', () => {
    const verdict = withCostStress({ checks: { a: true }, pass: true, extra: 1 }, flipped);
    expect(verdict).toEqual({
      checks: { a: true, holdsSignAtDoubledCost: false },
      costStress: flipped,
      pass: false,
      extra: 1,
    });
  });

  it('keeps a passing verdict passing without a flip', () => {
    const verdict = withCostStress({ checks: { a: true }, pass: true }, held);
    expect(verdict.checks).toEqual({ a: true, holdsSignAtDoubledCost: true });
    expect(verdict.pass).toBe(true);
  });

  it('never lifts a failing verdict', () => {
    expect(withCostStress({ checks: { a: false }, pass: false }, held).pass).toBe(false);
  });
});

describe('trialOutcome', () => {
  it("reads the scaled arm's out-of-sample Sharpe and full-window return", () => {
    const verdict = { scaled: { sharpeOutOfSample: 0.125, totalReturn: 0.048 } };
    expect(trialOutcome(verdict as unknown as VolTargetVerdict)).toEqual(outcome(0.125, 0.048));
  });
});

describe('candidateOutcome', () => {
  it("reads the walk-forward Sharpe and the full-window pick's return", () => {
    const shape = {
      trials: [FALLING, RISING],
      selectedByFold: [2, 2],
      strategySharpe: 0.4,
    } as const;
    expect(candidateOutcome(run({ ...shape, selectedTrial: 2 }))).toEqual({
      sharpeOutOfSample: 0.4,
      totalReturn: expect.closeTo(0.15, 12),
    });
    expect(candidateOutcome(run({ ...shape, selectedTrial: 1 })).totalReturn).toBeCloseTo(
      -0.15,
      12,
    );
  });

  it('throws when the selected trial has no series', () => {
    const result = run({
      trials: [RISING, RISING],
      selectedTrial: 3,
      selectedByFold: [1, 1],
      strategySharpe: 1,
    });
    expect(() => candidateOutcome(result)).toThrow('cost stress: no series for trial 3');
  });
});

describe('baselinePicksAt', () => {
  it("prices each fold's 1x pick on the 2x run's series over that fold's test days", () => {
    const base = run({
      trials: [RISING, RISING],
      selectedTrial: 2,
      selectedByFold: [1, 2],
      strategySharpe: 1,
    });
    const stressed = run({
      trials: [MIXED, FALLING],
      selectedTrial: 1,
      selectedByFold: [1, 1],
      strategySharpe: 1,
    });
    expect(baselinePicksAt(base, stressed, RANGES)).toEqual({
      sharpeOutOfSample: annualisedSharpe([0.04, 0.01, 0.03, -0.02, -0.01, -0.02]),
      totalReturn: expect.closeTo(-0.15, 12),
    });
  });

  it('throws when the runs cover different sessions', () => {
    const base = run({
      trials: [RISING, RISING],
      selectedTrial: 1,
      selectedByFold: [1, 1],
      strategySharpe: 1,
    });
    const longer = { ...base, dates: [...DATES, '2024-01-10'] };
    const shifted = { ...base, dates: [...DATES.slice(0, -1), '2024-01-10'] };
    for (const stressed of [longer, shifted]) {
      expect(() => baselinePicksAt(base, stressed, RANGES)).toThrow(
        'baselinePicksAt: the 1x and 2x runs do not share their walk-forward folds',
      );
    }
  });

  it('throws when the folds do not match the 1x picks', () => {
    const base = run({
      trials: [RISING, RISING],
      selectedTrial: 1,
      selectedByFold: [1, 1],
      strategySharpe: 1,
    });
    expect(() => baselinePicksAt(base, base, RANGES.slice(1))).toThrow('baselinePicksAt');
  });
});

describe('a candidate under "flip if either flips"', () => {
  it('fails when the 1x pick flips at 2x though the 2x pick stays positive', () => {
    const base = run({
      trials: [RISING, MIXED],
      selectedTrial: 1,
      selectedByFold: [1, 1],
      strategySharpe: 2,
    });
    const stressed = run({
      trials: [FALLING, RISING],
      selectedTrial: 2,
      selectedByFold: [2, 2],
      strategySharpe: 1.5,
    });
    const stress = gate(base, stressed);
    expect(stress.ownPicks.sharpeOutOfSample).toBeGreaterThan(0);
    expect(stress.ownPicks.totalReturn).toBeGreaterThan(0);
    expect(stress.flipped).toEqual([
      { picks: 'baselinePicks', measure: 'sharpeOutOfSample' },
      { picks: 'baselinePicks', measure: 'totalReturn' },
    ]);
    const verdict = withCostStress(base.verdict, stress);
    expect(verdict.checks.holdsSignAtDoubledCost).toBe(false);
    expect(verdict.pass).toBe(false);
  });

  it('passes when the same picks stay positive at 2x', () => {
    const base = run({
      trials: [RISING, FALLING],
      selectedTrial: 1,
      selectedByFold: [1, 1],
      strategySharpe: 2,
    });
    const stressed = run({
      trials: [RISING, FALLING],
      selectedTrial: 1,
      selectedByFold: [1, 1],
      strategySharpe: 1,
    });
    const verdict = withCostStress(base.verdict, gate(base, stressed));
    expect(verdict.costStress.flipped).toEqual([]);
    expect(verdict.pass).toBe(true);
  });
});
