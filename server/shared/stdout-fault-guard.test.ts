import { describe, expect, it } from 'vitest';
import { guardedWrite, installContinueOnFault, watchStdoutErrors } from './stdout-fault-guard.js';

/**
 * A stdout stand-in shaped like the real thing: `'error'` fires
 * asynchronously, through a registered listener, never as a synchronous
 * throw from `write`. This is deliberate — #714's (and this ticket's own,
 * reproduced against `console.log`) measurement is that a destroyed pipe
 * delivers the fault as an async event, and a test that only ever throws
 * synchronously from `write` would pass against a guard that does nothing.
 */
class FakeStdout {
  private listener?: (error: Error) => void;

  on(_event: 'error', listener: (error: Error) => void): this {
    this.listener = listener;
    return this;
  }

  /** Fires the async `'error'` event a real destroyed pipe delivers. */
  emitError(error: Error): void {
    if (this.listener === undefined) {
      throw new Error('nothing subscribed to stdout errors');
    }
    this.listener(error);
  }
}

describe('watchStdoutErrors', () => {
  it('routes the async error event to onFault, never a synchronous throw', () => {
    const stdout = new FakeStdout();
    const faults: Error[] = [];

    watchStdoutErrors(stdout, (error) => faults.push(error));

    // The mechanism under test: firing the ASYNC event, not calling write()
    // and catching a throw. This is the distinction #714 measured — a
    // try/catch around a write catches nothing on a real pipe.
    expect(() => stdout.emitError(new Error('EPIPE'))).not.toThrow();
    expect(faults).toHaveLength(1);
    expect(faults[0]?.message).toBe('EPIPE');
  });
});

describe('guardedWrite', () => {
  it('writes the line when the stream accepts it', () => {
    const lines: string[] = [];
    guardedWrite({ write: (line) => lines.push(line) }, 'hello\n');
    expect(lines).toEqual(['hello\n']);
  });

  it('swallows a throw from the stream — a fault report must not itself throw', () => {
    expect(() =>
      guardedWrite(
        {
          write: () => {
            throw new Error('stderr is dead too');
          },
        },
        'hello\n',
      ),
    ).not.toThrow();
  });
});

describe('installContinueOnFault', () => {
  it('reports an uncaughtException on stderr and does not exit', () => {
    const lines: string[] = [];
    const handlers = new Map<string, (error: unknown) => void>();

    installContinueOnFault((fault, error) => `${fault}: ${(error as Error).message}`, {
      stderr: { write: (line) => lines.push(line as string) },
      on: (event, handler) => handlers.set(event, handler),
    });

    handlers.get('uncaughtException')?.(new Error('boom'));

    expect(lines).toEqual(['uncaughtException: boom\n']);
  });

  it('reports an unhandledRejection on stderr and does not exit', () => {
    const lines: string[] = [];
    const handlers = new Map<string, (error: unknown) => void>();

    installContinueOnFault((fault, error) => `${fault}: ${(error as Error).message}`, {
      stderr: { write: (line) => lines.push(line as string) },
      on: (event, handler) => handlers.set(event, handler),
    });

    handlers.get('unhandledRejection')?.(new Error('rejected'));

    expect(lines).toEqual(['unhandledRejection: rejected\n']);
  });

  it('never calls an exit effect — there is none to call', () => {
    // There is no `exit` in ContinueOnFaultEffects at all: the type itself is
    // the proof this handler cannot terminate the process, unlike
    // `installFaultHandlers` in orchestrator/index.ts (#714), whose effects
    // require one.
    const handlers = new Map<string, (error: unknown) => void>();
    installContinueOnFault(() => 'fault', {
      stderr: { write: () => {} },
      on: (event, handler) => handlers.set(event, handler),
    });

    expect(() => handlers.get('uncaughtException')?.(new Error('x'))).not.toThrow();
  });
});
