import { toProfitFactorWire } from './metrics.js';

describe('toProfitFactorWire', () => {
  it('is a finite ratio for an ordinary window', () => {
    expect(toProfitFactorWire(2.5)).toEqual({ kind: 'ratio', value: 2.5 });
  });

  it('is a finite ratio of 0 for a window with no closed trades at all (wins === 0 && losses === 0)', () => {
    expect(toProfitFactorWire(0)).toEqual({ kind: 'ratio', value: 0 });
  });

  it('is no_losses for a flawless window (wins > 0, losses === 0)', () => {
    expect(toProfitFactorWire(Number.POSITIVE_INFINITY)).toEqual({ kind: 'no_losses' });
  });

  it('is unreadable for a value that is non-finite but not +Infinity', () => {
    expect(toProfitFactorWire(Number.NaN)).toEqual({ kind: 'unreadable' });
    expect(toProfitFactorWire(Number.NEGATIVE_INFINITY)).toEqual({ kind: 'unreadable' });
  });

  it('survives JSON.stringify -> JSON.parse for every case, unlike the bare number it replaces', () => {
    for (const input of [2.5, 0, Number.POSITIVE_INFINITY, Number.NaN, Number.NEGATIVE_INFINITY]) {
      const wire = toProfitFactorWire(input);
      const roundTripped: unknown = JSON.parse(JSON.stringify(wire));
      expect(roundTripped).toEqual(wire);
      expect(roundTripped).not.toBeNull();
    }
  });

  it('never wraps a non-finite number inside a ratio - the collapse this ticket exists to close, one field deeper', () => {
    for (const input of [2.5, 0, Number.POSITIVE_INFINITY, Number.NaN, Number.NEGATIVE_INFINITY]) {
      const wire = toProfitFactorWire(input);
      if (wire.kind === 'ratio') {
        expect(Number.isFinite(wire.value)).toBe(true);
      }
    }
  });
});
