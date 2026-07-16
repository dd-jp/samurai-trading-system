import { describe, expect, it, vi } from 'vitest';
import type { Clock } from '../shared/clock.js';
import type { HeartbeatNotifier } from '../verdict/notifications/types.js';
import { TradeChannelHeartbeat } from './heartbeat.js';

describe('TradeChannelHeartbeat.emit', () => {
  it('posts the current clock time to the trade channel', async () => {
    const now = new Date('2026-07-15T14:00:00Z');
    const clock: Clock = { now: () => now };
    const channel: HeartbeatNotifier = { postHeartbeat: vi.fn().mockResolvedValue(undefined) };

    await new TradeChannelHeartbeat(channel).emit(clock);

    expect(channel.postHeartbeat).toHaveBeenCalledTimes(1);
    expect(channel.postHeartbeat).toHaveBeenCalledWith(now);
  });
});
