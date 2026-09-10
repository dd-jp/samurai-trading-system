/**
 * Dead-man's-switch heartbeat (#96) — see docs/specs/orchestrator-spec.md
 * (Module: Heartbeat). Posts a lightweight liveness message to the heartbeat
 * channel on a fixed interval; the alert signal is silence, not content — an
 * external watchdog (out of scope here) checks last-heartbeat-age and alerts
 * if it grows stale. The Orchestrator does not monitor itself.
 *
 * That channel is a destination of its own, not the one the operator
 * escalations use (#342, alert-transport.ts), and the interval defaults to 15
 * minutes rather than 60s: this is the one alert that repeats forever whether
 * or not anything is wrong, so it is the one that can make a human stop
 * reading. Where it posts and how often are both the composition root's
 * decisions — nothing here knows either.
 *
 * A failed post is logged, not thrown: a transient channel outage must not
 * crash the Orchestrator process, since a crash is exactly the failure mode
 * the heartbeat exists to make externally visible via silence.
 */
import type { Clock } from '../../shared/index.js';
import { describeThrownSafely } from '../../shared/index.js';
import type { Logger } from './types.js';

/** The trade-channel surface the heartbeat needs — `heartbeatChannel` in alert-catalogue.ts. */
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
        event: 'heartbeat_post_failed',
        level: 'error',
        message: 'heartbeat post failed',
        payload: { error: describeThrownSafely(error) },
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
