/**
 * Telegram trade-channel adapter (ticket #81). See docs/specs/verdict-spec.md
 * ("Module: Human-in-the-Loop": "Telegram inline approve/reject buttons
 * primary"). The `TelegramClient` transport is injected — bot token /chat
 * provisioning is an ops task (spec "Out of Scope: Channel provisioning"),
 * mirroring market-data-service/sources/alpaca-source.ts's injected client.
 */
import type { RiskDecision } from '../../risk-manager/types.js';
import type {
  ApprovalChannel,
  ApprovalOutcome,
  ApprovalRequest,
  VerdictDecision,
} from '../types.js';
import { formatApprovalRequest, formatDecisionMessage, formatHeartbeatMessage } from './format.js';
import type { HeartbeatNotifier, TelegramClient, TradeChannelNotifier } from './types.js';

export class TelegramChannel implements TradeChannelNotifier, ApprovalChannel, HeartbeatNotifier {
  readonly #client: TelegramClient;
  readonly #chatId: string;

  constructor(client: TelegramClient, chatId: string) {
    this.#client = client;
    this.#chatId = chatId;
  }

  async notify(decision: VerdictDecision, riskDecision: RiskDecision): Promise<void> {
    await this.#client.sendMessage(this.#chatId, formatDecisionMessage(decision, riskDecision));
  }

  async requestApproval(request: ApprovalRequest): Promise<ApprovalOutcome> {
    return this.#client.sendApprovalRequest(
      this.#chatId,
      formatApprovalRequest(request),
      request.timeout_ms,
    );
  }

  async postHeartbeat(timestamp: Date): Promise<void> {
    await this.#client.sendMessage(this.#chatId, formatHeartbeatMessage(timestamp));
  }
}
