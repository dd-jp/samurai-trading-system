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

const ENTRY = {
  trace_id: 'trace-1',
  stage: 'trader',
  event: 'trader_candidate_rejected',
  level: 'debug',
  message: 'considered and rejected',
} satisfies LogEntry;

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
    expect(() => logger.log({ ...ENTRY, level: 'info' })).toThrow(/EBADF/);
  });
});
