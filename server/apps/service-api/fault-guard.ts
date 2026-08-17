/**
 * #764 — the stdout-write class #714 fixed for the orchestrator, decided
 * separately for the dashboard entrypoint. See `server/shared/stdout-fault-guard.ts`
 * for the shared mechanism and the `console.log` measurement; nothing here
 * classifies a fault by code or by call site.
 *
 * ## The decision: an arbitrary uncaught fault CONTINUES the process.
 *
 * The strongest argument for this is already written down in this app, at
 * `index.ts`'s bundle-diagnostic check (PR #597 review): a missing UI build is
 * loud but **not** fatal, because "refusing to start would take away the
 * operator's view of a live trading system... and would take the supervisor's
 * whole process group down with it (`supervisor.ts` stops the orchestrator
 * when the dashboard dies)". An arbitrary uncaught fault reaching this
 * entrypoint is the same trade-off in a different shape: exiting on it does
 * not merely lose the dashboard, it halts trading through
 * `server/apps/supervisor/supervisor.ts`'s "either child dying takes the
 * other down" rule. That blast radius is disproportionate to a fault in a
 * read-only observability surface.
 *
 * The orchestrator's counter-argument — "a process holding real positions
 * must not continue in an unknown state" — does not apply here by
 * construction: this process is stateless between requests (every read goes
 * through `store`/`providers` fresh; `server.ts`'s handlers already catch
 * their own failures and return 5xx, so what reaches an *arbitrary uncaught*
 * fault here is background wiring — the provider poller, an unawaited
 * rejection — not a request in flight). There is no position, no order, no
 * drain to get wrong.
 *
 * The honest residual: a dashboard that stays up while degraded is still read
 * as truth by an operator. Signalling that on `/api/snapshot` itself would
 * touch `contracts/` and the client and is out of scope for this ticket —
 * left for a follow-up, in the spirit of #714 capturing this ticket rather
 * than scope-creeping its own fix.
 *
 * ## Two guards, installed at two different times (deliberately)
 *
 * `watchDashboardStdout` must be installed **immediately**, before the first
 * `console.log` — `index.ts`'s bundle-diagnostic warn is the earliest one.
 *
 * `installDashboardContinueOnFault` must be installed **after boot
 * completes** (after `server.start()` resolves), not before. Before that
 * point this entrypoint has load-bearing refusals — `resolveStoreMode()`
 * (#330) refuses when `SAMURAI_MODE` is unset rather than silently serving a
 * healthy-looking page off the wrong database file, and `openSharedStore`
 * refuses an unmigratable file. Installing a continue-posture fault handler
 * before those run would neuter them: a swallowing `unhandledRejection`
 * handler could leave the process alive with no server ever listening.
 * Today's behaviour for a boot-time fault is unchanged — it still stops —
 * and only a fault while *serving* continues.
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
 * Reports once, on stderr, that console output is lost; HTTP responses do not
 * go through stdout and are unaffected.
 */
export function watchDashboardStdout(
  stdout: StdoutStream = process.stdout,
  stderr: ErrorStream = process.stderr,
): void {
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

/**
 * Installs the dashboard's "continue" fault handler — see the module doc for
 * why this entrypoint's answer differs from the orchestrator's.
 */
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
