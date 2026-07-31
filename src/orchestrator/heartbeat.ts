/**
 * Dead-man's-switch heartbeat (#96) — see docs/specs/orchestrator-spec.md
 * (Module: Heartbeat). Posts a lightweight liveness message over the trade
 * channel on a fixed interval; the alert signal is silence, not content — an
 * external watchdog (out of scope here) checks last-heartbeat-age and alerts
 * if it grows stale. The Orchestrator does not monitor itself.
 *
 * A failed post is logged, not thrown: a transient channel outage must not
 * crash the Orchestrator process, since a crash is exactly the failure mode
 * the heartbeat exists to make externally visible via silence.
 */
import type { Clock } from '../shared/index.js';
import type { Logger } from './types.js';

/** The trade-channel surface the heartbeat needs — see heartbeat-channel.ts. */
export interface HeartbeatChannel {
  postHeartbeat(timestamp: Date): Promise<void>;
}

export class Heartbeat {
  constructor(
    private readonly channel: HeartbeatChannel,
    private readonly logger: Logger,
  ) {}

  /** Posts one heartbeat message. Never throws. */
  async emit(clock: Clock): Promise<void> {
    try {
      await this.channel.postHeartbeat(clock.now());
    } catch (error) {
      this.logger.log({
        trace_id: 'heartbeat',
        stage: 'heartbeat',
        level: 'error',
        message: 'heartbeat post failed',
        payload: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  /** Emits on a fixed interval until `stop()` is called. */
  start(clock: Clock, intervalMs: number): NodeJS.Timeout {
    return setInterval(() => {
      void this.emit(clock);
    }, intervalMs);
  }

  stop(handle: NodeJS.Timeout): void {
    clearInterval(handle);
  }
}
