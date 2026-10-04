import { describe, expect, it } from 'vitest';
import type { BarSeries, DailyBar } from '../../../shared/index.js';
import { ADJUSTED_JUMP_MIN_RATIO, dataSanity, seriesSanity } from './bar-sanity.js';
import type { BarsSource } from './bars.js';

const SESSIONS = Array.from({ length: 40 }, (_, i) => {
  const date = new Date(Date.UTC(2025, 0, 1 + i));
  return date.toISOString().slice(0, 10);
});

function bar(date: string, close = 100, volume = 1_000): DailyBar {
  return { date, open: close, high: close, low: close, close, volume, rawClose: close };
}

function clean(dates: readonly string[] = SESSIONS): DailyBar[] {
  return dates.map((date) => bar(date));
}

function source(series: readonly BarSeries[]): BarsSource {
  const bySymbol = new Map(series.map((entry) => [entry.symbol, entry]));
  return { load: (symbol) => bySymbol.get(symbol) };
}

describe('seriesSanity', () => {
  it('raises nothing on a full, traded, continuous series', () => {
    const sanity = seriesSanity('ISF', clean(), SESSIONS);
    expect(sanity).toEqual({
      symbol: 'ISF',
      flags: [],
      coverageRatio: 1,
      missingSessions: [],
      zeroVolumeDays: [],
      adjustedJumps: [],
    });
  });

  it('ignores bars outside the window', () => {
    const history = [bar('2024-12-30', 1, 0), ...clean(), bar('2025-03-01', 900, 0)];
    expect(seriesSanity('ISF', history, SESSIONS).flags).toEqual([]);
  });

  it('flags each interior missing session as a gap', () => {
    const history = clean().filter((entry) => entry.date !== SESSIONS[10]);
    const sanity = seriesSanity('ISF', history, SESSIONS);
    expect(sanity.missingSessions).toEqual([SESSIONS[10]]);
    expect(sanity.flags).toEqual(['gap']);
    expect(sanity.coverageRatio).toBeCloseTo(39 / 40);
  });

  it('fails coverage once missing sessions push the ratio under 95%', () => {
    const dropped = new Set(SESSIONS.slice(5, 8));
    const history = clean().filter((entry) => !dropped.has(entry.date));
    expect(seriesSanity('ISF', history, SESSIONS).flags).toEqual(['coverage', 'gap']);
  });

  it('fails coverage on a series that stops before the window ends', () => {
    const sanity = seriesSanity('ISF', clean(SESSIONS.slice(0, 39)), SESSIONS);
    expect(sanity.flags).toEqual(['coverage']);
    expect(sanity.missingSessions).toEqual([]);
  });

  it('measures coverage from a late-starting series first bar, not the window start', () => {
    const sanity = seriesSanity('VUTY', clean(SESSIONS.slice(20)), SESSIONS);
    expect(sanity.flags).toEqual([]);
    expect(sanity.coverageRatio).toBe(1);
  });

  it('fails coverage on an absent series', () => {
    const sanity = seriesSanity('NONE', [], SESSIONS);
    expect(sanity.flags).toEqual(['coverage']);
    expect(sanity.coverageRatio).toBe(0);
  });

  it('fails coverage on a series with only the last session', () => {
    const sanity = seriesSanity('NEW', clean(SESSIONS.slice(39)), SESSIONS);
    expect(sanity.flags).toEqual(['coverage']);
    expect(sanity.coverageRatio).toBe(0.5);
  });

  it('flags zero-volume days', () => {
    const history = clean().map((entry, i) => (i === 3 ? bar(entry.date, 100, 0) : entry));
    const sanity = seriesSanity('SSLN', history, SESSIONS);
    expect(sanity.zeroVolumeDays).toEqual([SESSIONS[3]]);
    expect(sanity.flags).toEqual(['zero_volume']);
  });

  it('flags an adjusted close jump past the threshold in either direction', () => {
    const up = ADJUSTED_JUMP_MIN_RATIO * 1.001;
    const history = clean().map((entry, i) => {
      if (i === 10) return bar(entry.date, 100 * up);
      if (i === 20) return bar(entry.date, 100 / up);
      return entry;
    });
    const sanity = seriesSanity('CUS1', history, SESSIONS);
    expect(sanity.flags).toEqual(['adjusted_jump']);
    expect(sanity.adjustedJumps.map((jump) => jump.date)).toEqual([
      SESSIONS[10],
      SESSIONS[11],
      SESSIONS[20],
      SESSIONS[21],
    ]);
    expect(sanity.adjustedJumps[0]?.ratio).toBeCloseTo(up);
  });

  it('does not flag a move at the threshold itself', () => {
    const history = clean().map((entry, i) =>
      i >= 10 ? bar(entry.date, 100 * ADJUSTED_JUMP_MIN_RATIO) : entry,
    );
    expect(seriesSanity('ISF', history, SESSIONS).flags).toEqual([]);
  });

  it('flags a split the adjusted close missed but not one it absorbed', () => {
    const missed = clean().map((entry, i) =>
      i >= 10 ? { ...bar(entry.date, 50), rawClose: 50 } : entry,
    );
    const absorbed = clean().map((entry, i) => (i < 10 ? { ...entry, rawClose: 200 } : entry));
    expect(seriesSanity('X', missed, SESSIONS).flags).toEqual(['adjusted_jump']);
    expect(seriesSanity('X', absorbed, SESSIONS).flags).toEqual([]);
  });

  it('refuses a window shorter than two sessions', () => {
    expect(() => seriesSanity('ISF', clean(), SESSIONS.slice(0, 1))).toThrow(/two sessions/);
  });
});

describe('dataSanity', () => {
  it('checks each symbol once and reports only the flagged ones', () => {
    const report = dataSanity(
      source([
        { symbol: 'ISF', bars: clean() },
        { symbol: 'SSLN', bars: clean().map((entry) => bar(entry.date, 100, 0)) },
      ]),
      ['SSLN', 'ISF', 'SSLN', 'NONE'],
      SESSIONS,
    );
    expect(report.from).toBe(SESSIONS[0]);
    expect(report.to).toBe(SESSIONS[39]);
    expect(report.seriesChecked).toBe(3);
    expect(report.flagged.map((entry) => [entry.symbol, entry.flags])).toEqual([
      ['NONE', ['coverage']],
      ['SSLN', ['zero_volume']],
    ]);
  });

  it('refuses an empty window even with no symbols', () => {
    expect(() => dataSanity(source([]), [], [])).toThrow(/two sessions/);
  });
});
