/**
 * Telegram trade-channel adapter (ticket #81). See docs/specs/verdict-spec.md
 * ("Module: Human-in-the-Loop": "Telegram inline approve/reject buttons
 * primary"). The `TelegramClient` transport is injected — bot token /chat
 * provisioning is an ops task (spec "Out of Scope: Channel provisioning"),
 * mirroring market-data-service/sources/alpaca-source.ts's injected client.
 *
 * **This class is the result-notification half only.** Its `requestApproval`
 * (and `implements ApprovalChannel`) were retired in #275: it delegated to
 * `TelegramClient.sendApprovalRequest`, a synchronous round trip the decided
 * long-polling transport cannot offer, and was never constructed outside its
 * own test. The live HITL gate is `TelegramApprovalGateway` over
 * `SignedApprovalChannel` (#207) — see ./telegram/telegram-approval-gateway.ts
 * and docs/specs/transport-layer-spec.md ("Module: TelegramClient").
 */
import type { RiskDecision } from '../../risk-manager/index.js';
import type { VerdictDecision } from '../types.js';
import { formatDecisionMessage } from './format.js';
import type { TelegramClient, TradeChannelNotifier } from './types.js';

export class TelegramChannel implements TradeChannelNotifier {
  readonly #client: TelegramClient;
  readonly #chatId: string;

  constructor(client: TelegramClient, chatId: string) {
    this.#client = client;
    this.#chatId = chatId;
  }

  async notify(decision: VerdictDecision, riskDecision: RiskDecision): Promise<void> {
    await this.#client.sendMessage(this.#chatId, formatDecisionMessage(decision, riskDecision));
  }
}
