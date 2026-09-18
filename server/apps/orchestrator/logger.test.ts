import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildEntrypointLogger,
  formatLogLine,
  JsonLogger,
  type StdoutStream,
  watchStdoutErrors,
} from './logger.js';

class FakeStdout implements StdoutStream {
  readonly lines: string[] = [];
  private listener?: (error: Error) => void;
  throwOn?: Error;

  write(line: string): boolean {
    if (this.throwOn !== undefined) throw this.throwOn;
    this.lines.push(line);
    return true;
  }

  on(_event: 'error', listener: (error: Error) => void): this {
    this.listener = listener;
    return this;
  }

  breakPipe(error = new Error('EPIPE: broken pipe')): void {
    if (this.listener === undefined) throw new Error('nothing subscribed to stdout errors');
    this.listener(error);
  }

  parsed(): { level: string; message: string; payload?: Record<string, unknown> }[] {
    return this.lines.map((line) => JSON.parse(line));
  }
}

let dir: string;
let stdout: string[];
let writeSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'samurai-logger-'));
  stdout = [];
  writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  writeSpy.mockRestore();
  try {
    chmodSync(dir, 0o700);
  } catch {}
  rmSync(dir, { recursive: true, force: true });
});

function buildLoggerOverFakes(stdout: FakeStdout, file: string[]): JsonLogger {
  const logger = new JsonLogger({ write: (line) => file.push(line) }, stdout);
  watchStdoutErrors(logger, stdout);
  return logger;
}

const ENTRY = {
  trace_id: 'trace-1',
  stage: 'trader',
  level: 'info' as const,
  message: 'decided',
  payload: { direction: 'long' },
};

describe('JsonLogger', () => {
  it('writes one JSON line per call to stdout', () => {
    new JsonLogger().log(ENTRY);

    expect(stdout).toHaveLength(1);
    expect(stdout[0].endsWith('\n')).toBe(true);
    expect(JSON.parse(stdout[0])).toMatchObject({
      trace_id: 'trace-1',
      stage: 'trader',
      level: 'info',
      message: 'decided',
      payload: { direction: 'long' },
    });
    expect(typeof JSON.parse(stdout[0]).timestamp).toBe('string');
  });

  it('writes the identical line to the file sink as well as stdout', () => {
    const written: string[] = [];
    new JsonLogger({ write: (line) => written.push(line) }).log(ENTRY);

    expect(written).toEqual(stdout);
  });

  it('keeps logging to stdout when the sink throws, and never throws itself', () => {
    const logger = new JsonLogger({
      write: () => {
        throw new Error('EIO');
      },
    });

    expect(() => {
      logger.log(ENTRY);
      logger.log(ENTRY);
    }).not.toThrow();

    const parsed = stdout.map((line) => JSON.parse(line));
    expect(parsed.filter((e) => e.message === 'decided')).toHaveLength(2);
    const warns = parsed.filter((e) => e.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0].message).toMatch(/sink/i);
  });

  it('does not throw when reporting the sink failure itself fails', () => {
    let writes = 0;
    writeSpy.mockImplementation((chunk: unknown) => {
      writes += 1;
      if (writes > 1) throw new Error('EPIPE: broken pipe');
      stdout.push(String(chunk));
      return true;
    });

    const logger = new JsonLogger({
      write: () => {
        throw new Error('ENOSPC: no space left on device');
      },
    });

    expect(() => logger.log(ENTRY)).not.toThrow();
    expect(stdout.map((s) => JSON.parse(s).message)).toEqual(['decided']);
    expect(writes).toBe(2);

    expect(() => logger.log(ENTRY)).toThrow(/EPIPE/);
    expect(writes).toBe(3);
  });

  it('does not route the sink-failure warn back through the sink', () => {
    let attempts = 0;
    new JsonLogger({
      write: () => {
        attempts += 1;
        throw new Error('EIO');
      },
    }).log(ENTRY);

    expect(attempts).toBe(1);
  });
});

describe('formatLogLine payload serialization (#1061)', () => {
  const BASE = {
    trace_id: 't1',
    stage: 's',
    level: 'info' as const,
    message: 'm',
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('serializes a payload exactly once', () => {
    let calls = 0;
    const inner = {
      toJSON(): unknown {
        calls += 1;
        return { value: 42 };
      },
    };

    formatLogLine({ ...BASE, payload: { nested: inner } });

    expect(calls).toBe(1);
  });

  it('is byte-identical to the pre-fix output for a non-cyclic, mixed-type payload', () => {
    const line = formatLogLine({
      ...BASE,
      payload: { a: 1, b: { c: 2, d: [1, 2, 3] }, e: 'hello', token: 'secret123' },
      started_at: '2026-01-01T00:00:00.000Z',
      duration_ms: 42,
    });

    expect(line).toBe(
      '{"timestamp":"2026-01-01T00:00:00.000Z","trace_id":"t1","stage":"s","level":"info",' +
        '"message":"m","payload":{"a":1,"b":{"c":2,"d":[1,2,3]},"e":"hello","token":"[REDACTED]"},' +
        '"started_at":"2026-01-01T00:00:00.000Z","duration_ms":42}\n',
    );
  });

  it('is byte-identical to the pre-fix output when there is no payload', () => {
    const line = formatLogLine(BASE);

    expect(line).toBe(
      '{"timestamp":"2026-01-01T00:00:00.000Z","trace_id":"t1","stage":"s","level":"info","message":"m"}\n',
    );
  });

  it('puts the event code on the wire, between stage and level (#1115)', () => {
    const line = formatLogLine({ ...BASE, event: 'tick_failed', level: 'error' });

    expect(line).toBe(
      '{"timestamp":"2026-01-01T00:00:00.000Z","trace_id":"t1","stage":"s",' +
        '"event":"tick_failed","level":"error","message":"m"}\n',
    );
  });

  it('is byte-identical to the pre-fix output for a payload the depth bound flattens', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    const line = formatLogLine({ ...BASE, payload: cyclic });

    expect(line).toBe(
      '{"timestamp":"2026-01-01T00:00:00.000Z","trace_id":"t1","stage":"s","level":"info",' +
        '"message":"m","payload":{"self":{"self":{"self":{"self":{"self":{"self":' +
        '"[REDACTION_DEPTH_LIMIT]"}}}}}}}\n',
    );
  });

  it('still detects a genuinely cyclic payload inside the guard and degrades it the same way as before', () => {
    let calls = 0;
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const inner = {
      toJSON(): unknown {
        calls += 1;
        return cyclic;
      },
    };

    const line = formatLogLine({ ...BASE, payload: { nested: inner } });

    expect(line).toBe(
      '{"timestamp":"2026-01-01T00:00:00.000Z","trace_id":"t1","stage":"s","level":"info",' +
        '"message":"m","payload":{"redaction_failed":true}}\n',
    );
    expect(calls).toBe(1);
  });
});

describe('formatLogLine message masking (#1133)', () => {
  const BASE = {
    trace_id: 't1',
    stage: 's',
    level: 'info' as const,
  };

  it('masks a Telegram bot-token-shaped credential interpolated into message, not just payload', () => {
    const line = formatLogLine({
      ...BASE,
      message:
        'TypeError: Failed to parse URL from https://api.telegram.org/bot123456:FAKE-TOKEN-VALUE/sendMessage',
    });

    expect(line).not.toContain('FAKE-TOKEN-VALUE');
    expect(line).toContain('[REDACTED]');
  });

  it('leaves an ordinary message with no credential syntax unchanged', () => {
    const line = formatLogLine({ ...BASE, message: 'decided long AAPL' });

    expect(line).toContain('"message":"decided long AAPL"');
  });

  it.each([
    'token_bucket_wait: waiting 1200ms before the next Alpaca call',
    'idempotency key 3f9c2b7a1e6d4f80b2c5a91e7d3f6c48b0a2d4e6f8c1b3a5d7e9f0c2b4a6d8e0 already applied',
    'computeIndicator: sma(14) needs 14 bars but received 13',
  ])(
    'leaves near-miss prose %j unchanged, not just bland prose with no pattern to trip',
    (message) => {
      const line = formatLogLine({ ...BASE, message });

      expect(line).toContain(`"message":${JSON.stringify(message)}`);
    },
  );

  it('leaves the sanctioned correlation-token prefix intact — the bareword rule must not eat the field name and the prefix with it (#1133 review)', () => {
    const line = formatLogLine({
      ...BASE,
      message:
        'rejected a callback_query from a non-allowlisted user (from_id=absent, chat_id=67890, token_prefix=a1b2c3d4…)',
    });

    expect(line).toContain('token_prefix=a1b2c3d4…)');
    expect(line).not.toContain('[REDACTED]');
  });
});

describe('JsonLogger when stdout fails (#714)', () => {
  it('degrades to the file sink on an async stdout error and keeps logging there', () => {
    const stdout = new FakeStdout();
    const file: string[] = [];
    const logger = buildLoggerOverFakes(stdout, file);

    logger.log(ENTRY);
    stdout.breakPipe();
    logger.log({ ...ENTRY, message: 'after the pipe died' });

    const degradation = file.map((l) => JSON.parse(l)).find((e) => e.level === 'warn');
    expect(degradation.payload.log_stdout_sink).toBe('degraded');
    expect(degradation.message).toMatch(/EPIPE/);
    expect(file.map((l) => JSON.parse(l).message)).toContain('after the pipe died');
    expect(stdout.parsed().map((e) => e.message)).toEqual(['decided']);
    expect(logger.stdoutRetired).toBe(true);
  });

  it('records the degradation once, however many error events arrive', () => {
    const stdout = new FakeStdout();
    const file: string[] = [];
    const logger = buildLoggerOverFakes(stdout, file);

    for (let i = 0; i < 10; i += 1) stdout.breakPipe();
    logger.log(ENTRY);

    expect(file.map((l) => JSON.parse(l)).filter((e) => e.level === 'warn')).toHaveLength(1);
  });

  it('degrades on a synchronous stdout throw too', () => {
    const stdout = new FakeStdout();
    const file: string[] = [];
    const logger = buildLoggerOverFakes(stdout, file);
    stdout.throwOn = new Error('ENOSPC: no space left on device');

    expect(() => logger.log(ENTRY)).not.toThrow();

    const written = file.map((l) => JSON.parse(l));
    expect(written[0].payload.log_stdout_sink).toBe('degraded');
    expect(written[1].message).toBe('decided');
  });

  it('throws rather than degrading when there is no sink to record the failure on', () => {
    const stdout = new FakeStdout();
    stdout.throwOn = new Error('EBADF');
    const logger = new JsonLogger(undefined, stdout);

    expect(() => logger.log(ENTRY)).toThrow(/EBADF/);
  });

  it('throws when the file sink has silently retired, rather than reporting a lost line as durable', () => {
    const stdout = new FakeStdout();
    const retired = { write: () => {}, degraded: true };
    const logger = new JsonLogger(retired, stdout);

    stdout.throwOn = new Error('EPIPE: broken pipe');
    expect(() => logger.log(ENTRY)).toThrow(/EPIPE/);
    expect(logger.stdoutRetired).toBe(false);
  });

  it('falls back to stderr when stdout was retired first and the file retires later', () => {
    const stdout = new FakeStdout();
    const stderr: string[] = [];
    const sink = { write: () => {}, degraded: false };
    const logger = new JsonLogger(sink, stdout, { write: (line) => stderr.push(line) });

    stdout.throwOn = new Error('EPIPE: broken pipe');
    logger.log(ENTRY);
    expect(logger.stdoutRetired).toBe(true);
    expect(stderr).toHaveLength(0);

    sink.degraded = true;
    expect(() => logger.log({ ...ENTRY, message: 'after both sinks died' })).toThrow(
      /reached no sink/,
    );

    const written = stderr.map((line) => JSON.parse(line));
    expect(written[0].message).toMatch(/no sink left/);
    expect(written[0].payload).toMatchObject({
      log_stdout_sink: 'degraded',
      log_file_sink: 'degraded',
    });
    expect(written[1].message).toBe('after both sinks died');

    expect(() => logger.log({ ...ENTRY, message: 'and again' })).toThrow();
    expect(stderr.map((line) => JSON.parse(line).message)).toEqual([
      written[0].message,
      'after both sinks died',
      'and again',
    ]);
  });

  it('still throws when the last-resort stderr write throws too', () => {
    const stdout = new FakeStdout();
    stdout.throwOn = new Error('EBADF');
    const logger = new JsonLogger(undefined, stdout, {
      write: () => {
        throw new Error('stderr is as dead as stdout');
      },
    });

    expect(() => logger.log(ENTRY)).toThrow(/EBADF/);
  });

  it('throws out of the stdout error listener when nothing can record the failure', () => {
    const stdout = new FakeStdout();
    watchStdoutErrors(new JsonLogger(undefined, stdout), stdout);

    expect(() => stdout.breakPipe()).toThrow(/could not be recorded on any other sink/);
  });
});

describe('buildEntrypointLogger', () => {
  it('leaves a durable file behind with the logged lines in it', () => {
    const filePath = join(dir, 'orchestrator.log');
    const logger = buildEntrypointLogger({ filePath, maxBytes: 4096, maxRotatedFiles: 2 });

    logger.log(ENTRY);

    const [line] = readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    expect(JSON.parse(line)).toMatchObject({ trace_id: 'trace-1', message: 'decided' });
    expect(stdout.map((s) => JSON.parse(s).message)).toEqual(['decided']);
  });

  it('degrades to stdout with a warn when the path is unwritable', () => {
    const locked = join(dir, 'locked');
    mkdirSync(locked, { mode: 0o500 });

    const logger = buildEntrypointLogger({
      filePath: join(locked, 'nested', 'orchestrator.log'),
      maxBytes: 4096,
      maxRotatedFiles: 2,
    });

    const warn = stdout.map((s) => JSON.parse(s)).find((e) => e.level === 'warn');
    expect(warn).toBeDefined();
    expect(warn.message).toMatch(/log file sink disabled/i);
    expect(warn.stage).toBe('orchestrator');

    expect(() => logger.log(ENTRY)).not.toThrow();
    expect(stdout.map((s) => JSON.parse(s).message)).toContain('decided');
  });

  it('subscribes to stdout errors, so a broken pipe degrades instead of ending the run', () => {
    const filePath = join(dir, 'watched.log');
    const stdoutStream = new FakeStdout();
    const logger = buildEntrypointLogger(
      { filePath, maxBytes: 4096, maxRotatedFiles: 2 },
      stdoutStream,
    );

    expect(() => stdoutStream.breakPipe()).not.toThrow();

    logger.log({ ...ENTRY, message: 'after the pipe died' });
    const written = readFileSync(filePath, 'utf8');
    expect(written).toMatch(/"log_stdout_sink":"degraded"/);
    expect(written).toContain('after the pipe died');
  });

  it('reads its configuration from the environment when none is passed', () => {
    const filePath = join(dir, 'from-env', 'orchestrator.log');
    const saved = process.env.SAMURAI_LOG_FILE;
    process.env.SAMURAI_LOG_FILE = filePath;

    try {
      buildEntrypointLogger().log(ENTRY);
      expect(readFileSync(filePath, 'utf8')).toContain('"trace_id":"trace-1"');
    } finally {
      if (saved === undefined) delete process.env.SAMURAI_LOG_FILE;
      else process.env.SAMURAI_LOG_FILE = saved;
    }
  });
});
