/**
 * The provider tiles as they appear on the wire.
 *
 * Split out of `server/apps/service-api/provider-status.ts`, which keeps the half that
 * is genuinely server-side: `ProviderStatusReader` (the synchronous seam
 * `buildSnapshot` reads) and the poller that does the live HTTP probing. Only
 * the rendered shapes belong here — a browser needs to know what a tile looks
 * like, never how it gets filled in.
 *
 * Note what is NOT here: `ProviderStatusPoller` and its `AlpacaBrokerClient`
 * dependency. That import chain reaches `server/pipeline/execution/`, and pulling it
 * across the boundary would put broker adapter types in the browser's
 * TypeScript program.
 */

/**
 * Deliberately an enum of causes rather than a boolean, because the operator
 * response differs per cause: `unauthorized` is a wrong key, `forbidden` is a
 * plan that does not include the endpoint, `rate_limited` is a plan that does
 * but is being hit too hard. Collapsing those to "down" would throw away the
 * only part of the answer that tells you what to go fix.
 */
export type ProviderState =
  | 'ok'
  | 'unauthorized'
  | 'forbidden'
  | 'rate_limited'
  | 'error'
  | 'not_configured';

/** Alpaca's account ledger, parsed for display. */
export interface AlpacaBalanceWire {
  cash: number;
  equity: number;
  /** `null` when Alpaca did not send it — see `AlpacaAccount.buying_power`. */
  buying_power: number | null;
}

export interface ProviderTile {
  /**
   * Only the two providers this poller probes. Nous is deliberately NOT a
   * member: it has no probe and no tile here, because there is nothing to
   * probe — its dashboard figure comes from the `llm_spend` table instead.
   * Listing it would advertise a tile this module never produces.
   */
  provider: 'alpaca' | 'polygon';
  state: ProviderState;
  /** Short human-readable cause. Never contains a credential. */
  detail: string;
  /** ISO-8601 UTC of the last completed probe, or `null` if none has run yet. */
  observed_at: string | null;
}

export interface AlpacaTile extends ProviderTile {
  provider: 'alpaca';
  /** `null` unless `state === 'ok'` — a stale balance shown next to a failed probe reads as current. */
  balance: AlpacaBalanceWire | null;
}

export interface PolygonTile extends ProviderTile {
  provider: 'polygon';
}

export interface ProviderStatusPanel {
  alpaca: AlpacaTile;
  polygon: PolygonTile;
}
