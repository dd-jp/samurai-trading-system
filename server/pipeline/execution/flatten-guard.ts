/**
 * #1500: the Trader-facing half of the flatten guard's age bound.
 *
 * `SharedStore.getUnresolvedFlattens()` stays deliberately unbounded —
 * `reconcile()`'s worklist (reconcile.ts) must keep seeing every unresolved
 * row forever, or a row past `UNRESOLVABLE_FLATTEN_MAX_AGE_MS` would stop
 * being resolved at all, not just stop blocking. What must NOT stay
 * unbounded is what the Trader's `flattenAlreadyInFlight` guard
 * (trader/decide.ts) is allowed to treat as "still in flight": before this,
 * a flatten that was acked but never swept — a wedged fill poll, a venue
 * that keeps confirming a genuinely open order, or one whose adapter never
 * answers `resumeFlatten` at all — blocked every future flatten on that
 * instrument forever, across restarts and trading days, with no operator
 * path but editing SQLite by hand. That is exactly the outcome
 * `UNRESOLVABLE_FLATTEN_MAX_AGE_MS`'s own doc (reconcile.ts) already argues
 * against for `reconcileFlatten`'s narrower branch; this file applies the
 * SAME bound to the guard itself, at the one place the Trader stays
 * age-ignorant on purpose (trader/types.ts's `UnresolvedFlatten` doc): the
 * composition root, not `pipeline/trader`.
 *
 * `writeAheadFlatten`'s own atomic one-flatten-per-instrument check
 * (sqlite-shared-store.ts) carries the identical bound independently — see
 * its doc. Bounding only this read would leave the Trader willing to build
 * a flatten intent that `executeExit`/`reflattenResidual` then refuse at the
 * store, which is the same "instrument un-flattenable forever" outcome one
 * layer down; bounding only the store would leave the Trader still skipping
 * on `flattenAlreadyInFlight` before ever reaching it. Both must hold.
 *
 * ## What ages out is not resolved
 *
 * Unlike `reconcileFlatten`'s own age branch (reconcile.ts), this gate never
 * calls `resolveFlattenError` — the row stays in `flatten_submissions` at
 * whatever status it already had, and `getUnresolvedFlattens()` keeps
 * returning it to `reconcile()` every pass, unchanged. That is deliberate:
 * resolving it here would mean guessing the venue's answer without ever
 * having asked, which is exactly the guess `reconcileFlatten`'s own
 * "one answer, against an aged row" section refuses to make anywhere but on
 * a real (if stale) `resumeFlatten` response. The trade this file makes
 * instead is narrower — stop treating an old row as a reason to refuse a
 * NEW flatten, without asserting anything about what happened to the old
 * one.
 *
 * One consequence of that is worth stating plainly: because the row never
 * leaves the predicate, `boundedUnresolvedFlattens` below re-evaluates the
 * SAME aged-out row as "just crossed the bound" on every call until it
 * either resolves (a fresh `resumeFlatten` answer) or the process restarts.
 * The in-memory alerted-set below exists to keep the alert itself from
 * re-firing on every tick; it is NOT a second resolution mechanism, and a
 * restart re-arms it — see that field's doc.
 */

import type { Clock, Logger } from '../../shared/index.js';
import { describeThrownSafely, safeLog } from '../../shared/index.js';
import type { FlattenReconcileAlertChannel } from './flatten-reconcile-alert.js';
import { isFlattenBlockingAt, UNRESOLVABLE_FLATTEN_MAX_AGE_MS } from './reconcile.js';
import type { SharedStore, UnresolvedFlattenSubmission } from './types.js';

export interface FlattenGuardDeps {
  store: Pick<SharedStore, 'getUnresolvedFlattens'>;
  clock: Clock;
  flattenReconcileAlerts: FlattenReconcileAlertChannel;
  logger: Logger;
  /**
   * Fixed literal identifying which arm's guard raised the alert — the same
   * `control-arm-` prefix convention `FlattenReconcileAlert.trace_id`'s doc
   * describes for `reconcile()`'s own surfaces. Never a per-tick trace id:
   * this function is built once at the composition root and called on every
   * tick, so there is no single tick to attribute the alert to.
   */
  trace_id: string;
}

/**
 * Builds the function `TraderInput.unresolvedFlattens`/
 * `TraderStepDeps.getUnresolvedFlattens` are bound to at the composition
 * root (production.ts, control-arm-wiring.ts) — see this file's own doc for
 * why the bounding lives here and not in `pipeline/execution` or
 * `pipeline/trader` directly.
 */
export function boundedUnresolvedFlattens(
  deps: FlattenGuardDeps,
): () => Promise<UnresolvedFlattenSubmission[]> {
  // #1500: per-row, per-process dedup so an aged-out row that stays
  // unresolved (see file doc) pages an operator once, not on every tick
  // until it resolves. Unbounded in principle, bounded in practice by the
  // same thing that bounds `flatten_submissions` itself — trading activity,
  // not tick count — and cleared on restart, which re-alerts rather than
  // silently drops one, matching `FilledZeroSizeThrottle`'s posture on the
  // same trade-off.
  const alerted = new Set<string>();

  return async () => {
    const rows = await deps.store.getUnresolvedFlattens();
    const now = deps.clock.now();
    const blocking: UnresolvedFlattenSubmission[] = [];
    for (const row of rows) {
      if (isFlattenBlockingAt(row, now)) {
        blocking.push(row);
        continue;
      }
      if (!alerted.has(row.idempotency_key)) {
        alerted.add(row.idempotency_key);
        await postFlattenGuardBoundAlert(deps, row, now);
      }
    }
    return blocking;
  };
}

/** Fire-and-forget, fully swallowed — mirrors `reconcile.ts`'s own `postFlattenReconcileAlert`. */
async function postFlattenGuardBoundAlert(
  deps: FlattenGuardDeps,
  row: UnresolvedFlattenSubmission,
  now: Date,
): Promise<void> {
  const reason =
    `flatten guard bound tripped — this row has been unresolved for longer than ` +
    `UNRESOLVABLE_FLATTEN_MAX_AGE_MS (${UNRESOLVABLE_FLATTEN_MAX_AGE_MS}ms) and no longer blocks ` +
    `a NEW flatten on '${row.instrument}'; the row itself is unchanged and still needs an operator`;
  try {
    await deps.flattenReconcileAlerts.postFlattenReconcileAlert({
      trace_id: deps.trace_id,
      idempotency_key: row.idempotency_key,
      instrument: row.instrument,
      reason,
      observed_at: now,
    });
  } catch (error) {
    safeLog(deps.logger, {
      trace_id: deps.trace_id,
      stage: 'execution',
      event: 'flatten_guard_bound_alert_send_failed',
      level: 'error',
      message:
        'postFlattenReconcileAlert delivery failed for a flatten-guard bound trip — the ' +
        'instrument is flattenable again but the operator was not paged; check by hand',
      payload: {
        idempotency_key: row.idempotency_key,
        instrument: row.instrument,
        error: describeThrownSafely(error),
      },
    });
  }
}
