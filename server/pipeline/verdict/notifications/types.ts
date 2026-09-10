/**
 * Trade-channel notification types (ticket #81). See docs/specs/verdict-spec.md
 * ("Module: Human-in-the-Loop", stories 12/14). Transport clients are injected
 * rather than constructed from credentials here — connection/bot provisioning
 * is an ops/setup task (verdict-spec.md "Out of Scope: Channel provisioning"),
 * mirroring market-data-service/sources' AlpacaMarketDataClient/LseMarkClient
 * pattern.
 */
import type { RiskDecision } from '../../risk-manager/index.js';
import type { VerdictDecision } from '../types.js';

/**
 * Posts the final go/no-go result (with full context) to a trade channel.
 * Separate from `ApprovalChannel` (../types.js): that seam is the
 * request/response round-trip; this one is the result notification every
 * decision gets.
 */
export interface TradeChannelNotifier {
  notify(decision: VerdictDecision, riskDecision: RiskDecision, traceId: string): Promise<void>;
}

/**
 * Outbound transport surface for a Telegram bot. Nothing is received: there
 * is no human gate (ADR-0007, ADR-0013), so no inbound polling.
 */
export interface TelegramClient {
  sendMessage(chatId: string, text: string): Promise<void>;
}
