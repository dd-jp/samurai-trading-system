import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BarSeries, DailyBar } from '../../pipeline/momentum/index.js';
import { DEFAULT_BAR_STORE_ROOT } from '../../providers/bar-store/index.js';
import { SimulatedClock } from '../../shared/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import {
  resolveCliOptions,
  runCrossAssetTrendAgainst,
  runCrossAssetTrendCandidate,
  runMeanReversionAgainst,
  runVolTargetIndexAgainst,
} from './backtest-cli.js';
import { BarsMarketData, parseBoeGbpUsdCsv } from './data/index.js';
import { CONSTITUENTS_PATH, FX_PATH, SAXO_SPREADS_PATH, SPREADS_PATH } from './index.js';
import { CROSS_ASSET_TREND_TIDMS, VOL_TARGET_INDEX_TIDMS } from './signal/index.js';
import { researchStorePath, TrialLedger } from './trial-ledger.js';

describe('resolveCliOptions', () => {
  it('defaults every path and the logger when nothing is given', () => {
    const resolved = resolveCliOptions({});
    expect(resolved.root).toBe(DEFAULT_BAR_STORE_ROOT);
    expect(resolved.fxPath).toBe(FX_PATH);
    expect(resolved.spreadsPath).toBe(SPREADS_PATH);
    expect(resolved.saxoSpreadsPath).toBe(SAXO_SPREADS_PATH);
    expect(resolved.constituentsPath).toBe(CONSTITUENTS_PATH);
    expect(resolved.storePath).toBe(researchStorePath());
    expect(() =>
      resolved.logger.log({ level: 'info', event: 'x', trace_id: 't', stage: 's', message: 'm' }),
    ).not.toThrow();
  });

  it('keeps every override untouched', () => {
    const logger = { log: () => undefined };
    const resolved = resolveCliOptions({
      barStoreRoot: 'root',
      fxPath: 'fx',
      spreadsPath: 'spreads',
      saxoSpreadsPath: 'saxo-spreads',
      constituentsPath: 'constituents',
      storePath: ':memory:',
      logger,
    });
    expect(resolved).toEqual({
      root: 'root',
      fxPath: 'fx',
      spreadsPath: 'spreads',
      saxoSpreadsPath: 'saxo-spreads',
      constituentsPath: 'constituents',
      storePath: ':memory:',
      logger,
    });
  });
});

describe('the candidate runners', () => {
  it('restore a deleted FX file from its snapshot before reading it (#2000)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'v2-backtest-fx-'));
    try {
      writeFileSync(join(dir, 'fx.snapshot.csv'), 'DATE,XUDLUSS\n31 Dec 2025,1.25\n');
      const fxPath = join(dir, 'fx.csv');
      await expect(
        runCrossAssetTrendCandidate({ barStoreRoot: join(dir, 'no-bars'), fxPath }),
      ).rejects.toThrow();
      expect(existsSync(fxPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function weekdays(from: string, count: number): string[] {
  const dates: string[] = [];
  for (let ms = Date.parse(`${from}T00:00:00.000Z`); dates.length < count; ms += 86_400_000) {
    const day = new Date(ms).getUTCDay();
    if (day !== 0 && day !== 6) dates.push(new Date(ms).toISOString().slice(0, 10));
  }
  return dates;
}

const DATES = weekdays('2024-01-01', 90);

function series(symbol: string, drift: number): BarSeries {
  const bars: DailyBar[] = DATES.map((date, index) => {
    const close = 50 * (1 + drift) ** index;
    return {
      date,
      open: close,
      high: close * 1.01,
      low: close * 0.99,
      close,
      volume: 2_000_000,
      rawClose: close,
    };
  });
  return { symbol, bars };
}

const SYNTHETIC_BARS = new Map<string, BarSeries>(
  CROSS_ASSET_TREND_TIDMS.map((tidm, index) => [tidm, series(tidm, 0.0002 * (index + 1))]),
);

describe('runCrossAssetTrendAgainst', () => {
  // CPU-heavy: 9-12 s under coverage at load 25
  it('#1785: orchestrates trials, benchmark and the cost-stress rerun over a fixed window', {
    timeout: 40_000,
  }, async () => {
    const trendBars = { load: (symbol: string) => SYNTHETIC_BARS.get(symbol) };
    const market = new BarsMarketData(
      trendBars,
      parseBoeGbpUsdCsv('DATE,XUDLUSS\n29 Dec 2023,1.27\n'),
    );
    const db = openSharedStore(':memory:');
    try {
      const ledger = new TrialLedger(db, new SimulatedClock(new Date('2026-09-28T00:00:00.000Z')), {
        entries: [],
      });
      const window = { from: DATES[40] as string, to: DATES.at(-1) as string };
      const report = await runCrossAssetTrendAgainst(
        market,
        trendBars,
        () => 5,
        ledger,
        { log: () => undefined },
        window,
      );
      expect(report.trialsCounted).toBe(2);
      expect(ledger.count()).toBe(2);
      expect(report.baseline.trials).toHaveLength(2);
      expect(report.stressed.trials).toHaveLength(2);
      expect(report.baseline.dates).toEqual(report.stressed.dates);
      expect(report.minbtlLimit).toBeGreaterThan(0);
      expect(report.windowYears).toBeGreaterThan(0);
      expect(typeof report.signFlipped).toBe('boolean');
      // Same trials rerun at 2x cost must resolve to the same trial numbers (doc 66 ruling h):
      // a cost-sensitivity pass is never a new counted trial
      const rerun = await runCrossAssetTrendAgainst(
        market,
        trendBars,
        () => 5,
        ledger,
        { log: () => undefined },
        window,
      );
      expect(rerun.trialsCounted).toBe(2);
    } finally {
      db.close();
    }
  });
});

// A window long enough for foldRanges(16, embargo=10) to hold: length/16 - 2*embargo >= 2
// needs length >= ~352 sessions; 500 weekdays gives comfortable margin
const MEAN_REVERSION_DATES = weekdays('2022-01-01', 500);
const MEAN_REVERSION_SYMBOLS = ['AAA', 'BBB', 'CCC'];

function meanReversionSeries(symbol: string, drift: number): BarSeries {
  const bars: DailyBar[] = MEAN_REVERSION_DATES.map((date, index) => {
    const close = 50 * (1 + drift) ** index;
    return {
      date,
      open: close,
      high: close * 1.01,
      low: close * 0.99,
      close,
      volume: 2_000_000,
      rawClose: close,
    };
  });
  return { symbol, bars };
}

function meanReversionBarsSource() {
  const bySymbol = new Map<string, BarSeries>(
    MEAN_REVERSION_SYMBOLS.map((symbol, index) => [
      symbol,
      meanReversionSeries(symbol, 0.0003 * (index + 1)),
    ]),
  );
  // 'SPY' (calendarReferenceFor('alpaca')) is the session calendar, not a traded instrument
  bySymbol.set('SPY', {
    symbol: 'SPY',
    bars: MEAN_REVERSION_DATES.map((date) => ({
      date,
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      volume: 1,
      rawClose: 1,
    })),
  });
  return { load: (symbol: string) => bySymbol.get(symbol) };
}

describe('runMeanReversionAgainst', () => {
  // CPU-heavy: ~68 s under coverage at load 25
  it('#1785: orchestrates trials, benchmark and the cost-stress rerun with the #1515 embargo baked in', {
    timeout: 180_000,
  }, async () => {
    const barsSource = meanReversionBarsSource();
    const market = new BarsMarketData(
      barsSource,
      parseBoeGbpUsdCsv('DATE,XUDLUSS\n31 Dec 2021,1.35\n29 Dec 2023,1.27\n'),
    );
    const constituentsFor = (): readonly string[] => MEAN_REVERSION_SYMBOLS;
    const db = openSharedStore(':memory:');
    try {
      const ledger = new TrialLedger(db, new SimulatedClock(new Date('2026-09-28T00:00:00.000Z')), {
        entries: [],
      });
      const window = {
        from: MEAN_REVERSION_DATES[20] as string,
        to: MEAN_REVERSION_DATES.at(-1) as string,
      };
      const report = await runMeanReversionAgainst(
        market,
        barsSource,
        constituentsFor,
        () => 5,
        ledger,
        { log: () => undefined },
        window,
      );
      expect(report.trialsCounted).toBe(2);
      expect(ledger.count()).toBe(2);
      expect(report.baseline.trials).toHaveLength(2);
      expect(report.stressed.trials).toHaveLength(2);
      expect(report.baseline.dates).toEqual(report.stressed.dates);
      expect(report.minbtlLimit).toBeGreaterThan(0);
      expect(report.windowYears).toBeGreaterThan(0);
      expect(typeof report.signFlipped).toBe('boolean');
      // Same trials rerun at 2x cost must resolve to the same trial numbers (doc 66 ruling h)
      const rerun = await runMeanReversionAgainst(
        market,
        barsSource,
        constituentsFor,
        () => 5,
        ledger,
        { log: () => undefined },
        window,
      );
      expect(rerun.trialsCounted).toBe(2);
    } finally {
      db.close();
    }
  });
});

// foldRanges(16, embargo=20) needs length/16 - 2*embargo >= 2, so at least ~672 sessions
const VOL_TARGET_DATES = weekdays('2021-01-01', 720);

// ISF doubles as the LSE session calendar. IEEM swings ±4% a day through the middle third, far
// above either ceiling, so the strategy exits there while the benchmark holds
function volTargetSeries(symbol: string, swing: (index: number) => number): BarSeries {
  const bars: DailyBar[] = VOL_TARGET_DATES.map((date, index) => {
    const close = 4 * 1.0002 ** index * swing(index);
    return {
      date,
      open: close,
      high: close * 1.01,
      low: close * 0.99,
      close,
      volume: 2_000_000,
      rawClose: close,
    };
  });
  return { symbol, bars };
}

function volTargetBarsSource() {
  const third = VOL_TARGET_DATES.length / 3;
  const volatile = (index: number) =>
    index > third && index < 2 * third ? (index % 2 === 0 ? 1.04 : 0.96) : 1;
  const bySymbol = new Map<string, BarSeries>([
    ['ISF', volTargetSeries('ISF', () => 1)],
    ['IEEM', volTargetSeries('IEEM', volatile)],
  ]);
  return { load: (symbol: string) => bySymbol.get(symbol) };
}

describe('runVolTargetIndexAgainst', () => {
  it('#1785: runs both ceilings and the benchmark with the 20-session embargo, idempotently', {
    timeout: 180_000,
  }, async () => {
    const barsSource = volTargetBarsSource();
    const market = new BarsMarketData(
      barsSource,
      parseBoeGbpUsdCsv(
        'DATE,XUDLUSS\n31 Dec 2020,1.36\n31 Dec 2021,1.35\n30 Dec 2022,1.21\n29 Dec 2023,1.27\n',
      ),
    );
    const db = openSharedStore(':memory:');
    try {
      const ledger = new TrialLedger(db, new SimulatedClock(new Date('2026-10-02T00:00:00.000Z')), {
        entries: [],
      });
      const window = {
        from: VOL_TARGET_DATES[45] as string,
        to: VOL_TARGET_DATES.at(-1) as string,
      };
      const report = await runVolTargetIndexAgainst(
        market,
        barsSource,
        () => 5,
        ledger,
        { log: () => undefined },
        window,
      );
      expect(report.trialsCounted).toBe(2);
      expect(report.baseline.trials.map((trial) => trial.sleeve)).toEqual([
        'vol-target-index-v20',
        'vol-target-index-v25',
      ]);
      expect(report.stressed.trials).toHaveLength(2);
      expect(report.baseline.dates).toEqual(report.stressed.dates);
      expect(report.baseline.benchmark.equity[0]).toBe(7_000);
      const configs = (
        db.prepare('SELECT config FROM v2_trials ORDER BY trial').all() as {
          config: string;
        }[]
      ).map((row) => JSON.parse(row.config));
      expect(configs.map((config) => config.vol_ceiling)).toEqual([0.2, 0.25]);
      for (const config of configs) {
        expect(config).toMatchObject({
          universe: VOL_TARGET_INDEX_TIDMS,
          vol_window: 20,
          atr_window: 20,
          lookback_bars: 40,
        });
      }
      const benchmark = report.baseline.benchmark.equity;
      expect(new Set(benchmark).size).toBeGreaterThan(1);
      expect(report.baseline.trials[0]?.equity).not.toEqual(benchmark);
      expect(report.baseline.verdict.trialsCounted).toBe(2);
      const rerun = await runVolTargetIndexAgainst(
        market,
        barsSource,
        () => 5,
        ledger,
        { log: () => undefined },
        window,
      );
      expect(rerun.trialsCounted).toBe(2);
    } finally {
      db.close();
    }
  });
});

class TrialsRecorded extends Error {}

const NEW_TRIAL =
  "a changed trial hash is a new trial: the next run counts it against the candidate's 8 (doc 66 S3). Restore the hashed config, or re-pin only when a new trial is intended (#2020)";

async function recordedHashes(
  run: (
    market: BarsMarketData,
    bars: { load: (symbol: string) => BarSeries },
    ledger: TrialLedger,
  ) => Promise<unknown>,
): Promise<string[]> {
  const flat: DailyBar[] = weekdays('2000-01-03', 7_000).map((date) => ({
    date,
    open: 1,
    high: 1,
    low: 1,
    close: 1,
    volume: 1,
    rawClose: 1,
  }));
  const bars = { load: (symbol: string): BarSeries => ({ symbol, bars: flat }) };
  const market = new BarsMarketData(bars, parseBoeGbpUsdCsv('DATE,XUDLUSS\n29 Dec 2023,1.27\n'));
  const db = openSharedStore(':memory:');
  try {
    const ledger = new TrialLedger(db, new SimulatedClock(new Date('2026-10-02T00:00:00.000Z')), {
      entries: [],
    });
    const record = ledger.record.bind(ledger);
    ledger.record = (candidate, config) => {
      const trial = record(candidate, config);
      if (trial === 2) throw new TrialsRecorded();
      return trial;
    };
    await run(market, bars, ledger).catch((error: unknown) => {
      if (!(error instanceof TrialsRecorded)) throw error;
    });
    return ledger.list().map((row) => row.config_hash);
  } finally {
    db.close();
  }
}

// #2020: the trial identities doc 66 records. A drift re-counts an already-counted trial on the
// next run. Candidate 1's pre-#1815 0 bps pair, 18f04f50a183625e / 26a1eb88925a84e3, is a
// different experiment (entries filled at the decision close), not a hash to restore
describe('candidate trial hashes', () => {
  const quiet = { log: () => undefined };

  it('candidate 1 (cross-asset trend, SMA 100 / 200) keeps its 50 bps identity', async () => {
    const hashes = await recordedHashes((market, bars, ledger) =>
      runCrossAssetTrendAgainst(market, bars, () => 5, ledger, quiet),
    );
    expect(hashes, NEW_TRIAL).toEqual(['039ee8786818d43b', '043b721456d8d5e0']);
  });

  it('candidate 2 (mean reversion, RSI 10 / 15) keeps its recorded identity', async () => {
    const hashes = await recordedHashes((market, bars, ledger) =>
      runMeanReversionAgainst(
        market,
        bars,
        () => [],
        () => 5,
        ledger,
        quiet,
      ),
    );
    expect(hashes, NEW_TRIAL).toEqual(['478efb348a94f03d', '7cec20c3ae4bd18c']);
  });

  it('candidate 3 (vol-target index, ceiling 20% / 25%) keeps its recorded identity', async () => {
    const hashes = await recordedHashes((market, bars, ledger) =>
      runVolTargetIndexAgainst(market, bars, () => 5, ledger, quiet),
    );
    expect(hashes, NEW_TRIAL).toEqual(['af1c47710daf23f4', 'c3839566e157ce07']);
  });
});
