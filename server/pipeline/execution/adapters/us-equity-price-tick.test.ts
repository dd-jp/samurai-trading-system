import {
  formatTickPrice,
  roundBracketToTick,
  roundProtectiveLegsToTick,
  roundTriggerToTick,
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
    expect(snapToTick(1.11, 'up')).toBe(1.11);
    expect(snapToTick(1.13, 'down')).toBe(1.13);
    expect(snapToTick(2.22, 'up')).toBe(2.22);
    expect(snapToTick(1.18, 'down')).toBe(1.18);
    expect(snapToTick(0.0003, 'down')).toBe(0.0003);
    expect(snapToTick(766.41, 'up')).toBe(766.41);
    expect(snapToTick(762.34, 'up')).toBe(762.34);
  });

  it('rounds toward the named direction, never the nearer side', () => {
    expect(snapToTick(766.40805334, 'down')).toBe(766.4);
    expect(snapToTick(766.40805334, 'up')).toBe(766.41);
    expect(snapToTick(762.335, 'down')).toBe(762.33);
  });

  it('leaves a high-priced on-tick value alone, where a flat 1e-9 bound would not', () => {
    expect(snapToTick(111848.18, 'up')).toBe(111848.18);
    expect(snapToTick(111848.18, 'down')).toBe(111848.18);
  });

  it('refuses a price that rounds down to nothing', () => {
    expect(() => snapToTick(0.00005, 'down')).toThrow(/non-positive/);
  });

  it('returns a value that survives its own string form', () => {
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
  it('rounds the SPY short that the venue actually refused', () => {
    const rounded = roundBracketToTick('sell', 762.335, 766.40805334, 754.18889332);

    expect(rounded.entry).toBe(762.34);
    expect(rounded.stop).toBe(766.4);
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
    expect(roundBracketToTick('buy', 1.004567, 0.98765432, 1.114567)).toEqual({
      entry: 1,
      stop: 0.9877,
      target: 1.11,
    });
  });

  it('refuses a bracket that rounding collapses rather than submitting it inverted', () => {
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

describe('roundTriggerToTick', () => {
  it('rounds a buy trigger up and a sell trigger down, never past the rounded limit', () => {
    expect(roundTriggerToTick('buy', 99.501, 100)).toBe(99.51);
    expect(roundTriggerToTick('buy', 99.999, 99.99)).toBe(99.99);
    expect(roundTriggerToTick('sell', 100.499, 100)).toBe(100.49);
    expect(roundTriggerToTick('sell', 100.001, 100.01)).toBe(100.01);
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
