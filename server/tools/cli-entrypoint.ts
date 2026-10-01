import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { maskCredentials } from '../shared/index.js';

export function isMainModule(moduleUrl: string): boolean {
  const invokedPath = process.argv[1];
  return (
    invokedPath !== undefined &&
    moduleUrl ===
      new URL(`file://${isAbsolute(invokedPath) ? invokedPath : resolve(invokedPath)}`).href
  );
}

export interface MainProcess {
  readonly argv: readonly string[];
  readonly stderr: { write(text: string): unknown };
  exit(code: number): void;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function errorStack(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

export function runWhenInvoked(
  moduleUrl: string,
  main: () => Promise<unknown>,
  describe: (error: unknown) => string = errorMessage,
  proc: MainProcess = process,
): Promise<void> {
  const invokedPath = proc.argv[1];
  if (invokedPath === undefined || moduleUrl !== pathToFileURL(invokedPath).href) {
    return Promise.resolve();
  }
  return main().then(
    (code) => {
      if (typeof code === 'number') proc.exit(code);
    },
    (error: unknown) => {
      proc.stderr.write(`${maskCredentials(describe(error))}\n`);
      proc.exit(1);
    },
  );
}

export function onTerminationSignal(
  shutdown: () => Promise<unknown>,
  signals: Pick<NodeJS.Process, 'once'> = process,
): void {
  const handler = () => {
    void shutdown();
  };
  signals.once('SIGINT', handler);
  signals.once('SIGTERM', handler);
}

export function failExitCodeOnRejection(
  run: Promise<unknown>,
  report: (error: unknown) => void = console.error,
  proc: { exitCode?: number | string | null | undefined } = process,
): Promise<void> {
  return run.then(
    () => undefined,
    (error: unknown) => {
      report(error);
      proc.exitCode = 1;
    },
  );
}

export function exitCodeOrOne(
  run: Promise<number>,
  stderr: MainProcess['stderr'] = process.stderr,
): Promise<number> {
  return run.catch((error: unknown) => {
    stderr.write(`${errorMessage(error)}\n`);
    return 1;
  });
}
