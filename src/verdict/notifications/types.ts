/**
 * Trade-channel notification types (ticket #81). See docs/specs/verdict-spec.md
 * ("Module: Human-in-the-Loop", stories 12/14). Transport clients are injected
 * rather than constructed from credentials here — connection/bot provisioning
 * is an ops/setup task (verdict-spec.md "Out of Scope: Channel provisioning"),
 * mirroring market-data-service/sources' AlpacaClient/CcxtClient/IbkrClient
 * pattern.
 */
import type { RiskDecision } from '../../risk-manager/index.js';
import type { VerdictDecision } from '../types.js';

/**
 * Posts the final go/no-go result (with full context) to a trade channel.
 * Separate from `ApprovalChannel` (../types.js): that seam is the HITL
 * request/response round-trip; this one is the result notification every
 * decision gets, whether or not HITL ever engaged.
 */
export interface TradeChannelNotifier {
  notify(decision: VerdictDecision, riskDecision: RiskDecision, traceId: string): Promise<void>;
}

/** Minimal transport surface for posting a message to a Telegram chat. */
export interface TelegramClient {
  sendMessage(chatId: string, text: string): Promise<void>;
  /**
   * Sends a message with inline approve/reject buttons and resolves once the
   * human responds (or the channel's own timeout mechanics expire it). The
   * client owns the callback-listening/polling details; this call is a
   * single request/response round-trip from the caller's perspective.
   */
  sendApprovalRequest(
    chatId: string,
    text: string,
    timeoutMs: number,
  ): Promise<'approved' | 'rejected' | 'timeout'>;
}

/** Minimal transport surface for posting a message to a Discord channel. */
export interface DiscordClient {
  sendMessage(channelId: string, text: string): Promise<void>;
}
