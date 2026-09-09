/**
 * An owned Saxo activity row that IS a priced fill whose `Uic` resolves to no
 * pool line, so the line's `PriceToContractFactor` is unknown and the fill
 * cannot be expressed as cash (#1302). The fill is refused rather than booked
 * — on a GBX line an unscaled venue price is 100x wrong — and refusing it
 * throws out of `fetchNewFills`, so no fill for any lot lands that poll.
 *
 * Thrown AND posted, unlike `LegResizeUnverifiedAlertChannel` and
 * `DormantLegsUnresolvedAlertChannel`, which post instead of throwing. The
 * throw is what keeps a mis-scaled price out of the journal; the alert is
 * what makes the wedge visible, because the throw alone is not self-limiting:
 * `ingestFills` floors its `since` at the earliest open lot's `opened_at`
 * rather than advancing a watermark, so a TRANSIENT cause clears on the next
 * poll but a PERSISTENT one (the pool changed under a live lot, a Uic the
 * resolver never knew) re-drives the same row forever — every poll throws, no
 * lot goes terminal, and `since` never advances. Nothing else changes when
 * that happens, which is exactly the shape this repo's alert channels exist
 * for.
 *
 * REQUIRED with no default at the constructor, the same "tested mechanism
 * nothing calls" gap its two siblings refuse.
 *
 * CREDENTIALS: composed only of fields this module chose — no venue error
 * text or response body reaches it.
 */
export interface UnresolvedPriceUnitAlert {
  /** The lot's own `idempotency_key` (the bracket's `client_order_id`). */
  client_order_id: string;
  /** The activity row's `LogId` — the venue-side handle for the refused fill. */
  broker_fill_id: string;
  /** The Uic no pool line resolves; the operator's starting point. */
  uic: number;
  observed_at: Date;
}

export interface UnresolvedPriceUnitAlertChannel {
  postUnresolvedPriceUnitAlert(alert: UnresolvedPriceUnitAlert): Promise<void>;
}
