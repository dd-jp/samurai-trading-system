/**
 * Suite-wide guard: no test may create, replace or delete a real shared store
 * file in the checkout it is running from.
 *
 * `sharedStorePath()` (src/shared/store/open-shared-store.ts) resolves to
 * `data/samurai-{mode}.sqlite` RELATIVE to the process cwd, and vitest's cwd is
 * the repo root — the same file a live `yarn orchestrator` is holding open. On
 * 2026-08-06 `startup.test.ts` opened and then `rmSync`-ed that exact path
 * while a paper run was mid-flight. Nothing failed visibly: the orchestrator
 * and the dashboard both kept writing to the now-unlinked inode, so the damage
 * was only that the whole session — including the `llm_spend` rows ADR-0008's
 * $50 cap is measured over — would vanish at the next restart.
 *
 * That is a defect no assertion inside the offending test can catch, because
 * the test passed. It has to be observed from outside the test, which is what
 * this is: the store files' identity is recorded before the first test file and
 * compared after the last.
 *
 * Identity is the INODE, not the mtime. A live orchestrator writes to its store
 * continuously while the suite runs, so mtime changes constantly and means
 * nothing; the inode changes only if the file was unlinked and recreated —
 * exactly the event being guarded. A `null` on both sides (no such file, the
 * normal state of a fresh checkout) passes.
 *
 * A test that genuinely needs the production path resolution must relocate its
 * own cwd to a temp directory, as the #330 test in
 * `src/orchestrator/startup.test.ts` now does.
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';

/** Mirrors `STORE_MODES` — duplicated rather than imported so this guard does
 * not load application code before the suite starts. Drift is caught by the
 * store's own tests, which assert the full set of paths.
 *
 * `data/` itself is guarded alongside the files, and it is the entry that
 * catches the worse event. A store file absent at snapshot time and absent
 * afterwards reads as unchanged — which is precisely the state of a checkout
 * whose live store has ALREADY been unlinked out from under a running process,
 * so the files alone would go blind exactly when the damage is in flight. The
 * directory's inode changes on any `rm -rf data/` even when every file inside
 * it was already gone. */
const GUARDED_STORE_PATHS = [
  'data',
  'data/samurai-paper.sqlite',
  'data/samurai-live.sqlite',
  'data/samurai-backtest.sqlite',
  // #552/#554 gave Market Intelligence its OWN database file, and it is a real
  // store path by the same argument as the three above: the soak's archive of
  // every article it has ever ingested, and the only record of what the
  // analysts could see at each tick. Re-creating it loses the `ingested_at`
  // history that makes a replay honest, and there is no second copy anywhere.
  //
  // Added after this guard caught `startFromEnvironment` opening the paper
  // archive by default from `smoke-run.ts` and ten `startup.test.ts` sites —
  // it fired on `data` alone, but only on a checkout where `data/` did not
  // already exist, so a developer whose soak had ever run saw green.
  'data/samurai-mi-paper.sqlite',
  'data/samurai-mi-live.sqlite',
  'data/samurai-mi-backtest.sqlite',
] as const;

/** The inode of the file or directory, or `null` when it does not exist. */
function identity(path: string): string | null {
  try {
    return String(statSync(path).ino);
  } catch {
    return null;
  }
}

function snapshot(root: string): Map<string, string | null> {
  return new Map(GUARDED_STORE_PATHS.map((path) => [path, identity(join(root, path))]));
}

export default function setup(): () => void {
  const root = process.cwd();
  const before = snapshot(root);

  return () => {
    const after = snapshot(root);
    const damaged = GUARDED_STORE_PATHS.filter((path) => before.get(path) !== after.get(path));

    if (damaged.length === 0) return;

    // Throwing from a `globalSetup` teardown is reported ("error during close")
    // but does NOT fail the run — measured on vitest 4.1.10, exit code 0 with a
    // deliberately offending probe test. A guard that reports a live-store wipe
    // and then exits green is worse than no guard, because `yarn precommit` and
    // CI both read the exit code and nothing else. So the exit code is set
    // here, and the throw is kept only because it is what prints the message.
    process.exitCode = 1;

    throw new Error(
      `A test created, replaced or deleted a real shared store path in this checkout: ` +
        `${damaged.join(', ')}. Those belong to live paper/live/backtest runs — ` +
        `unlinking one while a process holds it open silently strands the whole session on ` +
        `an inode with no name, taking the ADR-0008 llm_spend accounting with it. Open ` +
        `':memory:' via openSharedStore, or relocate the test's cwd to a temp directory ` +
        `before exercising the production path resolution (see the #330 test in ` +
        `src/orchestrator/startup.test.ts).`,
    );
  };
}
