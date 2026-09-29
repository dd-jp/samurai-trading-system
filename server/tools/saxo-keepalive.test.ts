import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { alertsFor } from '../apps/v2/alerts.js';
import {
  keepAliveStatePath,
  readKeepAliveState,
  writeKeepAliveState,
} from '../pipeline/execution/adapters/saxo-keepalive-state.js';
import type { FetchLike } from '../pipeline/execution/adapters/saxo-oauth.js';
import type { SaxoTokenFileRecord } from '../pipeline/execution/adapters/saxo-token-file.js';
import { readTokenFile, writeTokenFile } from '../pipeline/execution/adapters/saxo-token-file.js';
import type { LogEntry, Logger } from '../shared/index.js';
import { recordingLogger } from '../shared/recording-logger.js';
import {
  jsonlFileLogger,
  runSaxoKeepAlive,
  WARN_WHEN_REFRESH_REMAINING_MS,
} from './saxo-keepalive.js';

const NOW = Date.parse('2026-09-29T12:00:00.000Z');
const SAVED_REFRESH = 'refresh-token-saved-fixture';
const SAVED_ACCESS = 'access-token-saved-fixture';
const ROTATED_REFRESH = 'refresh-token-rotated-fixture';
const ROTATED_ACCESS = 'access-token-rotated-fixture';
const ENV = { SAXO_LIVE_APP_KEY: 'key-fixture', SAXO_LIVE_APP_SECRET: 'secret-fixture' };

function liveRecord(overrides: Partial<SaxoTokenFileRecord> = {}): SaxoTokenFileRecord {
  return {
    environment: 'live',
    accessToken: SAVED_ACCESS,
    refreshToken: SAVED_REFRESH,
    accessTokenExpiresAt: new Date(NOW + 600_000).toISOString(),
    refreshTokenExpiresAt: new Date(NOW + 3_000_000).toISOString(),
    obtainedAt: new Date(NOW - 600_000).toISOString(),
    ...overrides,
  };
}

const okGateway: FetchLike = async () =>
  new Response(
    JSON.stringify({
      access_token: ROTATED_ACCESS,
      refresh_token: ROTATED_REFRESH,
      expires_in: 1200,
      refresh_token_expires_in: 3600,
    }),
    { status: 201 },
  );

const statusGateway =
  (status: number): FetchLike =>
  async () =>
    new Response('{"error":"x"}', { status });

describe('runSaxoKeepAlive', () => {
  let dir: string;
  let tokenPath: string;
  let now: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'saxo-keepalive-'));
    tokenPath = join(dir, 'live.json');
    now = NOW;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function run(fetchImpl: FetchLike, env: NodeJS.ProcessEnv = ENV) {
    const journal = recordingLogger();
    const alertLog = recordingLogger();
    const sent: { severity: string; text: string }[] = [];
    const telegram = alertsFor(
      [],
      { ...env, TELEGRAM_BOT_TOKEN: 'bot-fixture', TELEGRAM_CHAT_ID: 'chat-fixture' },
      async (_url, init) => {
        const body = JSON.parse(String(init.body)) as { text: string };
        sent.push({ severity: 'sent', text: body.text });
        return { ok: true, status: 200 };
      },
      alertLog,
    );
    const promise = runSaxoKeepAlive({
      env,
      tokenPath,
      clock: { now: () => new Date(now) },
      alerts: telegram,
      journal,
      fetchImpl,
      sleep: async () => {},
    });
    return { promise, journal, sent, alertLog };
  }

  it('rotates the token, exits 0, alerts nobody, and journals the new expiries', async () => {
    writeTokenFile(tokenPath, liveRecord());
    const { promise, journal, sent } = run(okGateway);

    expect(await promise).toBe(0);

    expect(readTokenFile(tokenPath)?.refreshToken).toBe(ROTATED_REFRESH);
    expect(sent).toEqual([]);
    const summary = journal.entries.find((entry) => entry.event === 'saxo_keepalive_run');
    expect(summary?.payload).toMatchObject({
      outcome: 'refreshed',
      access_token_expires_at: new Date(NOW + 1_200_000).toISOString(),
      refresh_token_expires_at: new Date(NOW + 3_600_000).toISOString(),
    });
  });

  it('with no saved session, alerts critical once, tells David to log in, and stays quiet after', async () => {
    const first = run(okGateway);
    expect(await first.promise).toBe(1);

    expect(first.sent).toHaveLength(1);
    expect(first.sent[0]?.text).toContain('CRITICAL');
    expect(first.sent[0]?.text).toContain('npm run saxo:login');
    expect(readKeepAliveState(tokenPath).lostAt).toBe(new Date(NOW).toISOString());

    const second = run(okGateway);
    expect(await second.promise).toBe(1);
    expect(second.sent).toEqual([]);
  });

  it('a rejected refresh token alerts once and never overwrites the saved token', async () => {
    writeTokenFile(tokenPath, liveRecord());
    const before = readFileSync(tokenPath, 'utf8');

    const first = run(statusGateway(400));
    expect(await first.promise).toBe(1);
    const second = run(statusGateway(400));
    expect(await second.promise).toBe(1);

    expect(readFileSync(tokenPath, 'utf8')).toBe(before);
    expect(first.sent).toHaveLength(1);
    expect(first.sent[0]?.text).toContain('rejected (HTTP 400)');
    expect(second.sent).toEqual([]);
  });

  it('an expired refresh token is reported lost without calling the gateway', async () => {
    writeTokenFile(
      tokenPath,
      liveRecord({ refreshTokenExpiresAt: new Date(NOW - 1_000).toISOString() }),
    );
    let calls = 0;
    const { promise, sent } = run(async () => {
      calls += 1;
      return okGateway('', {});
    });

    expect(await promise).toBe(1);
    expect(calls).toBe(0);
    expect(sent[0]?.text).toContain('expired');
  });

  it('a transient failure with time left retries silently and leaves the token untouched', async () => {
    writeTokenFile(tokenPath, liveRecord());
    const before = readFileSync(tokenPath, 'utf8');
    const { promise, sent, journal } = run(statusGateway(503));

    expect(await promise).toBe(1);

    expect(sent).toEqual([]);
    expect(readFileSync(tokenPath, 'utf8')).toBe(before);
    expect(existsSync(keepAliveStatePath(tokenPath))).toBe(false);
    expect(
      journal.entries.find((entry) => entry.event === 'saxo_keepalive_run')?.payload,
    ).toMatchObject({ outcome: 'failing', failed_attempts: 1 });
  });

  it('warns once when a transient failure leaves the refresh window nearly closed', async () => {
    writeTokenFile(
      tokenPath,
      liveRecord({
        refreshTokenExpiresAt: new Date(NOW + WARN_WHEN_REFRESH_REMAINING_MS).toISOString(),
      }),
    );
    const first = run(statusGateway(503));
    expect(await first.promise).toBe(1);
    const second = run(statusGateway(503));
    expect(await second.promise).toBe(1);

    expect(first.sent).toHaveLength(1);
    expect(first.sent[0]?.text).toContain('warning');
    expect(first.sent[0]?.text).toContain(
      new Date(NOW + WARN_WHEN_REFRESH_REMAINING_MS).toISOString(),
    );
    expect(second.sent).toEqual([]);
  });

  it('does not warn while the refresh window is one millisecond above the threshold', async () => {
    writeTokenFile(
      tokenPath,
      liveRecord({
        refreshTokenExpiresAt: new Date(NOW + WARN_WHEN_REFRESH_REMAINING_MS + 1).toISOString(),
      }),
    );
    const { promise, sent } = run(statusGateway(503));

    expect(await promise).toBe(1);
    expect(sent).toEqual([]);
  });

  it('a warned outage that then dies still escalates to critical', async () => {
    writeTokenFile(tokenPath, liveRecord());
    writeKeepAliveState(tokenPath, { warnedAt: new Date(NOW - 60_000).toISOString() });
    const { promise, sent } = run(statusGateway(401));

    expect(await promise).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain('CRITICAL');
    expect(readKeepAliveState(tokenPath)).toMatchObject({
      warnedAt: new Date(NOW - 60_000).toISOString(),
      lostAt: new Date(NOW).toISOString(),
    });
  });

  it('re-arms after a re-login: a good refresh clears the outage so the next one alerts again', async () => {
    const dead = run(okGateway);
    await dead.promise;
    expect(dead.sent).toHaveLength(1);

    writeTokenFile(tokenPath, liveRecord());
    const recovered = run(okGateway);
    expect(await recovered.promise).toBe(0);
    expect(existsSync(keepAliveStatePath(tokenPath))).toBe(false);
    expect(recovered.journal.entries.map((entry) => entry.event)).toContain(
      'saxo_keepalive_recovered',
    );

    rmSync(tokenPath);
    const again = run(okGateway);
    await again.promise;
    expect(again.sent).toHaveLength(1);
  });

  it('missing app credentials are an outage too: critical once, no crash', async () => {
    writeTokenFile(tokenPath, liveRecord());
    const first = run(okGateway, {});
    expect(await first.promise).toBe(1);
    const second = run(okGateway, {});
    expect(await second.promise).toBe(1);

    expect(first.sent).toHaveLength(1);
    expect(first.sent[0]?.text).toContain('SAXO_LIVE_APP_KEY');
    expect(second.sent).toEqual([]);
  });

  it('never puts a token value in an alert, a journal entry or the state file', async () => {
    writeTokenFile(tokenPath, liveRecord());
    const first = run(statusGateway(400));
    await first.promise;
    writeTokenFile(tokenPath, liveRecord());
    const second = run(okGateway);
    await second.promise;

    const everything = JSON.stringify([
      first.sent,
      first.journal.entries,
      second.sent,
      second.journal.entries,
      existsSync(keepAliveStatePath(tokenPath)) ? readKeepAliveState(tokenPath) : {},
    ]);
    for (const secret of [
      SAVED_REFRESH,
      SAVED_ACCESS,
      ROTATED_REFRESH,
      ROTATED_ACCESS,
      'secret-fixture',
    ]) {
      expect(everything).not.toContain(secret);
    }
  });

  it('a stray keep-alive state file cannot block a healthy rotation', async () => {
    writeTokenFile(tokenPath, liveRecord());
    writeFileSync(keepAliveStatePath(tokenPath), 'garbage');
    const { promise } = run(okGateway);

    expect(await promise).toBe(0);
  });
});

describe('jsonlFileLogger', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'saxo-keepalive-log-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends one masked JSON line per entry, creating the directory', () => {
    const path = join(dir, 'nested', 'saxo-keepalive.jsonl');
    const logger: Logger = jsonlFileLogger(path, () => new Date(NOW));
    const entry: LogEntry = {
      trace_id: 't',
      stage: 'orchestrator',
      level: 'info',
      event: 'e',
      message: 'Bearer abc.def.ghi leaked',
    };
    logger.log(entry);
    logger.log({ ...entry, message: 'second' });

    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1] as string)).toMatchObject({
      ts: new Date(NOW).toISOString(),
      message: 'second',
    });
    expect(lines[0]).not.toContain('abc.def.ghi');
  });

  it('never lets a failed write break the run', () => {
    writeFileSync(join(dir, 'blocker'), 'x');
    const logger = jsonlFileLogger(join(dir, 'blocker', 'log.jsonl'), () => new Date(NOW));

    expect(() =>
      logger.log({ trace_id: 't', stage: 's', level: 'info', event: 'e', message: 'm' }),
    ).not.toThrow();
  });
});
