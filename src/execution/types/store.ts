/**
 * The execution store port (#308) — the lot lifecycle's system of record.
 * Alone in its own file because it is the one interface both Execution and
 * Verdict depend on, and it changes for different reasons than either.
 */
import type {
  AssetClass,
  ClosedTrade,
  Fill,
  OpenPosition,
  OrderState,
} from '../../shared/index.js';

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
  /**
   * True if an order or fill already exists under this idempotency key —
   * OR a flatten submission does (#508 review, PR #516). An exit writes no
   * `OpenPosition` (see `writeAheadFlatten` below), so this alone is what
   * makes a replayed exit dedupe the same way a replayed entry does.
   */
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
   * Each named lot's persisted ENTRY fill quantity, summed — the batch read
   * `redistributeFlattenFills` (ingest-fills.ts, #517) uses in place of one
   * `getFills` round-trip per lot, since `ingestFills()` runs on every tick
   * and a flatten can name many lots (a multi-scale-in exit) at once. A key
   * with no persisted entry fill is simply absent from the returned `Map`,
   * not present at 0 — mirroring `DashboardQueryStore.getMarks`' own
   * "missing is absent" answer, the shape this follows.
   */
  getEntryFillSizes(idempotency_keys: readonly string[]): Promise<Map<string, number>>;
  /**
   * The mirror of `getEntryFillSizes` over the CLOSING legs (`leg != 'entry'`
   * — `ingest-fills.ts`'s `isExitFill` discriminator, in SQL): each named
   * lot's already-closed quantity, summed. Same batch shape and same
   * "a lot with no such fill is absent from the Map, not present at 0".
   *
   * #568: this is what makes held quantity — `filled_size` minus this —
   * derivable wherever an exit is sized, instead of `filled_size` (an
   * entry-only total that no exit fill ever reduces) standing in for it. See
   * `shared/held-quantity.ts`.
   *
   * Two neighbours in `ingest-fills.ts` deliberately do NOT read through this:
   * `redistributeFlattenFills`, whose split must stay pinned to the ENTRY
   * total for the stability reasons documented there; and
   * `maybeRearmResidual`, which arrives at the same residual from the fill
   * rows it is already holding for the lot it is advancing, so a batch read
   * keyed by lot would buy it nothing.
   */
  getExitFillSizes(idempotency_keys: readonly string[]): Promise<Map<string, number>>;
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
  /**
   * Write-ahead for a flatten (#508 review, PR #516) — persisted at
   * `'submitting'` BEFORE `broker.submitFlatten` is called, the same
   * write-ahead-then-resolve shape `writeAheadPosition` gives the bracket
   * path (and #312 gave the ccxt bracket journal). An exit has no bracket
   * and no `OpenPosition` to write ahead, so without this row a crash or a
   * lost response between the broker call and its ack left NO durable trace
   * of the attempt anywhere — not dedupable, not reconcilable. This is that
   * trace. Deliberately thin: no stop/target/entry price, because a flatten
   * is a plain market order and has none of those to journal.
   */
  writeAheadFlatten(submission: FlattenSubmissionWriteAhead): Promise<void>;
  /** Persist the post-ack transition (`'submitting'` → `'submitted'`). */
  resolveFlattenSubmitted(
    idempotency_key: string,
    update: { order_state: OrderState; broker_order_ids: string[] },
    resolved_at: Date,
  ): Promise<void>;
  /**
   * Persist `'submitting'` → `'error'` for a flatten that PROVABLY never
   * reached the broker (e.g. the pre-flatten bracket cancel failed) — as
   * opposed to a `submitFlatten` call that itself threw, which is genuine
   * ambiguity (the venue may have seen it) and is left at `'submitting'`
   * for reconcile to resolve later, exactly as the bracket path leaves a
   * `pending` record on a `submitBracket` failure.
   */
  resolveFlattenError(idempotency_key: string, reason: string, resolved_at: Date): Promise<void>;
  /**
   * The lot(s) a flatten submission was journalled to close (#517), in the
   * `opened_at` order `executeExit` wrote them — or `null` if `key` names no
   * flatten submission, or names one written before migration 0020 added
   * this column. `ingestFills()` is this method's only reader: a flatten's
   * fill carries the flatten's OWN idempotency key, never a held lot's, so
   * this is how a fill bucketed under that key gets routed back to the lot(s)
   * it actually closed instead of being silently dropped.
   */
  getFlattenLotKeys(idempotency_key: string): Promise<readonly string[] | null>;
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

/** The write-ahead record for `SharedStore.writeAheadFlatten` — see there for why it exists. */
export interface FlattenSubmissionWriteAhead {
  idempotency_key: string;
  instrument: string;
  asset_class: AssetClass;
  /** The CLOSING side, carried straight through from the exit intent. */
  side: 'buy' | 'sell';
  /** The held quantity being flattened. */
  size: number;
  submitted_at: Date;
  /**
   * The lot(s) this flatten is closing (#517) — `executeExit`'s `heldLots`,
   * by `idempotency_key`, in the `opened_at` order `getOpenPositions()`
   * already returned them in. Carried on the write-ahead itself, ahead of
   * the broker call, rather than reconstructed later from whatever is still
   * open when the fill lands: see migration 0020's comment for why that
   * later reconstruction is unsafe (a new lot on the same instrument could
   * open in between and wrongly receive this flatten's fill).
   */
  lot_idempotency_keys: readonly string[];
}
