/**
 * `debug` level and `SAMURAI_LOG_LEVEL` (#1035).
 *
 * The tests that matter are the last two. Filtering sits inside `log`, which
 * is also where #714's "no sink left" throw lives, so the danger a verbosity
 * setting introduces is not a lost line — it is a FABRICATED fault: a
 * suppressed entry that fell through to the write path would find neither sink
 * written and throw as though logging had failed, on a healthy run. And a
 * threshold that could suppress `warn`/`error` would let an operator configure
 * away the degradation notices the same rule depends on.
 */
import { describe, expect, it } from 'vitest';
import type { LogEntry } from '../../shared/index.js';
import { debugEnabledFromEnvironment, JsonLogger, type StdoutStream } from './logger.js';

class FakeStdout implements StdoutStream {
  readonly lines: string[] = [];
  write(line: string): boolean {
    this.lines.push(line);
    return true;
  }
  on(): unknown {
    return undefined;
  }
}

const ENTRY: LogEntry = {
  trace_id: 'trace-1',
  stage: 'trader',
  level: 'debug',
  message: 'considered and rejected',
};

describe('debugEnabledFromEnvironment', () => {
  it('enables only on an explicit debug value, trimmed and case-insensitive', () => {
    expect(debugEnabledFromEnvironment('debug')).toBe(true);
    expect(debugEnabledFromEnvironment('DEBUG')).toBe(true);
    expect(debugEnabledFromEnvironment('  debug  ')).toBe(true);
  });

  it('defaults to off when unset or set to anything else', () => {
    expect(debugEnabledFromEnvironment(undefined)).toBe(false);
    expect(debugEnabledFromEnvironment('')).toBe(false);
    expect(debugEnabledFromEnvironment('info')).toBe(false);
    expect(debugEnabledFromEnvironment('verbose')).toBe(false);
  });
});

describe('JsonLogger debug filtering', () => {
  it('drops debug entries by default', () => {
    const stdout = new FakeStdout();
    new JsonLogger(undefined, stdout).log(ENTRY);
    expect(stdout.lines).toEqual([]);
  });

  it('writes debug entries when enabled', () => {
    const stdout = new FakeStdout();
    new JsonLogger(undefined, stdout, process.stderr, true).log(ENTRY);
    expect(stdout.lines.join('')).toContain('considered and rejected');
    expect(stdout.lines.join('')).toContain('"level":"debug"');
  });

  it('never filters info, warn or error, whatever the setting', () => {
    const stdout = new FakeStdout();
    const logger = new JsonLogger(undefined, stdout, process.stderr, false);

    for (const level of ['info', 'warn', 'error'] as const) {
      logger.log({ ...ENTRY, level, message: `${level} line` });
    }

    expect(stdout.lines).toHaveLength(3);
    expect(stdout.lines.join('')).toContain('error line');
  });

  it('does NOT throw the no-sink error for a suppressed line when no sink works', () => {
    // The fabricated-fault case. A dropped debug line must return before the
    // `reachedStdout || reachedFile` check; if it did not, verbosity config
    // would raise #714's throw on a run whose logging is fine.
    const deadStdout: StdoutStream = {
      write() {
        throw new Error('EBADF');
      },
      on() {
        return undefined;
      },
    };
    const logger = new JsonLogger(undefined, deadStdout, { write: () => undefined }, false);

    expect(() => logger.log(ENTRY)).not.toThrow();
    // …while a non-suppressed line on the same dead logger still escalates.
    expect(() => logger.log({ ...ENTRY, level: 'info' })).toThrow(/EBADF/);
  });
});
