import {
  type ContinueOnFaultEffects,
  describeThrown,
  type ErrorStream,
  guardedWrite,
  installContinueOnFault,
  type StdoutStream,
  watchStdoutErrors,
} from '../../shared/index.js';

export function watchSupervisorStdout(
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
      'supervisor: stdout write failed and is retired for the rest of this process ' +
        `(${describeThrown(error)}). The orchestrator and dashboard children write to their ` +
        'own inherited stdio and are unaffected (#764).\n',
    );
  });
}

export function installSupervisorContinueOnFault(effects?: ContinueOnFaultEffects): void {
  installContinueOnFault(
    (fault, error) =>
      `supervisor ${fault}: ${describeThrown(error)} — continuing to supervise. Nothing ` +
      'restarts this process if it exits (#764: no process manager, no launchd/systemd unit, ' +
      'no cron loop — grepped, not assumed), so exiting would leave the whole system down until ' +
      'a human notices, which is worse than continuing with two already-spawned children still ' +
      'running underneath it.',
    effects,
  );
}
