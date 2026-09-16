/**
 * Polls the broker's fill feed for every open lot: persists new fills, resizes
 * protective legs to filled quantity, and emits `ClosedTrade` on flat.
 * Idempotent (dedups on `broker_fill_id`); a flatten's fill lands under its
 * OWN idempotency key, so `redistributeFlattenFills` routes it back to the
 * lot(s) it closed before anything else here runs.
 */

import type { Fill, OpenPosition, OrderState } from '../../shared/index.js';
import {
  BOOK_CURRENCY,
  coversQty,
  isBookCurrency,
  isExitFill,
  isFlat,
  logCaughtFailure,
  safeLog,
  totalQty,
  weightedAvgPrice,
} from '../../shared/index.js';
import { isWedgedZeroFillLot } from '../../shared/store/index.js';
import { closedTrade } from './closed-trade.js';
import { cumulativeIncrement } from './cumulative-feed.js';
import {
  chargeTopUpTo,
  type ModelledLegCost,
  type ModelledLotCosts,
  modelledLotCostsFor,
  prorateCostBreakdown,
} from './fill-cost.js';
import { splitFlattenFills } from './flatten-attribution.js';
import { markResidualsUnprotected, maybeRearmResidual } from './residual-protection.js';
import type {
  FillIngestInput,
  FlattenAttribution,
  NonSterlingFeeAlert,
  NormalizedFill,
} from './types.js';

/** #1087: a lot adopted as filled/partially_filled with `filled_size` still zero — `advanceLot` has nothing to advance and would otherwise warn in silence */
export const FILLED_WITH_ZERO_SIZE = 'filled position has zero filled_size' as const;

/** #1383: distinct message from the warn side, so a filter on it doesn't mistake this all-clear for another occurrence */
export const FILLED_ZERO_SIZE_CLEARED =
  'a lot previously warned zero-filled-size has advanced past zero' as const;

/**
 * A fill fee in a non-book currency. Alerted rather than refused: the venue
 * already traded, so refusing to persist would strand an open position
 * outside the fill log — worse than a booked fee whose currency is recorded.
 */
export const FEE_CURRENCY_NOT_BOOK_CURRENCY =
  'broker reported a fill fee in a currency that is not the book currency' as const;

/**
 * A flatten's split booked against a lot that had already closed — the venue
 * sold quantity the store's realized record does not contain. See
 * `persistUnattributedSplits` for what is and is not repaired.
 */
export const UNATTRIBUTED_FLATTEN_FILL =
  'flatten fill booked against an already-closed lot — its closed trade understates the sale' as const;

/** The #1506 persist itself failing: the fill is NOT booked, and will be retried next poll */
export const UNATTRIBUTED_FLATTEN_FILL_PERSIST_FAILED =
  'failed to book a flatten fill against an already-closed lot' as const;

/** A flatten split is `leg: 'exit'`, which has no submit-time cost estimate to read */
const NO_MODELLED_LOT_COSTS: ModelledLotCosts = { entry: null, protectiveExit: null };

export async function ingestFills(input: FillIngestInput): Promise<void> {
  const { clock, broker, store } = input;

  const positions = await store.getOpenPositions();
  if (positions.length === 0) return;

  // GLOBAL floor keyed on `opened_at` alone, never per-lot: a per-lot floor
  // can raise past an earlier fill still in flight and under-fetch it (#838)
  const since = earliest(positions.map((position) => position.opened_at));
  const fills = await broker.fetchNewFills(since);

  // Read AFTER fetchNewFills: an earlier `now` could predate an undated
  // fill's clock read, making advanceLot's no-lookahead filter drop it forever
  const now = clock.now();

  const byLot = new Map<string, NormalizedFill[]>();
  for (const fill of fills) {
    const bucket = byLot.get(fill.client_order_id);
    if (bucket === undefined) byLot.set(fill.client_order_id, [fill]);
    else bucket.push(fill);
  }

  // #517: a flatten submits under its OWN idempotency key, so its fill would
  // otherwise sit in a `byLot` bucket the loop below never reads; this
  // redistributes it into the closed lot(s)' own buckets first
  const failures: ContainedFailure[] = [];
  const flattenNamedLots = await redistributeFlattenFills(input, byLot, positions, failures);
  // Flat union of every lot named by any flatten this poll (#525)
  const flattenTargetedLots = new Set<string>();
  for (const lotKeys of flattenNamedLots.values()) {
    for (const lotKey of lotKeys) flattenTargetedLots.add(lotKey);
  }

  for (const position of positions) {
    // Every lot is independent work: whether one lot's store write or broker
    // call succeeds says nothing about the next lot's, so it must not decide
    // it. See `ContainedFailure`.
    try {
      await advanceLot(
        input,
        position,
        byLot.get(position.idempotency_key) ?? [],
        now,
        flattenTargetedLots.has(position.idempotency_key),
      );
    } catch (error) {
      failures.push({
        scope: 'lot-advance',
        key: position.idempotency_key,
        instrument: position.instrument,
        error,
      });
    }
  }

  // Mark a flatten swept only once every lot it named durably advanced —
  // never unconditionally on redistribution succeeding (#519/#526)
  const failedLotKeys = new Set(
    failures.filter((failure) => failure.scope === 'lot-advance').map((failure) => failure.key),
  );
  for (const [flattenKey, lotKeys] of flattenNamedLots) {
    if ([...lotKeys].some((lotKey) => failedLotKeys.has(lotKey))) continue;
    try {
      await input.store.markFlattenFillsSwept(flattenKey, now);
    } catch (error) {
      // Not correctness-critical: a missed mark leaves the row unswept,
      // which `getUnresolvedFlattens()`/`reconcile()` already recovers —
      // so this alone does not reject the poll's promise (#519/#526)
      logCaughtFailure(
        input.logger,
        {
          trace_id: input.trace_id,
          stage: 'execution',
          event: 'flatten_sweep_mark_failed',
          level: 'warn',
          message:
            'markFlattenFillsSwept failed — the row stays unswept and will be found again by ' +
            "the next reconcile() pass (SharedStore.getUnresolvedFlattens()'s own designed recovery)",
        },
        error,
        { flatten_key: flattenKey },
      );
      failures.push({ scope: 'flatten-sweep-mark', key: flattenKey, instrument: null, error });
    }
  }

  // Reported once every unit of work has run; 'flatten-sweep-mark' alone
  // does not reject the poll (see its catch above)
  if (failures.some((failure) => failure.scope !== 'flatten-sweep-mark')) {
    throwContainedFailures(failures);
  }
}

/** One unit of work a poll could not complete; held so one lot's failure never aborts the rest */
interface ContainedFailure {
  /** 'flatten-sweep-mark' alone is not correctness-critical (#519/#526/#603) */
  scope: 'flatten-attribution' | 'lot-advance' | 'flatten-sweep-mark';
  /** Never the failure's message or column content — `throwContainedFailures` writes this to `audit_log` (#507) */
  key: string;
  /** The lot's instrument when cheaply known; `null` for a flatten-keyed scope */
  instrument: string | null;
  error: unknown;
}

/** `reason` is the thrown value's CLASS NAME, never `error.message` (which could carry uncurated content) — reachable via `AggregateError.errors`/`cause` instead */
function throwContainedFailures(failures: readonly ContainedFailure[]): void {
  if (failures.length === 0) return;
  const named = failures
    .map((failure) => {
      const instrument = failure.instrument === null ? '' : ` (${failure.instrument})`;
      const reason =
        failure.error instanceof Error ? failure.error.constructor.name : typeof failure.error;
      return `${failure.scope} '${failure.key}'${instrument} [${reason}]`;
    })
    .join(', ');
  throw new AggregateError(
    failures.map((failure) => failure.error),
    `ingestFills: ${failures.length} contained failure(s) — every other lot in this poll was ` +
      `advanced; unresolved: ${named}`,
    { cause: failures[0]?.error },
  );
}

/**
 * Routes a flatten's fill(s) back to the lot(s) it closed (#517). Never
 * throws — a failed bucket is left un-redistributed (fail-closed) and
 * reported via `failures`. Returns every lot key named, including a
 * zero-share lot, since the caller's re-arm check needs it (#525).
 */
async function redistributeFlattenFills(
  input: FillIngestInput,
  byLot: Map<string, NormalizedFill[]>,
  positions: readonly OpenPosition[],
  failures: ContainedFailure[],
): Promise<Map<string, Set<string>>> {
  const positionKeys = new Set(positions.map((position) => position.idempotency_key));
  const flattenNamedLots = new Map<string, Set<string>>();

  // A snapshot, not a live iterator: the loop body deletes from `byLot` as it
  // goes. It can go stale mid-loop (a concurrent `execute()` opens a new lot
  // on the same instrument) — that lot's key is absent here, so its bucket
  // falls through to the `getFlattenAttribution` lookup below instead
  for (const clientOrderId of [...byLot.keys()]) {
    // a lot's own bucket — the existing path
    if (positionKeys.has(clientOrderId)) continue;

    // Fail-closed (#575): named-lot set is recorded only on SUCCESS, so a
    // failed bucket can't make `advanceLot` re-arm off an incomplete fill
    const targetedByThisFlatten = new Set<string>();
    try {
      await redistributeOneFlatten(
        input,
        byLot,
        clientOrderId,
        targetedByThisFlatten,
        positionKeys,
        failures,
      );
      // Empty (not merely absent) is the ordinary return for a
      // `clientOrderId` that names no real flatten — recording it anyway
      // would hand `markFlattenFillsSwept` a key with no backing row
      if (targetedByThisFlatten.size > 0) {
        flattenNamedLots.set(clientOrderId, targetedByThisFlatten);
      }
    } catch (error) {
      failures.push({ scope: 'flatten-attribution', key: clientOrderId, instrument: null, error });
    }
  }

  return flattenNamedLots;
}

/** All-or-nothing: either completes, or leaves `byLot` exactly as found (see the `byLot.delete` at the end) */
async function redistributeOneFlatten(
  input: FillIngestInput,
  byLot: Map<string, NormalizedFill[]>,
  clientOrderId: string,
  /** THIS bucket's named lots — a separate set the caller merges only on success */
  namedLots: Set<string>,
  /**
   * The caller's `positions` snapshot, by key — for `persistUnattributedSplits`
   * to detect a named lot missing from it
   */
  positionKeys: ReadonlySet<string>,
  /** The caller's accumulator, for the one failure this function does not throw on */
  failures: ContainedFailure[],
): Promise<void> {
  const { store } = input;
  const attribution = await store.getFlattenAttribution(clientOrderId);
  // Not a known flatten (unrelated id, a pre-migration-0020 row, or a lot
  // that opened after `positions` was captured): left untouched. The
  // broker's fill feed re-offers it next poll, once a fresh
  // `getOpenPositions()` snapshot names the lot for the ordinary path
  if (attribution === null || attribution.lot_idempotency_keys.length === 0) return;
  const lotKeys = attribution.lot_idempotency_keys;

  // Recorded before the split runs, so a lot with ZERO share of this raw
  // fill (a sibling absorbed it all) still gets the re-arm check (#525)
  for (const lotKey of lotKeys) namedLots.add(lotKey);

  const rawFills = byLot.get(clientOrderId);
  // Safe despite reading like a hazard (#575): `namedLots` is already
  // populated, but nothing is half-consumed yet (split hasn't started), so
  // this return leaves `byLot` untouched, same as any other early exit
  if (rawFills === undefined) return;

  // Each named lot's FIXED share of THIS flatten, off the write-ahead row
  // (#571) — must be STABLE (recomputes identically every poll) and
  // EXIT-AWARE (held quantity, not entry total); pre-migration-0021 rows
  // fall back to the old entry-total split instead of failing
  const journalledHeld = attribution.lot_held_quantities;
  const totalShare =
    journalledHeld === null
      ? await entryTotalShares(store, lotKeys)
      : new Map(journalledHeld.map((lot) => [lot.idempotency_key, lot.held]));

  const split = splitFlattenFills({ clientOrderId, rawFills, lotKeys, totalShare, attribution });
  const unattributed: [string, readonly NormalizedFill[]][] = [];
  for (const [lotKey, splitFills] of split.splits) {
    const bucket = byLot.get(lotKey);
    if (bucket === undefined) byLot.set(lotKey, [...splitFills]);
    else bucket.push(...splitFills);
    if (!positionKeys.has(lotKey)) unattributed.push([lotKey, splitFills]);
  }
  for (const { attributed, leftover } of split.outcomes) {
    // `leftover > 0`: a genuine venue over-fill past what the named lots
    // HELD (#571) — dropped (no safe lot to hand it to), but not silent (#527)
    if (leftover > 0) {
      // Dedup on `attributed`'s derived ids so this doesn't re-warn every
      // poll forever on the same re-offered over-fill (#527)
      let alreadyWarned = false;
      try {
        for (const { idempotency_key, broker_fill_id } of attributed) {
          if (await store.hasFill({ idempotency_key, broker_fill_id })) {
            alreadyWarned = true;
            break;
          }
        }
      } catch {
        // Can't tell — default to warning rather than suppressing; a
        // duplicate warn costs a grep, a suppressed one costs the trace
        alreadyWarned = false;
      }

      if (!alreadyWarned) {
        // Swallowed deliberately: a rejected alert must not turn a
        // SUCCESSFUL redistribution into a contained failure (this
        // function's all-or-nothing contract still has to complete)
        try {
          await input.flattenOverfillAlerts.postFlattenOverfillWarning({
            trace_id: input.trace_id,
            idempotency_key: clientOrderId,
            unattributed_qty: leftover,
            observed_at: input.clock.now(),
          });
        } catch {
          // #573: logged with a FIXED, self-authored message, never the
          // channel's own error — a Telegram failure can quote a URL
          // carrying a bot token
          safeLog(input.logger, {
            trace_id: input.trace_id,
            stage: 'execution',
            event: 'flatten_overfill_alert_send_failed',
            level: 'warn',
            message:
              'flatten-overfill alert delivery failed — the overfill itself was still dropped ' +
              'as designed; this only lost the diagnostic line about it',
            payload: { flatten_client_order_id: clientOrderId, unattributed_qty: leftover },
          });
        }
      }
    }
  }

  // AFTER the over-fill loop: #527's `alreadyWarned` check tests `hasFill`
  // on the ids this writes, so booking first would suppress the first-ever
  // warning for a fill that both over-fills and names a closed lot
  for (const [lotKey, splitFills] of unattributed) {
    await persistUnattributedSplits(
      input,
      attribution,
      clientOrderId,
      lotKey,
      splitFills,
      failures,
    );
  }

  // Durable "residual observed, protection not confirmed" marker (#549),
  // written before any `applyLotAdvance` this poll runs so a crash before
  // the re-arm confirms still leaves this lot findable by the sweep
  // Best-effort: a failed write only narrows #549's crash coverage, logged
  await markResidualsUnprotected(
    input,
    [...split.remaining].filter(([, unclosed]) => unclosed > 0).map(([lotKey]) => lotKey),
    input.clock.now(),
    {
      level: 'warn',
      message:
        'markResidualUnprotected failed during flatten redistribution — a crash before the ' +
        "re-arm confirms would leave this lot's residual invisible to the #549 sweep",
      payload: { flatten_client_order_id: clientOrderId },
    },
  );

  // Consumed LAST, not before the split, so a throw before this point leaves
  // `byLot` untouched — deleting only once the splits are in is what makes
  // this function all-or-nothing
  byLot.delete(clientOrderId);
}

/**
 * Books a split whose named lot is a TERMINAL lot the venue sold against,
 * already gone from `positions` (#1506) — the ordinary per-position loop
 * will never see it again. A failed write is NOT swallowed: it's pushed to
 * `failures`, since retiring the journal row here would lose the fill
 * permanently (`since`'s floor excludes it from all recovery).
 */
async function persistUnattributedSplits(
  input: FillIngestInput,
  attribution: FlattenAttribution,
  clientOrderId: string,
  lotKey: string,
  splitFills: readonly NormalizedFill[],
  failures: ContainedFailure[],
): Promise<void> {
  const { store } = input;
  // #842's no-lookahead filter, the one `advanceLot` applies to every fill it
  // books. A split dated after the poll's clock is left for a later poll
  // rather than booked early, which only the backtest clock can produce
  const now = input.clock.now();
  for (const fill of splitFills) {
    if (fill.timestamp.getTime() > now.getTime()) continue;
    try {
      if (await store.hasFill({ idempotency_key: lotKey, broker_fill_id: fill.broker_fill_id })) {
        continue;
      }
      // Not a degradation: a split's `cost_breakdown` is the flatten's own
      // capture, already prorated by `splitFlattenFills`
      await store.applyLotAdvance({
        idempotency_key: lotKey,
        fills: [toFill(fill, lotKey, NO_MODELLED_LOT_COSTS)],
      });
    } catch (error) {
      logCaughtFailure(
        input.logger,
        {
          trace_id: input.trace_id,
          stage: 'execution',
          event: 'unattributed_flatten_fill_persist_failed',
          level: 'error',
          message: UNATTRIBUTED_FLATTEN_FILL_PERSIST_FAILED,
        },
        error,
        {
          flatten_client_order_id: clientOrderId,
          idempotency_key: lotKey,
          broker_fill_id: fill.broker_fill_id,
          qty: fill.qty,
        },
      );
      // Scoped under the LOT's key, which `failedLotKeys` reads to hold
      // `markFlattenFillsSwept` back
      failures.push({ scope: 'lot-advance', key: lotKey, instrument: null, error });
      continue;
    }

    // After the successful write only, so the fee contradiction is reported
    // about a fill durably in the CGT source, never one whose write threw
    await warnOnNonSterlingFee(
      input,
      { idempotency_key: lotKey, instrument: attribution.instrument },
      fill,
    );

    safeLog(input.logger, {
      trace_id: input.trace_id,
      stage: 'execution',
      event: 'unattributed_flatten_fill',
      level: 'error',
      message: UNATTRIBUTED_FLATTEN_FILL,
      payload: {
        flatten_client_order_id: clientOrderId,
        idempotency_key: lotKey,
        broker_fill_id: fill.broker_fill_id,
        qty: fill.qty,
      },
    });

    if (input.unattributedFlattenFillAlerts === undefined) continue;
    try {
      await input.unattributedFlattenFillAlerts.postUnattributedFlattenFillAlert({
        trace_id: input.trace_id,
        flatten_idempotency_key: clientOrderId,
        lot_idempotency_key: lotKey,
        instrument: attribution.instrument,
        side: attribution.side,
        broker_fill_id: fill.broker_fill_id,
        qty: fill.qty,
        observed_at: input.clock.now(),
      });
    } catch {
      // Channel's own error discarded, never logged — a transport failure
      // can quote a URL carrying a bot token (#573)
      safeLog(input.logger, {
        trace_id: input.trace_id,
        stage: 'execution',
        event: 'unattributed_flatten_fill_alert_send_failed',
        level: 'warn',
        message:
          'postUnattributedFlattenFillAlert delivery failed — see the ' +
          'unattributed_flatten_fill entry above for the fill this concerns',
        payload: { idempotency_key: lotKey, broker_fill_id: fill.broker_fill_id },
      });
    }
  }
}

/**
 * Pre-migration-0021 fallback split, blind to exits already recorded
 * against the lot (#571). Wind-down path only.
 */
async function entryTotalShares(
  store: FillIngestInput['store'],
  lotKeys: readonly string[],
): Promise<Map<string, number>> {
  const entrySizes = await store.getEntryFillSizes(lotKeys);
  return new Map(lotKeys.map((lotKey) => [lotKey, entrySizes.get(lotKey) ?? 0]));
}

async function collectNewFillsForLot(
  input: FillIngestInput,
  position: OpenPosition,
  lotFills: readonly NormalizedFill[],
): Promise<{
  newFills: Fill[];
  cumulativeReoffers: NormalizedFill[];
  ingestedEntry: boolean;
  ingestedExit: boolean;
}> {
  const { store } = input;
  const newFills: Fill[] = [];
  /**
   * Fills the dedup gate rejected that may STILL owe quantity: a
   * `qty_is_cumulative` feed (Alpaca) reuses one order id per observation of
   * a running `filled_qty`, so "we have this id" != "we have this quantity"
   */
  const cumulativeReoffers: NormalizedFill[] = [];
  // Pure function of `position` — computed once, reused per fill below
  const modelledLotCosts = modelledLotCostsFor(position);
  let ingestedEntry = false;
  let ingestedExit = false;
  for (const fill of lotFills) {
    if (
      await store.hasFill({
        idempotency_key: position.idempotency_key,
        broker_fill_id: fill.broker_fill_id,
      })
    ) {
      if (fill.qty_is_cumulative === true) cumulativeReoffers.push(fill);
      continue;
    }
    newFills.push(toFill(fill, position.idempotency_key, modelledLotCosts));
    // Below the dedup gate on purpose: a check above it would re-announce
    // the same contradiction on every poll for the life of the lot
    await warnOnNonSterlingFee(input, position, fill);
    ingestedEntry ||= fill.leg === 'entry';
    ingestedExit ||= fill.leg === 'exit';
  }
  return { newFills, cumulativeReoffers, ingestedEntry, ingestedExit };
}

async function reconcileCumulativeReoffers(
  input: FillIngestInput,
  position: OpenPosition,
  collected: {
    newFills: Fill[];
    cumulativeReoffers: NormalizedFill[];
    ingestedEntry: boolean;
    ingestedExit: boolean;
  },
): Promise<{ persisted: Fill[] | null; ingestedEntry: boolean; ingestedExit: boolean }> {
  const { store } = input;
  const { cumulativeReoffers, newFills } = collected;
  let { ingestedEntry, ingestedExit } = collected;

  // The lot's persisted record, read at most once per call. Feeds that
  // don't set `qty_is_cumulative` (Simulated, every backtest) skip this read
  // entirely — `cumulativeReoffers` stays empty
  let persisted: Fill[] | null = null;
  if (cumulativeReoffers.length > 0) {
    persisted = await store.getFills(position.idempotency_key);
    for (const fill of cumulativeReoffers) {
      // Against `persisted` PLUS this poll's new rows: an increment already
      // computed for the same order id must count against the next one
      const topUp = await cumulativeTopUp(input, position, fill, [...persisted, ...newFills]);
      if (topUp === null) continue;
      newFills.push(topUp);
      // `resizeProtectiveLegs` fires on `ingestedEntry` and sets an ABSOLUTE
      // quantity — booking the increment without setting this leaves the
      // venue's stop/target armed for the stale, smaller figure
      ingestedEntry ||= topUp.leg === 'entry';
      ingestedExit ||= topUp.leg === 'exit';
    }
  }
  return { persisted, ingestedEntry, ingestedExit };
}

async function handleLotWithNoNewFills(
  input: FillIngestInput,
  position: OpenPosition,
  now: Date,
  flattenTargetedThisPoll: boolean,
): Promise<void> {
  // A flatten can name this lot and resolve this poll while handing it ZERO
  // share, with its legs already cancelled by the same `executeExit` call —
  // the re-arm check has to happen here since nothing else runs (#525)
  if (flattenTargetedThisPoll) {
    await maybeRearmResidual(input, position, now);
  }

  // A lot `reconcile()` just adopted as filled/partially_filled but whose
  // fill was never ingested lands here silently otherwise (#1087). `stuck_ms`
  // (vs. `consecutive`-throttled re-announcement) tells a poll or two of
  // Alpaca propagation lag apart from an hours-long genuinely wedged lot
  if (isWedgedZeroFillLot(position)) {
    const { announce, consecutive } = input.filledZeroSizeThrottle.observe(
      position.idempotency_key,
      now,
    );
    if (announce !== null) {
      safeLog(input.logger, {
        trace_id: input.trace_id,
        stage: 'execution',
        event: 'fill_priced_at_zero_size',
        level: announce,
        message: FILLED_WITH_ZERO_SIZE,
        payload: {
          idempotency_key: position.idempotency_key,
          instrument: position.instrument,
          order_state: position.order_state,
          stuck_ms: now.getTime() - position.opened_at.getTime(),
          consecutive,
        },
      });
    }
  }
}

/**
 * `flattenTargetedThisPoll` (#525) is true when a flatten named this lot and
 * resolved this poll, independent of whether `fills` is non-empty
 */
async function advanceLot(
  input: FillIngestInput,
  position: OpenPosition,
  fills: readonly NormalizedFill[],
  now: Date,
  flattenTargetedThisPoll: boolean,
): Promise<void> {
  const { broker, store } = input;

  // No lookahead: in a backtest the feed is the whole simulated future, and a
  // fill dated past T has not happened yet. This stays HERE rather than moving
  // into the caller's bucketing pass — it is per-call semantics against this
  // call's `now`, not a grouping key
  const lotFills = fills.filter((fill) => fill.timestamp.getTime() <= now.getTime());

  const collected = await collectNewFillsForLot(input, position, lotFills);
  const { newFills } = collected;
  const { persisted, ingestedEntry, ingestedExit } = await reconcileCumulativeReoffers(
    input,
    position,
    collected,
  );

  if (newFills.length === 0) {
    await handleLotWithNoNewFills(input, position, now, flattenTargetedThisPoll);
    return;
  }

  // Recomputed from the full fill record, never a running total — this is
  // what makes a re-poll converge instead of drifting
  const recorded = [
    ...(persisted ?? (await store.getFills(position.idempotency_key))),
    ...newFills,
  ];
  const entryFills = recorded.filter((fill) => fill.leg === 'entry');
  const exitFills = recorded.filter(isExitFill);

  const filledSize = totalQty(entryFills);
  // No entry fill yet — persist the rows alone. Deliberately NOT `clear()`ed:
  // restarting the wedge streak here would re-arm a `warn` that should stay
  // a quiet `info`-cadence wedge (#1087, #1383)
  if (filledSize === 0) {
    await store.applyLotAdvance({ idempotency_key: position.idempotency_key, fills: newFills });
    return;
  }

  // `filledSize > 0` confirms the wedge streak is genuinely over. Only an
  // episode that actually warned logs a clear below (mirrors
  // `reportAdvisoryWarnings`'s `hadWarnings` gate in tick-runner.ts)
  const { hadWarned } = input.filledZeroSizeThrottle.clear(position.idempotency_key);
  if (hadWarned) {
    safeLog(input.logger, {
      trace_id: input.trace_id,
      stage: 'execution',
      event: 'fill_zero_size_cleared',
      level: 'info',
      message: FILLED_ZERO_SIZE_CLEARED,
      payload: { idempotency_key: position.idempotency_key, instrument: position.instrument },
    });
  }

  const avgEntryPrice = weightedAvgPrice(entryFills);
  const exitQty = totalQty(exitFills);
  const flat = isFlat({ filledSize, exitQty });
  const orderState = nextState(position, filledSize, flat);

  // Resize sets an absolute quantity, so if the persist below never happens
  // the re-poll's identical resize is a no-op, not a double-trim
  if (!flat && ingestedEntry) {
    await broker.resizeProtectiveLegs(position.idempotency_key, filledSize);
  }

  // `executeExit` cancels every held lot's legs BEFORE the flatten, so "not
  // flat" after either signal means genuinely naked, not merely under-sized
  if (!flat && (ingestedExit || flattenTargetedThisPoll)) {
    await maybeRearmResidual(input, position, now, { filledSize, exitQty });
  }

  // One transaction: a crash mid-advance is repaired by the next poll
  // re-offering the same fills, which the dedup gate then accepts
  await store.applyLotAdvance({
    idempotency_key: position.idempotency_key,
    fills: newFills,
    position_update: {
      filled_size: filledSize,
      avg_entry_price: avgEntryPrice,
      order_state: orderState,
    },
    ...(flat
      ? {
          closed_trade: closedTrade(position, { filledSize, avgEntryPrice, entryFills, exitFills }),
        }
      : {}),
  });
}

/**
 * A lot that fills and exits between two polls lands on `closed` directly —
 * the intermediate states describe reality, not a queue every lot must pass
 */
function nextState(position: OpenPosition, filledSize: number, flat: boolean): OrderState {
  if (flat) return 'closed';
  return coversQty(filledSize, position.requested_size) ? 'filled' : 'partially_filled';
}

/**
 * One observation of a cumulative feed (Alpaca's running `filled_qty` under a
 * fixed order id), turned into the INCREMENT it still owes — or `null` when
 * it owes nothing. The top-up's id embeds the cumulative quantity it settles,
 * so a re-poll at the same cumulative recomputes the same id and no-ops.
 */
async function cumulativeTopUp(
  input: FillIngestInput,
  position: OpenPosition,
  fill: NormalizedFill,
  booked: readonly Fill[],
): Promise<Fill | null> {
  const increment = cumulativeIncrement(booked, fill);
  if (increment === null) return null;

  if (increment.priceDegraded) {
    // A non-positive derived price means the venue's cumulative average and
    // the tranche history disagree — worth an operator's attention
    safeLog(input.logger, {
      trace_id: input.trace_id,
      stage: 'execution',
      event: 'fill_topup_price_unusable',
      level: 'warn',
      message:
        '#842: cumulative fill top-up produced an unusable increment price — booking the ' +
        "quantity at the venue's cumulative average instead, so avg_entry_price is approximate",
      payload: {
        idempotency_key: position.idempotency_key,
        broker_fill_id: fill.broker_fill_id,
        booked_qty: increment.bookedQty,
        venue_cumulative_qty: fill.qty,
        derived_price: increment.derivedPrice,
      },
    });
  }

  // Reached only when booking a genuinely new increment — a re-poll at the
  // same cumulative never pages twice
  await warnOnNonSterlingFee(input, position, fill);

  return toFill(
    {
      ...fill,
      broker_fill_id: increment.broker_fill_id,
      qty: increment.qty,
      price: increment.price,
      fee: increment.fee,
    },
    position.idempotency_key,
    // Both of a lot's estimates are passed since the parameter is the pair —
    // `qty_is_cumulative` is Alpaca-only and reported on the entry leg only
    modelledLotCostsFor(position),
  );
}

/**
 * Enumerates fields rather than spreading, to keep `qty_is_cumulative`
 * (#842) out of the persisted row. `modelledLotCosts` fallback CHARGES the
 * modelled commission via `max(fill.fee, fallbackCostBreakdown.commission)`
 * — a top-up, not an addition, since the venue's own fee is the same
 * commission once Saxo is the adapter (#1121).
 */
/**
 * Posts to `input.nonSterlingFeeAlerts` AFTER `safeLog`, never instead of it
 * (#1465). Second param is the two fields read, not an `OpenPosition` —
 * `persistUnattributedSplits` books against a lot with none to pass (#1550).
 */
async function warnOnNonSterlingFee(
  input: FillIngestInput,
  position: { idempotency_key: string; instrument: string },
  fill: NormalizedFill,
): Promise<void> {
  const currency = fill.fee_currency;
  if (currency === undefined || isBookCurrency(currency)) return;
  const alert: NonSterlingFeeAlert = {
    trace_id: input.trace_id,
    idempotency_key: position.idempotency_key,
    instrument: position.instrument,
    broker_fill_id: fill.broker_fill_id,
    fee: fill.fee,
    fee_currency: currency,
    book_currency: BOOK_CURRENCY,
  };
  safeLog(input.logger, {
    trace_id: input.trace_id,
    stage: 'execution',
    event: 'fee_currency_not_book_currency',
    level: 'error',
    message: FEE_CURRENCY_NOT_BOOK_CURRENCY,
    // #1521: rides this existing line rather than a second one — a non-book
    // fee currency and a missing conversion rate are the same fact
    payload: {
      ...alert,
      fx_rate_to_gbp: fill.fx_rate_to_gbp,
      fx_rate_to_gbp_source: fill.fx_rate_to_gbp_source,
    },
  });
  if (input.nonSterlingFeeAlerts === undefined) return;
  try {
    await input.nonSterlingFeeAlerts.postNonSterlingFeeAlert(alert);
  } catch {
    safeLog(input.logger, {
      trace_id: input.trace_id,
      stage: 'execution',
      event: 'non_sterling_fee_alert_send_failed',
      level: 'error',
      message:
        'postNonSterlingFeeAlert delivery failed — see the fee_currency_not_book_currency ' +
        'entry above for the fill this concerns',
      payload: {
        idempotency_key: position.idempotency_key,
        broker_fill_id: fill.broker_fill_id,
      },
    });
  }
}

function toFill(
  fill: NormalizedFill,
  idempotencyKey: string,
  modelledLotCosts: ModelledLotCosts,
): Fill {
  const modelledLegCost = modelledLegCostFor(fill.leg, modelledLotCosts);
  const fallbackCostBreakdown =
    fill.cost_breakdown === undefined && modelledLegCost !== null
      ? prorateCostBreakdown(modelledLegCost.breakdown, fill.qty / modelledLegCost.requestedSize)
      : undefined;
  const chargedFee = chargeTopUpTo(fill.fee, fallbackCostBreakdown?.commission);

  return {
    idempotency_key: idempotencyKey,
    broker_fill_id: fill.broker_fill_id,
    leg: fill.leg,
    price: fill.price,
    qty: fill.qty,
    fee: chargedFee,
    timestamp: fill.timestamp,
    ...(fill.cost_breakdown !== undefined
      ? { cost_breakdown: fill.cost_breakdown }
      : fallbackCostBreakdown !== undefined
        ? { cost_breakdown: fallbackCostBreakdown }
        : {}),
    // #793: UNLIKE `qty_is_cumulative`, this one IS persisted (see
    // `NormalizedFill.exit_reason`'s doc)
    ...(fill.exit_reason === undefined ? {} : { exit_reason: fill.exit_reason }),
    // #1001: also persisted, unlike `qty_is_cumulative` — see
    // `Fill.flatten_idempotency_key`'s doc
    ...(fill.flatten_idempotency_key === undefined
      ? {}
      : { flatten_idempotency_key: fill.flatten_idempotency_key }),
    // #1220: carried through verbatim, never converted — see
    // `Fill.fee_currency`'s doc
    ...(fill.fee_currency === undefined ? {} : { fee_currency: fill.fee_currency }),
    // #1521: same posture as `fee_currency` above
    ...(fill.fx_rate_to_gbp === undefined ? {} : { fx_rate_to_gbp: fill.fx_rate_to_gbp }),
    ...(fill.fx_rate_to_gbp_source === undefined
      ? {}
      : { fx_rate_to_gbp_source: fill.fx_rate_to_gbp_source }),
  };
}

/**
 * Which submit-time estimate a fill's leg is charged from, or `null` for a
 * leg this lot's own submission never priced. `'exit'` is null deliberately:
 * a flatten's estimate belongs to the FLATTEN's own submit-time capture
 * (attached in `splitFlattenFills`), not this lot's.
 */
function modelledLegCostFor(
  leg: NormalizedFill['leg'],
  costs: ModelledLotCosts,
): ModelledLegCost | null {
  switch (leg) {
    case 'entry':
      return costs.entry;
    case 'stop':
    case 'target':
      return costs.protectiveExit;
    case 'exit':
      return null;
  }
}

function earliest(dates: readonly Date[]): Date {
  return dates.reduce((min, date) => (date.getTime() < min.getTime() ? date : min));
}
