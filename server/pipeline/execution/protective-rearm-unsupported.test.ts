/**
 * The permanent-gap discriminator (#1214) and the ONE boundary that can
 * silently erase it
 */
import { sanitizeBrokerError } from './broker-error.js';
import {
  isProtectiveRearmUnsupported,
  ProtectiveRearmUnsupportedError,
} from './protective-rearm-unsupported.js';

describe('isProtectiveRearmUnsupported (#1214)', () => {
  it('accepts the typed refusal and keeps the venue on it', () => {
    const error = new ProtectiveRearmUnsupportedError('saxo', 'no entry-less protective pair');

    expect(isProtectiveRearmUnsupported(error)).toBe(true);
    expect(error.venue).toBe('saxo');
    expect(error).toBeInstanceOf(Error);
  });

  it('rejects an ordinary failure, so a bad minute at the venue still reads as retryable', () => {
    expect(isProtectiveRearmUnsupported(new Error('venue briefly unreachable'))).toBe(false);
    expect(isProtectiveRearmUnsupported(undefined)).toBe(false);
    expect(isProtectiveRearmUnsupported(null)).toBe(false);
    expect(isProtectiveRearmUnsupported('protectiveRearmUnsupported')).toBe(false);
    expect(isProtectiveRearmUnsupported({ protectiveRearmUnsupported: 'yes' })).toBe(false);
  });

  it('does NOT survive sanitizeBrokerError — the invariant every adapter must respect', () => {
    // `sanitizeBrokerError` keeps only the fields `BrokerError` chose, so an
    // adapter that threw this INSIDE its `this.call` wrapper would hand the
    // #549 sweep a plain retryable error and silently restore the
    // "permanent gap reads as transient" behaviour (#1214). Pinned here so
    // the erasure is a visible property of the boundary rather than a
    // surprise found in production; `saxo-adapter.test.ts` pins the other
    // half — that the live adapter throws it outside that wrapper
    const wrapped = sanitizeBrokerError(
      'saxo',
      'rearmProtectiveLegs',
      new ProtectiveRearmUnsupportedError('saxo', 'no entry-less protective pair'),
    );

    expect(isProtectiveRearmUnsupported(wrapped)).toBe(false);
  });
});
