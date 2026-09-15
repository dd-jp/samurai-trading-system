/**
 * Supervises the two long-lived processes — orchestrator and dashboard — as a
 * single foreground `npm run serve`. Logic lives here rather than in `index.ts`
 * so it is reachable by a test; the entrypoint is the thin half, mirroring
 * `dashboard/server.ts` + `dashboard/index.ts`.
 *
 * Three decisions are load-bearing:
 *
 * **The children are spawned against `dist/`, not via `npm run orchestrator` /
 * `npm run dashboard`.** Both of those scripts begin with `npm run build`, so
 * spawning them would run two `tsc` invocations concurrently into the same
 * `dist/`. `npm run serve` builds once, then this file launches the built
 * entrypoints. `--env-file=.env.local` stays on the *children* so each
 * inherits exactly the environment behaviour of its own script, including
 * refusing to start when `.env.local` is absent — and `npm run serve` passes the
 * same flag to *this* process, which is load-bearing rather than cosmetic:
 * `sharedStorePath()` derives the database filename from `SAMURAI_MODE`
 * (#330), so a supervisor that skipped the env file could migrate a different
 * file than the one its children then open. A consequence worth knowing when
 * reading a failure: with the flag on the supervisor, a missing `.env.local`
 * is now refused *here*, before either child is spawned, so the error names
 * this process rather than one of the two below it.
 *
 * **A signal is forwarded, and then the supervisor waits for both children to
 * exit.** It must not `process.exit()` on the signal itself. The orchestrator's
 * SIGINT handler drains — it awaits the in-flight tick before exiting — and
 * killing this process first orphans that drain mid-pass, between Verdict's
 * `go` and Execution's write, which is precisely the orphaned verdict #209
 * exists to detect. For the same reason there is no bounded wait and no
 * escalation to SIGKILL: a timer here would re-create that orphan on a slow
 * tick. The orchestrator deliberately ignores a second signal, so the manual
 * escape hatch is `kill -9` on the child, chosen by the operator.
 *
 * **Either child dying takes the other down, and the exit code is non-zero.**
 * `serve` means "both up"; one silently down is the failure worth surfacing
 * loudly. The asymmetric alternative — keep trading when only the dashboard
 * dies — would make this the unattended-soak launcher, which it is not:
 * `npm run orchestrator` remains the money-path entrypoint.
 *
 * `detached` is left at its default (false) so the children stay in this
 * process group and a terminal Ctrl-C reaches them directly. The explicit
 * forwarding below is what covers the other case — `kill -TERM` aimed at the
 * supervisor alone — and double-signalling the orchestrator is safe, because
 * `buildShutdownHandler` guards re-entry.
 */
import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { openSharedStore, sharedStorePath } from '../../shared/store/index.js';
import { JsonLogger } from '../orchestrator/logger.js';

/** The subset of `child_process.spawn` this module uses, so tests can inject. */
export type SpawnFn = (command: string, args: readonly string[]) => ChildProcess;

/** The subset of a spawned child this module observes. */
export type SupervisedChild = Pick<ChildProcess, 'kill'> & {
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  once(event: 'error', listener: (error: Error) => void): void;
};

/**
 * Migrates the shared store to completion, then lets go of it.
 *
 * This exists because `serve` is the first thing that opens that database from
 * two processes *simultaneously* — until now an operator started `npm run
 * orchestrator` and `npm run dashboard` seconds apart, by hand. `runMigrations`
 * reads `schema_migrations` outside a transaction and then applies each
 * migration inside its own, so two processes opening a brand-new file can both
 * conclude nothing is applied and both run `CREATE TABLE`.
 *
 * This is not a narrow window. Measured at exactly the two-process width
 * `serve` uses, against a fresh DB: **48 of 50 trials failed**, splitting
 * between "table bars already exists" and "database is locked". With the store
 * migrated first: 0 of 50. Without this call the first-ever `npm run serve` on a
 * clean machine would almost certainly have died on startup — and, under the
 * fail-fast policy below, taken the other half down with it.
 *
 * Doing it here closes the race deterministically rather than by a timing
 * guess: by the time either child opens the file, every migration is already
 * recorded, so neither writes schema at all. A sleep-based stagger would only
 * shrink the window. Fixing the check-then-act in `migrate.ts` is the deeper
 * fix and belongs to the shared store, not to this script — nothing else in
 * the repo starts two openers at once, so nothing else is exposed to it today.
 */
function migrateSharedStore(): void {
  const db = openSharedStore(sharedStorePath());
  db.close();
}

export interface SupervisorEffects {
  /** Defaults to `child_process.spawn` with `stdio: 'inherit'`. */
  spawn?: SpawnFn;
  /** Defaults to `process.execPath` — the Node binary running the supervisor. */
  execPath?: string;
  /** Where the two entrypoints were built. Defaults to the `dist/` convention. */
  scripts?: { orchestrator: string; dashboard: string };
  /** Node flags applied to each child. Defaults to `--env-file=.env.local`. */
  nodeArgs?: readonly string[];
  /** Sink for the one thing this module reports: a child dying unrequested. */
  log?: (message: string) => void;
  /**
   * Run once, before either child is spawned. Defaults to
   * `migrateSharedStore`; throwing aborts the launch with nothing spawned.
   */
  prepare?: () => void;
}

export interface Supervisor {
  /** Forwards `signal` to every still-running child. Idempotent. */
  shutdown(signal: NodeJS.Signals): void;
  /**
   * Resolves once BOTH children have exited, with the code to exit on: `0`
   * only when both exited cleanly during a requested shutdown.
   */
  readonly done: Promise<number>;
}

const DEFAULT_SCRIPTS = {
  orchestrator: 'dist/server/apps/orchestrator/index.js',
  dashboard: 'dist/server/apps/service-api/index.js',
} as const;

const DEFAULT_NODE_ARGS = ['--env-file=.env.local'] as const;

/**
 * Signals that mean "someone asked for this to stop", whoever sent them.
 *
 * A terminal Ctrl-C reaches the children through the process group at the same
 * moment it reaches this process, so a child can be observed dead *before* the
 * supervisor's own handler has run. Without this set that race would report a
 * clean Ctrl-C as a crash and exit non-zero. SIGKILL is deliberately absent:
 * the documented escape hatch is manual, and it should still read as a failure.
 *
 * This set does not cover the orchestrator, which traps SIGINT and exits 0
 * *voluntarily* after draining — so its exit carries `signal=null`, matching
 * nothing here. What keeps that case at exit 0 is the supervisor's own handler
 * winning the race, which it does because draining costs at least a tick.
 * Measured rather than assumed: 25/25 trials of a real group-delivered SIGINT
 * exited 0, with the orchestrator stand-in returning code=0, signal=null.
 */
const REQUESTED_STOP: ReadonlySet<string> = new Set(['SIGINT', 'SIGTERM']);

/**
 * Migrates the store, spawns both children, and returns the handle the
 * entrypoint drives.
 *
 * Spawning happens eagerly here — by the time this returns, both processes are
 * launched — so a caller that never awaits `done` still gets both running. A
 * throwing `prepare` propagates with nothing spawned and nothing to clean up;
 * a `spawn` that throws propagates too, but only after signalling whichever
 * child it had already launched.
 */
/**
 * The default log sink's logger (#1035). Module-level so one supervisor run
 * has one logger, and stdout-only for the reason `service-api/index.ts`
 * documents: the orchestrator this process supervises owns the rotating file.
 */
const supervisorLogger = new JsonLogger();

export function startSupervisor(effects: SupervisorEffects = {}): Supervisor {
  const spawn: SpawnFn =
    effects.spawn ?? ((command, args) => nodeSpawn(command, [...args], { stdio: 'inherit' }));
  const execPath = effects.execPath ?? process.execPath;
  const scripts = effects.scripts ?? DEFAULT_SCRIPTS;
  const nodeArgs = effects.nodeArgs ?? DEFAULT_NODE_ARGS;
  // #1035: the default sink is now structured, so a supervisor line is
  // parseable and stage-filterable like every other line. Still a `(message:
  // string) => void` seam, so every injected `effects.log` in the tests is
  // unaffected.
  const log =
    effects.log ??
    ((message: string) => {
      supervisorLogger.log({
        trace_id: 'startup',
        stage: 'supervisor',
        event: 'supervisor_notice',
        level: 'warn',
        message,
      });
    });

  (effects.prepare ?? migrateSharedStore)();

  let shuttingDown = false;
  let exitCode = 0;

  const running = new Map<string, SupervisedChild>();
  const exits: Promise<void>[] = [];

  for (const name of ['orchestrator', 'dashboard'] as const) {
    let child: SupervisedChild;
    try {
      child = spawn(execPath, [...nodeArgs, scripts[name]]);
    } catch (error) {
      // `spawn` reports most failures asynchronously — ENOENT arrives as an
      // `'error'` event, handled below — but an argument it rejects outright
      // throws here instead. On the second child that would return out of
      // this function with the first one already live and no supervisor left
      // holding it: exactly the orphan this module exists to prevent. Ask the
      // survivors to stop, then let the caller see the original failure.
      shutdown('SIGTERM');
      throw error;
    }
    running.set(name, child);

    exits.push(
      new Promise<void>((resolve) => {
        // `'error'` and `'exit'` are not mutually exclusive, and Node does not
        // promise `'exit'` after an `'error'` at all. Both paths therefore end
        // in one guarded `settle`: without it a spawn failure would leave this
        // promise pending forever and hang `serve` with the other half live,
        // and an unhandled `'error'` would throw out of the supervisor and
        // orphan a child mid-drain — the two failures this module exists to
        // prevent.
        let settled = false;
        const settle = (): void => {
          if (settled) return;
          settled = true;
          running.delete(name);
          // Unconditional and idempotent: one half down means both come down,
          // and the survivor is asked rather than killed so it still drains.
          // SIGTERM regardless of what took the first child — when it died on
          // its own there is no signal to relay.
          shutdown('SIGTERM');
          resolve();
        };

        child.once('exit', (code, signal) => {
          // Read before `settle` calls `shutdown` and flips it, so the first
          // child's death is judged against the state that preceded it.
          const requested = shuttingDown || (signal !== null && REQUESTED_STOP.has(signal));

          // When already settled the `'error'` path has accounted for this
          // child; its code must not be overwritten.
          if (!settled) {
            if (!requested) {
              // An exit nobody asked for is a failure of `serve` itself,
              // whichever half it was: what survives is half a system. Note
              // the floor at 1 — a child that exits *cleanly* on its own
              // (`kill -TERM` aimed at the orchestrator alone, which drains
              // and returns 0) is still a failure of `serve`, and reporting
              // success while logging "stopping the other" would strand a
              // `npm run serve || alert` caller with no alert.
              exitCode = code === null || code === 0 ? 1 : code;
              log(`${name} exited (${signal ?? `code ${code ?? 'unknown'}`}); stopping the other.`);
            } else if (code !== null && code !== 0 && exitCode === 0) {
              // A requested stop that failed to drain cleanly still has to
              // reach the shell as a non-zero status.
              exitCode = code;
            }
          }

          settle();
        });

        child.once('error', (error) => {
          if (!settled) {
            // Never a requested stop: the process could not be spawned, or a
            // signal could not be delivered to it.
            if (exitCode === 0) exitCode = 1;
            log(`${name} failed: ${error.message}; stopping the other.`);
          }
          settle();
        });
      }),
    );
  }

  function shutdown(signal: NodeJS.Signals): void {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of running.values()) child.kill(signal);
  }

  return {
    shutdown,
    done: Promise.all(exits).then(() => exitCode),
  };
}
