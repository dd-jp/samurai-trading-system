/**
 * Trade-channel notification types (ticket #81). See docs/specs/verdict-spec.md
 * ("Module: Human-in-the-Loop", stories 12/14). Transport clients are injected
 * rather than constructed from credentials here — connection/bot provisioning
 * is an ops/setup task (verdict-spec.md "Out of Scope: Channel provisioning"),
 * mirroring market-data-service/sources' AlpacaMarketDataClient/CcxtClient/
 * IbkrClient pattern.
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

/**
 * Identifies the pending approval a set of inline buttons resolves, and how
 * long the client's correlation tokens for it stay live. `timeout_ms` is the
 * originating `ApprovalRequest.timeout_ms`, so the client's token map and
 * `SignedApprovalChannel`'s pending entry expire together.
 */
export interface ApprovalButtonTarget {
  trace_id: string;
  idempotency_key: string;
  timeout_ms: number;
}

/**
 * An inbound button press that has already passed the transport's own
 * identity check (Telegram: `callback_query.from.id` against
 * `TELEGRAM_ALLOWED_USER_IDS`) and matched a live correlation token.
 */
export interface ApprovalCallback {
  trace_id: string;
  idempotency_key: string;
  outcome: 'approved' | 'rejected';
}

/**
 * Minimal transport surface for a Telegram bot.
 *
 * The former `sendApprovalRequest` (ticket #81) is retired as of #275: it
 * baked in a synchronous request/response round trip that the decided
 * transport — long polling (`getUpdates`) — structurally cannot offer, since
 * the human's answer arrives on a separate inbound `callback_query`, not as
 * that call's return value. See docs/specs/transport-layer-spec.md ("Module:
 * TelegramClient"). The replacement is two halves of the same round trip:
 * a non-blocking send, and a handler registration for the inbound half.
 */
export interface TelegramClient {
  sendMessage(chatId: string, text: string): Promise<void>;
  /**
   * Posts an approval request with approve/reject inline buttons, each tagged
   * with an opaque correlation token minted at send time. Resolves once the
   * message is posted — it does **not** wait for the human.
   */
  sendApprovalButtons(chatId: string, text: string, target: ApprovalButtonTarget): Promise<void>;
  /**
   * Registers a handler for inbound button presses. The handler is invoked
   * only after the transport's identity check has passed and the correlation
   * token has been matched to a live request — an unauthorized or unmatched
   * press never reaches it.
   */
  onApprovalCallback(handler: (callback: ApprovalCallback) => void): void;
}

/** Minimal transport surface for posting a message to a Discord channel. */
export interface DiscordClient {
  sendMessage(channelId: string, text: string): Promise<void>;
}
