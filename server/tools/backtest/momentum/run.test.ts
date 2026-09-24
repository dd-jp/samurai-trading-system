import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { barsToCsv } from './bar-csv.js';
import { syntheticSeries, tradingCalendar } from './fixture.js';
import { GRID_A } from './grid.js';
import { SPREAD_CSV_HEADER } from './measure-alpaca-spread.js';
import {
  CAPITAL_PASSES_GBP,
  evaluationStartIndex,
  loadLseData,
  parseArgs,
  runVenue,
} from './run.js';
import type { SubBookVerdict } from './verdict.js';

const SESSIONS = 1_200;
const calendar = tradingCalendar('2016-01-04', SESSIONS);

function writeUsFixture(root: string): {
  barsDir: string;
  constituents: string;
  fx: string;
  spreads: string;
} {
  const barsDir = join(root, 'alpaca');
  mkdirSync(barsDir, { recursive: true });
  const symbols = Array.from({ length: 12 }, (_, index) => `S${String(index).padStart(2, '0')}`);
  writeFileSync(
    join(barsDir, 'SPY.csv'),
    barsToCsv(syntheticSeries({ symbol: 'SPY', calendar, seed: 1, volatility: 0.008 }).bars),
  );
  symbols.forEach((symbol, index) => {
    const to = index === 11 ? 900 : SESSIONS;
    writeFileSync(
      join(barsDir, `${symbol}.csv`),
      barsToCsv(
        syntheticSeries({
          symbol,
          calendar,
          seed: 10 + index,
          drift: 0.0002 + index * 0.0001,
          volatility: 0.02,
          startPrice: 20 + index * 15,
          to,
        }).bars,
      ),
    );
  });
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
  return { barsDir, constituents, fx, spreads };
}

function writeLseFixture(root: string): string {
  const barsDir = join(root, 'saxo');
  mkdirSync(barsDir, { recursive: true });
  const lines = ['CSPX', 'VUSA', 'ISF', 'SGLN'];
  writeFileSync(
    join(barsDir, 'CSPX.csv'),
    barsToCsv(syntheticSeries({ symbol: 'CSPX', calendar, seed: 3, volatility: 0.008 }).bars),
  );
  lines.slice(1).forEach((line, index) => {
    writeFileSync(
      join(barsDir, `${line}.csv`),
      barsToCsv(
        syntheticSeries({
          symbol: line,
          calendar,
          seed: 40 + index,
          drift: 0.0003,
          volatility: 0.012,
        }).bars,
      ),
    );
  });
  writeFileSync(
    join(barsDir, 'manifest.json'),
    JSON.stringify({
      calendar_reference: 'CSPX',
      symbols: Object.fromEntries(lines.map((line) => [line, { half_spread_bps: 5 }])),
    }),
  );
  return barsDir;
}

function readVerdict(outDir: string, venue: string, name: string): SubBookVerdict {
  return JSON.parse(readFileSync(join(outDir, venue, name), 'utf8')) as SubBookVerdict;
}

describe('momentum runner end to end on a synthetic fixture', () => {
  it('runs the US sub-book at both capitals in both share modes and writes verdicts, ledger and report', () => {
    const root = mkdtempSync(join(tmpdir(), 'momentum-us-'));
    const fixture = writeUsFixture(root);
    const outDir = join(root, 'out');
    const passes = runVenue({
      venue: 'us',
      barsDir: fixture.barsDir,
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
    expect(verdict.missingCoverageFraction).toBeCloseTo(1 / 13);
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
    expect(report).toContain('Missing: GONE');
    expect(report).toContain('## £5000 start capital, fractional');
  });

  it('is reproducible: two runs over the same fixture produce byte-identical verdicts', () => {
    const root = mkdtempSync(join(tmpdir(), 'momentum-repro-'));
    const fixture = writeUsFixture(root);
    const options = {
      venue: 'us' as const,
      barsDir: fixture.barsDir,
      capitals: [1_000],
      constituentsPath: fixture.constituents,
      fxPath: fixture.fx,
      spreadPath: fixture.spreads,
    };
    runVenue({ ...options, outDir: join(root, 'a') });
    runVenue({ ...options, outDir: join(root, 'b') });
    for (const name of ['verdict-1000-whole.json', 'verdict-1000-fractional.json']) {
      expect(readFileSync(join(root, 'a', 'us', name), 'utf8')).toBe(
        readFileSync(join(root, 'b', 'us', name), 'utf8'),
      );
    }
  });

  it('runs the LSE sub-book from a Saxo bar directory with per-line half spreads', () => {
    const root = mkdtempSync(join(tmpdir(), 'momentum-lse-'));
    const barsDir = writeLseFixture(root);
    const outDir = join(root, 'out');
    const passes = runVenue({
      venue: 'lse',
      barsDir,
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

  it('refuses to run the LSE sub-book until the Saxo bars and manifest land', () => {
    const root = mkdtempSync(join(tmpdir(), 'momentum-nolse-'));
    expect(() => loadLseData(join(root, 'saxo'))).toThrow(/LSE bars not present/);
    const barsDir = writeLseFixture(root);
    writeFileSync(
      join(barsDir, 'manifest.json'),
      JSON.stringify({
        calendar_reference: 'CSPX',
        symbols: { CSPX: {}, VUSA: { half_spread_bps: 1 } },
      }),
    );
    expect(() => loadLseData(barsDir)).toThrow(/CSPX needs a measured half_spread_bps/);
    writeFileSync(
      join(barsDir, 'manifest.json'),
      JSON.stringify({ calendar_reference: 'CSPX', symbols: { NOPE: { half_spread_bps: 1 } } }),
    );
    expect(() => loadLseData(barsDir)).toThrow(/NOPE but .*NOPE\.csv is missing/);
  });

  it('starts evaluation at the first month end after the longest lookback', () => {
    const start = evaluationStartIndex(calendar, GRID_A);
    expect(start).toBeGreaterThanOrEqual(252);
    expect(calendar[start]?.slice(0, 7)).not.toBe(calendar[start + 1]?.slice(0, 7));
    expect(() => evaluationStartIndex(calendar.slice(0, 100), GRID_A)).toThrow(/too short/);
  });

  it('parses CLI arguments with venue-specific defaults', () => {
    expect(parseArgs(['--venue', 'lse']).barsDir).toBe('data/bars/saxo');
    const us = parseArgs(['--venue', 'us', '--capital', '1000,5000,0', '--out', 'x']);
    expect(us.capitals).toEqual([1_000, 5_000]);
    expect(us.outDir).toBe('x');
    expect(us.barsDir).toBe('data/bars/alpaca');
    expect(() => parseArgs([])).toThrow(/usage/);
  });
});
