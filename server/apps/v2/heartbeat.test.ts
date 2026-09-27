import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../shared/index.js';
import { healthchecksHeartbeat, heartbeatFor, NO_HEARTBEAT, withHeartbeat } from './heartbeat.js';

const SECRET = 'https://hc-ping.com/secret-uuid';

function recorder() {
  const entries: Parameters<Logger['log']>[0][] = [];
  const logger: Logger = {
    log: (entry) => {
      entries.push(entry);
    },
  };
  return { entries, logger };
}

describe('healthchecksHeartbeat', () => {
  it('posts success to the ping URL and fail to its /fail endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const { entries, logger } = recorder();
    const beat = healthchecksHeartbeat(`${SECRET}//`, fetchImpl, logger);
    await beat('success');
    await beat('fail');
    expect(fetchImpl.mock.calls.map(([url, init]) => [url, init.method])).toEqual([
      [SECRET, 'POST'],
      [`${SECRET}/fail`, 'POST'],
    ]);
    expect(fetchImpl.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
    expect(entries.map((entry) => [entry.level, entry.event, entry.message])).toEqual([
      ['info', 'v2_heartbeat_sent', 'healthchecks success ping sent'],
      ['info', 'v2_heartbeat_sent', 'healthchecks fail ping sent'],
    ]);
    expect(
      entries.every((entry) => entry.trace_id === 'v2-heartbeat' && entry.stage === 'v2'),
    ).toBe(true);
  });

  it('warns on a non-2xx answer or a thrown fetch, and never logs the URL', async () => {
    const { entries, logger } = recorder();
    const refused = healthchecksHeartbeat(
      SECRET,
      vi.fn().mockResolvedValue({ ok: false, status: 404 }),
      logger,
    );
    await refused('success');
    const thrown = healthchecksHeartbeat(
      SECRET,
      vi.fn().mockRejectedValue(new TypeError(`fetch failed for ${SECRET}`)),
      logger,
    );
    await expect(thrown('fail')).resolves.toBeUndefined();
    expect(entries.map((entry) => [entry.level, entry.event, entry.message])).toEqual([
      ['warn', 'v2_heartbeat_failed', 'healthchecks answered 404'],
      ['warn', 'v2_heartbeat_failed', 'healthchecks fail ping did not complete'],
    ]);
    expect(JSON.stringify(entries)).not.toContain('secret-uuid');
  });

  it('warns and sends nothing when the URL is unset or blank', async () => {
    const fetchImpl = vi.fn();
    const { entries, logger } = recorder();
    await healthchecksHeartbeat(undefined, fetchImpl, logger)('success');
    await healthchecksHeartbeat('  ', fetchImpl, logger)('fail');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(entries.map((entry) => [entry.level, entry.event, entry.message])).toEqual([
      ['warn', 'v2_heartbeat_unset', 'HEALTHCHECKS_PING_URL is not set: no dead-man ping sent'],
      ['warn', 'v2_heartbeat_unset', 'HEALTHCHECKS_PING_URL is not set: no dead-man ping sent'],
    ]);
  });
});

describe('NO_HEARTBEAT', () => {
  it('resolves without sending', async () => {
    await expect(NO_HEARTBEAT('success')).resolves.toBeUndefined();
    await expect(NO_HEARTBEAT('fail')).resolves.toBeUndefined();
  });
});

describe('heartbeatFor', () => {
  const env = { HEALTHCHECKS_PING_URL: SECRET };

  it('never pings on a dry run, even with the URL set', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await heartbeatFor(
      ['--date', '2026-09-28', '--dry-run'],
      env,
      fetchImpl,
      recorder().logger,
    )('success');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('pings the configured URL once on a real run', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await heartbeatFor(['--date', '2026-09-28'], env, fetchImpl, recorder().logger)('success');
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([SECRET]);
  });
});

describe('withHeartbeat', () => {
  it('beats success on exit 0, fail on a non-zero exit, and fail then rethrows on a throw', async () => {
    const beat = vi.fn().mockResolvedValue(undefined);
    expect(await withHeartbeat(() => Promise.resolve(0), beat)).toBe(0);
    expect(await withHeartbeat(() => Promise.resolve(1), beat)).toBe(1);
    const boom = new Error('cycle failed');
    await expect(withHeartbeat(() => Promise.reject(boom), beat)).rejects.toBe(boom);
    expect(beat.mock.calls).toEqual([['success'], ['fail'], ['fail']]);
  });

  it('rethrows the cycle error when the fail beat itself throws', async () => {
    const boom = new Error('cycle failed');
    const beat = vi.fn().mockRejectedValue(new Error('logger down'));
    await expect(withHeartbeat(() => Promise.reject(boom), beat)).rejects.toBe(boom);
  });
});
