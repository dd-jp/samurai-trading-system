import { describe, expect, it } from 'vitest';
import type { BarSeries, DailyBar } from '../../pipeline/momentum/index.js';
import { DEFAULT_BAR_STORE_ROOT } from '../../providers/bar-store/index.js';
import { SimulatedClock } from '../../shared/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import { resolveCliOptions, runCrossAssetTrendAgainst } from './backtest-cli.js';
import { BarsMarketData, parseBoeGbpUsdCsv } from './data/index.js';
import { CONSTITUENTS_PATH, FX_PATH, SAXO_SPREADS_PATH, SPREADS_PATH } from './index.js';
import { CROSS_ASSET_TREND_TIDMS } from './signal/index.js';
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
  it('#1785: orchestrates trials, benchmark and the cost-stress rerun over a fixed window', async () => {
    const market = new BarsMarketData(
      { load: (symbol) => SYNTHETIC_BARS.get(symbol) },
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
