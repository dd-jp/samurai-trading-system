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
 * flatten-closed lot at all — splitting it by the per-lot HELD quantities the
 * same journal row recorded (#571).
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
 * #549: both re-arm triggers above are POLL-SCOPED, so this module now also
 * journals a durable marker (`open_positions.residual_unprotected_since`,
 * migration 0024) the moment a residual is first known — at flatten
 * redistribution and again ahead of the re-arm attempt — cleared only when
 * protection is CONFIRMED. `sweepResidualProtection`
 * (residual-protection-sweep.ts) reads it back on reconcile/fill-sync
 * cadence, which is what retries a re-arm a crash (or a survived failure)
 * left unconfirmed; the #525 no-retry-loop decision stands unchanged on the
 * poll path itself.
 *
 * Every loop below runs under a containment boundary — see `ContainedFailure`.
 * A failure inside one flatten bucket, one lot, or one flatten's post-advance
 * sweep-mark decides that unit only; the whole set is reported once, after
 * every other unit of work has landed — except a `flatten-sweep-mark`
 * failure on its own, which resolves the poll rather than rejecting it (see
 * `throwContainedFailures`'s own doc).
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
import type { FillIngestInput, NonSterlingFeeAlert, NormalizedFill } from './types.js';

/**
 * #1087: a lot `reconcile()` adopted as `filled`/`partially_filled` from
 * broker truth but whose `filled_size` is still zero — an invariant
 * violation nothing else in this poll reports, since `advanceLot` has
 * nothing new to advance and would otherwise return in total silence.
 */
export const FILLED_WITH_ZERO_SIZE = 'filled position has zero filled_size' as const;

/**
 * #1383: the matching clear-side transition line for `FILLED_WITH_ZERO_SIZE`
 * — a distinct message/event, not a reuse of the warn one, so a listener
 * (`FilledZeroSizeWarningRecorder`-style filter on the warn message) does not
 * pick up the all-clear as another occurrence of the condition.
 */
export const FILLED_ZERO_SIZE_CLEARED =
  'a lot previously warned zero-filled-size has advanced past zero' as const;

/**
 * #1220. A fill fee denominated in something other than the book currency.
 *
 * **Alerted, not refused, and the choice is deliberate.** The venue has
 * already traded by the time `fetchNewFills` reports this; refusing to
 * persist the fill would strand a real open position outside the append-only
 * fill log (CONTEXT.md invariant 4) — a silent halt with money exposed,
 * which is strictly worse than a booked fee whose currency is recorded and
 * shouted about. The row is written with `fee_currency` verbatim
 * (migration 0054) and this is raised at `error`.
 *
 * **Paged, not just logged (#1465).** `warnOnNonSterlingFee` posts to
 * `ExecutionInput.nonSterlingFeeAlerts` beside this `safeLog` line — #1220
 * left this recorded-but-not-paged (the only sink was `ExecutionInput.logger`,
 * a rotating file nobody escalates); #1465 closes that gap the way every
 * other `error`-level entry in this file already does, beside an
 * `AlertChannelSlots` post (`ResidualExposureAlert`) or a report of one
 * failing.
 *
 * It is a CONTRADICTION rather than an FX conversion to model because
 * `tradeableUniverse` (universe-pool) excludes every non-sterling line: a
 * foreign fee means an instrument was traded that selection should have
 * refused, so converting it would paper over the real defect one layer up.
 */
export const FEE_CURRENCY_NOT_BOOK_CURRENCY =
  'broker reported a fill fee in a currency that is not the book currency' as const;

export async function ingestFills(input: FillIngestInput): Promise<void> {
  const { clock, broker, store } = input;

  const positions = await store.getOpenPositions();
  if (positions.length === 0) return;

  // The feed's floor is the oldest live lot: no fill of ours predates the
  // `execute()` that opened the lot it belongs to. Re-offered fills are
  // expected and handled by the dedup below, so this only bounds the query.
  //
  // Keep this GLOBAL, keyed on `opened_at` alone — never raise it per lot to
  // `max(opened_at, last_ingested_fill_ts)` (#838): a lot is not one ordered
  // stream (every leg shares the lot's `idempotency_key`, so
  // `last_ingested_fill_ts` is a max over entry/stop/target/exit fills that
  // nothing orders against each other), so a per-lot floor can raise itself
  // past an earlier fill still in flight and silently under-fetch it —
  // `collectFill`'s strict `filledAt < since` guard drops it inside the
  // adapter, with no recovery path (`hasFill` dedup only guards against
  // OVER-fetching). `BrokerAdapter.fetchNewFills` deliberately does NOT
  // promise per-lot timestamp monotonicity, and cannot — see its doc in
  // types/broker.ts. This floor is correct only while every adapter upholds
  // "no fill dated earlier than the `opened_at` of the lot it belongs to" —
  // verify that before trusting this comment for a new adapter (#1087:
  // `SimulatedBrokerAdapter` violated it once; fixed at the source
  // (simulated-adapter.ts), not here). Widening this floor to re-verify it
  // is not diagnosable through `yarn smoke`'s gate (#1125): the excluded
  // scripted fill surfaces as a per-lot-aggregated contained failure with no
  // `GATE:` line and no naming of what broke about this floor specifically.
  const since = earliest(positions.map((position) => position.opened_at));
  const fills = await broker.fetchNewFills(since);

  // #842: read the clock AFTER the sweep, not before. `fetchNewFills` dates a
  // fill the venue left undated at ITS OWN read of the same clock, taken part
  // way through a paced, multi-request sweep — so a `now` sampled before that
  // sweep is strictly EARLIER under a real clock, and `advanceLot`'s
  // `timestamp <= now` no-lookahead filter would drop every undated fill on
  // every poll, forever. Reading here makes `now` the later of the two by
  // construction. Under the backtest clock (stepped by the harness, never by
  // this call) both reads return the same instant, so simulated time is
  // unchanged.
  const now = clock.now();

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
  const flattenNamedLots = await redistributeFlattenFills(input, byLot, positions, failures);
  // The flat union `advanceLot`'s per-lot re-arm check reads (#525) — a lot
  // named by ANY flatten this poll, independent of which one.
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

  // #519/#526: mark each flatten whose EVERY named lot durably advanced this
  // poll (or had nothing new to advance) as swept — see
  // `SharedStore.markFlattenFillsSwept`'s doc for why this is gated on the
  // lot-advance outcome rather than fired unconditionally once redistribution
  // succeeds, and migration 0023 for what this bounds.
  const failedLotKeys = new Set(
    failures.filter((failure) => failure.scope === 'lot-advance').map((failure) => failure.key),
  );
  for (const [flattenKey, lotKeys] of flattenNamedLots) {
    if ([...lotKeys].some((lotKey) => failedLotKeys.has(lotKey))) continue;
    try {
      await input.store.markFlattenFillsSwept(flattenKey, now);
    } catch (error) {
      // NOT correctness-critical the way a 'flatten-attribution'/'lot-advance'
      // failure is (#519/#526): a missed mark only means the
      // row stays exactly where it already was — unswept, and so still found
      // by `getUnresolvedFlattens()` — which is `reconcile()`'s own designed
      // recovery for it, not data this poll lost. `throwContainedFailures`
      // below is gated accordingly: this scope alone does not reject the
      // poll's promise. It still travels in `failures`, so it is NAMED in the
      // AggregateError whenever a genuinely correctness-critical failure ALSO
      // happened this same poll — nothing here hides it from that report.
      // Only a mark failure entirely on its own resolves without REJECTING the
      // poll's promise (#519/#526's gate below) — but not SILENTLY (#573):
      // this module carries a `Logger` (`ExecutionInput.logger`), so the row
      // staying unswept gets a local trace even when nothing else this poll
      // failed to name it in an AggregateError. `warn`, not `error`: the
      // self-healing next-reconcile() recovery this comment already
      // describes is exactly why this is not an operator escalation.
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

  // Last, once no unit of work is left to lose: reporting must not cost
  // progress, and progress must not buy silence. Scoped to the
  // correctness-critical failures only (#519/#526) — see the
  // 'flatten-sweep-mark' catch above for why that scope alone must not
  // reject this poll's promise.
  if (failures.some((failure) => failure.scope !== 'flatten-sweep-mark')) {
    throwContainedFailures(failures);
  }
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
 * re-throw reopens exactly the hole it closes — the property `shared/safe-log.ts`'s
 * `safeLog()` and `alertResidualExposure` below are built around. So the
 * `catch` blocks push and do nothing else: no formatting, no inspection of
 * the caught error, no I/O.
 */
interface ContainedFailure {
  /**
   * Which boundary caught it — a flatten bucket's redistribution, one lot's
   * advance, or (#519/#526) the best-effort `markFlattenFillsSwept` write
   * that bounds `reconcile()`'s rescan. The third is NOT correctness-critical
   * the way the first two are (see its call site): `ingestFills`'s own call
   * to `throwContainedFailures` is gated to skip it when it is the ONLY
   * scope present, so a mark failure alone resolves the poll rather than
   * rejecting it (#603). It still rides in this list, and so is still named,
   * whenever a correctness-critical failure ALSO occurs the same poll.
   */
  scope: 'flatten-attribution' | 'lot-advance' | 'flatten-sweep-mark';
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
  /**
   * #1087: the lot's instrument, when the scope has one cheaply to hand
   * (`lot-advance` always does — it is a field on the `OpenPosition` already
   * in scope). `null` for a flatten-keyed scope, where recovering it would
   * mean reading the flatten journal row on the failure path itself. Safe to
   * name unconditionally: instrument tickers are a small, controlled
   * vocabulary, not the untrusted payload `key`'s own doc above guards
   * against.
   */
  instrument: string | null;
  /** The original throw, preserved whole rather than stringified here. */
  error: unknown;
}

/**
 * Fail-closed AND visible, which is the bar: the poll did not fully succeed
 * and says so, having first done every piece of work it still could.
 *
 * The caller (`ingestFills`) only reaches this when `failures` names at
 * least one correctness-critical scope — a 'flatten-sweep-mark'-only
 * `failures` array never gets here at all (#519/#526): that scope's
 * own recovery (the row stays unswept and rescannable) does not need a
 * rejected promise to work, and treating it as fatal here would make a poll
 * that fully succeeded at every money-relevant thing report itself failed.
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
 *
 * #1087: `instrument` and a `reason` ride in the message alongside `scope`
 * and `key` now (#1049 found this the smoke gate's blind spot; this is the
 * same blind spot in a live run's own log). `reason` is the thrown value's
 * CLASS NAME, never `error.message` — this function still may not inspect or
 * format the error's own content (`ContainedFailure.key`'s doc above), and a
 * store failure reaching here has not been curated the way `reconcile.ts`'s
 * #297-sanitized `BrokerError` has. A debugger holding the object still has
 * `error.message` via `AggregateError.errors`/`cause`.
 */
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
 * regardless of which adapter reported it. WHY this flatten closed the
 * position — a flat-by-close, an early release, or a direction flip — is a
 * SEPARATE question from what `leg` answers, and travels on `exit_reason`
 * instead (#793): journalled at write-ahead, read back from
 * `getFlattenAttribution` here, and carried onto the split fill for
 * `closedTrade()` to read as `close_reason`.
 *
 * Returns, PER FLATTEN, every lot key it named and this call actually
 * processed (#525) — independent of the per-fill split, which can
 * legitimately leave a later-opened lot with ZERO share of a partial fill.
 * That lot gets no entry in `byLot` and so is otherwise invisible to
 * `ingestFills`' per-position loop this poll; the caller uses the flat union
 * of every flatten's set to still run `advanceLot`'s re-arm check for it.
 *
 * Keyed by the flatten's OWN `client_order_id` rather than flattened into one
 * set (#519/#526): the caller also uses this to decide, per flatten, whether
 * `SharedStore.markFlattenFillsSwept` may run — which requires knowing which
 * lots THAT flatten named, not the union across every flatten this poll.
 *
 * Never throws. One flatten's failure is contained to that flatten and
 * appended to `failures` for `ingestFills` to report once the poll is done —
 * see `ContainedFailure`. A bucket that fails is left un-redistributed and so
 * un-attributed, which is the fail-closed answer; it is not left unreported,
 * and (per the caller) it is absent from the returned map, so it is never a
 * `markFlattenFillsSwept` candidate either.
 */
async function redistributeFlattenFills(
  input: FillIngestInput,
  byLot: Map<string, NormalizedFill[]>,
  positions: readonly OpenPosition[],
  failures: ContainedFailure[],
): Promise<Map<string, Set<string>>> {
  const positionKeys = new Set(positions.map((position) => position.idempotency_key));
  const flattenNamedLots = new Map<string, Set<string>>();

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
    // The named-lot set is recorded only on SUCCESS. A lot key reaching
    // `flattenNamedLots` from a bucket that then failed would make
    // `advanceLot` re-arm protective legs sized off a fill record this very
    // containment refused to complete — arming the venue for quantity it may
    // already have sold. Left out, that lot is naked and reported; left in, it
    // could be naked AND covered by a leg that sells what it does not hold.
    // The same omission is also what keeps a failed flatten out of the
    // caller's `markFlattenFillsSwept` candidates (#519/#526) — see this
    // function's own doc.
    const targetedByThisFlatten = new Set<string>();
    try {
      await redistributeOneFlatten(input, byLot, clientOrderId, targetedByThisFlatten);
      // EMPTY, not merely absent-from-the-map, is `redistributeOneFlatten`'s
      // ordinary return for a `clientOrderId` that is not a real flatten at
      // all — `getFlattenAttribution` returning `null` (its own doc: "not a
      // known flatten either"). That is NOT a rare edge case here: `brackets`
      // is never pruned (alpaca-adapter.ts), so a CLOSED lot's own bracket
      // keeps being re-polled every future sweep, and once that lot leaves
      // `positions` this loop's `positionKeys.has` gate no longer recognises
      // its (duplicate, already-`hasFill`-deduped) fill as "a lot's own
      // bucket" — it falls through to this exact lookup instead. Recording
      // an EMPTY entry for it would hand the caller's `markFlattenFillsSwept`
      // a `clientOrderId` that names no `flatten_submissions` row at all,
      // which throws. Only a NON-EMPTY result is a real flatten.
      if (targetedByThisFlatten.size > 0) {
        flattenNamedLots.set(clientOrderId, targetedByThisFlatten);
      }
    } catch (error) {
      failures.push({ scope: 'flatten-attribution', key: clientOrderId, instrument: null, error });
    }
  }

  return flattenNamedLots;
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
  input: FillIngestInput,
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
  // (#575): `namedLots` is already populated when this returns, and
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
  // dedup below (it matches on the full `(idempotency_key, broker_fill_id)`
  // pair, #1320, but this lot's `idempotency_key` half is fixed across
  // polls, so a shrunk second attempt under the SAME derived id does not
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

  const split = splitFlattenFills({ clientOrderId, rawFills, lotKeys, totalShare, attribution });
  for (const [lotKey, splitFills] of split.splits) {
    const bucket = byLot.get(lotKey);
    if (bucket === undefined) byLot.set(lotKey, [...splitFills]);
    else bucket.push(...splitFills);
  }
  for (const { attributed, leftover } of split.outcomes) {
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
    // Dropping it is not silent (#527): "Should not happen" is precisely the
    // condition worth a trace — a venue over-fill,
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
      // #527: only warn the FIRST time this exact rawFill's over-fill
      // is observed. `leftover` is pure arithmetic recomputed from the raw
      // fill's own qty against the (stable, deterministic) journalled
      // shares, so a RE-OFFERED fill — this module's own dedup-on-`hasFill`
      // contract says re-offering is expected — would otherwise recompute
      // the SAME `leftover` and re-fire the SAME warning every poll for as
      // long as the venue keeps returning it. Alpaca's own flatten sweep
      // happens to prune an order after one poll (adapters/alpaca-adapter.ts),
      // but this function has no adapter-specific knowledge and must not
      // assume every `BrokerAdapter` does the same — the Simulated adapter's
      // `fetchNewFills` re-offers everything past `since` forever, which is
      // exactly the shape a backtest run drives this through.
      // Un-deduped, that floods the very trace #527 exists to create — the
      // "line repeated daily is a line nobody reads" failure #342 already
      // named for a different channel.
      //
      // `attributed` are this rawFill's OWN derived ids
      // (deterministic per (rawFill, lotKey) — see `splitFill` in
      // flatten-attribution.ts): if any
      // is already in `fills`, this exact rawFill's split already ran to
      // completion — and so was already warned about — in an earlier poll.
      // Empty only when EVERY named lot was already fully satisfied before
      // this rawFill was reached (a LATER rawFill in a multi-fill list
      // contributing pure surplus with nothing to check against) — that
      // narrow case still warns every poll; named, not solved, here.
      let alreadyWarned = false;
      try {
        for (const { idempotency_key, broker_fill_id } of attributed) {
          if (await store.hasFill({ idempotency_key, broker_fill_id })) {
            alreadyWarned = true;
            break;
          }
        }
      } catch {
        // Can't tell — default to warning rather than suppressing. A
        // duplicate warn costs a grep; a wrongly-suppressed one costs the
        // trace this ticket exists to create — the same asymmetry
        // `maybeRearmResidual`'s upper-bound reasoning (#569) already
        // takes elsewhere in this file. And deliberately UNLOGGED (#573): the
        // `postFlattenOverfillWarning` call this `hasFill` check gates is
        // itself the trace — defaulting to warning guarantees it still fires,
        // so a `logCaughtFailure` call here would only ever be a duplicate of
        // that one, on a path that already runs once per raw fill.
        alreadyWarned = false;
      }

      if (!alreadyWarned) {
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
            trace_id: input.trace_id,
            idempotency_key: clientOrderId,
            unattributed_qty: leftover,
            observed_at: input.clock.now(),
          });
        } catch {
          // The redistribution itself is unaffected — see the comment above
          // for why this stays swallowed rather than contained. #573: now
          // traced locally with a FIXED, self-authored message rather than
          // the channel's own error — `alpaca-adapter.ts`'s
          // `escalateAgedUnpricedFills` sets the precedent this follows: a
          // Telegram transport failure quotes the request it failed
          // on, and that URL can carry a bot token, so the channel's error is
          // read and discarded, never logged.
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

  // #549: the durable "residual observed, protection not confirmed" marker,
  // written the moment the residual is FIRST knowable — this split's own
  // arithmetic: any named lot whose journalled share was not fully consumed
  // by this flatten's fill(s) still holds quantity whose protective legs
  // `executeExit` already cancelled. Written HERE, before any
  // `applyLotAdvance` this poll runs, because this is the last durable
  // foothold ahead of the exact crash window #549 names: a crash after a
  // SIBLING lot's advance persists (which dedups the re-offered fill away)
  // but before THIS lot's re-arm attempt would leave `flattenTargetedThisPoll`
  // false on every future poll, and nothing else would ever look at this lot
  // again. `advanceLot`'s `maybeRearmResidual` clears it the same poll on a
  // confirmed re-arm (or a flat read); a lot that instead round-trips to
  // `closed` leaves the column set on a TERMINAL row, which
  // `getUnprotectedResidualLots()` excludes by state — settled, not swept.
  //
  // Best-effort, never throwing, for the same reason as the over-fill warning
  // above: this function's contract is complete-in-full-or-leave-`byLot`-
  // untouched, and the splits are already pushed — a store flake here must
  // not turn a successful redistribution into a contained failure. A failed
  // write only narrows #549's crash coverage back to the old poll-scoped
  // window, and says so in the log.
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

  // Consumed LAST, not before the split. The split loop above cannot throw —
  // the split itself is arithmetic over two Maps, and #527's over-fill
  // warning (plus its `hasFill` dedup check, #527) is the loop's only
  // I/O, deliberately wrapped so neither can escape (see their own comments)
  // — but the store reads before it can, and a
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
  store: FillIngestInput['store'],
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
  // call's `now`, not a grouping key.
  const lotFills = fills.filter((fill) => fill.timestamp.getTime() <= now.getTime());

  const newFills: Fill[] = [];
  /**
   * #842: fills the dedup gate rejected that may STILL owe this lot quantity.
   * A `qty_is_cumulative` feed (Alpaca — see `NormalizedFill`'s field doc)
   * re-uses one id, the ORDER id, for every observation of a running
   * `filled_qty`, so "we already have this id" does NOT mean "we already have
   * this quantity". Collected here and reconciled below rather than inline so
   * the reconciliation needs ONE store read for the whole call, however many
   * fills the feed re-offered.
   */
  const cumulativeReoffers: NormalizedFill[] = [];
  // #1001/#1301: read once per call, reused by every `toFill`/`cumulativeTopUp`
  // call below rather than re-derived per fill — it is a pure function of
  // `position`, which does not change within this call.
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
    // Inside the loop, BELOW the dedup gate on purpose: `fetchNewFills` is
    // inclusive of `since`, so every adapter re-offers the same fill
    // forever, and a check above the gate would re-announce this
    // contradiction on every poll for the life of the lot.
    await warnOnNonSterlingFee(input, position, fill);
    ingestedEntry ||= fill.leg === 'entry';
    ingestedExit ||= fill.leg === 'exit';
  }

  /**
   * The lot's persisted record, read AT MOST ONCE per call and reused by
   * `recorded` below rather than read twice.
   *
   * The honest cost, stated rather than buried: on Alpaca every open lot's
   * entry order is re-offered on EVERY poll (that is what a cumulative feed
   * is), so this read now happens once per open lot per poll where before it
   * happened only when a fill was genuinely new. That is one indexed local
   * SQLite SELECT per lot on a 15-second cadence against a book of single-
   * digit concurrent lots — bounded and local, and the alternative (deciding
   * "is there an increment?" without looking at what is persisted) is exactly
   * the guess this ticket exists to remove. Feeds that do not set the flag
   * (Simulated, every backtest) keep the old shape untouched: no
   * `cumulativeReoffers`, no read.
   */
  let persisted: Fill[] | null = null;
  if (cumulativeReoffers.length > 0) {
    persisted = await store.getFills(position.idempotency_key);
    for (const fill of cumulativeReoffers) {
      // Against `persisted` PLUS this poll's own new rows: a top-up already
      // computed for the same order id in this same loop must count against
      // the next one, or two re-offers in one pass would each claim the full
      // increment.
      const topUp = await cumulativeTopUp(input, position, fill, [...persisted, ...newFills]);
      if (topUp === null) continue;
      newFills.push(topUp);
      // THE POINT OF THE TICKET. `resizeProtectiveLegs` below fires on
      // `ingestedEntry`, and it sets an ABSOLUTE quantity — book the
      // increment without setting this and `filled_size` is repaired in the
      // store while the venue's stop/target stay armed for the stale, smaller
      // figure, leaving the increment naked. That is the whole defect, moved
      // one layer down rather than fixed.
      ingestedEntry ||= topUp.leg === 'entry';
      ingestedExit ||= topUp.leg === 'exit';
    }
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

    // #1087: `reconcile()` runs immediately before this call, same poll (see
    // `fill-sync.ts`'s `runPoll`), and adopts the broker's `order_state`
    // without touching `filled_size` (`reconcile.ts`'s own doc) — so a lot
    // reconcile just adopted as `filled`/`partially_filled` but whose fill
    // was never ingested lands HERE, with nothing new to advance, and would
    // otherwise return in total silence.
    //
    // This is a WARNING, not necessarily a defect: on the live arm, Alpaca
    // can report `filled_qty > 0` on the order a poll or two before its
    // separate fill feed catches up, so a lot can legitimately pass through
    // this branch once or twice and self-clear on the next poll once
    // `ingestFills` sees the fill. `stuck_ms` (from `opened_at`, no new
    // tracked state needed — a lot in this state can only have been wedged
    // since close to when it opened) is what tells the two apart: a poll or
    // two of propagation lag looks nothing like the hours-long, monotonically
    // growing `stuck_ms` of a genuinely wedged lot (#1087's META case, caused
    // at the source — see `simulated-adapter.ts` — by a fill excluded forever
    // from every subsequent poll's `since` floor).
    //
    // Throttled (`filledZeroSizeThrottle`, filled-zero-size-throttle.ts):
    // unthrottled, a lot wedged for hours logs an identical line on every
    // 15-second poll. `consecutive` rides in the payload alongside `stuck_ms`
    // so an ANNOUNCED line still carries how long the condition has held —
    // both the one-time `warn` and every later low-cadence `info`
    // re-announcement while the lot stays wedged.
    if (
      (position.order_state === 'filled' || position.order_state === 'partially_filled') &&
      position.filled_size === 0
    ) {
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
    return;
  }

  // Recomputed from the full fill record (persisted rows + this poll's new
  // ones, in the order the atomic write below will persist them), never from
  // a running total — rebuilding from the record is what makes a re-poll
  // converge on the same numbers instead of drifting.
  const recorded = [
    ...(persisted ?? (await store.getFills(position.idempotency_key))),
    ...newFills,
  ];
  const entryFills = recorded.filter((fill) => fill.leg === 'entry');
  const exitFills = recorded.filter(isExitFill);

  const filledSize = totalQty(entryFills);
  // An exit fill cannot precede the entry fill that created the lot to exit.
  // If one somehow arrives first, there is no lot to size or close yet —
  // persist the fill rows alone. Deliberately NOT `clear()`ed here: `filled_size`
  // is still 0 after this recompute (e.g. a non-entry fill landed on an
  // already-wedged lot), so the streak the throttle above was counting for
  // it hasn't actually ended — clearing here would restart it at
  // `consecutive: 1` on the very next poll (and re-arm a `warn` that should
  // have stayed a quiet `info`-cadence wedge) instead of continuing the
  // warn-once/low-cadence-info episode (#1087; #1383).
  if (filledSize === 0) {
    await store.applyLotAdvance({ idempotency_key: position.idempotency_key, fills: newFills });
    return;
  }

  // The lot advanced past zero — any zero-size-wedge streak this throttle
  // was counting for it is genuinely over now, confirmed by `filledSize > 0`
  // above (not merely by `newFills.length > 0`, which a non-entry fill on a
  // still-wedged lot would also satisfy). Clears an entry that never warned
  // (never reached the alert threshold) as readily as one that did — only
  // the former case logs below, since an episode that never paged has
  // nothing to report as cleared (mirrors `reportAdvisoryWarnings`'s
  // `hadWarnings` gate in tick-runner.ts).
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
    await maybeRearmResidual(input, position, now, { filledSize, exitQty });
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
 * #842. One observation of a CUMULATIVE feed (Alpaca's `getOrder`: a running
 * `filled_qty` under a fixed order id — see `NormalizedFill.qty_is_cumulative`)
 * whose id `hasFill` has already seen, turned into the INCREMENT it still owes
 * this lot — or `null` when it owes nothing. The arithmetic (and why it is an
 * extra row rather than an amendment) lives in `cumulativeIncrement`; this
 * wrapper owns the I/O around it.
 *
 * The top-up's id embeds the cumulative quantity it settles, which makes it
 * DETERMINISTIC and STABLE across polls — the same property
 * `redistributeFlattenFills` needs of its own suffixed ids. A re-poll at the
 * same cumulative recomputes the same id, finds it among `booked`, computes a
 * zero delta, and returns `null`. Idempotent by arithmetic, not by luck.
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
    // Logged because a non-positive derived price means the venue's own
    // cumulative average and the tranche history disagree, which is worth an
    // operator's attention even though it does not stop the ingest.
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

  // #1465: reached only past `cumulativeIncrement`'s `null` returns, so only
  // when this call is about to book a genuinely new increment — a re-poll at
  // the same cumulative pages nothing twice, the same property `advanceLot`'s
  // own call (below the dedup gate) relies on for its half of `toFill`'s two
  // call sites.
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
    // #1001: same fallbacks `advanceLot`'s own `toFill` call uses. Both of a
    // lot's estimates are passed rather than the entry's alone because the
    // parameter is the pair, not because this path reaches the protective one:
    // `qty_is_cumulative` is Alpaca-only and Alpaca reports it on the entry
    // leg, so the protective member is unexercised here.
    modelledLotCostsFor(position),
  );
}

/**
 * Normalized broker shape → the stored record, keyed to its lot.
 *
 * Enumerates its fields rather than spreading, which is what keeps
 * `qty_is_cumulative` (#842) OUT of the persisted row — deliberately, not by
 * omission: a stored `Fill` is always an increment by the time it is written
 * (`cumulativeTopUp` has already taken the difference), so a row carrying a
 * "this is a running total" flag would be a lie that every later rebuild of
 * `filled_size` would have to re-litigate.
 *
 * `modelledLotCosts` (#1001, #1301) is the FALLBACK for a real-broker fill,
 * which arrives with `fill.cost_breakdown === undefined` — the venue reports
 * no breakdown of its own. `modelledLegCostFor` picks which of the lot's two
 * submit-time estimates this fill's leg is charged from (`'entry'` from the
 * entry's, `'stop'`/`'target'` from the protective exit's, `'exit'` from
 * neither — a flatten carries the flatten submission's own), and it is
 * prorated by this fill's share of `requestedSize`. Both estimates come from
 * ONE `captureSubmitSnapshot` pass off ONE `MarketState` (execute.ts), which
 * is what keeps this a single derivation per priced event (#1121 AC6) with
 * nothing invented at ingest.
 *
 * ## #1121: the fallback's `commission` is CHARGED, not just recorded
 *
 * A real-broker fill's persisted `fee` must not be just `fill.fee` —
 * whatever the venue reported (0 on Alpaca's commission-free paper book) —
 * leaving `fallbackCostBreakdown.commission` unused beside it, read only by
 * FL's live-vs-modelled divergence check (GAP-F). The control arm's
 * `SimulatedBrokerAdapter` prices its own fills through the same `CostModel`
 * and stamps the result straight onto `fee` (`simulated-adapter.ts`); the
 * live arm must match it. On every leg — entry, protective exit (#1301) and
 * flatten — the two arms' `realized_pnl_net` are only on the same cost basis
 * if the live arm charges the modelled commission, which is exactly the
 * comparison `docs/research/12-edge-hypothesis-critique.md` D4 and #636 rule
 * out: a matched control has to be matched on cost too, not only on window.
 *
 * The decision: CHARGE the live arm the modelled commission, rather than
 * strip cost from both arms and compare
 * gross. Comparing gross would answer a different, less useful question —
 * it would discard exactly the cost sensitivity ADR-0018's accuracy bar and
 * doc 54's break-even thresholds are written against, and it would still
 * diverge from what the live venue will actually charge once Saxo settles
 * real trades (ADR-0015's 2026-08-30 amendment). `#1000` still owns the
 * commission rate's calibration; this only spends the number it already
 * produces.
 *
 * That Saxo will charge the SAME rate this fallback reads
 * (`config.simulated.venue: 'saxo'`, `costConfig.venues.saxo.commissionRate`,
 * both off `SAXO_COMMISSION_RATE`, as does `saxo-adapter.ts`'s own reported
 * `fee`) is the reason the charge is a TOP-UP and not an addition: the venue's
 * number and the model's are the same commission, so adding them would double-
 * charge the moment Saxo is the adapter. `chargeTopUpTo` is where that is
 * enforced; read its doc for why `max` and not "defer to the venue".
 *
 * Only `commission` is charged — never `spread_cost`, `slippage` or
 * `market_impact`, the breakdown's other three components. Those three are
 * adverse-PRICE effects: on a real-broker fill they are already paid, baked
 * into `fill.price` by whatever the venue actually filled at (the same
 * reason `simulated-adapter.ts`'s own entry fill comment gives — "the other
 * components are already expressed in the adverse fill price",
 * cost-model-backtest-spec.md). Adding them again on top of `fee` would
 * charge that leg of the round trip twice: once implicitly, in the price
 * `realized_pnl_net`'s gross leg is computed from, and once explicitly, in
 * `fees_total`. `commission` is the one component that is NOT a price
 * effect — it is a separate cash deduction a venue makes on top of the fill
 * price — so it is the one component a real venue's `fee: 0` can be honestly
 * missing, and the one this fallback restores.
 *
 * `fee` is therefore `max(fill.fee, fallbackCostBreakdown.commission)` exactly
 * when the fallback fires, and `fill.fee` unchanged otherwise (no modelled
 * snapshot, or a fill that already carries its OWN `cost_breakdown` —
 * `SimulatedBrokerAdapter`'s path, where `fee` already IS the commission and
 * charging it again would double-charge). `cost_breakdown` itself is left
 * exactly as it always was: the modelled ESTIMATE, unmodified by the charge
 * taken from it.
 *
 * ## AC2, "distinguishable", as narrowly as it actually holds
 *
 * `fee - (cost_breakdown?.commission ?? 0)` is a BOUND on the venue's own
 * report, not a reconstruction of it. Under the top-up rule `fee` is
 * `max(venue, modelled)`, so the subtraction returns the venue's number
 * exactly when the venue out-charged the model, and 0 otherwise — where the
 * only claim the row supports is "the venue reported at most `commission`".
 * Under `max` the two components are not separable from one number, and
 * separating them exactly needs a `fills` column, whose backfill for
 * pre-fix live rows is genuinely ambiguous (`fee = 0` with `commission = c`
 * subtracts to `−c`, which was never anybody's report).
 *
 * On today's venues the bound is tight: Alpaca paper reports 0, so 0 is the
 * exact answer, and a Simulated-adapter fill has no venue behind it at all.
 * One pre-existing wrinkle, not introduced by #1121:
 * `redistributeOneFlatten` re-spreads a Simulated fill's OWN `cost_breakdown`
 * unprorated while `fee` IS prorated, so on a multi-lot control-arm flatten
 * the subtraction is negative wherever the lot's `share < 1` — which includes
 * the FIRST row of a split, not only the later ones (6/4 off one raw fill of
 * 10 gives `0.6C − C = −0.4C`). Fixing it means re-prorating #1001's own
 * snapshot handling, which is that ticket's mechanism.
 *
 * `closed_trades.fees_total`
 * is an undecomposed sum on top of that, so an operator reconciling the arm
 * comparison against a broker statement has to join back to `fills` — and even
 * there gets the bound, not the venue's number. THE CALL, stated rather than
 * left implicit: that satisfies "distinguishable" for the arm comparison, whose
 * question is whether both arms paid the same modelled cost, and does NOT
 * satisfy it for venue reconciliation. Separating the two components exactly
 * needs a `fills` column of its own; #1121 does not add one.
 *
 * ## What this still does not cover
 *
 * #1301 closed the protective-leg gap this section used to describe: a live
 * `'stop'`/`'target'` fill is now charged the modelled commission from
 * `modelled_protective_exit_cost_breakdown` (migration 0061), priced in the
 * SAME `captureSubmitSnapshot` pass as the entry's. Both arms are therefore on
 * one cost basis on every leg either can close on, and the under-charge — a
 * whole exit commission under an adapter reporting `fee: 0` — is gone rather
 * than merely bounded. What remains on that leg under a real venue is a
 * PRICE-BASIS difference — the venue charges at the fill price, the model
 * estimated at a mid — and it is WIDER here than the flatten leg's, not the
 * same one. A flatten's estimate is captured at the flatten's own submission,
 * moments before its fill; a protective leg's is captured at the ENTRY's
 * submission, a whole holding period and a bracket width earlier. The
 * magnitude is that bracket width times the commission rate
 * (`SAXO_COMMISSION_RATE`, 8 bp/side), it has no fixed sign, and it roughly
 * cancels across a
 * population of stops (mid above the fill) and targets (mid below it). It is a
 * basis error, not a missing charge.
 *
 * WHAT #1301 DID NOT CLOSE, and could not. The same ticket's round-2 finding
 * is a SELECTION effect, not an under-charge: `modelledCostCharged`
 * (closed-trade.ts) needs one successful submit-time capture per covered leg,
 * and a protective exit's legs are all priced by the ENTRY's single capture
 * while a flatten exit additionally needs the flatten's own. So a flatten exit
 * still needs two captures where a protective exit needs one, its drop rate
 * under `SqliteArmComparisonSource`'s `modelled_cost_charged = 0` filter is
 * still weakly higher, and the surviving live population is still enriched in
 * bracket exits. That survives BY CONSTRUCTION of the option David chose on
 * 2026-09-14 (price the protective legs at submit, one derivation) over giving
 * the control arm a bracket-exit path. #1546 owns that surviving selection
 * term; #1301 owned only the under-charge, which is closed. See
 * `modelledCostCharged`'s doc and
 * `sqlite-arm-comparison-source.ts`'s `modelledCostCharged` filter, which
 * carry the same limit from their own side.
 */
/**
 * Raises `FEE_CURRENCY_NOT_BOOK_CURRENCY` for a fill whose venue-reported fee
 * currency is not sterling — see that constant for why this alerts rather
 * than refusing, and why it is a contradiction rather than an FX term.
 *
 * `isBookCurrency` (server/shared/book-currency.ts, #1465: pence in any of
 * its four spellings, plus GBP in any case) is the same predicate
 * `LseMarkDataSource` refuses foreign marks with at boot, reused rather than
 * re-derived so the two cannot disagree.
 *
 * Posts to `input.nonSterlingFeeAlerts` AFTER the `safeLog` line, never
 * instead of it (#1465) — see that field's own doc for why absence is not
 * silence. A rejected post reaches only a fixed, self-authored log line, per
 * `NonSterlingFeeAlert`'s CREDENTIALS boundary: the channel's own thrown
 * error is never logged, since an alert transport can carry a credential in
 * its failure text.
 */
async function warnOnNonSterlingFee(
  input: FillIngestInput,
  position: OpenPosition,
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
    // #1521: same trip point as `fx_rate_to_gbp`'s absence — a non-book fee
    // currency and a missing conversion rate are the same fact about this
    // fill, so the reason rides this existing line rather than a second one.
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
    // #793: UNLIKE `qty_is_cumulative`, this one IS persisted — see
    // `NormalizedFill.exit_reason`'s doc for why it has to survive to reach
    // `closedTrade()` on any poll, not only the one that ingested this fill.
    ...(fill.exit_reason === undefined ? {} : { exit_reason: fill.exit_reason }),
    // #1001: UNLIKE `qty_is_cumulative`, this one IS persisted — see
    // `Fill.flatten_idempotency_key`'s doc.
    ...(fill.flatten_idempotency_key === undefined
      ? {}
      : { flatten_idempotency_key: fill.flatten_idempotency_key }),
    // #1220, migration 0054: carried through verbatim and never converted —
    // `Fill.fee_currency`'s doc has the reasoning, and `warnOnNonSterlingFee`
    // is what makes a foreign one loud, on both `toFill` call sites (#1465
    // closed the `cumulativeTopUp` gap — see that function's own call).
    ...(fill.fee_currency === undefined ? {} : { fee_currency: fill.fee_currency }),
    // #1521, migration 0060: carried through verbatim, same posture as
    // `fee_currency` above — see `Fill.fx_rate_to_gbp`'s doc.
    ...(fill.fx_rate_to_gbp === undefined ? {} : { fx_rate_to_gbp: fill.fx_rate_to_gbp }),
    ...(fill.fx_rate_to_gbp_source === undefined
      ? {}
      : { fx_rate_to_gbp_source: fill.fx_rate_to_gbp_source }),
  };
}

/**
 * Which submit-time estimate a fill's leg is charged from, or `null` for a leg
 * this lot's own submission never priced.
 *
 * `'exit'` is null here and not an oversight: a flatten's estimate belongs to
 * the FLATTEN's submit-time capture, prorated across the lots it named by
 * `splitFlattenFills` (flatten-attribution.ts), and is attached there. Reading
 * the entry lot's estimate for it would charge an exit the price of an entry
 * priced at a different instant.
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
