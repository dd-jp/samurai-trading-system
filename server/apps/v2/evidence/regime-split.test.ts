import { describe, expect, it } from 'vitest';
import { annualisedSharpe } from './momentum/stats.js';
import { type RegimeDay, regimePeriods, regimeSplit } from './regime-split.js';

function day(date: string, strategy: number, benchmark: number): RegimeDay {
  return { date, strategy, benchmark };
}

function wave(date: string, index: number, strategyMean: number, benchmarkMean: number) {
  const swing = index % 2 === 0 ? 0.01 : -0.01;
  return day(date, strategyMean + swing, benchmarkMean + swing * 1.1);
}

describe('regimePeriods', () => {
  it('lists every calendar year the window touches, then the two stress windows', () => {
    expect(regimePeriods('2019-06-03', '2021-02-01')).toEqual([
      { period: '2019', from: '2019-01-01', to: '2019-12-31' },
      { period: '2020', from: '2020-01-01', to: '2020-12-31' },
      { period: '2021', from: '2021-01-01', to: '2021-12-31' },
      { period: '2020-crash', from: '2020-02-19', to: '2020-03-23' },
      { period: '2022-drawdown', from: '2022-01-03', to: '2022-10-12' },
    ]);
    expect(regimePeriods('2024-01-02', '2024-12-31').map((row) => row.period)).toEqual([
      '2024',
      '2020-crash',
      '2022-drawdown',
    ]);
  });
});

describe('regimeSplit', () => {
  const steady = [
    ...['2019-03-01', '2019-03-04', '2019-03-05', '2019-03-06'].map((date, index) =>
      wave(date, index, 0.004, 0.0001),
    ),
    ...['2020-02-20', '2020-02-21', '2020-03-23', '2020-03-24'].map((date, index) =>
      wave(date, index, 0.004, 0.0001),
    ),
  ];

  it('reports each period haircut Sharpe minus benchmark Sharpe, inclusive of both ends', () => {
    const split = regimeSplit(steady, regimePeriods('2019-03-01', '2020-03-24'), 0.6);
    const crash = split.periods.find((row) => row.period === '2020-crash');
    const inCrash = steady.slice(4, 7);
    expect(crash?.inPeriod.sessions).toBe(3);
    const strategy = annualisedSharpe(inCrash.map((row) => row.strategy)) * 0.6;
    const benchmark = annualisedSharpe(inCrash.map((row) => row.benchmark));
    expect(crash?.inPeriod.strategySharpeHaircut).toBeCloseTo(strategy, 12);
    expect(crash?.inPeriod.benchmarkSharpe).toBeCloseTo(benchmark, 12);
    expect(crash?.inPeriod.excess).toBeCloseTo(strategy - benchmark, 12);
    expect(crash?.withoutPeriod.sessions).toBe(5);
    expect(split.periods.find((row) => row.period === '2019')?.inPeriod.sessions).toBe(4);
    expect(split.periods.find((row) => row.period === '2020')?.withoutPeriod.sessions).toBe(4);
    expect(split.beatsBenchmarkWithAnyPeriodRemoved).toBe(true);
    expect(split.periods.every((row) => row.beatsBenchmarkWithoutPeriod)).toBe(true);
  });

  it('fails when removing one period loses the edge, even though the whole series beats it', () => {
    const carried = [
      ...['2019-03-01', '2019-03-04', '2019-03-05', '2019-03-06'].map((date, index) =>
        wave(date, index, -0.002, 0.001),
      ),
      ...['2020-06-01', '2020-06-02', '2020-06-03', '2020-06-04'].map((date, index) =>
        wave(date, index, 0.03, 0.0005),
      ),
    ];
    const whole = regimeSplit(carried, [], 0.6);
    expect(whole.beatsBenchmarkWithAnyPeriodRemoved).toBe(true);
    const split = regimeSplit(carried, regimePeriods('2019-03-01', '2020-06-04'), 0.6);
    const without2020 = split.periods.find((row) => row.period === '2020');
    expect(without2020?.withoutPeriod.excess).toBeLessThan(0);
    expect(without2020?.beatsBenchmarkWithoutPeriod).toBe(false);
    expect(split.periods.find((row) => row.period === '2019')?.beatsBenchmarkWithoutPeriod).toBe(
      true,
    );
    expect(split.beatsBenchmarkWithAnyPeriodRemoved).toBe(false);
  });

  it('leaves a period without two sessions blank, and fails closed when the remainder has fewer than two', () => {
    const days = [
      day('2019-03-01', 0.01, 0),
      day('2019-03-04', -0.005, 0.001),
      day('2020-03-02', 0.02, -0.01),
    ];
    const split = regimeSplit(days, regimePeriods('2019-03-01', '2020-03-02'), 0.6);
    const [year2019, year2020, crash, drawdown] = split.periods;
    expect(year2020?.inPeriod).toEqual({
      sessions: 1,
      strategySharpeHaircut: null,
      benchmarkSharpe: null,
      excess: null,
    });
    expect(year2020?.withoutPeriod.sessions).toBe(2);
    expect(year2020?.withoutPeriod.excess).not.toBeNull();
    expect(year2019?.withoutPeriod).toEqual({
      sessions: 1,
      strategySharpeHaircut: null,
      benchmarkSharpe: null,
      excess: null,
    });
    expect(year2019?.beatsBenchmarkWithoutPeriod).toBe(false);
    expect(crash?.inPeriod.sessions).toBe(1);
    expect(drawdown?.inPeriod.sessions).toBe(0);
    expect(drawdown?.withoutPeriod.sessions).toBe(3);
    expect(split.beatsBenchmarkWithAnyPeriodRemoved).toBe(false);
  });

  it('does not count a tie as beating the benchmark', () => {
    const days = ['2019-03-01', '2019-03-04', '2019-03-05'].map((date, index) =>
      day(date, index === 1 ? -0.01 : 0.02, index === 1 ? -0.01 : 0.02),
    );
    const split = regimeSplit(days, regimePeriods('2020-01-01', '2020-12-31'), 1);
    expect(split.periods[0]?.withoutPeriod.excess).toBe(0);
    expect(split.periods[0]?.beatsBenchmarkWithoutPeriod).toBe(false);
    expect(split.beatsBenchmarkWithAnyPeriodRemoved).toBe(false);
  });
});
