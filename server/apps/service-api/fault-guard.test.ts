import { describe, expect, it } from 'vitest';
import { installDashboardContinueOnFault, watchDashboardStdout } from './fault-guard.js';

/** Async-`'error'`-only stand-in for `process.stdout` — see stdout-fault-guard.test.ts */
class FakeStdout {
  private listener?: (error: Error) => void;
  on(_event: 'error', listener: (error: Error) => void): this {
    this.listener = listener;
    return this;
  }
  emitError(error: Error): void {
    if (this.listener === undefined) {
      throw new Error(
        'smoke: nothing subscribed to dashboard stdout errors — watchDashboardStdout stopped ' +
          'calling watchStdoutErrors (#764), so a broken pipe would reach uncaughtException',
      );
    }
    this.listener(error);
  }
}

/**
 * Same shape as `FakeStdout`, plus `write` — stands in for `process.stderr`,
 * which is both the reporting channel and (per the module doc's "Both
 * streams, not just stdout") a stream that must itself have an `'error'`
 * listener so a dead stderr degrades instead of reaching `uncaughtException`
 */
class FakeStderr {
  private listener?: (error: Error) => void;
  readonly lines: string[] = [];
  on(_event: 'error', listener: (error: Error) => void): this {
    this.listener = listener;
    return this;
  }
  write(line: string): void {
    this.lines.push(line);
  }
  emitError(error: Error): void {
    if (this.listener === undefined) {
      throw new Error(
        'smoke: nothing subscribed to dashboard stderr errors — watchDashboardStdout stopped ' +
          'calling watchStdoutErrors on stderr (#764), so a dead stderr report would itself ' +
          'reach uncaughtException',
      );
    }
    this.listener(error);
  }
}

describe('watchDashboardStdout', () => {
  it('degrades a destroyed stdout pipe instead of throwing, and reports once on stderr', () => {
    const stdout = new FakeStdout();
    const stderr = new FakeStderr();
    watchDashboardStdout(stdout, stderr);

    expect(() => stdout.emitError(new Error('EPIPE'))).not.toThrow();
    // A dead pipe fires 'error' again on every subsequent write attempt
    // (measured: 36 of 40 in the module doc) — the report must not repeat
    stdout.emitError(new Error('EPIPE'));
    stdout.emitError(new Error('EPIPE'));

    expect(stderr.lines).toHaveLength(1);
    expect(stderr.lines[0]).toContain('stdout write failed');
    expect(stderr.lines[0]).toContain('EPIPE');
  });

  it('is provable by removal: nothing subscribed raises on the fake', () => {
    const stdout = new FakeStdout();
    expect(() => stdout.emitError(new Error('EPIPE'))).toThrow(/nothing subscribed/);
  });

  it('also degrades a destroyed stderr — the reporting channel itself is guarded', () => {
    const stdout = new FakeStdout();
    const stderr = new FakeStderr();
    watchDashboardStdout(stdout, stderr);

    // stderr sharing a fd with stdout is the realistic failure this covers
    // (closed terminal, torn-down detached tmux) — see the module doc's
    // empirical confirmation. Firing this must not throw.
    expect(() => stderr.emitError(new Error('EPIPE'))).not.toThrow();
  });

  it('is provable by removal: an unguarded stderr raises on the fake', () => {
    const stderr = new FakeStderr();
    expect(() => stderr.emitError(new Error('EPIPE'))).toThrow(/nothing subscribed/);
  });
});

describe('installDashboardContinueOnFault', () => {
  it('reports an arbitrary uncaught fault and does not exit', () => {
    const stderrLines: string[] = [];
    const handlers = new Map<string, (error: unknown) => void>();

    installDashboardContinueOnFault({
      stderr: { write: (line) => stderrLines.push(line as string) },
      on: (event, handler) => handlers.set(event, handler),
    });

    handlers.get('uncaughtException')?.(new Error('a background bug'));

    expect(stderrLines).toHaveLength(1);
    expect(stderrLines[0]).toContain('dashboard uncaughtException');
    expect(stderrLines[0]).toContain('a background bug');
    expect(stderrLines[0]).toContain('continuing to serve');
  });

  it('reports an unhandledRejection the same way', () => {
    const stderrLines: string[] = [];
    const handlers = new Map<string, (error: unknown) => void>();

    installDashboardContinueOnFault({
      stderr: { write: (line) => stderrLines.push(line as string) },
      on: (event, handler) => handlers.set(event, handler),
    });

    handlers.get('unhandledRejection')?.(new Error('a void-ed promise'));

    expect(stderrLines[0]).toContain('dashboard unhandledRejection');
  });
});
