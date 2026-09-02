/**
 * The execution store port (#308) — the lot lifecycle's system of record.
 * Alone in its own file because it is the one interface both Execution and
 * Verdict depend on, and it changes for different reasons than either.
 */
import type {
  AssetClass,
  ClosedTrade,
  ExitReason,
  Fill,
  LotHeldQuantity,
  OpenPosition,
  OrderState,
} from '../../../shared/index.js';

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
   *
   * #571: no longer how a flatten's fill is split. That split now reads the
   * held quantities journalled on the flatten row itself
   * (`FlattenAttribution.lot_held_quantities`); this remains the fallback for
   * a flatten row written before migration 0021, which has none — see
   * `redistributeFlattenFills` for why an entry total was the wrong number
   * despite being a stable one.
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
   * `redistributeFlattenFills`, whose split reads the held quantities the
   * flatten JOURNALLED at write-ahead (#571) rather than re-deriving them
   * here — a live re-derivation would shrink as this very flatten's own fills
   * persisted, and an unstable split is what `broker_fill_id` dedup cannot
   * survive; and `maybeRearmResidual`, which arrives at the same residual
   * from the fill rows it is already holding for the lot it is advancing, so
   * a batch read keyed by lot would buy it nothing.
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
   * True iff `idempotency_key` names a `flatten_submissions` row resolved to
   * `'error'` — i.e. `resolveFlattenError`'s own invariant: the flatten
   * PROVABLY never reached the broker. A `'submitting'` or `'submitted'` row
   * returns `false` — retrying under a fresh key while the broker's answer
   * to the ORIGINAL attempt is still unknown (`'submitting'`) or the
   * original attempt already succeeded (`'submitted'`) risks a double
   * flatten, the #516 reverse-position hazard. `false` also for a key that
   * names no flatten row at all.
   */
  isRetryableFlattenError(idempotency_key: string): Promise<boolean>;
  /**
   * What a flatten submission journalled about the lot(s) it was closing
   * (#517, widened by #571) — or `null` if `key` names no flatten submission,
   * or names one written before migration 0020 added the lot identity.
   * `ingestFills()` is this method's only reader: a flatten's fill carries
   * the flatten's OWN idempotency key, never a held lot's, so this is how a
   * fill bucketed under that key gets routed back to the lot(s) it actually
   * closed instead of being silently dropped.
   */
  getFlattenAttribution(idempotency_key: string): Promise<FlattenAttribution | null>;
  /**
   * `reconcile()`'s worklist (#519, #526) — every flatten row a crash could
   * have stranded, bounded so the sweep does not re-poll the venue for a
   * flatten that finished closing its lot(s) days ago (0022's own doc for
   * the full reasoning): `status = 'submitting'` (the write-ahead's ack was
   * lost) OR (`status = 'submitted'` AND `fills_swept_at IS NULL` — acked,
   * but not yet confirmed durably applied to every lot it named).
   *
   * `'error'` rows are excluded outright: that status means the flatten
   * PROVABLY never reached the broker (`resolveFlattenError`'s own doc), so
   * there is nothing left for the venue to answer about it.
   */
  getUnresolvedFlattens(): Promise<UnresolvedFlattenSubmission[]>;
  /**
   * Refreshes a flatten's known venue state on an ALREADY-`'submitted'` row,
   * without touching `resolved_at` (migration 0019: the moment the ORIGINAL
   * write-ahead was settled — `resolveFlattenSubmitted`'s job, for a row
   * still at `'submitting'`) or `status` (already `'submitted'`; this is not
   * a new ambiguity being resolved, only a fresher answer to one already
   * settled once). Reusing `resolveFlattenSubmitted` here would silently
   * overwrite `resolved_at` with whatever time `reconcile()` happened to run
   * at, which is a different, false claim about when the flatten was acked.
   */
  recordFlattenOrderStateObserved(
    idempotency_key: string,
    update: { order_state: OrderState; broker_order_ids: string[] },
  ): Promise<void>;
  /**
   * Marks a flatten's fill(s) as durably applied to every lot it named THIS
   * poll — `ingest-fills.ts`'s call site, right after every one of a
   * flatten's named lots has either advanced cleanly or had nothing new to
   * advance. This is what bounds `getUnresolvedFlattens()` above; see
   * migration 0023 for why the bound cannot be `order_state` alone, and why
   * this may NOT be called merely because a raw fill was observed — only
   * once it is durably applied, or a lot-advance failure this poll would
   * become permanently unrecoverable instead of retried on the next
   * `reconcile()` pass.
   */
  markFlattenFillsSwept(idempotency_key: string, swept_at: Date): Promise<void>;
  /**
   * #549: durably marks a lot's partial-flatten residual as observed but not
   * yet confirmed protected — written by `maybeRearmResidual`
   * (ingest-fills.ts) the moment the residual is first known, BEFORE the
   * re-arm attempt, so a crash anywhere between the exit fill persisting and
   * the re-arm confirming leaves a row `getUnprotectedResidualLots()` finds.
   *
   * Keeps the FIRST observation: a lot already marked stays marked at its
   * original `residual_unprotected_since` (COALESCE), and its alert-dedup
   * state (`residual_rearm_alerted_at`) is untouched — a re-poll of the same
   * unprotected episode is the same episode, not a fresh one. See migration
   * 0024.
   */
  markResidualUnprotected(idempotency_key: string, observed_at: Date): Promise<void>;
  /**
   * The only way the #549 marker clears: protection was CONFIRMED — the
   * broker's re-arm call resolved (venue-acked, or adopted as already live
   * on the venue), or a fuller read showed the lot flat with nothing left to
   * protect. Clears the alert-dedup timestamp with it, so a LATER residual
   * episode on the same lot alerts afresh. Idempotent: clearing an unmarked
   * (or unknown) lot is a no-op, which is what lets the sweep and the
   * observing poll race without either failing.
   */
  confirmResidualProtected(idempotency_key: string): Promise<void>;
  /**
   * Once-per-episode alert dedup for the #549 sweep (#342's repeated-line
   * lesson): recorded when `ResidualExposureAlertChannel` accepted a
   * delivery for an unprotected episode, checked by the sweep so a marker
   * that stays unprotected across many passes pages the operator once, not
   * once per pass. Cleared together with the marker by
   * `confirmResidualProtected`.
   *
   * CONDITIONAL (#549 review): records only when the episode has no
   * alerted-at yet (`... AND residual_rearm_alerted_at IS NULL`) and
   * returns whether THIS call won that write — first-writer-wins durably,
   * so the dedup holds regardless of which alert surface (the observing
   * poll's inline path, the sweep) got there first or in what order.
   * `false` means another surface already recorded the episode's page (or
   * the key names no lot) — never an error.
   */
  markResidualAlerted(idempotency_key: string, alerted_at: Date): Promise<boolean>;
  /**
   * The #549 sweep's worklist: every NON-TERMINAL lot still marked
   * unprotected. Bounded the same way `getOpenPositions()` is — a terminal
   * lot's residual is settled by definition (`closed` means round-tripped to
   * flat; `rejected`/`cancelled`/`expired` mean no venue exposure under this
   * lot) — so the sweep never grows with history. Each row carries the full
   * `OpenPosition` (everything a retry needs: instrument, side, stop,
   * target, requested_size) plus the marker's own two timestamps.
   */
  getUnprotectedResidualLots(): Promise<UnprotectedResidualLot[]>;
}

/**
 * One lot the #549 residual-protection sweep still has work to do on — see
 * `SharedStore.getUnprotectedResidualLots`.
 */
export interface UnprotectedResidualLot {
  position: OpenPosition;
  /** When the unprotected residual was FIRST observed (migration 0024). */
  unprotected_since: Date;
  /** When this episode's operator alert was posted; null if it never was. */
  alerted_at: Date | null;
}

/**
 * One `flatten_submissions` row `reconcile()`'s sweep still has work to do
 * on — see `SharedStore.getUnresolvedFlattens`.
 */
export interface UnresolvedFlattenSubmission {
  idempotency_key: string;
  instrument: string;
  /**
   * `'submitting'`: the write-ahead's ack was lost — `broker.resumeFlatten`
   * settles whether the venue ever saw it, the same ambiguity `reconcile()`
   * already settles for a bracket's `pending` write-ahead.
   * `'submitted'`: the venue acked it once; this row still needs a fresher
   * answer, or its fills durably applied, before it can be dropped from the
   * scan (see `SharedStore.markFlattenFillsSwept`).
   */
  status: 'submitting' | 'submitted';
}

/**
 * The journalled record of which lots a flatten was closing, and how much
 * each of them HELD when it was submitted — see `getFlattenAttribution`.
 *
 * The two arrays are positionally parallel and the store refuses a row where
 * they are not, so a reader may index one by the other's position without
 * re-checking.
 */
export interface FlattenAttribution {
  /** In the `opened_at` order `executeExit` read the lots in — the FIFO order the split allocates in. */
  lot_idempotency_keys: readonly string[];
  /**
   * Each lot's held quantity (`filled_size` minus its already-recorded exit
   * fills) AT WRITE-AHEAD TIME, summing to the flatten's own `size` — the
   * fixed per-lot share `redistributeFlattenFills` allocates against (#571).
   *
   * Returned already PAIRED with its lot's key, in the same order as
   * `lot_idempotency_keys`, even though the column stores a bare positional
   * array: the store validates the two agree in length and is therefore the
   * only place that has to reason about the pairing at all. A reader handed
   * two parallel arrays would have to index one by the other's position and
   * decide, on the money path, what a missing entry means.
   *
   * `null` for a flatten row written before migration 0021, which recorded no
   * such quantities; its fill falls back to the pre-#571 entry-total split.
   */
  lot_held_quantities: readonly LotHeldQuantity[] | null;
  /**
   * #793: WHY this flatten was submitted — the same `ExitReason` the exit
   * intent's `metadata.exit_reason` carried at decide time, journalled
   * verbatim on write-ahead (migration 0031). `null` for a flatten row
   * written before that migration, which recorded no such reason.
   */
  exit_reason: ExitReason | null;
  /**
   * #1001: the modelled cost breakdown captured at the flatten's own
   * submit time (`FlattenSubmissionWriteAhead.modelled_cost_breakdown`) —
   * what `redistributeOneFlatten` (ingest-fills.ts) prorates by each named
   * lot's share and attaches to that lot's split exit fill, since the venue
   * reports no breakdown of its own. `null` for a flatten row written before
   * migration 0037, or whose submit-time capture failed.
   */
  modelled_cost_breakdown: {
    spread_cost: number;
    commission: number;
    slippage: number;
    market_impact: number;
  } | null;
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
   * The lot(s) this flatten is closing and what each of them HELD as it was
   * submitted — `heldQuantitiesFor`'s own result, passed through whole, in
   * the `opened_at` order `getOpenPositions()` returned the lots in and
   * summing to `size`.
   *
   * ONE field, not a key list beside a quantity list: the store splits it
   * across the two columns migrations 0020 and 0021 added, so a caller cannot
   * hand over a quantity paired with the wrong lot.
   *
   * Carried on the write-ahead itself, ahead of the broker call, rather than
   * reconstructed when the fill lands. The IDENTITY must be (migration 0020:
   * a new lot could open on the same instrument in between and wrongly
   * receive this flatten's fill); so must the QUANTITY (migration 0021: the
   * split must be identical on every poll or `broker_fill_id` dedup strands
   * the difference, and held quantity re-derived later shrinks as this very
   * flatten's own fills persist).
   */
  lot_held_quantities: readonly LotHeldQuantity[];
  /**
   * #793: WHY this flatten is being submitted — the exit intent's own
   * `metadata.exit_reason`, carried straight through so `getFlattenAttribution`
   * can hand it back to `redistributeOneFlatten` (migration 0031). Every exit
   * intent carries one (`buildFlattenExit` requires the argument — see
   * `ExitReason`'s doc); `executeExit` refuses to write ahead without it
   * rather than defaulting silently.
   */
  exit_reason: ExitReason;
  /**
   * #1001's submit-time snapshot, mirroring `OpenPosition`'s own fields of
   * the same name (records.ts) — see there for what each one is. `null`
   * rather than omitted (unlike the read-side `OpenPosition`/`Fill` optional
   * fields): `captureSubmitSnapshot` (execute.ts) always returns a value for
   * every one of these, sometimes null when the best-effort capture failed
   * or was skipped (`order.metadata.unpriced_exit`), so the write-ahead call
   * site never has a "not yet known" case to omit.
   */
  decision_price: number | null;
  quote_bid: number | null;
  quote_ask: number | null;
  quote_mid: number | null;
  quote_observed_at: Date | null;
  modelled_cost_breakdown: {
    spread_cost: number;
    commission: number;
    slippage: number;
    market_impact: number;
  } | null;
}
