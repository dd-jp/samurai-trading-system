/**
 * Execution's second surface — `ingestFills()` (ticket #83). See
 * docs/specs/execution-spec.md ("Module: Order State Machine & Partial
 * Fills", "Module: Trade-Record Schema").
 *
 * A bracket's lifecycle outlives the `execute()` that placed it — a stock's
 * exit leg may fill days later — so advancing it is a separate, pollable
 * surface. Per live lot: drain the venue's fill feed, persist each new `Fill`,
 * resize the protective legs to cumulative filled quantity, and on
 * round-trip-to-flat emit the `ClosedTrade` the Feedback Loop and Risk read.
 *
 * It reads the broker's fill feed, not the broker's opinion of the store:
 * correcting store-vs-broker divergence is #86's `reconcile()`.
 *
 * Idempotent by construction, because polling is the access pattern: fills
 * dedup on `broker_fill_id`, and a lot closes once because closing makes it
 * terminal and terminal lots leave `getOpenPositions()`.
 *
 * A flatten's fill is a special case of "a fill for a lot" (#517): it
 * arrives under the FLATTEN's own idempotency key, never the lot's, because
 * `execute()`'s exit path (`executeExit`) submits it under a fresh one.
 * `redistributeFlattenFills` below routes it back to the lot(s) the flatten
 * journalled it was closing before the rest of this module ever sees it —
 * without that routing there is no other mechanism that closes a
 * flatten-closed lot at all (see the finding in PR #517's body).
 */
import type { ClosedTrade, Fill, OpenPosition, OrderState } from '../shared/index.js';
import type { ExecutionInput, NormalizedFill } from './types.js';

/** A fill on a protective/closing leg — anything that isn't opening the lot. */
type ExitFill = Fill & { leg: 'stop' | 'target' | 'exit' };

export async function ingestFills(input: ExecutionInput): Promise<void> {
  const { clock, broker, store } = input;
  const now = clock.now();

  const positions = await store.getOpenPositions();
  if (positions.length === 0) return;

  // The feed's floor is the oldest live lot: no fill of ours predates the
  // `execute()` that opened the lot it belongs to. Re-offered fills are
  // expected and handled by the dedup below, so this only bounds the query.
  const since = earliest(positions.map((position) => position.opened_at));
  const fills = await broker.fetchNewFills(since);

  // Bucket once by lot rather than re-scanning the whole feed per position:
  // `since` is the OLDEST live lot's `opened_at`, so a single stale open lot
  // drags the feed's span across the whole process lifetime while `positions`
  // grows with the universe. Within a bucket the feed's own order is
  // preserved, which `advanceLot` relies on downstream.
  const byLot = new Map<string, NormalizedFill[]>();
  for (const fill of fills) {
    const bucket = byLot.get(fill.client_order_id);
    if (bucket === undefined) byLot.set(fill.client_order_id, [fill]);
    else bucket.push(fill);
  }

  // #517: a bucket the loop below would otherwise never read. A flatten
  // submits under its OWN fresh idempotency key (execute.ts's
  // `executeExit`), never a held lot's, so its fill lands in `byLot` keyed
  // on a client_order_id that matches no `position.idempotency_key` — and
  // until this call, that bucket was simply never looked up again. This
  // redistributes it into the target lot(s)' own buckets (keyed by their
  // OWN idempotency_key) before the loop reads them, so the rest of this
  // function needs no knowledge that a flatten was ever involved.
  await redistributeFlattenFills(input, byLot, positions);

  for (const position of positions) {
    await advanceLot(input, position, byLot.get(position.idempotency_key) ?? [], now);
  }
}

/**
 * Routes a flatten's fill(s) back to the lot(s) `executeExit` journalled it
 * to close (#517), by rewriting `byLot` in place: buckets keyed on a
 * flatten's own client_order_id are removed, and their fills reappear —
 * split and retagged — under the closing lot(s)' own idempotency_key, so
 * `advanceLot`'s existing per-lot logic (including its `timestamp <= now`
 * no-lookahead filter, applied AFTER this call, unchanged) needs no
 * knowledge that any of this happened.
 *
 * `fill.leg` is NOT how a flatten's bucket is recognised — the Simulated
 * adapter tags its own flatten fill `'entry'` (it models the flatten as
 * just another priced fill at submit time, the same as a bracket's entry),
 * and nothing in `BrokerAdapter`'s contract requires every adapter to agree
 * on what a flatten fill's leg should read. `getFlattenLotKeys` keyed on
 * `client_order_id` is adapter-agnostic where a leg tag is not, which is
 * why this function does not consult `fill.leg` to decide whether a bucket
 * is a flatten's — only afterwards, to force it to `'exit'` on the way out
 * (below), so `advanceLot`'s `isExitFill`/`closedTrade` see one true answer
 * regardless of which adapter reported it.
 */
async function redistributeFlattenFills(
  input: ExecutionInput,
  byLot: Map<string, NormalizedFill[]>,
  positions: readonly OpenPosition[],
): Promise<void> {
  const { store } = input;
  const positionKeys = new Set(positions.map((position) => position.idempotency_key));

  // A snapshot of the keys, not a live iterator: the loop body deletes from
  // `byLot` as it goes (once a flatten bucket is consumed, redistributed) and
  // a Map's own key order is otherwise unaffected by that, but iterating a
  // separate array keeps the deletion from being a subtlety a reader has to
  // reason through.
  //
  // The snapshot can go stale mid-loop: a concurrent `execute()` can write a
  // NEW lot on the same instrument while this function is still awaiting a
  // store round-trip for an EARLIER bucket, and on an unlucky interleaving
  // that new lot's own entry fill can already be sitting in `byLot` by the
  // time the loop below reaches it. That new lot's key is absent from THIS
  // `positionKeys` snapshot, so its bucket fails the "a lot's own bucket"
  // check right below and falls through to the `getFlattenLotKeys` lookup
  // instead — see that lookup's own comment for what happens to it from
  // there, and why it is safe.
  for (const clientOrderId of [...byLot.keys()]) {
    if (positionKeys.has(clientOrderId)) continue; // a lot's own bucket — the existing path.

    const lotKeys = await store.getFlattenLotKeys(clientOrderId);
    // Not a known flatten either (an unrelated/unknown client_order_id, a
    // flatten row written before migration 0020 named no lot, OR — per the
    // snapshot comment above — a lot that opened on this instrument AFTER
    // `positions` was captured): left exactly as before this change. The
    // bucket sits untouched in `byLot`; `ingestFills()`'s per-position loop
    // reads only the SAME stale `positions`, so it never looks this key up
    // either. Nothing is lost — the broker's fill feed re-offers the same
    // fill next poll (this module's own dedup-on-`broker_fill_id` contract),
    // and by then a fresh `getOpenPositions()` snapshot names the lot, so it
    // is picked up by the ORDINARY per-position path, one poll later than it
    // theoretically could have been. And it can never collide with a REAL
    // flatten's targets: `lot_idempotency_keys` is fixed at that flatten's
    // own write-ahead, which necessarily predates a lot that did not exist
    // yet.
    if (lotKeys === null || lotKeys.length === 0) continue;

    const rawFills = byLot.get(clientOrderId);
    if (rawFills === undefined) continue; // appeases the type checker; every key here has a bucket.
    byLot.delete(clientOrderId);

    // Each named lot's FIXED total share of THIS flatten — its entry's fully
    // filled quantity, reconstructed from persisted ENTRY fills the same way
    // `advanceLot` reconstructs `filledSize` below. Deliberately NOT reduced
    // by prior EXIT fills already on record for the lot, and NOT filtered to
    // lots still present in `positions` (open) — either would make the split
    // drift between polls as fills get persisted and lots go terminal, and a
    // DIFFERENT split under the SAME `broker_fill_id`-derived id is exactly
    // what breaks `hasFill`'s dedup below (it matches on id alone, so a
    // shrunk second attempt does not "correct" the first — it just vanishes
    // behind it, silently stranding the difference). An entry's filled
    // quantity, in contrast, is fixed forever once filling stops — which is
    // always before any exit fill can exist for the same lot (`advanceLot`'s
    // own "an exit fill cannot precede the entry fill" invariant) — so
    // recomputing this on every poll, for every named lot regardless of
    // whether it has since closed, yields the IDENTICAL split every time.
    // That is what lets a poll dedupe cleanly on `broker_fill_id` instead of
    // needing to reconstruct "how much of this fill did lot X already get".
    const totalShare = new Map<string, number>();
    for (const lotKey of lotKeys) {
      const priorFills = await store.getFills(lotKey);
      const entryQty = priorFills
        .filter((fill) => fill.leg === 'entry')
        .reduce((sum, fill) => sum + fill.qty, 0);
      totalShare.set(lotKey, entryQty);
    }

    // Processed in the feed's own order, decrementing an IN-MEMORY copy of
    // `totalShare` across `rawFills` — a flatten is modelled/observed as one
    // fill in practice (an IOC market order does not rest, so there is
    // normally exactly one raw fill per flatten to allocate), but this stays
    // general instead of assuming that: if the feed ever legitimately offers
    // more than one raw fill for the same flatten in one poll, an EARLIER
    // one in this SAME pass must still count against a lot's fixed share
    // before a LATER one is allocated, or the two would double-book it.
    const remaining = new Map(totalShare);
    for (const rawFill of rawFills) {
      let leftover = rawFill.qty;
      for (const lotKey of lotKeys) {
        if (leftover <= 0) break;
        const need = remaining.get(lotKey) ?? 0;
        if (need <= 0) continue;

        const take = Math.min(need, leftover);
        const share = take / rawFill.qty;
        const splitFill: NormalizedFill = {
          ...rawFill,
          // Forced regardless of what the adapter tagged the raw fill — see
          // this function's docstring.
          leg: 'exit',
          // The lot-scoped id `hasFill`/`fills`' PK need: `hasFill` dedups
          // GLOBALLY on `broker_fill_id` alone (`ingest-fills.ts` above), so
          // splitting one raw fill across two lots under the SAME id would
          // make the second lot's split silently vanish behind the first
          // lot's dedup the moment either is persisted. Stable across polls
          // for the reason `totalShare` above is: the SAME (id, qty) pair
          // recomputes every time, so a repeat poll dedupes cleanly instead
          // of colliding with a differently-sized earlier attempt.
          broker_fill_id: `${rawFill.broker_fill_id}:${lotKey}`,
          qty: take,
          fee: rawFill.fee * share,
        };

        const bucket = byLot.get(lotKey);
        if (bucket === undefined) byLot.set(lotKey, [splitFill]);
        else bucket.push(splitFill);

        remaining.set(lotKey, need - take);
        leftover -= take;
      }
      // `leftover > 0` here means the flatten filled more than the named
      // lots' entries ever covered — `execute()`'s exact
      // `order.size === heldSize` check (execute.ts's `executeExit`) means
      // this should not happen, and there is no safe lot to hand the excess
      // to, so it is left unattributed rather than guessed onto one. Silent,
      // deliberately: a genuine over-fill here would already be showing up
      // as a resize/exposure divergence elsewhere, and manufacturing a
      // second signal here would not make that one easier to find.
      //
      // A DIFFERENT case from a new lot opening on this instrument mid-poll
      // (see the `positionKeys` snapshot comment above, and the
      // `getFlattenLotKeys` one below it): that one is a bucket this
      // function never even reaches this far for — it exits at the
      // `getFlattenLotKeys` check, deferred safely to the next poll. This
      // one is a genuine surplus against the flatten's OWN named lots, with
      // nowhere safe to go, ever.
    }
  }
}

/** `fills` is this lot's bucket already — keyed on `client_order_id` by the caller. */
async function advanceLot(
  input: ExecutionInput,
  position: OpenPosition,
  fills: readonly NormalizedFill[],
  now: Date,
): Promise<void> {
  const { broker, store } = input;

  // No lookahead: in a backtest the feed is the whole simulated future, and a
  // fill dated past T has not happened yet. This stays HERE rather than moving
  // into the caller's bucketing pass — it is per-call semantics against this
  // call's `now`, not a grouping key.
  const lotFills = fills.filter((fill) => fill.timestamp.getTime() <= now.getTime());

  const newFills: Fill[] = [];
  let ingestedEntry = false;
  for (const fill of lotFills) {
    if (await store.hasFill(fill.broker_fill_id)) continue;
    newFills.push(toFill(fill, position.idempotency_key));
    ingestedEntry ||= fill.leg === 'entry';
  }

  // Nothing landed: the lot is exactly as the last poll left it.
  if (newFills.length === 0) return;

  // Recomputed from the full fill record (persisted rows + this poll's new
  // ones, in the order the atomic write below will persist them), never from
  // a running total — rebuilding from the record is what makes a re-poll
  // converge on the same numbers instead of drifting.
  const recorded = [...(await store.getFills(position.idempotency_key)), ...newFills];
  const entryFills = recorded.filter((fill) => fill.leg === 'entry');
  const exitFills = recorded.filter(isExitFill);

  const filledSize = totalQty(entryFills);
  // An exit fill cannot precede the entry fill that created the lot to exit.
  // If one somehow arrives first, there is no lot to size or close yet —
  // persist the fill rows alone.
  if (filledSize === 0) {
    await store.applyLotAdvance({ idempotency_key: position.idempotency_key, fills: newFills });
    return;
  }

  const avgEntryPrice = weightedAvgPrice(entryFills);
  const flat = coversQty(totalQty(exitFills), filledSize);
  const orderState = nextState(position, filledSize, flat);

  // Size the protection to what actually filled, before persisting the
  // advance: leaving a lot under-protected is the failure that costs money,
  // and only a fresh entry fill can have changed the quantity to protect.
  // Resize sets an absolute quantity, so if the persist below never happens
  // the re-poll's identical resize is a no-op, not a double-trim.
  if (!flat && ingestedEntry) {
    await broker.resizeProtectiveLegs(position.idempotency_key, filledSize);
  }

  // One transaction: fills, lot state, and (on flat) the ClosedTrade land
  // together or not at all — a crash mid-advance is repaired by the next
  // poll re-offering the same fills, which the dedup gate then accepts.
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
 * `partially_filled` while the entry is still working, `filled` once it is
 * complete, `closed` on round-trip-to-flat. A lot that fills and exits
 * between two polls lands on `closed` directly — the intermediate states are
 * a description of reality, not a queue every lot must pass through.
 */
function nextState(position: OpenPosition, filledSize: number, flat: boolean): OrderState {
  if (flat) return 'closed';
  return coversQty(filledSize, position.requested_size) ? 'filled' : 'partially_filled';
}

/**
 * Relative tolerance on the quantity comparisons, because both sides are
 * float64 sums of decimal `Fill.qty` rows and two sums of the SAME total
 * differ unless the tranches happen to share a summation order: entry
 * tranches of 0.3 + 0.3 + 0.4 total exactly 1, while exit tranches of
 * 0.7 + 0.2 + 0.1 total 0.9999999999999999. A bare `>=` therefore reads a
 * fully-exited lot as still open — forever, since no further fill is coming:
 * no `ClosedTrade` for the Feedback Loop, and a phantom lot left in
 * `getOpenPositions()` consuming Risk's exposure caps.
 *
 * The margin over float noise, measured against the same (n+2)·2^-53 bound
 * ADR-0005 §1 derives (n products, an n-term naive summation, one division),
 * is 88x at n = 100 fills (1.13e-14) and 36x at the 250-fills-per-leg worst
 * case (2.80e-14) — comfortable, but tens of times, NOT orders of
 * magnitude: a workload past ~9,000 fills on one leg would need this
 * constant revisited. The margin in the other direction is the wide one: a
 * residue of 1e-12 of a lot is orders below any venue's minimum quantity
 * increment, so it does not exist at the broker either and a lot that reads
 * flat here is flat there too. The tolerance has to carry that argument on
 * its own — `reconcile()` (#86) only inspects `pending`/`submitted` lots, so
 * it never revisits one this code has marked terminal.
 * See [ADR-0005](../../docs/adr/0005-money-math-precision.md).
 */
const QTY_EPSILON_RELATIVE = 1e-12;

/** `actual >= target`, tolerant of float64 summation noise on either side. */
function coversQty(actual: number, target: number): boolean {
  return actual >= target - Math.abs(target) * QTY_EPSILON_RELATIVE;
}

function closedTrade(
  position: OpenPosition,
  lot: {
    filledSize: number;
    avgEntryPrice: number;
    entryFills: readonly Fill[];
    exitFills: readonly ExitFill[];
  },
): ClosedTrade {
  const { filledSize, avgEntryPrice, entryFills, exitFills } = lot;

  // The fill that took the lot flat — it names how the trade ended and when.
  const closing = exitFills[exitFills.length - 1] as ExitFill;
  const avgExitPrice = weightedAvgPrice(exitFills);

  // Signed against the direction of the lot: a short earns the fall.
  const gross =
    position.side === 'buy'
      ? (avgExitPrice - avgEntryPrice) * filledSize
      : (avgEntryPrice - avgExitPrice) * filledSize;
  const feesTotal = [...entryFills, ...exitFills].reduce((sum, fill) => sum + fill.fee, 0);

  return {
    idempotency_key: position.idempotency_key,
    debate_id: position.debate_id,
    instrument: position.instrument,
    asset_class: position.asset_class,
    side: position.side,
    entry: avgEntryPrice,
    // The lot's INITIAL stop, carried from the bracket — R's denominator is
    // the risk taken at open.
    stop: position.stop,
    filled_size: filledSize,
    realized_pnl_net: gross - feesTotal,
    fees_total: feesTotal,
    opened_at: position.opened_at,
    closed_at: closing.timestamp,
    close_reason: closing.leg,
  };
}

/** Normalized broker shape → the stored record, keyed to its lot. */
function toFill(fill: NormalizedFill, idempotencyKey: string): Fill {
  return {
    idempotency_key: idempotencyKey,
    broker_fill_id: fill.broker_fill_id,
    leg: fill.leg,
    price: fill.price,
    qty: fill.qty,
    fee: fill.fee,
    timestamp: fill.timestamp,
    ...(fill.cost_breakdown === undefined ? {} : { cost_breakdown: fill.cost_breakdown }),
  };
}

function isExitFill(fill: Fill): fill is ExitFill {
  return fill.leg !== 'entry';
}

function totalQty(fills: readonly Fill[]): number {
  return fills.reduce((sum, fill) => sum + fill.qty, 0);
}

/** Size-weighted, so two unequal partials give the true average. */
function weightedAvgPrice(fills: readonly Fill[]): number {
  const qty = totalQty(fills);
  if (qty === 0) return 0;
  return fills.reduce((sum, fill) => sum + fill.price * fill.qty, 0) / qty;
}

function earliest(dates: readonly Date[]): Date {
  return dates.reduce((min, date) => (date.getTime() < min.getTime() ? date : min));
}
