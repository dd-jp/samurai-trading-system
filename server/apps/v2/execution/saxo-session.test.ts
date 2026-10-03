import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readKeepAliveState, writeKeepAliveState } from './saxo/saxo-keepalive-state.js';
import type { SaxoTokenFileRecord } from './saxo/saxo-token-file.js';
import { writeTokenFile } from './saxo/saxo-token-file.js';
import { SaxoSessionLostError } from './saxo/saxo-token-source.js';
import {
  recordedSessionLoss,
  recordSessionLoss,
  saxoSessionRefusal,
  sessionLossOf,
} from './saxo-session.js';

const NOW = new Date('2026-09-29T12:00:00.000Z');
const iso = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();

function record(overrides: Partial<SaxoTokenFileRecord> = {}): SaxoTokenFileRecord {
  return {
    environment: 'live',
    accessToken: 'access-fixture',
    refreshToken: 'refresh-fixture',
    accessTokenExpiresAt: iso(-60_000),
    refreshTokenExpiresAt: iso(1_800_000),
    obtainedAt: iso(-1_000_000),
    ...overrides,
  };
}

describe('saxoSessionRefusal', () => {
  let dir: string;
  let tokenPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'saxo-session-'));
    tokenPath = join(dir, 'live.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('accepts a session whose refresh token is alive, even with the access token expired', () => {
    writeTokenFile(tokenPath, record());
    expect(saxoSessionRefusal(NOW, tokenPath)).toBeUndefined();
  });

  it('refuses with the login command when nothing was ever logged in', () => {
    expect(saxoSessionRefusal(NOW, tokenPath)).toContain('npm run saxo:login');
  });

  it('refuses an unreadable token file rather than throwing', () => {
    writeFileSync(tokenPath, 'not json');
    expect(saxoSessionRefusal(NOW, tokenPath)).toContain('unreadable');
  });

  it('refuses a session saved for the other gateway', () => {
    writeTokenFile(tokenPath, record({ environment: 'sim' }));
    expect(saxoSessionRefusal(NOW, tokenPath)).toContain('sim gateway');
  });

  it('refuses at the exact instant the refresh token expires, and not a millisecond before', () => {
    writeTokenFile(tokenPath, record({ refreshTokenExpiresAt: iso(0) }));
    expect(saxoSessionRefusal(NOW, tokenPath)).toContain('expired');

    writeTokenFile(tokenPath, record({ refreshTokenExpiresAt: iso(1) }));
    expect(saxoSessionRefusal(NOW, tokenPath)).toBeUndefined();
  });

  it('refuses while the keep-alive has recorded the session lost since the token was issued', () => {
    writeTokenFile(tokenPath, record({ obtainedAt: iso(-600_000) }));
    writeKeepAliveState(tokenPath, { lostAt: iso(-300_000), lostReason: 'rejected (HTTP 400)' });

    expect(saxoSessionRefusal(NOW, tokenPath)).toContain('rejected (HTTP 400)');
  });

  it('accepts again once a login newer than the loss record has replaced the token', () => {
    writeTokenFile(tokenPath, record({ obtainedAt: iso(-100_000) }));
    writeKeepAliveState(tokenPath, { lostAt: iso(-300_000), lostReason: 'rejected (HTTP 400)' });

    expect(saxoSessionRefusal(NOW, tokenPath)).toBeUndefined();
  });

  it('treats a loss record stamped the same instant as the token as still lost', () => {
    writeTokenFile(tokenPath, record({ obtainedAt: iso(-300_000) }));
    writeKeepAliveState(tokenPath, { lostAt: iso(-300_000), lostReason: 'r' });

    expect(saxoSessionRefusal(NOW, tokenPath)).toBeDefined();
  });

  it('still refuses when the loss record carries no reason', () => {
    writeTokenFile(tokenPath, record({ obtainedAt: iso(-600_000) }));
    writeKeepAliveState(tokenPath, { lostAt: iso(-300_000) });

    expect(saxoSessionRefusal(NOW, tokenPath)).toContain('reason not recorded');
  });

  it('ignores a warning-only state', () => {
    writeTokenFile(tokenPath, record());
    writeKeepAliveState(tokenPath, { warnedAt: iso(-1_000) });

    expect(saxoSessionRefusal(NOW, tokenPath)).toBeUndefined();
  });
});

describe('recordSessionLoss', () => {
  let dir: string;
  let tokenPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'saxo-session-loss-'));
    tokenPath = join(dir, 'live.json');
    writeTokenFile(tokenPath, record({ obtainedAt: iso(-600_000) }));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('records the loss so the refusal reads it, keeping an earlier warning', () => {
    writeKeepAliveState(tokenPath, { warnedAt: iso(-60_000) });
    recordSessionLoss('rejected (HTTP 401)', NOW, tokenPath);

    expect(readKeepAliveState(tokenPath)).toEqual({
      warnedAt: iso(-60_000),
      lostAt: NOW.toISOString(),
      lostReason: 'rejected (HTTP 401)',
    });
    expect(recordedSessionLoss(tokenPath)).toContain('rejected (HTTP 401)');
    expect(saxoSessionRefusal(NOW, tokenPath)).toContain('rejected (HTTP 401)');
  });

  it('keeps the first record of an outage', () => {
    writeKeepAliveState(tokenPath, { lostAt: iso(-300_000), lostReason: 'first' });
    recordSessionLoss('second', NOW, tokenPath);

    expect(readKeepAliveState(tokenPath)).toEqual({ lostAt: iso(-300_000), lostReason: 'first' });
  });

  it('overwrites a loss record older than the current session', () => {
    writeKeepAliveState(tokenPath, { lostAt: iso(-900_000), lostReason: 'stale' });
    recordSessionLoss('fresh', NOW, tokenPath);

    expect(readKeepAliveState(tokenPath)).toEqual({
      lostAt: NOW.toISOString(),
      lostReason: 'fresh',
    });
  });

  it('reports no recorded loss without a saved session', () => {
    expect(recordedSessionLoss(join(dir, 'absent.json'))).toBeUndefined();
  });
});

describe('sessionLossOf', () => {
  it('reads a session-lost error and ignores any other failure', () => {
    expect(sessionLossOf(new SaxoSessionLostError('lost'))).toBe('lost');
    expect(sessionLossOf(new Error('SAXO_LIVE_APP_KEY is not set'))).toBeUndefined();
  });
});
