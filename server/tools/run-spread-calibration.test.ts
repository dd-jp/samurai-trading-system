import {
  bucketSampleEnd,
  CALIBRATION_WINDOW,
  INTRADAY_CALIBRATION_WINDOW,
  SESSION_BUCKETS,
  sampleDates,
  usEquityCloseUtc,
  usEquityOpenUtc,
} from './run-spread-calibration.js';
import {
  CALIBRATED_COST_CONFIG,
  CALIBRATED_INTRADAY_COST_CONFIG,
  costConfigFor,
  costConfigFromEnv,
  PESSIMISTIC_COST_CONFIG,
} from './run-stage2.js';
import { STAGE2_FREE_STACK_WINDOW } from './stage2-source.js';

describe('usEquityCloseUtc', () => {
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

describe('the intraday sampling geometry (#875)', () => {
  it('opens 6.5 hours before the close, under both DST regimes', () => {
    expect(usEquityOpenUtc(new Date('2025-06-11T00:00:00Z')).toISOString()).toBe(
      '2025-06-11T13:30:00.000Z',
    );
    expect(usEquityOpenUtc(new Date('2025-01-15T00:00:00Z')).toISOString()).toBe(
      '2025-01-15T14:30:00.000Z',
    );
  });

  it('samples strictly inside the session, excluding both auctions', () => {
    const date = new Date('2025-06-11T00:00:00Z');
    const open = usEquityOpenUtc(date).getTime();
    const close = usEquityCloseUtc(date).getTime();

    for (const bucket of SESSION_BUCKETS) {
      const end = bucketSampleEnd(date, bucket.minutesAfterOpen).getTime();
      expect(end - 60_000).toBeGreaterThan(open);
      expect(end).toBeLessThan(close);
    }
  });

  it('spreads its buckets across the session rather than sampling one moment', () => {
    const date = new Date('2025-06-11T00:00:00Z');
    const ends = SESSION_BUCKETS.map((b) => bucketSampleEnd(date, b.minutesAfterOpen).getTime());

    for (let i = 1; i < ends.length; i++) {
      expect(ends[i] as number).toBeGreaterThan(ends[i - 1] as number);
    }
    const span = (ends.at(-1) as number) - (ends[0] as number);
    expect(span).toBeGreaterThan(5 * 60 * 60_000);
  });

  it('samples the window an intraday Stage 2 run actually replays', () => {
    expect(INTRADAY_CALIBRATION_WINDOW).toBe(STAGE2_FREE_STACK_WINDOW);
    expect(INTRADAY_CALIBRATION_WINDOW.start.getTime()).toBeLessThan(
      CALIBRATION_WINDOW.start.getTime(),
    );
  });
});

describe('CALIBRATED_COST_CONFIG', () => {
  it('prices spread far below the uncalibrated fixture', () => {
    expect(CALIBRATED_COST_CONFIG.stocks.spreadVolatilityCoefficient).toBeLessThan(
      PESSIMISTIC_COST_CONFIG.stocks.spreadVolatilityCoefficient / 20,
    );
    expect(CALIBRATED_COST_CONFIG.crypto.spreadVolatilityCoefficient).toBeLessThan(
      PESSIMISTIC_COST_CONFIG.crypto.spreadVolatilityCoefficient / 15,
    );
  });

  it('raises the crypto commission to the published taker fee', () => {
    expect(CALIBRATED_COST_CONFIG.crypto.commissionRate).toBe(0.0025);
    expect(CALIBRATED_COST_CONFIG.crypto.commissionRate).toBeGreaterThan(
      PESSIMISTIC_COST_CONFIG.crypto.commissionRate,
    );
  });

  it('leaves the equity commission to the structural floor rather than inventing a rate', () => {
    expect(CALIBRATED_COST_CONFIG.stocks.commissionRate).toBe(0);
  });

  it('derives slippage from the measured spread rather than asserting a new number', () => {
    for (const assetClass of ['crypto', 'stocks'] as const) {
      expect(CALIBRATED_COST_CONFIG[assetClass].slippageCoefficient).toBeCloseTo(
        CALIBRATED_COST_CONFIG[assetClass].spreadVolatilityCoefficient / 4,
        10,
      );
    }
  });

  it('leaves market impact at the pessimistic value', () => {
    expect(CALIBRATED_COST_CONFIG.crypto.impactK).toBe(PESSIMISTIC_COST_CONFIG.crypto.impactK);
    expect(CALIBRATED_COST_CONFIG.stocks.impactK).toBe(PESSIMISTIC_COST_CONFIG.stocks.impactK);
  });
});

describe('costConfigFor — the timeframe-keyed cost config (#875)', () => {
  it('leaves a daily run on exactly the config every recorded daily result used', () => {
    expect(costConfigFor('1d')).toBe(CALIBRATED_COST_CONFIG);
    expect(costConfigFor('1d')).toEqual({
      crypto: {
        spreadVolatilityCoefficient: 0.028,
        commissionRate: 0.0025,
        slippageCoefficient: 0.007,
        impactK: 0.1,
      },
      stocks: {
        spreadVolatilityCoefficient: 0.0037,
        commissionRate: 0,
        slippageCoefficient: 0.000925,
        impactK: 0.05,
      },
    });
  });

  it('switches an intraday run onto the intraday-fitted config', () => {
    expect(costConfigFor('1m')).toBe(CALIBRATED_INTRADAY_COST_CONFIG);
    expect(costConfigFor('5m')).toBe(CALIBRATED_INTRADAY_COST_CONFIG);
  });

  it('prices the intraday spread ratio far above the daily one', () => {
    expect(CALIBRATED_INTRADAY_COST_CONFIG.stocks.spreadVolatilityCoefficient).toBeGreaterThan(
      CALIBRATED_COST_CONFIG.stocks.spreadVolatilityCoefficient * 10,
    );
  });

  it('derives intraday slippage by the daily config own rule rather than a new one', () => {
    expect(CALIBRATED_INTRADAY_COST_CONFIG.stocks.slippageCoefficient).toBeCloseTo(
      CALIBRATED_INTRADAY_COST_CONFIG.stocks.spreadVolatilityCoefficient / 4,
      10,
    );
  });

  it('leaves the unreachable crypto branch on the pessimistic fixture', () => {
    expect(CALIBRATED_INTRADAY_COST_CONFIG.crypto).toBe(PESSIMISTIC_COST_CONFIG.crypto);
  });

  it('carries a Saxo-keyed commission override at ADR-0015:201s 8bps rate', () => {
    expect(CALIBRATED_INTRADAY_COST_CONFIG.venues?.saxo?.commissionRate).toBe(0.0008);
    expect(CALIBRATED_INTRADAY_COST_CONFIG.stocks.commissionRate).toBe(0);
  });

  it('honours SAMURAI_STAGE2_COST_CONFIG=pessimistic at both resolutions', () => {
    for (const timeframe of ['1d', '1m']) {
      expect(costConfigFor(timeframe, { SAMURAI_STAGE2_COST_CONFIG: 'pessimistic' })).toBe(
        PESSIMISTIC_COST_CONFIG,
      );
    }
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
