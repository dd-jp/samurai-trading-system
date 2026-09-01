import {
  formatTickPrice,
  roundBracketToTick,
  roundProtectiveLegsToTick,
  snapToTick,
  tickFor,
} from './us-equity-price-tick.js';

describe('tickFor', () => {
  it('is a penny at and above one dollar', () => {
    expect(tickFor(1)).toBe(0.01);
    expect(tickFor(762.335)).toBe(0.01);
  });

  it('is a hundredth of a penny below one dollar', () => {
    expect(tickFor(0.9999)).toBe(0.0001);
    expect(tickFor(0.0525)).toBe(0.0001);
  });
});

describe('snapToTick', () => {
  it('leaves an already-valid price exactly alone in both directions', () => {
    // The float-dust guard, on values that ACTUALLY carry dust. `766.41/0.01`
    // is exactly 76641, so it proves nothing; these do not divide cleanly:
    //   1.11 / 0.01 = 111.00000000000001  -> a bare ceil bumps it to 1.12
    //   1.13 / 0.01 = 112.99999999999999  -> a bare floor drops it to 1.12
    // A price the venue would have accepted verbatim must come back unchanged
    // in BOTH directions. These sit in the penny range ADR-0016's LSE ETP
    // universe trades in, so this is the live case, not a contrived one.
    expect(snapToTick(1.11, 'up')).toBe(1.11);
    expect(snapToTick(1.13, 'down')).toBe(1.13);
    expect(snapToTick(2.22, 'up')).toBe(2.22);
    expect(snapToTick(1.18, 'down')).toBe(1.18);
    // Sub-dollar grid: 0.0003 / 0.0001 = 2.9999999999999996.
    expect(snapToTick(0.0003, 'down')).toBe(0.0003);
    expect(snapToTick(766.41, 'up')).toBe(766.41);
    expect(snapToTick(762.34, 'up')).toBe(762.34);
  });

  it('rounds toward the named direction, never the nearer side', () => {
    expect(snapToTick(766.40805334, 'down')).toBe(766.4);
    expect(snapToTick(766.40805334, 'up')).toBe(766.41);
    // 762.335 is nearer 762.34, but 'down' must still go down.
    expect(snapToTick(762.335, 'down')).toBe(762.33);
  });

  it('returns a value that survives its own string form', () => {
    // The whole point: `76641 * 0.01` is not 766.41, and String()-ing that
    // onto the wire is refused for the same reason as the unrounded price.
    expect(String(snapToTick(766.40805334, 'up'))).toBe('766.41');
  });

  it('uses the sub-dollar grid below a dollar', () => {
    expect(snapToTick(0.05253491, 'down')).toBe(0.0525);
    expect(snapToTick(0.05253491, 'up')).toBe(0.0526);
  });

  it('refuses a non-positive or non-finite price rather than emitting one', () => {
    expect(() => snapToTick(0, 'up')).toThrow(/positive finite/);
    expect(() => snapToTick(Number.NaN, 'up')).toThrow(/positive finite/);
  });
});

describe('formatTickPrice', () => {
  it('emits two decimals at or above a dollar and four below', () => {
    expect(formatTickPrice(766.4)).toBe('766.40');
    expect(formatTickPrice(0.0525)).toBe('0.0525');
  });
});

describe('roundBracketToTick', () => {
  /**
   * The live shape. Both rejections on 2026-09-01 were `side: 'sell'`, so the
   * short branch is the one on the live path, not the long.
   */
  it('rounds the SPY short that the venue actually refused', () => {
    const rounded = roundBracketToTick('sell', 762.335, 766.40805334, 754.18889332);

    // Entry UP: a short's limit is the least it will accept.
    expect(rounded.entry).toBe(762.34);
    // Stop DOWN: a short's stop sits above the entry, so down is a smaller loss.
    expect(rounded.stop).toBe(766.4);
    // Target UP: below the entry, so up is the earlier, easier fill.
    expect(rounded.target).toBe(754.19);
  });

  it('never widens a short position risk', () => {
    const { stop, target, entry } = roundBracketToTick('sell', 762.335, 766.40805334, 754.18889332);
    expect(stop).toBeLessThanOrEqual(766.40805334);
    expect(target).toBeGreaterThanOrEqual(754.18889332);
    expect(entry).toBeGreaterThanOrEqual(762.335);
  });

  it('never widens a long position risk', () => {
    const { stop, target, entry } = roundBracketToTick('buy', 707.19456, 700.11234, 719.98765);
    expect(stop).toBeGreaterThanOrEqual(700.11234);
    expect(target).toBeLessThanOrEqual(719.98765);
    expect(entry).toBeLessThanOrEqual(707.19456);
    expect(stop).toBe(700.12);
    expect(target).toBe(719.98);
    expect(entry).toBe(707.19);
  });

  it('keeps a long ordered stop < entry < target', () => {
    const { stop, entry, target } = roundBracketToTick('buy', 100.004, 99.986, 100.024);
    expect(stop).toBeLessThan(entry);
    expect(entry).toBeLessThan(target);
  });

  it('resolves the tick per LEG, so a bracket straddling a dollar uses both grids', () => {
    // The reason `tickFor` is called per price rather than once per order: a
    // long entered just above a dollar has its stop on the finer grid and its
    // target on the coarser one, in the SAME bracket.
    expect(roundBracketToTick('buy', 1.004567, 0.98765432, 1.114567)).toEqual({
      // >= $1: penny grid, rounded down for a long entry.
      entry: 1,
      // < $1: hundredth-of-a-penny grid, rounded up (toward the entry).
      stop: 0.9877,
      // >= $1 again: penny grid, rounded down.
      target: 1.11,
    });
  });

  it('refuses a bracket that rounding collapses rather than submitting it inverted', () => {
    // Sub-tick wide: every leg lands on 100.00.
    expect(() => roundBracketToTick('buy', 100.001, 99.9995, 100.002)).toThrow(
      /collapsed the bracket/,
    );
    expect(() => roundBracketToTick('sell', 100.001, 100.002, 99.9995)).toThrow(
      /collapsed the bracket/,
    );
  });

  it('passes an already-on-grid bracket through untouched', () => {
    expect(roundBracketToTick('sell', 762.34, 766.4, 754.19)).toEqual({
      entry: 762.34,
      stop: 766.4,
      target: 754.19,
    });
  });
});

describe('roundProtectiveLegsToTick', () => {
  it('rounds a held short toward its entry', () => {
    expect(roundProtectiveLegsToTick('sell', 766.40805334, 754.18889332)).toEqual({
      stop: 766.4,
      target: 754.19,
    });
  });

  it('rounds a held long toward its entry', () => {
    expect(roundProtectiveLegsToTick('buy', 700.11234, 719.98765)).toEqual({
      stop: 700.12,
      target: 719.98,
    });
  });

  it('refuses legs that rounding collapses', () => {
    expect(() => roundProtectiveLegsToTick('buy', 100.0006, 100.0004)).toThrow(
      /collapsed the bracket/,
    );
  });
});
