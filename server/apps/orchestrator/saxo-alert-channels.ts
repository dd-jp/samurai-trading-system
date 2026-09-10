/**
 * Trade-channel adapters for the Saxo adapter's three escalations (#1400),
 * the same move `TradeChannelUnpricedFillAlert` makes for #298: reuse
 * Verdict's already-provisioned Telegram transport rather than introduce a
 * second integration.
 *
 * All three landed at #1215/#1216/#1302 as REQUIRED constructor arguments
 * with no default — the adapter refuses to be built without them precisely
 * so that they cannot end up log-only by omission — and then had no transport
 * at all, because nothing constructed the adapter. Wiring the venue (#1400)
 * is what makes them reachable from a phone, which is the whole point of
 * `ALERT_CHANNEL_FIELDS`' exhaustiveness guard (alert-transport.ts).
 *
 * Three classes in one file rather than three files: they share a formatter
 * shape and a destination, and they arrive together as one venue's escalation
 * set.
 */
import type {
  DormantLegsUnresolvedAlert,
  DormantLegsUnresolvedAlertChannel,
  LegResizeUnverifiedAlert,
  LegResizeUnverifiedAlertChannel,
  UnresolvedPriceUnitAlert,
  UnresolvedPriceUnitAlertChannel,
} from '../../pipeline/execution/index.js';
import { TradeChannelAlert } from './trade-channel.js';

export class TradeChannelLegResizeUnverifiedAlert
  extends TradeChannelAlert
  implements LegResizeUnverifiedAlertChannel
{
  async postLegResizeUnverifiedAlert(alert: LegResizeUnverifiedAlert): Promise<void> {
    await this.send(
      `Samurai UNVERIFIED STOP SIZE: ${alert.instrument} filled ${alert.filled_qty} of ` +
        `${alert.requested_qty ?? 'an unjournalled'} on the entry leg, and this venue cannot ` +
        'confirm the protective legs were resized.\n' +
        `Lot ${alert.client_order_id}, observed ${alert.observed_at.toISOString()}.\n` +
        'If the stop is still sized to the original amount it will over-close into a reversed ' +
        'position when it fires. Check the legs on the venue and resize them by hand.',
    );
  }
}

export class TradeChannelDormantLegsUnresolvedAlert
  extends TradeChannelAlert
  implements DormantLegsUnresolvedAlertChannel
{
  async postDormantLegsUnresolvedAlert(alert: DormantLegsUnresolvedAlert): Promise<void> {
    await this.send(
      `Samurai WEDGED LEGS: ${alert.instrument} has a dormant protective-leg pair the venue ` +
        `audit trail will not give a verdict on (${Math.round(alert.stuck_ms / 60_000)}m).\n` +
        `Lot ${alert.client_order_id}, observed ${alert.observed_at.toISOString()}.\n` +
        'The legs are deliberately NOT cancelled without evidence they are done, so this will ' +
        'not clear itself. Resolve the order on the venue by hand.',
    );
  }
}

export class TradeChannelUnresolvedPriceUnitAlert
  extends TradeChannelAlert
  implements UnresolvedPriceUnitAlertChannel
{
  async postUnresolvedPriceUnitAlert(alert: UnresolvedPriceUnitAlert): Promise<void> {
    await this.send(
      `Samurai UNPRICEABLE FILL: a priced fill arrived for Uic ${alert.uic}, which resolves to ` +
        'no pool line, so its quote unit is unknown and the cash it represents cannot be ' +
        'derived.\n' +
        `Lot ${alert.client_order_id}, venue fill ${alert.broker_fill_id}, observed ` +
        `${alert.observed_at.toISOString()}.\n` +
        'The fill is refused rather than booked — on a pence-quoted line an unscaled price is ' +
        '100x wrong — and every subsequent poll refuses it again, so no lot goes terminal ' +
        'until the pool and the venue agree on this instrument.',
    );
  }
}
