/**
 * The bounds table and its validator (#638, CV-15 / GAP-6).
 *
 * These cover the TABLE. The acceptance criterion — "sets each guarded value
 * beyond its line and asserts the system refuses to boot" — is covered at the
 * seams that actually put a number into force, in
 * `server/pipeline/risk-manager/threshold-clamp.test.ts` and
 * `server/pipeline/feedback-loop/threshold-clamp.test.ts`, because a test that
 * only calls the validator proves the table and not the wiring.
 */
import {
  assertThresholdsWithinBounds,
  assertThresholdWithinBounds,
  boundFor,
  GUARDED_THRESHOLD_BOUNDS,
  GUARDED_THRESHOLD_NAMES,
  type ThresholdBound,
  ThresholdBoundViolationError,
} from './threshold-bounds.js';

describe('GUARDED_THRESHOLD_BOUNDS', () => {
  it('guards exactly the names the specs record, and no others by accident', () => {
    expect([...GUARDED_THRESHOLD_NAMES].sort()).toEqual([
      'daily_loss_pct',
      'daily_loss_pct_crypto',
      'daily_loss_pct_stocks',
      'max_drawdown_pct',
      'max_pbo',
      'min_deflated_sharpe',
      'min_oos_sharpe',
      'recovery_drawdown_pct',
    ]);
  });

  it('carries a citable source on every bound — an uncited limit is invented', () => {
    for (const name of GUARDED_THRESHOLD_NAMES) {
      expect(GUARDED_THRESHOLD_BOUNDS[name].source.length).toBeGreaterThan(0);
    }
  });

  it('states at least one edge per entry — a bound with neither is decoration', () => {
    for (const name of GUARDED_THRESHOLD_NAMES) {
      const bound: ThresholdBound = GUARDED_THRESHOLD_BOUNDS[name];
      expect(bound.min !== undefined || bound.max !== undefined).toBe(true);
    }
  });

  it('holds PBO at the one hard kill criterion the record states', () => {
    expect(GUARDED_THRESHOLD_BOUNDS.max_pbo.max).toBe(0.05);
  });
});

describe('assertThresholdWithinBounds', () => {
  it('accepts a value inside its bound', () => {
    expect(() => assertThresholdWithinBounds('max_pbo', 0.05, 'test')).not.toThrow();
    expect(() => assertThresholdWithinBounds('max_drawdown_pct', 0.3, 'test')).not.toThrow();
  });

  it('REFUSES rather than coerces — a silently clamped value reads as accepted', () => {
    let thrown: unknown;
    try {
      assertThresholdWithinBounds('max_pbo', 0.5, 'test');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ThresholdBoundViolationError);
    const violation = thrown as ThresholdBoundViolationError;
    // The offending value survives into the message: an operator must be able
    // to fix the config without attaching a debugger.
    expect(violation.value).toBe(0.5);
    expect(violation.threshold).toBe('max_pbo');
    expect(violation.message).toContain('at most 0.05');
    expect(violation.message).toContain('REFUSED, not clamped');
  });

  it('refuses a floor crossing in the other direction too', () => {
    expect(() => assertThresholdWithinBounds('min_oos_sharpe', 0.4, 'test')).toThrow(
      ThresholdBoundViolationError,
    );
    expect(() => assertThresholdWithinBounds('min_deflated_sharpe', 0.9, 'test')).toThrow(
      ThresholdBoundViolationError,
    );
  });

  it('refuses NaN wherever a bound exists — it compares false against both edges', () => {
    expect(() => assertThresholdWithinBounds('max_pbo', Number.NaN, 'test')).toThrow(
      ThresholdBoundViolationError,
    );
    expect(() => assertThresholdWithinBounds('max_drawdown_pct', Number.NaN, 'test')).toThrow(
      ThresholdBoundViolationError,
    );
  });

  it('leaves an unguarded name alone — inventing a limit no document states is worse', () => {
    expect(boundFor('max_position_size')).toBeUndefined();
    expect(() => assertThresholdWithinBounds('max_position_size', 1_000_000, 'test')).not.toThrow();
  });

  it('does not treat an inherited Object property as a bound', () => {
    expect(boundFor('toString')).toBeUndefined();
    expect(() => assertThresholdWithinBounds('toString', 999, 'test')).not.toThrow();
  });

  it('names the site so the refusal says WHICH path rejected the value', () => {
    expect(() => assertThresholdWithinBounds('max_pbo', 0.5, 'SomeCallSite')).toThrow(
      /^SomeCallSite: /,
    );
  });
});

describe('assertThresholdsWithinBounds', () => {
  it('skips undefined entries — absence is a different failure, owned elsewhere', () => {
    expect(() => assertThresholdsWithinBounds({ max_pbo: undefined }, 'test')).not.toThrow();
  });

  it('reports BOTH crossings at once rather than sending the operator round twice', () => {
    let thrown: unknown;
    try {
      assertThresholdsWithinBounds({ max_pbo: 0.5, min_oos_sharpe: 0.1 }, 'test');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('max_pbo');
    expect((thrown as Error).message).toContain('min_oos_sharpe');
  });

  it('throws the typed error when exactly one value crosses', () => {
    expect(() => assertThresholdsWithinBounds({ max_pbo: 0.5 }, 'test')).toThrow(
      ThresholdBoundViolationError,
    );
  });
});
