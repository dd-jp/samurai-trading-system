import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BarSeries } from '../../../pipeline/momentum/index.js';
import { isMainModule } from '../../cli-entrypoint.js';
import { loadBarDirectory } from './bar-csv.js';
import { PointInTimeMembership, parseConstituentsCsv } from './constituents.js';
import type { BookFx } from './fx.js';
import { GBP_IDENTITY_FX, parseBoeXudlussCsv, YearFixedFx } from './fx.js';
import type { TrialConfig, Venue } from './grid.js';
import { GRID_A, GRID_A_TRIAL_COUNT, gridForVenue, maxWarmupDays, trialHash } from './grid.js';
import { AlignedMarket, monthEndIndices } from './market.js';
import { DEFAULT_SPREAD_PATH, halfSpreadLookup, parseSpreadCsv } from './measure-alpaca-spread.js';
import { DEFAULT_ALPACA_BARS_DIR, DEFAULT_CONSTITUENTS_PATH } from './pull-alpaca-bars.js';
import { renderVerdictMarkdown } from './report.js';
import type { SimulationResult, UniverseAt, VenueCosts } from './simulate.js';
import { simulate } from './simulate.js';
import { ledgerFromGrid, mergeLedger, type TrialLedger } from './trial-ledger.js';
import type { SubBookVerdict } from './verdict.js';
import { subBookVerdict } from './verdict.js';

const DEFAULT_SAXO_BARS_DIR = 'data/bars/saxo';
const DEFAULT_FX_PATH = 'data/bars/fx/gbpusd-boe-xudluss.csv';
const DEFAULT_OUT_DIR = 'data/backtest/momentum';
const LEDGER_FILE = 'trials.json';
export const CAPITAL_PASSES_GBP = [1_000, 5_000] as const;

interface SaxoBarsManifest {
  readonly calendar_reference: string;
  readonly symbols: Record<string, { readonly half_spread_bps: number }>;
}

export interface VenueData {
  readonly venue: Venue;
  readonly market: AlignedMarket;
  readonly universe: UniverseAt;
  readonly costs: VenueCosts;
  readonly fx: BookFx;
  readonly missingCoverageFraction: number;
  readonly missingNames: readonly string[];
  readonly spreadFallbackBps: number;
  readonly spreadMeasuredNames: number;
}

export interface RunOptions {
  readonly venue: Venue;
  readonly barsDir: string;
  readonly outDir: string;
  readonly capitals: readonly number[];
  readonly constituentsPath: string;
  readonly fxPath: string;
  readonly spreadPath: string;
}

export function parseArgs(argv: readonly string[]): RunOptions {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const venue = value('--venue');
  if (venue !== 'us' && venue !== 'lse')
    throw new Error('usage: run.ts --venue us|lse [--bars dir] [--out dir]');
  const capitals = value('--capital')
    ?.split(',')
    .map(Number)
    .filter((capital) => capital > 0);
  return {
    venue,
    barsDir: value('--bars') ?? (venue === 'us' ? DEFAULT_ALPACA_BARS_DIR : DEFAULT_SAXO_BARS_DIR),
    outDir: value('--out') ?? DEFAULT_OUT_DIR,
    capitals: capitals !== undefined && capitals.length > 0 ? capitals : CAPITAL_PASSES_GBP,
    constituentsPath: value('--constituents') ?? DEFAULT_CONSTITUENTS_PATH,
    fxPath: value('--fx') ?? DEFAULT_FX_PATH,
    spreadPath: value('--spreads') ?? DEFAULT_SPREAD_PATH,
  };
}

export function memberSessionCoverage(
  market: AlignedMarket,
  universe: UniverseAt,
): { missingFraction: number; missingNames: readonly string[] } {
  const missingSessions = new Map<string, number>();
  let memberSessions = 0;
  market.calendar.forEach((date, index) => {
    for (const symbol of universe(date)) {
      memberSessions++;
      if (market.has(symbol) && market.barAt(symbol, index) !== undefined) continue;
      missingSessions.set(symbol, (missingSessions.get(symbol) ?? 0) + 1);
    }
  });
  const missing = [...missingSessions.values()].reduce((sum, count) => sum + count, 0);
  return {
    missingFraction: memberSessions === 0 ? 0 : missing / memberSessions,
    missingNames: [...missingSessions.keys()].sort(),
  };
}

function loadUsData(
  options: Pick<RunOptions, 'barsDir' | 'constituentsPath' | 'fxPath' | 'spreadPath'>,
): VenueData {
  const series = loadBarDirectory(options.barsDir);
  const reference = requireSeries(series, 'SPY');
  const membership = new PointInTimeMembership(
    parseConstituentsCsv(readFileSync(options.constituentsPath, 'utf8')),
  );
  const market = new AlignedMarket(reference, series);
  const coverage = memberSessionCoverage(market, (date) => membership.membersOn(date));
  const spreads = halfSpreadLookup(parseSpreadCsv(readFileSync(options.spreadPath, 'utf8')));
  return {
    venue: 'us',
    market,
    universe: (date) => membership.membersOn(date),
    costs: { venue: 'us', halfSpreadBps: spreads.halfSpreadBps },
    fx: new YearFixedFx(parseBoeXudlussCsv(readFileSync(options.fxPath, 'utf8'))),
    missingCoverageFraction: coverage.missingFraction,
    missingNames: coverage.missingNames,
    spreadFallbackBps: spreads.fallbackBps,
    spreadMeasuredNames: spreads.measured,
  };
}

export function loadLseData(barsDir: string): VenueData {
  const manifestPath = join(barsDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(
      `LSE bars not present: expected ${manifestPath} with calendar_reference and per-symbol half_spread_bps ` +
        '(doc 70 §8 STOP branch — Saxo sibling Uics first, EODHD one-month fallback)',
    );
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as SaxoBarsManifest;
  const series = loadBarDirectory(barsDir);
  const reference = requireSeries(series, manifest.calendar_reference);
  const symbols = Object.keys(manifest.symbols).sort();
  const halfSpreads = new Map<string, number>();
  for (const symbol of symbols) {
    if (!series.has(symbol))
      throw new Error(`LSE manifest lists ${symbol} but ${barsDir}/${symbol}.csv is missing`);
    const halfSpread = manifest.symbols[symbol]?.half_spread_bps;
    if (halfSpread === undefined || !(halfSpread >= 0)) {
      throw new Error(`LSE manifest: ${symbol} needs a measured half_spread_bps`);
    }
    halfSpreads.set(symbol, halfSpread);
  }
  return {
    venue: 'lse',
    market: new AlignedMarket(reference, series),
    universe: () => symbols,
    costs: { venue: 'lse', halfSpreadBps: (symbol) => requireHalfSpread(halfSpreads, symbol) },
    fx: GBP_IDENTITY_FX,
    missingCoverageFraction: 0,
    missingNames: [],
    spreadFallbackBps: Number.NaN,
    spreadMeasuredNames: symbols.length,
  };
}

function requireHalfSpread(halfSpreads: ReadonlyMap<string, number>, symbol: string): number {
  const halfSpread = halfSpreads.get(symbol);
  if (halfSpread === undefined)
    throw new Error(`LSE manifest has no half_spread_bps for ${symbol}`);
  return halfSpread;
}

function requireSeries(series: ReadonlyMap<string, BarSeries>, symbol: string): BarSeries {
  const found = series.get(symbol);
  if (found === undefined)
    throw new Error(`bars directory has no ${symbol}.csv calendar reference`);
  return found;
}

export function evaluationStartIndex(
  calendar: readonly string[],
  trials: readonly TrialConfig[],
): number {
  const warmup = maxWarmupDays(trials);
  const start = monthEndIndices(calendar).find((index) => index >= warmup);
  if (start === undefined) throw new Error(`calendar too short for ${warmup}-day warmup`);
  return start;
}

export interface PassResult {
  readonly startCapitalGbp: number;
  readonly wholeShares: boolean;
  readonly verdict: SubBookVerdict;
  readonly benchmarkSameMode: SimulationResult;
}

function runPass(data: VenueData, startCapitalGbp: number, wholeShares: boolean): PassResult {
  const trials = gridForVenue(data.venue);
  const start = evaluationStartIndex(data.market.calendar, GRID_A);
  const book = { startCapitalGbp, wholeShares, fx: data.fx };
  const common = {
    market: data.market,
    universe: data.universe,
    costs: data.costs,
    evaluationStartIndex: start,
  };
  const results = trials.map((config) => ({
    config,
    hash: trialHash(config),
    result: simulate({ ...common, config, role: 'strategy', book }),
  }));
  const benchmarkConfig = trials[0] as TrialConfig;
  const benchmarkFractional = simulate({
    ...common,
    config: benchmarkConfig,
    role: 'benchmark',
    book: { ...book, wholeShares: false },
  });
  const benchmarkSameMode = wholeShares
    ? simulate({ ...common, config: benchmarkConfig, role: 'benchmark', book })
    : benchmarkFractional;
  const verdict = subBookVerdict({
    venue: data.venue,
    startCapitalGbp,
    wholeShares,
    trials: results,
    benchmark: benchmarkFractional,
    totalTrialsCounted: GRID_A_TRIAL_COUNT,
    missingCoverageFraction: data.missingCoverageFraction,
  });
  return { startCapitalGbp, wholeShares, verdict, benchmarkSameMode };
}

function writeLedger(outDir: string): TrialLedger {
  const path = join(outDir, LEDGER_FILE);
  const ledger = existsSync(path)
    ? mergeLedger(JSON.parse(readFileSync(path, 'utf8')) as TrialLedger, GRID_A)
    : ledgerFromGrid(GRID_A);
  writeFileSync(path, `${JSON.stringify(ledger, null, 2)}\n`);
  return ledger;
}

export function runVenue(options: RunOptions): PassResult[] {
  const data = options.venue === 'us' ? loadUsData(options) : loadLseData(options.barsDir);
  const venueDir = join(options.outDir, options.venue);
  mkdirSync(venueDir, { recursive: true });
  writeLedger(options.outDir);
  const passes: PassResult[] = [];
  for (const capital of options.capitals) {
    for (const wholeShares of [true, false]) {
      const pass = runPass(data, capital, wholeShares);
      passes.push(pass);
      const name = `verdict-${capital}-${wholeShares ? 'whole' : 'fractional'}`;
      writeFileSync(join(venueDir, `${name}.json`), `${JSON.stringify(pass.verdict, null, 2)}\n`);
    }
  }
  writeFileSync(join(venueDir, 'verdict.md'), renderVerdictMarkdown(data, passes));
  return passes;
}

if (isMainModule(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  const passes = runVenue(options);
  execFileSync('npx', ['biome', 'format', '--write', options.outDir], { stdio: 'ignore' });
  for (const pass of passes) {
    const { verdict } = pass;
    console.log(
      `${verdict.venue} £${pass.startCapitalGbp} ${pass.wholeShares ? 'whole' : 'fractional'}: ` +
        `${verdict.pass ? 'PASS' : 'FAIL'} wf strategy ${verdict.walkForward.strategySharpe.toFixed(3)} ` +
        `(haircut ${verdict.walkForward.strategySharpeHaircut.toFixed(3)}) vs benchmark ` +
        `${verdict.walkForward.benchmarkSharpe.toFixed(3)}; DSR ${verdict.deflatedSharpe.toFixed(3)}; ` +
        `PBO ${verdict.pbo.toFixed(3)}; maxDD ${(verdict.trials[0] ? Math.max(...verdict.trials.map((t) => t.maxDrawdown)) : 0).toFixed(3)}`,
    );
  }
}
