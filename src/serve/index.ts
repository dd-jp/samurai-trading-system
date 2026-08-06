/**
 * `yarn serve` entry point — brings up the orchestrator and the dashboard
 * together in one foreground process, so a single Ctrl-C stops both.
 *
 * Thin by design: everything worth testing lives in `supervisor.ts`, including
 * why a signal is forwarded rather than acted on here. This file only wires
 * the real process to it.
 *
 * `yarn serve` builds first, then runs this; the supervisor spawns the built
 * `dist/` entrypoints directly rather than re-entering the `orchestrator` and
 * `dashboard` scripts, which would each start their own `tsc`.
 */
import { pathToFileURL } from 'node:url';
import { startSupervisor } from './supervisor.js';

// Entrypoint guard, matching orchestrator/index.ts: this file is importable,
// and importing it must not spawn two processes.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log('Samurai serve → starting orchestrator + dashboard. Ctrl+C to stop both.');

  let supervisor: ReturnType<typeof startSupervisor>;
  try {
    // Throws only from the pre-spawn store migration, with nothing spawned.
    // Message only, never the error object — the same posture as
    // orchestrator/index.ts, whose config can reference API credentials.
    supervisor = startSupervisor();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }

  // Forwarded, never acted on locally: the orchestrator drains on SIGINT, and
  // exiting here first would orphan that drain mid-tick. `done` resolves only
  // once both children are actually gone.
  process.on('SIGINT', () => supervisor.shutdown('SIGINT'));
  process.on('SIGTERM', () => supervisor.shutdown('SIGTERM'));

  process.exit(await supervisor.done);
}
