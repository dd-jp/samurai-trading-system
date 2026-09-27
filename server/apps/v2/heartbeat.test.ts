import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../shared/index.js';
import { healthchecksHeartbeat, withHeartbeat } from './heartbeat.js';

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
    const beat = healthchecksHeartbeat(`${SECRET}/`, fetchImpl, logger);
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
    expect(entries.map((entry) => [entry.level, entry.event])).toEqual([
      ['warn', 'v2_heartbeat_unset'],
      ['warn', 'v2_heartbeat_unset'],
    ]);
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
});
