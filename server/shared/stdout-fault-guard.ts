export interface StdoutStream {
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export interface ErrorStream {
  write(line: string): unknown;
}

export function watchStdoutErrors(stdout: StdoutStream, onFault: (error: Error) => void): void {
  stdout.on('error', onFault);
}

export function guardedWrite(stream: ErrorStream, line: string): void {
  try {
    stream.write(line);
  } catch {}
}

export type ProcessFault = 'uncaughtException' | 'unhandledRejection';

export interface ContinueOnFaultEffects {
  stderr: ErrorStream;
  on: (event: ProcessFault, handler: (error: unknown) => void) => void;
}

export function installContinueOnFault(
  describe: (fault: ProcessFault, error: unknown) => string,
  effects: ContinueOnFaultEffects = {
    stderr: process.stderr,
    on: (event, handler) => {
      process.on(event, handler);
    },
  },
): void {
  const report = (fault: ProcessFault) => (error: unknown) => {
    guardedWrite(effects.stderr, `${describe(fault, error)}\n`);
  };
  effects.on('uncaughtException', report('uncaughtException'));
  effects.on('unhandledRejection', report('unhandledRejection'));
}
