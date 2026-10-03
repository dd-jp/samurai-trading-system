import {
  annualisedSharpe,
  annualisedVol,
  calendarYearReturns,
  compoundedAnnualReturn,
  maxDrawdown,
  moments,
  perPeriodSharpe,
} from './stats.js';

describe('moments', () => {
  it('matches hand-computed mean, sample stdev, skew and excess kurtosis', () => {
    const stats = moments([1, 2, 3, 4, 10]);
    expect(stats.count).toBe(5);
    expect(stats.mean).toBe(4);
    expect(stats.stdev).toBeCloseTo(Math.sqrt(50 / 4));
    expect(stats.skew).toBeCloseTo(36 / 10 ** 1.5, 6);
    expect(stats.excessKurtosis).toBeCloseTo(278.8 / 100 - 3, 6);
  });

  it('is zero-skew and zero-kurtosis for a constant series', () => {
    expect(moments([2, 2, 2])).toEqual({ count: 3, mean: 2, stdev: 0, skew: 0, excessKurtosis: 0 });
  });

  it('rejects fewer than two values', () => {
    expect(() => moments([1])).toThrow(/need >= 2/);
  });
});

describe('Sharpe and volatility', () => {
  it('annualises the per-period Sharpe by root 252', () => {
    const returns = [0.01, 0.02, 0.0, 0.01];
    expect(annualisedSharpe(returns)).toBeCloseTo(perPeriodSharpe(returns) * Math.sqrt(252));
    expect(annualisedVol(returns)).toBeCloseTo(moments(returns).stdev * Math.sqrt(252));
  });

  it('is zero Sharpe for a constant series', () => {
    expect(perPeriodSharpe([0.01, 0.01])).toBe(0);
  });
});

describe('maxDrawdown', () => {
  it('measures the deepest peak-to-trough fall', () => {
    expect(maxDrawdown([100, 120, 90, 110, 80, 130])).toBeCloseTo(1 - 80 / 120);
    expect(maxDrawdown([100, 110, 120])).toBe(0);
    expect(maxDrawdown([])).toBe(0);
  });
});

describe('compoundedAnnualReturn', () => {
  it('compounds over trading days at 252 a year', () => {
    const equity = [1, ...Array.from({ length: 252 }, () => 1.1)];
    expect(compoundedAnnualReturn(equity)).toBeCloseTo(0.1);
    expect(compoundedAnnualReturn([1])).toBe(0);
    expect(compoundedAnnualReturn([0, 1])).toBe(0);
  });
});

describe('calendarYearReturns', () => {
  it('measures each year from the prior year close', () => {
    const dates = ['2020-12-30', '2020-12-31', '2021-06-30', '2021-12-31', '2022-03-01'];
    const equity = [100, 110, 120, 132, 120];
    const byYear = calendarYearReturns(dates, equity);
    expect(byYear.get(2020)).toBeCloseTo(0.1);
    expect(byYear.get(2021)).toBeCloseTo(0.2);
    expect(byYear.get(2022)).toBeCloseTo(120 / 132 - 1);
  });

  it('rejects mismatched lengths', () => {
    expect(() => calendarYearReturns(['2020-01-01'], [1, 2])).toThrow(/differ in length/);
  });
});
