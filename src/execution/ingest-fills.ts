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
 * flatten-closed lot at all (see the finding in PR #517's body) — splitting
 * it by the per-lot HELD quantities the same journal row recorded (#571).
 *
 * #525: `executeExit` cancels every held lot's protective legs BEFORE
 * submitting the flatten (#516 — a resting leg fires into a now-flat
 * position and opens a REVERSE one). When the flatten fills completely that
 * is safe; when it fills PARTIALLY, the cancelled legs are simply gone and
 * whatever remains open is naked until something re-arms it. `advanceLot`
 * below re-arms a residual the same poll it learns about it — from the
 * lot's own new exit fill, or (see `redistributeFlattenFills`'s returned
 * set) from a flatten that named this lot at all, even one that gave it
 * ZERO share this poll because an earlier-opened sibling absorbed the whole
 * partial fill. A failed re-arm posts `ResidualExposureAlertChannel` rather
 * than retrying — the recorded decision on #525 rejected a retry loop on
 * the order-submitting path, and this fallback is what keeps a naked
 * residual from going unnoticed through an unattended soak (#238).
 *
 * Both loops below run under a containment boundary — see `ContainedFailure`.
 * A failure inside one flatten bucket or one lot decides that unit only; the
 * whole set is reported once, after every other unit of work has landed.
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
  //
  // Its RETURN (#525) is every lot key named by a flatten resolved this
  // poll, regardless of whether that lot ended up with a nonzero share of
  // this specific raw fill — `advanceLot` needs that even for a lot this
  // poll gives NO new fill, so it can still re-arm a residual left at its
  // full original size because an earlier sibling lot absorbed the whole
  // partial fill.
  const failures: ContainedFailure[] = [];
  const flattenTargetedLots = await redistributeFlattenFills(input, byLot, positions, failures);

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
      failures.push({ scope: 'lot-advance', key: position.idempotency_key, error });
    }
  }

  // Last, once no unit of work is left to lose: reporting must not cost
  // progress, and progress must not buy silence.
  throwContainedFailures(failures);
}

/**
 * One unit of work a poll could not complete, held until the rest of the poll
 * has run.
 *
 * The boundary is per unit of work rather than per throw site because the same
 * blast-radius shape had already been point-fixed twice before #575 — #569
 * (`maybeRearmResidual`'s unguarded store read, below) and #524
 * (`AlpacaBrokerAdapter.fetchNewFills`, adapters/alpaca-adapter.ts) — and a
 * per-throw-site guard only ever closes the throw paths that exist today.
 * `ingestFills` is two loops over independent work: each flatten bucket to
 * redistribute, then each open lot to advance. A failure inside one says
 * nothing about any other, so it may not abort them. Where the cause is a
 * DURABLE row (a corrupt `flatten_submissions` entry) an aborting poll never
 * self-recovers: the next poll reads the same row and aborts identically,
 * indefinitely, looking in the logs exactly like a quiet market.
 *
 * Nothing that constructs one of these may throw. A containment guard that can
 * re-throw reopens exactly the hole it closes — the property `safeLog()`
 * (orchestrator/tick-loop.ts) and `alertResidualExposure` below are built
 * around. So the `catch` blocks push and do nothing else: no formatting, no
 * inspection of the caught error, no I/O.
 */
interface ContainedFailure {
  /** Which of the two boundaries caught it — a flatten bucket, or one lot's advance. */
  scope: 'flatten-attribution' | 'lot-advance';
  /**
   * The offending record's identifier: `open_positions.idempotency_key` for a
   * lot, the flatten's `client_order_id` for a bucket. An IDENTIFIER, never
   * the failure's message and never any column content — `throwContainedFailures`
   * puts it in a message #507 durably records to `audit_log`, and that record
   * must not carry untrusted payload. Same rule, same reason, as
   * `SqliteExecutionStore.getFlattenAttribution`'s own messages, which name
   * this key and withhold the row.
   */
  key: string;
  /** The original throw, preserved whole rather than stringified here. */
  error: unknown;
}

/**
 * Fail-closed AND visible, which is the bar: the poll did not fully succeed
 * and says so, having first done every piece of work it still could.
 *
 * Not swallowed, because silence is the failure mode being fixed. The one
 * production caller is `startFillSync`'s `runOnce` (orchestrator/fill-sync.ts),
 * which logs a rejection at `error` and keeps polling — so a throw here costs
 * no future poll, and is the only channel that reaches an operator at all
 * while #551's alert transport is unbuilt. That sink logs `error.message`
 * ONLY, so every identifier has to be in the message itself; the underlying
 * errors ride in `AggregateError.errors`, and the first also as `cause`, for a
 * debugger holding the object.
 *
 * `AggregateError` rather than a bare `Error` for the reason
 * `AlpacaBrokerAdapter.fetchNewFills` uses one: a pass over independent units
 * can fail in several at once, and picking one to report discards the rest.
 */
function throwContainedFailures(failures: readonly ContainedFailure[]): void {
  if (failures.length === 0) return;
  const named = failures.map((failure) => `${failure.scope} '${failure.key}'`).join(', ');
  throw new AggregateError(
    failures.map((failure) => failure.error),
    `ingestFills: ${failures.length} contained failure(s) — every other lot in this poll was ` +
      `advanced; unresolved: ${named}`,
    { cause: failures[0]?.error },
  );
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
 * on what a flatten fill's leg should read. `getFlattenAttribution` keyed on
 * `client_order_id` is adapter-agnostic where a leg tag is not, which is
 * why this function does not consult `fill.leg` to decide whether a bucket
 * is a flatten's — only afterwards, to force it to `'exit'` on the way out
 * (below), so `advanceLot`'s `isExitFill`/`closedTrade` see one true answer
 * regardless of which adapter reported it.
 *
 * Returns every lot key named by a flatten this call actually processed
 * (#525) — independent of the per-fill split, which can legitimately
 * leave a later-opened lot with ZERO share of a partial fill. That lot gets
 * no entry in `byLot` and so is otherwise invisible to `ingestFills`'
 * per-position loop this poll; the caller uses this set to still run
 * `advanceLot`'s re-arm check for it.
 *
 * Never throws. One flatten's failure is contained to that flatten and
 * appended to `failures` for `ingestFills` to report once the poll is done —
 * see `ContainedFailure`. A bucket that fails is left un-redistributed and so
 * un-attributed, which is the fail-closed answer; it is not left unreported.
 */
async function redistributeFlattenFills(
  input: ExecutionInput,
  byLot: Map<string, NormalizedFill[]>,
  positions: readonly OpenPosition[],
  failures: ContainedFailure[],
): Promise<Set<string>> {
  const positionKeys = new Set(positions.map((position) => position.idempotency_key));
  const flattenTargetedLots = new Set<string>();

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
  // check right below and falls through to the `getFlattenAttribution` lookup
  // instead — see that lookup's own comment for what happens to it from
  // there, and why it is safe.
  for (const clientOrderId of [...byLot.keys()]) {
    if (positionKeys.has(clientOrderId)) continue; // a lot's own bucket — the existing path.

    // #575's containment boundary for one flatten. `getFlattenAttribution`
    // alone throws five ways, and every one of them is a statement about THIS
    // journal row — not about any other bucket, and not about any lot.
    //
    // The contained outcome is deliberately NOT "skip the lots this flatten
    // named": on the two paths where the key parse itself fails, which lots it
    // named is exactly what is unknown. What is skipped is the
    // REDISTRIBUTION. The flatten's raw bucket stays keyed on its own
    // client_order_id, which matches no `position.idempotency_key`, so the
    // per-position loop never reads it and not one share of its fill is
    // attributed to anyone — fail-closed, because a split guessed off a
    // corrupt row mis-assigns quantity on the money path, which is the worse
    // failure. Every lot, including the ones this flatten named, still
    // advances on its OWN fills.
    //
    // The named-lot set is merged only on SUCCESS. A lot key reaching
    // `flattenTargetedLots` from a bucket that then failed would make
    // `advanceLot` re-arm protective legs sized off a fill record this very
    // containment refused to complete — arming the venue for quantity it may
    // already have sold. Left out, that lot is naked and reported; left in, it
    // could be naked AND covered by a leg that sells what it does not hold.
    const targetedByThisFlatten = new Set<string>();
    try {
      await redistributeOneFlatten(input, byLot, clientOrderId, targetedByThisFlatten);
      for (const lotKey of targetedByThisFlatten) flattenTargetedLots.add(lotKey);
    } catch (error) {
      failures.push({ scope: 'flatten-attribution', key: clientOrderId, error });
    }
  }

  return flattenTargetedLots;
}

/**
 * One flatten bucket's redistribution, whole: read the journal row, record the
 * lot(s) it named into `namedLots`, split its raw fill(s) across
 * them in `byLot`, and consume the bucket. Extracted so the caller's loop is
 * one unit of work under one `try` rather than a hundred lines punctuated by
 * section headers.
 *
 * All-or-nothing within the poll: it either completes or leaves `byLot`
 * exactly as it found it (see the `byLot.delete` at the end), which is what
 * makes the caller's containment a clean skip rather than a partial write.
 * `namedLots` is the caller's per-bucket set, discarded on a throw.
 */
async function redistributeOneFlatten(
  input: ExecutionInput,
  byLot: Map<string, NormalizedFill[]>,
  clientOrderId: string,
  /**
   * THIS bucket's named lots, not the caller's accumulator — deliberately a
   * separate set, which the caller merges only once this function returns. A
   * key written straight through to the shared set and then abandoned mid-way
   * makes `advanceLot` re-arm against a fill record this poll never completed;
   * see the caller's comment.
   */
  namedLots: Set<string>,
): Promise<void> {
  const { store } = input;
  const attribution = await store.getFlattenAttribution(clientOrderId);
  // Not a known flatten either (an unrelated/unknown client_order_id, a
  // flatten row written before migration 0020 named no lot, OR — per the
  // snapshot comment in `redistributeFlattenFills` — a lot that opened AFTER
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
  if (attribution === null || attribution.lot_idempotency_keys.length === 0) return;
  const lotKeys = attribution.lot_idempotency_keys;

  // #525: recorded before the split below runs, so a lot that ends up
  // with ZERO share of this raw fill (an earlier-opened sibling absorbed
  // all of it) is still marked as needing the re-arm check — it is just
  // as naked as one that got a partial share, only more so.
  for (const lotKey of lotKeys) namedLots.add(lotKey);

  const rawFills = byLot.get(clientOrderId);
  // Appeases the type checker; every key here has a bucket. Note the
  // ordering above is deliberate and NOT a hazard, though it reads like one
  // (#575 review): `namedLots` is already populated when this returns, and
  // the caller merges it. That is the wanted outcome even here — the flatten
  // named those lots, so they still need `advanceLot`'s re-arm check.
  //
  // It is safe only because this return, unlike a throw, leaves `byLot`
  // exactly as it found it and completes the unit of work. The rule the
  // caller's containment depends on is "a bucket half-consumed must not
  // publish its names", and nothing is half-consumed on this path — the
  // split below has not started. A future edit that moves work above this
  // line breaks that, and would have to move the `namedLots` population
  // below it in the same change.
  if (rawFills === undefined) return;

  // Each named lot's FIXED total share of THIS flatten — what the lot HELD
  // when `executeExit` journalled the flatten, read straight off the
  // write-ahead row (#571).
  //
  // Two properties are needed at once. STABLE: a DIFFERENT split under the
  // SAME `broker_fill_id`-derived id is exactly what breaks `hasFill`'s
  // dedup below (it matches on id alone, so a shrunk second attempt does not
  // "correct" the first — it just vanishes behind it, silently stranding
  // the difference), so the share must recompute identically on every poll,
  // for every named lot, regardless of whether it has since closed. And
  // EXIT-AWARE: the flatten's SIZE is the venue-true held quantity
  // (`filled_size` minus recorded exit fills), so a share that ignores prior
  // exits does not add up to the fill being split.
  //
  // Only a journalled number has both. Held quantity re-derived HERE is
  // exit-aware but not stable — it shrinks as this very flatten's own fills
  // persist. An entry total is stable but not exit-aware, so an older lot
  // with prior exits absorbs quantity belonging to its siblings. Written
  // once, before the broker call, the journalled held quantity is fixed the
  // instant it exists AND is the number the flatten was sized against —
  // `Σ lot_held_quantities === flatten.size`, which is in turn
  // `executeExit`'s exact-equality guard against `order.size`.
  //
  // The store hands these back already paired with their lot's key, having
  // refused any row where the pairing could not be established, so there is
  // nothing to index or re-check here.
  //
  // PRE-0021 ROWS keep the old entry-total split rather than failing: a
  // flatten submitted before that migration recorded no held quantities,
  // and this is the only path that can still reach one (its fill has not
  // been ingested yet). The entry sizes it needs are read as ONE batch, not
  // one `getFills` round-trip per lot — `ingestFills` runs on every tick
  // and a multi-scale-in exit can name many lots — following
  // `DashboardQueryStore.getMarks`' precedent (dashboard/sqlite-query-store.ts):
  // one `WHERE ... IN (...)` query, a `Map` back, a lot with no persisted
  // entry fill simply absent from it rather than present at 0. Either way
  // this reads only what a PRIOR poll already persisted; it has nothing to
  // do with, and does not touch, `advanceLot`'s `fill.timestamp <= now`
  // no-lookahead filter below, which governs THIS poll's fresh fills off
  // the broker feed instead.
  const journalledHeld = attribution.lot_held_quantities;
  const totalShare =
    journalledHeld === null
      ? await entryTotalShares(store, lotKeys)
      : new Map(journalledHeld.map((lot) => [lot.idempotency_key, lot.held]));

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
        // `redistributeFlattenFills`'s docstring.
        leg: 'exit',
        // `fills`' row identity is `(idempotency_key, broker_fill_id)` — the
        // table's PK — so the SAME venue fill id can legitimately hold ONE
        // ROW PER LOT it is split across. That is the right scope here: a
        // multi-lot flatten's raw fill deliberately becomes several
        // accounting rows, one per named lot, so uniqueness has to be judged
        // per (lot, id) pair, not by id alone across every lot — a blanket
        // "this broker_fill_id exists somewhere, so skip it" rule would read
        // lot B's rightful share as a duplicate of lot A's the moment lot
        // A's is persisted.
        //
        // `hasFill` itself takes no idempotency_key argument, though — like
        // `totalShare` above, it compares the id VALUE alone — so the only
        // way to land it in the right per-lot scope is to put the lot INSIDE
        // the id, which is what the suffix below does. Omit it, and
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
    // `leftover > 0` here means the flatten filled more than the named lots
    // HELD when it was submitted (#571 — before that, more than their
    // ENTRIES ever covered, which a lot with prior exits could exceed
    // legitimately). `execute()`'s exact `order.size === heldSize` check
    // (execute.ts's `executeExit`) sizes the flatten to exactly the sum of
    // the shares journalled here, so this is now a genuine venue over-fill,
    // and there is no safe lot to hand the excess to — it is left
    // unattributed rather than guessed onto one, which stays exactly right:
    // a split invented here would mis-assign quantity on the money path.
    //
    // What changed (#527): dropping it used to be SILENT. "Should not
    // happen" is precisely the condition worth a trace — a venue over-fill,
    // a store/venue divergence, or a future change to the `heldSize` guard
    // would otherwise make this quantity vanish from the accounting with
    // nothing to show for it, unnoticed through a 14-day unattended soak
    // (#238). The warning below only reports; it does not change what
    // happens to `leftover` — the excess still drops.
    //
    // A DIFFERENT case from a new lot opening on this instrument mid-poll
    // (see `redistributeFlattenFills`'s `positionKeys` snapshot comment, and
    // the `getFlattenAttribution` one above): that one is a bucket this
    // function never even reaches this far for — it exits at the
    // `getFlattenAttribution` check, deferred safely to the next poll. This
    // one is a genuine surplus against the flatten's OWN named lots, with
    // nowhere safe to go, ever.
    if (leftover > 0) {
      // Swallowed, deliberately — the same posture `alertResidualExposure`
      // takes below, for the same reason: this function's contract (see its
      // doc) is that it either completes in full or leaves `byLot` untouched,
      // and `byLot.delete(clientOrderId)` still has to run right after this
      // loop either way. A channel that rejects must not turn a SUCCESSFUL
      // redistribution into a contained failure — that would defer the whole
      // bucket to next poll over nothing worse than a failed diagnostic, which
      // is strictly worse than the silent drop this exists to fix. Only an
      // identifier and a computed quantity cross this boundary — never the
      // raw fill or the attribution row — so a corrupted `flatten_submissions`
      // row (#524's own test) cannot leak through it either.
      try {
        await input.flattenOverfillAlerts.postFlattenOverfillWarning({
          idempotency_key: clientOrderId,
          unattributed_qty: leftover,
          observed_at: input.clock.now(),
        });
      } catch {
        // Nothing left to do — see the comment above.
      }
    }
  }

  // Consumed LAST, not before the split. The split loop above cannot throw —
  // the split itself is arithmetic over two Maps, and #527's over-fill
  // warning is the loop's only I/O, deliberately wrapped so it cannot escape
  // either (see its own comment) — but the store reads before it can, and a
  // bucket deleted ahead of a throw would take this poll's copy of the raw
  // fill with it. Deleting only once the splits are in `byLot` is what makes
  // this function all-or-nothing. No lot key can collide with
  // `clientOrderId`: a flatten's key is fresh per `executeExit`, so it is
  // never one of the lots it names.
  byLot.delete(clientOrderId);
}

/**
 * The pre-#571 split, kept for flatten rows written before migration 0021
 * recorded held quantities — each lot's persisted ENTRY total, which is stable
 * across polls (an entry's filled quantity is fixed forever once filling
 * stops) but blind to exits already recorded against the lot. That blindness
 * IS #571; see `redistributeFlattenFills` for what it costs. Reachable only
 * for a flatten submitted before this code shipped whose fill has not been
 * ingested yet, so it is a wind-down path, not a supported mode — delete it,
 * and the branch that selects it, once no `flatten_submissions` row has a
 * NULL `lot_held_quantities`.
 *
 * A lot with no persisted entry fill is absent from `getEntryFillSizes`' Map
 * rather than present at 0 (its documented shape), which reads here as a
 * zero share — the same answer, made explicit.
 */
async function entryTotalShares(
  store: ExecutionInput['store'],
  lotKeys: readonly string[],
): Promise<Map<string, number>> {
  const entrySizes = await store.getEntryFillSizes(lotKeys);
  return new Map(lotKeys.map((lotKey) => [lotKey, entrySizes.get(lotKey) ?? 0]));
}

/**
 * `fills` is this lot's bucket already — keyed on `client_order_id` by the
 * caller. `flattenTargetedThisPoll` (#525) is true when a flatten named
 * this lot and resolved this poll, independent of whether `fills` itself is
 * non-empty — see `redistributeFlattenFills`'s doc for why a lot can be
 * named with zero share.
 */
async function advanceLot(
  input: ExecutionInput,
  position: OpenPosition,
  fills: readonly NormalizedFill[],
  now: Date,
  flattenTargetedThisPoll: boolean,
): Promise<void> {
  const { broker, store } = input;

  // No lookahead: in a backtest the feed is the whole simulated future, and a
  // fill dated past T has not happened yet. This stays HERE rather than moving
  // into the caller's bucketing pass — it is per-call semantics against this
  // call's `now`, not a grouping key.
  const lotFills = fills.filter((fill) => fill.timestamp.getTime() <= now.getTime());

  const newFills: Fill[] = [];
  let ingestedEntry = false;
  let ingestedExit = false;
  for (const fill of lotFills) {
    if (await store.hasFill(fill.broker_fill_id)) continue;
    newFills.push(toFill(fill, position.idempotency_key));
    ingestedEntry ||= fill.leg === 'entry';
    ingestedExit ||= fill.leg === 'exit';
  }

  if (newFills.length === 0) {
    // #525: normally "the lot is exactly as the last poll left it" — but a
    // flatten can name this lot and resolve this poll while handing it ZERO
    // share (an earlier-opened sibling absorbed the whole partial fill), in
    // which case there is no new fill here at all yet the lot's legs were
    // still cancelled by the SAME `executeExit` call that cancelled every
    // held lot's legs before submitting the flatten. Nothing else in this
    // function runs for a lot with no new fill, so the re-arm check has to
    // happen here, off the fuller persisted record rather than this poll's
    // (empty) one.
    if (flattenTargetedThisPoll) {
      await maybeRearmResidual(input, position, now);
    }
    return;
  }

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

  // #525: a partial flatten's own exit fill lands here as `ingestedExit`;
  // `flattenTargetedThisPoll` covers the zero-share sibling case the block
  // above already documents. `executeExit` cancels every held lot's legs
  // BEFORE the flatten, so "not flat" after either signal means genuinely
  // naked, never merely under-sized — that's `resizeProtectiveLegs`'
  // case, handled above.
  if (!flat && (ingestedExit || flattenTargetedThisPoll)) {
    await maybeRearmResidual(input, position, now, { filledSize, exitQty: totalQty(exitFills) });
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
 * Re-arms a residual left by a partial flatten (#525's recorded decision —
 * option 1), or posts the fallback alert when the re-arm itself fails or
 * cannot be attempted safely. Never throws: every failure this function can
 * observe — the store read on the `known === undefined` path, the broker
 * call rejecting, the alert channel itself failing — is swallowed here, the
 * same posture `safeLog()` takes in orchestrator/tick-loop.ts, so a flaky
 * store, a flaky re-arm, or a flaky alert transport can never escape into
 * `advanceLot` and abort `ingestFills`' per-lot loop for every OTHER lot the
 * same poll has yet to reach.
 *
 * `known` lets the caller in `advanceLot`'s main path hand over
 * `filledSize`/`exitQty` it already computed off the SAME persisted record,
 * rather than re-reading the store; the zero-new-fill branch above has no
 * such record in hand and reads it fresh here instead.
 */
async function maybeRearmResidual(
  input: ExecutionInput,
  position: OpenPosition,
  now: Date,
  known?: { filledSize: number; exitQty: number },
): Promise<void> {
  const { broker, store } = input;

  let filledSize: number;
  let exitQty: number;
  if (known === undefined) {
    let recorded: Fill[];
    try {
      recorded = await store.getFills(position.idempotency_key);
    } catch {
      // The exact residual is unknowable without the read that just
      // failed — alerting with `requested_size` (the lot's own, always
      // in hand, untouched by this failure) rather than a smaller,
      // possibly-wrong guess: it can only OVER-state what is genuinely at
      // risk, never under-state it, which is the conservative direction
      // for an operator deciding whether to go check the venue by hand.
      // NOT `Number.NaN` — `LoggingResidualExposureAlertChannel` writes
      // this alert through `JSON.stringify` (logger.ts), which silently
      // turns `NaN` into `null`, and a `null` quantity is less legible
      // than an honest upper bound. Never rethrown: see this function's
      // "Never throws" doc above.
      //
      // Flagged as an upper bound rather than passed off as the exact
      // residual (#569 review): without the flag a persistent store outage
      // reads as a stream of confident alerts, and an operator cannot tell
      // an estimate from a measurement. The caught error itself is not
      // forwarded — see `ResidualExposureAlert`'s CREDENTIALS note.
      await alertResidualExposure(input, position, position.requested_size, now, true);
      return;
    }
    filledSize = totalQty(recorded.filter((fill) => fill.leg === 'entry'));
    exitQty = totalQty(recorded.filter(isExitFill));
  } else {
    ({ filledSize, exitQty } = known);
  }

  // No entry fill on record yet: there is nothing open to protect. Cannot
  // happen on the `known` path (the caller already refused to reach here
  // with `filledSize === 0`), but the zero-new-fill path above has no such
  // guarantee — a flatten can, in principle, name a lot whose entry fill is
  // still outstanding.
  if (filledSize === 0) return;
  // Flat by this fuller read even though the per-poll signal said
  // "not flat": nothing left to protect.
  if (coversQty(exitQty, filledSize)) return;

  const residual = filledSize - exitQty;

  // Fail-closed (`executeExit`'s precedent, execute.ts): a non-finite or
  // non-positive residual while `coversQty` above says "not flat" means the
  // store's own numbers disagree in a way `QTY_EPSILON_RELATIVE` was not
  // built to absorb. Refusing to hand the broker a garbage quantity and
  // alerting instead is the same posture `executeExit` takes on a
  // store/venue size mismatch — surface it, never guess.
  if (!(residual > 0) || !Number.isFinite(residual)) {
    await alertResidualExposure(input, position, residual, now);
    return;
  }

  try {
    await broker.rearmProtectiveLegs(
      position.idempotency_key,
      position.instrument,
      position.side,
      residual,
      position.stop,
      position.target,
    );
  } catch {
    // The broker's own error is not forwarded to the alert — see
    // `ResidualExposureAlert`'s CREDENTIALS note: this channel carries only
    // fields chosen here, never broker error text. Losing the detail is
    // fine; an operator reads the alert and checks the venue directly.
    await alertResidualExposure(input, position, residual, now);
  }
}

/**
 * The #525 fallback, posted when a re-arm failed or could not be safely
 * attempted. Fire-and-forget and fully swallowed on failure — the alert IS
 * the fallback, so there is nothing left to fall back to if delivering it
 * also fails; the caller (`maybeRearmResidual`) must keep running either
 * way, mirroring `safeLog()`'s reasoning in orchestrator/tick-loop.ts.
 */
async function alertResidualExposure(
  input: ExecutionInput,
  position: OpenPosition,
  residualQty: number,
  now: Date,
  /**
   * `true` only on the path where the fill read failed and `residualQty` is
   * therefore the lot's whole requested size rather than the exact residual
   * (#569 review). Defaulted so the two exact call sites read unchanged.
   */
  residualQtyIsUpperBound = false,
): Promise<void> {
  try {
    await input.residualExposureAlerts.postResidualExposureAlert({
      idempotency_key: position.idempotency_key,
      instrument: position.instrument,
      side: position.side,
      residual_qty: residualQty,
      residual_qty_is_upper_bound: residualQtyIsUpperBound,
      stop: position.stop,
      target: position.target,
      observed_at: now,
    });
  } catch {
    // Nothing left to do — see this function's doc comment.
  }
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
