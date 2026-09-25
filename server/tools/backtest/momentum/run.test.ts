import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BarSeries } from '../../../pipeline/momentum/index.js';
import { ParquetBarStore } from '../../../providers/bar-store/index.js';
import { roundBarPrices } from './bar-csv.js';
import { syntheticSeries, tradingCalendar } from './fixture.js';
import { GRID_A } from './grid.js';
import { AlignedMarket } from './market.js';
import { SPREAD_CSV_HEADER } from './measure-alpaca-spread.js';
import { renderVerdictMarkdown } from './report.js';
import {
  CAPITAL_PASSES_GBP,
  evaluationStartIndex,
  loadLseData,
  memberSessionCoverage,
  parseArgs,
  runVenue,
} from './run.js';
import type { SubBookVerdict } from './verdict.js';

const SESSIONS = 1_200;
const calendar = tradingCalendar('2016-01-04', SESSIONS);

async function writeBars(
  barsRoot: string,
  venue: string,
  series: readonly BarSeries[],
): Promise<void> {
  const store = await ParquetBarStore.open(barsRoot);
  try {
    await store.write(
      venue,
      series.map((one) => ({ symbol: one.symbol, bars: roundBarPrices(one.bars) })),
    );
  } finally {
    store.close();
  }
}

async function writeUsFixture(root: string): Promise<{
  barsRoot: string;
  constituents: string;
  fx: string;
  spreads: string;
}> {
  const barsRoot = join(root, 'parquet');
  const symbols = Array.from({ length: 12 }, (_, index) => `S${String(index).padStart(2, '0')}`);
  await writeBars(barsRoot, 'alpaca', [
    syntheticSeries({ symbol: 'SPY', calendar, seed: 1, volatility: 0.008 }),
    ...symbols.map((symbol, index) =>
      syntheticSeries({
        symbol,
        calendar,
        seed: 10 + index,
        drift: 0.0002 + index * 0.0001,
        volatility: 0.02,
        startPrice: 20 + index * 15,
        to: index === 11 ? 900 : SESSIONS,
      }),
    ),
  ]);
  const constituents = join(root, 'constituents.csv');
  writeFileSync(
    constituents,
    `date,tickers\n2016-01-04,"${symbols.join(',')},GONE"\n2019-08-01,"${symbols.slice(0, 11).join(',')}"\n`,
  );
  const fx = join(root, 'fx.csv');
  writeFileSync(
    fx,
    'DATE,XUDLUSS\n31 Dec 2015,1.4739\n29 Dec 2016,1.224\n29 Dec 2017,1.3579\n31 Dec 2018,1.2608\n31 Dec 2019,1.3189\n31 Dec 2020,1.3579\n',
  );
  const spreads = join(root, 'spreads.csv');
  writeFileSync(spreads, `${SPREAD_CSV_HEADER}\nS00,10,1.5\nS01,10,2.5\n`);
  return { barsRoot, constituents, fx, spreads };
}

interface LseFixture {
  readonly barsRoot: string;
  readonly lseManifestPath: string;
}

async function writeLseFixture(root: string): Promise<LseFixture> {
  const barsRoot = join(root, 'parquet');
  const lines = ['CSPX', 'VUSA', 'ISF', 'SGLN'];
  await writeBars(barsRoot, 'saxo', [
    syntheticSeries({ symbol: 'CSPX', calendar, seed: 3, volatility: 0.008 }),
    ...lines.slice(1).map((line, index) =>
      syntheticSeries({
        symbol: line,
        calendar,
        seed: 40 + index,
        drift: 0.0003,
        volatility: 0.012,
      }),
    ),
  ]);
  mkdirSync(join(root, 'saxo'), { recursive: true });
  const lseManifestPath = join(root, 'saxo', 'manifest.json');
  writeFileSync(
    lseManifestPath,
    JSON.stringify({
      calendar_reference: 'CSPX',
      symbols: Object.fromEntries(lines.map((line) => [line, { half_spread_bps: 5 }])),
    }),
  );
  return { barsRoot, lseManifestPath };
}

function readVerdict(outDir: string, venue: string, name: string): SubBookVerdict {
  return JSON.parse(readFileSync(join(outDir, venue, name), 'utf8')) as SubBookVerdict;
}

describe('momentum runner end to end on a synthetic fixture', () => {
  it('runs the US sub-book at both capitals in both share modes and writes verdicts, ledger and report', async () => {
    const root = mkdtempSync(join(tmpdir(), 'momentum-us-'));
    const fixture = await writeUsFixture(root);
    const outDir = join(root, 'out');
    const passes = await runVenue({
      venue: 'us',
      barsRoot: fixture.barsRoot,
      lseManifestPath: '',
      outDir,
      capitals: CAPITAL_PASSES_GBP,
      constituentsPath: fixture.constituents,
      fxPath: fixture.fx,
      spreadPath: fixture.spreads,
    });
    expect(passes.map((pass) => [pass.startCapitalGbp, pass.wholeShares])).toEqual([
      [1_000, true],
      [1_000, false],
      [5_000, true],
      [5_000, false],
    ]);
    const verdict = readVerdict(outDir, 'us', 'verdict-1000-whole.json');
    expect(verdict.trials.map((trial) => trial.trial)).toEqual([5, 6, 7, 8]);
    expect(verdict.trialsCounted).toBe(8);
    expect(verdict.missingCoverageFraction).toBeGreaterThan(0.02);
    expect(verdict.coverageStopFailed).toBe(true);
    expect(verdict.pass).toBe(false);
    expect(verdict.delistingHaircutApplied).toBe(0.05);
    expect(typeof verdict.pbo).toBe('number');
    expect(verdict.deflatedSharpe).toBeGreaterThanOrEqual(0);
    expect(verdict.deflatedSharpe).toBeLessThanOrEqual(1);
    const ledger = JSON.parse(readFileSync(join(outDir, 'trials.json'), 'utf8')) as {
      entries: { trial: number }[];
    };
    expect(ledger.entries.map((entry) => entry.trial)).toEqual(GRID_A.map((trial) => trial.trial));
    const report = readFileSync(join(outDir, 'us', 'verdict.md'), 'utf8');
    expect(report).toContain(
      'Kill line: fails unless it beats the benchmark after a 40% Sharpe haircut',
    );
    expect(report).toContain('Missing: GONE, S11');
    expect(report).toContain('## £5000 start capital, fractional');
  });

  it('is reproducible: two runs over the same fixture produce byte-identical verdicts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'momentum-repro-'));
    const fixture = await writeUsFixture(root);
    const options = {
      venue: 'us' as const,
      barsRoot: fixture.barsRoot,
      lseManifestPath: '',
      capitals: [1_000],
      constituentsPath: fixture.constituents,
      fxPath: fixture.fx,
      spreadPath: fixture.spreads,
    };
    await runVenue({ ...options, outDir: join(root, 'a') });
    await runVenue({ ...options, outDir: join(root, 'b') });
    for (const name of ['verdict-1000-whole.json', 'verdict-1000-fractional.json']) {
      expect(readFileSync(join(root, 'a', 'us', name), 'utf8')).toBe(
        readFileSync(join(root, 'b', 'us', name), 'utf8'),
      );
    }
  });

  it('runs the LSE sub-book from the Saxo bars in the store with per-line half spreads', async () => {
    const root = mkdtempSync(join(tmpdir(), 'momentum-lse-'));
    const fixture = await writeLseFixture(root);
    const outDir = join(root, 'out');
    const passes = await runVenue({
      venue: 'lse',
      ...fixture,
      outDir,
      capitals: [1_000],
      constituentsPath: '',
      fxPath: '',
      spreadPath: '',
    });
    expect(passes.length).toBe(2);
    const verdict = readVerdict(outDir, 'lse', 'verdict-1000-whole.json');
    expect(verdict.trials.map((trial) => trial.trial)).toEqual([1, 2, 3, 4]);
    expect(verdict.delistingHaircutApplied).toBe(0);
    expect(verdict.checks.coverageWithinStop).toBe(true);
    expect(verdict.trials.every((trial) => trial.custodyCost > 0)).toBe(true);
  });

  it('clips the LSE calendar to the manifest window, reports splices and exclusions, and refuses a line starting after the window', async () => {
    const root = mkdtempSync(join(tmpdir(), 'momentum-lse-window-'));
    const fixture = await writeLseFixture(root);
    const late = roundBarPrices(
      syntheticSeries({ symbol: 'LATE', calendar, seed: 77, from: 300 }).bars,
    );
    await writeBars(fixture.barsRoot, 'saxo', [{ symbol: 'LATE', bars: late }]);
    const manifest = {
      calendar_reference: 'CSPX',
      window_start: late[0]?.date,
      window_binding_line: 'LATE',
      spread: { source: 'infoprices burst', statistic: 'p25' },
      symbols: {
        CSPX: { half_spread_bps: 1 },
        VUSA: { half_spread_bps: 2, spliced_from: { tidm: 'VUSD', splice_date: '2016-03-01' } },
        LATE: { half_spread_bps: 3 },
      },
      excluded: { GONE: { reason: 'splice exceeds tolerance' } },
    };
    writeFileSync(fixture.lseManifestPath, JSON.stringify(manifest));
    const data = await loadLseData(fixture);
    expect(data.market.calendar[0]).toBe(late[0]?.date);
    expect(data.market.calendar.length).toBe(SESSIONS - 300);
    expect(data.lse).toEqual({
      windowStart: late[0]?.date,
      bindingLine: 'LATE',
      splices: [{ tidm: 'VUSA', from: 'VUSD', spliceDate: '2016-03-01' }],
      excluded: [{ tidm: 'GONE', reason: 'splice exceeds tolerance' }],
      spreadSource: 'p25; infoprices burst',
    });
    expect(data.costs.halfSpreadBps('LATE')).toBe(3);
    expect(() => data.costs.halfSpreadBps('ISF')).toThrow(/no half_spread_bps for ISF/);
    const report = renderVerdictMarkdown(data, []);
    expect(report).toContain(`LSE window from ${late[0]?.date} (binding line LATE)`);
    expect(report).toContain('VUSA from VUSD before 2016-03-01');
    expect(report).toContain('Excluded from the run: GONE — splice exceeds tolerance');
    expect(report).toContain(
      'LSE coverage: 0.0% of line-sessions without a Saxo bar inside the window.',
    );
    writeFileSync(
      fixture.lseManifestPath,
      JSON.stringify({ ...manifest, window_start: calendar[100] }),
    );
    await expect(loadLseData(fixture)).rejects.toThrow(
      /LATE first bar .* is after the window start/,
    );
    writeFileSync(
      fixture.lseManifestPath,
      JSON.stringify({ ...manifest, window_start: '2099-01-01' }),
    );
    await expect(loadLseData(fixture)).rejects.toThrow(/after the last reference bar/);
  });

  it('refuses LSE bars that still carry a unit break', async () => {
    const root = mkdtempSync(join(tmpdir(), 'momentum-lse-unit-'));
    const fixture = await writeLseFixture(root);
    const broken = syntheticSeries({ symbol: 'ISF', calendar, seed: 41 }).bars.map((b, i) =>
      i < 400
        ? {
            ...b,
            open: b.open / 100,
            high: b.high / 100,
            low: b.low / 100,
            close: b.close / 100,
            rawClose: b.rawClose / 100,
          }
        : b,
    );
    await writeBars(fixture.barsRoot, 'saxo', [{ symbol: 'ISF', bars: broken }]);
    await expect(loadLseData(fixture)).rejects.toThrow(/ISF has a unit break at .* ×100/);
  });

  it('refuses to run the LSE sub-book until the Saxo bars and manifest land', async () => {
    const root = mkdtempSync(join(tmpdir(), 'momentum-nolse-'));
    await expect(
      loadLseData({
        barsRoot: join(root, 'parquet'),
        lseManifestPath: join(root, 'saxo', 'manifest.json'),
      }),
    ).rejects.toThrow(/LSE bars not present/);
    const fixture = await writeLseFixture(root);
    writeFileSync(
      fixture.lseManifestPath,
      JSON.stringify({
        calendar_reference: 'CSPX',
        symbols: { CSPX: {}, VUSA: { half_spread_bps: 1 } },
      }),
    );
    await expect(loadLseData(fixture)).rejects.toThrow(/CSPX needs a measured half_spread_bps/);
    writeFileSync(
      fixture.lseManifestPath,
      JSON.stringify({ calendar_reference: 'CSPX', symbols: { NOPE: { half_spread_bps: 1 } } }),
    );
    await expect(loadLseData(fixture)).rejects.toThrow(/NOPE but the bar store has no saxo NOPE/);
    writeFileSync(
      fixture.lseManifestPath,
      JSON.stringify({ calendar_reference: 'GONE', symbols: {} }),
    );
    await expect(loadLseData(fixture)).rejects.toThrow(/bar store has no GONE calendar reference/);
  });

  it('measures coverage over member-sessions, not over names with a file', () => {
    const short = tradingCalendar('2016-01-04', 10);
    const reference = syntheticSeries({ symbol: 'REF', calendar: short, seed: 1 });
    const full = syntheticSeries({ symbol: 'FULL', calendar: short, seed: 2 });
    const late = syntheticSeries({ symbol: 'LATE', calendar: short, seed: 3, from: 6 });
    const market = new AlignedMarket(
      reference,
      new Map([
        ['FULL', full],
        ['LATE', late],
      ]),
    );
    const coverage = memberSessionCoverage(market, (date) =>
      date < (short[5] as string) ? ['FULL', 'LATE'] : ['FULL', 'NONE'],
    );
    expect(coverage.missingNames).toEqual(['LATE', 'NONE']);
    expect(coverage.missingFraction).toBeCloseTo((5 + 5) / 20);
  });

  it('starts evaluation at the first month end after the longest lookback', () => {
    const start = evaluationStartIndex(calendar, GRID_A);
    expect(start).toBeGreaterThanOrEqual(252);
    expect(calendar[start]?.slice(0, 7)).not.toBe(calendar[start + 1]?.slice(0, 7));
    expect(() => evaluationStartIndex(calendar.slice(0, 100), GRID_A)).toThrow(/too short/);
  });

  it('parses CLI arguments with the Parquet store and Saxo manifest as defaults', () => {
    const lse = parseArgs(['--venue', 'lse']);
    expect(lse.barsRoot).toBe('data/bars/parquet');
    expect(lse.lseManifestPath).toBe('data/bars/saxo/manifest.json');
    const us = parseArgs([
      '--venue',
      'us',
      '--capital',
      '1000,5000,0',
      '--out',
      'x',
      '--bars',
      'b',
    ]);
    expect(us.capitals).toEqual([1_000, 5_000]);
    expect(us.outDir).toBe('x');
    expect(us.barsRoot).toBe('b');
    expect(parseArgs(['--venue', 'lse', '--manifest', 'm']).lseManifestPath).toBe('m');
    expect(() => parseArgs([])).toThrow(/usage/);
  });
});
