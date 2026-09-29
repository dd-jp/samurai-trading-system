import { closeSync, openSync, statSync, unlinkSync, writeSync } from 'node:fs';

export const SAXO_TOKEN_LOCK_STALE_MS = 60_000;

function lockIsStale(lockPath: string, nowMs: number): boolean {
  try {
    return nowMs - statSync(lockPath).mtimeMs > SAXO_TOKEN_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {}
}

function createExclusive(lockPath: string, owner: string): boolean {
  try {
    const fd = openSync(lockPath, 'wx', 0o600);
    writeSync(fd, owner);
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

export function tryLockTokenFile(tokenPath: string, nowMs: number): (() => void) | undefined {
  const lockPath = `${tokenPath}.lock`;
  if (lockIsStale(lockPath, nowMs)) removeQuietly(lockPath);
  const owner = `${process.pid}:${nowMs}`;
  if (!createExclusive(lockPath, owner)) return undefined;
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    removeQuietly(lockPath);
  };
}
