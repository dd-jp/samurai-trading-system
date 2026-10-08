import { describe, expect, it } from 'vitest';
import type { BookSeries } from './backtest-verdict.js';
import {
  BASELINE_PATH_NOISE_OOS_SHARPE,
  type VolTargetVerdictInput,
  volTargetVerdict,
  yearsInsideLossCap,
} from './vol-target-verdict.js';

function weekdays(from: string, count: number): string[] {
  const dates: string[] = [];
  for (let ms = Date.parse(`${from}T00:00:00.000Z`); dates.length < count; ms += 86_400_000) {
    const day = new Date(ms).getUTCDay();
    if (day !== 0 && day !== 6) dates.push(new Date(ms).toISOString().slice(0, 10));
  }
  return dates;
}

const DATES = weekdays('2021-06-01', 400);
const SPLIT = DATES.findIndex((date) => date >= '2022-01-01');

function book(returnAt: (index: number) => number, start = 1_000): BookSeries {
  const returns = DATES.map((_, index) => returnAt(index));
  const equity = [start];
  for (const value of returns) equity.push((equity.at(-1) as number) * (1 + value));
  return { equity, returns };
}

const wobble = (index: number) => (index % 2 === 0 ? 1 : -1);

function input(
  trial: BookSeries,
  baseline: BookSeries,
  overrides: Partial<VolTargetVerdictInput> = {},
): VolTargetVerdictInput {
  return {
    dates: DATES,
    trial: { ...trial, trial: 7 },
    baseline,
    outOfSampleFrom: '2022-01-01',
    trialsCounted: 7,
    lossCapGbp: 450,
    folds: 4,
    embargo: 0,
    ...overrides,
  };
}

describe('volTargetVerdict (#1860)', () => {
  it('splits in and out of sample at the first session on or after the boundary', () => {
    const trial = book((index) => (index < SPLIT ? -0.002 : 0.004) + 0.001 * wobble(index));
    const baseline = book((index) => (index < SPLIT ? 0.003 : -0.002) + 0.004 * wobble(index));
    const verdict = volTargetVerdict(input(trial, baseline));
    expect(verdict.outOfSampleFrom).toBe(DATES[SPLIT]);
    expect(verdict.from).toBe(DATES[0]);
    expect(verdict.to).toBe(DATES.at(-1));
    expect(verdict.trial).toBe(7);
    expect(verdict.trialsCounted).toBe(7);
    expect(verdict.scaled.sharpeInSample).toBeLessThan(0);
    expect(verdict.scaled.sharpeOutOfSample).toBeGreaterThan(0);
    expect(verdict.baseline.sharpeInSample).toBeGreaterThan(0);
    expect(verdict.baseline.sharpeOutOfSample).toBeLessThan(0);
    const outOfSample = trial.equity.slice(SPLIT);
    expect(verdict.scaled.totalReturnOutOfSample).toBeCloseTo(
      (outOfSample.at(-1) as number) / (outOfSample[0] as number) - 1,
      12,
    );
    expect(verdict.scaled.totalReturn).toBeCloseTo((trial.equity.at(-1) as number) / 1_000 - 1, 12);
  });

  it('passes a scaled arm that beats the baseline out of sample after the haircut with a lower drawdown', () => {
    const trial = book((index) => 0.003 + 0.001 * wobble(index));
    const baseline = book((index) => 0.0005 + 0.01 * wobble(index));
    const verdict = volTargetVerdict(input(trial, baseline, { trialsCounted: 2 }));
    expect(verdict.outOfSampleSharpeHaircut).toBeCloseTo(
      verdict.scaled.sharpeOutOfSample * 0.6,
      12,
    );
    expect(verdict.checks).toEqual({
      beatsBaselineOutOfSampleAfterHaircut: true,
      lowersDrawdown: true,
      deflatedSharpeAtLeast095: true,
      pboAtMost010: true,
    });
    expect(verdict.pass).toBe(true);
    expect(verdict.beyondBaselinePathNoise).toBe(true);
  });

  it('fails a scaled arm whose out-of-sample edge does not survive the 40% haircut', () => {
    const baseline = book((index) => 0.002 + 0.002 * wobble(index));
    const trial = book((index) => 0.002 + 0.0015 * wobble(index));
    const verdict = volTargetVerdict(input(trial, baseline));
    expect(verdict.scaled.sharpeOutOfSample).toBeGreaterThan(verdict.baseline.sharpeOutOfSample);
    expect(verdict.checks.beatsBaselineOutOfSampleAfterHaircut).toBe(false);
    expect(verdict.pass).toBe(false);
  });

  it('fails a scaled arm whose drawdown only equals the baseline', () => {
    const baseline = book((index) => (index === 10 ? -0.05 : 0));
    const trial = book((index) =>
      index === 10 ? -0.05 : index > 10 ? 0.004 + 0.0001 * wobble(index) : 0,
    );
    const verdict = volTargetVerdict(input(trial, baseline));
    expect(verdict.scaled.maxDrawdown).toBe(verdict.baseline.maxDrawdown);
    expect(verdict.checks.beatsBaselineOutOfSampleAfterHaircut).toBe(true);
    expect(verdict.checks.lowersDrawdown).toBe(false);
    expect(verdict.pass).toBe(false);
  });

  it('measures the out-of-sample drawdown from the last in-sample mark', () => {
    const trial = book((index) => (index === SPLIT ? -0.1 : index === 5 ? -0.3 : 0));
    const verdict = volTargetVerdict(
      input(
        trial,
        book(() => 0),
      ),
    );
    expect(verdict.scaled.maxDrawdown).toBeCloseTo(0.37, 12);
    expect(verdict.scaled.maxDrawdownOutOfSample).toBeCloseTo(0.1, 12);
  });

  it('deflates over every counted trial and rejects a pair the CSCV ranks unstably', () => {
    const trial = book((index) => 0.0004 + 0.01 * Math.sin(index * 1.7));
    const baseline = book((index) => 0.0004 + 0.01 * Math.cos(index * 1.3));
    const few = volTargetVerdict(input(trial, baseline, { trialsCounted: 1 }));
    const many = volTargetVerdict(input(trial, baseline, { trialsCounted: 60 }));
    expect(many.deflatedSharpe).toBeLessThan(few.deflatedSharpe);
    expect(many.checks.deflatedSharpeAtLeast095).toBe(false);
    expect(many.pbo).toBeGreaterThan(0.1);
    expect(many.checks.pboAtMost010).toBe(false);
  });

  it('flags a Sharpe gap within the baseline path noise', () => {
    const baseline = book((index) => 0.0002 + 0.01 * wobble(index));
    const trial = book((index) => 0.0002 + 0.0099 * wobble(index));
    const verdict = volTargetVerdict(input(trial, baseline));
    expect(Math.abs(verdict.outOfSampleSharpeDelta)).toBeLessThan(BASELINE_PATH_NOISE_OOS_SHARPE);
    expect(verdict.beyondBaselinePathNoise).toBe(false);
  });

  it('sets the capital ceiling from the scaled arm drawdown', () => {
    const trial = book((index) => (index === 3 ? -0.2 : 0.001));
    const verdict = volTargetVerdict(
      input(
        trial,
        book(() => 0),
      ),
    );
    expect(verdict.capitalCeilingGbp).toBeCloseTo(450 / (verdict.scaled.maxDrawdown * 1.5), 9);
  });

  it('refuses misaligned series, a split with under 2 sessions a side, and an uncounted trial', () => {
    const flat = book(() => 0.001);
    expect(() =>
      volTargetVerdict(input({ ...flat, returns: flat.returns.slice(1) }, flat)),
    ).toThrow(/same dates/);
    expect(() => volTargetVerdict(input(flat, { ...flat, equity: flat.equity.slice(1) }))).toThrow(
      /same dates/,
    );
    expect(() => volTargetVerdict(input(flat, flat, { outOfSampleFrom: '2030-01-01' }))).toThrow(
      /fewer than 2 sessions/,
    );
    expect(() =>
      volTargetVerdict(input(flat, flat, { outOfSampleFrom: DATES.at(-1) as string })),
    ).toThrow(/fewer than 2 sessions/);
    expect(() =>
      volTargetVerdict(input(flat, flat, { outOfSampleFrom: DATES[1] as string })),
    ).toThrow(/fewer than 2 sessions/);
    expect(() =>
      volTargetVerdict(input(flat, flat, { outOfSampleFrom: DATES[2] as string })),
    ).not.toThrow();
    expect(() =>
      volTargetVerdict(input(flat, flat, { outOfSampleFrom: DATES.at(-2) as string })),
    ).not.toThrow();
    expect(() => volTargetVerdict(input(flat, flat, { trialsCounted: 0 }))).toThrow(/not counted/);
  });

  it('defaults to 16 folds with no embargo', () => {
    const trial = book((index) => 0.001 + 0.01 * Math.sin(index * 1.7));
    const baseline = book((index) => 0.001 + 0.01 * Math.cos(index * 1.3));
    const defaulted = volTargetVerdict(
      input(trial, baseline, { folds: undefined, embargo: undefined }),
    );
    const explicit = volTargetVerdict(input(trial, baseline, { folds: 16, embargo: 0 }));
    expect(defaulted.pbo).toBe(explicit.pbo);
    expect(volTargetVerdict(input(trial, baseline, { folds: 4 })).pbo).not.toBe(explicit.pbo);
  });
});

describe('yearsInsideLossCap (#1860)', () => {
  const dates = ['2021-12-30', '2021-12-31', '2022-01-03', '2022-12-30', '2023-01-02'];

  it('counts the calendar years whose net loss from the prior year end stayed within the cap', () => {
    expect(yearsInsideLossCap(dates, [1_000, 900, 500, 700, 200, 250], 450)).toBeCloseTo(2 / 3, 12);
  });

  it('keeps a year that loses exactly the cap inside it', () => {
    expect(yearsInsideLossCap(dates, [1_000, 900, 550, 550, 100, 100], 450)).toBe(1);
  });
});
