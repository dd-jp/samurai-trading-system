import { recordingLogger } from './recording-logger.js';
import { describeThrown, describeThrownSafely, logCaughtFailure, safeLog } from './safe-log.js';
import type { Logger } from './types.js';

const TEMPLATE = {
  trace_id: 'trace-1',
  stage: 'execution',
  event: 'store_read_failed',
  level: 'error' as const,
};

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

  it('coerces a non-string `message` through the same JSON.stringify/String ladder instead of returning it verbatim', () => {
    const error = new Error('unused');
    Object.defineProperty(error, 'message', {
      get: () => ({ code: 'weird' }),
    });

    const result = describeThrown(error);

    expect(typeof result).toBe('string');
    expect(result).toBe('{"code":"weird"}');
  });

  it('falls back to String() when JSON.stringify itself returns undefined (a message getter returning undefined)', () => {
    const error = new Error('unused');
    Object.defineProperty(error, 'message', {
      get: () => undefined,
    });

    const result = describeThrown(error);

    expect(typeof result).toBe('string');
    expect(result).toBe('undefined');
  });

  it('renders a bare undefined throw as the string "undefined", not the value undefined', () => {
    expect(describeThrown(undefined)).toBe('undefined');
  });
});

describe('describeThrownSafely', () => {
  it('renders an Error by its message, exactly as describeThrown does', () => {
    expect(describeThrownSafely(new Error('boom'))).toBe('boom');
  });

  it('returns the placeholder for a value describeThrown itself cannot render', () => {
    const hostile: Record<string, unknown> = {
      [Symbol.toPrimitive]: () => {
        throw new Error('render boom');
      },
    };
    hostile.self = hostile;

    expect(() => describeThrown(hostile)).toThrow('render boom');
    expect(describeThrownSafely(hostile)).toBe('[unrenderable error]');
  });

  it('returns the placeholder for a message getter that throws', () => {
    const error = new Error('unused');
    Object.defineProperty(error, 'message', {
      get: () => {
        throw new Error('render boom');
      },
    });

    expect(describeThrownSafely(error)).toBe('[unrenderable error]');
  });

  it('returns the placeholder when `instanceof` itself throws', () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error('trap boom');
        },
      },
    );

    expect(describeThrownSafely(hostile)).toBe('[unrenderable error]');
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
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    logCaughtFailure(logger, { ...TEMPLATE, message: 'x' }, circular, {});

    expect(logger.entries).toHaveLength(1);
    const payload = logger.entries[0]?.payload as { error: unknown } | undefined;
    expect(typeof payload?.error).toBe('string');
  });
});
