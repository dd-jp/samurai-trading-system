import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Clock } from '../shared/clock.js';
import type { HeartbeatChannel } from './heartbeat.js';
import { Heartbeat } from './heartbeat.js';
import type { Logger } from './types.js';

const NOW = new Date('2026-07-15T14:00:00Z');
const CLOCK: Clock = { now: () => NOW };

function makeLogger(): Logger {
  return { log: vi.fn() };
}

function makeChannel(impl?: (timestamp: Date) => Promise<void>): HeartbeatChannel {
  return { postHeartbeat: vi.fn(impl ?? (async () => {})) };
}

describe('Heartbeat.emit', () => {
  it('posts one heartbeat with the clock timestamp', async () => {
    const channel = makeChannel();
    const heartbeat = new Heartbeat(channel, makeLogger());

    await heartbeat.emit(CLOCK);

    expect(channel.postHeartbeat).toHaveBeenCalledTimes(1);
    expect(channel.postHeartbeat).toHaveBeenCalledWith(NOW);
  });

  it('logs and swallows a channel failure rather than throwing', async () => {
    const channel = makeChannel(async () => {
      throw new Error('channel unreachable');
    });
    const logger = makeLogger();
    const heartbeat = new Heartbeat(channel, logger);

    await expect(heartbeat.emit(CLOCK)).resolves.toBeUndefined();

    expect(logger.log).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'error', stage: 'heartbeat' }),
    );
  });
});

describe('Heartbeat.start', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('posts on a fixed schedule until stopped', async () => {
    const channel = makeChannel();
    const heartbeat = new Heartbeat(channel, makeLogger());

    const handle = heartbeat.start(CLOCK, 60_000);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(channel.postHeartbeat).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(channel.postHeartbeat).toHaveBeenCalledTimes(2);

    heartbeat.stop(handle);
    await vi.advanceTimersByTimeAsync(120_000);

    // A missed heartbeat is externally detectable via silence: once stopped,
    // no further posts occur, however long the watchdog waits.
    expect(channel.postHeartbeat).toHaveBeenCalledTimes(2);
  });
});
