/**
 * `safeLog`/`logCaughtFailure`/`describeThrown` (#573) — the guarantee every
 * caller inside error-handling code depends on: nothing here can itself
 * throw, no matter how hostile the logger or the caught value is.
 */
import { recordingLogger } from './recording-logger.js';
import { describeThrown, logCaughtFailure, safeLog } from './safe-log.js';
import type { Logger } from './types.js';

const TEMPLATE = { trace_id: 'trace-1', stage: 'execution', level: 'error' as const };

describe('describeThrown', () => {
  it('renders an Error by its message', () => {
    expect(describeThrown(new Error('boom'))).toBe('boom');
  });

  it('renders a string as-is', () => {
    expect(describeThrown('plain string')).toBe('plain string');
  });

  it('renders a plain object via JSON.stringify', () => {
    expect(describeThrown({ code: 'ECONNRESET' })).toBe('{"code":"ECONNRESET"}');
  });

  it('falls back to String() for a value JSON.stringify cannot render (circular)', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(describeThrown(circular)).toBe(String(circular));
  });
});

describe('safeLog', () => {
  it('forwards the entry to a healthy logger', () => {
    const logger = recordingLogger();
    safeLog(logger, { ...TEMPLATE, message: 'hello' });
    expect(logger.entries).toEqual([{ ...TEMPLATE, message: 'hello' }]);
  });

  it('swallows a throw from logger.log — an EPIPE must not escape', () => {
    const logger: Logger = {
      log: () => {
        throw new Error('EPIPE');
      },
    };
    expect(() => safeLog(logger, { ...TEMPLATE, message: 'hello' })).not.toThrow();
  });
});

describe('logCaughtFailure', () => {
  it('logs the caught error, sanitized, under the given template and extra payload', () => {
    const logger = recordingLogger();
    logCaughtFailure(
      logger,
      { ...TEMPLATE, message: 'store read failed' },
      new Error('SQLITE_BUSY: database is locked'),
      { idempotency_key: 'key-1' },
    );

    expect(logger.entries).toEqual([
      {
        ...TEMPLATE,
        message: 'store read failed',
        payload: { idempotency_key: 'key-1', error: 'SQLITE_BUSY: database is locked' },
      },
    ]);
  });

  it('masks a credential-shaped substring in the caught error text (sanitizeLogText)', () => {
    const logger = recordingLogger();
    logCaughtFailure(
      logger,
      { ...TEMPLATE, message: 'broker call failed' },
      new Error('unauthorized: Bearer abc123.def456'),
      {},
    );

    const payload = logger.entries[0]?.payload as { error: string };
    expect(payload.error).not.toContain('abc123.def456');
    expect(payload.error).toContain('[REDACTED]');
  });

  // The graded property (#573 review): a log call inside a catch must not
  // itself throw. A throwing `Logger` alone does not pin this — `safeLog`
  // already guards that call, which happens AFTER rendering — so this drives
  // a value through the render step `safeLog` does NOT guard: `toJSON`
  // throwing sends `describeThrown` to its `String(error)` fallback (the
  // branch its own `JSON.stringify` catch takes), and THAT throws too via
  // `toString`, escaping `describeThrown` entirely. Paired with a throwing
  // logger, so both of `logCaughtFailure`'s own guards are exercised at once.
  it("never throws for a value hostile enough to break describeThrown's own fallback, even paired with a throwing logger", () => {
    const hostile = {
      toJSON(): never {
        throw new Error('toJSON exploded');
      },
      toString(): never {
        throw new Error('toString exploded too');
      },
    };
    const throwingLogger: Logger = {
      log: () => {
        throw new Error('EPIPE');
      },
    };

    expect(() =>
      logCaughtFailure(throwingLogger, { ...TEMPLATE, message: 'x' }, hostile, {}),
    ).not.toThrow();
  });

  it('still delivers the log line for a hostile-but-survivable value once paired with a healthy logger', () => {
    const logger = recordingLogger();
    // `JSON.stringify` throws on a circular object (`describeThrown`'s own
    // fallback path), and `String()` on a plain object degrades to
    // `"[object Object]"` rather than throwing — so this is the case
    // `describeThrown` alone already survives, exercised here through the
    // full `logCaughtFailure` wrapper.
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    logCaughtFailure(logger, { ...TEMPLATE, message: 'x' }, circular, {});

    expect(logger.entries).toHaveLength(1);
    const payload = logger.entries[0]?.payload as { error: unknown } | undefined;
    expect(typeof payload?.error).toBe('string');
  });
});
