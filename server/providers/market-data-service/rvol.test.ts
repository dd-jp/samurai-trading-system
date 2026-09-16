/**
 * RVOL on a median, same-clock-time baseline (#747).
 *
 * The two acceptance-criteria traps this file exists to pin, plus the
 * degrade-behaviour and no-session-anchor cases `computeSessionVwap`'s own
 * test file established the pattern for:
 *
 * 1. Median, not mean — one outlier session must not move the baseline.
 * 2. Same clock-time bucket, not a whole-session average — a normal open
 *    must not read as elevated.
 *
 * Sessions are grouped by `TradingCalendar.sessionStart`, exactly as
 * `computeSessionVwap` groups its own in-session bars — `computeRvol`'s doc
 * comment explains why that boundary is safe to key sessions on. Tests here
 * use a synthetic day-boundary calendar rather than the real US/LSE
 * calendars, so the grouping/median/same-bucket arithmetic is exercised in
 * isolation from real trading-hours minutiae (which `trading-calendar.test.ts`
 * already covers on its own terms).
 */
import { computeRvol, RVOL_SESSION_WINDOW } from './rvol.js';
import type { TradingCalendar } from './trading-calendar.js';
import { AlwaysOpenCalendar } from './trading-calendar.js';
import type { Bar } from './types.js';

const INSTRUMENT = 'SPY';
const TIMEFRAME = '5m';
const BAR_INTERVAL_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** UTC-midnight day boundaries — a real, non-null session per day, unlike `AlwaysOpenCalendar` */
const DAILY_SESSION_CALENDAR: TradingCalendar = {
  isOpen: () => true,
  isTradingDay: () => true,
  sessionStart: (instant) =>
    new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate())),
  sessionEnd: (instant) =>
    new Date(
      Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate()) + DAY_MS,
    ),
};

function bar(closeTime: Date, volume: number): Bar {
  return {
    instrument: INSTRUMENT,
    timeframe: TIMEFRAME,
    open_time: new Date(closeTime.getTime() - BAR_INTERVAL_MS),
    close_time: closeTime,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume,
    source: 'fixture',
  };
}

/** Day `dayOffset` (0 = today, 1 = yesterday, ... higher = further back)'s bars, ordinal-indexed by `volumes`. */
function sessionBars(dayOffset: number, volumes: number[]): Bar[] {
  const dayStart = new Date('2026-08-10T00:00:00Z').getTime() - dayOffset * DAY_MS;
  return volumes.map((volume, index) =>
    bar(new Date(dayStart + (index + 1) * BAR_INTERVAL_MS), volume),
  );
}

const ASOF = new Date('2026-08-10T00:10:00Z');

describe('computeRvol — median, same-clock-time baseline (#747)', () => {
  it('the median binds: one 1000x-volume outlier session does not move the baseline the way a mean would', () => {
    // Ten prior sessions' ordinal-1 (their only) bucket: nine at 100, one at
    // 100,000. Today's ordinal-1 bucket is 150 — a mild, ordinary bump over
    // the ordinary 100 baseline
    const priorVolumes = [100, 100, 100, 100, 100000, 100, 100, 100, 100, 100];
    const bars = [
      ...priorVolumes.flatMap((volume, index) => sessionBars(10 - index, [volume])),
      ...sessionBars(0, [150]),
    ];

    const result = computeRvol(bars, DAILY_SESSION_CALENDAR, ASOF);

    // Median of [100,100,100,100,100,100,100,100,100,100000] = 100
    expect(result.degraded_reason).toBeNull();
    expect(result.sessions_used).toBe(RVOL_SESSION_WINDOW);
    expect(result.rvol).toBeCloseTo(1.5, 8);

    // The trap: a MEAN baseline over the same ten sessions is dominated by
    // the outlier and would read today's ordinary bump as suppressed, not
    // elevated — the opposite conclusion. Pinned here so a future edit that
    // swaps median for mean is caught by a changed expectation, not silence
    const mean = priorVolumes.reduce((sum, v) => sum + v, 0) / priorVolumes.length;
    expect(mean).toBeCloseTo(10090, 8);
    const meanBasedRvol = 150 / mean;
    expect(meanBasedRvol).toBeLessThan(0.02);
    expect(result.rvol).not.toBeCloseTo(meanBasedRvol, 2);
  });

  it('the same-clock-time bucket binds: a normal open does not read as elevated RVOL', () => {
    // Every session (today and the ten priors) opens at volume 1000, then a
    // much quieter second bucket at volume 50 — the U-shaped intraday curve
    // Today's CURRENT bucket is the open itself (ordinal 0), matching every
    // prior session's own open
    const bars = [
      ...Array.from({ length: RVOL_SESSION_WINDOW }, (_, i) =>
        sessionBars(10 - i, [1000, 50]),
      ).flat(),
      ...sessionBars(0, [1000]),
    ];

    const result = computeRvol(bars, DAILY_SESSION_CALENDAR, ASOF);

    expect(result.degraded_reason).toBeNull();
    expect(result.rvol).toBeCloseTo(1, 8);

    // The trap: a WHOLE-SESSION-AVERAGE baseline (session avg = (1000+50)/2
    // = 525) would read this same, entirely ordinary open as ~1.9x
    // "elevated" — every open on every ordinary day, by construction of the
    // U-shaped curve, not because anything unusual happened
    const wholeSessionAverageBaseline = (1000 + 50) / 2;
    const wronglyElevated = 1000 / wholeSessionAverageBaseline;
    expect(wronglyElevated).toBeGreaterThan(1.5);
    expect(result.rvol).not.toBeCloseTo(wronglyElevated, 1);
  });

  it('computes a real ratio once all ten prior sessions supply the matching bucket', () => {
    const priorVolumes = [80, 120, 90, 110, 100, 95, 105, 85, 115, 100];
    const bars = [
      ...priorVolumes.flatMap((volume, index) => sessionBars(10 - index, [volume])),
      ...sessionBars(0, [300]),
    ];

    const result = computeRvol(bars, DAILY_SESSION_CALENDAR, ASOF);

    // Sorted: 80,85,90,95,100,100,105,110,115,120 -> median = (100+100)/2 = 100
    expect(result.degraded_reason).toBeNull();
    expect(result.sessions_used).toBe(RVOL_SESSION_WINDOW);
    expect(result.sessions_target).toBe(RVOL_SESSION_WINDOW);
    expect(result.rvol).toBeCloseTo(3, 8);
  });
});

describe('computeRvol — degraded buckets are a stated behaviour, never a silently wrong ratio (#747)', () => {
  it('degrades to insufficient_sessions when one of ten prior sessions lacks the ordinal bucket — a half-day-shaped gap', () => {
    // Nine prior sessions have two bars (ordinal 0 and 1); one (day 5) has
    // only ordinal 0 — as if that session ended early, before its ordinal-1
    // bucket ever printed. Today's current bucket is ordinal 1.
    const bars = [
      ...Array.from({ length: RVOL_SESSION_WINDOW }, (_, i) => {
        const dayOffset = 10 - i;
        return dayOffset === 5 ? sessionBars(dayOffset, [100]) : sessionBars(dayOffset, [100, 90]);
      }).flat(),
      ...sessionBars(0, [100, 200]),
    ];

    const result = computeRvol(bars, DAILY_SESSION_CALENDAR, ASOF);

    expect(result.rvol).toBeNull();
    expect(result.degraded_reason).toBe('insufficient_sessions');
    expect(result.sessions_used).toBe(RVOL_SESSION_WINDOW - 1);
  });

  it('degrades to insufficient_sessions when fewer than ten prior sessions exist at all', () => {
    const bars = [
      ...sessionBars(4, [100]),
      ...sessionBars(3, [100]),
      ...sessionBars(2, [100]),
      ...sessionBars(1, [100]),
      ...sessionBars(0, [150]),
    ];

    const result = computeRvol(bars, DAILY_SESSION_CALENDAR, ASOF);

    expect(result.rvol).toBeNull();
    expect(result.degraded_reason).toBe('insufficient_sessions');
    expect(result.sessions_used).toBe(4);
    expect(result.sessions_target).toBe(RVOL_SESSION_WINDOW);
  });

  it('degrades to zero_baseline when the median baseline volume is 0', () => {
    const bars = [
      ...Array.from({ length: RVOL_SESSION_WINDOW }, (_, i) => sessionBars(10 - i, [0])).flat(),
      ...sessionBars(0, [50]),
    ];

    const result = computeRvol(bars, DAILY_SESSION_CALENDAR, ASOF);

    expect(result.rvol).toBeNull();
    expect(result.degraded_reason).toBe('zero_baseline');
    expect(result.sessions_used).toBe(RVOL_SESSION_WINDOW);
  });

  it('degrades to no_current_bucket when there are no bars at all', () => {
    const result = computeRvol([], DAILY_SESSION_CALENDAR, ASOF);

    expect(result.rvol).toBeNull();
    expect(result.degraded_reason).toBe('no_current_bucket');
    expect(result.sessions_used).toBe(0);
  });

  it('degrades to no_session_anchor under AlwaysOpenCalendar — a real answer, not a fabricated crypto baseline', () => {
    const bars = sessionBars(0, [150]);

    const result = computeRvol(bars, new AlwaysOpenCalendar(), ASOF);

    expect(result.rvol).toBeNull();
    expect(result.degraded_reason).toBe('no_session_anchor');
    expect(result.sessions_used).toBe(0);
  });
});
