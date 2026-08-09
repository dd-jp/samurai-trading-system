import { computeMetrics } from './metrics.js';
import type { ReturnSeries, TradeSeries } from './validation-types.js';

const WINDOW = { start: new Date('2026-01-01T00:00:00Z'), end: new Date('2026-01-11T00:00:00Z') };

function trade(overrides: Partial<TradeSeries['trades'][number]> = {}) {
  return {
    instrument: 'SPY',
    pnl: 100,
    notional: 10_000,
    opened_at: new Date('2026-01-01T00:00:00Z'),
    closed_at: new Date('2026-01-02T00:00:00Z'),
    ...overrides,
  };
}

function series(returns: number[], periodsPerYear = 252): ReturnSeries {
  return { returns, periodsPerYear };
}

function trades(list: TradeSeries['trades'], averageCapital = 100_000): TradeSeries {
  return { trades: list, averageCapital, window: WINDOW };
}

/** i.i.d.-ish returns: no autocorrelation to speak of. */
const FLAT_ISH = [0.01, -0.005, 0.012, -0.008, 0.006, 0.009, -0.003, 0.011, -0.006, 0.004];

describe('computeMetrics', () => {
  it('reports every field of the suite together', () => {
    const metrics = computeMetrics(series(FLAT_ISH), trades([trade()]));

    // The suite is the contract: a caller must never be handed one number.
    expect(Object.keys(metrics).sort()).toEqual(
      [
        'calmar',
        'expectancy',
        'exposure',
        'kurtosis',
        'max_drawdown',
        'profit_factor',
        'sharpe',
        'skew',
        'sortino',
        'turnover',
        // The DSR inputs (#406) — part of the same contract: they describe the
        // sample `sharpe` was computed on, so they travel with it.
        'per_period_sharpe',
        'annualization_factor',
        'observations',
      ].sort(),
    );

    for (const [field, value] of Object.entries(metrics)) {
      expect(value, `${field} must be a number`).toBeTypeOf('number');
      expect(Number.isNaN(value), `${field} must not be NaN`).toBe(false);
    }
  });

  describe('the DSR inputs (#406)', () => {
    /**
     * The three fields are redundant with `sharpe` by construction, which is
     * what makes them safe to consume — and what makes drift between them
     * silent. Pinning the identity is the only thing that keeps them honest.
     */
    it('reports a per-period Sharpe that reproduces the annualized one exactly', () => {
      const metrics = computeMetrics(series(FLAT_ISH), trades([trade()]));

      expect(metrics.per_period_sharpe * metrics.annualization_factor).toBeCloseTo(
        metrics.sharpe,
        12,
      );
    });

    it('reports a per-period Sharpe that is NOT the annualized one — the bug this seam exists to prevent', () => {
      const metrics = computeMetrics(series(FLAT_ISH), trades([trade()]));

      // Handing `sharpe` to deflatedSharpe() was the pre-#406 trap: it inflates
      // the statistic by the annualization factor and silently flatters DSR.
      expect(metrics.annualization_factor).toBeGreaterThan(1);
      expect(Math.abs(metrics.sharpe)).toBeGreaterThan(Math.abs(metrics.per_period_sharpe));
    });

    it('counts observations from the scored sample, not from the trades or the window', () => {
      expect(computeMetrics(series(FLAT_ISH), trades([trade()])).observations).toBe(
        FLAT_ISH.length,
      );
      expect(computeMetrics(series(FLAT_ISH.slice(0, 5)), trades([trade()])).observations).toBe(5);
    });

    it('is unaffected by periodsPerYear in the per-period Sharpe, and affected in the factor', () => {
      // The annualization base is the one thing that separates the two, so the
      // stock/crypto split (252 vs 365) must move the factor and nothing else.
      const stocks = computeMetrics(series(FLAT_ISH, 252), trades([trade()]));
      const crypto = computeMetrics(series(FLAT_ISH, 365), trades([trade()]));

      expect(crypto.per_period_sharpe).toBeCloseTo(stocks.per_period_sharpe, 12);
      expect(crypto.annualization_factor).not.toBeCloseTo(stocks.annualization_factor, 6);
    });
  });

  describe('sharpe — Lo (2002) annualization', () => {
    /**
     * The discriminating test: positively autocorrelated returns have a
     * q-period variance larger than q times the per-period variance, so the
     * naive ×√q overstates their annualized Sharpe. If this passes with the
     * naive factor, the adjustment is not there.
     */
    it('reports a lower Sharpe than naive x-root-q on positively autocorrelated returns', () => {
      // AR(1) with phi = +0.6 — the momentum/trend shape this system trades.
      // 12 periods/year keeps max-lag at 11 (well within the 60 obs window)
      // so the autocorrelation estimates at the tail are stable.
      const autocorrelated = arOne(0.6, 60);
      const periodsPerYear = 12;

      const { sharpe } = computeMetrics(series(autocorrelated, periodsPerYear), trades([trade()]));
      const naive = perPeriodSharpe(autocorrelated) * Math.sqrt(periodsPerYear);

      expect(Math.abs(sharpe)).toBeLessThan(Math.abs(naive));
    });

    it('reports a higher Sharpe than naive x-root-q on negatively autocorrelated returns', () => {
      const meanReverting = arOne(-0.4, 60);
      const periodsPerYear = 12;

      const { sharpe } = computeMetrics(series(meanReverting, periodsPerYear), trades([trade()]));
      const naive = perPeriodSharpe(meanReverting) * Math.sqrt(periodsPerYear);

      expect(Math.abs(sharpe)).toBeGreaterThan(Math.abs(naive));
    });

    it('collapses to naive x-root-q when returns have no serial correlation', () => {
      // Perfectly alternating around a mean has rho_k that cancel over the
      // Bartlett weights only approximately, so use a series built to have
      // ~zero autocorrelation at every lag: a single non-zero deviation.
      const returns = [0.02, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01];
      const periodsPerYear = 4;

      const { sharpe } = computeMetrics(series(returns, periodsPerYear), trades([trade()]));
      const naive = perPeriodSharpe(returns) * Math.sqrt(periodsPerYear);

      // Not exactly equal — the sample rho_k are not exactly zero — but the
      // adjustment must not move a near-uncorrelated series far.
      expect(sharpe).toBeCloseTo(naive, 0);
    });
  });

  it('computes max_drawdown as a positive peak-to-trough fraction of compounded equity', () => {
    // 1.0 -> 1.5 -> 0.75 -> 0.9: worst decline is 0.75/1.5, i.e. 50%.
    const { max_drawdown } = computeMetrics(series([0.5, -0.5, 0.2]), trades([trade()]));

    expect(max_drawdown).toBeCloseTo(0.5, 10);
  });

  it('computes profit_factor as gross wins over gross losses', () => {
    const { profit_factor } = computeMetrics(
      series(FLAT_ISH),
      trades([trade({ pnl: 300 }), trade({ pnl: 100 }), trade({ pnl: -200 })]),
    );

    expect(profit_factor).toBeCloseTo(400 / 200, 10);
  });

  it('computes expectancy as (P_win x AvgWin) - (P_loss x AvgLoss)', () => {
    const { expectancy } = computeMetrics(
      series(FLAT_ISH),
      trades([
        trade({ pnl: 300 }),
        trade({ pnl: 100 }),
        trade({ pnl: -200 }),
        trade({ pnl: -100 }),
      ]),
    );

    // 0.5 * 200 - 0.5 * 150 = 25
    expect(expectancy).toBeCloseTo(25, 10);
  });

  it('computes turnover as traded notional over average capital', () => {
    const { turnover } = computeMetrics(
      series(FLAT_ISH),
      trades([trade({ notional: 30_000 }), trade({ notional: 20_000 })], 100_000),
    );

    expect(turnover).toBeCloseTo(0.5, 10);
  });

  describe('exposure', () => {
    it('is the fraction of the window with a position open', () => {
      // 2 of the window's 10 days.
      const { exposure } = computeMetrics(
        series(FLAT_ISH),
        trades([
          trade({
            opened_at: new Date('2026-01-01T00:00:00Z'),
            closed_at: new Date('2026-01-03T00:00:00Z'),
          }),
        ]),
      );

      expect(exposure).toBeCloseTo(0.2, 10);
    });

    it('merges concurrent trades rather than summing them', () => {
      // Two instruments held over the same 2 days is 2 days of exposure, not
      // 4 — a diversified portfolio is not 40% exposed because it holds two
      // names, and summing would report exposure > 1 for a fully-invested one.
      const { exposure } = computeMetrics(
        series(FLAT_ISH),
        trades([
          trade({
            instrument: 'SPY',
            opened_at: new Date('2026-01-01T00:00:00Z'),
            closed_at: new Date('2026-01-03T00:00:00Z'),
          }),
          trade({
            instrument: 'QQQ',
            opened_at: new Date('2026-01-02T00:00:00Z'),
            closed_at: new Date('2026-01-03T00:00:00Z'),
          }),
        ]),
      );

      expect(exposure).toBeCloseTo(0.2, 10);
    });
  });

  it('reports excess kurtosis, so a flat-tailed sample is not silently +3', () => {
    const { kurtosis } = computeMetrics(series(FLAT_ISH), trades([trade()]));

    // Whatever the value, it is excess: a normal-ish sample sits near 0, not 3.
    expect(kurtosis).toBeLessThan(3);
  });

  describe('refuses to report a degenerate number', () => {
    it('throws on a zero-variance return series rather than reporting Sharpe 0', () => {
      expect(() => computeMetrics(series([0.01, 0.01, 0.01]), trades([trade()]))).toThrow(
        /zero variance/,
      );
    });

    it('throws on a series too short to estimate dispersion', () => {
      expect(() => computeMetrics(series([0.01]), trades([trade()]))).toThrow(/at least 2/);
    });

    it('throws when averageCapital is zero rather than dividing by it', () => {
      expect(() => computeMetrics(series(FLAT_ISH), trades([trade()], 0))).toThrow(
        /averageCapital must be > 0/,
      );
    });
  });
});

/** Deterministic AR(1): r_t = phi * r_{t-1} + e_t, with a fixed sawtooth for e. */
function arOne(phi: number, length: number): number[] {
  const returns: number[] = [];
  let previous = 0.01;

  // Simple mulberry32 PRNG seeded to 42 for reproducibility.
  let state = 42;
  const rand = () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  for (let t = 0; t < length; t++) {
    const noise = 0.004 * (rand() - 0.5); // zero-mean, bounded
    const value = phi * previous + noise;
    returns.push(value);
    previous = value;
  }

  return returns;
}

function perPeriodSharpe(returns: number[]): number {
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance =
    returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  return mean / Math.sqrt(variance);
}
