/**
 * Session-anchored VWAP and distance-from-VWAP (#746).
 *
 * A SEPARATE module from `indicators.ts`/`computeIndicator` on purpose — see
 * that module's doc comment and `session-features.test.ts`'s enforcement
 * tests. `computeIndicator` is a zero-dependency pure function of `(bars,
 * spec)`, and the cache-key invariant `indicator-cache.ts` relies on is that
 * `spec.lookback` alone determines the window. A session anchor is calendar
 * data, not a lookback: dragging a `TradingCalendar` into that function would
 * either break the invariant (the same `spec` now answers differently
 * depending on wall-clock session boundaries the cache key knows nothing
 * about) or force the calendar itself into the cache key, which is a far
 * bigger change than this ticket's "one feature, trimmed" scope. So the
 * session anchor is computed here, one level up, over bars `computeIndicator`
 * never sees change shape.
 *
 * Anchored to `TradingCalendar.sessionStart`, not a hand-rolled "09:30/08:00
 * open" constant — see that method's own doc comment for why it is a
 * close-to-close ACCOUNTING boundary rather than the intraday open. That
 * distinction is harmless here: ingestion only ever produces bars while
 * `isOpen` is true (ticket #66), so no bar exists between the previous close
 * and the next session's open, and the first bar with `close_time >
 * sessionStart(asOf)` is therefore the first bar of the CURRENT trading
 * session regardless of which boundary the method is named for.
 *
 * `null` is a real answer, not a missing one, and it is read from
 * `sessionEnd`, never fabricated from `sessionStart`. Every `TradingCalendar`
 * — `AlwaysOpenCalendar` included — has a real `sessionStart` (crypto's is
 * 00:00 UTC, an ACCOUNTING anchor `sessionEnd`'s own doc comment names and
 * explicitly forbids reusing as a trading instruction). Gating on
 * `sessionStart` would therefore compute a midnight-anchored VWAP for a 24/7
 * instrument — a fabricated number about the tape, the exact class of defect
 * `sessionEnd`'s doc comment exists to prevent. `sessionEnd(asOf) === null`
 * is the calendar's own "this venue has no session to anchor to" answer, so
 * that is what this module asks.
 *
 * ## The volume caveat (#744)
 *
 * `types.ts`'s `INDICATOR_KINDS` records that on a leveraged ETP, volume is
 * market-maker and wrapper flow rather than informed flow, and a
 * volume-derived read should target the liquid US underlying. VWAP is
 * volume-weighted, so the caveat applies to it exactly as it would to a
 * registry kind.
 *
 * This module does NOT resolve that caveat — it computes the session VWAP on
 * whichever `instrument` its caller passes bars for, which today is the
 * traded instrument itself (the same posture `technical-analyst.ts`'s
 * `upVolumeShare` already takes for the participation axis; #745 noted the
 * same gap there rather than smuggling in a fix). Routing this at the liquid
 * US underlying instead would need a screening/underlying-instrument identity
 * this codebase does not have yet — there is no mapping from a leveraged LSE
 * ETP to the US name it tracks anywhere in the system. That plumbing is not
 * built here; it is recorded as a real gap rather than silently ignored or
 * faked with invented plumbing.
 */

import type { TradingCalendar } from './trading-calendar.js';
import type { Bar } from './types.js';

/**
 * Session-anchored VWAP and the current price's distance from it.
 *
 * `vwap` is the volume-weighted average of each session bar's typical price
 * `(high + low + close) / 3`. `distance_from_vwap` is `lastClose - vwap`, in
 * the instrument's own price units — scale-dependent across a leveraged step
 * exactly the way `atr_pct`'s doc comment describes for ATR (`indicators.ts`
 * #744), which is a documented property here rather than something this
 * ticket normalizes; that is future work, not this module's job.
 *
 * Both fields are `null` together, never independently: there is no reading
 * to take a distance from when there is no VWAP.
 */
export interface SessionVwap {
  vwap: number | null;
  distance_from_vwap: number | null;
}

/** `SessionVwap` with both fields `null` — the shared "nothing to anchor to" answer */
const NO_SESSION_ANCHOR: SessionVwap = { vwap: null, distance_from_vwap: null };

/**
 * Computes the session-anchored VWAP and distance-from-VWAP over `bars`.
 *
 * `bars` must be ascending by `close_time` and is expected to already be
 * filtered to `close_time <= asOf` (the same contract every
 * `MarketDataService.getBars` caller relies on) — this function does not
 * re-sort or re-filter against `asOf`, only against the resolved session
 * start. A caller that already fetched a wider warm-up window (as
 * `technicalAnalyst` does for its own 5m specs) can pass it straight through;
 * bars from a PRIOR session are filtered out here, not by the caller.
 *
 * Returns `NO_SESSION_ANCHOR` when:
 * - `calendar.sessionEnd(asOf)` is `null` — the venue has no session to
 *   anchor to (`AlwaysOpenCalendar`, i.e. crypto).
 * - No bar in `bars` falls inside the current session yet (a fresh session
 *   with no bars printed, or a `bars` window that does not reach back far
 *   enough to cover it).
 * - Every in-session bar has zero volume — there is genuinely nothing to
 *   weight by, the same "no fabricated reading" posture
 *   `technical-analyst.ts`'s `upVolumeShare` already takes for its own
 *   participating-volume read.
 *
 * `calendar.sessionEnd`/`sessionStart` may THROW rather than answer (a
 * calendar whose holiday table is exhausted or wrong) — see
 * `TradingCalendar.sessionEnd`'s doc comment ("THROWS — `null` and 'cannot
 * answer' are different answers"). This function does not catch that: it
 * propagates, the same fail-loud posture `technicalAnalyst`'s CORE reads take
 * for a short indicator window, rather than silently reporting "no session"
 * for a calendar that is actually broken.
 */
export function computeSessionVwap(
  bars: Bar[],
  calendar: TradingCalendar,
  asOf: Date,
): SessionVwap {
  if (calendar.sessionEnd(asOf) === null) {
    return NO_SESSION_ANCHOR;
  }

  const sessionStart = calendar.sessionStart(asOf);
  const sessionBars = bars.filter(
    (bar) =>
      bar.close_time.getTime() > sessionStart.getTime() &&
      bar.close_time.getTime() <= asOf.getTime(),
  );

  if (sessionBars.length === 0) {
    return NO_SESSION_ANCHOR;
  }

  let sumPriceVolume = 0;
  let sumVolume = 0;
  for (const bar of sessionBars) {
    const typicalPrice = (bar.high + bar.low + bar.close) / 3;
    sumPriceVolume += typicalPrice * bar.volume;
    sumVolume += bar.volume;
  }

  if (sumVolume === 0) {
    return NO_SESSION_ANCHOR;
  }

  const vwap = sumPriceVolume / sumVolume;
  const lastClose = (sessionBars[sessionBars.length - 1] as Bar).close;

  return { vwap, distance_from_vwap: lastClose - vwap };
}
