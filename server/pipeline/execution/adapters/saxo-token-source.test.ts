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
import type {
  SaxoRefreshTimers,
  SaxoSessionLostAlert,
  SaxoSessionLostAlertChannel,
  SaxoSessionState,
} from './saxo-token-source.js';
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

function recordingSessionLostAlerts(): SaxoSessionLostAlertChannel & {
  alerts: SaxoSessionLostAlert[];
} {
  const alerts: SaxoSessionLostAlert[] = [];
  return { alerts, postSaxoSessionLostAlert: (alert) => alerts.push(alert) };
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
      sessionLostAlerts?: SaxoSessionLostAlertChannel;
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
      ...(overrides.sessionLostAlerts === undefined
        ? {}
        : { sessionLostAlerts: overrides.sessionLostAlerts }),
    });
    return { refresher, clock, scheduled, entries, calls, logger };
  }

  it('resumes from the saved session on start, with no login', async () => {
    writeTokenFile(path, savedRecord());
    const { refresher } = build();

    expect(await refresher.getAccessToken()).toBe(SAVED_ACCESS);
    expect(refresher.sessionState()).toMatchObject({ status: 'active', failedAttempts: 0 });
    void refresher.stop();
  });

  it('schedules the refresh from the returned lifetimes, ahead of the access token expiry', async () => {
    writeTokenFile(path, savedRecord());
    const { refresher, scheduled, calls } = build();
    refresher.start();

    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.delayMs).toBe(1_200_000 - 60_000);

    scheduled[0]?.callback();
    await refresher.whenIdle();

    expect(calls).toEqual([`grant_type=refresh_token&refresh_token=${SAVED_REFRESH}`]);
    expect(await refresher.getAccessToken()).toBe(ROTATED_ACCESS);
    expect(scheduled).toHaveLength(2);
    expect(scheduled[1]?.delayMs).toBe(1_200_000 - 60_000);
    void refresher.stop();
  });

  it('persists the rotated refresh token BEFORE the new access token is observable', async () => {
    writeTokenFile(path, savedRecord());
    const observed: string[] = [];
    const inUse: SaxoSessionState[] = [];
    const built = build({
      writeRecord: (target, record) => {
        observed.push(readTokenFile(target)?.refreshToken ?? 'none');
        inUse.push(built.refresher.sessionState());
        writeTokenFile(target, record);
      },
    });
    const refresher = built.refresher;
    refresher.start();
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
    void refresher.stop();
  });

  it('carries loggedInAt forward through a rotation unchanged — a rotation is not a manual login (#1524)', async () => {
    const loggedInAt = new Date(START - 86_400_000).toISOString();
    writeTokenFile(path, savedRecord({ loggedInAt }));
    const { refresher, scheduled } = build();
    refresher.start();
    scheduled[0]?.callback();
    await refresher.whenIdle();

    expect(readTokenFile(path)?.loggedInAt).toBe(loggedInAt);
    void refresher.stop();
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
    void refresher.stop();
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
    expect(second.calls).toEqual([`grant_type=refresh_token&refresh_token=${ROTATED_REFRESH}`]);
    second.refresher.stop();
  });

  it('reports the session lost — and refuses to hand out a bearer — when there is no saved session', async () => {
    const { refresher, entries } = build();

    await expect(refresher.getAccessToken()).rejects.toBeInstanceOf(SaxoSessionLostError);
    expect(refresher.sessionState()).toMatchObject({ status: 'lost' });
    expect(entries.map((entry) => entry.event)).toContain('saxo_session_lost');
    expect(JSON.stringify(entries)).toContain('npm run saxo:login');
  });

  it('posts to sessionLostAlerts exactly once per instance, even across repeated failed calls (#1524)', async () => {
    const sessionLostAlerts = recordingSessionLostAlerts();
    const { refresher } = build({ sessionLostAlerts });

    await expect(refresher.getAccessToken()).rejects.toBeInstanceOf(SaxoSessionLostError);
    await expect(refresher.getAccessToken()).rejects.toBeInstanceOf(SaxoSessionLostError);
    await expect(refresher.getAccessToken()).rejects.toBeInstanceOf(SaxoSessionLostError);

    expect(sessionLostAlerts.alerts).toHaveLength(1);
    expect(sessionLostAlerts.alerts[0]).toMatchObject({
      environment: 'sim',
      reason: expect.stringContaining('npm run saxo:login'),
    });
  });

  it('a fresh instance after a re-login alerts again — the episode resets with the process (#1524)', async () => {
    const first = recordingSessionLostAlerts();
    const firstRefresher = build({ sessionLostAlerts: first }).refresher;
    await expect(firstRefresher.getAccessToken()).rejects.toBeInstanceOf(SaxoSessionLostError);
    expect(first.alerts).toHaveLength(1);

    writeTokenFile(path, savedRecord());
    const second = recordingSessionLostAlerts();
    const secondRefresher = build({ sessionLostAlerts: second }).refresher;
    expect(await secondRefresher.getAccessToken()).toBe(SAVED_ACCESS);
    expect(second.alerts).toHaveLength(0);
    void secondRefresher.stop();

    const failing = build({
      sessionLostAlerts: second,
      fetchImpl: async () => new Response('{"error":"invalid_grant"}', { status: 400 }),
    });
    failing.refresher.start();
    failing.scheduled[0]?.callback();
    await failing.refresher.whenIdle();
    expect(second.alerts).toHaveLength(1);

    failing.scheduled[0]?.callback();
    await failing.refresher.whenIdle();
    expect(second.alerts).toHaveLength(1);
  });

  it('does not page when no sessionLostAlerts channel is supplied (log-only posture)', async () => {
    const { refresher, entries } = build();

    await expect(refresher.getAccessToken()).rejects.toBeInstanceOf(SaxoSessionLostError);

    expect(entries.map((entry) => entry.event)).toContain('saxo_session_lost');
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
    void refresher.stop();
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

    clock.advance(3_600_000 - 3_000);
    scheduled[scheduled.length - 1]?.callback();
    await refresher.whenIdle();

    expect(refresher.sessionState()).toMatchObject({ status: 'lost' });
    await expect(refresher.getAccessToken()).rejects.toBeInstanceOf(SaxoSessionLostError);
  });

  it('puts no token value in any log line or error message', async () => {
    writeTokenFile(path, savedRecord());
    const { refresher, scheduled, entries } = build({
      fetchImpl: async () => new Response(`refused for ${SAVED_REFRESH}`, { status: 500 }),
      backoff: { baseMs: 1_000, maxMs: 1_000 },
    });
    refresher.start();
    scheduled[0]?.callback();
    await refresher.whenIdle();
    void refresher.stop();

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
    void refresher.stop();
  });

  it('does not resolve stop() until a rotation in flight has been written to disk', async () => {
    writeTokenFile(path, savedRecord());
    let releaseGateway = (): void => {};
    const gatewayAnswered = new Promise<void>((resolve) => {
      releaseGateway = resolve;
    });
    const { refresher, scheduled } = build({
      fetchImpl: async () => {
        await gatewayAnswered;
        return tokenResponse({ access_token: ROTATED_ACCESS, refresh_token: ROTATED_REFRESH });
      },
    });
    refresher.start();
    scheduled[0]?.callback();

    const stopped = refresher.stop();
    releaseGateway();
    await stopped;

    expect(readTokenFile(path)?.refreshToken).toBe(ROTATED_REFRESH);
  });

  it('refuses rather than handing out an expired bearer once it has been stopped', async () => {
    writeTokenFile(path, savedRecord());
    const { refresher, clock, calls } = build();
    refresher.start();
    await refresher.stop();
    clock.advance(1_200_001);

    await expect(refresher.getAccessToken()).rejects.toBeInstanceOf(SaxoSessionLostError);
    await expect(refresher.getAccessToken()).rejects.toThrow(/could not be renewed/);
    expect(calls).toEqual([]);
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
