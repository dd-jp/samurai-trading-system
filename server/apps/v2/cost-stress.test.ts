import { describe, expect, it } from 'vitest';
import type { BacktestResult } from './backtest.js';
import {
  candidateOutcome,
  flipsSignAtDoubledCost,
  trialOutcome,
  withCostStress,
} from './cost-stress.js';
import type { VolTargetVerdict } from './vol-target-verdict.js';

const outcome = (sharpeOutOfSample: number, totalReturn: number) => ({
  sharpeOutOfSample,
  totalReturn,
});

function trialVerdict(sharpeOutOfSample: number, totalReturn: number, pass = true) {
  return {
    scaled: { sharpeOutOfSample, totalReturn },
    checks: { beatsBaselineOutOfSampleAfterHaircut: pass, lowersDrawdown: true },
    pass,
  } as unknown as VolTargetVerdict;
}

function candidateResult(
  sharpe: number,
  equity: readonly number[],
  pass = true,
  selectedTrial = 2,
): BacktestResult {
  return {
    dates: [],
    benchmark: { equity: [], returns: [] },
    trials: [
      { trial: 1, sleeve: 'a', equity: [100, 50], returns: [] },
      { trial: 2, sleeve: 'b', equity, returns: [] },
    ],
    verdict: {
      selectedTrial,
      walkForward: { strategySharpe: sharpe },
      checks: { beatsBenchmarkAfterHaircut: pass },
      pass,
    },
  } as unknown as BacktestResult;
}

describe('flipsSignAtDoubledCost', () => {
  it.each([
    ['Sharpe turns negative', outcome(0.125, -0.1), outcome(-0.225, -0.2), true],
    ['Sharpe turns exactly zero', outcome(0.1, -0.1), outcome(0, -0.2), true],
    ['return turns negative', outcome(-0.1, 0.048), outcome(-0.2, -0.045), true],
    ['return turns exactly zero', outcome(-0.1, 0.01), outcome(-0.2, 0), true],
    ['both stay positive', outcome(0.3, 0.2), outcome(Number.EPSILON, Number.EPSILON), false],
    ['Sharpe already zero at 1x', outcome(0, -0.1), outcome(-0.5, -0.2), false],
    ['return already zero at 1x', outcome(-0.1, 0), outcome(-0.2, -0.1), false],
    ['both already negative', outcome(-0.1, -0.1), outcome(-0.2, -0.2), false],
    ['stress improves a negative', outcome(-0.1, -0.1), outcome(0.1, 0.1), false],
  ])('%s', (_case, base, stressed, flipped) => {
    expect(flipsSignAtDoubledCost(base, stressed)).toBe(flipped);
  });
});

describe('withCostStress', () => {
  it('names the check and fails a passing verdict on a flip', () => {
    const verdict = withCostStress({ checks: { a: true }, pass: true, extra: 1 }, true);
    expect(verdict).toEqual({
      checks: { a: true, holdsSignAtDoubledCost: false },
      pass: false,
      extra: 1,
    });
  });

  it('keeps a passing verdict passing without a flip', () => {
    const verdict = withCostStress({ checks: { a: true }, pass: true }, false);
    expect(verdict).toEqual({ checks: { a: true, holdsSignAtDoubledCost: true }, pass: true });
  });

  it('never lifts a failing verdict', () => {
    expect(withCostStress({ checks: { a: false }, pass: false }, false).pass).toBe(false);
  });
});

describe('the vol-target trial under the 2x rule', () => {
  const gate = (base: VolTargetVerdict, stressed: VolTargetVerdict) =>
    withCostStress(base, flipsSignAtDoubledCost(trialOutcome(base), trialOutcome(stressed)));

  it("reads the scaled arm's out-of-sample Sharpe and full-window return", () => {
    expect(trialOutcome(trialVerdict(0.125, 0.048))).toEqual(outcome(0.125, 0.048));
  });

  it('fails on the snapshot numbers, 0.125 to -0.225 and +4.8% to -4.5%', () => {
    const verdict = gate(trialVerdict(0.125, 0.048), trialVerdict(-0.225, -0.045));
    expect(verdict.checks.holdsSignAtDoubledCost).toBe(false);
    expect(verdict.pass).toBe(false);
  });

  it('passes when both stay just above zero at 2x', () => {
    const verdict = gate(trialVerdict(0.125, 0.048), trialVerdict(0.001, 0.001));
    expect(verdict.checks.holdsSignAtDoubledCost).toBe(true);
    expect(verdict.pass).toBe(true);
  });

  it('fails when only the return reaches zero at 2x', () => {
    const verdict = gate(trialVerdict(0.125, 0.048), trialVerdict(0.05, 0));
    expect(verdict.pass).toBe(false);
  });
});

describe('a candidate under the 2x rule', () => {
  const gate = (base: BacktestResult, stressed: BacktestResult) =>
    withCostStress(
      base.verdict,
      flipsSignAtDoubledCost(candidateOutcome(base), candidateOutcome(stressed)),
    );

  it("reads the walk-forward Sharpe and the selected trial's return", () => {
    expect(candidateOutcome(candidateResult(0.4, [1_000, 1_100]))).toEqual({
      sharpeOutOfSample: 0.4,
      totalReturn: expect.closeTo(0.1, 12),
    });
    expect(candidateOutcome(candidateResult(0.4, [1_000, 1_100], true, 1)).totalReturn).toBe(-0.5);
  });

  it('fails when the walk-forward Sharpe reaches zero at 2x', () => {
    const verdict = gate(candidateResult(0.4, [1_000, 1_100]), candidateResult(0, [1_000, 1_050]));
    expect(verdict.checks).toEqual({
      beatsBenchmarkAfterHaircut: true,
      holdsSignAtDoubledCost: false,
    });
    expect(verdict.pass).toBe(false);
  });

  it('fails when the return turns negative at 2x', () => {
    const verdict = gate(candidateResult(0.4, [1_000, 1_100]), candidateResult(0.2, [1_000, 999]));
    expect(verdict.pass).toBe(false);
  });

  it('passes when both stay just above zero at 2x', () => {
    const verdict = gate(
      candidateResult(0.4, [1_000, 1_100]),
      candidateResult(0.01, [1_000, 1_001]),
    );
    expect(verdict.checks.holdsSignAtDoubledCost).toBe(true);
    expect(verdict.pass).toBe(true);
  });

  it('throws when the selected trial has no series', () => {
    expect(() => candidateOutcome(candidateResult(0.4, [1, 2], true, 3))).toThrow(
      'candidateOutcome: no series for trial 3',
    );
  });
});
