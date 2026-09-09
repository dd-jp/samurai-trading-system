import {
  DEFAULT_POLYGON_PACING,
  DEFAULT_VENUE_PACING,
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

  /**
   * The whole reason this is validated rather than trusted: a rate set ABOVE
   * the venue's published limit is not a slow system, it is a banned API key.
   */
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

  /**
   * Polygon is deliberately NOT a `VenueKey` (#510/#520 — see the `VenueKey`
   * doc in `venue-pacing.ts` for the live-boot-risk reasoning), so
   * `resolveVenuePacing()` itself must never read or validate
   * `SAMURAI_PACING_POLYGON_*`. This is the direction of isolation that
   * protects `production.ts`, the LIVE composition root: a malformed
   * Stage-2-only override must not be able to fail orchestrator boot.
   */
  it('never reads or validates SAMURAI_PACING_POLYGON_* — a malformed override does not throw', () => {
    expect(() =>
      resolveVenuePacing({ SAMURAI_PACING_POLYGON_REFILL_PER_SEC: 'not-a-number' }),
    ).not.toThrow();
    expect(resolveVenuePacing({ SAMURAI_PACING_POLYGON_REFILL_PER_SEC: 'not-a-number' })).toEqual(
      DEFAULT_VENUE_PACING,
    );
  });

  /**
   * ccxt is the one venue with no ceiling to check against, because no crypto
   * venue OR account tier has been chosen yet (CLAUDE.md: "Kraken or Coinbase
   * Advanced"). Inventing a ceiling here would be exactly the fabricated
   * number #299 asks us not to produce, so the operator is trusted and the
   * default stays at the conservative floor.
   */
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

  /**
   * #299's premise is that "a rate limit is a property of the account, not of
   * the code". A ceiling raisable only by editing a source constant would
   * re-hardcode exactly that, in the one direction an operator needs it —
   * Alpaca grants raised allowances on request. So the ceiling itself is ops
   * config, and stating it is a separate deliberate act from tuning the rate.
   */
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

/**
 * #510/#520: Polygon's pacing is resolved through its own entry point, NOT
 * folded into `resolveVenuePacing()`/`VENUE_KEYS` — see the `VenueKey` doc
 * in `venue-pacing.ts`. These tests cover the same parsing/validation
 * ground `resolveVenuePacing`'s tests do (via the shared `resolveBucketPacing`
 * extraction), plus the isolation property that is the whole point of the
 * split: neither resolver's env-var namespace can affect the other.
 */
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

  /**
   * The other direction of isolation from the `resolveVenuePacing` test
   * above: Polygon's own resolver must not be tripped by a malformed
   * override for a venue it never touches, either — the original
   * diagnosability complaint (#520 review, second cycle) that a Stage 2
   * operator's construction shouldn't fail on an Alpaca/IBKR typo.
   */
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
