import type { Clock } from '../../shared/index.js';
import { describeThrownSafely } from '../../shared/index.js';
import type { Logger } from './types.js';

export interface HeartbeatChannel {
  postHeartbeat(timestamp: Date): Promise<void>;
}

export class Heartbeat {
  constructor(
    private readonly channel: HeartbeatChannel,
    private readonly logger: Logger,
  ) {}

  async emit(clock: Clock): Promise<void> {
    try {
      await this.channel.postHeartbeat(clock.now());
    } catch (error) {
      this.logger.log({
        trace_id: 'heartbeat',
        stage: 'heartbeat',
        event: 'heartbeat_post_failed',
        level: 'error',
        message: 'heartbeat post failed',
        payload: { error: describeThrownSafely(error) },
      });
    }
  }

  start(clock: Clock, intervalMs: number): NodeJS.Timeout {
    return setInterval(() => {
      void this.emit(clock);
    }, intervalMs);
  }

  stop(handle: NodeJS.Timeout): void {
    clearInterval(handle);
  }
}
