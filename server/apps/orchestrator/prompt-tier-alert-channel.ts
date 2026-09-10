/**
 * Trade-channel adapter for the prompt-tier crossing alert (#1155) — the
 * nineteenth outbound operator escalation.
 *
 * Same shape as `TradeChannelThresholdClampAlert`: wrap the already-
 * provisioned Telegram client rather than introduce a second integration,
 * post to the ESCALATION chat (never the heartbeat chat, #342 — a cost-rate
 * change is a decision waiting on the operator, not a beat), and
 * fire-and-forget since the port is synchronous — `record()` is
 * `LlmSpendSink`'s hard "must never fail a call" contract (spend-sink.ts's
 * file doc), so nothing on this path can await a delivery.
 */
import type {
  PromptTierAlert,
  PromptTierAlertChannel,
} from '../../pipeline/debate-engine/index.js';
import type { TelegramClient } from '../../pipeline/verdict/index.js';
import { describeThrownSafely } from '../../shared/index.js';
import { TradeChannelAlert } from './trade-channel.js';
import type { Logger } from './types.js';

export function formatPromptTierAlert(alert: PromptTierAlert): string {
  return (
    `Samurai PROMPT-TIER CROSSED: ${alert.model} priced ${alert.prompt_tokens} prompt ` +
    `tokens, above its ${alert.above_prompt_tokens}-token large-prompt tier ` +
    `(#${alert.consecutive_crossings} consecutive call as of ${alert.reported_at.toISOString()}).\n` +
    'This call priced at the tier rate — a 2.5x unit-cost step against the base rate, ' +
    "against ADR-0008's $50/14d cap.\n" +
    `Trace ${alert.trace_id}, stage ${alert.stage}${alert.debate_id ? `, debate ${alert.debate_id}` : ''}.`
  );
}

export class TradeChannelPromptTierAlert
  extends TradeChannelAlert
  implements PromptTierAlertChannel
{
  readonly #logger: Logger;

  constructor(telegram: TelegramClient, chatId: string, logger: Logger) {
    super(telegram, chatId);
    this.#logger = logger;
  }

  postPromptTierAlert(alert: PromptTierAlert): void {
    const text = formatPromptTierAlert(alert);
    this.sendDetached(text, (error: unknown) => {
      // The one alert whose failure to send must itself stay visible — see
      // `TradeChannelThresholdClampAlert`'s identical reasoning.
      this.#logger.log({
        trace_id: alert.trace_id,
        stage: alert.stage,
        event: 'prompt_tier_alert_send_failed',
        level: 'error',
        message: 'prompt-tier alert failed to send — the crossing still stands',
        payload: {
          model: alert.model,
          consecutive_crossings: alert.consecutive_crossings,
          reported_at: alert.reported_at.toISOString(),
          error: describeThrownSafely(error),
        },
      });
    });
  }
}
