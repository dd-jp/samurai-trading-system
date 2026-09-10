/**
 * Trade-channel adapter for the consecutive analyst-skip alert (#431) — the
 * sixth outbound operator escalation, and the one analysts-spec.md story 25
 * specified and no ticket had built.
 *
 * Same shape as `TradeChannelOrphanAlert` / `TradeChannelUnpricedFillAlert`:
 * wrap the already-provisioned Telegram client rather
 * than introduce a second integration, and post to the ESCALATION chat, never
 * the heartbeat chat (#342) — a stage producing no decisions is a decision
 * waiting on the operator, not a beat.
 *
 * What it replaces on that path is `LoggingAnalystSkipAlertChannel`
 * (console-channels.ts), which writes the same facts to the log at `error` —
 * fine for a supervised run, and not an alert at all at 3am.
 *
 * A failed post rejects rather than being swallowed; `buildAnalystsStep`
 * catches and logs it, so the tick still returns its (empty) answer and the
 * undelivered alert is on the record.
 */
import type { AnalystSkipAlert, AnalystSkipAlertChannel } from './production/analysts-adapter.js';
import { TradeChannelAlert } from './trade-channel.js';

/**
 * Names the instrument, the length of the run, and every mandatory failure
 * behind the current skip — the operator's first question is always "why", and
 * the reasons are the only thing that distinguishes a bad API key from a data
 * outage from a market that is genuinely closed.
 */
function formatAnalystSkipAlert(alert: AnalystSkipAlert): string {
  const reasons = alert.failures
    .map((failure) => `- ${failure.analyst_type} (${failure.role}): ${failure.reason}`)
    .join('\n');

  return (
    `Samurai ANALYST STAGE SKIPPING: ${alert.instrument} has skipped ` +
    `${alert.consecutive_skips} consecutive ticks as of ` +
    `${alert.reported_at.toISOString()}.\n` +
    'No debate, no trade and no decision is being produced for it — the heartbeat keeps ' +
    'beating regardless, so this will not show up as downtime.\n' +
    `Failures behind the current skip:\n${reasons || '- (none reported)'}`
  );
}

export class TradeChannelAnalystSkipAlert
  extends TradeChannelAlert
  implements AnalystSkipAlertChannel
{
  async postAnalystSkipAlert(alert: AnalystSkipAlert): Promise<void> {
    const text = formatAnalystSkipAlert(alert);
    await this.send(text);
  }
}
