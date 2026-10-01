import { describe, expect, it } from 'vitest';
import {
  applyBarHygiene,
  dropNonSessionBars,
  findHolesAndFlips,
  findUnitBreaks,
  normaliseUnitBreaks,
  quarantineImplausibleBars,
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
    expect(report).toEqual({
      rescaled_fields: [],
      neighbour_repairs: [],
      dropped_glitch_dates: [],
      ranges_widened: 2,
    });
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
    expect(report).toEqual({
      rescaled_fields: [],
      neighbour_repairs: [],
      dropped_glitch_dates: [],
      ranges_widened: 0,
    });
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
    expect(report.neighbour_repairs).toEqual([{ date: '2017-03-02', field: 'low' }]);
    expect(bars).toEqual([ohlc('2017-03-02', 229.26, 232.215, 229.26, 232.215)]);
  });

  it('drops a bar spanning more than 1.4x when its close disagrees with a neighbour too far for the neighbour rule', () => {
    const before = ohlc('2012-02-10', 21.96, 21.96, 21.96, 21.96);
    const glitch = ohlc('2012-02-13', 22.38, 22.38, 14, 22.38);
    const after = ohlc('2012-02-14', 14.04, 14.04, 13.98, 13.98);
    const { bars, report } = repairBarShape([before, glitch, after]);
    expect(bars).toEqual([before, after]);
    expect(report.neighbour_repairs).toEqual([]);
    expect(report.dropped_glitch_dates).toEqual(['2012-02-13']);
  });

  it('drops a bar spanning just over 1.4x and keeps one spanning exactly 1.4x', () => {
    const around = (date: string, open: number, high: number, low: number, close: number) =>
      repairBarShape([
        ohlc('2020-01-01', 10, 10, 10, 10),
        ohlc(date, open, high, low, close),
        ohlc('2020-01-03', 14, 14, 14, 14),
      ]);
    const edge = around('2020-01-02', 10, 14, 10, 14);
    expect(edge.bars.map((b) => b.date)).toEqual(['2020-01-01', '2020-01-02', '2020-01-03']);
    expect(edge.report.dropped_glitch_dates).toEqual([]);
    const justOver = around('2020-01-02', 10, 14.01, 10, 12);
    expect(justOver.report.neighbour_repairs).toEqual([]);
    expect(justOver.report.dropped_glitch_dates).toEqual(['2020-01-02']);
  });

  it('passes a non-positive or non-finite price through untouched for the store to reject', () => {
    const broken = [
      ohlc('2020-01-02', 10, 10.5, 0, 10),
      ohlc('2020-01-03', 10, Number.NaN, 9, 10),
      ohlc('2020-01-06', 10, 10.5, 9, Number.POSITIVE_INFINITY),
    ];
    const { bars, report } = repairBarShape(broken);
    expect(bars).toEqual(broken);
    expect(report).toEqual({
      rescaled_fields: [],
      neighbour_repairs: [],
      dropped_glitch_dates: [],
      ranges_widened: 0,
    });
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
      const level = (10 + Math.sin(i / 20) * 3) * (random() < 0.04 ? 1.6 : 1);
      return ohlc(date, noisy(level), noisy(level), noisy(level), level, level * 0.98);
    });
    const once = repairBarShape(raw);
    const twice = repairBarShape(once.bars);
    expect(twice.bars).toEqual(once.bars);
    expect(twice.report).toEqual({
      rescaled_fields: [],
      neighbour_repairs: [],
      dropped_glitch_dates: [],
      ranges_widened: 0,
    });
    expect(once.report.rescaled_fields.length).toBeGreaterThan(10);
    expect(once.report.neighbour_repairs.length).toBeGreaterThan(10);
    expect(once.report.dropped_glitch_dates.length).toBeGreaterThan(2);
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

describe('repairBarShape against the neighbouring closes', () => {
  it('keeps the SPOG 2020-03-09 crash close and replaces its bad open and high with it', () => {
    const { bars, report } = repairBarShape([
      ohlc('2020-03-06', 8.3, 8.4, 8.2, 8.2513),
      ohlc('2020-03-09', 11.37, 11.37, 6, 6.115),
      ohlc('2020-03-10', 6, 6.1, 5.9, 5.97),
    ]);
    expect(bars[1]).toEqual(ohlc('2020-03-09', 6.115, 6.115, 6, 6.115));
    expect(report.neighbour_repairs).toEqual([
      { date: '2020-03-09', field: 'open' },
      { date: '2020-03-09', field: 'high' },
    ]);
    expect(report.dropped_glitch_dates).toEqual([]);
  });

  it('keeps the SPGP 2020-03-17 close and replaces its bad open and low, then widens', () => {
    const { bars, report } = repairBarShape([
      ohlc('2020-03-16', 7.485, 7.715, 7.2, 7.3275),
      ohlc('2020-03-17', 5.8996, 9.0592, 5.8996, 8.385),
      ohlc('2020-03-18', 8.3, 8.4, 7.9, 8.1),
    ]);
    expect(bars[1]).toEqual(ohlc('2020-03-17', 8.385, 9.0592, 8.385, 8.385));
    expect(report.neighbour_repairs.map((r) => r.field)).toEqual(['open', 'low']);
    expect(report.dropped_glitch_dates).toEqual([]);
  });

  it('replaces the IUSA 2017-01-20 high and widens the range back over the open', () => {
    const { bars, report } = repairBarShape([
      ohlc('2017-01-19', 18.3, 18.35, 18.28, 18.3287),
      ohlc('2017-01-20', 18.37, 22.529, 18.3, 18.3438),
      ohlc('2017-01-23', 18.05, 18.1, 18, 18.0362),
    ]);
    expect(bars[1]).toEqual(ohlc('2017-01-20', 18.37, 18.37, 18.3, 18.3438));
    expect(report.neighbour_repairs).toEqual([{ date: '2017-01-20', field: 'high' }]);
    expect(report.ranges_widened).toBe(1);
  });

  it('keeps a field exactly 1.1x beyond the closes and replaces one just past it, both ways', () => {
    const middle = (open: number, high: number, low: number) =>
      repairBarShape([
        ohlc('2020-01-01', 10, 10, 10, 10),
        ohlc('2020-01-02', open, high, low, 10),
        ohlc('2020-01-03', 10, 10, 10, 10),
      ]).report.neighbour_repairs.map((r) => r.field);
    expect(middle(10, 11, 10)).toEqual([]);
    expect(middle(10, 11.001, 10)).toEqual(['high']);
    expect(middle(10, 10, 9.1)).toEqual([]);
    expect(middle(10, 10, 9.09)).toEqual(['low']);
    expect(middle(11.001, 11.001, 10)).toEqual(['open', 'high']);
  });

  it('judges the first and last bar against the one neighbour they have and their own close', () => {
    const { bars, report } = repairBarShape([
      ohlc('2020-01-01', 13.3, 13.3, 12, 12),
      ohlc('2020-01-02', 10, 10, 10, 10),
      ohlc('2020-01-03', 12, 13, 12, 12),
      ohlc('2020-01-06', 10, 10, 10, 10),
      ohlc('2020-01-07', 12, 13.3, 12, 12),
    ]);
    expect(report.neighbour_repairs).toEqual([
      { date: '2020-01-01', field: 'open' },
      { date: '2020-01-01', field: 'high' },
      { date: '2020-01-07', field: 'high' },
    ]);
    expect(bars[2]).toEqual(ohlc('2020-01-03', 12, 13, 12, 12));
    expect(bars[4]).toEqual(ohlc('2020-01-07', 12, 12, 12, 12));
  });

  it('never changes a close, so a glitched close such as IEEM 2014-06-20 stays in place', () => {
    const { bars, report } = repairBarShape([
      ohlc('2014-06-19', 23.97, 23.97, 23.97, 23.97),
      ohlc('2014-06-20', 23.8723, 23.91, 23.8322, 29.931),
      ohlc('2014-06-23', 23.8873, 23.8873, 23.8873, 23.8873),
    ]);
    expect(report.neighbour_repairs).toEqual([]);
    expect(bars[1]).toEqual(ohlc('2014-06-20', 23.8723, 29.931, 23.8322, 29.931));
  });

  it('rescales a unit-off field before the neighbour rule could replace it', () => {
    const { bars, report } = repairBarShape([
      ohlc('2016-11-22', 17.5025, 17.5025, 17.5025, 17.5025),
      ohlc('2016-11-23', 17.49, 1750.25, 17.25, 17.365),
      ohlc('2016-11-24', 17.4825, 17.4825, 17.4825, 17.4825),
    ]);
    expect(bars[1]?.high).toBeCloseTo(17.5025, 10);
    expect(report.rescaled_fields).toEqual([{ date: '2016-11-23', field: 'high', factor: 0.01 }]);
    expect(report.neighbour_repairs).toEqual([]);
  });

  it('leaves an unreadable bar between readable ones for the store to reject', () => {
    const broken = ohlc('2020-01-02', 10, Number.NaN, 9, 10);
    const { bars, report } = repairBarShape([
      ohlc('2020-01-01', 10, 10.5, 9.5, 10),
      broken,
      ohlc('2020-01-03', 10, 10.5, 9.5, 10),
    ]);
    expect(bars[1]).toBe(broken);
    expect(report.neighbour_repairs).toEqual([]);
  });
});

describe('quarantineImplausibleBars', () => {
  type Bar = ReturnType<typeof ohlc>;
  const flatBar = (date: string, close: number) => ohlc(date, close, close, close, close);
  const around = (previousClose: number, bar: Bar, nextClose: number | undefined): Bar[] => [
    flatBar('2000-01-03', previousClose),
    bar,
    ...(nextClose === undefined ? [] : [flatBar('2099-12-31', nextClose)]),
  ];

  it('quarantines the SPY, MRK and VZ low prints from #1889 and names the field, price and ratio', () => {
    const cases: readonly [number, Bar, number][] = [
      [686.58, ohlc('2026-02-02', 684.2, 691.5, 68.47, 689.99), 684.15],
      [64.21, ohlc('2021-06-11', 64.69, 64.82, 12.92, 64.32), 64.17],
      [38.19, ohlc('2026-01-08', 38.23, 38.76, 10.09, 38.61), 38.5],
    ];
    for (const [previous, bar, next] of cases) {
      const { bars, quarantined } = quarantineImplausibleBars(around(previous, bar, next));
      expect(bars.map((b) => b.date)).toEqual(['2000-01-03', '2099-12-31']);
      expect(quarantined).toEqual([
        {
          date: bar.date,
          field: 'low',
          price: bar.low,
          ratio: Math.min(previous, next, bar.close) / bar.low,
        },
      ]);
    }
  });

  it('quarantines the BBBY 2016-10-27 high print', () => {
    const bar = ohlc('2016-10-27', 35.61, 108.26, 35.04, 35.19);
    const { quarantined } = quarantineImplausibleBars(around(35.58, bar, 35.4));
    expect(quarantined).toEqual([
      { date: '2016-10-27', field: 'high', price: 108.26, ratio: 108.26 / 35.58 },
    ]);
  });

  it('keeps the genuine GME 2021-01-28 and FRC 2023-03-13 extremes untouched', () => {
    const gme = around(86.88, ohlc('2021-01-28', 66.25, 120.75, 28.06, 48.4), 81.25);
    const frc = around(81.76, ohlc('2023-03-13', 26.76, 42, 17.53, 31.21), 39.63);
    for (const series of [gme, frc]) {
      const { bars, quarantined } = quarantineImplausibleBars(series);
      expect(quarantined).toEqual([]);
      expect(bars).toEqual(series);
      expect(bars[1]).toBe(series[1]);
    }
  });

  it('keeps a field exactly 2x beyond the closes and quarantines one just past it', () => {
    const flag = (bar: Bar) =>
      quarantineImplausibleBars(around(10, bar, 10)).quarantined.map((q) => q.field);
    expect(flag(ohlc('2020-01-02', 10, 20, 10, 10))).toEqual([]);
    expect(flag(ohlc('2020-01-02', 10, 20.01, 10, 10))).toEqual(['high']);
    expect(flag(ohlc('2020-01-02', 10, 10, 5, 10))).toEqual([]);
    expect(flag(ohlc('2020-01-02', 10, 10, 4.99, 10))).toEqual(['low']);
  });

  it('names the worst field when more than one is beyond the closes', () => {
    const high = quarantineImplausibleBars(around(10, ohlc('2020-01-02', 25, 30, 10, 10), 10));
    expect(high.quarantined).toEqual([{ date: '2020-01-02', field: 'high', price: 30, ratio: 3 }]);
    const open = quarantineImplausibleBars(around(10, ohlc('2020-01-02', 30, 25, 10, 10), 10));
    expect(open.quarantined).toEqual([{ date: '2020-01-02', field: 'open', price: 30, ratio: 3 }]);
    const tie = quarantineImplausibleBars(around(10, ohlc('2020-01-02', 30, 30, 10, 10), 10));
    expect(tie.quarantined[0]?.field).toBe('open');
  });

  it('judges the newest bar on the previous and its own close, and only unflags it once a next close arrives', () => {
    const newest = ohlc('2020-01-02', 10, 21, 10, 10);
    expect(quarantineImplausibleBars(around(10, newest, undefined)).quarantined).toHaveLength(1);
    expect(quarantineImplausibleBars(around(10, newest, 11)).quarantined).toEqual([]);
    let seed = 1889;
    const random = () => {
      seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296;
      return seed / 4_294_967_296;
    };
    let flaggedAsNewest = 0;
    for (let trial = 0; trial < 500; trial++) {
      const close = 5 + random() * 10;
      const high = close * (1 + random() * 2);
      const bar = ohlc('2020-01-02', close, high, close / (1 + random() * 2), close);
      const previous = 5 + random() * 10;
      const asNewest = quarantineImplausibleBars(around(previous, bar, undefined)).quarantined;
      const next = 5 + random() * 10;
      const withNext = quarantineImplausibleBars(around(previous, bar, next)).quarantined;
      if (asNewest.length === 0) expect(withNext).toEqual([]);
      else flaggedAsNewest++;
    }
    expect(flaggedAsNewest).toBeGreaterThan(50);
  });
});
