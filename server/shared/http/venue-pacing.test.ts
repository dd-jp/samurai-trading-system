import {
  DEFAULT_POLYGON_PACING,
  DEFAULT_VENUE_PACING,
  DISTINCT_BAR_WINDOWS_PER_INSTRUMENT,
  deriveAnalystDrainMs,
  deriveAnalystTimeoutMs,
  POLYGON_DOCUMENTED_CEILING_PER_SECOND,
  resolvePolygonPacing,
  resolveVenuePacing,
  VENUE_DOCUMENTED_CEILING_PER_SECOND,
  venuePacingEnvVars,
} from './venue-pacing.js';

describe('resolveVenuePacing', () => {
  it('returns the checked-in defaults when nothing is configured', () => {
    expect(resolveVenuePacing({})).toEqual(DEFAULT_VENUE_PACING);
  });

  it('treats empty and whitespace-only values as unset, like every other env read', () => {
    expect(
      resolveVenuePacing({
        SAMURAI_PACING_ALPACA_CAPACITY: '',
        SAMURAI_PACING_ALPACA_REFILL_PER_SEC: '   ',
      }),
    ).toEqual(DEFAULT_VENUE_PACING);
  });

  it('overrides one venue without disturbing the others', () => {
    const resolved = resolveVenuePacing({
      SAMURAI_PACING_CCXT_CAPACITY: '4',
      SAMURAI_PACING_CCXT_REFILL_PER_SEC: '2.5',
    });

    expect(resolved.ccxt).toEqual({ capacity: 4, refillPerSecond: 2.5, reserveForPriority: 0 });
    expect(resolved.alpaca).toEqual(DEFAULT_VENUE_PACING.alpaca);
    expect(resolved.ibkr).toEqual(DEFAULT_VENUE_PACING.ibkr);
  });

  it('allows one half of a venue pair to be overridden alone', () => {
    const resolved = resolveVenuePacing({ SAMURAI_PACING_ALPACA_REFILL_PER_SEC: '2' });

    expect(resolved.alpaca).toEqual({
      capacity: DEFAULT_VENUE_PACING.alpaca.capacity,
      reserveForPriority: DEFAULT_VENUE_PACING.alpaca.reserveForPriority,
      refillPerSecond: 2,
    });
  });

  it.each([
    ['not-a-number', 'fast'],
    ['zero', '0'],
    ['negative', '-1'],
    ['infinite', 'Infinity'],
  ])('refuses a %s refill rate rather than pacing at it', (_label, raw) => {
    expect(() => resolveVenuePacing({ SAMURAI_PACING_CCXT_REFILL_PER_SEC: raw })).toThrow(
      /SAMURAI_PACING_CCXT_REFILL_PER_SEC/,
    );
  });

  it('refuses a capacity below one — a bucket that can never mint a whole token parks forever', () => {
    expect(() => resolveVenuePacing({ SAMURAI_PACING_CCXT_CAPACITY: '0.5' })).toThrow(
      /SAMURAI_PACING_CCXT_CAPACITY/,
    );
  });

  it("refuses a sustained rate above Alpaca's documented 200 req/min", () => {
    expect(() => resolveVenuePacing({ SAMURAI_PACING_ALPACA_REFILL_PER_SEC: '10' })).toThrow(
      /documented limit/,
    );
  });

  it("refuses a sustained rate above IBKR's documented 50 msg/sec", () => {
    expect(() => resolveVenuePacing({ SAMURAI_PACING_IBKR_REFILL_PER_SEC: '100' })).toThrow(
      /documented limit/,
    );
  });

  it('never reads or validates SAMURAI_PACING_POLYGON_* — a malformed override does not throw', () => {
    expect(() =>
      resolveVenuePacing({ SAMURAI_PACING_POLYGON_REFILL_PER_SEC: 'not-a-number' }),
    ).not.toThrow();
    expect(resolveVenuePacing({ SAMURAI_PACING_POLYGON_REFILL_PER_SEC: 'not-a-number' })).toEqual(
      DEFAULT_VENUE_PACING,
    );
  });

  it('applies no ceiling to ccxt, whose venue and tier are undecided', () => {
    expect(VENUE_DOCUMENTED_CEILING_PER_SECOND.ccxt).toBeUndefined();
    expect(resolveVenuePacing({ SAMURAI_PACING_CCXT_REFILL_PER_SEC: '25' }).ccxt).toEqual({
      capacity: DEFAULT_VENUE_PACING.ccxt.capacity,
      refillPerSecond: 25,
      reserveForPriority: 0,
    });
  });

  it('every default sits at or under its own documented ceiling', () => {
    for (const [venue, ceiling] of Object.entries(VENUE_DOCUMENTED_CEILING_PER_SECOND)) {
      if (ceiling === undefined) continue;
      const key = venue as keyof typeof DEFAULT_VENUE_PACING;
      expect(DEFAULT_VENUE_PACING[key].refillPerSecond).toBeLessThanOrEqual(ceiling);
    }
  });

  it('names every env var for a venue so an operator can be told what to set', () => {
    expect(venuePacingEnvVars('alpaca')).toEqual({
      capacity: 'SAMURAI_PACING_ALPACA_CAPACITY',
      refillPerSecond: 'SAMURAI_PACING_ALPACA_REFILL_PER_SEC',
      ceilingPerSecond: 'SAMURAI_PACING_ALPACA_CEILING_PER_SEC',
      reserveForPriority: 'SAMURAI_PACING_ALPACA_PRIORITY_RESERVE',
    });
  });

  describe('an account with a documented allowance above the published default', () => {
    it('can raise the ceiling from the environment, with no code change', () => {
      const resolved = resolveVenuePacing({
        SAMURAI_PACING_ALPACA_CEILING_PER_SEC: '16.6',
        SAMURAI_PACING_ALPACA_REFILL_PER_SEC: '10',
      });

      expect(resolved.alpaca.refillPerSecond).toBe(10);
    });

    it('still refuses a rate above the RAISED ceiling', () => {
      expect(() =>
        resolveVenuePacing({
          SAMURAI_PACING_ALPACA_CEILING_PER_SEC: '16.6',
          SAMURAI_PACING_ALPACA_REFILL_PER_SEC: '20',
        }),
      ).toThrow(/documented limit of 16.6/);
    });

    it('points the operator at the ceiling variable rather than at the source', () => {
      expect(() => resolveVenuePacing({ SAMURAI_PACING_ALPACA_REFILL_PER_SEC: '10' })).toThrow(
        /SAMURAI_PACING_ALPACA_CEILING_PER_SEC/,
      );
    });

    it('refuses a nonsense ceiling rather than treating it as no ceiling', () => {
      expect(() =>
        resolveVenuePacing({ SAMURAI_PACING_ALPACA_CEILING_PER_SEC: 'unlimited' }),
      ).toThrow(/SAMURAI_PACING_ALPACA_CEILING_PER_SEC/);
    });
  });
});

describe('resolvePolygonPacing', () => {
  it('returns the checked-in default when nothing is configured', () => {
    expect(resolvePolygonPacing({})).toEqual(DEFAULT_POLYGON_PACING);
  });

  it('keeps the default at a deliberate margin under the 5 calls/min ceiling', () => {
    expect(DEFAULT_POLYGON_PACING.refillPerSecond).toBeLessThan(
      POLYGON_DOCUMENTED_CEILING_PER_SECOND,
    );
  });

  it('overrides from SAMURAI_PACING_POLYGON_*', () => {
    const resolved = resolvePolygonPacing({ SAMURAI_PACING_POLYGON_REFILL_PER_SEC: '0.05' });
    expect(resolved).toEqual({
      capacity: DEFAULT_POLYGON_PACING.capacity,
      refillPerSecond: 0.05,
      reserveForPriority: DEFAULT_POLYGON_PACING.reserveForPriority,
    });
  });

  it("refuses a sustained rate above Polygon's documented 5 calls/min free tier", () => {
    expect(() => resolvePolygonPacing({ SAMURAI_PACING_POLYGON_REFILL_PER_SEC: '1' })).toThrow(
      /documented limit/,
    );
  });

  it('names SAMURAI_PACING_POLYGON_REFILL_PER_SEC specifically when the malformed value is not a number', () => {
    expect(() =>
      resolvePolygonPacing({ SAMURAI_PACING_POLYGON_REFILL_PER_SEC: 'not-a-number' }),
    ).toThrow(/SAMURAI_PACING_POLYGON_REFILL_PER_SEC/);
  });

  it('never reads or validates an unrelated venue override — a malformed Alpaca/IBKR value does not throw', () => {
    expect(() =>
      resolvePolygonPacing({
        SAMURAI_PACING_ALPACA_REFILL_PER_SEC: 'not-a-number',
        SAMURAI_PACING_IBKR_CAPACITY: '-1',
      }),
    ).not.toThrow();
    expect(
      resolvePolygonPacing({
        SAMURAI_PACING_ALPACA_REFILL_PER_SEC: 'not-a-number',
        SAMURAI_PACING_IBKR_CAPACITY: '-1',
      }),
    ).toEqual(DEFAULT_POLYGON_PACING);
  });

  it('names its own env vars under the same SAMURAI_PACING_POLYGON_* scheme every other venue uses', () => {
    expect(venuePacingEnvVars('polygon')).toEqual({
      capacity: 'SAMURAI_PACING_POLYGON_CAPACITY',
      refillPerSecond: 'SAMURAI_PACING_POLYGON_REFILL_PER_SEC',
      ceilingPerSecond: 'SAMURAI_PACING_POLYGON_CEILING_PER_SEC',
      reserveForPriority: 'SAMURAI_PACING_POLYGON_PRIORITY_RESERVE',
    });
  });
});

describe('deriveAnalystDrainMs', () => {
  it("reproduces DEFAULT_ANALYST_TIMEOUT_MS's own derivation at the checked-in defaults", () => {
    const DEFAULT_UNIVERSE_LENGTH = 20;
    expect(deriveAnalystDrainMs(DEFAULT_VENUE_PACING.alpaca, DEFAULT_UNIVERSE_LENGTH)).toBe(30_000);
  });

  it('moves with a widened override rather than staying pinned to the default', () => {
    const widened = { capacity: 1, refillPerSecond: 0.05, reserveForPriority: 0 };
    const derived = deriveAnalystDrainMs(widened, 1);

    expect(derived).toBe(60_000);
    expect(derived).toBeGreaterThan(30_000);
  });

  it('moves the other direction too: a tighter override shrinks the deadline', () => {
    const tightened = { capacity: 41, refillPerSecond: 4, reserveForPriority: 21 };
    const derived = deriveAnalystDrainMs(tightened, 20);

    expect(derived).toBeLessThan(30_000);
  });

  it('scales sweep demand off DISTINCT_BAR_WINDOWS_PER_INSTRUMENT, not a second hardcoded count', () => {
    const pacing = { capacity: 0, refillPerSecond: 1, reserveForPriority: 0 };
    expect(deriveAnalystDrainMs(pacing, 5)).toBe(5 * DISTINCT_BAR_WINDOWS_PER_INSTRUMENT * 1_000);
  });

  it('floors at zero when headroom alone already covers the sweep', () => {
    expect(deriveAnalystDrainMs({ capacity: 1_000, refillPerSecond: 1 }, 1)).toBe(0);
  });
});

describe('deriveAnalystTimeoutMs', () => {
  it('adds the fetch-bound floor to the drain rather than taking the max of the two', () => {
    const pacing = { capacity: 1, refillPerSecond: 1, reserveForPriority: 0 };
    const drainMs = deriveAnalystDrainMs(pacing, 1);
    expect(drainMs).toBe(3_000);

    const fetchBoundMs = 5_000;
    expect(deriveAnalystTimeoutMs(pacing, 1, fetchBoundMs)).toBe(drainMs + fetchBoundMs);
    expect(deriveAnalystTimeoutMs(pacing, 1, fetchBoundMs)).not.toBe(
      Math.max(drainMs, fetchBoundMs),
    );
  });

  it('on the shipped Saxo profile (5-instrument universe), the drain floors at zero and the fetch bound alone is the deadline', () => {
    expect(deriveAnalystDrainMs(DEFAULT_VENUE_PACING.alpaca, 5)).toBe(0);

    const alpacaFetchBoundMs = 30_750;
    const deadline = deriveAnalystTimeoutMs(DEFAULT_VENUE_PACING.alpaca, 5, alpacaFetchBoundMs);

    expect(deadline).toBe(alpacaFetchBoundMs);
    expect(deadline).toBeGreaterThanOrEqual(alpacaFetchBoundMs);
    expect(deadline).toBeGreaterThanOrEqual(30_000);
  });
});
