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
 * at 15 minutes against a `flatten_before_close_ms` of 5, so the flatten fired
 * only when a tick happened to land in the session's final five minutes —
 * roughly one session in three, decided by nothing but where the interval's
 * phase fell relative to the close.
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
 * when the previous one is still running (#669), a debate pass is ~13s against a
 * 30s crypto latency budget, and the interval timer drifts. Requiring two ticks
 * inside the window means the flatten survives losing one of them, which is a
 * thing that demonstrably happens rather than a thing that might.
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
  const window = traderConfig.flatten_before_close_ms;
  const required = MIN_TICKS_INSIDE_FLATTEN_WINDOW * tickIntervalMs;
  if (window >= required) return;

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
