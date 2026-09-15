/**
 * #1186: the terminal action for a lot `ingest-fills.ts`'s `FILLED_WITH_ZERO_SIZE`
 * throttle only ever WARNS about.
 *
 * ## The gap this closes
 *
 * A lot `reconcile()` adopts as `filled`/`partially_filled` (broker truth)
 * whose `filled_size` stays zero (`Fill` rows say otherwise) has no path back
 * to a live state and no sweep that already covers it:
 *
 * - `reconcile()`'s own bracket pass only revisits `pending`/`submitted`
 *   (`IN_FLIGHT_ORDER_STATES`, reconcile.ts) — this lot is neither.
 * - `sweepResidualProtection` (#549) keys on `residual_unprotected_since`,
 *   which this lot never sets — nothing was ever flattened.
 * - `sweepTerminalPositions` (#1088) only deletes ALREADY-terminal rows; this
 *   lot is not terminal yet, which is exactly the problem.
 * - `ingestFills()`'s `advanceLot` only recomputes state from a NEW fill
 *   (`newFills.length === 0` returns early) — and once no more `Fill` rows
 *   will ever be recorded for THIS lot, nothing in this store revisits it
 *   again. That "no more fills" state has more than one cause: #1096 fixed
 *   the since-floor defect that excluded a real fill forever for the
 *   incident's META row (`simulated-adapter.ts`); #1302's unresolved-
 *   price-unit refusal is a still-live route where a fill is deliberately
 *   never booked. Either way — or any future defect of the same shape —
 *   the lot is stuck, and this store has no mechanism that ever looks at it
 *   again without this sweep.
 *
 * `FilledZeroSizeThrottle` (filled-zero-size-throttle.ts) bounds the LOG
 * volume this condition produces, not its LIFETIME — its own doc names this
 * sweep as the mechanism that closes that gap.
 *
 * ## Store evidence only — no venue call, ever
 *
 * This function decides entirely from the STORE's own ledger
 * (`OpenPosition.order_state`/`filled_size`/`opened_at`) and never calls
 * `BrokerAdapter` at all — so #1215's rule (no order is cancelled or
 * re-placed without audit evidence) is satisfied trivially. That is NOT the
 * same claim as "this lot has no venue position": `order_state` is
 * `filled`/`partially_filled` because the VENUE reported it, and
 * `filled_size = 0` means only that this store's `Fill` rows disagree with
 * that report — not that none exist (see #1096/#1302 above). Retiring the
 * row is a bookkeeping close of OUR record, never a claim about the venue's
 * book. `findUnrecordedVenuePositions` (reconcile.ts, run immediately after
 * this sweep, every pass) is the mechanism that actually reconciles the
 * venue's positions against the store's — it is the backstop that surfaces
 * a real position in this instrument, at `info`
 * (`reconcileDivergenceLevel`, apps/orchestrator/fill-sync.ts), on the very
 * next pass if the venue turns out to hold one. Being store-only, rather
 * than store-evidence-plus-a-venue-position-claim, is what makes this safe
 * to run unconditionally on every `reconcile()` pass — including the very
 * first one after a restart, before any adapter has rebuilt a shred of
 * in-memory state about the lot (the exact position a restart leaves the
 * system in, per #1186's AC).
 *
 * ## Auto-retire, not an operator alert
 *
 * #1186's AC offers two shapes: auto-retire within a bounded window, or (if
 * no automatic remediation is judged safe) escalate to an operator alert.
 * This takes the first, and deliberately adds no new `AlertChannelSlots`
 * transport:
 *
 * - The ACTION ITSELF has no live-money consequence to get wrong: it only
 *   ever rewrites `open_positions` (never touches the venue), so the worst
 *   case is a bookkeeping row saying `abandoned` about a lot that turns out
 *   to still have real venue exposure — and that worst case already has its
 *   own backstop, `findUnrecordedVenuePositions` (see "Store evidence only"
 *   above), independent of whether THIS sweep ever ran. Every OTHER
 *   escalation in this module (`ResidualExposureAlert`, `FlattenReconcileAlert`,
 *   `FlattenOverfillWarning`) exists because the system might be silently
 *   exposed at the venue and no other mechanism would notice; this sweep is
 *   not that case, because the venue-exposure question is already someone
 *   else's job. There is no decision left for an operator to make that
 *   retiring this row, specifically, would change.
 * - The record is not lost. `abandon_reason` (migration 0056) is written to
 *   the row itself — durable, queryable, surviving every future restart —
 *   which is a STRONGER trace than a transient alert delivery would be. The
 *   reconcile divergence this returns still reaches the log at `info`
 *   (`reconcileDivergenceLevel`, fill-sync.ts) exactly like every other sweep
 *   outcome, so an operator scanning the log sees it happen without a paging
 *   channel existing solely to repeat what the row already says.
 *
 * ## The bounded window
 *
 * `WEDGED_ZERO_FILL_ABANDON_AFTER_MS` is deliberately NOT tuned to
 * `ingestFills()`'s poll cadence the way `FilledZeroSizeThrottle`'s constants
 * are — see this constant's own doc for why a wall-clock day, not a poll
 * count, is the right shape here.
 */

import { describeThrownSafely, logCaughtFailure } from '../../shared/index.js';
import { isWedgedZeroFillLot } from '../../shared/store/index.js';
import type { ReconcileDivergence, WedgedSweepInput } from './types.js';

/**
 * How long a lot may sit `filled`/`partially_filled` with `filled_size = 0`
 * before this sweep retires it — measured from `opened_at`, the same anchor
 * `ingest-fills.ts`'s own `stuck_ms` payload already uses (there is no
 * earlier durable timestamp for a lot in this state: it can only have gone
 * wedged close to when it opened, per that file's own comment).
 *
 * 24 hours. ADR-0014's horizon is intraday, flat-by-close: every LEGITIMATE
 * lot's `filled_size` moves off zero, or the lot round-trips to `closed`,
 * inside the SAME trading day it opened — `buildExitIntent` (trader/decide.ts)
 * targets every still-open lot in the flat-by-close window regardless of
 * `filled_size`. A lot still reporting zero a full calendar day later cannot
 * be legitimate propagation lag (`ingest-fills.ts`'s own doc: Alpaca lags "a
 * poll or two", seconds to low minutes, not hours) and cannot be waiting on a
 * same-day flatten that has not run yet either — it is structurally dead.
 * Wide margin, deliberately: this window trades promptness for certainty,
 * since the only cost of waiting is `#753`'s control-arm data point staying
 * unproduced a little longer, not live exposure (see the file doc's "store
 * evidence only" section — there is none to protect).
 */
export const WEDGED_ZERO_FILL_ABANDON_AFTER_MS = 24 * 60 * 60 * 1_000;

/** What one pass of the #1186 sweep examined and retired. */
export interface WedgedZeroFillSweepResult {
  checked: number;
  divergences: ReconcileDivergence[];
}

/**
 * One `reconcile()`-cadence pass (startup and #921's periodic poll, live and
 * control arm alike — the same two call sites every other `reconcile()`
 * sweep gets for free). Cheap when healthy: no lot matches, no store write.
 *
 * Each candidate lot is independent work under its own containment, the same
 * shape `sweepResidualProtection` uses (residual-protection-sweep.ts): a
 * store failure retiring one lot must not stop this pass from retiring every
 * OTHER wedged lot it found, and a durable cause (a corrupt row) must not
 * make every future pass abort identically forever.
 */
export async function sweepWedgedZeroFillLots(
  input: WedgedSweepInput,
): Promise<WedgedZeroFillSweepResult> {
  const { store, clock, logger, trace_id } = input;
  const now = clock.now();

  const positions = await store.getOpenPositions();
  const wedged = positions.filter(
    (position) =>
      isWedgedZeroFillLot(position) &&
      now.getTime() - position.opened_at.getTime() >= WEDGED_ZERO_FILL_ABANDON_AFTER_MS,
  );

  const divergences: ReconcileDivergence[] = [];
  for (const position of wedged) {
    const stuckMs = now.getTime() - position.opened_at.getTime();
    const reason =
      `wedged zero-fill lot: order_state '${position.order_state}' with filled_size 0 for ` +
      `${stuckMs}ms (>= the ${WEDGED_ZERO_FILL_ABANDON_AFTER_MS}ms bounded window) — no fill ` +
      'can ever land for it (ingest-fills.ts advanceLot only advances on a new fill); retired ' +
      'to a bookkeeping terminal state on store evidence alone, no venue call made (#1186)';

    try {
      const abandoned = await store.abandonWedgedZeroFillLot(position.idempotency_key, reason);
      if (!abandoned) {
        // `abandonWedgedZeroFillLot`'s SQL WHERE-guard (sqlite-shared-store.ts)
        // restates this shape rather than sharing `isWedgedZeroFillLot` — a
        // SQL string cannot import a TS predicate (#1601). A no-op UPDATE is
        // ambiguous between two causes this re-check tells apart: a fresh
        // read still matching `isWedgedZeroFillLot` means the SQL guard
        // rejected a row the TS predicate still calls wedged — the two
        // copies of this shape have diverged, not a race — while a fresh
        // read that no longer matches (including the lot having gone
        // terminal, so it drops out of `getOpenPositions()` entirely) means
        // a fill landed (or some other terminal transition happened) between
        // the worklist read and this write, exactly what the WHERE-guard
        // exists to detect: the lot un-wedged itself, and the next
        // `advanceLot`/reconcile pass already owns whatever state it is in
        // now.
        const stillWedged = (await store.getOpenPositions()).some(
          (open) => open.idempotency_key === position.idempotency_key && isWedgedZeroFillLot(open),
        );
        if (stillWedged) {
          divergences.push({
            idempotency_key: position.idempotency_key,
            instrument: position.instrument,
            store_state: position.order_state,
            broker_state: null,
            action: 'undetermined',
            kind: 'sweep',
            reason:
              `wedged-zero-fill shape mismatch: isWedgedZeroFillLot still matches ` +
              `'${position.idempotency_key}' but abandonWedgedZeroFillLot's SQL guard did not ` +
              '— the TS predicate and its SQL restatement have diverged (#1601)',
            escalation: 'sweep_shape_mismatch',
          });
        }
        continue;
      }
      divergences.push({
        idempotency_key: position.idempotency_key,
        instrument: position.instrument,
        store_state: position.order_state,
        broker_state: null,
        action: 'adopted',
        kind: 'sweep',
        reason,
      });
    } catch (error) {
      logCaughtFailure(
        logger,
        {
          trace_id,
          stage: 'execution',
          event: 'wedged_zero_fill_abandon_failed',
          level: 'error',
          message:
            'sweepWedgedZeroFillLots: abandonWedgedZeroFillLot failed for one wedged lot — it ' +
            'stays wedged and the next pass retries',
        },
        error,
        { idempotency_key: position.idempotency_key },
      );
      divergences.push({
        idempotency_key: position.idempotency_key,
        instrument: position.instrument,
        store_state: position.order_state,
        broker_state: null,
        action: 'undetermined',
        kind: 'sweep',
        reason: `wedged-zero-fill abandon failed: ${describeThrownSafely(error)}`,
        escalation: 'sweep_abandon_failed',
      });
    }
  }

  return { checked: wedged.length, divergences };
}
