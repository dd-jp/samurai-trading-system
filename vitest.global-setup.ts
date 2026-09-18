import { statSync } from 'node:fs';
import { join } from 'node:path';

const GUARDED_STORE_PATHS = [
  'data',
  'data/samurai-paper.sqlite',
  'data/samurai-live.sqlite',
  'data/samurai-backtest.sqlite',
  'data/samurai-mi-paper.sqlite',
  'data/samurai-mi-live.sqlite',
  'data/samurai-mi-backtest.sqlite',
] as const;

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
