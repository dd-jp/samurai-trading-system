import { describe, expect, it } from 'vitest';
import { annualisedSharpe } from '../../tools/backtest/index.js';
import {
  type BookSeries,
  backtestVerdict,
  CAPITAL_CEILING_DRAWDOWN_MULTIPLE,
  capitalCeilingGbp,
  type VerdictInput,
} from './backtest-verdict.js';

function book(returns: readonly number[]): BookSeries {
  const equity = [1_000];
  for (const value of returns) equity.push((equity.at(-1) as number) * (1 + value));
  return { equity, returns };
}

function noisy(length: number, mean: number, amplitude: number, phase: number): number[] {
  return Array.from({ length }, (_, index) => mean + amplitude * Math.sin(index * 1.7 + phase));
}

const LENGTH = 400;
const DATES = Array.from({ length: LENGTH }, (_, index) =>
  new Date(Date.UTC(2020, 0, 1) + index * 86_400_000).toISOString().slice(0, 10),
);

function input(overrides: Partial<VerdictInput> = {}): VerdictInput {
  return {
    dates: DATES,
    trials: [
      { trial: 9, ...book(noisy(LENGTH, 0.004, 0.002, 0)) },
      { trial: 10, ...book(noisy(LENGTH, 0.0001, 0.01, 1)) },
    ],
    benchmark: book(noisy(LENGTH, 0.0002, 0.01, 2)),
    trialsCounted: 10,
    lossCapGbp: 1_500,
    folds: 4,
    ...overrides,
  };
}

describe('capitalCeilingGbp', () => {
  it('is the loss cap over 1.5 times the drawdown, unbounded without one', () => {
    expect(CAPITAL_CEILING_DRAWDOWN_MULTIPLE).toBe(1.5);
    expect(capitalCeilingGbp(1_500, 0.2)).toBeCloseTo(5_000, 9);
    expect(capitalCeilingGbp(900, 0.3)).toBeCloseTo(2_000, 9);
    expect(capitalCeilingGbp(1_500, 0)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('backtestVerdict', () => {
  it('passes a dominant low-volatility trial and reports the selection and the numbers', () => {
    const verdict = backtestVerdict(input());
    expect(verdict.from).toBe(DATES[0]);
    expect(verdict.to).toBe(DATES.at(-1));
    expect(verdict.trialsCounted).toBe(10);
    expect(verdict.selectedTrial).toBe(9);
    expect(verdict.walkForward.selectedByFold).toEqual([9, 9, 9]);
    expect(verdict.trials.map((trial) => trial.foldSharpes.length)).toEqual([4, 4]);
    expect(verdict.walkForward.strategySharpeHaircut).toBeCloseTo(
      verdict.walkForward.strategySharpe * 0.6,
      12,
    );
    expect(verdict.checks).toEqual({
      beatsBenchmarkAfterHaircut: true,
      deflatedSharpeAtLeast095: true,
      pboAtMost010: true,
    });
    expect(verdict.pass).toBe(true);
    expect(verdict.maxDrawdown).toBe(verdict.trials[0]?.maxDrawdown);
    expect(verdict.capitalCeilingGbp).toBeCloseTo(capitalCeilingGbp(1_500, verdict.maxDrawdown), 9);
  });

  it('fails when the benchmark beats the haircut Sharpe', () => {
    const verdict = backtestVerdict(input({ benchmark: book(noisy(LENGTH, 0.004, 0.0015, 0.5)) }));
    expect(verdict.checks.beatsBenchmarkAfterHaircut).toBe(false);
    expect(verdict.walkForward.benchmarkSharpe).toBeGreaterThan(
      verdict.walkForward.strategySharpeHaircut,
    );
    expect(verdict.pass).toBe(false);
  });

  it('compares against the benchmark over the walk-forward window only', () => {
    const inSample = noisy(LENGTH / 4, 0.02, 0.001, 0);
    const outOfSample = noisy((LENGTH * 3) / 4, -0.001, 0.01, 2);
    const verdict = backtestVerdict(input({ benchmark: book([...inSample, ...outOfSample]) }));
    expect(verdict.walkForward.benchmarkSharpe).toBeCloseTo(annualisedSharpe(outOfSample), 12);
    expect(verdict.benchmarkSharpe).toBeGreaterThan(verdict.walkForward.benchmarkSharpe);
    expect(verdict.checks.beatsBenchmarkAfterHaircut).toBe(true);
  });

  it('deflates harder as the global trial counter grows', () => {
    const weak = [
      { trial: 1, ...book(noisy(LENGTH, 0.0008, 0.01, 0)) },
      { trial: 2, ...book(noisy(LENGTH, 0.0001, 0.01, 1)) },
    ];
    const few = backtestVerdict(input({ trials: weak, trialsCounted: 2 }));
    const many = backtestVerdict(input({ trials: weak, trialsCounted: 500 }));
    expect(many.deflatedSharpe).toBeLessThan(few.deflatedSharpe);
    expect(many.checks.deflatedSharpeAtLeast095).toBe(false);
  });

  it('scores a flat trial with no deflated Sharpe', () => {
    const flat = { trial: 1, ...book(Array.from({ length: LENGTH }, () => 0)) };
    const verdict = backtestVerdict(
      input({ trials: [flat, { trial: 2, ...book(Array.from({ length: LENGTH }, () => 0)) }] }),
    );
    expect(verdict.deflatedSharpe).toBe(0);
    expect(verdict.deflatedSharpeWalkForward).toBe(0);
    expect(verdict.capitalCeilingGbp).toBe(Number.POSITIVE_INFINITY);
  });

  it('refuses fewer than two trials, misaligned series and an undercounted ledger', () => {
    const [first] = input().trials;
    expect(() => backtestVerdict(input({ trials: [first as never] }))).toThrow(
      'backtestVerdict: PBO needs at least 2 trials',
    );
    expect(() =>
      backtestVerdict(input({ benchmark: book(noisy(LENGTH - 1, 0, 0.01, 0)) })),
    ).toThrow('backtestVerdict: every series must cover the same dates');
    const shortEquity = { ...book(noisy(LENGTH, 0, 0.01, 0)), equity: [1] };
    expect(() => backtestVerdict(input({ benchmark: shortEquity }))).toThrow(
      'backtestVerdict: every series must cover the same dates',
    );
    expect(() => backtestVerdict(input({ trialsCounted: 1 }))).toThrow(
      'backtestVerdict: the trial counter is below the trials in this run',
    );
  });
});
