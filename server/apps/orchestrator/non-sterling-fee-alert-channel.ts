/**
 * Trade-channel adapter for the non-sterling-fee alert (#1465) — the
 * twenty-fifth outbound operator escalation.
 *
 * Same shape as `TradeChannelThresholdClampAlert`: wrap the already-
 * provisioned Telegram client rather than introduce a second integration,
 * post to the ESCALATION chat (never the heartbeat chat, #342). Unlike that
 * one, the port itself is `Promise<void>` (`NonSterlingFeeAlertChannel`
 * mirrors `ResidualExposureAlertChannel`'s posture per #1465's own ask) and
 * awaited by its one caller (`warnOnNonSterlingFee`, ingest-fills.ts), which
 * already wraps the call in its own try/catch and never re-throws — so this
 * class does not need its own internal swallow the way
 * `TradeChannelThresholdClampAlert`'s synchronous port does.
 */
import type {
  NonSterlingFeeAlert,
  NonSterlingFeeAlertChannel,
} from '../../pipeline/execution/index.js';
import { TradeChannelAlert } from './trade-channel.js';

/**
 * Composed only from the alert's own curated fields — no broker error, no
 * response body. See `NonSterlingFeeAlert`'s CREDENTIALS note for why that
 * boundary is hard.
 */
function formatNonSterlingFeeAlert(alert: NonSterlingFeeAlert): string {
  return (
    `Samurai NON-STERLING FEE: ${alert.instrument} (lot ${alert.idempotency_key}) booked a fill ` +
    `fee of ${alert.fee} ${alert.fee_currency}, not ${alert.book_currency}.\n` +
    `Fill ${alert.broker_fill_id}. tradeableUniverse() should have excluded this instrument — ` +
    'check the universe pool and universe-selector wiring for a selection-layer defect.'
  );
}

export class TradeChannelNonSterlingFeeAlert
  extends TradeChannelAlert
  implements NonSterlingFeeAlertChannel
{
  async postNonSterlingFeeAlert(alert: NonSterlingFeeAlert): Promise<void> {
    await this.send(formatNonSterlingFeeAlert(alert));
  }
}
