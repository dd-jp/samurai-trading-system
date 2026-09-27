import { describe, expect, it } from 'vitest';
import {
  applyBarHygiene,
  dropNonSessionBars,
  findHolesAndFlips,
  findUnitBreaks,
  normaliseUnitBreaks,
} from './index.js';

function tradingCalendar(from: string, sessions: number): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  while (dates.length < sessions) {
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function bar(date: string, close: number) {
  return { date, open: close, high: close, low: close, close, volume: 1, rawClose: close };
}

const calendar = tradingCalendar('2010-01-04', 2_500);

describe('bar hygiene', () => {
  const dates = calendar.slice(0, 12);
  const level = (i: number) => 10 + i * 0.05;

  it('rescales the segment before a ×100 unit break to the latest unit', () => {
    const raw = dates.map((date, i) => bar(date, i < 5 ? level(i) / 100 : level(i)));
    const { bars, breaks } = normaliseUnitBreaks(raw);
    expect(breaks).toEqual([{ date: dates[5], factor: 100 }]);
    expect(bars.map((b) => b.close)).toEqual(dates.map((_, i) => level(i)));
    expect(bars[0]?.rawClose).toBe(level(0));
    expect(bars[0]?.high).toBe(level(0));
    expect(findUnitBreaks(bars)).toEqual([]);
  });

  it('rescales the segment before a ÷100 unit break and composes a three-bar ×100 spike back to unity', () => {
    const down = dates.map((date, i) => bar(date, i < 4 ? level(i) * 100 : level(i)));
    const fixedDown = normaliseUnitBreaks(down);
    expect(fixedDown.breaks).toEqual([{ date: dates[4], factor: 0.01 }]);
    expect(fixedDown.bars.map((b) => b.close)).toEqual(dates.map((_, i) => level(i)));
    const spike = dates.map((date, i) => bar(date, i >= 3 && i <= 5 ? level(i) * 100 : level(i)));
    const fixedSpike = normaliseUnitBreaks(spike);
    expect(fixedSpike.breaks.map((b) => [b.date, b.factor])).toEqual([
      [dates[3], 100],
      [dates[6], 0.01],
    ]);
    expect(fixedSpike.bars.map((b) => b.close)).toEqual(dates.map((_, i) => level(i)));
  });

  it('refuses a genuine 4× move as a data hole unless allow-listed, and counts ±40% flips as suspect', () => {
    const hole = dates.map((date, i) => bar(date, i === 6 ? level(i) * 4 : level(i)));
    expect(() => applyBarHygiene('X', hole, { fetchDate: '2099-01-01' })).toThrow(/data hole/);
    const allowed = applyBarHygiene('X', hole, {
      fetchDate: '2099-01-01',
      allowHolesReason: 'known',
    });
    expect(allowed.report.holes.map((h) => h.date)).toEqual([dates[6], dates[7]]);
    const flips = dates.map((date, i) => bar(date, i % 2 === 0 ? 10 : 15));
    const found = findHolesAndFlips(flips);
    expect(found.holes).toEqual([]);
    expect(found.flips).toEqual({ count: 11, from: dates[1], to: dates[11] });
    expect(findHolesAndFlips(dates.map((d, i) => bar(d, level(i)))).flips).toBeUndefined();
  });

  it('drops weekend-dated bars and bars on or after the fetch date, and reports both', () => {
    const raw = [
      bar('2017-01-01', 1),
      bar('2017-01-03', 1),
      bar('2017-01-07', 1),
      bar('2017-01-09', 1),
      bar('2017-01-10', 1),
    ];
    const { bars, dropped } = dropNonSessionBars(raw, '2017-01-10');
    expect(bars.map((b) => b.date)).toEqual(['2017-01-03', '2017-01-09']);
    expect(dropped).toEqual(['2017-01-01', '2017-01-07', '2017-01-10']);
    const clean = applyBarHygiene('X', raw, { fetchDate: '2017-01-10' });
    expect(clean.report).toEqual({
      dropped_dates: ['2017-01-01', '2017-01-07', '2017-01-10'],
      unit_breaks: [],
      holes: [],
      suspect_flips: undefined,
    });
  });
});
