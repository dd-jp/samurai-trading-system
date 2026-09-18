import {
  type ContinueOnFaultEffects,
  describeThrown,
  type ErrorStream,
  guardedWrite,
  installContinueOnFault,
  type StdoutStream,
  watchStdoutErrors,
} from '../../shared/index.js';

export function watchDashboardStdout(
  stdout: StdoutStream = process.stdout,
  stderr: StdoutStream & ErrorStream = process.stderr,
): void {
  watchStdoutErrors(stderr, () => {
  });

  let reported = false;
  watchStdoutErrors(stdout, (error) => {
    if (reported) return;
    reported = true;
    guardedWrite(
      stderr,
      'dashboard: stdout write failed and is retired for the rest of this process ' +
        `(${describeThrown(error)}). Console output is lost; HTTP responses are unaffected (#764).\n`,
    );
  });
}

export function installDashboardContinueOnFault(effects?: ContinueOnFaultEffects): void {
  installContinueOnFault(
    (fault, error) =>
      `dashboard ${fault}: ${describeThrown(error)} — continuing to serve. A dashboard that ` +
      'exits on an arbitrary fault takes the orchestrator down with it (supervisor.ts stops ' +
      'the orchestrator when the dashboard dies), and this process holds no positions for an ' +
      '"unknown state" to strand (#764).',
    effects,
  );
}
