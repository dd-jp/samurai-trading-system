import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FetchResult, RawDailyBar } from './alpaca-bars-api.js';
import {
  AlpacaBarsApi,
  authHeaders,
  barsUrl,
  credentialsFromEnv,
  endOfDayUtc,
  parseBarsPage,
} from './alpaca-bars-api.js';
import { BAR_CSV_HEADER, barsToCsv, loadBarDirectory, parseBarCsv } from './bar-csv.js';
import { PointInTimeMembership, parseConstituentsCsv } from './constituents.js';
import { GBP_IDENTITY_FX, parseBoeXudlussCsv, YearFixedFx } from './fx.js';
import {
  FIXED_PARAMETERS,
  GRID_A,
  GRID_A_TRIAL_COUNT,
  gridForVenue,
  maxWarmupDays,
  trialHash,
} from './grid.js';
import {
  AlignedMarket,
  MAX_CARRY_FORWARD_DAYS,
  monthEndIndices,
  monthOf,
  yearOf,
} from './market.js';
import {
  halfSpreadBps,
  halfSpreadLookup,
  lastSessions,
  measureSymbol,
  median,
  newYorkUtcOffsetMinutes,
  parseQuotePage,
  parseSpreadCsv,
  quotesUrl,
  SPREAD_CSV_HEADER,
  sampleWindowUtc,
  spreadRowsToCsv,
} from './measure-alpaca-spread.js';
import {
  alpacaSymbolCandidates,
  barDate,
  joinAdjustedAndRaw,
  parsePullArgs,
  pullSymbol,
} from './pull-alpaca-bars.js';
import { distinctTrialCount, ledgerFromGrid, mergeLedger } from './trial-ledger.js';

describe('grid', () => {
  it('numbers Grid A from #1: four LSE trend trials then four US cross-sectional trials', () => {
    expect(GRID_A_TRIAL_COUNT).toBe(8);
    expect(GRID_A.map((trial) => trial.trial)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(gridForVenue('lse').map((trial) => [trial.lookbackDays, trial.stop === null])).toEqual([
      [252, true],
      [252, false],
      [126, true],
      [126, false],
    ]);
    expect(gridForVenue('us').every((trial) => trial.family === 'cross-sectional-top-k')).toBe(
      true,
    );
    expect(gridForVenue('lse').every((trial) => trial.family === 'time-series-trend')).toBe(true);
  });

  it('fixes the non-searched parameters per doc 70', () => {
    expect(FIXED_PARAMETERS).toEqual({
      skipDays: 21,
      stop: { atrWindow: 20, atrMultiple: 2 },
      topK: 10,
      volWindowDays: 60,
      targetVolatility: 0.1,
      grossCap: 1,
    });
    for (const trial of GRID_A) {
      expect(trial.executionLagBars).toBe(1);
      expect(trial.rebalance).toBe('monthly-last-session');
    }
    expect(maxWarmupDays(GRID_A)).toBe(252);
  });

  it('hashes the config identity, not the trial number', () => {
    const [first] = GRID_A;
    expect(trialHash({ ...(first as (typeof GRID_A)[number]), trial: 99 })).toBe(
      trialHash(first as (typeof GRID_A)[number]),
    );
    expect(new Set(GRID_A.map(trialHash)).size).toBe(8);
    expect(trialHash(first as (typeof GRID_A)[number])).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('trial ledger', () => {
  it('records eight distinct trials numbered from one', () => {
    const ledger = ledgerFromGrid(GRID_A);
    expect(ledger.entries.map((entry) => entry.trial)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(distinctTrialCount(ledger)).toBe(8);
  });

  it('merges idempotently and refuses to rewrite a numbered trial', () => {
    const ledger = ledgerFromGrid(GRID_A);
    expect(mergeLedger(ledger, GRID_A)).toEqual(ledger);
    const altered = GRID_A.map((trial) =>
      trial.trial === 3 ? { ...trial, lookbackDays: 63 } : trial,
    );
    expect(() => mergeLedger(ledger, altered)).toThrow(/trial #3 already recorded/);
  });

  it('refuses a grid that does not start at #1 or skips a number', () => {
    expect(() => ledgerFromGrid(GRID_A.slice(1))).toThrow(/expected trial #1/);
    expect(() => ledgerFromGrid([GRID_A[0], GRID_A[2]] as typeof GRID_A)).toThrow(
      /expected trial #2/,
    );
  });
});

describe('market', () => {
  const calendar = [
    '2024-01-30',
    '2024-01-31',
    '2024-02-01',
    '2024-02-02',
    '2024-02-29',
    '2024-03-01',
  ];
  const bar = (date: string, close: number) => ({
    date,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
    rawClose: close,
  });
  const reference = { symbol: 'REF', bars: calendar.map((date) => bar(date, 1)) };

  it('finds month-end decision days, never the final session', () => {
    expect(monthEndIndices(calendar)).toEqual([1, 4]);
    expect(yearOf('2024-02-29')).toBe(2024);
    expect(monthOf('2024-02-29')).toBe('2024-02');
  });

  it('aligns a sparse series to the reference calendar and carries the last close forward', () => {
    const sparse = { symbol: 'S', bars: [bar('2024-01-31', 10), bar('2024-02-02', 12)] };
    const market = new AlignedMarket(reference, new Map([['S', sparse]]));
    expect(market.symbols()).toEqual(['S']);
    expect(market.barAt('S', 1)?.close).toBe(10);
    expect(market.barAt('S', 2)).toBeUndefined();
    expect(market.closeAtOrBefore('S', 2)).toBe(10);
    expect(market.closeAtOrBefore('S', 0)).toBeUndefined();
    expect(market.barIndexAt('S', 3)).toBe(1);
    expect(market.seriesEndedBefore('S', 3)).toBe(false);
    expect(market.seriesEndedBefore('S', 4)).toBe(true);
    expect(MAX_CARRY_FORWARD_DAYS).toBe(5);
  });

  it('ignores bars on dates outside the reference calendar and rejects unknown symbols', () => {
    const off = { symbol: 'O', bars: [bar('2024-01-15', 5), bar('2024-01-31', 6)] };
    const market = new AlignedMarket(reference, new Map([['O', off]]));
    expect(market.barAt('O', 1)?.close).toBe(6);
    expect(market.bars('O').length).toBe(2);
    expect(() => market.barAt('X', 0)).toThrow(/unknown symbol/);
    expect(market.has('X')).toBe(false);
    expect(market.coverageOk('X', 1, 1)).toBe(false);
    expect(market.coverageOk('O', 1, 1)).toBe(false);
  });

  it('rejects an empty reference', () => {
    expect(() => new AlignedMarket({ symbol: 'R', bars: [] }, new Map())).toThrow(
      /empty reference/,
    );
  });
});

describe('fx', () => {
  const csv =
    'DATE,XUDLUSS\n30 Dec 2015,1.48\n31 Dec 2015,1.4739\n04 Jan 2016,1.4689\n03 Jan 2017,1.224\n';

  it('parses BoE rows into ISO dates', () => {
    const rates = parseBoeXudlussCsv(csv);
    expect(rates[0]).toEqual({ date: '2015-12-30', usdPerGbp: 1.48 });
    expect(rates[3]).toEqual({ date: '2017-01-03', usdPerGbp: 1.224 });
  });

  it('fixes each year at the last published rate on or before 1 January', () => {
    const fx = new YearFixedFx(parseBoeXudlussCsv(csv));
    expect(fx.usdPerGbpFor(2016)).toBe(1.4739);
    expect(fx.usdPerGbpFor(2017)).toBe(1.4689);
    expect(fx.usdPerGbpFor(2017)).toBe(1.4689);
    expect(() => fx.usdPerGbpFor(2015)).toThrow(/no rate on or before/);
    expect(GBP_IDENTITY_FX.usdPerGbpFor(2016)).toBe(1);
  });

  it('rejects a bad header, a malformed row, a bad month, a non-positive rate and unordered dates', () => {
    expect(() => parseBoeXudlussCsv('x\n')).toThrow(/unexpected header/);
    expect(() => parseBoeXudlussCsv('DATE,XUDLUSS\nnope\n')).toThrow(/malformed row/);
    expect(() => parseBoeXudlussCsv('DATE,XUDLUSS\n01 Foo 2016,1.2\n')).toThrow(/unknown month/);
    expect(() => parseBoeXudlussCsv('DATE,XUDLUSS\n01 Jan 2016,0\n')).toThrow(/non-positive/);
    expect(() => parseBoeXudlussCsv('DATE,XUDLUSS\n02 Jan 2016,1\n01 Jan 2016,1\n')).toThrow(
      /not ascending/,
    );
  });
});

describe('constituents', () => {
  const csv = 'date,tickers\n2016-01-04,"AAPL,MSFT,BRK.B"\n2016-02-01,"AAPL,MSFT"\n';

  it('parses rows and answers point-in-time membership', () => {
    const membership = new PointInTimeMembership(parseConstituentsCsv(csv));
    expect(membership.membersOn('2016-01-04')).toEqual(['AAPL', 'BRK.B', 'MSFT']);
    expect(membership.membersOn('2016-01-20')).toEqual(['AAPL', 'BRK.B', 'MSFT']);
    expect(membership.membersOn('2016-03-01')).toEqual(['AAPL', 'MSFT']);
    expect(membership.allTickers()).toEqual(['AAPL', 'BRK.B', 'MSFT']);
    expect(membership.firstDate()).toBe('2016-01-04');
    expect(membership.lastDate()).toBe('2016-02-01');
    expect(() => membership.membersOn('2015-12-31')).toThrow(/no membership row/);
  });

  it('rejects a bad header, a malformed row, unordered rows and an empty file', () => {
    expect(() => parseConstituentsCsv('x\n')).toThrow(/unexpected header/);
    expect(() => parseConstituentsCsv('date,tickers\nnope\n')).toThrow(/malformed row/);
    expect(() => parseConstituentsCsv('date,tickers\n2016-02-01,A\n2016-01-01,A\n')).toThrow(
      /not ascending/,
    );
    expect(() => new PointInTimeMembership([])).toThrow(/no membership rows/);
  });
});

describe('bar csv', () => {
  const bars = [
    { date: '2024-01-02', open: 1.5, high: 2, low: 1, close: 1.75, volume: 100, rawClose: 7 },
    { date: '2024-01-03', open: 1.75, high: 2, low: 1.5, close: 1.9, volume: 200, rawClose: 7.6 },
  ];

  it('round-trips through the Alpaca layout with raw_close', () => {
    const text = barsToCsv(bars);
    expect(text.split('\n')[0]).toBe(BAR_CSV_HEADER);
    expect(parseBarCsv('X', text).bars).toEqual(bars);
  });

  it('accepts the Saxo layout without raw_close, defaulting raw to close', () => {
    const series = parseBarCsv('S', 'date,open,high,low,close,volume\n2024-01-02,1,2,0.5,1.5,10\n');
    expect(series.bars[0]?.rawClose).toBe(1.5);
  });

  it('rejects a bad header, wrong cell count, non-numeric cells and unordered dates', () => {
    expect(() => parseBarCsv('X', 'a,b\n')).toThrow(/unexpected bar CSV header/);
    expect(() => parseBarCsv('X', `${BAR_CSV_HEADER}\n2024-01-02,1,2\n`)).toThrow(
      /cells, expected 7/,
    );
    expect(() => parseBarCsv('X', `${BAR_CSV_HEADER}\n2024-01-02,1,2,0.5,x,10,1\n`)).toThrow(
      /non-numeric/,
    );
    expect(() =>
      parseBarCsv('X', `${BAR_CSV_HEADER}\n2024-01-03,1,2,0.5,1,10,1\n2024-01-02,1,2,0.5,1,10,1\n`),
    ).toThrow(/not strictly ascending/);
  });

  it('loads every csv in a directory keyed by file name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bars-'));
    writeFileSync(join(dir, 'AAA.csv'), barsToCsv(bars));
    writeFileSync(join(dir, 'manifest.json'), '{}');
    const loaded = loadBarDirectory(dir);
    expect([...loaded.keys()]).toEqual(['AAA']);
    expect(loaded.get('AAA')?.bars.length).toBe(2);
  });
});

describe('alpaca bars api', () => {
  const rawBar = (t: string, c: number): RawDailyBar => ({ t, o: c, h: c, l: c, c, v: 1 });

  it('reads credentials from the environment and builds auth headers', () => {
    expect(() => credentialsFromEnv({})).toThrow(/ALPACA_API_KEY/);
    const credentials = credentialsFromEnv({ ALPACA_API_KEY: 'k', ALPACA_API_SECRET: 's' });
    expect(authHeaders(credentials)).toEqual({
      'APCA-API-KEY-ID': 'k',
      'APCA-API-SECRET-KEY': 's',
      accept: 'application/json',
    });
  });

  it('builds a SIP daily-bars URL with an end-of-day UTC end so a date-only end is never in the future', () => {
    expect(endOfDayUtc('2026-09-23')).toBe('2026-09-23T23:59:59Z');
    const url = new URL(
      barsUrl({ symbol: 'SPY', start: '2016-01-04', end: '2026-09-23', adjustment: 'all' }, 'tok'),
    );
    expect(url.pathname).toBe('/v2/stocks/bars');
    expect(url.searchParams.get('feed')).toBe('sip');
    expect(url.searchParams.get('timeframe')).toBe('1Day');
    expect(url.searchParams.get('end')).toBe('2026-09-23T23:59:59Z');
    expect(url.searchParams.get('page_token')).toBe('tok');
    expect(url.searchParams.get('adjustment')).toBe('all');
  });

  it('parses a page and tolerates a symbol with no bars', () => {
    const page = parseBarsPage(
      { bars: { SPY: [rawBar('2016-01-04T05:00:00Z', 1)] }, next_page_token: 'n' },
      'SPY',
    );
    expect(page.bars.length).toBe(1);
    expect(page.nextPageToken).toBe('n');
    expect(parseBarsPage({ bars: {} }, 'SPY')).toEqual({ bars: [], nextPageToken: undefined });
    expect(() => parseBarsPage('x', 'SPY')).toThrow(/non-object/);
    expect(() => parseBarsPage({ bars: { SPY: 'x' } }, 'SPY')).toThrow(/not an array/);
    expect(() => parseBarsPage({ bars: { SPY: [{ t: 1 }] } }, 'SPY')).toThrow(/malformed bar/);
  });

  it('paginates, paces requests and backs off on 429', async () => {
    const calls: string[] = [];
    const sleeps: number[] = [];
    let attempt = 0;
    const fetcher = async (url: string): Promise<FetchResult> => {
      calls.push(url);
      attempt++;
      if (attempt === 1) return { status: 429, body: 'slow down' };
      if (url.includes('page_token=p2')) {
        return { status: 200, body: { bars: { SPY: [rawBar('2016-01-05T05:00:00Z', 2)] } } };
      }
      return {
        status: 200,
        body: { bars: { SPY: [rawBar('2016-01-04T05:00:00Z', 1)] }, next_page_token: 'p2' },
      };
    };
    const api = new AlpacaBarsApi(
      { apiKey: 'k', apiSecret: 's' },
      fetcher,
      async (ms) => {
        sleeps.push(ms);
      },
      0,
    );
    const bars = await api.dailyBars({
      symbol: 'SPY',
      start: '2016-01-04',
      end: '2016-01-05',
      adjustment: 'all',
    });
    expect(bars.map((bar) => bar.c)).toEqual([1, 2]);
    expect(calls.length).toBe(3);
    expect(sleeps).toContain(20_000);
  });

  it('throws on a non-retryable status and after repeated 429s', async () => {
    const forbidden = new AlpacaBarsApi(
      { apiKey: 'k', apiSecret: 's' },
      async () => ({ status: 403, body: { message: 'no' } }),
      async () => {},
      0,
    );
    await expect(forbidden.getWithRetry('u')).rejects.toThrow(/Alpaca 403/);
    const throttled = new AlpacaBarsApi(
      { apiKey: 'k', apiSecret: 's' },
      async () => ({ status: 429, body: '' }),
      async () => {},
      0,
    );
    await expect(throttled.getWithRetry('u')).rejects.toThrow(/rate-limited 5 times/);
  });
});

describe('pull-alpaca-bars helpers', () => {
  const rawBar = (t: string, c: number): RawDailyBar => ({ t, o: c, h: c, l: c, c, v: 1 });

  it('joins adjusted OHLCV with the raw close by date', () => {
    const joined = joinAdjustedAndRaw(
      'X',
      [rawBar('2016-01-04T05:00:00Z', 10)],
      [rawBar('2016-01-04T05:00:00Z', 40)],
    );
    expect(joined).toEqual([
      { date: '2016-01-04', open: 10, high: 10, low: 10, close: 10, volume: 1, rawClose: 40 },
    ]);
    expect(() => joinAdjustedAndRaw('X', [rawBar('2016-01-04T05:00:00Z', 10)], [])).toThrow(
      /no raw counterpart/,
    );
    expect(barDate('2016-01-04T05:00:00Z')).toBe('2016-01-04');
  });

  it('tries the dotted ticker then the dot-stripped Alpaca symbol', async () => {
    expect(alpacaSymbolCandidates('BRK.B')).toEqual(['BRK.B', 'BRKB']);
    expect(alpacaSymbolCandidates('AAPL')).toEqual(['AAPL']);
    const requested: string[] = [];
    const api = new AlpacaBarsApi(
      { apiKey: 'k', apiSecret: 's' },
      async (url) => {
        const symbol = new URL(url).searchParams.get('symbols') as string;
        requested.push(symbol);
        return {
          status: 200,
          body: { bars: symbol === 'BRKB' ? { BRKB: [rawBar('2016-01-04T05:00:00Z', 1)] } : {} },
        };
      },
      async () => {},
      0,
    );
    const pulled = await pullSymbol(api, 'BRK.B', '2016-01-04', '2016-01-05');
    expect(pulled?.alpacaSymbol).toBe('BRKB');
    expect(requested).toEqual(['BRK.B', 'BRKB', 'BRKB']);
    expect(await pullSymbol(api, 'NONE', '2016-01-04', '2016-01-05')).toBeUndefined();
  });

  it('parses CLI flags with defaults', () => {
    const args = parsePullArgs(['--end', '2026-09-23', '--out', 'x']);
    expect(args.end).toBe('2026-09-23');
    expect(args.outDir).toBe('x');
    expect(args.constituents).toBe('data/bars/sp500-constituents.csv');
  });
});

describe('spread measurement', () => {
  it('samples the first SIP quote in the 15:59 ET window and turns it into half-spread bps', () => {
    const url = new URL(quotesUrl('AAPL', '2026-09-23'));
    expect(url.pathname).toBe('/v2/stocks/AAPL/quotes');
    expect(url.searchParams.get('start')).toBe('2026-09-23T19:59:00Z');
    expect(url.searchParams.get('end')).toBe('2026-09-23T19:59:30Z');
    expect(newYorkUtcOffsetMinutes('2026-07-01')).toBe(-240);
    expect(newYorkUtcOffsetMinutes('2026-01-15')).toBe(-300);
    expect(sampleWindowUtc('2026-01-15')).toEqual({
      start: '2026-01-15T20:59:00Z',
      end: '2026-01-15T20:59:30Z',
    });
    expect(sampleWindowUtc('2026-03-09')).toEqual({
      start: '2026-03-09T19:59:00Z',
      end: '2026-03-09T19:59:30Z',
    });
    expect(sampleWindowUtc('2026-03-06').start).toBe('2026-03-06T20:59:00Z');
    expect(url.searchParams.get('limit')).toBe('1');
    expect(parseQuotePage({ quotes: [{ bp: 99, ap: 101 }] })).toEqual({ bid: 99, ask: 101 });
    expect(parseQuotePage({ quotes: [] })).toBeUndefined();
    expect(parseQuotePage({ quotes: [{ bp: 101, ap: 99 }] })).toBeUndefined();
    expect(parseQuotePage('x')).toBeUndefined();
    expect(halfSpreadBps({ bid: 99, ask: 101 })).toBeCloseTo(100);
  });

  it('takes the per-name median and falls back to the cross-sectional median', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(() => median([])).toThrow(/empty/);
    const rows = parseSpreadCsv(
      spreadRowsToCsv([
        { symbol: 'A', sessions: 2, medianHalfSpreadBps: 1 },
        { symbol: 'B', sessions: 2, medianHalfSpreadBps: 3 },
        { symbol: 'C', sessions: 2, medianHalfSpreadBps: 9 },
      ]),
    );
    const lookup = halfSpreadLookup(rows);
    expect(lookup.halfSpreadBps('A')).toBe(1);
    expect(lookup.halfSpreadBps('ZZZ')).toBe(3);
    expect(lookup.fallbackBps).toBe(3);
    expect(lookup.measured).toBe(3);
    expect(() => halfSpreadLookup(new Map())).toThrow(/no measured spreads/);
    expect(() => parseSpreadCsv('x\n')).toThrow(/unexpected header/);
    expect(() => parseSpreadCsv(`${SPREAD_CSV_HEADER}\n,1,2\n`)).toThrow(/malformed row/);
    expect(lastSessions(['a', 'b', 'c'], 2)).toEqual(['b', 'c']);
  });

  it('measures a symbol across sessions and falls back through symbol candidates', async () => {
    const api = new AlpacaBarsApi(
      { apiKey: 'k', apiSecret: 's' },
      async (url) => ({
        status: 200,
        body: url.includes('/BRKB/') ? { quotes: [{ bp: 100, ap: 100.02 }] } : { quotes: [] },
      }),
      async () => {},
      0,
    );
    const row = await measureSymbol(api, 'BRK.B', ['2026-09-22', '2026-09-23']);
    expect(row?.sessions).toBe(2);
    expect(row?.medianHalfSpreadBps).toBeCloseTo(1, 3);
    expect(await measureSymbol(api, 'NONE', ['2026-09-23'])).toBeUndefined();
  });
});
