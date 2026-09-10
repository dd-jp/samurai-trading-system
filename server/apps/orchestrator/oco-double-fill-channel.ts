/**
 * Trade-channel adapter for the emulated-OCO double-fill alert (#586) — the
 * same move `TradeChannelResidualExposureAlert` makes (residual-exposure-
 * alert-channel.ts): reuse Verdict's already-provisioned Telegram
 * transport rather than introduce a second integration.
 *
 * This is what makes the accepted-risk window's materialisation reachable
 * during an UNATTENDED soak (#238): a double fill means the lot over-closed
 * and a REVERSE position may be open at the venue, and
 * `LoggingOcoDoubleFillAlertChannel` writes a line nobody is tailing at 3am.
 * `SAMURAI_ALERTS=telegram` builds this one over the shared
 * `TelegramBotApiClient` (alert-transport.ts) and posts to the ESCALATION
 * chat, never the heartbeat chat (#342): an accidental reverse position is a
 * decision waiting on the operator, not a beat.
 */
import type {
  OcoDoubleFillAlert,
  OcoDoubleFillAlertChannel,
} from '../../pipeline/execution/index.js';
import { TradeChannelAlert } from './trade-channel.js';

/**
 * Composed only from the alert's own curated fields — identifiers this
 * system chose and the instrument, never venue error text. See
 * `OcoDoubleFillAlert`'s CREDENTIALS note.
 */
function formatOcoDoubleFillAlert(alert: OcoDoubleFillAlert): string {
  return (
    `Samurai OCO DOUBLE FILL: ${alert.instrument} — BOTH emulated protective legs filled ` +
    `(stop ${alert.stop_order_id}, target ${alert.target_order_id}) as of ` +
    `${alert.observed_at.toISOString()}.\n` +
    `Lot ${alert.client_order_id}. The lot is over-closed and a REVERSE position may now be ` +
    'open at the venue. Nothing was unwound automatically — check the position and close it ' +
    'by hand.'
  );
}

export class TradeChannelOcoDoubleFillAlert
  extends TradeChannelAlert
  implements OcoDoubleFillAlertChannel
{
  async postOcoDoubleFillAlert(alert: OcoDoubleFillAlert): Promise<void> {
    const text = formatOcoDoubleFillAlert(alert);
    await this.send(text);
  }
}
