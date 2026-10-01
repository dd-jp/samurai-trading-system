import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  errorMessage,
  errorStack,
  exitCodeOrOne,
  failExitCodeOnRejection,
  type MainProcess,
  onTerminationSignal,
  runWhenInvoked,
  setExitCodeWhenInvoked,
  writeOrFail,
} from './cli-entrypoint.js';

const SCRIPT = '/opt/samurai/server/apps/v2/index.ts';
const SCRIPT_URL = pathToFileURL(SCRIPT).href;

function fakeProcess(argv: readonly string[]): MainProcess & {
  exits: number[];
  written: string[];
} {
  const exits: number[] = [];
  const written: string[] = [];
  return {
    argv,
    exits,
    written,
    stderr: { write: (text: string) => written.push(text) },
    exit: (code: number) => {
      exits.push(code);
    },
  };
}

describe('runWhenInvoked', () => {
  it('does not run main when another script was invoked', async () => {
    const proc = fakeProcess(['node', '/opt/samurai/other.ts']);
    let ran = false;
    await runWhenInvoked(
      SCRIPT_URL,
      async () => {
        ran = true;
      },
      errorMessage,
      proc,
    );
    expect(ran).toBe(false);
    expect(proc.exits).toEqual([]);
  });

  it('does not run main when no script path is present', async () => {
    const proc = fakeProcess(['node']);
    let ran = false;
    await runWhenInvoked(
      SCRIPT_URL,
      async () => {
        ran = true;
      },
      errorMessage,
      proc,
    );
    expect(ran).toBe(false);
  });

  it('exits with the code main resolves to', async () => {
    const proc = fakeProcess(['node', SCRIPT]);
    await runWhenInvoked(SCRIPT_URL, async () => 3, errorMessage, proc);
    expect(proc.exits).toEqual([3]);
  });

  it('leaves the process running when main resolves without a code', async () => {
    const proc = fakeProcess(['node', SCRIPT]);
    await runWhenInvoked(SCRIPT_URL, async () => undefined, errorMessage, proc);
    expect(proc.exits).toEqual([]);
  });

  it('writes the described error and exits 1 when main rejects', async () => {
    const proc = fakeProcess(['node', SCRIPT]);
    await runWhenInvoked(
      SCRIPT_URL,
      () => Promise.reject(new Error('boom')),
      (error) => `described ${errorMessage(error)}`,
      proc,
    );
    expect(proc.written).toEqual(['described boom\n']);
    expect(proc.exits).toEqual([1]);
  });

  it('describes errors by message by default', async () => {
    const proc = fakeProcess(['node', SCRIPT]);
    await runWhenInvoked(SCRIPT_URL, () => Promise.reject(new Error('boom')), undefined, proc);
    expect(proc.written).toEqual(['boom\n']);
  });

  it('masks credentials in what it writes, whichever describer is used', async () => {
    const leak = () =>
      Promise.reject(new Error('refresh failed: refresh_token=abc123 Bearer xyz789'));
    const byDefault = fakeProcess(['node', SCRIPT]);
    await runWhenInvoked(SCRIPT_URL, leak, undefined, byDefault);
    const byStack = fakeProcess(['node', SCRIPT]);
    await runWhenInvoked(SCRIPT_URL, leak, errorStack, byStack);
    expect(byDefault.written).toEqual(['refresh failed: [REDACTED] [REDACTED]\n']);
    expect(byStack.written.join('')).not.toMatch(/abc123|xyz789/);
    expect(byStack.written.join('')).toContain('refresh failed: [REDACTED] [REDACTED]');
  });
});

describe('errorMessage and errorStack', () => {
  it('stringifies non-Error values', () => {
    expect(errorMessage('plain')).toBe('plain');
    expect(errorStack(42)).toBe('42');
  });

  it('prefers the stack and falls back to the message', () => {
    const withStack = new Error('boom');
    expect(errorStack(withStack)).toBe(withStack.stack);
    const withoutStack = new Error('bare');
    Object.defineProperty(withoutStack, 'stack', { value: undefined });
    expect(errorStack(withoutStack)).toBe('bare');
  });
});

describe('onTerminationSignal', () => {
  it('runs the shutdown once on SIGINT or SIGTERM', async () => {
    const handlers = new Map<string, () => void>();
    const signals = {
      once: (event: string, handler: () => void) => {
        handlers.set(event, handler);
        return signals;
      },
    } as unknown as Pick<NodeJS.Process, 'once'>;
    let stops = 0;
    onTerminationSignal(async () => {
      stops += 1;
    }, signals);
    expect([...handlers.keys()]).toEqual(['SIGINT', 'SIGTERM']);
    handlers.get('SIGTERM')?.();
    expect(stops).toBe(1);
  });
});

describe('failExitCodeOnRejection', () => {
  it('leaves the exit code alone when the run resolves', async () => {
    const reported: unknown[] = [];
    const proc: { exitCode?: number } = {};
    await failExitCodeOnRejection(Promise.resolve('done'), (e) => reported.push(e), proc);
    expect(reported).toEqual([]);
    expect(proc.exitCode).toBeUndefined();
  });

  it('reports the error and sets exit code 1 on rejection', async () => {
    const reported: unknown[] = [];
    const proc: { exitCode?: number } = {};
    const error = new Error('down');
    await failExitCodeOnRejection(Promise.reject(error), (e) => reported.push(e), proc);
    expect(reported).toEqual([error]);
    expect(proc.exitCode).toBe(1);
  });
});

describe('exitCodeOrOne', () => {
  it('passes a resolved code through', async () => {
    const proc = fakeProcess([]);
    expect(await exitCodeOrOne(Promise.resolve(0), proc.stderr)).toBe(0);
    expect(proc.written).toEqual([]);
  });

  it('writes the message and returns 1 on rejection', async () => {
    const proc = fakeProcess([]);
    expect(await exitCodeOrOne(Promise.reject(new Error('down')), proc.stderr)).toBe(1);
    expect(proc.written).toEqual(['down\n']);
  });
});

describe('writeOrFail', () => {
  it('writes the produced text and returns 0', async () => {
    const lines: string[] = [];
    expect(
      await writeOrFail(
        (line) => lines.push(line),
        async () => 'report',
      ),
    ).toBe(0);
    expect(lines).toEqual(['report']);
  });

  it('writes the error message and returns 1 when producing fails', async () => {
    const lines: string[] = [];
    const failing = async (): Promise<string> => {
      throw new Error('no store');
    };
    expect(await writeOrFail((line) => lines.push(line), failing)).toBe(1);
    expect(lines).toEqual(['no store']);
  });
});

describe('setExitCodeWhenInvoked', () => {
  it('sets the exit code from main when the module is the invoked script', async () => {
    const proc: { exitCode?: number } = {};
    const invoked = pathToFileURL(process.argv[1] ?? '').href;
    await setExitCodeWhenInvoked(invoked, async () => 3, proc);
    expect(proc.exitCode).toBe(3);
  });

  it('leaves the exit code alone and skips main for an imported module', async () => {
    const proc: { exitCode?: number } = {};
    let ran = false;
    await setExitCodeWhenInvoked(
      'file:///not/invoked.ts',
      async () => {
        ran = true;
        return 3;
      },
      proc,
    );
    expect(ran).toBe(false);
    expect(proc.exitCode).toBeUndefined();
  });
});
