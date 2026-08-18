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

describe('the intraday sampling geometry (#875)', () => {
  it('opens 6.5 hours before the close, under both DST regimes', () => {
    expect(usEquityOpenUtc(new Date('2025-06-11T00:00:00Z')).toISOString()).toBe(
      '2025-06-11T13:30:00.000Z',
    );
    expect(usEquityOpenUtc(new Date('2025-01-15T00:00:00Z')).toISOString()).toBe(
      '2025-01-15T14:30:00.000Z',
    );
  });

  /**
   * The load-bearing exclusion. A quote timestamped at an auction is an
   * artifact, not a tradeable two-sided market — a live probe returned SPY at
   * 752.40/799.00 at the bell — and at minute resolution the opening print
   * would otherwise dominate the first bucket. Both ends are excluded, and
   * symmetrically: excluding only one would bias the fit toward whichever
   * artifact survived.
   */
  it('samples strictly inside the session, excluding both auctions', () => {
    const date = new Date('2025-06-11T00:00:00Z');
    const open = usEquityOpenUtc(date).getTime();
    const close = usEquityCloseUtc(date).getTime();

    for (const bucket of SESSION_BUCKETS) {
      const end = bucketSampleEnd(date, bucket.minutesAfterOpen).getTime();
      // The sampled minute is [end - 60s, end), so its START must clear the
      // opening print and its END must stop short of the bell.
      expect(end - 60_000).toBeGreaterThan(open);
      expect(end).toBeLessThan(close);
    }
  });

  /** One reading a session would be the most flattering point on a U-shaped curve. */
  it('spreads its buckets across the session rather than sampling one moment', () => {
    const date = new Date('2025-06-11T00:00:00Z');
    const ends = SESSION_BUCKETS.map((b) => bucketSampleEnd(date, b.minutesAfterOpen).getTime());

    for (let i = 1; i < ends.length; i++) {
      expect(ends[i] as number).toBeGreaterThan(ends[i - 1] as number);
    }
    const span = (ends.at(-1) as number) - (ends[0] as number);
    expect(span).toBeGreaterThan(5 * 60 * 60_000);
  });

  /**
   * The ratio being fit is a ratio of two quantities that must come from the
   * same period — the daily calibration's own stated discipline. The intraday
   * fit is consumed by an intraday Stage 2 run, which replays
   * `STAGE2_FREE_STACK_WINDOW`, so the fit must sample that window and not the
   * daily fit's Polygon-bounded two years.
   */
  it('samples the window an intraday Stage 2 run actually replays', () => {
    expect(INTRADAY_CALIBRATION_WINDOW).toBe(STAGE2_FREE_STACK_WINDOW);
    expect(INTRADAY_CALIBRATION_WINDOW.start.getTime()).toBeLessThan(
      CALIBRATION_WINDOW.start.getTime(),
    );
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

describe('costConfigFor — the timeframe-keyed cost config (#875)', () => {
  /**
   * The reproducibility guarantee, asserted rather than assumed. Every recorded
   * Stage 2 result was computed at daily resolution under
   * `CALIBRATED_COST_CONFIG`; if keying by timeframe moved what a daily run
   * charges, none of them would still reproduce.
   */
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

  /**
   * The direction is the measurement, not a preference: ATR14 on 1-minute bars
   * is ~20x smaller than on daily bars while the quoted spread is not, so the
   * fitted RATIO is far larger intraday. A config whose intraday coefficient
   * were at or below the daily one would be the flattering model this ticket
   * exists to remove, and would pass every other test here.
   */
  it('prices the intraday spread ratio far above the daily one', () => {
    expect(CALIBRATED_INTRADAY_COST_CONFIG.stocks.spreadVolatilityCoefficient).toBeGreaterThan(
      CALIBRATED_COST_CONFIG.stocks.spreadVolatilityCoefficient * 10,
    );
  });

  /** Same declared rule as the daily config — half of the half-spread, flagged as an assumption. */
  it('derives intraday slippage by the daily config own rule rather than a new one', () => {
    expect(CALIBRATED_INTRADAY_COST_CONFIG.stocks.slippageCoefficient).toBeCloseTo(
      CALIBRATED_INTRADAY_COST_CONFIG.stocks.spreadVolatilityCoefficient / 4,
      10,
    );
  });

  /**
   * Unreachable — an intraday Stage 2 run is equities-only (`universeFor`) and
   * crypto left scope on 2026-08-16 — so it carries the PESSIMISTIC fixture
   * rather than a calibrated number nobody measured. If a future path does
   * reach it, it over-charges rather than flatters.
   */
  it('leaves the unreachable crypto branch on the pessimistic fixture', () => {
    expect(CALIBRATED_INTRADAY_COST_CONFIG.crypto).toBe(PESSIMISTIC_COST_CONFIG.crypto);
  });

  /** The comparison escape hatch still wins, at every resolution. */
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
