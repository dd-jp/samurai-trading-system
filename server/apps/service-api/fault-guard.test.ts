import { describe, expect, it } from 'vitest';
import { installDashboardContinueOnFault, watchDashboardStdout } from './fault-guard.js';

/** Async-`'error'`-only stand-in for `process.stdout` — see stdout-fault-guard.test.ts. */
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

describe('watchDashboardStdout', () => {
  it('degrades a destroyed stdout pipe instead of throwing, and reports once on stderr', () => {
    const stdout = new FakeStdout();
    const stderrLines: string[] = [];
    watchDashboardStdout(stdout, { write: (line) => stderrLines.push(line as string) });

    expect(() => stdout.emitError(new Error('EPIPE'))).not.toThrow();
    // A dead pipe fires 'error' again on every subsequent write attempt
    // (measured: 36 of 40 in the module doc) — the report must not repeat.
    stdout.emitError(new Error('EPIPE'));
    stdout.emitError(new Error('EPIPE'));

    expect(stderrLines).toHaveLength(1);
    expect(stderrLines[0]).toContain('stdout write failed');
    expect(stderrLines[0]).toContain('EPIPE');
  });

  it('is provable by removal: nothing subscribed raises on the fake', () => {
    const stdout = new FakeStdout();
    expect(() => stdout.emitError(new Error('EPIPE'))).toThrow(/nothing subscribed/);
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
