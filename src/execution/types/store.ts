/**
 * The execution store port (#308) — the lot lifecycle's system of record.
 * Alone in its own file because it is the one interface both Execution and
 * Verdict depend on, and it changes for different reasons than either.
 */
import type { ClosedTrade, Fill, OpenPosition, OrderState } from '../../shared/index.js';

/**
 * Execution's writer seam over the shared store, of which it is the sole
 * writer (cross-spec §4).
 *
 * `findByKey` is intentionally identical to the read-only `PositionStore`
 * that Verdict (#79) declared for its dedup gate, so one concrete store
 * satisfies both seams. Verdict's file is left alone: it consumes this store
 * read-only and has no reason to depend on the writer surface.
 */
export interface SharedStore {
  /** True if an order or fill already exists under this idempotency key. */
  findByKey(idempotency_key: string): Promise<boolean>;
  /**
   * Write-ahead: persist the intended lot at `pending` BEFORE the broker
   * call, so a crash between decision and broker-ack is recoverable (#86
   * reconciles those orphans against the broker).
   */
  writeAheadPosition(position: OpenPosition): Promise<void>;
  /** Persist the post-ack transition (`pending` → `submitted`). */
  updatePositionState(
    idempotency_key: string,
    update: { order_state: OrderState; broker_order_ids: string[] },
  ): Promise<void>;
  /**
   * Lots whose lifecycle is still running — what `ingestFills()` advances.
   * Terminal records (`closed`/`cancelled`/`rejected`/`expired`) are excluded:
   * a fill against a closed lot is not ours to act on, and this is what makes
   * a re-poll after close a no-op.
   */
  getOpenPositions(): Promise<OpenPosition[]>;
  /**
   * True if this `broker_fill_id` was already ingested. The fill feed is
   * inclusive of `since`, so every poll re-offers the fills it already
   * delivered; without this the same fill is counted twice and the lot's
   * `filled_size` runs away from the broker's.
   */
  hasFill(broker_fill_id: string): Promise<boolean>;
  /**
   * Every `Fill` recorded against a lot, in ingestion order. Realized size,
   * avg price and PnL are reconstructed from these rather than a running
   * total, so a re-poll converges instead of drifting.
   */
  getFills(idempotency_key: string): Promise<Fill[]>;
  /**
   * Persist one poll's advance of a lot — new fills, the recomputed lot
   * state, and on round-trip-to-flat the `ClosedTrade` — atomically. A crash
   * can no longer land between the fill rows and the lot state they imply:
   * that gap was unrepairable, because the next poll's `hasFill` dedup
   * skipped the already-written fills and never recomputed the lot
   * (`filled_size`/`avg_entry_price` stale forever, the `ClosedTrade` never
   * written). All-or-nothing, the re-poll repairs by re-offering.
   *
   * `fills` may stand alone (an exit fill arriving before any entry gives
   * the lot no state to recompute yet); `closed_trade` is written once —
   * a second close for the same lot fails the whole advance.
   */
  applyLotAdvance(advance: LotAdvance): Promise<void>;
}

/** One poll's atomic advance of a single lot — see `SharedStore.applyLotAdvance`. */
export interface LotAdvance {
  idempotency_key: string;
  /** New fills this poll ingested (already deduped against `hasFill`). One row per fill — CONTEXT.md invariant #4. */
  fills: readonly Fill[];
  /** The lot state recomputed from ALL persisted + new fills; absent while no entry fill exists. */
  position_update?: { filled_size: number; avg_entry_price: number; order_state: OrderState };
  /** The realized record, on round-trip-to-flat only. */
  closed_trade?: ClosedTrade;
}
