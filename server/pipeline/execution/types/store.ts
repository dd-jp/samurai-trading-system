/** The execution store port — split out because both Execution and Verdict depend on it. */
import type {
  AssetClass,
  BrokerFillId,
  ClosedTrade,
  ExitReason,
  Fill,
  LotHeldQuantity,
  OpenPosition,
  OrderState,
} from '../../../shared/index.js';
import type { ModelledCostBreakdown } from '../../../shared/store/index.js';

/** The open book: every lot still in flight and how much of each is already closed. */
export interface PositionReader {
  /** Excludes terminal lots — a fill against a closed lot is not ours to act on. */
  getOpenPositions(): Promise<OpenPosition[]>;
  /**
   * Each named lot's already-closed (exit-leg) quantity, summed — what makes held
   * quantity (`filled_size` minus this) derivable wherever an exit is sized.
   * A lot with no such fill is absent from the Map, not present at 0.
   */
  getExitFillSizes(idempotency_keys: readonly string[]): Promise<Map<string, number>>;
}

/**
 * The bracket path's write-ahead-then-resolve journal over `open_positions`.
 * `findByKey` is intentionally identical to Verdict's read-only dedup check,
 * so one concrete store satisfies both seams.
 */
export interface LotJournal {
  /**
   * True if an order or fill already exists under this key, OR a flatten
   * submission does — an exit writes no `OpenPosition`, so this is what makes
   * a replayed exit dedupe the same way a replayed entry does.
   */
  findByKey(idempotency_key: string): Promise<boolean>;
  /** Persist the intended lot at `pending` BEFORE the broker call, so a crash is recoverable via reconcile. */
  writeAheadPosition(position: OpenPosition): Promise<void>;
  /** Persist the post-ack transition (`pending` → `submitted`) */
  updatePositionState(
    idempotency_key: string,
    update: { order_state: OrderState; broker_order_ids: string[] },
  ): Promise<void>;
}

/** Reads over `fills`: the dedup check and per-lot fill history held-quantity is reconstructed from. */
export interface FillReader {
  /**
   * True if this `(idempotency_key, broker_fill_id)` pair was already ingested.
   * Matches the full `fills` primary key, not `broker_fill_id` alone: there is no
   * venue column, and the id is venue-assigned, so an id-only match could credit
   * one lot's fill to a different lot sharing that id string.
   */
  hasFill(args: { idempotency_key: string; broker_fill_id: BrokerFillId }): Promise<boolean>;
  /** Every `Fill` recorded against a lot, in ingestion order — realized size/price/PnL are rebuilt from these, not a running total. */
  getFills(idempotency_key: string): Promise<Fill[]>;
  /**
   * Each named lot's persisted ENTRY fill quantity, summed. A key with no
   * persisted entry fill is absent from the Map, not present at 0. Superseded
   * by `FlattenAttribution.lot_held_quantities` for flattens written after
   * migration 0021; remains the fallback for rows written before it.
   */
  getEntryFillSizes(idempotency_keys: readonly string[]): Promise<Map<string, number>>;
}

/** What `ingestFills()` persists through and nothing else does: the atomic lot advance and flatten-fill routing. */
export interface FillJournal {
  /**
   * Persist one poll's advance of a lot — new fills, recomputed state, and
   * on round-trip-to-flat the `ClosedTrade` — atomically, so a crash cannot
   * land between the fill rows and the lot state they imply.
   */
  applyLotAdvance(advance: LotAdvance): Promise<void>;
  /**
   * What a flatten submission journalled about the lot(s) it was closing, or
   * `null` if `key` names no flatten (or one written before the lot-identity
   * migration). A flatten's fill carries its OWN idempotency key, never a held
   * lot's, so this is how the fill gets routed back to the lot(s) it closed.
   */
  getFlattenAttribution(idempotency_key: string): Promise<FlattenAttribution | null>;
  /**
   * Marks a flatten's fill(s) durably applied to every lot it named this poll —
   * bounds `getUnresolvedFlattens()`. Must NOT be called merely because a raw
   * fill was observed, only once durably applied, or a failed advance becomes
   * permanently unrecoverable instead of retried by `reconcile()`.
   */
  markFlattenFillsSwept(idempotency_key: string, swept_at: Date): Promise<void>;
}

/** The flatten path's write-ahead-then-resolve journal over `flatten_submissions` — written by `executeExit`, settled by `reconcile()`. */
export interface FlattenJournal {
  /**
   * Write-ahead at `'submitting'` BEFORE `broker.submitFlatten`, the same
   * shape `writeAheadPosition` gives the bracket path — without it a crash
   * between the broker call and its ack leaves no durable trace of the attempt.
   *
   * **Also the one-flatten-per-instrument gate.** Must refuse — atomically
   * with the insert — a submission whose instrument already has an unresolved
   * flatten. Two independent submitters exist (`executeExit`'s flatten window,
   * `reflattenResidual`'s residual walk); a check either makes before calling
   * this leaves a window for the other to submit a second market order on the
   * same held quantity.
   */
  writeAheadFlatten(submission: FlattenSubmissionWriteAhead): Promise<void>;
  /** Persist the post-ack transition (`'submitting'` → `'submitted'`) */
  resolveFlattenSubmitted(
    idempotency_key: string,
    update: { order_state: OrderState; broker_order_ids: string[] },
    resolved_at: Date,
  ): Promise<void>;
  /**
   * Persist → `'error'` for a flatten the venue will never fill: never reached
   * the broker, reconcile observed it terminal with zero fill, or (not proof —
   * a single negative answer against an aged row) an acked row has sat
   * unresolved past `UNRESOLVABLE_FLATTEN_MAX_AGE_MS` and the venue denies it.
   * See `reconcileFlatten`'s own doc before reasoning about the third case.
   */
  resolveFlattenError(idempotency_key: string, reason: string, resolved_at: Date): Promise<void>;
  /**
   * True iff `idempotency_key` names a flatten resolved to `'error'` — the
   * venue will never fill it. `false` for `'submitting'`/`'submitted'`
   * (retrying while the original attempt's outcome is unknown or already
   * succeeded risks a double flatten) and for an unknown key.
   */
  isRetryableFlattenError(idempotency_key: string): Promise<boolean>;
  /**
   * `reconcile()`'s worklist: every flatten row a crash could have stranded —
   * `'submitting'` (ack lost) OR (`'submitted'` AND fills not yet swept).
   * `'error'` rows are excluded: nothing left for the venue to answer, and a
   * fill is still routed home by `getFlattenAttribution` regardless (keyed on
   * `idempotency_key` alone, no status filter), so excluding a row here never
   * orphans a later fill. Also feeds the one-flatten-per-instrument gate and
   * the Trader's `flattenAlreadyInFlight` refusal, and is scoped to the
   * calling instance's own arm (control vs live must never cross-read).
   */
  getUnresolvedFlattens(): Promise<UnresolvedFlattenSubmission[]>;
  /**
   * Records that `reconcileFlatten` sent this flatten a venue cancel — success
   * or failure alike, so a cancel that throws every pass still feeds
   * `FLATTEN_CANCEL_RETRY_EVERY_MS`'s throttle. Overwrites: the LAST attempt is
   * what the throttle measures against.
   */
  markFlattenCancelAttempted(idempotency_key: string, attempted_at: Date): Promise<void>;
  /**
   * Records that a pass saw this row terminal at the venue with fills still
   * unswept — starts the release window and throttles the venue read.
   * Overwrites: the LAST look is what both are measured from.
   */
  markFlattenTerminalUnsweptChecked(idempotency_key: string, checked_at: Date): Promise<void>;
  /**
   * Refreshes a flatten's known venue state on an already-`'submitted'` row,
   * without touching `resolved_at` (the ORIGINAL ack moment) or `status`.
   * Reusing `resolveFlattenSubmitted` here would silently overwrite
   * `resolved_at` with a later, false ack time.
   */
  recordFlattenOrderStateObserved(
    idempotency_key: string,
    update: { order_state: OrderState; broker_order_ids: string[] },
  ): Promise<void>;
}

/** The durable marker on a lot whose partial-flatten residual is not yet confirmed protected, and the sweep worklist it feeds. */
export interface ResidualMarkers {
  /**
   * Durably marks a lot's partial-flatten residual as observed but not yet
   * protected — written the moment the residual is first known, BEFORE the
   * re-arm attempt, so a crash before confirmation leaves a row the sweep finds.
   * Keeps the FIRST observation (COALESCE): a re-poll of the same unprotected
   * episode is the same episode, not a fresh one.
   */
  markResidualUnprotected(idempotency_key: string, observed_at: Date): Promise<void>;
  /**
   * The only way the marker clears: protection was CONFIRMED (broker re-arm
   * acked or adopted, or the lot read flat with nothing left to protect).
   * Idempotent — clearing an unmarked lot is a no-op, letting the sweep and
   * the observing poll race without either failing.
   */
  confirmResidualProtected(idempotency_key: string): Promise<void>;
  /**
   * Pre-attempt page dedup (store-read failure, non-finite/non-positive
   * residual, ordinary retryable re-arm failure) — deliberately separate from
   * `markResidualRearmUnsupportedAlerted`'s column, so a pre-attempt page
   * firing first can never consume the one page a real permanent gap needs.
   * CONDITIONAL: records only while unset, returns whether THIS call won —
   * first-writer-wins regardless of which alert surface got there first.
   */
  markResidualAlerted(idempotency_key: string, alerted_at: Date): Promise<boolean>;
  /**
   * The TRUTHFUL permanent-gap page's own once-per-episode dedup — a separate
   * column from `markResidualAlerted`'s. Only called by the two sites that
   * actually observed `ProtectiveRearmUnsupportedError`. Same
   * conditional/first-writer-wins contract.
   */
  markResidualRearmUnsupportedAlerted(idempotency_key: string, alerted_at: Date): Promise<boolean>;
  /**
   * Point-read of the permanent-gap dedup, consulted BEFORE paging: after a
   * re-flatten is submitted for a residual, a later partial fill can hit the
   * same venue refusal again for the SAME episode, and without this check that
   * pass would page a second time before the reflatten's fill closes the marker.
   */
  getResidualRearmUnsupportedAlertedAt(idempotency_key: string): Promise<Date | null>;
  /**
   * The sweep's worklist: every NON-TERMINAL lot still marked unprotected.
   * Bounded like `getOpenPositions()` — a terminal lot's residual is settled
   * by definition, so the sweep never grows with history.
   */
  getUnprotectedResidualLots(): Promise<UnprotectedResidualLot[]>;
}

/** Bookkeeping closes of lots that were never real positions — no venue action, ever. */
export interface LotRetirement {
  /**
   * Deletes `open_positions` rows that were never real positions and never
   * will be (`rejected`/`cancelled`/`expired`, `filled_size = 0`, older than
   * `cutoff`). Returns the count deleted.
   *
   * `closed` rows are deliberately never swept here, nor is a terminal row
   * with `filled_size > 0` — `getOpenPositions()`'s terminal filter already
   * keeps these out of every live read, so this closes a retention problem,
   * not a correctness one. A `closed` row alone carries the submit-time
   * snapshot (`decision_price`, quotes, `modelled_cost_breakdown`) that
   * `closed_trades` has no columns for, so CLAUDE.md's CGT retention
   * requirement makes deleting it someone else's call.
   */
  sweepTerminalPositions(cutoff: Date): Promise<number>;
  /**
   * Retires ONE lot from `filled`/`partially_filled` with `filled_size = 0` to
   * `'abandoned'`, recording why. A zero-fill lot has no venue position, so
   * this is a bookkeeping close, never a venue action.
   *
   * Guarded in the UPDATE itself (`order_state IN (...) AND filled_size = 0`),
   * not read-then-written, so a fill landing between the worklist read and this
   * write cannot be overwritten by a decision made off the stale read. Returns
   * whether the write actually landed, so a genuine abandonment can be told
   * apart from that race.
   */
  abandonWedgedZeroFillLot(idempotency_key: string, reason: string): Promise<boolean>;
}

/**
 * Execution's writer seam over the shared store, of which it is the sole
 * writer — every role above, which is what one concrete store implements and
 * the composition root shares.
 */
export type SharedStore = PositionReader &
  LotJournal &
  FillReader &
  FillJournal &
  FlattenJournal &
  ResidualMarkers &
  LotRetirement;

/** One lot the residual-protection sweep still has work to do on — see `SharedStore.getUnprotectedResidualLots`. */
export interface UnprotectedResidualLot {
  position: OpenPosition;
  /** When the unprotected residual was FIRST observed. */
  unprotected_since: Date;
  /** When this episode's operator alert was posted; null if it never was */
  alerted_at: Date | null;
  /**
   * When the TRUTHFUL permanent-gap page (a confirmed venue refusal) was
   * posted for this episode; null if it never was. Independent of `alerted_at`.
   */
  rearm_unsupported_alerted_at: Date | null;
}

/** One `flatten_submissions` row `reconcile()`'s sweep still has work to do on — see `SharedStore.getUnresolvedFlattens`. */
export interface UnresolvedFlattenSubmission {
  idempotency_key: string;
  instrument: string;
  /**
   * `'submitting'`: the write-ahead's ack was lost, resolved by `resumeFlatten`.
   * `'submitted'`: acked once; still needs a fresher answer or swept fills
   * before it drops out of the scan.
   */
  status: 'submitting' | 'submitted';
  /** The write-ahead time — how long this row has blocked its instrument, and the anchor the max-age bound measures against. */
  submitted_at: Date;
  /**
   * The venue's last known answer, or `null` if it has never once described
   * this flatten. Nothing ever clears it back to `null`: a `null` here means
   * no later pass can be relied on to turn the row terminal, so it takes the
   * never-confirmed cancel path; a WORKING value means the row must keep
   * blocking every later flatten regardless of age.
   */
  order_state: OrderState | null;
  /**
   * When a venue cancel was last attempted for this row, or `null` if never.
   * A throttle input ONLY — never evidence that the venue cancelled anything.
   */
  cancel_attempted_at: Date | null;
  /**
   * When a pass last saw this row terminal at the venue with fills still
   * unswept, or `null` if never. Starts the release window at the moment that
   * shape first appeared, not at submission. Never evidence about the venue.
   */
  terminal_unswept_checked_at: Date | null;
}

/**
 * The journalled record of which lots a flatten was closing, and how much
 * each HELD when it was submitted — see `getFlattenAttribution`.
 *
 * The two arrays are positionally parallel and the store refuses a row where
 * they are not, so a reader may index one by the other's position without re-checking.
 */
export interface FlattenAttribution {
  /** In the `opened_at` order `executeExit` read the lots in — the FIFO order the split allocates in */
  lot_idempotency_keys: readonly string[];
  /**
   * The flatten's own instrument. Carried here (rather than looked up) because
   * `persistUnattributedSplits` books a split against a lot that has already
   * left `getOpenPositions()`, and `sweepTerminalPositions` can delete the
   * terminal row a `findByKey` lookup would otherwise depend on.
   */
  instrument: string;
  /**
   * The CLOSING side, not the lot's opening side — `'sell'` closes a long,
   * `'buy'` closes a short, and the operator text for an unattributed split
   * says what the VENUE did. Reading the lot's own side would invert it on
   * every buy-to-close.
   */
  side: 'buy' | 'sell';
  /**
   * Each lot's held quantity AT WRITE-AHEAD TIME, summing to the flatten's own
   * `size` — the fixed per-lot share the fill split allocates against.
   * `null` for a flatten row written before this was journalled, whose fill
   * falls back to the pre-existing entry-total split.
   */
  lot_held_quantities: readonly LotHeldQuantity[] | null;
  /** WHY this flatten was submitted — the exit intent's `metadata.exit_reason`, journalled verbatim on write-ahead. `null` for rows written before that migration. */
  exit_reason: ExitReason | null;
  /**
   * The modelled cost breakdown captured at the flatten's own submit time —
   * prorated by each named lot's share since the venue reports no breakdown
   * of its own. `null` if written before that migration, or the capture failed.
   */
  modelled_cost_breakdown: ModelledCostBreakdown | null;
  /**
   * The quantity the flatten was SUBMITTED for. Load-bearing, not
   * informational: prorating the cost breakdown against this (rather than a
   * raw fill's own size) is what makes the shares sum to 1.0 across the whole
   * submission however many raw fills the venue splits it into.
   */
  size: number;
}

/** One poll's atomic advance of a single lot — see `SharedStore.applyLotAdvance`. */
export interface LotAdvance {
  idempotency_key: string;
  /** New fills this poll ingested (already deduped against `hasFill`). One row per fill. */
  fills: readonly Fill[];
  /** The lot state recomputed from ALL persisted + new fills; absent while no entry fill exists */
  position_update?: { filled_size: number; avg_entry_price: number; order_state: OrderState };
  /** The realized record, on round-trip-to-flat only */
  closed_trade?: ClosedTrade;
}

/** The write-ahead record for `SharedStore.writeAheadFlatten` — see there for why it exists. */
export interface FlattenSubmissionWriteAhead {
  idempotency_key: string;
  instrument: string;
  asset_class: AssetClass;
  /** The CLOSING side, carried straight through from the exit intent */
  side: 'buy' | 'sell';
  /** The held quantity being flattened */
  size: number;
  submitted_at: Date;
  /**
   * The lot(s) this flatten is closing and what each HELD as it was
   * submitted, in the `opened_at` order `getOpenPositions()` returned them,
   * summing to `size`. ONE field, not a separate key list and quantity list,
   * so a caller cannot hand over a quantity paired with the wrong lot.
   * Carried on the write-ahead itself, ahead of the broker call, since a new
   * lot could open on the same instrument before the fill lands and wrongly
   * receive this flatten's fill if reconstructed later.
   */
  lot_held_quantities: readonly LotHeldQuantity[];
  /** WHY this flatten is being submitted — the exit intent's own `metadata.exit_reason`, carried straight through. Every exit intent carries one; `executeExit` refuses to write ahead without it. */
  exit_reason: ExitReason;
  /**
   * The submit-time snapshot, mirroring `OpenPosition`'s own fields of the
   * same name. `null` (never omitted): the capture always returns a value,
   * sometimes null when the best-effort capture failed or was skipped.
   */
  decision_price: number | null;
  quote_bid: number | null;
  quote_ask: number | null;
  quote_mid: number | null;
  quote_observed_at: Date | null;
  modelled_cost_breakdown: ModelledCostBreakdown | null;
}
