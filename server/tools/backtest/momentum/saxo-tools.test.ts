import type { SaxoSessionState } from '../../../pipeline/execution/adapters/saxo-token-source.js';
import type { FetchResult } from './alpaca-bars-api.js';
import {
  applyBarHygiene,
  dropNonSessionBars,
  findHolesAndFlips,
  findUnitBreaks,
  normaliseUnitBreaks,
} from './bar-hygiene.js';
import { tradingCalendar } from './fixture.js';
import type { FxRate } from './fx.js';
import {
  gbpPerQuotedUnit,
  isSpliced,
  LSE_AUX_LINES,
  LSE_CALENDAR_REFERENCE,
  LSE_MOMENTUM_LINES,
} from './lse-lines.js';
import {
  burstRows,
  nearestRankPercentile,
  parseSaxoSpreadCsv,
  SAXO_SPREAD_CSV_HEADER,
  saxoSpreadRowsToCsv,
} from './measure-saxo-spread.js';
import {
  assertUnitMatchesSaxo,
  density,
  distributionAdjustmentCheck,
  parseSaxoPullArgs,
  windowStartOf,
} from './pull-saxo-bars.js';
import type { ChartSample, InfoPriceQuote } from './saxo-api.js';
import {
  mergeChartPages,
  parseChartPage,
  parseInfoPricesList,
  parseInstrumentDetails,
  SAXO_CHART_PAGE,
  SaxoReadOnlyApi,
  samplesToBars,
} from './saxo-api.js';
import {
  convertUsdBarsToGbp,
  overlapStats,
  SPLICE_MAX_MEAN_ABS_RETURN_DIFF_BPS,
  SPLICE_MIN_OVERLAP_SESSIONS,
  spliceSibling,
} from './splice.js';

const calendar = tradingCalendar('2010-01-04', 2_500);

function sample(date: string, close: number): ChartSample {
  return {
    Time: `${date}T00:00:00.000000Z`,
    Open: close,
    High: close,
    Low: close,
    Close: close,
    Volume: 1,
  };
}

function bar(date: string, close: number) {
  return { date, open: close, high: close, low: close, close, volume: 1, rawClose: close };
}

const tokens = {
  getAccessToken: async () => 'tok',
  sessionState: (): SaxoSessionState => ({ status: 'active' }) as SaxoSessionState,
  stop: async () => {},
};

describe('lse lines', () => {
  it('declares 24 pre-registered lines, two of them spliced from a USD sibling, plus the Acc aux line', () => {
    expect(LSE_MOMENTUM_LINES.length).toBe(24);
    expect(new Set(LSE_MOMENTUM_LINES.map((line) => line.tidm)).size).toBe(24);
    expect(new Set(LSE_MOMENTUM_LINES.map((line) => line.uic)).size).toBe(24);
    expect(LSE_MOMENTUM_LINES.filter(isSpliced).map((line) => line.tidm)).toEqual(['IHCU', 'CMFP']);
    expect(LSE_MOMENTUM_LINES.filter(isSpliced).map((line) => line.spliceFrom.unit)).toEqual([
      'USD',
      'USD',
    ]);
    expect(LSE_MOMENTUM_LINES.some((line) => line.tidm === LSE_CALENDAR_REFERENCE)).toBe(true);
    expect(LSE_AUX_LINES.map((line) => line.tidm)).toEqual(['CUKX']);
  });

  it('converts GBX to GBP exactly once by unit and refuses a unit factor for USD', () => {
    expect(gbpPerQuotedUnit('GBX')).toBe(0.01);
    expect(gbpPerQuotedUnit('GBP')).toBe(1);
    expect(() => gbpPerQuotedUnit('USD')).toThrow(/needs an FX rate/);
  });
});

describe('saxo chart parsing', () => {
  it('parses ChartInfo and samples and rejects malformed bodies', () => {
    const page = parseChartPage({
      ChartInfo: { FirstSampleTime: '2000-04-28T00:00:00Z', DelayedByMinutes: 15 },
      Data: [sample('2016-01-05', 2), sample('2016-01-04', 1)],
    });
    expect(page.firstSampleTime).toBe('2000-04-28T00:00:00Z');
    expect(page.delayedByMinutes).toBe(15);
    expect(page.samples.length).toBe(2);
    expect(() => parseChartPage({ Data: 'x' })).toThrow(/Data is not an array/);
    expect(() => parseChartPage({ Data: [{ Time: 'x' }] })).toThrow(/malformed sample/);
    expect(() => parseChartPage(null)).toThrow(/non-object/);
  });

  it('scales GBX samples by 0.01 once, sorts by date and sets rawClose to the scaled close', () => {
    const bars = samplesToBars([sample('2016-01-05', 250), sample('2016-01-04', 200)], 0.01);
    expect(bars.map((b) => b.date)).toEqual(['2016-01-04', '2016-01-05']);
    expect(bars.map((b) => b.close)).toEqual([2, 2.5]);
    expect(bars.map((b) => b.rawClose)).toEqual([2, 2.5]);
    expect(bars[0]?.open).toBe(2);
    expect(() => samplesToBars([], 0)).toThrow(/bad unit factor/);
  });

  it('merges pages by sample time, later pages overriding, in ascending order', () => {
    const merged = mergeChartPages([
      [sample('2016-01-06', 3), sample('2016-01-05', 2)],
      [sample('2016-01-05', 9), sample('2016-01-04', 1)],
    ]);
    expect(merged.map((s) => [s.Time.slice(0, 10), s.Close])).toEqual([
      ['2016-01-04', 1],
      ['2016-01-05', 9],
      ['2016-01-06', 3],
    ]);
  });

  it('parses instrument details with defaults and infoprices quotes, dropping unusable ones', () => {
    const details = parseInstrumentDetails({
      Symbol: 'ISF:xlon',
      CurrencyCode: 'GBP',
      PriceToContractFactor: 0.01,
      IsTradable: true,
      IsComplex: false,
      Exchange: { ExchangeId: 'LSE_ETF' },
    });
    expect(details).toEqual({
      symbol: 'ISF:xlon',
      currencyCode: 'GBP',
      priceToContractFactor: 0.01,
      isTradable: true,
      isComplex: false,
      exchangeId: 'LSE_ETF',
    });
    expect(parseInstrumentDetails({}).priceToContractFactor).toBe(1);
    expect(() => parseInstrumentDetails(1)).toThrow(/non-object/);
    const quotes = parseInfoPricesList({
      Data: [
        {
          Uic: 1,
          LastUpdated: 't',
          Quote: { Bid: 100, Ask: 101, DelayedByMinutes: 15, MarketState: 'Open' },
        },
        { Uic: 2, Quote: { Bid: 0, Ask: 1 } },
        { Uic: 3, Quote: { Bid: 5, Ask: 4 } },
        { Quote: { Bid: 1, Ask: 2 } },
        'junk',
      ],
    });
    expect(quotes).toEqual([
      { uic: 1, bid: 100, ask: 101, delayedByMinutes: 15, marketState: 'Open', lastUpdated: 't' },
    ]);
    expect(() => parseInfoPricesList({})).toThrow(/Data missing/);
  });
});

describe('saxo read-only api', () => {
  it('pages back with Mode=UpTo until a short page, keeping only samples older than the cursor', async () => {
    const dates = calendar.slice(0, 2 * SAXO_CHART_PAGE + 5);
    const calls: string[] = [];
    const fetcher = async (url: string, token: string): Promise<FetchResult> => {
      calls.push(url);
      expect(token).toBe('tok');
      const params = new URL(url).searchParams;
      const upTo = params.get('Time');
      const eligible =
        upTo === null ? dates : dates.filter((date) => `${date}T00:00:00.000000Z` <= upTo);
      const page = eligible.slice(-SAXO_CHART_PAGE);
      return {
        status: 200,
        body: {
          ChartInfo: { DelayedByMinutes: 15 },
          Data: page.map((date, i) => sample(date, i + 1)),
        },
      };
    };
    const api = new SaxoReadOnlyApi(tokens, 'https://gw.example/openapi/', fetcher, async () => {});
    const history = await api.dailyHistory(4361, 'Etf');
    expect(history.delayedByMinutes).toBe(15);
    expect(history.samples.length).toBe(dates.length);
    expect(history.samples[0]?.Time.slice(0, 10)).toBe(dates[0]);
    expect(calls.length).toBe(3);
    expect(calls[0]).toContain('/openapi/chart/v3/charts?');
    expect(calls[0]).toContain('Horizon=1440');
    expect(calls[0]).toContain('FieldGroups=ChartInfo%2CData');
    expect(calls[1]).toContain('Mode=UpTo');
  });

  it('stops paging when the older page brings nothing new', async () => {
    const dates = calendar.slice(0, SAXO_CHART_PAGE);
    let calls = 0;
    const fetcher = async (): Promise<FetchResult> => {
      calls++;
      return { status: 200, body: { Data: dates.map((date, i) => sample(date, i + 1)) } };
    };
    const api = new SaxoReadOnlyApi(tokens, 'https://gw.example', fetcher, async () => {});
    const history = await api.dailyHistory(1, 'Etc');
    expect(history.samples.length).toBe(SAXO_CHART_PAGE);
    expect(calls).toBe(2);
  });

  it('backs off on 429, retries a 401 twice and throws on any other status', async () => {
    const sleeps: number[] = [];
    let attempt = 0;
    const api = new SaxoReadOnlyApi(
      tokens,
      'https://gw.example',
      async () => {
        attempt++;
        if (attempt === 1) return { status: 429, body: '' };
        if (attempt === 2) return { status: 401, body: '' };
        return { status: 200, body: { Symbol: 'X' } };
      },
      async (ms) => {
        sleeps.push(ms);
      },
    );
    expect((await api.instrumentDetails(1, 'Etf')).symbol).toBe('X');
    expect(sleeps).toEqual([65_000, 2_000]);
    const failing = new SaxoReadOnlyApi(
      tokens,
      'https://gw.example',
      async () => ({ status: 500, body: 'boom' }),
      async () => {},
    );
    await expect(failing.infoPrices([1])).rejects.toThrow(/Saxo 500/);
    const dead = new SaxoReadOnlyApi(
      tokens,
      'https://gw.example',
      async () => ({ status: 401, body: '' }),
      async () => {},
    );
    await expect(dead.instrumentDetails(1, 'Etf')).rejects.toThrow(/Saxo 401/);
  });

  it('paces chart calls at 100 per minute', async () => {
    const sleeps: number[] = [];
    const api = new SaxoReadOnlyApi(
      tokens,
      'https://gw.example',
      async () => ({ status: 200, body: { Data: [] } }),
      async (ms) => {
        sleeps.push(ms);
      },
    );
    for (let i = 0; i < 101; i++) await api.dailyHistory(1, 'Etf');
    expect(sleeps.length).toBe(1);
    expect(sleeps[0]).toBeGreaterThan(0);
    expect(sleeps[0]).toBeLessThanOrEqual(60_500);
  });
});

describe('sibling splice', () => {
  const rates: FxRate[] = [
    { date: '2015-12-31', usdPerGbp: 1.5 },
    { date: '2016-01-05', usdPerGbp: 2 },
  ];

  it('converts USD bars with the last BoE fix on or before each date, exactly once', () => {
    const gbp = convertUsdBarsToGbp(
      [bar('2016-01-04', 3), bar('2016-01-05', 4), bar('2016-01-06', 5)],
      rates,
    );
    expect(gbp.map((b) => b.close)).toEqual([2, 2, 2.5]);
    expect(gbp.map((b) => b.rawClose)).toEqual([2, 2, 2.5]);
    expect(gbp[0]?.high).toBe(2);
    expect(() => convertUsdBarsToGbp([bar('2015-01-01', 1)], rates)).toThrow(
      /no BoE fix on or before 2015-01-01/,
    );
  });

  it('measures the overlap in returns on common dates only', () => {
    const primary = [
      bar('2016-01-04', 100),
      bar('2016-01-05', 101),
      bar('2016-01-06', 102),
      bar('2016-01-07', 103),
    ];
    const sibling = [bar('2016-01-04', 200), bar('2016-01-05', 202), bar('2016-01-07', 206)];
    const stats = overlapStats(primary, sibling);
    expect(stats.sessions).toBe(2);
    expect(stats.meanAbsReturnDiffBps).toBeCloseTo(
      ((0.01 - 0.01 + Math.abs(103 / 101 - 206 / 202)) / 2) * 10_000,
      6,
    );
    expect(stats.returnCorrelation).toBeCloseTo(1, 9);
    expect(overlapStats(primary, []).sessions).toBe(0);
    expect(overlapStats(primary, []).meanAbsReturnDiffBps).toBeNaN();
  });

  it('prepends only the sibling bars before the primary first bar and applies the pre-declared tolerance', () => {
    const dates = calendar.slice(0, 200);
    const sibling = dates.map((date, i) => bar(date, 100 + i * 0.1));
    const primary = dates.slice(100).map((date, i) => bar(date, 100 + (100 + i) * 0.1));
    const result = spliceSibling({ symbol: 'X', bars: primary }, sibling);
    expect(result.spliceDate).toBe(dates[100]);
    expect(result.siblingBarsUsed).toBe(100);
    expect(result.bars.length).toBe(200);
    expect(result.bars[99]?.date).toBe(dates[99]);
    expect(result.overlap.sessions).toBe(99);
    expect(result.overlap.sessions).toBeGreaterThanOrEqual(SPLICE_MIN_OVERLAP_SESSIONS);
    expect(result.overlap.meanAbsReturnDiffBps).toBeLessThanOrEqual(
      SPLICE_MAX_MEAN_ABS_RETURN_DIFF_BPS,
    );
    expect(result.withinTolerance).toBe(true);
    const noisy = dates.map((date, i) =>
      bar(date, (100 + i * 0.1) * (i % 2 === 0 ? 1.002 : 0.998)),
    );
    expect(spliceSibling({ symbol: 'X', bars: primary }, noisy).withinTolerance).toBe(false);
    const thin = spliceSibling({ symbol: 'X', bars: primary }, sibling.slice(0, 110));
    expect(thin.overlap.sessions).toBe(9);
    expect(thin.withinTolerance).toBe(false);
    expect(() => spliceSibling({ symbol: 'E', bars: [] }, sibling)).toThrow(/has no bars/);
  });
});

describe('saxo spread measurement', () => {
  const quote = (uic: number, bid: number, ask: number): InfoPriceQuote => ({
    uic,
    bid,
    ask,
    delayedByMinutes: 15,
    marketState: 'Open',
    lastUpdated: '',
  });

  it('takes the nearest-rank percentile', () => {
    expect(nearestRankPercentile([5, 1, 3, 2, 4], 0.25)).toBe(2);
    expect(nearestRankPercentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(nearestRankPercentile([7], 0.25)).toBe(7);
    expect(() => nearestRankPercentile([], 0.5)).toThrow(/empty/);
  });

  it('builds one row per declared line from the bursts, in line order, skipping lines with no quote', () => {
    const isf = LSE_MOMENTUM_LINES[0];
    const vmid = LSE_MOMENTUM_LINES[1];
    if (isf === undefined || vmid === undefined) throw new Error('fixture');
    const bursts = [1, 2, 3, 4, 5].map((k) => [
      quote(isf.uic, 100, 100 + k * 0.02),
      quote(vmid.uic, 50, 50.1),
    ]);
    const rows = burstRows(bursts, '2026-09-25T11:00:00Z');
    expect(rows.map((row) => row.symbol)).toEqual(['ISF', 'VMID']);
    expect(rows[0]?.samples).toBe(5);
    expect(rows[0]?.p25HalfSpreadBps).toBeCloseTo((0.04 / 2 / 100.02) * 10_000, 6);
    expect(rows[0]?.medianHalfSpreadBps).toBeCloseTo((0.06 / 2 / 100.03) * 10_000, 6);
    const csv = saxoSpreadRowsToCsv(rows);
    expect(csv.startsWith(`${SAXO_SPREAD_CSV_HEADER}\n`)).toBe(true);
    const parsed = parseSaxoSpreadCsv(csv);
    expect(parsed.get('VMID')?.uic).toBe(vmid.uic);
    expect(parsed.get('ISF')?.measuredAt).toBe('2026-09-25T11:00:00Z');
    expect(() => parseSaxoSpreadCsv('x\n')).toThrow(/unexpected header/);
    expect(() => parseSaxoSpreadCsv(`${SAXO_SPREAD_CSV_HEADER}\nISF,1,5,-1,2,t\n`)).toThrow(
      /malformed row/,
    );
  });
});

describe('pull-saxo-bars helpers', () => {
  it('measures density as bars per trading year of the span', () => {
    const dense = calendar.slice(0, 252).map((date, i) => bar(date, i + 1));
    expect(density(dense)).toBeGreaterThan(0.95);
    expect(density(dense)).toBeLessThan(1.05);
    expect(density(dense.filter((_, i) => i % 2 === 0))).toBeLessThan(0.55);
    expect(density([])).toBe(0);
    expect(density([dense[0] as (typeof dense)[number]])).toBe(0);
  });

  it('refuses a line whose Saxo PriceToContractFactor disagrees with the declared unit', () => {
    const gbx = { tidm: 'ISF', uic: 1, assetType: 'Etf' as const, unit: 'GBX' as const, role: '' };
    const details = parseInstrumentDetails({ PriceToContractFactor: 0.01 });
    expect(() => assertUnitMatchesSaxo(gbx, details)).not.toThrow();
    expect(() => assertUnitMatchesSaxo({ ...gbx, unit: 'GBP' }, details)).toThrow(
      /PriceToContractFactor is 0.01/,
    );
    expect(() =>
      assertUnitMatchesSaxo({ ...gbx, unit: 'USD' }, parseInstrumentDetails({})),
    ).not.toThrow();
  });

  it('reads distribution drift from the dist/acc close ratio', () => {
    const dates = calendar.slice(0, 253);
    const acc = { symbol: 'ACC', bars: dates.map((date) => bar(date, 100)) };
    const dist = {
      symbol: 'DIST',
      bars: dates.map((date, i) => bar(date, 100 * (1 - (0.03 * i) / 252))),
    };
    const check = distributionAdjustmentCheck(dist, acc) as {
      annualised_drift: number;
      from: string;
    };
    expect(check.from).toBe(dates[0]);
    expect(check.annualised_drift).toBeLessThan(-0.02);
    expect(check.annualised_drift).toBeGreaterThan(-0.04);
    expect(distributionAdjustmentCheck(dist, { symbol: 'X', bars: [] })).toEqual({
      pair: ['DIST', 'X'],
      result: 'no common dates',
    });
  });

  it('binds the window to the latest first bar and parses CLI flags with defaults', () => {
    expect(
      windowStartOf({
        A: { first: '2010-01-01' },
        B: { first: '2016-06-21' },
        C: { first: '2012-01-01' },
      }),
    ).toEqual({
      windowStart: '2016-06-21',
      binding: 'B',
    });
    expect(windowStartOf({})).toEqual({ windowStart: '', binding: '' });
    expect(parseSaxoPullArgs([])).toEqual({
      outDir: 'data/bars/saxo',
      auxDir: 'data/bars/saxo-aux',
      spreads: 'data/bars/saxo-spreads.csv',
      fx: 'data/bars/fx/gbpusd-boe-xudluss.csv',
      tokenFile: undefined,
    });
    expect(parseSaxoPullArgs(['--out', 'o', '--token-file', 't']).tokenFile).toBe('t');
  });
});

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
