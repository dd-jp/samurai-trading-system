/**
 * The one invariant that ties the Orchestrator's tick interval to the Trader's
 * flatten window (#670), asserted at boot.
 *
 * ## The failure this exists to stop
 *
 * #668 made flat-by-close fire only while `now` is inside
 * `[sessionEnd − flatten_before_close_ms, sessionEnd)`. The Trader can only
 * evaluate that predicate when a tick actually runs, so the window is not a
 * period of time during which the book flattens — it is a set of instants at
 * which flattening becomes POSSIBLE, and a tick has to land in it.
 *
 * If the tick interval is longer than the window, a tick sequence strides
 * straight over it. Ticks at `close − 10m` and `close + 0m` against a 5-minute
 * window means the predicate is never true on any tick, the position carries
 * overnight, and NOTHING is logged as an error — `trader_log` reads exactly like
 * a session with nothing to flatten. That is the precise outcome ADR-0014's
 * flat-by-close rule exists to prevent, arrived at silently.
 *
 * This was live, not hypothetical: the paper profile shipped `tickIntervalMs`
 * at 15 minutes against a `flatten_before_close_ms` of 5.
 *
 * **And the failure does not vary from session to session — it is decided once,
 * at boot, for the whole run.** Ticks land at `bootTime + k * tickIntervalMs`,
 * so the phase is a property of the process, not of the day. A session close
 * recurs every 24 hours, and 24 hours is an exact multiple of both 15 minutes
 * (96) and 2 minutes (720), so the offset between the tick grid and the close
 * is IDENTICAL every session. Either a tick lands in the window every day or it
 * lands in it on no day at all, determined by nothing but when the process
 * happened to start.
 *
 * That is worse than an intermittent fault and it is why this is a boot
 * assertion. An intermittent flatten would at least show up in the positions
 * table as an inconsistency somebody might chase; a run that started on the
 * wrong phase never flattens once in fourteen days, and looks from the inside
 * exactly like a run with nothing to flatten.
 *
 * ## Why an assertion rather than a comment
 *
 * The two knobs live in different configs, owned by different stages, and
 * neither one is wrong on its own. Someone tuning cadence for cost (#670's
 * whole subject) has no reason to know the flatten window exists, and someone
 * tightening the flatten window to reduce end-of-day slippage has no reason to
 * look at the tick rate. A comment does not guard a value someone flips without
 * reading it — the same argument `assertAutomationLevelSupported` and
 * `assertTraderConfigSound` are placed on in `buildProductionComponents`.
 *
 * Failing at BOOT is the point. The alternative is a soak that starts cleanly,
 * looks healthy for fourteen days, and is discovered to have carried overnight
 * against its own horizon only when someone reads the positions table.
 *
 * ## What this deliberately does NOT guard
 *
 * Only the window's LOWER bound. A `flatten_before_close_ms` at or above the
 * session length makes `[sessionEnd − W, sessionEnd)` true at every instant of
 * the session, so the book flattens on every tick and can never hold a
 * position — and this function would accept it (raised in #711 review).
 *
 * Left unguarded for two reasons, neither of them "it cannot happen".
 *
 * First, the composition root does not know the session length. It has two
 * numbers; the session boundary lives behind `TradingCalendar` and differs per
 * venue and per half-day. A hardcoded 24h ceiling here would be a number
 * invented at the wrong layer, and it would still accept a 7h window against a
 * 6.5h LSE session — the case that actually bites.
 *
 * Second, the two failure modes are not symmetric in how they are discovered.
 * A window too NARROW is silent: nothing flattens, nothing logs, and the
 * positions table is the only witness. A window too WIDE is loud in outcome:
 * the strategy holds nothing, the trade count is zero, and it is visible on the
 * first day rather than the fourteenth. This assertion exists for the silent
 * one.
 *
 * The honest consequence is that the test fixtures below park the window at
 * hours-wide values to keep timers quiet, and a value like that copied into a
 * real profile would be an always-flatten config that boots happily. Bounding
 * it properly needs the calendar, which is #712's `withFlattenTail` territory,
 * not this file's.
 */
import type { TraderConfig } from '../../../pipeline/trader/index.js';

/**
 * How many tick intervals must fit inside the flatten window.
 *
 * **One would be the bare arithmetic minimum.** Ticks are an arithmetic
 * progression spaced `tickIntervalMs` apart, so a half-open interval of length
 * `W` contains at least one tick exactly when `W >= tickIntervalMs`. At equality
 * it contains precisely one, and that one is load-bearing.
 *
 * **Two is what makes it survive a real run.** The single tick the minimum
 * guarantees is not guaranteed to EXECUTE: `production.ts` drops a whole tick
 * when the previous one is still running (#669), and the interval timer drifts.
 * Requiring two ticks buys tolerance for ONE arbitrary lost tick.
 *
 * It is deliberately not claimed to be a general safety factor. #669's drops are
 * not independent events — a pass slow enough to eat one tick is the same pass
 * that may still be running at the next, so consecutive drops are correlated and
 * two ticks do not make the flatten twice as likely to land. Two is the smallest
 * margin above the arithmetic minimum, chosen because the minimum has no margin
 * at all, and NOT because a run of drops has been shown to be impossible.
 * Raising it is a cost decision (a wider window flattens earlier and gives up
 * end-of-day exposure), so it stays at the smallest defensible value.
 */
export const MIN_TICKS_INSIDE_FLATTEN_WINDOW = 2;

/**
 * Throws unless the flatten window is wide enough for the tick rate to land
 * inside it with a tick to spare.
 *
 * `tickIntervalMs` is the EFFECTIVE value — resolve
 * `config.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS` before calling, because
 * the default is what an unset config actually runs at and asserting on
 * `undefined` would exempt precisely the callers who never thought about it.
 */
export function assertFlattenWindowCoversTickInterval(
  traderConfig: TraderConfig,
  tickIntervalMs: number,
): void {
  // Guarded FIRST, because a bad interval makes the real check pass vacuously
  // rather than fail. `config.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS`
  // substitutes only for null/undefined, so a configured `0` survives the
  // nullish coalesce, `required` becomes 0, and every window on earth clears
  // it — including one that disables flat-by-close outright. An assertion whose
  // failure mode is silent approval is worse than no assertion.
  if (!Number.isFinite(tickIntervalMs) || tickIntervalMs <= 0) {
    throw new Error(
      `tickIntervalMs must be a positive, finite number of milliseconds, got ${tickIntervalMs}. ` +
        'Flat-by-close is evaluated on a tick, so a non-positive interval means there is no ' +
        'tick rate for the flatten window to be checked against (#670).',
    );
  }

  const window = traderConfig.flatten_before_close_ms;
  const required = MIN_TICKS_INSIDE_FLATTEN_WINDOW * tickIntervalMs;
  if (window < required) {
    const ticksInWindow = (window / tickIntervalMs).toFixed(2);
    throw new Error(
      `traderConfig.flatten_before_close_ms (${window}ms) must be at least ` +
        `${MIN_TICKS_INSIDE_FLATTEN_WINDOW}x tickIntervalMs (${tickIntervalMs}ms = ${required}ms), ` +
        `but only ${ticksInWindow} tick(s) fit inside the flatten window. ` +
        'Flat-by-close is evaluated ON a tick, so a window this narrow is stepped over: the ' +
        'position carries overnight against ADR-0014 with nothing logged as an error. ' +
        'Widen flatten_before_close_ms or shorten tickIntervalMs (#670).',
    );
  }

  // #1389's grace, checked here because it is the same invariant one bell
  // later: the grace is also a set of instants at which flattening becomes
  // POSSIBLE, and a tick still has to land in it.
  //
  // ONE tick, not `MIN_TICKS_INSIDE_FLATTEN_WINDOW`. The pre-close window's
  // second tick buys tolerance for one arbitrary lost tick on the path that
  // carries the whole obligation. The grace is not that path — it is the
  // SECOND chance, reached only when the pre-close window's own guaranteed
  // ticks were already missed — so requiring the same margin twice would price
  // a backstop as if it were the primary, and every extra minute of grace is
  // spent against gate 2a's 15-minute ceiling (see `flatten_after_close_ms`).
  // What this refuses is the degenerate case: a grace no tick can land in at
  // all, which is a grace that silently does not exist.
  const grace = traderConfig.flatten_after_close_ms;
  if (grace < tickIntervalMs) {
    throw new Error(
      `traderConfig.flatten_after_close_ms (${grace}ms) must be at least tickIntervalMs ` +
        `(${tickIntervalMs}ms), but only ${(grace / tickIntervalMs).toFixed(2)} tick(s) fit ` +
        'inside the post-close flatten grace. The grace is #1389\'s second chance at a lot the ' +
        'pre-close window missed, and it is evaluated ON a tick too — a grace no tick lands in ' +
        'restores the forward-only window, silently. Widen flatten_after_close_ms or shorten ' +
        'tickIntervalMs (#1389).',
    );
  }
}

/**
 * Throws unless #1389's post-close grace fits under Verdict's price-staleness
 * ceiling.
 *
 * ## Why this bound exists at all
 *
 * A mandatory flatten is exempt from gate 1 (`staleness`, #894) and gate 4
 * (`market_closed`, #1388), and both exemptions are deliberate. It is NOT
 * exempt from gate 2a, the price gate: a PRICED flatten still has its mark
 * compared against `max_mark_age`, and past that age Verdict answers
 * `stale_feed` no matter how mandatory the exit is.
 *
 * So `max_mark_age.stocks` is the real ceiling on how late any post-bell
 * flatten can produce a `go`, and a grace configured past it buys nothing but
 * ticks that cannot transact — while looking, in `trader_log`, exactly like a
 * grace that is working.
 *
 * ## Why `verdictConfig`, not `riskConfig`
 *
 * Both carry a `max_mark_age` and they are the same value in every shipped
 * profile today. Gate 2a reads **Verdict's** (`verdict/index.ts`), so that is
 * the one asserted against. Asserting the Risk copy would pass every test in
 * the repo and be wrong the first time the two diverge — which is the only
 * time an assertion is worth having.
 */
export function assertFlattenGraceWithinMarkAge(
  traderConfig: TraderConfig,
  verdictMaxMarkAgeStocksMs: number,
): void {
  const grace = traderConfig.flatten_after_close_ms;
  if (grace <= verdictMaxMarkAgeStocksMs) return;

  throw new Error(
    `traderConfig.flatten_after_close_ms (${grace}ms) must not exceed ` +
      `verdictConfig.max_mark_age.stocks (${verdictMaxMarkAgeStocksMs}ms). A priced mandatory ` +
      'flatten is NOT exempt from Verdict gate 2a, so past that age every post-close flatten is ' +
      'refused `stale_feed` — the extra grace produces ticks that cannot transact while reading ' +
      'like a grace that works (#1389).',
  );
}
