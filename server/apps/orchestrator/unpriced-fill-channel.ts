/**
 * Trade-channel adapter for the unpriced-fill age-out alert (#298) — the same
 * move `TradeChannelHeartbeat` makes for the heartbeat (heartbeat-channel.ts):
 * reuse Verdict's already-provisioned Telegram transport rather than
 * introduce a second integration, and wrap the raw clients rather than route
 * through `TradeChannelNotifier.notify`, which is shaped for a
 * `VerdictDecision` and not for an operational anomaly.
 *
 * This is the implementation that makes #298's acceptance criterion reachable
 * during an UNATTENDED soak (#238): `LoggingUnpricedFillAlertChannel` writes a
 * line nobody is tailing at 3am, whereas this one reaches a phone. Since #322
 * it is wired for real — `SAMURAI_ALERTS=telegram` builds it over a
 * `TelegramBotApiClient` at the entrypoint (alert-transport.ts).
 */
import type {
  UnpricedFillAlert,
  UnpricedFillAlertChannel,
} from '../../pipeline/execution/index.js';
import { TradeChannelAlert } from './trade-channel.js';

/**
 * Composed only from the alert's own curated fields — no broker error, no
 * response body. See `UnpricedFillAlert`'s doc for why that boundary is hard.
 */
function formatUnpricedFillAlert(alert: UnpricedFillAlert): string {
  const minutes = Math.round(alert.unpriced_for_ms / 60_000);
  return (
    `Samurai STUCK LOT: ${alert.venue} reports ${alert.qty} ${alert.instrument} ` +
    `filled on the ${alert.leg} leg but will not price it (${minutes}m unpriced, ` +
    `threshold ${Math.round(alert.age_out_ms / 60_000)}m).\n` +
    `Order ${alert.broker_fill_id}, lot ${alert.client_order_id}, ` +
    `first seen ${alert.first_seen_at.toISOString()}.\n` +
    'The fill cannot be booked, so the lot stays under-filled, its stop is sized ' +
    'to the wrong quantity and no closed trade will be emitted. Check the order ' +
    'on the venue and reconcile it by hand.'
  );
}

export class TradeChannelUnpricedFillAlert
  extends TradeChannelAlert
  implements UnpricedFillAlertChannel
{
  async postUnpricedFillAlert(alert: UnpricedFillAlert): Promise<void> {
    const text = formatUnpricedFillAlert(alert);
    await this.send(text);
  }
}
