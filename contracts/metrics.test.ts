/**
 * `toProfitFactorWire` (#1270) — the one place `MetricsSuite.profit_factor`
 * crosses into `ProfitFactorWire`. A window with wins and no losses is
 * `Number.POSITIVE_INFINITY` in-process, and `JSON.stringify` has no
 * representation for it: `JSON.stringify(Infinity) === 'null'`. These tests
 * assert on the SERIALIZED string, not just the in-process object — a test
 * that only checked `toProfitFactorWire(Infinity)` in memory would still
 * pass if the result secretly carried a non-finite `number` field, which
 * dies in `JSON.stringify` exactly like the bug this ticket closes.
 */
import { toProfitFactorWire } from './metrics.js';

describe('toProfitFactorWire', () => {
  it('is a finite ratio for an ordinary window', () => {
    expect(toProfitFactorWire(2.5)).toEqual({ kind: 'ratio', value: 2.5 });
  });

  it('is a finite ratio of 0 for a window with no closed trades at all (wins === 0 && losses === 0)', () => {
    // `profitFactor()` (sqlite-query-store.ts) returns 0 for this case, not
    // `NaN` — it must keep reading as a real, finite 0, not collapse into
    // `no_losses` or `unreadable`
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
    // The bug this ticket fixes: `JSON.stringify(Number.POSITIVE_INFINITY)`
    // is the string `'null'`. Prove the wrapped form does not take that
    // route for any of the three states
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
