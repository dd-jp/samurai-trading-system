import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VENUE_PACING,
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

    expect(resolved.ccxt).toEqual({ capacity: 4, refillPerSecond: 2.5 });
    expect(resolved.alpaca).toEqual(DEFAULT_VENUE_PACING.alpaca);
    expect(resolved.ibkr).toEqual(DEFAULT_VENUE_PACING.ibkr);
  });

  it('allows one half of a venue pair to be overridden alone', () => {
    const resolved = resolveVenuePacing({ SAMURAI_PACING_ALPACA_REFILL_PER_SEC: '2' });

    expect(resolved.alpaca).toEqual({
      capacity: DEFAULT_VENUE_PACING.alpaca.capacity,
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
    });
  });

  it('every default sits at or under its own documented ceiling', () => {
    for (const [venue, ceiling] of Object.entries(VENUE_DOCUMENTED_CEILING_PER_SECOND)) {
      if (ceiling === undefined) continue;
      const key = venue as keyof typeof DEFAULT_VENUE_PACING;
      expect(DEFAULT_VENUE_PACING[key].refillPerSecond).toBeLessThanOrEqual(ceiling);
    }
  });

  it('names both env vars for a venue so an operator can be told what to set', () => {
    expect(venuePacingEnvVars('alpaca')).toEqual({
      capacity: 'SAMURAI_PACING_ALPACA_CAPACITY',
      refillPerSecond: 'SAMURAI_PACING_ALPACA_REFILL_PER_SEC',
    });
  });
});
