/**
 * Relative volume (RVOL) on a median, same-clock-time baseline (#747).
 *
 * RVOL is the current 5-minute bucket's volume over the **median** of the
 * SAME CLOCK-TIME bucket across the prior `RVOL_SESSION_WINDOW` (10)
 * sessions. A SEPARATE module from `indicators.ts`/`computeIndicator`, for
 * exactly the reason `session-features.ts` (#746) gives for its own VWAP: a
 * session anchor is calendar data, not a lookback, and `computeIndicator`
 * must stay a zero-dependency pure function of `(bars, spec)` so the
 * `spec.lookback`-only cache-key invariant in `indicator-cache.ts` holds.
 * This module takes a `TradingCalendar` directly, the same shape as
 * `computeSessionVwap`.
 *
 * ## Both choices in "median of the same clock-time bucket" are load-bearing
 *
 * **Median, not mean.** A single news-driven session must not set the
 * baseline for the next fortnight the way one outlier would drag a mean.
 * `rvol.test.ts` proves this binds: a synthetic window with nine ordinary
 * baseline sessions and one 1000x-volume outlier session produces a median
 * indistinguishable from the ordinary sessions, while the mean of the same
 * data would be dominated by the outlier and read the *ordinary* current
 * bucket as suppressed rather than normal.
 *
 * **Same clock-time bucket, not a whole-session average.** US equity volume
 * follows a U-shaped intraday curve — the open and close print far more
 * volume than the midday lull — so a baseline built from a session-wide
 * average would read every open as "unusual" by construction, regardless of
 * whether anything unusual happened. `rvol.test.ts` proves this binds too: a
 * synthetic session where the open is reliably ~10x a midday bar reads as
 * RVOL ≈ 1 (not elevated) against a same-time-of-day baseline, while the
 * same open against a whole-session-average baseline would read as ~10x
 * elevated on every ordinary day.
 *
 * ## Why this survives the IEX partial-tape caveat — read before changing the baseline
 *
 * Alpaca's free tier serves IEX-only bars, one exchange's slice of the
 * consolidated tape, not the full NBBO volume. A *raw* volume reading off
 * IEX alone would be a fabricated claim about "the market's" volume. RVOL
 * survives that caveat for two SEPARATE reasons, and both depend on this
 * exact baseline shape:
 *
 * 1. **It is an IEX-to-IEX ratio.** Both the numerator (today's bucket) and
 *    the denominator (the historical buckets) are read off the same feed, so
 *    IEX's fixed share of consolidated volume cancels in the division —
 *    RVOL asks "is IEX's slice bigger than usual", not "is total volume
 *    bigger than usual", and the former is a fair question to ask of a
 *    partial tape even though the latter is not.
 * 2. **The same-time-of-day baseline cancels IEX's time-of-day share
 *    drift.** IEX's share of consolidated volume is not even constant
 *    ACROSS the trading day — dark-pool and other-venue routing shifts
 *    disproportionately around the open/close versus midday. A whole-session
 *    average baseline would divide today's open-bucket IEX share by a
 *    denominator built mostly from midday IEX share, reintroducing exactly
 *    the bias the ratio was supposed to cancel. Comparing the SAME
 *    clock-time bucket across sessions holds that time-of-day share
 *    (whatever it is) constant on both sides of the ratio.
 *
 * A later reader who "simplifies" the baseline to a whole-session or
 * whole-history mean breaks BOTH properties silently: the number would still
 * compute, still look like a ratio, and would quietly stop meaning what RVOL
 * is supposed to mean.
 *
 * ## The volume caveat (#744)
 *
 * `types.ts`'s `INDICATOR_KINDS` names RVOL by name as a future volume-derived
 * kind the leveraged-ETP caveat applies to: on a 3x ETP, volume is
 * market-maker/wrapper flow, not informed flow, and a volume-derived read
 * should target the liquid US underlying. This module takes the same
 * posture `session-features.ts` already recorded for VWAP and
 * `technical-analyst.ts`'s `upVolumeShare` already recorded for the
 * participation axis: it computes RVOL on whichever `instrument` its caller
 * passes bars for, which today is the traded instrument itself. Routing at
 * the underlying instead needs a screening/underlying-instrument identity
 * this codebase does not have (arrives with #749's `screening_instrument`).
 * That plumbing is not built here; it is recorded as a real gap, not
 * silently ignored.
 *
 * ## Degraded buckets — a STATED behaviour, never a silently wrong ratio
 *
 * `computeRvol` REFUSES to compute a ratio — returns `rvol: null` with a
 * `degraded_reason` — unless the current bucket has a same-clock-time match
 * in every one of the `RVOL_SESSION_WINDOW` most recent prior sessions. A
 * session can fail to supply a match for reasons that are a normal part of
 * the tape, not a data fault: a half-day (LSE Christmas Eve, a US early
 * close) that ends before today's clock-time bucket ever opens that day, or
 * a genuine gap in a sparser feed. Rather than silently computing a median
 * over however many sessions happen to have a match — the "4 of 10, unsaid"
 * shape this repo treats as a fabricated number — this returns `null` and
 * `sessions_used` reports exactly how many sessions DID have a match, so a
 * caller can log or display the shortfall instead of a falsely-precise
 * ratio. This mirrors `computeIndicator`'s own refusal (`InsufficientBarsError`)
 * to serve an indicator over fewer bars than its spec, rather than silently
 * approximating.
 */

import type { TradingCalendar } from './trading-calendar.js';
import type { Bar } from './types.js';

/** RVOL's baseline window: the prior N sessions, per the ticket's definition */
export const RVOL_SESSION_WINDOW = 10;

/** Why `computeRvol` returned `null` instead of a ratio */
export type RvolDegradedReason =
  /** `calendar.sessionEnd(asOf) === null` — the venue has no session to anchor to (crypto) */
  | 'no_session_anchor'
  /** No bar in `bars` falls inside the current session yet */
  | 'no_current_bucket'
  /**
   * Fewer than `RVOL_SESSION_WINDOW` prior sessions supplied a bar at the
   * same clock-time bucket as the current one — either because fewer than
   * `RVOL_SESSION_WINDOW` prior sessions are present in `bars` at all, or
   * because one or more of those sessions lacks that specific bucket (a
   * half-day that ended before it, a gap in the feed)
   */
  | 'insufficient_sessions'
  /** The median baseline volume is 0 — there is no meaningful ratio to a zero denominator */
  | 'zero_baseline';

export interface RvolReading {
  /** current-bucket volume / median same-clock-time baseline volume, or `null` if degraded */
  rvol: number | null;
  /**
   * How many of the (up to) `RVOL_SESSION_WINDOW` most recent prior sessions
   * actually supplied a bar at the current bucket's clock-time position.
   * Populated even when `rvol` is `null`, so a caller can report the
   * shortfall rather than just "unavailable".
   */
  sessions_used: number;
  /** Always `RVOL_SESSION_WINDOW` — carried for display convenience */
  sessions_target: number;
  /** `null` when `rvol` is a real number; otherwise names why it is not */
  degraded_reason: RvolDegradedReason | null;
}

const NO_CURRENT_BUCKET: RvolReading = {
  rvol: null,
  sessions_used: 0,
  sessions_target: RVOL_SESSION_WINDOW,
  degraded_reason: 'no_current_bucket',
};

function degraded(reason: RvolDegradedReason, sessionsUsed: number): RvolReading {
  return {
    rvol: null,
    sessions_used: sessionsUsed,
    sessions_target: RVOL_SESSION_WINDOW,
    degraded_reason: reason,
  };
}

/**
 * Standard median: sorted middle value, or the average of the two middle
 * values for an even-length input (`RVOL_SESSION_WINDOW` is 10, so the
 * "exactly 10 sessions" case always averages a middle pair). `values` is
 * copied before sorting — callers must not have their own array order
 * disturbed as a side effect of computing a baseline over it.
 */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
    : (sorted[mid] as number);
}

/**
 * Computes RVOL over `bars` for the session containing their most recent
 * entry, against the median same-clock-time bucket across the prior
 * `RVOL_SESSION_WINDOW` sessions found in `bars`.
 *
 * `bars` must be ascending by `close_time` and already PIT-filtered to
 * `close_time <= asOf` — the same contract `computeSessionVwap` relies on.
 * It must be a WIDE window: at least `RVOL_SESSION_WINDOW + 1` sessions'
 * worth of same-timeframe bars, which is materially more than any other
 * reader in this service asks for (issue #386/#747) — see
 * `normalizing-data-source.ts`'s `MAX_RAW_LIMIT_ABSOLUTE` for the raw-fetch
 * cap this shape of request required.
 *
 * ## Session partitioning and "same clock-time bucket"
 *
 * Bars are grouped into sessions by `calendar.sessionStart(bar.close_time)`
 * — the same accounting-boundary technique `computeSessionVwap` uses, valid
 * for the same reason: ingestion never produces a bar between one session's
 * close and the next one's open (#66), so every bar's session is exactly the
 * group sharing its `sessionStart` value.
 *
 * "The same clock-time bucket" is then each session's bars' ORDINAL
 * POSITION from that session's own first bar (0 = the opening bucket), not a
 * raw UTC-clock comparison. Every calendar here opens a session at a FIXED
 * LOCAL wall-clock time every trading day (09:30 ET, 08:00 London) —
 * `TradingCalendar`'s `Intl`-backed implementations resolve that
 * DST-correctly — so a session's Nth bar is always the same local
 * clock-time bucket as every other session's Nth bar, without this module
 * needing its own timezone table. A half-day session simply has fewer
 * ordinal positions than a full one, which this module reads as "that
 * session has no match for a late bucket" (`insufficient_sessions`) rather
 * than mis-aligning the rest of the session against it.
 *
 * The CURRENT bucket is the last bar in `bars` — necessarily the most
 * recent bar at or before `asOf` — at its ordinal position within its own
 * (current) session.
 */
export function computeRvol(bars: Bar[], calendar: TradingCalendar, asOf: Date): RvolReading {
  if (calendar.sessionEnd(asOf) === null) {
    return degraded('no_session_anchor', 0);
  }

  const currentBar = bars.at(-1);
  if (!currentBar) {
    return NO_CURRENT_BUCKET;
  }

  // Partition into sessions, keyed by each bar's accounting session start
  // `bars` is ascending, so each group's bars are ascending too, and group
  // insertion order is the sessions' chronological order
  const sessions = new Map<number, Bar[]>();
  for (const b of bars) {
    const key = calendar.sessionStart(b.close_time).getTime();
    const group = sessions.get(key);
    if (group) {
      group.push(b);
    } else {
      sessions.set(key, [b]);
    }
  }

  const currentSessionKey = calendar.sessionStart(currentBar.close_time).getTime();
  const currentSession = sessions.get(currentSessionKey);
  if (!currentSession || currentSession.length === 0) {
    // Cannot happen given currentBar came from `bars` itself, but keeps this
    // function total rather than trusting the Map lookup implicitly
    return NO_CURRENT_BUCKET;
  }
  const currentIndex = currentSession.length - 1;
  const currentVolume = currentBar.volume;

  // Prior sessions, most-recent-first, excluding the current one
  const priorSessionKeys = [...sessions.keys()]
    .filter((key) => key < currentSessionKey)
    .sort((a, b) => b - a)
    .slice(0, RVOL_SESSION_WINDOW);

  const baselineVolumes: number[] = [];
  for (const key of priorSessionKeys) {
    const sessionBars = sessions.get(key) as Bar[];
    const matchingBar = sessionBars[currentIndex];
    if (matchingBar) {
      baselineVolumes.push(matchingBar.volume);
    }
  }

  if (
    priorSessionKeys.length < RVOL_SESSION_WINDOW ||
    baselineVolumes.length < RVOL_SESSION_WINDOW
  ) {
    return degraded('insufficient_sessions', baselineVolumes.length);
  }

  const baseline = median(baselineVolumes);
  if (baseline === 0) {
    return degraded('zero_baseline', baselineVolumes.length);
  }

  return {
    rvol: currentVolume / baseline,
    sessions_used: baselineVolumes.length,
    sessions_target: RVOL_SESSION_WINDOW,
    degraded_reason: null,
  };
}
