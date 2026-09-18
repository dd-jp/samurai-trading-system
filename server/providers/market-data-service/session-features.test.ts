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
    const asOf = new Date('2026-07-15T12:00:00Z');
    const bars = [
      bar(new Date('2026-07-15T00:05:00Z')),
      bar(new Date('2026-07-15T06:00:00Z')),
      bar(new Date('2026-07-15T12:00:00Z')),
    ];
    const calendar = new AlwaysOpenCalendar();

    expect(calendar.sessionStart(asOf)).toBeInstanceOf(Date);
    expect(calendar.sessionEnd(asOf)).toBeNull();

    const result = computeSessionVwap(bars, calendar, asOf);

    expect(result).toEqual({ vwap: null, distance_from_vwap: null });
  });

  it('anchors to sessionStart and computes a volume-weighted average over only in-session bars', () => {
    const calendar = new UsEquityRegularHoursCalendar();
    const asOf = new Date('2026-07-15T14:00:00Z');
    const sessionStart = calendar.sessionStart(asOf);
    expect(sessionStart.toISOString()).toBe('2026-07-14T20:00:00.000Z');

    const priorSessionBar = bar(new Date('2026-07-14T19:55:00Z'), {
      close: 999,
      volume: 1_000_000,
    });
    const inSessionBars = [
      bar(new Date('2026-07-15T13:35:00Z'), { high: 102, low: 98, close: 100, volume: 10 }),
      bar(new Date('2026-07-15T13:40:00Z'), { high: 104, low: 100, close: 102, volume: 30 }),
    ];

    const result = computeSessionVwap([priorSessionBar, ...inSessionBars], calendar, asOf);

    expect(result.vwap).toBeCloseTo(101.5, 8);
    expect(result.distance_from_vwap).toBeCloseTo(102 - 101.5, 8);
  });

  it('returns null when no bar in the window falls inside the current session yet', () => {
    const calendar = new LseRegularHoursCalendar();
    const asOf = new Date('2026-07-15T08:05:00Z');
    const staleBars = [bar(new Date('2026-07-14T15:00:00Z'))];

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

describe('computeIndicator stays pure and calendar-free (#746)', () => {
  it('rejects a third (calendar) argument at compile time', () => {
    const calendar = new AlwaysOpenCalendar();
    const bars: Bar[] = [bar(new Date('2026-07-15T13:35:00Z'))];
    const spec: IndicatorSpec = { indicator: 'sma', params: {}, timeframe: '5m', lookback: 1 };

    // @ts-expect-error — computeIndicator's signature is exactly (bars, spec).
    computeIndicator(bars, spec, calendar);
  });

  it('never imports TradingCalendar/trading-calendar.js — a source-level check independent of the type check above', () => {
    const source = readFileSync(fileURLToPath(new URL('./indicators.ts', import.meta.url)), 'utf8');

    expect(source).not.toMatch(/trading-calendar/);
    expect(source).not.toMatch(/TradingCalendar/);
  });
});
