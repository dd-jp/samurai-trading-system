import { describe, expect, it } from 'vitest';
import {
  applyBarHygiene,
  dropNonSessionBars,
  findHolesAndFlips,
  findUnitBreaks,
  normaliseUnitBreaks,
  repairBarShape,
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

function ohlc(
  date: string,
  open: number,
  high: number,
  low: number,
  close: number,
  rawClose = close,
) {
  return { date, open, high, low, close, volume: 7, rawClose };
}

describe('the venue-neutral hygiene step', () => {
  it('leaves the bar shape alone, so the Alpaca path is unaffected by the Saxo repair', () => {
    const swapped = { ...bar('2020-01-02', 10), open: 10.4, high: 10.1, low: 9.9 };
    const { bars, report } = applyBarHygiene('X', [swapped], { fetchDate: '2099-01-01' });
    expect(bars).toEqual([swapped]);
    expect(report).not.toHaveProperty('shape_repair');
  });
});

describe('repairBarShape', () => {
  it('widens the range to cover open and close and never touches open, close, rawClose or volume', () => {
    const { bars, report } = repairBarShape([
      ohlc('2020-01-02', 10.2, 10.1, 9.9, 10, 10.05),
      ohlc('2020-01-03', 10, 10.5, 10.1, 10.4, 10.35),
    ]);
    expect(bars).toEqual([
      ohlc('2020-01-02', 10.2, 10.2, 9.9, 10, 10.05),
      ohlc('2020-01-03', 10, 10.5, 10, 10.4, 10.35),
    ]);
    expect(report).toEqual({ rescaled_fields: [], dropped_glitch_dates: [], ranges_widened: 2 });
  });

  it('widens a swapped high and low to the four-price envelope', () => {
    const { bars } = repairBarShape([ohlc('2020-01-02', 10, 9.8, 10.2, 10.1)]);
    expect(bars).toEqual([ohlc('2020-01-02', 10, 10.2, 9.8, 10.1)]);
  });

  it('leaves a valid bar and a flat bar untouched, the same object', () => {
    const valid = ohlc('2020-01-02', 10, 10.5, 9.8, 10.2);
    const flat = ohlc('2020-01-03', 10, 10, 10, 10);
    const { bars, report } = repairBarShape([valid, flat]);
    expect(bars[0]).toBe(valid);
    expect(bars[1]).toBe(flat);
    expect(report).toEqual({ rescaled_fields: [], dropped_glitch_dates: [], ranges_widened: 0 });
  });

  it('rescales a high that is 100× the other prices back to the unit', () => {
    const { bars, report } = repairBarShape([ohlc('2016-11-23', 17.49, 1750.25, 17.25, 17.365)]);
    expect(bars[0]?.high).toBeCloseTo(17.5025, 10);
    expect(bars[0]).toMatchObject({ open: 17.49, low: 17.25, close: 17.365, rawClose: 17.365 });
    expect(report.rescaled_fields).toEqual([{ date: '2016-11-23', field: 'high', factor: 0.01 }]);
    expect(report.ranges_widened).toBe(0);
  });

  it('rescales a low that is 1/100 of the other prices up to the unit', () => {
    const { bars, report } = repairBarShape([ohlc('2011-09-28', 11.31, 11.395, 0.1129, 11.34)]);
    expect(bars[0]?.low).toBeCloseTo(11.29, 10);
    expect(report.rescaled_fields).toEqual([{ date: '2011-09-28', field: 'low', factor: 100 }]);
  });

  it('rescales an open that is off by the unit factor and widens the range around it', () => {
    const { bars, report } = repairBarShape([ohlc('2011-09-20', 0.1148, 11.5, 11.4, 11.44)]);
    expect(bars[0]?.open).toBeCloseTo(11.48, 10);
    expect(bars[0]?.high).toBeCloseTo(11.5, 10);
    expect(report.rescaled_fields).toEqual([{ date: '2011-09-20', field: 'open', factor: 100 }]);
  });

  it('rescales two fields off by the unit in one bar', () => {
    const { bars, report } = repairBarShape([ohlc('2011-09-20', 11.4, 1150, 0.114, 11.44)]);
    expect(bars[0]).toMatchObject({ open: 11.4, close: 11.44 });
    expect(bars[0]?.high).toBeCloseTo(11.5, 10);
    expect(bars[0]?.low).toBeCloseTo(11.4, 10);
    expect(report.rescaled_fields.map((r) => r.field)).toEqual(['high', 'low']);
  });

  it('does not treat a ratio outside the (90, 110) band as a unit error', () => {
    const { bars, report } = repairBarShape([
      ohlc('2017-03-02', 229.26, 232.215, 22.3844, 232.215),
    ]);
    expect(report.rescaled_fields).toEqual([]);
    expect(bars).toEqual([]);
    expect(report.dropped_glitch_dates).toEqual(['2017-03-02']);
  });

  it('drops a bar whose four prices still span more than 1.4x after the unit repair, and reports the date', () => {
    const glitch = ohlc('2012-02-06', 154.35, 154.35, 94.87, 94.87);
    const justOver = ohlc('2012-02-07', 10, 14.01, 10, 12);
    const widenedOnly = ohlc('2012-02-08', 14, 19.5, 14.3, 19.4);
    const { bars, report } = repairBarShape([glitch, justOver, widenedOnly]);
    expect(bars).toEqual([ohlc('2012-02-08', 14, 19.5, 14, 19.4)]);
    expect(report.dropped_glitch_dates).toEqual(['2012-02-06', '2012-02-07']);
  });

  it('keeps a bar whose four prices span exactly 1.4x', () => {
    const edge = ohlc('2020-01-02', 10, 14, 10, 14);
    const { bars, report } = repairBarShape([edge]);
    expect(bars).toEqual([edge]);
    expect(report.dropped_glitch_dates).toEqual([]);
  });

  it('passes a non-positive or non-finite price through untouched for the store to reject', () => {
    const broken = [
      ohlc('2020-01-02', 10, 10.5, 0, 10),
      ohlc('2020-01-03', 10, Number.NaN, 9, 10),
      ohlc('2020-01-06', 10, 10.5, 9, Number.POSITIVE_INFINITY),
    ];
    const { bars, report } = repairBarShape(broken);
    expect(bars).toEqual(broken);
    expect(report).toEqual({ rescaled_fields: [], dropped_glitch_dates: [], ranges_widened: 0 });
  });

  it('is idempotent and always yields bars the store invariant accepts, over random glitched series', () => {
    let seed = 1838;
    const random = () => {
      seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296;
      return seed / 4_294_967_296;
    };
    const glitchFactors = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 100, 0.01, 1.6, 0.6, 9, 0.3];
    const noisy = (level: number) =>
      level *
      (1 + (random() - 0.5) * 0.06) *
      (glitchFactors[Math.floor(random() * glitchFactors.length)] as number);
    const dates = calendar.slice(0, 400);
    const raw = dates.map((date, i) => {
      const level = 10 + Math.sin(i / 20) * 3;
      return ohlc(date, noisy(level), noisy(level), noisy(level), level, level * 0.98);
    });
    const once = repairBarShape(raw);
    const twice = repairBarShape(once.bars);
    expect(twice.bars).toEqual(once.bars);
    expect(twice.report).toEqual({
      rescaled_fields: [],
      dropped_glitch_dates: [],
      ranges_widened: 0,
    });
    expect(once.report.rescaled_fields.length).toBeGreaterThan(10);
    expect(once.report.dropped_glitch_dates.length).toBeGreaterThan(10);
    expect(once.report.ranges_widened).toBeGreaterThan(10);
    expect(once.bars.length + once.report.dropped_glitch_dates.length).toBe(raw.length);
    for (const b of once.bars) {
      expect(b.low).toBeLessThanOrEqual(Math.min(b.open, b.close));
      expect(b.high).toBeGreaterThanOrEqual(Math.max(b.open, b.close));
      expect(b.high).toBeGreaterThanOrEqual(b.low);
      expect(b.rawClose).toBe(b.close * 0.98);
    }
  });
});
