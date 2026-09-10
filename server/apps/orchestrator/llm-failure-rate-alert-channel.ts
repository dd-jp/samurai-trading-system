/**
 * Trade-channel adapter for the llm-failure-rate alert (#1396). Same shape
 * as `TradeChannelMiCoverageAlert`: wrap the already-provisioned Telegram
 * client, post to the ESCALATION chat (never the heartbeat chat, #342) — an
 * elevated `llm_failure` rate is a decision waiting on the operator (is the
 * provider degraded, is a key rate-limited), not a beat.
 *
 * A failed post rejects rather than being swallowed; `checkLlmFailureRate`
 * (production/llm-failure-rate-guard.ts) catches and logs it, so the tick
 * still returns its answer and the undelivered alert is on the record.
 */
import type {
  LlmFailureRateAlert,
  LlmFailureRateAlertChannel,
} from './production/llm-failure-rate-guard.js';
import { TradeChannelAlert } from './trade-channel.js';

function formatLlmFailureRateAlert(alert: LlmFailureRateAlert): string {
  const hours = Math.round(alert.window_ms / 3_600_000);
  const pct = (alert.rate * 100).toFixed(1);
  return (
    `Samurai LLM FAILURE RATE ELEVATED: ${pct}% of truncations over the last ${hours}h ` +
    `(${alert.llm_failure_count}/${alert.total_count}) truncated on an outright LLM call ` +
    `failure, as of ${alert.reported_at.toISOString()}.\n` +
    'Check the LLM provider status and the rate-limited client for sustained 429s/5xxs — a ' +
    'debate log row alone cannot tell live provider trouble from a spend-cap refusal.'
  );
}

export class TradeChannelLlmFailureRateAlert
  extends TradeChannelAlert
  implements LlmFailureRateAlertChannel
{
  async postLlmFailureRateAlert(alert: LlmFailureRateAlert): Promise<void> {
    await this.send(formatLlmFailureRateAlert(alert));
  }
}
