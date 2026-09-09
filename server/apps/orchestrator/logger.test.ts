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

/**
 * A stdout stand-in that can be broken in either of the two ways a real one
 * breaks: synchronously (file/TTY stdio) and asynchronously (a pipe, which is
 * what a soak actually has — see `watchStdoutErrors`).
 */
class FakeStdout implements StdoutStream {
  readonly lines: string[] = [];
  private listener?: (error: Error) => void;
  /** Set to make `write` throw, modelling synchronous stdio. */
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

  /** Delivers what Node delivers on a dead pipe: an async `'error'` event. */
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
  } catch {
    // Already removable.
  }
  rmSync(dir, { recursive: true, force: true });
});

/** A logger over both fakes, wired the way `buildEntrypointLogger` wires the real one. */
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

    // Both, not either — a foreground run stays readable while the soak gets
    // its durable trace.
    expect(written).toEqual(stdout);
  });

  it('keeps logging to stdout when the sink throws, and never throws itself', () => {
    // The requirement that must not be got wrong: a sink failure is not
    // allowed to propagate into a tick.
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
    // Both entries still reached stdout...
    expect(parsed.filter((e) => e.message === 'decided')).toHaveLength(2);
    // ...plus exactly one warn about the sink, not one per line.
    const warns = parsed.filter((e) => e.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0].message).toMatch(/sink/i);
  });

  it('does not throw when reporting the sink failure itself fails', () => {
    // The same hole review found in `RotatingFileSink.report` (#349), one file
    // over: the degradation warn goes to stdout, and stdout throws EPIPE once
    // the far end of the pipe is gone. Modelled exactly — the entry line is
    // written fine, then the pipe breaks before the warn about the failing
    // sink can go out. A file failure must not become an exception in a tick.
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
    // The entry itself still got out, and the warn was attempted (2 writes).
    expect(stdout.map((s) => JSON.parse(s).message)).toEqual(['decided']);
    expect(writes).toBe(2);

    // Rewritten for #714, which took the decision this comment used to say
    // had been deferred. A *later* call still throws, but no longer because
    // stdout is unguarded: both sinks are now gone (the file retired on
    // ENOSPC, stdout on EPIPE), so there is nowhere to record the failure and
    // the rule is that the logger stops rather than continuing blind. The
    // throw carries stdout's own error.
    expect(() => logger.log(ENTRY)).toThrow(/EPIPE/);
    // 3, not 4: the sink's degradation was reported once and never retried.
    expect(writes).toBe(3);
  });

  it('does not route the sink-failure warn back through the sink', () => {
    // Otherwise the degradation warn is the thing that recurses.
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
    // `redactPayload`'s walk always returns FUNCTION-typed values unchanged
    // (they fail the `typeof value !== 'object'` check), so an own `toJSON`
    // property on a payload survives the redaction walk by reference and is
    // still there — and still callable — on the redacted object that gets
    // put on the wire. That makes it a reliable probe for how many times the
    // *redacted* structure, not just the original payload, is actually run
    // through JSON serialization: once per invocation of this `toJSON`.
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
    // Captured from the logger before #1061's change, with the system clock
    // fixed so the timestamp field is reproducible.
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
    // The field-by-field build means a field nobody adds here is silently
    // dropped: `event` would type-check at every call site and reach no
    // reader, which is the whole mechanism defeated.
    const line = formatLogLine({ ...BASE, event: 'tick_failed', level: 'error' });

    expect(line).toBe(
      '{"timestamp":"2026-01-01T00:00:00.000Z","trace_id":"t1","stage":"s",' +
        '"event":"tick_failed","level":"error","message":"m"}\n',
    );
  });

  it('is byte-identical to the pre-fix output for a payload the depth bound flattens', () => {
    // An ordinary self-referential object never reaches `JSON.stringify` as an
    // actual cycle: `redactPayload`'s walk rebuilds a fresh plain object at
    // every level and is depth-bounded, so it bottoms out at
    // `MAX_DEPTH` with a marker string well before any native stringifier
    // would see a cycle. Captured from the logger before #1061's change.
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
    // The depth bound cannot save a payload whose cycle is hidden behind a
    // `toJSON` — the walker preserves that function by reference (see the
    // first test in this block) without ever calling it, so the cycle is
    // invisible to the walk and only surfaces when the redacted structure is
    // actually serialized. This is the real shape of "a cyclic payload that
    // survives the walk" the module doc warns about, and it must still be
    // caught inside `formatLogLine`'s guard rather than escaping from it.
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

    // Same fallback payload as before the fix, and the throwing structure was
    // only ever handed to the serializer once — never escaping to a second,
    // unguarded pass.
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
});

describe('JsonLogger when stdout fails (#714)', () => {
  /** The soak case: a pipe dies asynchronously and the run must continue. */
  it('degrades to the file sink on an async stdout error and keeps logging there', () => {
    const stdout = new FakeStdout();
    const file: string[] = [];
    const logger = buildLoggerOverFakes(stdout, file);

    logger.log(ENTRY);
    stdout.breakPipe();
    logger.log({ ...ENTRY, message: 'after the pipe died' });

    // The failure itself is recorded — durably, on the sink that survived.
    const degradation = file.map((l) => JSON.parse(l)).find((e) => e.level === 'warn');
    expect(degradation.payload.log_stdout_sink).toBe('degraded');
    expect(degradation.message).toMatch(/EPIPE/);
    // ...and the run keeps producing its trace on the file.
    expect(file.map((l) => JSON.parse(l).message)).toContain('after the pipe died');
    // Stdout is retired, not retried: the line after the break never went there.
    expect(stdout.parsed().map((e) => e.message)).toEqual(['decided']);
    expect(logger.stdoutRetired).toBe(true);
  });

  it('records the degradation once, however many error events arrive', () => {
    // A dead pipe emits one `'error'` per subsequent write — 22 of them in the
    // measurement in `watchStdoutErrors`. The durable log must not fill with
    // copies of its own failure.
    const stdout = new FakeStdout();
    const file: string[] = [];
    const logger = buildLoggerOverFakes(stdout, file);

    for (let i = 0; i < 10; i += 1) stdout.breakPipe();
    logger.log(ENTRY);

    expect(file.map((l) => JSON.parse(l)).filter((e) => e.level === 'warn')).toHaveLength(1);
  });

  it('degrades on a synchronous stdout throw too', () => {
    // stdout attached to a file or TTY is synchronous, so the failure arrives
    // at the write call instead. Same rule, other half.
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
    // The rule that makes the degrade honest: nothing is swallowed unless the
    // swallowing is written down somewhere that survives.
    const stdout = new FakeStdout();
    stdout.throwOn = new Error('EBADF');
    const logger = new JsonLogger(undefined, stdout);

    expect(() => logger.log(ENTRY)).toThrow(/EBADF/);
  });

  it('throws when the file sink has silently retired, rather than reporting a lost line as durable', () => {
    // `RotatingFileSink.write` swallows its own I/O failures and returns
    // normally, so "it did not throw" is not evidence of durability. Without
    // the `degraded` check the logger would degrade stdout into a sink that
    // writes nowhere — running blind, which is the outcome #714 forbids.
    const stdout = new FakeStdout();
    const retired = { write: () => {}, degraded: true };
    const logger = new JsonLogger(retired, stdout);

    stdout.throwOn = new Error('EPIPE: broken pipe');
    expect(() => logger.log(ENTRY)).toThrow(/EPIPE/);
    expect(logger.stdoutRetired).toBe(false);
  });

  it('falls back to stderr when stdout was retired first and the file retires later', () => {
    // The ordering a soak actually hits — terminal closes on day three, disk
    // fills on day nine — and the one where the throw lands inside a tick and
    // is swallowed by #573's `safeLog`. So stderr, not the throw, is what
    // keeps the run from trading with no trace anywhere.
    const stdout = new FakeStdout();
    const stderr: string[] = [];
    const sink = { write: () => {}, degraded: false };
    const logger = new JsonLogger(sink, stdout, { write: (line) => stderr.push(line) });

    stdout.throwOn = new Error('EPIPE: broken pipe');
    logger.log(ENTRY);
    expect(logger.stdoutRetired).toBe(true);
    expect(stderr).toHaveLength(0);

    // Now the file sink retires too, the way `RotatingFileSink` does it:
    // silently, still returning from `write`.
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

    // The notice is said once; the lines themselves keep coming.
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

    // The escalation survives its own last resort failing — the guard around
    // the stderr write must not become the thing that reports.
    expect(() => logger.log(ENTRY)).toThrow(/EBADF/);
  });

  it('throws out of the stdout error listener when nothing can record the failure', () => {
    // The async half of the same escalation: it reaches `uncaughtException`,
    // whose handler (index.ts) records what it can and exits deliberately.
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
    // And stdout is unchanged — this is a second sink, not a replacement.
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

    // The construction warn is a proper structured line on stdout...
    const warn = stdout.map((s) => JSON.parse(s)).find((e) => e.level === 'warn');
    expect(warn).toBeDefined();
    expect(warn.message).toMatch(/log file sink disabled/i);
    expect(warn.stage).toBe('orchestrator');

    // ...and the process keeps logging.
    expect(() => logger.log(ENTRY)).not.toThrow();
    expect(stdout.map((s) => JSON.parse(s).message)).toContain('decided');
  });

  it('subscribes to stdout errors, so a broken pipe degrades instead of ending the run', () => {
    // The wiring #714 turns on. Asserted here rather than at the entrypoint
    // guard, which no test can reach — the reason this function is exported at
    // all. Removing the `watchStdoutErrors` call fails this test.
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
