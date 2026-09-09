/**
 * Held-first ordering of a tick plan (#1390).
 *
 * ## The defect this closes
 *
 * `UniverseScheduler.nextTick` (`scheduler.ts`) returns the configured
 * universe in its fixed, held-status-unaware order on every tick, and
 * `TailSequencer` (`tick-loop.ts`) grants the portfolio-mutating tail
 * STRICTLY in that plan order — `begin(i)` does not resolve until every
 * index below `i` has fully settled, heads included (`tick-loop.ts`'s own
 * "tail order is plan order, not completion order" invariant, #1040). A held
 * instrument sitting late in the fixed order therefore queues behind every
 * earlier instrument's WHOLE pass, decision debate included, before its own
 * flatten can even reach the Trader.
 *
 * The 2026-09-08 incident measured exactly this: a 19:58:19.942Z tick inside
 * the flatten window found all 20 configured instruments still claimed by an
 * earlier, still-running pass and ran 0. Of 9 held control lots, only the two
 * that happened to sit first in `DEFAULT_UNIVERSE` (QQQ, AAPL) flattened in
 * time.
 *
 * ## Why this reorders every tick, not only inside the flatten window
 *
 * A window gate would need to know the CLAIMING pass — the one actually in
 * flight when the window opens — was itself built inside the window. It
 * was not: the incident's Trader arrivals ran from 19:58:27 to 20:02:02 (a
 * single pass taking 6+ minutes against the configured tick interval), so the
 * pass serving the window was claimed before the window opened. A predicate
 * gated on "is `tick_time` inside the flatten window" is dead on arrival
 * against the exact case the ticket measured — at saturation the plan that
 * matters is never built while the window's own clock read is current.
 *
 * The ticket's own constraint rules this out on principle, not just on this
 * one incident: "The tail must be correct at whatever throughput the pass
 * happens to have." A policy that depends on knowing how long a pass runs is
 * a throughput dependency in a different shape. Ordering held-first
 * unconditionally has no such dependency, and for FLATTEN COVERAGE it is a
 * strict superset of "inside the window, held before flat" — every held lot
 * that would have been reached by a window-gated reorder is still reached
 * here. It is not a superset in every respect: reordering runs on EVERY tick,
 * not only inside the window, so on a saturated pass outside the window it
 * also pushes flat instruments to the back — costing them entry timing, not
 * just flatten timing. That cost is accepted, not incidental: ADR-0014's
 * flat-by-close obligation is mandatory and an entry is not, so a saturated
 * pass should spend its limited throughput on the obligation first.
 *
 * ## Why the wholesale "still running from a previous pass" skip is left alone
 *
 * `production.ts`'s `running` Map guard (#669) still drops every instrument a
 * still-in-flight pass claimed, every tick, unconditionally — that guard's
 * job is preventing double-dispatch of one instrument, not scheduling. This
 * file does not touch it. Deferral is safe once every pass is held-first
 * ordered — for BOTH arms; `production.ts`'s `heldAssets` reader
 * (`buildHeldAssetsReader`) unions the live and control-arm stores for
 * exactly this reason, since a held-only-for-one-arm set would leave the
 * other arm's held lots exactly as unprioritized as no fix at all — because
 * the reason a busy tick is safe to skip is that the pass OWNING those
 * instruments is now working through them held-first itself: a held lot
 * delayed by a busy skip is delayed behind the same in-flight pass's own
 * held-priority tail, not behind that pass's flat instruments. Re-dispatch
 * (pre-emption) would reintroduce the double-dispatch #669 exists to forbid,
 * for a case this reordering already removes the harm from.
 *
 * This safety is bounded by when the held set was READ, not by anything the
 * in-flight pass does afterward: `heldAssets()` is called once per pass, at
 * plan-build time (`production.ts`'s `runOnce`), so a lot opened AFTER that
 * read has no priority for that pass's entire lifetime — 6+ minutes in the
 * incident. Such a lot is ordered as flat until the NEXT pass reads a fresh
 * held set, not re-prioritized mid-pass.
 *
 * ## Coverage bound (state it, don't leave it emergent)
 *
 * `assertFlattenWindowCoversTickInterval` (`production/flatten-tick-coupling.ts`)
 * already guarantees at least `MIN_TICKS_INSIDE_FLATTEN_WINDOW` (2) ticks land
 * inside `[sessionEnd - flatten_before_close_ms, sessionEnd)`. Within one such
 * tick, tails run strictly one instrument at a time (`TailSequencer`), each
 * bounded by `DEFAULT_CRITIC_BUDGET_MS` (10s, `risk-manager/critic.ts`) plus
 * sub-second book operations — so one tick clears roughly
 * `tickIntervalMs / (DEFAULT_CRITIC_BUDGET_MS + book overhead)` tails, held
 * ones first. A universe holding more lots than that bound, across the
 * guaranteed ticks, minus whatever an in-flight prior pass already consumed,
 * WILL miss the excess — held-first ordering guarantees those lots are tried
 * first, not that every held lot fits. A lot beyond the bound is a miss, and
 * #1389 (a missed lot gets no second chance) owns that consequence; this file
 * only maximizes how many held lots the available throughput reaches.
 */

/**
 * Stably partitions `instruments` into held-first order: every instrument
 * whose asset is in `heldAssets` moves ahead of every instrument that is not,
 * with each group's own relative order preserved.
 *
 * Stable, not sorted by any other key — sorting would be free to reorder
 * within a group, and `TailSequencer` grants tails in plan order, so an
 * unstable reorder would make WHICH held lot goes first depend on the sort
 * implementation rather than on the scheduler's own configured order.
 */
export function orderHeldFirst<T extends { readonly asset: string }>(
  instruments: readonly T[],
  heldAssets: ReadonlySet<string>,
): T[] {
  const held: T[] = [];
  const flat: T[] = [];
  for (const instrument of instruments) {
    (heldAssets.has(instrument.asset) ? held : flat).push(instrument);
  }
  return [...held, ...flat];
}
