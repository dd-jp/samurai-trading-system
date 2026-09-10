/**
 * Trade-channel adapter for the orphaned go-verdict alert (#209) — the third
 * of the three outbound operator alerts, and the one that had no reachable
 * implementation until #322.
 *
 * `TradeChannelHeartbeat` (heartbeat-channel.ts) and
 * `TradeChannelUnpricedFillAlert` (unpriced-fill-channel.ts) already made this
 * exact move for their own alert types: reuse Verdict's already-provisioned
 * Telegram transport rather than introduce a second integration, and
 * wrap the raw clients rather than route through `TradeChannelNotifier.notify`,
 * which is shaped for a `VerdictDecision` and not for an operational anomaly.
 * This file exists because the composition root needed all three to wire a
 * genuinely unattended run (#238) and only two of them existed.
 *
 * What it replaces on that path is `LoggingOrphanAlertChannel`
 * (console-channels.ts), which writes the same facts to the log at `error` —
 * fine for a supervised run, and not an alert at all at 3am.
 *
 * A failed post rejects rather than being swallowed. `OrphanVerdictScanner.scan`
 * catches per orphan and logs the failure (orphan-verdict-scan.ts), so the
 * scan still reports the rest — swallowing here would delete that record and
 * leave an orphan that looks alerted-on when it was not.
 */
import type { OrphanAlertChannel, OrphanGoVerdict } from './orphan-verdict-scan.js';
import { TradeChannelAlert } from './trade-channel.js';

/**
 * Composed from the orphan's own four fields, all of which the recipient needs:
 * `idempotency_key` is the client order id the venue knows the trade by (the
 * reason `OrphanGoVerdict` carries it at all — the scan matches on `trace_id`),
 * and `trace_id` is what finds the pass in `audit_log`/`verdict_log`.
 */
function formatOrphanAlert(orphan: OrphanGoVerdict): string {
  return (
    `Samurai ORPHANED GO VERDICT: a 'go' for ${orphan.instrument} was recorded at ` +
    `${orphan.verdict_timestamp.toISOString()} with no matching execution record — this ` +
    'process died between Verdict and Execution.\n' +
    `Client order id ${orphan.idempotency_key}, trace ${orphan.trace_id}.\n` +
    'An order may or may not have reached the venue, and nothing resubmits or cancels it ' +
    'automatically. Check the venue for that client order id and reconcile it by hand.'
  );
}

export class TradeChannelOrphanAlert extends TradeChannelAlert implements OrphanAlertChannel {
  async postOrphanAlert(orphan: OrphanGoVerdict): Promise<void> {
    const text = formatOrphanAlert(orphan);
    await this.send(text);
  }
}
