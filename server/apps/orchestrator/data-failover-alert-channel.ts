/**
 * Trade-channel adapter for the live OHLCV failover alert (#562) — the
 * fourteenth outbound operator escalation, and the criterion #560 could not
 * meet: its `FAILOVER:` line reached the backfill script's own stdout, which
 * nobody is watching during a fourteen-day unattended soak.
 *
 * Same shape as `TradeChannelMiCoverageAlert`: wrap the already-provisioned
 * Telegram client and post to the ESCALATION chat,
 * never the heartbeat chat (#342) — leaving the primary market-data vendor is
 * a fact that should interrupt someone, not a beat.
 *
 * What it replaces on that path is `LoggingDataFailoverAlertChannel`
 * (console-channels.ts), which writes the same facts to the log at `warn`.
 *
 * A failed post rejects rather than being swallowed; `buildFailoverDataSource`
 * (production/data-failover.ts) catches and logs it, so the failover still
 * returns its bars and the undelivered alert is on the record.
 */
import type { DataFailoverAlert, DataFailoverAlertChannel } from './production/data-failover.js';
import { TradeChannelAlert } from './trade-channel.js';

function formatDataFailoverAlert(alert: DataFailoverAlert): string {
  return (
    `Samurai MARKET-DATA FAILOVER (${alert.leg}): ${alert.primaryName} failed for ` +
    `${alert.symbol} ${alert.timeframe} at ${alert.reported_at.toISOString()} — ` +
    `${alert.primaryError}\n` +
    (alert.suppressed_since_last > 0
      ? `${alert.suppressed_since_last} further failover(s) for this instrument were suppressed ` +
        'by the alert throttle since the last message — the stall is ongoing, not intermittent.\n'
      : '') +
    `${alert.fallbackName} is serving those bars instead. The run continues on a DEGRADED ` +
    'data path: fallback bars are stamped with their own source, and their volume convention ' +
    "differs from the primary's, which moves getADV()'s denominator while they sit in the " +
    'window. Marks are NOT failed over — only bars — so a primary that cannot quote still ' +
    'fails loudly. Check whether the primary vendor is stalled.'
  );
}

export class TradeChannelDataFailoverAlert
  extends TradeChannelAlert
  implements DataFailoverAlertChannel
{
  async postDataFailoverAlert(alert: DataFailoverAlert): Promise<void> {
    const text = formatDataFailoverAlert(alert);
    await this.send(text);
  }
}
