import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../shared/index.js';
import { liveTokenSource, openSaxoLiveSession, SaxoReadOnlyApi } from './saxo-api.js';

const ENV = { SAXO_LIVE_APP_KEY: 'key', SAXO_LIVE_APP_SECRET: 'secret' };

const inMinutes = (minutes: number): string =>
  new Date(Date.now() + minutes * 60_000).toISOString();

function tokenFile(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'saxo-session-')), 'live.json');
  writeFileSync(
    path,
    JSON.stringify({
      accessToken: 'a',
      refreshToken: 'r',
      accessTokenExpiresAt: inMinutes(20),
      refreshTokenExpiresAt: inMinutes(60),
      environment: 'live',
      obtainedAt: inMinutes(0),
    }),
  );
  return path;
}

function recorder() {
  const entries: Parameters<Logger['log']>[0][] = [];
  const logger: Logger = {
    log: (entry) => {
      entries.push(entry);
    },
  };
  return { entries, logger };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('openSaxoLiveSession', () => {
  it('refuses without the live app credentials, before touching a token file', () => {
    expect(() => openSaxoLiveSession({}, '/nonexistent/live.json')).toThrow(/SAXO_LIVE_APP_KEY/);
  });

  it('refuses a dead session and reports it through the given logger, not stdout', () => {
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { entries, logger } = recorder();
    expect(() => openSaxoLiveSession(ENV, '/nonexistent/live.json', logger)).toThrow(
      /Saxo token dead, needs `npm run saxo:login`/,
    );
    expect(entries.map((entry) => [entry.event, entry.level])).toEqual([
      ['saxo_session_lost', 'error'],
    ]);
    expect(stdout).not.toHaveBeenCalled();
  });

  it('opens a read-only API on a live session and stops its refresher', async () => {
    const path = tokenFile();
    const session = openSaxoLiveSession(ENV, path, recorder().logger);
    expect(session.api).toBeInstanceOf(SaxoReadOnlyApi);
    await expect(session.stop()).resolves.toBeUndefined();
  });
});

describe('liveTokenSource', () => {
  it('keeps writing to the console when no logger is given', () => {
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(() => liveTokenSource(ENV, '/nonexistent/live.json')).toThrow(/Saxo token dead/);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('saxo_session_lost'));
  });
});
