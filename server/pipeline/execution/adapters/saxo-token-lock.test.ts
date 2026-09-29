import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SAXO_TOKEN_LOCK_STALE_MS, tryLockTokenFile } from './saxo-token-lock.js';

describe('tryLockTokenFile', () => {
  let dir: string;
  let tokenPath: string;
  const lockPath = () => `${tokenPath}.lock`;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'saxo-token-lock-'));
    tokenPath = join(dir, 'live.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('grants the lock to the first caller and refuses a second until released', () => {
    const now = Date.now();
    const release = tryLockTokenFile(tokenPath, now);
    expect(release).toBeTypeOf('function');
    expect(tryLockTokenFile(tokenPath, now)).toBeUndefined();

    release?.();

    expect(existsSync(lockPath())).toBe(false);
    expect(tryLockTokenFile(tokenPath, now)).toBeTypeOf('function');
  });

  it('release is idempotent and never removes a lock a later holder took', () => {
    const now = Date.now();
    const first = tryLockTokenFile(tokenPath, now);
    first?.();
    const second = tryLockTokenFile(tokenPath, now);
    first?.();

    expect(existsSync(lockPath())).toBe(true);
    second?.();
    expect(existsSync(lockPath())).toBe(false);
  });

  it('takes over a lock older than the stale limit, left by a crashed holder', () => {
    writeFileSync(lockPath(), 'crashed');
    const old = new Date(Date.now() - SAXO_TOKEN_LOCK_STALE_MS - 1_000);
    utimesSync(lockPath(), old, old);

    expect(tryLockTokenFile(tokenPath, Date.now())).toBeTypeOf('function');
  });

  it('keeps a lock younger than the stale limit', () => {
    writeFileSync(lockPath(), 'live');
    const recent = new Date(Date.now() - SAXO_TOKEN_LOCK_STALE_MS + 5_000);
    utimesSync(lockPath(), recent, recent);

    expect(tryLockTokenFile(tokenPath, Date.now())).toBeUndefined();
  });

  it('refuses rather than throwing when the directory is missing', () => {
    expect(tryLockTokenFile(join(dir, 'absent', 'live.json'), Date.now())).toBeUndefined();
  });
});
