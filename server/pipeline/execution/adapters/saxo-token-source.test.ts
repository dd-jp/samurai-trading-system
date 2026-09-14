/**
 * #1523 — the refresher that keeps a Saxo OAuth session alive.
 *
 * Every case here is offline: a fake token endpoint, injected timers and a
 * sandboxed token file. Nothing reads the operator's real saved session, and
 * the one acceptance criterion that needs the live SIM gateway (authenticated
 * calls across consecutive access-token lifetimes) is a measurement, not a
 * test.
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenBucket } from '../../../shared/index.js';
import { recordingLogger } from '../../../shared/recording-logger.js';
import { SaxoHttpBrokerClient } from './saxo-http-client.js';
import type { FetchLike } from './saxo-oauth.js';
import type { SaxoTokenFileRecord } from './saxo-token-file.js';
import { readTokenFile, writeTokenFile } from './saxo-token-file.js';
import type { SaxoRefreshTimers, SaxoSessionState } from './saxo-token-source.js';
import { SaxoSessionLostError, SaxoTokenRefresher } from './saxo-token-source.js';

const CONFIG = {
  tokenUrl: 'https://sim.logonvalidation.net/token',
  appKey: 'app-key-fixture',
  appSecret: 'app-secret-fixture',
};

const SAVED_ACCESS = 'access-token-saved-fixture';
const SAVED_REFRESH = 'refresh-token-saved-fixture';
const ROTATED_ACCESS = 'access-token-rotated-fixture';
const ROTATED_REFRESH = 'refresh-token-rotated-fixture';

const START = Date.parse('2026-09-15T09:00:00.000Z');

function savedRecord(overrides: Partial<SaxoTokenFileRecord> = {}): SaxoTokenFileRecord {
  return {
    environment: 'sim',
    accessToken: SAVED_ACCESS,
    refreshToken: SAVED_REFRESH,
    // The lifetimes measured on live, 2026-09-14: 1200 s / 3600 s.
    accessTokenExpiresAt: new Date(START + 1_200_000).toISOString(),
    refreshTokenExpiresAt: new Date(START + 3_600_000).toISOString(),
    obtainedAt: new Date(START).toISOString(),
    ...overrides,
  };
}

function movableClock(): { now: () => Date; advance: (ms: number) => void } {
  let current = START;
  return {
    now: () => new Date(current),
    advance: (ms) => {
      current += ms;
    },
  };
}

interface ScheduledRefresh {
  callback: () => void;
  delayMs: number;
  cleared: boolean;
}

function fakeTimers(): { timers: SaxoRefreshTimers; scheduled: ScheduledRefresh[] } {
  const scheduled: ScheduledRefresh[] = [];
  return {
    scheduled,
    timers: {
      set(callback, delayMs) {
        scheduled.push({ callback, delayMs, cleared: false });
        return scheduled.length - 1;
      },
      clear(handle) {
        const entry = scheduled[handle as number];
        if (entry !== undefined) entry.cleared = true;
      },
    },
  };
}

function tokenResponse(
  body: { access_token: string; refresh_token: string },
  status = 201,
): Response {
  return new Response(
    JSON.stringify({ ...body, expires_in: 1200, refresh_token_expires_in: 3600 }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

describe('SaxoTokenRefresher', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'saxo-token-source-'));
    path = join(dir, 'sim.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function build(
    overrides: {
      fetchImpl?: FetchLike;
      writeRecord?: (path: string, record: SaxoTokenFileRecord) => void;
      backoff?: { baseMs: number; maxMs: number };
    } = {},
  ) {
    const clock = movableClock();
    const { timers, scheduled } = fakeTimers();
    const logger = recordingLogger();
    const entries = logger.entries;
    const calls: string[] = [];
    const refresher = new SaxoTokenRefresher({
      environment: 'sim',
      config: CONFIG,
      tokenPath: path,
      logger,
      clock,
      timers,
      fetchImpl:
        overrides.fetchImpl ??
        (async (_url, init) => {
          calls.push(String(init.body));
          return tokenResponse({ access_token: ROTATED_ACCESS, refresh_token: ROTATED_REFRESH });
        }),
      ...(overrides.writeRecord === undefined ? {} : { writeRecord: overrides.writeRecord }),
      ...(overrides.backoff === undefined ? {} : { backoff: overrides.backoff }),
    });
    return { refresher, clock, scheduled, entries, calls, logger };
  }

  it('resumes from the saved session on start, with no login', async () => {
    writeTokenFile(path, savedRecord());
    const { refresher } = build();

    expect(await refresher.getAccessToken()).toBe(SAVED_ACCESS);
    expect(refresher.sessionState()).toMatchObject({ status: 'active', failedAttempts: 0 });
    refresher.stop();
  });

  it('schedules the refresh from the returned lifetimes, ahead of the access token expiry', async () => {
    writeTokenFile(path, savedRecord());
    const { refresher, scheduled, calls } = build();
    refresher.start();

    // 1200 s of access-token life, refreshed a minute early — derived from the
    // saved instants, never from a hard-coded 20/40-minute window.
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.delayMs).toBe(1_200_000 - 60_000);

    scheduled[0]?.callback();
    await refresher.whenIdle();

    expect(calls).toEqual([`grant_type=refresh_token&refresh_token=${SAVED_REFRESH}`]);
    expect(await refresher.getAccessToken()).toBe(ROTATED_ACCESS);
    // The next window is armed off the NEW response, not the old record.
    expect(scheduled).toHaveLength(2);
    expect(scheduled[1]?.delayMs).toBe(1_200_000 - 60_000);
    refresher.stop();
  });

  it('persists the rotated refresh token BEFORE the new access token is observable', async () => {
    writeTokenFile(path, savedRecord());
    const observed: string[] = [];
    const inUse: SaxoSessionState[] = [];
    const built = build({
      writeRecord: (target, record) => {
        // Both halves of the ordering, observed mid-write: the file still
        // holds the old refresh token, and the refresher still reports the old
        // session. Either one swapping first is a token in use whose partner
        // is not on disk.
        observed.push(readTokenFile(target)?.refreshToken ?? 'none');
        inUse.push(built.refresher.sessionState());
        writeTokenFile(target, record);
      },
    });
    const refresher = built.refresher;
    refresher.start();
    // Fired late in the access token's life, so the rotated record's expiry is
    // a different instant from the saved one and the swap is observable.
    built.clock.advance(1_140_000);
    built.scheduled[0]?.callback();
    await refresher.whenIdle();

    expect(inUse).toEqual([
      {
        status: 'active',
        accessTokenExpiresAt: savedRecord().accessTokenExpiresAt,
        refreshTokenExpiresAt: savedRecord().refreshTokenExpiresAt,
        failedAttempts: 0,
      },
    ]);
    expect(observed).toEqual([SAVED_REFRESH]);
    expect(readTokenFile(path)?.refreshToken).toBe(ROTATED_REFRESH);
    expect(await refresher.getAccessToken()).toBe(ROTATED_ACCESS);
    refresher.stop();
  });

  it('never adopts a token it could not save — a crash at the persist step leaves the old one in use', async () => {
    writeTokenFile(path, savedRecord());
    const { refresher, scheduled, entries } = build({
      writeRecord: () => {
        throw new Error('simulated crash between receipt and persistence');
      },
      backoff: { baseMs: 1_000, maxMs: 1_000 },
    });
    refresher.start();
    scheduled[0]?.callback();
    await refresher.whenIdle();

    expect(await refresher.getAccessToken()).toBe(SAVED_ACCESS);
    expect(readTokenFile(path)?.refreshToken).toBe(SAVED_REFRESH);
    expect(entries.map((entry) => entry.event)).toContain('saxo_token_persist_failed');
    refresher.stop();
  });

  it('survives a restart: a fresh refresher reads back the rotated session', async () => {
    writeTokenFile(path, savedRecord());
    const first = build();
    first.refresher.start();
    first.scheduled[0]?.callback();
    await first.refresher.whenIdle();
    first.refresher.stop();

    const second = build();
    expect(await second.refresher.getAccessToken()).toBe(ROTATED_ACCESS);
    second.scheduled[0]?.callback();
    await second.refresher.whenIdle();
    // The restarted process refreshes with the token the first one SAVED.
    expect(second.calls).toEqual([`grant_type=refresh_token&refresh_token=${ROTATED_REFRESH}`]);
    second.refresher.stop();
  });

  it('reports the session lost — and refuses to hand out a bearer — when there is no saved session', async () => {
    const { refresher, entries } = build();

    await expect(refresher.getAccessToken()).rejects.toBeInstanceOf(SaxoSessionLostError);
    expect(refresher.sessionState()).toMatchObject({ status: 'lost' });
    expect(entries.map((entry) => entry.event)).toContain('saxo_session_lost');
    expect(JSON.stringify(entries)).toContain('yarn saxo:login');
  });

  it('reports the session lost when the saved refresh token has already expired', async () => {
    writeTokenFile(
      path,
      savedRecord({
        accessTokenExpiresAt: new Date(START - 3_600_000).toISOString(),
        refreshTokenExpiresAt: new Date(START - 1_000).toISOString(),
      }),
    );
    const { refresher, scheduled } = build();

    await expect(refresher.getAccessToken()).rejects.toThrow(/session is lost/);
    expect(scheduled).toHaveLength(0);
  });

  it('refreshes on demand when the access token expired while the process was down', async () => {
    writeTokenFile(
      path,
      savedRecord({ accessTokenExpiresAt: new Date(START - 1_000).toISOString() }),
    );
    const { refresher, scheduled } = build();

    expect(scheduled).toHaveLength(0);
    expect(await refresher.getAccessToken()).toBe(ROTATED_ACCESS);
    refresher.stop();
  });

  it('stops retrying the moment the gateway REJECTS the refresh token', async () => {
    writeTokenFile(path, savedRecord());
    const { refresher, scheduled, entries } = build({
      fetchImpl: async () => new Response('{"error":"invalid_grant"}', { status: 400 }),
    });
    refresher.start();
    scheduled[0]?.callback();
    await refresher.whenIdle();

    expect(refresher.sessionState()).toEqual({
      status: 'lost',
      reason: 'the refresh token was rejected (HTTP 400)',
    });
    // One armed refresh, cleared; no retry behind it.
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.cleared).toBe(true);
    expect(entries.map((entry) => entry.event)).toContain('saxo_session_lost');
  });

  it('retries a transient failure with bounded backoff, then gives up inside the closing window', async () => {
    writeTokenFile(path, savedRecord());
    const { refresher, scheduled, clock } = build({
      fetchImpl: async () => new Response('upstream', { status: 503 }),
      backoff: { baseMs: 1_000, maxMs: 4_000 },
    });
    refresher.start();

    for (const expected of [1_000, 2_000, 4_000, 4_000]) {
      const pending = scheduled[scheduled.length - 1];
      pending?.callback();
      await refresher.whenIdle();
      expect(scheduled[scheduled.length - 1]?.delayMs).toBe(expected);
    }
    expect(refresher.sessionState()).toMatchObject({ status: 'active', failedAttempts: 4 });

    // Inside the last few seconds of the refresh window, another retry could
    // not land before it closes — so the session is declared lost instead.
    clock.advance(3_600_000 - 3_000);
    scheduled[scheduled.length - 1]?.callback();
    await refresher.whenIdle();

    expect(refresher.sessionState()).toMatchObject({ status: 'lost' });
    await expect(refresher.getAccessToken()).rejects.toBeInstanceOf(SaxoSessionLostError);
  });

  it('puts no token value in any log line or error message', async () => {
    writeTokenFile(path, savedRecord());
    const { refresher, scheduled, entries } = build({
      // An upstream body that echoes the secret back is the worst case this
      // has to survive.
      fetchImpl: async () => new Response(`refused for ${SAVED_REFRESH}`, { status: 500 }),
      backoff: { baseMs: 1_000, maxMs: 1_000 },
    });
    refresher.start();
    scheduled[0]?.callback();
    await refresher.whenIdle();
    refresher.stop();

    let thrown = '';
    const lost = build({
      fetchImpl: async () => new Response('{"error":"invalid_grant"}', { status: 400 }),
    });
    lost.refresher.start();
    lost.scheduled[0]?.callback();
    await lost.refresher.whenIdle();
    try {
      await lost.refresher.getAccessToken();
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error);
    }

    const written = `${JSON.stringify(entries)}${JSON.stringify(lost.entries)}${thrown}`;
    for (const secret of [SAVED_ACCESS, SAVED_REFRESH, ROTATED_ACCESS, ROTATED_REFRESH]) {
      expect(written).not.toContain(secret);
    }
    expect(thrown).toMatch(/session is lost/);
  });

  it('is read by SaxoHttpBrokerClient per request, so a rotation mid-run reaches the next call', async () => {
    writeTokenFile(path, savedRecord());
    const { refresher, scheduled } = build();
    refresher.start();

    const sent: (string | undefined)[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        sent.push((init.headers as Record<string, string>).authorization);
        return new Response('{"Data":[]}', { status: 200 });
      }),
    );
    const client = new SaxoHttpBrokerClient({
      environment: 'sim',
      baseUrl: 'https://gateway.example/sim/openapi',
      logger: recordingLogger(),
      tokenSource: refresher,
      rateLimiter: new TokenBucket({ capacity: 1_000, refillPerSecond: 1_000 }),
    });
    try {
      await client.listOpenOrders();
      scheduled[0]?.callback();
      await refresher.whenIdle();
      await client.listOpenOrders();
    } finally {
      vi.unstubAllGlobals();
    }

    expect(sent).toEqual([`Bearer ${SAVED_ACCESS}`, `Bearer ${ROTATED_ACCESS}`]);
    refresher.stop();
  });
});

describe('writeTokenFile (atomic replacement, #1523)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'saxo-token-file-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('leaves no temp file behind and lands the replacement at 0600', () => {
    const path = join(dir, 'sim.json');
    writeTokenFile(path, savedRecord());
    writeTokenFile(path, savedRecord({ refreshToken: ROTATED_REFRESH }));

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readTokenFile(path)?.refreshToken).toBe(ROTATED_REFRESH);
    expect(readFileSync(path, 'utf8')).not.toContain('tmp');
  });

  it('refuses a token file that is not a usable session rather than reading past it', () => {
    const path = join(dir, 'sim.json');
    writeFileSync(path, '{"environment":"sim"}');

    expect(() => readTokenFile(path)).toThrow(/accessToken is missing/);
    expect(readTokenFile(join(dir, 'absent.json'))).toBeUndefined();
  });
});
