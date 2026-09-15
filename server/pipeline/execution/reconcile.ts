/**
 * Execution's crash-restart surface — `reconcile()` (ticket #86). See
 * docs/specs/execution-spec.md ("Module: Idempotency & Crash-Restart").
 *
 * `execute()` writes the lot `pending` BEFORE calling the broker, so a crash
 * in that gap leaves a record whose truth only the venue knows: the bracket
 * may have landed, or may never have been seen. This is where that ambiguity
 * is settled, on startup, with the broker as tie-break authority — adopt what
 * the venue says, or mark the lot `rejected` where the venue authoritatively
 * never received it.
 *
 * What actually prevents the post-crash double-submit is the write-ahead
 * itself: whichever way a lot is settled here, exactly one record survives
 * under the idempotency key, so `execute()`'s `findByKey` gate turns any
 * replay of the same decision into a `deduped` that never reaches the broker.
 * Reconcile's job is to stop that surviving record from being a lie.
 *
 * Scope is the in-flight states only (`pending`/`submitted`), per the ticket.
 * A `partially_filled`/`filled` lot is `ingestFills()`'s: its `filled_size`
 * and `avg_entry_price` are reconstructed from the persisted `Fill` rows, and
 * reconcile overwriting them from a venue order summary would fight that
 * reconstruction. The two surfaces divide cleanly — reconcile owns submit
 * ambiguity, `ingestFills()` owns fill-driven advance — so a startup runs
 * reconcile first, then `ingestFills()` to pick up whatever filled while the
 * process was down.
 *
 * ## The flatten-journal sweep (#519, #526)
 *
 * `executeExit` (execute.ts) journals a flatten to `flatten_submissions`
 * write-ahead, the same way the bracket path write-aheads to `open_positions`
 * — but nothing swept that journal: a flatten stuck at `'submitting'` (the
 * venue may have seen it; the ack response was lost) sat there forever, and
 * even an ACKED flatten (`'submitted'`) was only ever polled for fills by
 * `AlpacaBrokerAdapter.flattens`, a process-local map a restart empties —
 * losing the fill, the lot's round-trip to `closed`, and its `ClosedTrade`
 * with it (#526's own finding).
 *
 * The flatten sweep in `reconcile()` below closes both: it reads
 * `SharedStore.getUnresolvedFlattens()` — bounded so the sweep does not
 * re-poll the venue for a flatten that finished closing its lot(s) long ago,
 * see migration 0023 — and calls `reconcileFlatten` for each row, which asks
 * the venue via `BrokerAdapter.resumeFlatten`, whose side effect (re-populating a live
 * adapter's `flattens` map) is what makes the NEXT `fetchNewFills` sweep find
 * the order again after a restart. Symmetric to `reconcileLot` below in
 * every way that matters: the venue is the tie-break authority, ignorance is
 * never treated as absence, and every settled row updates the journal exactly
 * once.
 *
 * `ReconcileDivergence`/`ReconcileReport` are WIDENED to also carry a
 * flatten's outcome rather than gaining a sibling type — see
 * `ReconcileDivergence`'s own doc (types/execution.ts) for why.
 *
 * ## The terminal-row sweep (#1088)
 *
 * `getOpenPositions()` already excludes every terminal `open_positions` row
 * from every live read (crash recovery, exposure sizing, the dashboard), so
 * a `rejected`/`cancelled`/`expired` row sitting in the table is inert — but
 * before #1088 nothing ever deleted one, so the table grew without bound
 * (observed: 10 terminal rows to 1 live row). `sweepTerminalPositions`
 * (`SqliteExecutionStore`) is the fix: called unconditionally at the end of
 * every `reconcile()` pass, which — like the flatten and residual sweeps
 * above — gives it both of `reconcile()`'s existing production call sites
 * (startup, and the periodic poll per #921) for free, live and control arm
 * alike (`control-arm-wiring.ts` builds both arms' `reconcile()` off this
 * same function). See `sqlite-shared-store.ts`'s "row lifecycle" doc for the
 * full lifecycle and why `closed` rows are deliberately never swept.
 *
 * `TERMINAL_SWEEP_AGE_MS` below is the age gate: `sweepTerminalPositions`
 * only deletes a row once its `decision_timestamp` is this old. The reason
 * is idempotency-key reuse — `idempotency_key` hashes
 * `(instrument, bar, side, arm)` (`computeIdempotencyKey`), not `debate_id`,
 * specifically so a crash-restart replay of the SAME bar coordinate reuses
 * the SAME key and dedupes against the row `execute()` already wrote for it
 * (`findByKey`). Deleting a terminal row the moment it turns terminal would
 * free that key for reuse while a same-bar replay is still plausible; fixed
 * at 24h — 24x `DEBATE_BAR_TIMEFRAME_MS` (the bar grid a replay's coordinate
 * is measured against, debate-log-store.ts), comfortably past any realistic
 * crash-recovery gap.
 *
 * ## The wedged-zero-fill sweep (#1186)
 *
 * A lot adopted `filled`/`partially_filled` whose `filled_size` never moves
 * off zero is NOT yet terminal, so the sweep above never reaches it, and it is
 * not `IN_FLIGHT_ORDER_STATES`, so this file's own bracket pass never revisits
 * it either — the gap `wedged-zero-fill-sweep.ts` closes. Called the same way
 * the residual sweep is (both production call sites, live and control arm,
 * store-evidence-only), just after it.
 */

import type { OpenPosition, OrderState } from '../../shared/index.js';
import { coversQty, describeThrownSafely, heldQuantitiesFor, safeLog } from '../../shared/index.js';
import { IN_FLIGHT_ORDER_STATES, TERMINAL_ORDER_STATES } from '../../shared/store/index.js';
import { sweepResidualProtection } from './residual-protection-sweep.js';
import type {
  NormalizedOrder,
  NormalizedPosition,
  ReconcileDivergence,
  ReconcileEscalation,
  ReconcileInput,
  ReconcileReport,
  UnresolvedFlattenSubmission,
} from './types.js';
import { sweepWedgedZeroFillLots } from './wedged-zero-fill-sweep.js';

/**
 * #1088: how old a terminal, size-0 `open_positions` row's
 * `decision_timestamp` (the original write-ahead time — there is no
 * separate terminal-transition timestamp to anchor on) must be before
 * `sweepTerminalPositions` deletes it. See this file's "terminal-row sweep"
 * doc above for the idempotency-key-reuse-safety reasoning behind the value.
 */
export const TERMINAL_SWEEP_AGE_MS = 24 * 60 * 60 * 1_000;

/**
 * #1214 review round 2: how long an ACKED (`'submitted'`) flatten row may sit
 * blocking its instrument while the venue keeps answering that it has no such
 * order, before `reconcileFlatten` forces it terminal.
 *
 * ## Why a bound has to exist at all
 *
 * An unresolved `flatten_submissions` row blocks BOTH flatten submitters —
 * `writeAheadFlatten`'s atomic gate refuses `executeExit`'s mandatory
 * flat-by-close and `reflattenResidual`'s walk alike, and since #1389 the
 * Trader refuses to even build the intent (`flattenAlreadyInFlight`,
 * trader/decide.ts). Before this constant, the `resumeFlatten`-returns-null
 * branch below left such a row untouched on every pass forever: the
 * instrument could never be flattened again, across restarts and trading
 * days, with no operator path short of editing SQLite by hand. That is the
 * exact outcome ADR-0014's flat-by-close horizon exists to prevent, so the
 * block has to be time-limited in code rather than "documented, not coded".
 *
 * ## Why five minutes
 *
 * `DEFAULT_TRADER_CONFIG.flatten_before_close_ms` (trader/types.ts), which is
 * how long the flatten window is open BEFORE the bell. Picking the same value
 * buys the guarantee that matters: a row that was already blocking when the
 * window opened is forced terminal by the bell at the latest, leaving the
 * whole `flatten_after_close_ms` grace for the daily flatten to go out.
 * `assertFlattenWindowCoversTickInterval` (#670, #1389) guarantees at least
 * ONE tick lands in that grace; that it holds
 * `MIN_TICKS_INSIDE_FLATTEN_WINDOW` follows only from the defaults being equal
 * on both sides of the bell, which is a property of `DEFAULT_TRADER_CONFIG`
 * and not an invariant the boot assertion enforces. Reconcile runs on every
 * fill-sync poll (#921, 15s by default) and that loop has no calendar gate, so
 * the forcing pass itself lands within a poll of the bound expiring, post-bell
 * included. `production/flatten-tick-coupling.test.ts` asserts the equality
 * against the trader default, and the grace relation with it, so neither can
 * drift silently; the value is NOT imported, because execution does not depend
 * on the trader.
 *
 * The residual carry this does NOT cover is stated rather than argued away: a
 * row first submitted INSIDE that session's flatten window cannot be aged out
 * before the window shuts, so its instrument carries overnight and the
 * carried-lot alert (orchestrator/production/carried-lot-alert.ts) is what
 * makes it audible — ADR-0014's 2026-09-10 amendment, unchanged.
 *
 * ## What evidence actually forces the row: one answer, against an aged row
 *
 * The bound is on the ROW'S AGE (`now - row.submitted_at`) and nothing on this
 * path counts observations — no consecutive-negative tally is kept anywhere. So
 * the forcing fires on the FIRST `resumeFlatten` null that lands once the age
 * is past: one unanswered check against an old row, not a measured run of
 * denials. A row that went unpolled for the whole bound (process down, poll
 * failing) is forced on its very first answer. Every docblock, reason string
 * and alert on this path has to say that much and no more; "the venue denied it
 * on every pass" would describe observations that were never made.
 *
 * ## Why acting on evidence that thin is still the right trade
 *
 * `getFlattenAttribution` is keyed on `idempotency_key` alone with NO status
 * filter, so a fill that turns up after the row was forced still routes to the
 * lots the flatten named and still reduces held quantity. The residual risk is
 * therefore narrow: a flatten still WORKING at the venue that the venue is
 * simultaneously denying exists. Flattens are market orders under a DayOrder
 * TIF, so one this old that the venue cannot name is far likelier dead than
 * working. Against that residual risk sits an instrument that is otherwise
 * un-flattenable forever, which is #1214's own DECISION applied unchanged:
 * closing the account down imperfectly beats leaving it open.
 *
 * ## What forcing the row terminal RE-ARMS, and why that is accepted
 *
 * Unblocking the instrument is not the only consequence, and the second one is
 * #516's reverse-position hazard by name. An `'error'` row is a spent attempt
 * to both durable key walks: `resolveReflattenKey` (residual-reflatten.ts)
 * sees the key as taken (`findByKey` is status-blind) and hands back the NEXT
 * `:residual-reflatten-N`, and `resolveExitRetryKey` (execute.ts) reads it as
 * retryable (`isRetryableFlattenError` is `status === 'error'`) and advances to
 * the next `:retry-N`. So a second live market order can go out on the same
 * held quantity while the first may — on the branch this bound exists for —
 * still be working at the venue. That is exactly the double-sell #516 forbids,
 * and it is accepted here for the same reason the resolution itself is: both
 * orders are DayOrder market flattens in the same direction on a lot that must
 * end the day flat, the row is old enough that the venue's inability to name
 * the first is likelier death than work in progress, and both walks stay
 * bounded (three attempts each, durable across restarts).
 *
 * The worst case is worse than "one extra fill", and is written down rather
 * than rounded off. If the FIRST flatten did fill and was merely never
 * confirmed, and the second one then fills too: the first fill attributes
 * correctly and closes the lot in the store, and the second fill's
 * `redistributeOneFlatten` resolves to a lot key `getOpenPositions()` no longer
 * returns. The store can then show flat while the venue holds a REVERSE
 * position. That quantity is no longer dropped: `persistUnattributedSplits`
 * (ingest-fills.ts) books it against the closed lot and pages, provided the
 * poll reaches redistribution at all — which needs SOME other lot still open,
 * since `ingestFills` returns at its own `positions.length === 0` guard.
 * The last-open-lot case is the reconcile side's:
 * `findUnrecordedVenuePositions` below runs unconditionally on every pass, and
 * since #1550 raises an `UnrecordedVenuePositionAlertChannel` page rather than
 * only a log level. Neither path repairs the realized record — the lot's
 * `ClosedTrade` still understates the sale, which is why both escalate for
 * hand correction. Weighed against all of that is an instrument that can never
 * be flattened again — an open position carried indefinitely against ADR-0014,
 * with certainty rather than in a narrow race. The bound accepts the race.
 */
export const UNRESOLVABLE_FLATTEN_MAX_AGE_MS = 5 * 60 * 1_000;

/**
 * #1500: how often one wedged `flatten_submissions` row may cost a venue
 * cancel and an operator page.
 *
 * `reconcileFlatten` cancels a flatten the venue is still working (and a
 * never-confirmed one it cannot ask about) once the row is past
 * `UNRESOLVABLE_FLATTEN_MAX_AGE_MS`, and nothing about that row changes
 * until the venue answers — so the same row qualifies again on the next
 * pass, and reconcile runs on the fill-sync poll (#921, 15s by default).
 * Unthrottled that is ~240 venue cancels and ~240 real pages per hour per
 * row, and on Saxo each cancel is a full `listOpenOrders()` plus a DELETE
 * against a pacing budget shared with the trading path.
 *
 * The retry buys nothing at poll cadence: the first cancel is the one that
 * acts, and re-issuing it only covers a delivery failure or a venue that
 * accepted it and did nothing. Half an hour keeps both the venue cost and
 * the page cadence at two per hour per row while still retrying well inside
 * a trading session. The attempt time is DURABLE
 * (`flatten_submissions.cancel_attempted_at`, migration 0062) rather than
 * process-local, so a restart loop cannot turn the throttle back into a
 * per-pass cancel.
 */
export const FLATTEN_CANCEL_RETRY_EVERY_MS = 30 * 60 * 1_000;

/**
 * #1500: how long a TERMINAL flatten whose fills were never swept may keep
 * blocking its instrument before reconcile decides on venue evidence.
 *
 * `fills_swept_at` is the only thing that retires such a row, and only
 * `ingestFills()` writes it — as the LAST step of a poll that must first
 * attribute the flatten's fills and advance every lot they name. Any failure
 * before that step leaves the row unswept, and several of them never recur on
 * a later poll because the fills themselves have aged past the `since` floor,
 * so the flatten key is never iterated again. The row then blocks its
 * instrument's mandatory flat-by-close for as long as the store exists, across
 * restarts, with no operator path but hand-editing SQLite.
 *
 * Measured from `terminal_unswept_checked_at` (migration 0063) — the first
 * pass that saw the row TERMINAL with its fills unswept — not from
 * `submitted_at`. Two different failures rule that out: a row that has been
 * alive for hours and goes terminal NOW is already past any submission-based
 * bound, so it would be judged within one 15s poll of the fill itself, against
 * a venue position view that may still lag its own fill processing (the lag
 * `cancelNeverConfirmedFlatten` reads AFTER its cancel to avoid). Judged too
 * early, coverage reads true on a venue that has simply not caught up, and the
 * replacement flatten goes out at full size — the #516/#1389 over-sell.
 *
 * Half an hour of the row sitting in that shape is long relative to the 15s
 * fill poll, so a flatten sweeping NORMALLY is never examined here: a working
 * sweep has had well over a hundred chances by then.
 */
export const UNSWEPT_TERMINAL_FLATTEN_MAX_AGE_MS = 30 * 60 * 1_000;

/** A `broker.getOpenPositions()` answer, or why this pass has none. */
type VenuePositions = { positions: readonly NormalizedPosition[] } | { error: string };

export async function reconcile(input: ReconcileInput): Promise<ReconcileReport> {
  const { clock, store } = input;
  const now = clock.now();

  // `getOpenPositions()` is every non-terminal lot; the in-flight ones are
  // the subset a crash can have left disagreeing with the venue.
  const positions = await store.getOpenPositions();
  const inFlight = positions.filter((position) =>
    IN_FLIGHT_ORDER_STATES.includes(position.order_state),
  );

  const divergences: ReconcileDivergence[] = [];
  let corrected = 0;

  for (const position of inFlight) {
    const divergence = await reconcileLot(input, position);
    if (divergence === null) continue;

    divergences.push(divergence);
    // `undetermined` deliberately wrote nothing, so it is not a correction.
    if (divergence.action !== 'undetermined') corrected += 1;
  }

  // #519/#526 — see the file doc's "flatten-journal sweep" section.
  const unresolvedFlattens = await store.getUnresolvedFlattens();
  for (const row of unresolvedFlattens) {
    const divergence = await reconcileFlatten(input, row, now, positions);
    divergences.push(divergence);
    if (divergence.action !== 'undetermined') corrected += 1;
  }

  // #549 — the residual-protection sweep (residual-protection-sweep.ts):
  // every lot still durably marked "partial-flatten residual observed,
  // protection not confirmed" gets its re-arm retried idempotently, or its
  // escalation raised. AFTER the flatten sweep above, deliberately: on the
  // crypto path `resumeFlatten`'s side effect is what re-populates the
  // adapter's process-local worklists a restart emptied, the same ordering
  // reason `runStartupReconcile` runs before the first `ingestFills()`.
  // Symmetric to the flatten sweep in the report too — its markers count in
  // `checked`, its resolutions in `corrected`.
  const residualSweep = await sweepResidualProtection(input);
  for (const divergence of residualSweep.divergences) {
    divergences.push(divergence);
    if (divergence.action !== 'undetermined') corrected += 1;
  }

  // #1186 — see wedged-zero-fill-sweep.ts. Store-evidence-only (no broker
  // call): it reads `getOpenPositions()` fresh, its own worklist scan, the
  // same shape `sweepResidualProtection` above already takes with its own
  // `getUnprotectedResidualLots()` rather than reusing this function's
  // `positions` — a lot it retires is never one `reconcileLot` above needed
  // to act on (it is not `IN_FLIGHT_ORDER_STATES`) or one
  // `findUnrecordedVenuePositions` below should compare against a venue read
  // (it has no venue position).
  const wedgedZeroFillSweep = await sweepWedgedZeroFillLots(input);
  for (const divergence of wedgedZeroFillSweep.divergences) {
    divergences.push(divergence);
    if (divergence.action !== 'undetermined') corrected += 1;
  }

  // Read HERE rather than hoisted above the sweeps: a snapshot taken before
  // the flatten loop is stale by every `resumeFlatten` timeout and every
  // venue cancel that loop spent, and `cancelNeverConfirmedFlatten` takes its
  // own read after its cancel resolves for exactly that reason (#1500).
  divergences.push(
    ...(await findUnrecordedVenuePositions(input, await readVenuePositions(input), positions, now)),
  );

  // #1088 — see the file doc's "terminal-row sweep" section. Unconditional:
  // every pass ages out whatever has crossed the cutoff since the last one,
  // live and control arm alike.
  const cutoff = new Date(now.getTime() - TERMINAL_SWEEP_AGE_MS);
  const swept = await store.sweepTerminalPositions(cutoff);

  return {
    checked:
      inFlight.length +
      unresolvedFlattens.length +
      residualSweep.checked +
      wedgedZeroFillSweep.checked,
    corrected,
    divergences,
    swept,
    timestamp: now,
  };
}

/**
 * Settle one `flatten_submissions` row against the venue — the flatten
 * counterpart of `reconcileLot` below, called for every row
 * `SharedStore.getUnresolvedFlattens()` names. Always returns a divergence
 * (unlike `reconcileLot`, which returns `null` on agreement): every row this
 * function is handed is, by construction, one the store does not yet
 * consider settled, so there is always something to report — the flatten
 * equivalent of `reconcileLot` never being called for an already-terminal
 * lot in the first place.
 */
async function reconcileFlatten(
  input: ReconcileInput,
  row: UnresolvedFlattenSubmission,
  now: Date,
  storePositions: readonly OpenPosition[],
): Promise<ReconcileDivergence> {
  const { broker, store } = input;
  // `'submitting'` maps onto `'pending'` — the same "written ahead, not yet
  // confirmed" meaning that value already carries for a bracket's write-ahead
  // (see `ReconcileDivergence`'s widen doc, types/execution.ts).
  const storeState: OrderState = row.status === 'submitting' ? 'pending' : 'submitted';

  let order: Awaited<ReturnType<typeof broker.resumeFlatten>>;
  try {
    order = await broker.resumeFlatten(row.idempotency_key, row.instrument);
  } catch (error) {
    // Ignorance, not evidence — `reconcileLot`'s own reasoning applies
    // unchanged: the adapter could not answer, and treating that as "never
    // placed" would mark a live, possibly-filled flatten as never having
    // reached the venue. Left exactly as it was, and escalated: unlike a
    // bracket's `pending` write-ahead, an unresolved flatten is a lot stuck
    // in genuine ambiguity about whether it is still held, which is
    // paging-worthy on its own (#519) — see `FlattenReconcileAlertChannel`'s
    // doc for why this is not treated as a background diagnostic.
    //
    // `order_state` is left untouched here, and that is what makes it
    // STICKY: a row the venue once confirmed WORKING keeps that answer
    // through any number of later throws, so nothing downstream can mistake
    // "the adapter went quiet" for "the order went away". Such a row is
    // handled by `cancelWedgedFlatten` below on the next pass the adapter
    // CAN answer; while it cannot, the row keeps blocking and the alert is
    // the whole of the response.
    //
    // #1500: a row the venue NEVER confirmed (`order_state` still null) has
    // no such later pass to wait for — `resumeFlatten` may throw forever, and
    // no other surface ever writes this row. Past
    // `UNRESOLVABLE_FLATTEN_MAX_AGE_MS` it is taken through
    // `cancelNeverConfirmedFlatten`, which is the ONLY path that releases the
    // instrument, and does so on venue evidence rather than on age.
    if (
      row.order_state === null &&
      now.getTime() - row.submitted_at.getTime() >= UNRESOLVABLE_FLATTEN_MAX_AGE_MS
    ) {
      return await cancelNeverConfirmedFlatten(input, row, now, storePositions, {
        storeState,
        resumeError: describeThrownSafely(error),
      });
    }

    const reason = describeThrownSafely(error);
    await postFlattenReconcileAlert(input, row, reason, now);
    return {
      idempotency_key: row.idempotency_key,
      instrument: row.instrument,
      store_state: storeState,
      broker_state: null,
      action: 'undetermined',
      kind: 'flatten',
      reason,
    };
  }

  if (order === null) {
    if (row.status === 'submitting') {
      // The venue authoritatively has no such order: this write-ahead never
      // landed, the same settlement `reconcileLot` makes for a bracket's
      // `pending` record. Unlike that path there is no lot to mark
      // `rejected` — a flatten writes no `OpenPosition` — so the JOURNAL row
      // itself is what carries the terminal answer.
      const reason =
        'reconcile: broker has no order under this client_order_id — the write-ahead never landed';
      await store.resolveFlattenError(row.idempotency_key, reason, now);
      return {
        idempotency_key: row.idempotency_key,
        instrument: row.instrument,
        store_state: storeState,
        broker_state: null,
        action: 'rejected',
        kind: 'flatten',
        reason,
      };
    }

    // A row already at `'submitted'` carries `broker_order_ids` the venue
    // gave it once — the venue definitely acked this flatten. A LATER null
    // from `resumeFlatten` is not proof the write-ahead never landed (it
    // provably did); it is the adapter unable to reconfirm an order it
    // already told us about (aged out of a lookup window, for instance).
    // Treating this as `'rejected'` would write a false record — "the
    // write-ahead never landed" — about a flatten that may have filled and
    // closed a lot. So the FIRST such answers leave the journal untouched and
    // escalate, the same as a genuine `resumeFlatten` throw just above.
    //
    // But only up to `UNRESOLVABLE_FLATTEN_MAX_AGE_MS` (#1214 review round 2).
    // "Left untouched and escalated" is a resolution path only if something
    // else eventually resolves the row, and for this shape nothing did:
    // `fills_swept_at` is the only other thing that ever retires a
    // `'submitted'` row and only `ingestFills()` sets it, only for a flatten
    // that produced fills — which this one, on the venue's current account,
    // did not. The row therefore blocked its instrument's mandatory
    // flat-by-close forever, across restarts and trading days. Past the bound
    // the system decides rather than freezes: the reason string records the
    // row's age and the single current answer it acted on — not a denial count,
    // which nothing here keeps — and the alert is still posted every pass, so
    // forcing the row terminal silences nothing an operator was being told
    // before.
    const age = now.getTime() - row.submitted_at.getTime();
    const provenance =
      `flatten '${row.idempotency_key}' was previously acked by the broker (a durable ` +
      "'submitted' journal row exists) but the venue now reports no such order";
    if (age >= UNRESOLVABLE_FLATTEN_MAX_AGE_MS) {
      const reason =
        `${provenance}. The row has been unresolved for ${Math.round(age / 1_000)}s — past the ` +
        `${UNRESOLVABLE_FLATTEN_MAX_AGE_MS / 1_000}s bound, so the journal row is resolved to ` +
        'stop it blocking every later flatten on this instrument. This is a DECISION on one ' +
        'unanswered check against a row that old, not proof the flatten is dead, and not a ' +
        'record of repeated denial (nothing counts how often the venue was asked): check the ' +
        'venue by hand, and note that a fill arriving later is still attributed to the lots ' +
        'this flatten named (getFlattenAttribution does not filter on status)';
      await postFlattenReconcileAlert(input, row, reason, now);
      await store.resolveFlattenError(row.idempotency_key, reason, now);
      return {
        idempotency_key: row.idempotency_key,
        instrument: row.instrument,
        store_state: storeState,
        broker_state: null,
        action: 'rejected',
        kind: 'flatten',
        reason,
      };
    }
    const reason = `${provenance} — leaving the journal untouched; check the venue by hand`;
    await postFlattenReconcileAlert(input, row, reason, now);
    return {
      idempotency_key: row.idempotency_key,
      instrument: row.instrument,
      store_state: storeState,
      broker_state: null,
      action: 'undetermined',
      kind: 'flatten',
      reason,
    };
  }

  // The venue named an order. `resumeFlatten`'s side effect already
  // re-populated the adapter's own flatten-sweep worklist; what is left is
  // updating the journal so this row eventually stops being "unresolved".

  // #1214 review — the ONE venue answer that must resolve the row here rather
  // than merely be recorded on it. `fills_swept_at` is the only thing that
  // ever bounds a `'submitted'` row (`getUnresolvedFlattens`), and only
  // `ingestFills()` sets it, only for a flatten that actually produced fills.
  // A flatten the venue terminally refused therefore had NOTHING to resolve
  // it: `recordFlattenOrderStateObserved` below leaves `status`/`resolved_at`
  // untouched, so the row stayed unresolved forever — wedging every later
  // flatten on the instrument, both this instrument's daily flatten
  // (`executeExit`'s write-ahead guard) and the #1214 re-flatten walk, across
  // restarts.
  //
  // `filled_qty === 0` is load-bearing, not belt-and-braces: a flatten that
  // filled part of the lot and was then cancelled still has fills in flight
  // for `ingestFills()` to sweep, and `resumeFlatten`'s worklist side effect
  // above is what recovers them after a restart. Only a flatten that closed
  // NOTHING is dead with nothing owing.
  if (TERMINAL_ORDER_STATES.includes(order.order_state) && order.filled_qty === 0) {
    const reason =
      `reconcile: the venue reports this flatten '${order.order_state}' having filled nothing — ` +
      'it closed no quantity and never will, so the journal row is resolved rather than left ' +
      'standing as an in-flight flatten on the instrument';
    await store.resolveFlattenError(row.idempotency_key, reason, now);
    return {
      idempotency_key: row.idempotency_key,
      instrument: row.instrument,
      store_state: storeState,
      broker_state: order.order_state,
      action: 'rejected',
      kind: 'flatten',
      reason,
    };
  }

  if (row.status === 'submitting') {
    // The genuine first resolution of this write-ahead's ambiguity —
    // `resolveFlattenSubmitted` is the right write here (sets `resolved_at`,
    // the same as it does when `executeExit` itself calls it on a clean ack).
    await store.resolveFlattenSubmitted(
      row.idempotency_key,
      { order_state: order.order_state, broker_order_ids: order.broker_order_ids },
      now,
    );
  } else {
    // Already resolved once; this is a FRESHER answer to a question already
    // settled, not a new ambiguity — `recordFlattenOrderStateObserved`
    // leaves `resolved_at`/`status` alone (see its own doc, types/store.ts).
    await store.recordFlattenOrderStateObserved(row.idempotency_key, {
      order_state: order.order_state,
      broker_order_ids: order.broker_order_ids,
    });
  }

  const adopted = `flatten journal said '${row.status}'; broker reports '${order.order_state}'`;

  // #1500: the terminal row whose fills were never swept. `filled_qty > 0`
  // here (the branch above took the zero case), so `ingestFills()` owes this
  // row a `markFlattenFillsSwept` it has not delivered, and once the row has
  // sat in that shape past `UNSWEPT_TERMINAL_FLATTEN_MAX_AGE_MS` it is not
  // going to: the fills have aged past its `since` floor, so the flatten key
  // is never iterated again.
  //
  // Below the record/resolve writes above on purpose, not merely after them:
  // the venue state that motivates the release is written to the row BEFORE
  // any pass can release on it, including for a `'submitting'` row whose ack
  // this is (`resolveFlattenSubmitted` — `broker_order_ids` and `resolved_at`
  // would otherwise never be written for a row released here).
  //
  // The window starts at the FIRST pass that saw this shape and the same
  // column throttles the verdict's cost — see the constant, and migration
  // 0063. A pass inside the window does nothing at all: no venue read, no
  // page, and the row falls through to the 'adopted' answer it had before
  // this branch existed.
  if (TERMINAL_ORDER_STATES.includes(order.order_state)) {
    const firstSeen = row.terminal_unswept_checked_at;
    if (firstSeen === null) {
      await store.markFlattenTerminalUnsweptChecked(row.idempotency_key, now);
    } else if (now.getTime() - firstSeen.getTime() >= UNSWEPT_TERMINAL_FLATTEN_MAX_AGE_MS) {
      return await judgeTerminalUnsweptFlatten(
        input,
        row,
        order,
        firstSeen,
        storePositions,
        storeState,
        now,
      );
    }
  }

  // #1500 — cancel-then-replace, the only path that reaches the shape #1500
  // was filed for. Every acked row carries a WORKING `order_state`
  // (`resolveFlattenSubmitted` sets it, the branch just above refreshes it),
  // and no gate anywhere releases a working row at any age — correctly, since
  // a second full-size market flatten against an order the venue is still
  // confirming open is the #516/#1389 over-sell. So a flatten the venue acks
  // and then never fills would block its instrument's mandatory flat-by-close
  // forever. The way out is not to release the row, it is to make the row
  // STOP BEING WORKING: ask the venue to cancel it. The cancel's own terminal
  // answer then arrives on a later pass and routes into one of the two
  // resolution paths that already exist — `filled_qty === 0` resolves the row
  // above, and a partial fill is retired by `markFlattenFillsSwept` once
  // `ingestFills()` applies it — so what finally unblocks the instrument is
  // always venue evidence plus swept fills, never elapsed time.
  //
  // Gated on the FRESH `order.order_state` rather than `row.status`: a
  // `'submitting'` row the venue confirms working is the same hazard and
  // wants the same cancel, and one rule covering both cannot disagree with
  // itself. `BrokerAdapter.cancel` is idempotent BY CONTRACT (already
  // cancelled, filled or unknown all resolve rather than throw), so re-issuing
  // it is safe; `FLATTEN_CANCEL_RETRY_EVERY_MS` is what stops it being issued
  // every poll.
  const working = !TERMINAL_ORDER_STATES.includes(order.order_state);
  if (working && now.getTime() - row.submitted_at.getTime() >= UNRESOLVABLE_FLATTEN_MAX_AGE_MS) {
    return {
      idempotency_key: row.idempotency_key,
      instrument: row.instrument,
      store_state: storeState,
      broker_state: order.order_state,
      action: 'adopted',
      kind: 'flatten',
      reason: `${adopted}; ${await cancelWedgedFlatten(input, row, order.order_state, now)}`,
      escalation: 'wedge_cancelled',
    };
  }

  return {
    idempotency_key: row.idempotency_key,
    instrument: row.instrument,
    store_state: storeState,
    broker_state: order.order_state,
    action: 'adopted',
    kind: 'flatten',
    reason: adopted,
  };
}

/**
 * The cancel half of the cancel-then-replace above. Fully swallowed, like
 * every other venue call on this sweep: a cancel that could not be delivered
 * leaves the row exactly as it was — still blocking, still working, still
 * retried once the throttle is next due — which is the same standing this
 * sweep already gives a `resumeFlatten` that could not answer. Returns the
 * sentence the caller appends to its divergence `reason`, so a cancel and its
 * outcome are readable off the reconcile report as well as off the alert, and
 * so a pass that deliberately did NOT re-cancel says so rather than reading as
 * a pass that never tried.
 */
async function cancelWedgedFlatten(
  input: ReconcileInput,
  row: UnresolvedFlattenSubmission,
  observedState: OrderState,
  now: Date,
): Promise<string> {
  const age = Math.round((now.getTime() - row.submitted_at.getTime()) / 1_000);
  if (!cancelDue(row, now)) {
    return (
      `the venue still reports this flatten '${observedState}' after ${age}s; it was already ` +
      `cancelled at the venue at ${row.cancel_attempted_at?.toISOString()} and the row keeps ` +
      'blocking until the venue reports it terminal AND its fills are swept — not re-cancelled ' +
      'or re-paged this pass (FLATTEN_CANCEL_RETRY_EVERY_MS)'
    );
  }
  const provenance =
    `the venue still reports this flatten '${observedState}' after ${age}s — past the ` +
    `${UNRESOLVABLE_FLATTEN_MAX_AGE_MS / 1_000}s bound, so it is being CANCELLED at the venue ` +
    'rather than left to block every later flatten on this instrument. The journal row is ' +
    'unchanged and keeps blocking until the venue reports the order terminal AND its fills ' +
    'are swept — nothing is re-armed on age alone';
  // Recorded BEFORE the call, and for a failure as well as a success: the
  // throttle bounds what this sweep costs the venue and the operator, so it
  // must not be escapable by a cancel that throws on every pass.
  await input.store.markFlattenCancelAttempted(row.idempotency_key, now);
  try {
    await input.broker.cancel(row.idempotency_key, row.instrument);
  } catch (error) {
    const reason = `${provenance}. The cancel FAILED (${describeThrownSafely(error)}); retrying when due`;
    await postFlattenReconcileAlert(input, row, reason, now);
    return reason;
  }
  await postFlattenReconcileAlert(input, row, provenance, now);
  return provenance;
}

/**
 * Whether this row may cost another venue cancel and another page — see
 * `FLATTEN_CANCEL_RETRY_EVERY_MS`. A row never cancelled is always due.
 */
function cancelDue(row: UnresolvedFlattenSubmission, now: Date): boolean {
  if (row.cancel_attempted_at === null) return true;
  return now.getTime() - row.cancel_attempted_at.getTime() >= FLATTEN_CANCEL_RETRY_EVERY_MS;
}

/**
 * #1500: the never-confirmed row — `order_state` still null past the bound
 * because `resumeFlatten` has never once answered for it. Reached only from
 * the throw branch above.
 *
 * This is the one row shape with no other way out. `writeAheadFlatten`
 * committed and `submitFlatten` may well have landed at the venue (the ack
 * response is exactly what is missing), so the order may be working right
 * now; but the adapter cannot describe it, so no later pass can turn it
 * terminal, and `ingestFills()` has nothing to sweep. Releasing it on age
 * alone would let a second full-size market flatten out against an order that
 * may be filling — the #516/#1389 reverse position, which a broken read
 * endpoint is no reason to risk: a venue can serve order placement while its
 * order-details endpoint fails.
 *
 * So the row is released ONLY on two pieces of venue evidence together:
 *
 * 1. `cancel(idempotency_key)` resolves. Both production adapters address the
 *    venue by the key `submitFlatten` registered (Alpaca's `client_order_id`,
 *    Saxo's `ExternalReference`), so this reaches the order without ever
 *    needing the lost ack — and by contract it also resolves when the venue
 *    has no such order, or has one that already filled. On its own it
 *    therefore proves nothing about whether the flatten filled, which is
 *    exactly why it is not sufficient.
 * 2. The venue's own position for the instrument still covers everything the
 *    store thinks it holds. That is the evidence a `void` cancel cannot
 *    carry: had this flatten filled — in part or in full, before or despite
 *    the cancel — the venue would hold LESS than the store's held quantity,
 *    and the replacement `executeExit` sizes off `heldQuantitiesFor` would be
 *    too big by whatever filled.
 *
 * Anything else keeps the row blocking and pages: a cancel that throws, a
 * venue book this pass could not read, or a venue position that no longer
 * covers the store's — the last being the case where something DID fill and
 * an operator has to attribute it by hand, since the fills cannot be ingested
 * through an adapter that will not describe the order.
 *
 * The residual race is this file's ordinary one (#429/#1122): a fill landing
 * between the position read and the replacement is still sized against the
 * older number. What that leaves behind is surfaced rather than dropped —
 * booked and paged by `persistUnattributedSplits` (ingest-fills.ts) where some
 * lot is still open, and paged by `findUnrecordedVenuePositions` below where
 * none is.
 */
async function cancelNeverConfirmedFlatten(
  input: ReconcileInput,
  row: UnresolvedFlattenSubmission,
  now: Date,
  storePositions: readonly OpenPosition[],
  context: { storeState: OrderState; resumeError: string },
): Promise<ReconcileDivergence> {
  const age = Math.round((now.getTime() - row.submitted_at.getTime()) / 1_000);
  const provenance =
    `the venue has never once described flatten '${row.idempotency_key}' (resumeFlatten: ` +
    `${context.resumeError}) and the row is ${age}s old — past the ` +
    `${UNRESOLVABLE_FLATTEN_MAX_AGE_MS / 1_000}s bound`;
  const blocked = (reason: string, escalation: ReconcileEscalation): ReconcileDivergence => ({
    idempotency_key: row.idempotency_key,
    instrument: row.instrument,
    store_state: context.storeState,
    broker_state: null,
    action: 'undetermined',
    kind: 'flatten',
    reason,
    escalation,
  });

  if (!cancelDue(row, now)) {
    return blocked(
      `${provenance}. Already cancelled at the venue at ` +
        `${row.cancel_attempted_at?.toISOString()}; still blocking, and not re-cancelled or ` +
        're-paged this pass (FLATTEN_CANCEL_RETRY_EVERY_MS)',
      'never_confirmed_throttled',
    );
  }

  await input.store.markFlattenCancelAttempted(row.idempotency_key, now);
  try {
    await input.broker.cancel(row.idempotency_key, row.instrument);
  } catch (error) {
    const reason = `${provenance}. The cancel FAILED (${describeThrownSafely(error)}); the row keeps blocking`;
    await postFlattenReconcileAlert(input, row, reason, now);
    return blocked(reason, 'never_confirmed_cancel_failed');
  }

  // Read AFTER the cancel resolves, never a snapshot taken before it: a fill
  // can land while the cancel is in flight (and a venue's position view lags
  // its own fill processing), and a pre-cancel snapshot would answer for a book
  // that no longer exists — releasing the row on coverage the venue no longer
  // has, which is the #516/#1389 over-sell this check exists to refuse.
  const coverage = await venueCoversStoreHeld(input, row, storePositions);
  if (!coverage.covered) {
    const reason =
      `${provenance}. It was CANCELLED at the venue, but ${coverage.note}, so the row keeps ` +
      'blocking rather than let a replacement be sized off a held quantity that may be too ' +
      'big. The fills cannot be ingested through an adapter that will not describe this ' +
      'order: attribute them by hand';
    await postFlattenReconcileAlert(input, row, reason, now);
    return blocked(reason, 'never_confirmed_coverage_short');
  }

  const reason =
    `${provenance}. It was CANCELLED at the venue, and ${coverage.note} — so no replacement ` +
    'can over-sell, and the journal row is resolved rather than left blocking every later ' +
    'flatten on the instrument. A fill arriving later is still attributed to the lots this ' +
    'flatten named (getFlattenAttribution does not filter on status)';
  await postFlattenReconcileAlert(input, row, reason, now);
  await input.store.resolveFlattenError(row.idempotency_key, reason, now);
  return {
    idempotency_key: row.idempotency_key,
    instrument: row.instrument,
    store_state: context.storeState,
    broker_state: null,
    action: 'rejected',
    kind: 'flatten',
    reason,
  };
}

/** Fire-and-forget, fully swallowed — the alert IS the fallback; see `FlattenReconcileAlertChannel`'s doc. */
async function postFlattenReconcileAlert(
  input: ReconcileInput,
  row: UnresolvedFlattenSubmission,
  reason: string,
  now: Date,
): Promise<void> {
  try {
    await input.flattenReconcileAlerts.postFlattenReconcileAlert({
      // #1331: this surface's own id, which carries the `control-arm-` prefix
      // when the control arm is the one sweeping — see
      // `FlattenReconcileAlert.trace_id` for what makes that hold. The same id
      // the send-failure log below uses, so a failed alert and the alert it
      // failed to deliver land under one trace.
      trace_id: input.trace_id,
      idempotency_key: row.idempotency_key,
      instrument: row.instrument,
      reason,
      observed_at: now,
    });
  } catch {
    // The reconcile pass this alert reports on already completed — nothing
    // to undo here, see `ResidualExposureAlert`'s doc for the same posture.
    // #573: traced locally now — this IS the fallback failing, so without
    // this an unresolved flatten's genuine ambiguity is invisible even to
    // someone reading the log. Fixed, self-authored message, never the
    // channel's own error — the same CREDENTIALS posture
    // `alertResidualExposure`'s own channel-failure catch takes
    // (ingest-fills.ts): a Telegram transport failure quotes the
    // request it failed on, which can carry a bot token.
    safeLog(input.logger, {
      trace_id: input.trace_id,
      stage: 'execution',
      event: 'flatten_reconcile_alert_send_failed',
      level: 'error',
      message:
        'postFlattenReconcileAlert delivery failed — an unresolved flatten stays genuinely ' +
        'ambiguous and the operator was not paged; check the venue by hand',
      payload: { idempotency_key: row.idempotency_key, instrument: row.instrument },
    });
  }
}

/**
 * The verdict on a row that has sat TERMINAL with unswept fills for the whole
 * `UNSWEPT_TERMINAL_FLATTEN_MAX_AGE_MS` window — reached at most once per
 * window per row, since every outcome that leaves the row standing re-arms the
 * throttle this is gated on.
 *
 * Released on the same evidence `cancelNeverConfirmedFlatten` uses, never on
 * age, and for the same reason: the venue's own book agreeing with what the
 * store considers held means no replacement can over-sell. The fills are
 * unbooked by construction here (`filled_qty > 0`, `fills_swept_at` null), so
 * the release is never a claim that they reached the store — it is the claim
 * that resolving the row is safe. Any disagreement is the case where those
 * unbooked fills change what is held; no venue number can say which lot each
 * belongs to, so that one keeps blocking and pages for hand attribution.
 */
async function judgeTerminalUnsweptFlatten(
  input: ReconcileInput,
  row: UnresolvedFlattenSubmission,
  order: NormalizedOrder,
  lastExamined: Date,
  storePositions: readonly OpenPosition[],
  storeState: OrderState,
  now: Date,
): Promise<ReconcileDivergence> {
  // Since the LAST look, not since the first: the column is re-armed by every
  // look that does not release, so on a row wedged for days this reads one
  // window, never the whole age. See migration 0063.
  const sat = Math.round((now.getTime() - lastExamined.getTime()) / 1_000);
  const provenance =
    `the venue reports this flatten '${order.order_state}' having filled ${order.filled_qty}, ` +
    `and ${sat}s after this sweep last examined it ingestFills has still not swept its ` +
    `fills — past the ${UNSWEPT_TERMINAL_FLATTEN_MAX_AGE_MS / 60_000}min bound`;
  const coverage = await venueCoversStoreHeld(input, row, storePositions);
  if (!coverage.covered) {
    const reason =
      `${provenance}. ${coverage.note}, so the fills this flatten produced are real and not ` +
      'in the store, and no venue number can say which lot each belongs to. The row keeps ' +
      'blocking: attribute them by hand';
    // Re-armed for the row that stays: the next look — one venue read, one
    // page — is a window away, not one 15s poll away (migration 0063).
    await input.store.markFlattenTerminalUnsweptChecked(row.idempotency_key, now);
    await postFlattenReconcileAlert(input, row, reason, now);
    return {
      idempotency_key: row.idempotency_key,
      instrument: row.instrument,
      store_state: storeState,
      broker_state: order.order_state,
      action: 'undetermined',
      kind: 'flatten',
      reason,
    };
  }
  const reason =
    `${provenance}. ${coverage.note} — so no replacement can over-sell, and the journal row ` +
    'is resolved rather than left blocking every later flatten on the instrument. Its fills ' +
    'are still unswept: this is an INFERENCE that resolving is safe, not a completed sweep, ' +
    'and not a finding that they reached the store';
  await postFlattenReconcileAlert(input, row, reason, now);
  await input.store.resolveFlattenError(row.idempotency_key, reason, now);
  return {
    idempotency_key: row.idempotency_key,
    instrument: row.instrument,
    store_state: storeState,
    broker_state: order.order_state,
    action: 'rejected',
    kind: 'flatten',
    reason,
  };
}

/** Held quantity of one instrument's lots on one OPENING side, per lot, never netted across sides. */
function sumHeld(
  lots: readonly OpenPosition[],
  side: OpenPosition['side'],
  heldByKey: ReadonlyMap<string, number>,
): number {
  return lots
    .filter((lot) => lot.side === side)
    .reduce((sum, lot) => sum + (heldByKey.get(lot.idempotency_key) ?? 0), 0);
}

/**
 * Does the venue's own book AGREE with everything the store thinks it holds
 * for this row's instrument? The single piece of evidence both #1500 release
 * paths rest on: if this flatten closed any quantity the store has not booked,
 * the venue holds LESS than `heldQuantitiesFor` says, and a replacement sized
 * off the store would sell that difference twice (#516/#1389). A surplus is
 * refused too, for the reason given at the test itself.
 *
 * `note` is the evidence in words for the caller's `reason`/alert; the caller
 * appends what it then did. NOT covered is returned for ignorance as well as
 * for a short venue — a book this pass could not read, or one no single number
 * can answer for, is never evidence of coverage.
 *
 * The venue book is read here, per call, deliberately NOT hoisted: a snapshot
 * taken before this sweep's `resumeFlatten` timeouts and venue cancels answers
 * for a book that may no longer exist.
 */
async function venueCoversStoreHeld(
  input: ReconcileInput,
  row: UnresolvedFlattenSubmission,
  storePositions: readonly OpenPosition[],
): Promise<{ covered: boolean; note: string }> {
  const venue = await readVenuePositions(input);
  if ('error' in venue) {
    return {
      covered: false,
      note: `this pass could not read the venue's positions (${venue.error}) to check what it holds`,
    };
  }

  const lots = storePositions.filter((position) => position.instrument === row.instrument);
  const held = await heldQuantitiesFor(lots, (keys) => input.store.getExitFillSizes(keys));
  const heldByKey = new Map(held.map((lot) => [lot.idempotency_key, lot.held]));
  const longHeld = sumHeld(lots, 'buy', heldByKey);
  const shortHeld = sumHeld(lots, 'sell', heldByKey);
  // A venue reports ONE netted position per instrument, so it can corroborate
  // the store's held quantity only while the store's lots are all one way.
  // Lots on BOTH sides net inside the venue's own number, and
  // `heldQuantitiesFor` refuses to pre-sum across lots for that reason
  // (held-quantity.ts) — exactly offsetting sides would otherwise compare 0
  // against 0 and read as coverage on no evidence at all. Keyed on the lots
  // themselves, not on their held sums: an over-closed lot carries a NEGATIVE
  // held, so summing first would net the two sides right back together.
  if (lots.some((lot) => lot.side === 'buy') && lots.some((lot) => lot.side === 'sell')) {
    return {
      covered: false,
      note:
        `the store holds ${longHeld} long and ${shortHeld} short ${row.instrument} across lots ` +
        'and the venue reports one NETTED position per instrument, so no venue number can ' +
        'corroborate both sides',
    };
  }
  // Both sides signed the same way before they are compared:
  // `NormalizedPosition.qty` carries the venue's direction, `held` never does.
  // A venue book that has crossed to the other side of the store's — the
  // #516/#1389 over-sell state — must not read as "still holds everything",
  // which is exactly what comparing magnitudes would say.
  const direction = shortHeld > 0 ? -1 : 1;
  const storeHeld = longHeld + shortHeld;
  const venueQty =
    direction *
    venue.positions
      .filter((position) => position.instrument === row.instrument)
      .reduce((sum, position) => sum + position.qty, 0);
  if (!coversQty(venueQty, storeHeld)) {
    return {
      covered: false,
      note:
        `the venue holds ${venueQty} ${row.instrument} against ${storeHeld} the store still ` +
        'considers held, so something filled that the store has not booked',
    };
  }
  // A SURPLUS is not coverage either, though it passes the test above. The
  // venue holding MORE than the store thinks it holds means some of that book
  // is quantity the store has no lot for, and nothing else reports that:
  // `findUnrecordedVenuePositions` compares instrument PRESENCE, so a surplus
  // on an instrument the store already knows is invisible to it. An unbooked
  // exit fill up to the size of that surplus hides inside it: the sum still
  // covers, while the lot it belonged to is over-stated. That is the same
  // fills-not-booked state as a short venue — no over-sell, since a
  // replacement would be sized off the store's smaller number, but a released
  // row whose fills are missing from the journal, and the PnL and CGT record
  // with them. Coverage is therefore agreement, tested both ways under the one
  // flatness tolerance.
  if (!coversQty(storeHeld, venueQty)) {
    return {
      covered: false,
      note:
        `the venue holds ${venueQty} ${row.instrument} against ${storeHeld} the store considers ` +
        'held — a surplus the store has no lot for, which an unbooked exit fill of its size ' +
        'would hide inside, so this book cannot corroborate the store',
    };
  }
  // Nothing held is coverage for the only question this answers — a
  // replacement sized off the store cannot over-sell what the store does not
  // hold — but it is coverage on an EMPTY comparison, so the note must not
  // borrow the language of the corroborated case below and claim the venue
  // confirmed anything about this flatten's fills.
  if (storeHeld === 0) {
    return {
      covered: true,
      note:
        `the store holds no ${row.instrument} for this flatten to close, so nothing it could ` +
        'still be owed is at risk — the venue book says nothing either way about what filled',
    };
  }
  return {
    covered: true,
    note:
      `the venue still holds ${venueQty} ${row.instrument} — everything the store considers ` +
      `held (${storeHeld})`,
  };
}

/**
 * The venue's own book. A failure is carried as a value rather than thrown:
 * every consumer treats "the venue could not be asked" as ignorance to report,
 * never as evidence — `findUnrecordedVenuePositions` reports the gap in its
 * scan, and `venueCoversStoreHeld` answers NOT covered.
 */
async function readVenuePositions(input: ReconcileInput): Promise<VenuePositions> {
  try {
    return { positions: await input.broker.getOpenPositions() };
  } catch (error) {
    return { error: describeThrownSafely(error) };
  }
}

/**
 * The OTHER direction (#429). Everything above walks the STORE's lots and asks
 * the venue about each, which can only ever find a lot the store knows about.
 * execution-spec.md's requirement is symmetric — *"store shows a position the
 * broker doesn't, **or vice-versa**"* — and the second half had no surface
 * until `BrokerAdapter.getOpenPositions` existed.
 *
 * What it catches: a write-ahead that died before persisting, an order placed
 * by hand, or a lot whose store record was lost. Such a position is invisible
 * to Risk's exposure caps indefinitely, because Risk computes exposure from
 * the store.
 *
 * **Nothing is written, deliberately.** An `OpenPosition` carries a
 * `debate_id`, an entry bracket, a conviction and a stop; a venue position
 * carries none of them. Adopting one would mean inventing all of it, and would
 * insert an UNPROTECTED position — no stop, no target — into a system whose
 * every other lot has a bracket, where `ingestFills` would then try to size
 * protective legs that do not exist. Reporting it is the honest action; what to
 * do about it is the operator's call.
 *
 * A venue that cannot answer is reported, not fatal: the store-side pass has
 * already done real work by this point, and losing it because a positions
 * endpoint was down would be the worse outcome.
 *
 * #1550: it also PAGES. The divergence it returns reaches `logger.log` at
 * `warn` (`reconcileDivergenceLevel`, fill-sync.ts) and nothing escalated off
 * that, which left the one exposure the Risk Manager structurally cannot see
 * audible only to an operator reading the stream. The page is raised from
 * here, not from the poll loop, because this is where the venue read that
 * established it lives — and it is throttled per instrument, because the
 * condition is a standing state this re-derives on every 15s pass, not an
 * event (see `UnrecordedVenuePositionThrottle`).
 *
 * The page covers `action: 'unrecorded'` rows ONLY, never the venue-read
 * failure above: a positions endpoint that is down says nothing about whether
 * an exposure exists, and paging on it would page continuously through an
 * outage while proving nothing. That row still reaches the log at `warn` as
 * `undetermined`, which is what it is.
 */
async function findUnrecordedVenuePositions(
  input: ReconcileInput,
  venue: VenuePositions,
  storePositions: readonly OpenPosition[],
  now: Date,
): Promise<ReconcileDivergence[]> {
  if ('error' in venue) {
    // Deliberately no `throttle.dueFor([])`: forgetting every standing episode
    // on a read that proved nothing would re-page the lot of them the instant
    // the endpoint recovered. See that method's own doc.
    return [
      {
        idempotency_key: '',
        instrument: '',
        store_state: 'pending',
        broker_state: null,
        action: 'undetermined',
        kind: 'unrecorded',
        reason:
          'broker.getOpenPositions failed, so a position the venue holds and the store does ' +
          `not would not have been seen this pass: ${venue.error}`,
      },
    ];
  }
  const venuePositions = venue.positions;

  // Compared per INSTRUMENT, not per lot: a venue reports one netted position
  // where the store may hold several lots, so "the store has any open lot for
  // this instrument" is the only comparison the two shapes support.
  const known = new Set(storePositions.map((position) => position.instrument));

  const unrecorded = venuePositions.filter((venuePosition) => !known.has(venuePosition.instrument));
  await pageUnrecordedVenuePositions(input, unrecorded, now);

  return unrecorded.map((venuePosition) => ({
    // No idempotency key exists — this lot was never written under one, which
    // is precisely the finding.
    idempotency_key: '',
    instrument: venuePosition.instrument,
    store_state: 'pending' as const,
    broker_state: null,
    action: 'unrecorded' as const,
    kind: 'unrecorded' as const,
    reason:
      `venue holds ${venuePosition.qty} ${venuePosition.instrument} (${venuePosition.side}) ` +
      'with no open lot in the store — this exposure is invisible to the Risk Manager. ' +
      'Nothing was written: adopting it would mean inventing the bracket, stop and debate_id ' +
      'it has none of. Reconcile it by hand.',
  }));
}

/**
 * #1550: the page behind `findUnrecordedVenuePositions`' divergence rows.
 *
 * Throttled per instrument (`UnrecordedVenuePositionThrottle`), and never
 * allowed to fail the reconcile pass: the scan's job is to REPORT, the
 * divergence rows are returned either way, and a transport that cannot deliver
 * must not cost the sweeps that already ran this pass.
 */
async function pageUnrecordedVenuePositions(
  input: ReconcileInput,
  unrecorded: readonly NormalizedPosition[],
  now: Date,
): Promise<void> {
  const due = new Set(
    input.unrecordedVenuePositionThrottle.dueFor(
      unrecorded.map((venuePosition) => venuePosition.instrument),
      now,
    ),
  );

  for (const venuePosition of unrecorded) {
    if (!due.has(venuePosition.instrument)) continue;
    try {
      await input.unrecordedVenuePositionAlerts.postUnrecordedVenuePositionAlert({
        // This surface's own id, carrying the `control-arm-` prefix when the
        // control arm is the one scanning — the same field the catalogue's
        // `page` predicate reads to keep a simulated broker off the phone.
        trace_id: input.trace_id,
        instrument: venuePosition.instrument,
        qty: venuePosition.qty,
        side: venuePosition.side,
        observed_at: now,
      });
    } catch {
      // Fixed, self-authored message, never the channel's own error — the
      // CREDENTIALS posture `postFlattenReconcileAlert` above documents.
      safeLog(input.logger, {
        trace_id: input.trace_id,
        stage: 'execution',
        event: 'unrecorded_venue_position_alert_send_failed',
        level: 'error',
        message:
          'postUnrecordedVenuePositionAlert delivery failed — a venue position no open lot ' +
          'explains stays invisible to the Risk Manager and the operator was not paged; ' +
          'see the unrecorded divergence line for this instrument',
        payload: { instrument: venuePosition.instrument },
      });
    }
  }
}

/** Settle one lot against the venue. Null when store and broker agree. */
async function reconcileLot(
  input: ReconcileInput,
  position: OpenPosition,
): Promise<ReconcileDivergence | null> {
  const { broker, store } = input;
  const key = position.idempotency_key;

  let order: Awaited<ReturnType<typeof broker.getOrder>>;
  try {
    order = await broker.getOrder(key, position.instrument);
  } catch (error) {
    // The adapter could not answer — which is NOT evidence of anything. The
    // record is left exactly as it was: treating ignorance as "never placed"
    // would mark a live, possibly filled position `rejected` and hide real
    // exposure from Risk, and treating it as "landed" invents a state the
    // venue never reported. It surfaces for an operator instead. (An
    // adapter's `getOrder` may complete a venue-side cleanup of its own —
    // e.g. cancelling orders it has independently confirmed dead — before it
    // throws; a throw here says nothing about whether that cleanup ran, and
    // a retry is safe because such cleanup is idempotent by construction.)
    return {
      idempotency_key: key,
      instrument: position.instrument,
      store_state: position.order_state,
      broker_state: null,
      action: 'undetermined',
      kind: 'bracket',
      // Safe to surface verbatim ON CREDENTIALS: #297's H1 makes every adapter
      // convert what its client threw into a `BrokerError` built only from
      // curated fields. Same posture and same expression as `execute()`'s
      // submit-failure branch.
      //
      // That is NOT the same as "only a `BrokerError` reaches this catch", and
      // #1262 checked: `AlpacaBrokerAdapter.getOrder` does real work OUTSIDE
      // the `call()` wrapper H1 lives in — `state.recordBracketOrderIds`,
      // `normalizeOrder`, the emulation lookups — whose throws never pass
      // through `sanitizeBrokerError` at all; and `sanitizeBrokerError` itself
      // reads `status`/`code`/`venueMessage` off the raw thrown value, so a
      // hostile getter throws from inside `call`'s own catch and delivers
      // whatever IT threw onward. So the render is guarded rather than trusted
      // — a throw here would escape the catch that exists to report the
      // adapter's silence and would leave the lot with no divergence at all.
      reason: describeThrownSafely(error),
    };
  }

  if (order === null) {
    // The venue authoritatively has no such order: the write-ahead never
    // landed. Marking it terminal is what frees the lot from the in-flight
    // set without ever re-submitting it — the bracket cannot be rebuilt from
    // an `OpenPosition` anyway (it carries no entry price or time-in-force),
    // so a resubmit here would be fabricating an order, not recovering one.
    await store.updatePositionState(key, { order_state: 'rejected', broker_order_ids: [] });

    return {
      idempotency_key: key,
      instrument: position.instrument,
      store_state: position.order_state,
      broker_state: null,
      action: 'rejected',
      kind: 'bracket',
      reason: 'broker has no order under this client_order_id — the write-ahead never landed',
    };
  }

  if (agrees(position, order)) return null;

  // Broker is the tie-break authority, so its state is adopted wholesale.
  // Only `order_state`/`broker_order_ids` though: `filled_size` stays at
  // whatever the `Fill` rows say, because those rows are the record and
  // `ingestFills()` rebuilds from them. A lot adopted as `filled` here is
  // still non-terminal, so it stays in `getOpenPositions()` and the very next
  // `ingestFills()` supplies the quantity and price to match.
  await store.updatePositionState(key, {
    order_state: order.order_state,
    broker_order_ids: order.broker_order_ids,
  });

  return {
    idempotency_key: key,
    instrument: position.instrument,
    store_state: position.order_state,
    broker_state: order.order_state,
    action: 'adopted',
    kind: 'bracket',
    reason: `store said '${position.order_state}', broker says '${order.order_state}'`,
  };
}

/**
 * Agreement is on state AND the venue's leg ids: a lot the store believes is
 * `pending` but which the venue acked carries ids the store never recorded,
 * and losing them would leave nothing to cancel the bracket by.
 */
function agrees(
  position: OpenPosition,
  order: { order_state: OrderState; broker_order_ids: string[] },
): boolean {
  return (
    position.order_state === order.order_state &&
    sameIds(position.broker_order_ids, order.broker_order_ids)
  );
}

function sameIds(stored: readonly string[], broker: readonly string[]): boolean {
  return stored.length === broker.length && stored.every((id, index) => id === broker[index]);
}
