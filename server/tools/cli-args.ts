import { existsSync } from 'node:fs';
import { assertStorePathMatchesMode } from '../apps/orchestrator/index.js';
import { resolveStoreMode, sharedStorePath } from '../shared/store/index.js';

export const DEFAULT_WINDOW_DAYS = 30;

export function parseWindowDays(argv: readonly string[]): number {
  const index = argv.indexOf('--days');
  if (index === -1) return DEFAULT_WINDOW_DAYS;

  const raw = argv[index + 1];
  const days = Number(raw);
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error(`--days must be a positive number of days, got ${JSON.stringify(raw)}.`);
  }
  return days;
}

export function assertDbPathExists(dbPath: string): void {
  if (!existsSync(dbPath)) {
    throw new Error(`--db ${dbPath} does not exist — refusing to create a new database file.`);
  }
}

export function resolveDbPathFromArgv(argv: readonly string[]): string {
  const explicitDbIndex = argv.indexOf('--db');
  const explicitDbPath = explicitDbIndex === -1 ? undefined : argv[explicitDbIndex + 1];
  if (explicitDbIndex !== -1 && explicitDbPath === undefined) {
    throw new Error('--db requires a path argument.');
  }

  if (explicitDbPath !== undefined) {
    assertDbPathExists(explicitDbPath);
    return explicitDbPath;
  }
  const mode = resolveStoreMode();
  const dbPath = sharedStorePath(mode);
  assertStorePathMatchesMode({ dbPath, mode });
  return dbPath;
}
