/**
 * Combined Telegram + Discord trade channel (ticket #81). See
 * docs/specs/verdict-spec.md ("Channels: Telegram + Discord dedicated trade
 * channel"). `notify` is one logical post from a caller's perspective (fans
 * out to both configured channels internally).
 *
 * **HITL approvals no longer route through here.** This class's
 * `requestApproval` (and `implements ApprovalChannel`) were retired in #275
 * along with `TelegramChannel`'s — it forwarded to a synchronous
 * `TelegramClient.sendApprovalRequest` round trip the decided long-polling
 * transport cannot offer, and was never constructed outside its own test. The
 * live gate is `TelegramApprovalGateway` over `SignedApprovalChannel` (#207);
 * see ./telegram/telegram-approval-gateway.ts and
 * docs/specs/transport-layer-spec.md ("Module: TelegramClient").
 */
import type { RiskDecision } from '../../risk-manager/index.js';
import type { VerdictDecision } from '../types.js';
import type { TradeChannelNotifier } from './types.js';

export class TradeChannel implements TradeChannelNotifier {
  readonly #telegram: TradeChannelNotifier;
  readonly #discord: TradeChannelNotifier | undefined;

  constructor(telegram: TradeChannelNotifier, discord?: TradeChannelNotifier) {
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
}
