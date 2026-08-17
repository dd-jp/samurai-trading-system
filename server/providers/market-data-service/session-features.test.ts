/**
 * Session-anchored VWAP and distance-from-VWAP (#746).
 *
 * Two concerns, kept in one file because they are the two acceptance-criteria
 * traps the issue names:
 *
 * 1. `computeSessionVwap` itself — the arithmetic, the session filter, and
 *    the `null` cases (no session to anchor to, no bars yet, zero volume).
 * 2. The PURITY BOUNDARY — `computeIndicator` must stay a zero-dependency
 *    pure function of `(bars, spec)` with no way for a `TradingCalendar` to
 *    reach it, enforced two ways rather than only documented: a compile-time
 *    check (`@ts-expect-error` on a third, calendar argument) and a
 *    source-scan that fails if `indicators.ts` ever imports
 *    `trading-calendar.ts`.
 *
 * Every test here injects an explicit `TradingCalendar` — none reads the
 * ambient clock or a module-level default.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { computeIndicator } from './indicators.js';
import { computeSessionVwap } from './session-features.js';
import {
  AlwaysOpenCalendar,
  LseRegularHoursCalendar,
  UsEquityRegularHoursCalendar,
} from './trading-calendar.js';
import type { Bar, IndicatorSpec } from './types.js';

const INSTRUMENT = 'BTC-USD';
const TIMEFRAME = '5m';
const BAR_INTERVAL_MS = 5 * 60 * 1000;

function bar(closeTime: Date, overrides: Partial<Bar> = {}): Bar {
  return {
    instrument: INSTRUMENT,
    timeframe: TIMEFRAME,
    open_time: new Date(closeTime.getTime() - BAR_INTERVAL_MS),
    close_time: closeTime,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 10,
    source: 'fixture',
    ...overrides,
  };
}

describe('computeSessionVwap', () => {
  it('returns null for both fields under AlwaysOpenCalendar — a real answer, not a midnight anchor (#746)', () => {
    // 2026-07-15 is a Wednesday; nothing calendar-special about it. The point
    // is that AlwaysOpenCalendar.sessionStart(asOf) returns a REAL, non-null
    // 00:00 UTC value (it is an accounting anchor, not "no session") — so if
    // this module gated on sessionStart instead of sessionEnd, it would
    // fabricate a midnight-anchored VWAP here. It must not.
    const asOf = new Date('2026-07-15T12:00:00Z');
    const bars = [
      bar(new Date('2026-07-15T00:05:00Z')),
      bar(new Date('2026-07-15T06:00:00Z')),
      bar(new Date('2026-07-15T12:00:00Z')),
    ];
    const calendar = new AlwaysOpenCalendar();

    // Sanity: the trap this test guards against is real — sessionStart alone
    // would NOT signal "no session".
    expect(calendar.sessionStart(asOf)).toBeInstanceOf(Date);
    expect(calendar.sessionEnd(asOf)).toBeNull();

    const result = computeSessionVwap(bars, calendar, asOf);

    expect(result).toEqual({ vwap: null, distance_from_vwap: null });
  });

  it('anchors to sessionStart and computes a volume-weighted average over only in-session bars', () => {
    // 2026-07-15 14:00 UTC = 10:00 ET, mid-session. `sessionStart` is the
    // ACCOUNTING boundary — the most recent close AT OR BEFORE `asOf` — which
    // mid-session is YESTERDAY's 16:00 ET close (20:00 UTC July 14), not
    // today's 09:30 ET open. That is still the right filter boundary: no bar
    // exists between yesterday's close and today's open (#66's ingestion
    // gate), so every bar with `close_time > sessionStart` is a bar of
    // TODAY's session regardless of which boundary `sessionStart` itself
    // resolves to — see the module's own doc comment.
    const calendar = new UsEquityRegularHoursCalendar();
    const asOf = new Date('2026-07-15T14:00:00Z');
    const sessionStart = calendar.sessionStart(asOf);
    expect(sessionStart.toISOString()).toBe('2026-07-14T20:00:00.000Z');

    const priorSessionBar = bar(new Date('2026-07-14T19:55:00Z'), {
      close: 999, // before sessionStart — would blow up the average if wrongly included
      volume: 1_000_000,
    });
    const inSessionBars = [
      bar(new Date('2026-07-15T13:35:00Z'), { high: 102, low: 98, close: 100, volume: 10 }),
      bar(new Date('2026-07-15T13:40:00Z'), { high: 104, low: 100, close: 102, volume: 30 }),
    ];

    const result = computeSessionVwap([priorSessionBar, ...inSessionBars], calendar, asOf);

    // typical prices: (102+98+100)/3=100, (104+100+102)/3=102
    // vwap = (100*10 + 102*30) / 40 = (1000 + 3060) / 40 = 101.5
    expect(result.vwap).toBeCloseTo(101.5, 8);
    expect(result.distance_from_vwap).toBeCloseTo(102 - 101.5, 8);
  });

  it('returns null when no bar in the window falls inside the current session yet', () => {
    const calendar = new LseRegularHoursCalendar();
    const asOf = new Date('2026-07-15T08:05:00Z'); // just after 08:00 London open
    const staleBars = [bar(new Date('2026-07-14T15:00:00Z'))]; // yesterday's session

    const result = computeSessionVwap(staleBars, calendar, asOf);

    expect(result).toEqual({ vwap: null, distance_from_vwap: null });
  });

  it('returns null when every in-session bar has zero volume — nothing to weight by', () => {
    const calendar = new UsEquityRegularHoursCalendar();
    const asOf = new Date('2026-07-15T14:00:00Z');
    const zeroVolumeBars = [
      bar(new Date('2026-07-15T13:35:00Z'), { volume: 0 }),
      bar(new Date('2026-07-15T13:40:00Z'), { volume: 0 }),
    ];

    const result = computeSessionVwap(zeroVolumeBars, calendar, asOf);

    expect(result).toEqual({ vwap: null, distance_from_vwap: null });
  });

  it('excludes a bar exactly AT sessionStart, matching the half-open convention `sessionStart` documents', () => {
    const calendar = new UsEquityRegularHoursCalendar();
    const asOf = new Date('2026-07-15T14:00:00Z');
    const sessionStart = calendar.sessionStart(asOf);
    const boundaryBar = bar(sessionStart, { close: 555, volume: 1_000_000 });
    const genuineBar = bar(new Date('2026-07-15T13:35:00Z'), { close: 100, volume: 10 });

    const result = computeSessionVwap([boundaryBar, genuineBar], calendar, asOf);

    expect(result.vwap).toBeCloseTo(100, 8);
  });
});

/**
 * The purity boundary: `computeIndicator` must remain calendar-free.
 * Enforced two ways, and each is verified to be load-bearing (not merely
 * present) — see the PR description for the mutation that was run against
 * each.
 */
describe('computeIndicator stays pure and calendar-free (#746)', () => {
  it('rejects a third (calendar) argument at compile time', () => {
    const calendar = new AlwaysOpenCalendar();
    const bars: Bar[] = [bar(new Date('2026-07-15T13:35:00Z'))];
    const spec: IndicatorSpec = { indicator: 'sma', params: {}, timeframe: '5m', lookback: 1 };

    // @ts-expect-error — computeIndicator's signature is exactly (bars, spec).
    // A third argument, even a real TradingCalendar, must fail `tsc`. If this
    // directive ever goes unused, the signature has been widened to accept a
    // calendar and this test — not just this comment — is what catches it.
    computeIndicator(bars, spec, calendar);
  });

  it('never imports TradingCalendar/trading-calendar.js — a source-level check independent of the type check above', () => {
    const source = readFileSync(fileURLToPath(new URL('./indicators.ts', import.meta.url)), 'utf8');

    expect(source).not.toMatch(/trading-calendar/);
    expect(source).not.toMatch(/TradingCalendar/);
  });
});
