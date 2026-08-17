/**
 * #764 — the stdout-write class #714 fixed for the orchestrator, decided
 * separately for the supervisor entrypoint. See
 * `server/shared/stdout-fault-guard.ts` for the shared mechanism and the
 * `console.log` measurement; nothing here classifies a fault by code or by
 * call site.
 *
 * ## The decision: an arbitrary uncaught fault CONTINUES the process.
 *
 * The ticket's own framing is right, and it is checked rather than assumed:
 * **nothing restarts this process if it exits.** Grepped for a process
 * manager or OS-level supervision — no `pm2`/`nodemon`/`forever` dependency
 * in `package.json`, no `.plist`/`.service` file anywhere in the repo, no
 * `launchctl`/`systemctl`/`crontab` reference in the docs. README documents
 * exactly one way to run this: `yarn start` / `yarn serve` in a foreground
 * terminal (or a detached tmux session, per `docs/adr/...` deployment notes),
 * stopped by Ctrl-C. If this process exits on an arbitrary fault, the system
 * stays down until a human notices and restarts it by hand — for a live-money
 * system that is a worse outcome than the fault itself. That is the
 * discriminating fact, not "a supervisor that exits defeats its purpose" by
 * itself.
 *
 * "Continue" is cheap here for a reason specific to what this process is:
 * `startSupervisor()`'s job is signal-forwarding and exit-code bookkeeping
 * over two already-spawned OS processes (`server/apps/supervisor/supervisor.ts`).
 * The orchestrator and the dashboard are independent processes that keep
 * running whether or not the supervisor's own JS state is intact — an
 * arbitrary fault here does not touch either child directly, unlike the
 * orchestrator's own fault, which happens inside the process holding
 * positions.
 *
 * The honest residual, named rather than hidden: if the fault lands inside
 * the `running`/`shuttingDown`/`settle` closure in `supervisor.ts` — between
 * a child's `'exit'` and `shutdown()`'s `child.kill()` loop — a later Ctrl-C
 * might not reach both children, and `done` might never resolve, hanging
 * `yarn serve` with both children still live. That is still strictly better
 * than the alternative this ticket is deciding against: exiting the
 * supervisor turns that same fault into a hard SIGTERM race against whichever
 * child is mid-drain, which is the exact orphaned-verdict shape #209 exists to
 * detect. A hung supervisor with two live children is recoverable by a manual
 * `kill -9`, matching the escape hatch `supervisor.ts` already documents for
 * a stuck drain; a supervisor that is simply gone is not.
 *
 * ## Both streams, not just stdout
 *
 * The realistic failure this ticket targets — a closed terminal, a detached
 * tmux session torn down from under the process — does not usually destroy
 * only stdout; stderr shares the same fd more often than not
 * (`JsonLogger.lastResort`, logger.ts, #714). Both `watchSupervisorStdout`'s
 * own report and `installSupervisorContinueOnFault`'s fault report write to
 * stderr; an unguarded, also-dead stderr turns that report itself into a
 * second async fault with no handler, undoing the continue-posture. Confirmed
 * empirically the same way as the dashboard's guard (see its module doc) —
 * a stdout-only listener died 4 writes in on the stderr report's own EPIPE; a
 * no-op stderr listener ran to completion. So `watchSupervisorStdout`
 * subscribes to stderr's `'error'` event too, with a no-op handler.
 *
 * ## Two guards, installed at two different times (deliberately)
 *
 * `watchSupervisorStdout` must be installed **immediately**, before the first
 * `console.log` — `index.ts`'s startup banner is the earliest one.
 *
 * `installSupervisorContinueOnFault` must be installed **after
 * `startSupervisor()` returns**, not before. `index.ts` already wraps that
 * call in a `try/catch` that stops the process on a synchronous failure
 * (message-only, matching the orchestrator's own credential-safety posture) —
 * that is a *pre-spawn* failure, with nothing yet running, and today's
 * behaviour for it is unchanged: it still stops. Installing a continue-posture
 * handler before that point would risk swallowing exactly the failure that
 * `try/catch` exists to surface.
 */
import { describeThrown } from '../../shared/safe-log.js';
import {
  type ContinueOnFaultEffects,
  type ErrorStream,
  guardedWrite,
  installContinueOnFault,
  type StdoutStream,
  watchStdoutErrors,
} from '../../shared/stdout-fault-guard.js';

/**
 * Subscribes to stdout's `'error'` event so a destroyed pipe degrades rather
 * than reaching `uncaughtException` — see the module doc's measurement.
 * Reports once, on stderr, that console output is lost; the children's own
 * stdio is `inherit`, so their output goes straight to the real fds and is
 * unaffected by this process's own stream dying.
 *
 * Also subscribes to stderr's own `'error'` event, with a no-op handler —
 * see the module doc's "Both streams, not just stdout".
 */
export function watchSupervisorStdout(
  stdout: StdoutStream = process.stdout,
  stderr: StdoutStream & ErrorStream = process.stderr,
): void {
  watchStdoutErrors(stderr, () => {
    // Nowhere left to report to — see the module doc. The subscription
    // itself is the entire mechanism.
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

/**
 * Installs the supervisor's "continue" fault handler — see the module doc for
 * why this entrypoint's answer differs from the orchestrator's.
 */
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
