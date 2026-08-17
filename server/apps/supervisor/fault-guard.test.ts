import { describe, expect, it } from 'vitest';
import { installSupervisorContinueOnFault, watchSupervisorStdout } from './fault-guard.js';

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
        'smoke: nothing subscribed to supervisor stdout errors — watchSupervisorStdout stopped ' +
          'calling watchStdoutErrors (#764), so a broken pipe would reach uncaughtException',
      );
    }
    this.listener(error);
  }
}

describe('watchSupervisorStdout', () => {
  it('degrades a destroyed stdout pipe instead of throwing, and reports once on stderr', () => {
    const stdout = new FakeStdout();
    const stderrLines: string[] = [];
    watchSupervisorStdout(stdout, { write: (line) => stderrLines.push(line as string) });

    expect(() => stdout.emitError(new Error('EPIPE'))).not.toThrow();
    stdout.emitError(new Error('EPIPE'));

    expect(stderrLines).toHaveLength(1);
    expect(stderrLines[0]).toContain('supervisor: stdout write failed');
  });

  it('is provable by removal: nothing subscribed raises on the fake', () => {
    const stdout = new FakeStdout();
    expect(() => stdout.emitError(new Error('EPIPE'))).toThrow(/nothing subscribed/);
  });
});

describe('installSupervisorContinueOnFault', () => {
  it('reports an arbitrary uncaught fault and does not exit', () => {
    const stderrLines: string[] = [];
    const handlers = new Map<string, (error: unknown) => void>();

    installSupervisorContinueOnFault({
      stderr: { write: (line) => stderrLines.push(line as string) },
      on: (event, handler) => handlers.set(event, handler),
    });

    handlers.get('uncaughtException')?.(new Error('a bug in the settle closure'));

    expect(stderrLines).toHaveLength(1);
    expect(stderrLines[0]).toContain('supervisor uncaughtException');
    expect(stderrLines[0]).toContain('continuing to supervise');
    expect(stderrLines[0]).toContain('Nothing restarts this process');
  });

  it('reports an unhandledRejection the same way', () => {
    const stderrLines: string[] = [];
    const handlers = new Map<string, (error: unknown) => void>();

    installSupervisorContinueOnFault({
      stderr: { write: (line) => stderrLines.push(line as string) },
      on: (event, handler) => handlers.set(event, handler),
    });

    handlers.get('unhandledRejection')?.(new Error('a void-ed promise'));

    expect(stderrLines[0]).toContain('supervisor unhandledRejection');
  });
});
