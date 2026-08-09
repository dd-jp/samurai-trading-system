import { CALIBRATION_WINDOW, sampleDates, usEquityCloseUtc } from './run-spread-calibration.js';
import {
  CALIBRATED_COST_CONFIG,
  costConfigFromEnv,
  PESSIMISTIC_COST_CONFIG,
} from './run-stage2.js';

describe('usEquityCloseUtc', () => {
  /**
   * The sample window spans several DST transitions. Sampling an EST date at
   * 20:00Z would measure an hour BEFORE the close, where spreads are tighter —
   * a silent bias toward a flattering calibration, in a script whose entire
   * purpose is to stop flattering the cost model.
   */
  it('closes at 20:00Z under EDT', () => {
    expect(usEquityCloseUtc(new Date('2025-06-11T00:00:00Z')).toISOString()).toBe(
      '2025-06-11T20:00:00.000Z',
    );
  });

  it('closes at 21:00Z under EST', () => {
    expect(usEquityCloseUtc(new Date('2025-01-15T00:00:00Z')).toISOString()).toBe(
      '2025-01-15T21:00:00.000Z',
    );
  });
});

describe('sampleDates', () => {
  it('spreads the requested count across the window, oldest first', () => {
    const dates = sampleDates(CALIBRATION_WINDOW, 4);

    expect(dates).toHaveLength(4);
    expect(dates[0]?.getTime()).toBeGreaterThanOrEqual(CALIBRATION_WINDOW.start.getTime());
    expect(dates[3]?.getTime()).toBeLessThanOrEqual(CALIBRATION_WINDOW.end.getTime());
    for (let i = 1; i < dates.length; i++) {
      expect((dates[i] as Date).getTime()).toBeGreaterThan((dates[i - 1] as Date).getTime());
    }
  });

  it('returns UTC midnights, so the close offset is applied to a clean date', () => {
    for (const date of sampleDates(CALIBRATION_WINDOW, 6)) {
      expect(date.toISOString()).toMatch(/T00:00:00\.000Z$/);
    }
  });
});

describe('CALIBRATED_COST_CONFIG', () => {
  /**
   * The measured finding, pinned so a later edit cannot quietly walk the
   * calibration back toward the fixture: real quoted spreads were 27x (stocks)
   * and 18x (crypto) narrower than the fixture assumed.
   */
  it('prices spread far below the uncalibrated fixture', () => {
    expect(CALIBRATED_COST_CONFIG.stocks.spreadVolatilityCoefficient).toBeLessThan(
      PESSIMISTIC_COST_CONFIG.stocks.spreadVolatilityCoefficient / 20,
    );
    expect(CALIBRATED_COST_CONFIG.crypto.spreadVolatilityCoefficient).toBeLessThan(
      PESSIMISTIC_COST_CONFIG.crypto.spreadVolatilityCoefficient / 15,
    );
  });

  /**
   * Calibration is NOT uniformly cheaper, and that asymmetry is the reason the
   * sensitivity ladder in #403 was labelled a diagnostic rather than a
   * forecast. Alpaca's base-tier crypto taker fee is 0.25%; the fixture had
   * 0.001, so this term moves UP.
   */
  it('raises the crypto commission to the published taker fee', () => {
    expect(CALIBRATED_COST_CONFIG.crypto.commissionRate).toBe(0.0025);
    expect(CALIBRATED_COST_CONFIG.crypto.commissionRate).toBeGreaterThan(
      PESSIMISTIC_COST_CONFIG.crypto.commissionRate,
    );
  });

  /**
   * Equities are commission-free at Alpaca; only SEC/TAF/CAT pass through on
   * sells. Rather than fabricate a rate, this is 0 and `CostModelImpl`'s
   * structural 1bp floor covers it — already more than the real pass-through.
   */
  it('leaves the equity commission to the structural floor rather than inventing a rate', () => {
    expect(CALIBRATED_COST_CONFIG.stocks.commissionRate).toBe(0);
  });

  /** Slippage is an explicit assumption: half of the half-spread. */
  it('derives slippage from the measured spread rather than asserting a new number', () => {
    for (const assetClass of ['crypto', 'stocks'] as const) {
      expect(CALIBRATED_COST_CONFIG[assetClass].slippageCoefficient).toBeCloseTo(
        CALIBRATED_COST_CONFIG[assetClass].spreadVolatilityCoefficient / 4,
        10,
      );
    }
  });

  /** Impact had no measurement basis to revise, so the pessimistic value stands. */
  it('leaves market impact at the pessimistic value', () => {
    expect(CALIBRATED_COST_CONFIG.crypto.impactK).toBe(PESSIMISTIC_COST_CONFIG.crypto.impactK);
    expect(CALIBRATED_COST_CONFIG.stocks.impactK).toBe(PESSIMISTIC_COST_CONFIG.stocks.impactK);
  });
});

describe('costConfigFromEnv', () => {
  it('defaults to the calibrated config', () => {
    expect(costConfigFromEnv({})).toBe(CALIBRATED_COST_CONFIG);
  });

  it('re-runs against the old fixture on request, for comparison', () => {
    expect(costConfigFromEnv({ SAMURAI_STAGE2_COST_CONFIG: 'pessimistic' })).toBe(
      PESSIMISTIC_COST_CONFIG,
    );
  });

  it('treats an unrecognised value as the default rather than silently picking one', () => {
    expect(costConfigFromEnv({ SAMURAI_STAGE2_COST_CONFIG: 'cheap' })).toBe(CALIBRATED_COST_CONFIG);
  });
});
