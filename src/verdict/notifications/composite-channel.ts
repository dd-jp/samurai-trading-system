/**
 * Combined Telegram + Discord trade channel (ticket #81). See
 * docs/specs/verdict-spec.md ("Channels: Telegram + Discord dedicated trade
 * channel"). `notify` is one logical post from a caller's perspective (fans
 * out to both configured channels internally); HITL approval round-trips
 * through Telegram, the spec's primary approval mechanism.
 */
import type { RiskDecision } from '../../risk-manager/index.js';
import type {
  ApprovalChannel,
  ApprovalOutcome,
  ApprovalRequest,
  VerdictDecision,
} from '../types.js';
import type { TradeChannelNotifier } from './types.js';

export class TradeChannel implements TradeChannelNotifier, ApprovalChannel {
  readonly #telegram: TelegramChannelLike;
  readonly #discord: TradeChannelNotifier | undefined;

  constructor(telegram: TelegramChannelLike, discord?: TradeChannelNotifier) {
    this.#telegram = telegram;
    this.#discord = discord;
  }

  async notify(
    decision: VerdictDecision,
    riskDecision: RiskDecision,
    traceId: string,
  ): Promise<void> {
    await Promise.all([
      this.#telegram.notify(decision, riskDecision, traceId),
      this.#discord?.notify(decision, riskDecision, traceId),
    ]);
  }

  async requestApproval(request: ApprovalRequest): Promise<ApprovalOutcome> {
    return this.#telegram.requestApproval(request);
  }
}

type TelegramChannelLike = TradeChannelNotifier & ApprovalChannel;
