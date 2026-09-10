/**
 * The equity tick window = the entry window UNION the flatten tail.
 *
 * ## The defect this exists to close
 *
 * `stocksTradingWindow` (#706) reads as an ENTRY narrowing — that is what its
 * docblock says, what its commit message argued, and what it is for. It is not
 * what it does. `UniverseScheduler.nextTick` uses it to build
 * `TickPlan.instruments`, and `runOnce` runs the WHOLE pipeline pass only for
 * the instruments in that plan. An instrument the window excludes gets no tick
 * at all — no Analysts, no Debate, and no **Trader**.
 *
 * The Trader is the only thing that flattens. `withinFlattenWindow`
 * (`trader/decide.ts:176`) is evaluated on a tick and nowhere else: there is no
 * session-end job, and `fillSync` handles fills rather than positions. So a
 * window that closes at 15:45 removes every tick that could ever land inside
 * `[sessionEnd - flatten_before_close_ms, sessionEnd)`, and the flat-by-close
 * rule ADR-0014 rests on **silently stops running**. `trader_log` reads exactly
 * like a session with nothing to flatten, which is the same signature #691
 * already found on a non-positive window.
 *
 * On the paper venue the gap is not marginal. The window is 14:30-15:45 London
 * = 09:30-10:45 ET, and `UsEquityRegularHoursCalendar` closes at 16:00 ET, so
 * the last tick of the day falls **five hours and ten minutes** before the
 * flatten needs one.
 *
 * ## Why the union is safe rather than merely cheap
 *
 * Re-admitting ticks in the flatten tail cannot open a position: the entry path
 * consults the same window and returns `skip('session_closing')`
 * (`decide.ts:361`), which is checked before any bar is fetched. So the tail
 * ticks can close and can never open — verified at the call site, not taken
 * from the docblock.
 *
 * The gap between the two spans costs nothing that needs a tick:
 *
 *   - **Price exits survive it.** Equity brackets are submitted to the venue as
 *     `order_class: 'bracket'` (`alpaca-adapter.ts:459`), so take-profit and
 *     stop are resting orders at the broker, not something this process
 *     re-evaluates. Only the TIME rule needs a tick, because no venue order
 *     expresses "flat by close".
 *   - **Marks do not go stale from it.** `getMark` fetches through the data
 *     source per call (`service.ts:224`), and `classifyMarkFreshness` compares
 *     `mark.observed_at` against the instant it was read — how long ago the
 *     market spoke, not how long ago we last ticked. A tail tick carries a
 *     fresh mark.
 *   - **Fills are not missed by it.** `ingestFills()` runs on its own cadence,
 *     deliberately not on the tick loop (`production.ts:105-109`).
 *
 * ## Why this is composed here rather than in `SchedulerConfig`
 *
 * The tail is `flatten_before_close_ms` before `sessionEnd`, and the scheduler
 * is handed neither: `TraderConfig` is the Trader's, and `sessionEnd` needs the
 * equity calendar. The composition root is the one place that holds both, and
 * it is already where #668 put the decision that the flatten and the scheduler
 * must resolve through the SAME calendar object. Teaching `SchedulerConfig`
 * about a trader field would reintroduce the two-copies problem
 * `equityCalendarFor` exists to prevent.
 */
import type { TradingCalendar } from '../../../providers/market-data-service/index.js';

/**
 * Widen `entryWindow` to also admit the flatten tail.
 *
 * `instant` is only ever passed here once `calendar.isOpen(instant)` is already
 * true — the scheduler evaluates the window second, and it narrows a session
 * rather than opening one. The `remaining >= 0` bound is kept explicit anyway:
 * a past close is `withinFlattenWindow`'s to answer (it flattens, #691), and
 * this predicate must not be the thing that decides it by accident.
 *
 * A `null` `sessionEnd` is a venue that never closes (`AlwaysOpenCalendar`,
 * #667), which has no tail to add. It returns the entry window unchanged rather
 * than opening the instrument up, since #667 left what flat-by-close means on a
 * 24/7 venue as an open thesis amendment.
 */
export function withFlattenTail(
  entryWindow: (instant: Date) => boolean,
  calendar: TradingCalendar,
  flattenBeforeCloseMs: number,
): (instant: Date) => boolean {
  return (instant: Date): boolean => {
    if (entryWindow(instant)) {
      return true;
    }

    const sessionEnd = calendar.sessionEnd(instant);
    if (sessionEnd === null) {
      return false;
    }

    const remaining = sessionEnd.getTime() - instant.getTime();
    return remaining >= 0 && remaining <= flattenBeforeCloseMs;
  };
}

/**
 * The tail on the OTHER side of the bell (#1389): true while `instant` is
 * within `flattenAfterCloseMs` of the close that has just passed.
 *
 * ## Why this is a separate predicate rather than a widened `withFlattenTail`
 *
 * `withFlattenTail` narrows a session the scheduler has ALREADY decided is
 * open — the scheduler evaluates it only under `calendar.isOpen(instant)`, and
 * its own docblock says so. Widening its bound past the close would produce
 * `true` at instants the conjunct upstream has already turned into `false`, so
 * the extra range would be unreachable and the fix would look landed while
 * doing nothing. That is the #706 failure shape exactly: a predicate that reads
 * correct at the site that cannot reach it.
 *
 * So the grace enters the plan as its OWN, OR'd input
 * (`SchedulerConfig.postCloseFlattenWindow`), and this is what feeds it.
 *
 * ## Why `sessionStart`
 *
 * `sessionEnd` is contractually forward — past the bell it names TOMORROW's
 * close — so it cannot answer "which close just passed". `sessionStart` is
 * documented as the most recent regular or early close AT OR BEFORE the
 * instant, which is that close. The same pair, in the same order, that
 * `withinFlattenWindow` resolves the flatten's own coordinate through: the
 * scheduler and the Trader must agree about which instants are inside the
 * grace, or the plan admits ticks the Trader declines (waste) or withholds
 * ticks it needs (the bug).
 *
 * A `null` `sessionEnd` is a venue that never closes (`AlwaysOpenCalendar`,
 * #667). It has no close to be past, so there is no grace — the same answer
 * `withFlattenTail` gives, and for the same #667 reason.
 */
export function postCloseFlattenTail(
  calendar: TradingCalendar,
  flattenAfterCloseMs: number,
): (instant: Date) => boolean {
  return (instant: Date): boolean => {
    if (calendar.sessionEnd(instant) === null) return false;

    const elapsed = instant.getTime() - calendar.sessionStart(instant).getTime();
    return elapsed >= 0 && elapsed <= flattenAfterCloseMs;
  };
}
