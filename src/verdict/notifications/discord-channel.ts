/**
 * Discord trade-channel adapter (ticket #81). See docs/specs/verdict-spec.md
 * ("Module: Human-in-the-Loop": "Channels: Telegram (inline approve/reject) +
 * Discord"). Discord is notification-only here — the spec names Telegram's
 * inline buttons as the primary approval mechanism; Discord mirrors
 * decisions/approval-requests for visibility. The `DiscordClient` transport
 * is injected — provisioning is an ops task (spec "Out of Scope").
 */
import type { RiskDecision } from '../../risk-manager/types.js';
import type { VerdictDecision } from '../types.js';
import { formatDecisionMessage, formatHeartbeatMessage } from './format.js';
import type { DiscordClient, HeartbeatNotifier, TradeChannelNotifier } from './types.js';

export class DiscordChannel implements TradeChannelNotifier, HeartbeatNotifier {
  readonly #client: DiscordClient;
  readonly #channelId: string;

  constructor(client: DiscordClient, channelId: string) {
    this.#client = client;
    this.#channelId = channelId;
  }

  async notify(decision: VerdictDecision, riskDecision: RiskDecision): Promise<void> {
    await this.#client.sendMessage(this.#channelId, formatDecisionMessage(decision, riskDecision));
  }

  async postHeartbeat(timestamp: Date): Promise<void> {
    await this.#client.sendMessage(this.#channelId, formatHeartbeatMessage(timestamp));
  }
}
