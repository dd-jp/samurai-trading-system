/**
 * Dead-man's-switch heartbeat (#96) — see docs/specs/orchestrator-spec.md
 * (Module: Heartbeat). Reuses Verdict's already-provisioned trade channel
 * (verdict-spec.md story 14) — a different message type on the same channel,
 * not a new integration.
 *
 * `emit` posts one heartbeat; posting it on a fixed interval is the caller's
 * concern (a scheduler wired up wherever the process bootstraps, out of
 * scope here). The alert signal is silence, not content: a separate,
 * unspecced watchdog checks last-heartbeat age. The Orchestrator does not
 * monitor itself.
 */
import type { Clock } from '../shared/clock.js';
import type { HeartbeatNotifier } from '../verdict/notifications/types.js';
import type { Heartbeat } from './types.js';

export class TradeChannelHeartbeat implements Heartbeat {
  constructor(private readonly channel: HeartbeatNotifier) {}

  async emit(clock: Clock): Promise<void> {
    await this.channel.postHeartbeat(clock.now());
  }
}
