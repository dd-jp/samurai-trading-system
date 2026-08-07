/**
 * The operator-visibility port for an emulated OCO whose protective legs BOTH
 * filled (#586) — the risk the owner accepted when choosing local emulation
 * over Alpaca's (crypto-rejected) native order classes, surfaced honestly
 * when it materialises instead of hidden.
 *
 * ## Why this exists
 *
 * Alpaca rejects every advanced order class for crypto (verified live, #550:
 * `422` code `42210000`), so the crypto stop and take-profit rest at the
 * venue as two INDEPENDENT plain orders and the one-cancels-other promise is
 * kept by the fill sweep: observe one leg fill, cancel the sibling. Between
 * two sweeps (`DEFAULT_FILL_POLL_INTERVAL_MS`, ~15s) nothing enforces the
 * exclusion — a fast market can trade through both prices and fill BOTH
 * legs, which does not merely over-close the lot: the second leg opens a
 * REVERSE position the system never decided to hold.
 *
 * When the sweep observes that state it books both fills truthfully (hiding
 * one would corrupt the accounting on top of the exposure) and posts here.
 * There is no automated unwind: what to do with an accidental reverse
 * position is an operator decision, and the accepted-risk trade was "alert,
 * don't hide", not "handle".
 *
 * Same shape as `ResidualExposureAlertChannel` / `FlattenOverfillAlertChannel`:
 * declared beside its caller (adapters/alpaca-crypto-emulation.ts),
 * implemented by `LoggingOcoDoubleFillAlertChannel`
 * (orchestrator/console-channels.ts), Telegram transport wired through
 * `SAMURAI_ALERTS` (orchestrator/alert-transport.ts) as the ninth
 * `ALERT_CHANNEL_FIELDS` member.
 *
 * CREDENTIALS: composed only of identifiers and the instrument this system
 * chose itself — never venue error text or response bodies, the same boundary
 * every alert port in this repo draws.
 */

/** Both protective legs of one emulated OCO reported filled. */
export interface OcoDoubleFillAlert {
  /** The lot's own `idempotency_key` (the bracket's `client_order_id`). */
  client_order_id: string;
  /** Repo-form instrument (`BTC-USD`), never the venue's slash form. */
  instrument: string;
  /** The venue order id of the filled stop leg. */
  stop_order_id: string;
  /** The venue order id of the filled take-profit leg. */
  target_order_id: string;
  observed_at: Date;
}

export interface OcoDoubleFillAlertChannel {
  postOcoDoubleFillAlert(alert: OcoDoubleFillAlert): Promise<void>;
}
