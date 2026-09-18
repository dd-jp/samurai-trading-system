import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AdjustmentLog,
  BreachAlertChannel,
  FeedbackConfig,
} from '../../../pipeline/feedback-loop/index.js';
import { computeMetrics } from '../../../pipeline/feedback-loop/index.js';
import type { Clock, ClosedTrade, TuningStore } from '../../../shared/index.js';
import { openSharedStore } from '../../../shared/store/index.js';
import type { Stage2Selection } from '../../../tools/backtest/index.js';
import { computeMetrics as libraryComputeMetrics } from '../../../tools/backtest/index.js';
import { SqliteDailyEquityStore } from '../sqlite-daily-equity-store.js';
import type { LogEntry, Logger } from '../types.js';
import {
  DEFAULT_STAGE2_MAX_AGE_DAYS,
  MIN_RETURN_OBSERVATIONS,
  SqliteDailyEquityMetricsSource,
} from './daily-equity-metrics-source.js';

const MS_PER_DAY = 24 * 60 * 60 * 1_000;
const SERIES_START = Date.UTC(2026, 0, 1);

function makeLogger(): Logger & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { entries, log: (entry: LogEntry) => entries.push(entry) };
}

function openStore(): { store: SqliteDailyEquityStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'samurai-daily-metrics-'));
  return {
    store: new SqliteDailyEquityStore(openSharedStore(join(dir, 'test.sqlite'))),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function seed(
  store: SqliteDailyEquityStore,
  count: number,
  options: { skipDay?: number } = {},
): void {
  let day = 0;
  for (let i = 0; i < count; i += 1) {
    if (options.skipDay === i) day += 1;
    const sessionStart = new Date(SERIES_START + day * MS_PER_DAY);
    store.append(sessionStart, 100_000 + (i % 7) * 250 - i * 3, sessionStart, true);
    day += 1;
  }
}

function makeSource(
  store: SqliteDailyEquityStore,
  logger: Logger,
  trades: ClosedTrade[] = [],
  minReturnObservations?: number,
): SqliteDailyEquityMetricsSource {
  return new SqliteDailyEquityMetricsSource({
    equity: store,
    trades: { getClosedTradesBetween: () => trades },
    logger,
    ...(minReturnObservations === undefined ? {} : { minReturnObservations }),
  });
}

describe('SqliteDailyEquityMetricsSource', () => {
  it('produces a real MetricsSuite once the series is long enough', () => {
    const { store, cleanup } = openStore();
    try {
      seed(store, MIN_RETURN_OBSERVATIONS + 1);
      const sample = makeSource(store, makeLogger()).getDailyMetrics();

      expect(sample).toBeDefined();
      expect(Number.isFinite(sample?.daily.sharpe)).toBe(true);
      expect(Number.isFinite(sample?.daily.max_drawdown)).toBe(true);
      expect(sample?.revalidation).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('derives EQUITY returns annualized at 365, matching the validation library exactly', () => {
    const { store, cleanup } = openStore();
    try {
      const equities: number[] = [];
      for (let i = 0; i <= MIN_RETURN_OBSERVATIONS; i += 1) {
        const at = new Date(SERIES_START + i * MS_PER_DAY);
        const equity = 100_000 + (i % 7) * 250 - i * 3;
        equities.push(equity);
        store.append(at, equity, at, true);
      }

      const expectedReturns: number[] = [];
      for (let i = 1; i < equities.length; i += 1) {
        expectedReturns.push(
          ((equities[i] as number) - (equities[i - 1] as number)) / (equities[i - 1] as number),
        );
      }
      const averageCapital = equities.reduce((sum, e) => sum + e, 0) / equities.length;
      const expected = libraryComputeMetrics(
        { returns: expectedReturns, periodsPerYear: 365 },
        {
          trades: [],
          averageCapital,
          window: {
            start: new Date(SERIES_START),
            end: new Date(SERIES_START + MIN_RETURN_OBSERVATIONS * MS_PER_DAY),
          },
        },
      );

      expect(makeSource(store, makeLogger()).getDailyMetrics()?.daily).toEqual(expected);
    } finally {
      cleanup();
    }
  });

  it('refuses a series one observation short of the gate', () => {
    const { store, cleanup } = openStore();
    try {
      seed(store, MIN_RETURN_OBSERVATIONS);
      const logger = makeLogger();

      expect(makeSource(store, logger).getDailyMetrics()).toBeUndefined();
      expect(logger.entries[0]?.message).toMatch(/insufficient observations/);
      expect(logger.entries[0]?.payload).toMatchObject({
        usable_returns: MIN_RETURN_OBSERVATIONS - 1,
        required: MIN_RETURN_OBSERVATIONS,
      });
    } finally {
      cleanup();
    }
  });

  it('a ~10-observation soak yields nothing to evaluate', () => {
    const { store, cleanup } = openStore();
    try {
      seed(store, 10);
      expect(makeSource(store, makeLogger()).getDailyMetrics()).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('logs the skip reason ONCE per call, not once per tick', () => {
    const { store, cleanup } = openStore();
    try {
      seed(store, 10);
      const logger = makeLogger();
      const source = makeSource(store, logger);

      source.getDailyMetrics();
      expect(logger.entries).toHaveLength(1);
      source.getDailyMetrics();
      expect(logger.entries).toHaveLength(2);
    } finally {
      cleanup();
    }
  });

  it('stops the run at a spacing gap rather than treating 48h as one period', () => {
    const { store, cleanup } = openStore();
    try {
      seed(store, MIN_RETURN_OBSERVATIONS + 1, { skipDay: MIN_RETURN_OBSERVATIONS - 4 });
      const logger = makeLogger();

      expect(makeSource(store, logger).getDailyMetrics()).toBeUndefined();
      expect(logger.entries[0]?.payload).toMatchObject({ usable_returns: 4 });
    } finally {
      cleanup();
    }
  });

  it('uses only the contiguous trailing run when a gap sits before enough fresh data', () => {
    const { store, cleanup } = openStore();
    try {
      seed(store, 5);
      const store2Start = SERIES_START + 40 * MS_PER_DAY;
      for (let i = 0; i <= MIN_RETURN_OBSERVATIONS; i += 1) {
        const at = new Date(store2Start + i * MS_PER_DAY);
        store.append(at, 100_000 + (i % 5) * 300, at, true);
      }

      expect(makeSource(store, makeLogger()).getDailyMetrics()).toBeDefined();
    } finally {
      cleanup();
    }
  });

  it('refuses a series whose base equity is non-positive', () => {
    const { store, cleanup } = openStore();
    try {
      for (let i = 0; i <= MIN_RETURN_OBSERVATIONS; i += 1) {
        const at = new Date(SERIES_START + i * MS_PER_DAY);
        store.append(at, i === MIN_RETURN_OBSERVATIONS - 3 ? 0 : 100_000 + i * 40, at, true);
      }

      expect(makeSource(store, makeLogger()).getDailyMetrics()).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('does not let a HISTORICAL zero poison a fresh usable run behind it', () => {
    const { store, cleanup } = openStore();
    try {
      store.append(new Date(SERIES_START), 0, new Date(SERIES_START), true);
      for (let i = 1; i <= MIN_RETURN_OBSERVATIONS + 1; i += 1) {
        const at = new Date(SERIES_START + i * MS_PER_DAY);
        store.append(at, 100_000 + (i % 5) * 300, at, true);
      }

      expect(makeSource(store, makeLogger()).getDailyMetrics()).toBeDefined();
    } finally {
      cleanup();
    }
  });

  it('returns undefined rather than throwing when the account was perfectly flat', () => {
    const { store, cleanup } = openStore();
    try {
      for (let i = 0; i <= MIN_RETURN_OBSERVATIONS; i += 1) {
        const at = new Date(SERIES_START + i * MS_PER_DAY);
        store.append(at, 100_000, at, true);
      }
      const logger = makeLogger();

      expect(makeSource(store, logger).getDailyMetrics()).toBeUndefined();
      expect(logger.entries[0]?.message).toMatch(/zero variance/);
    } finally {
      cleanup();
    }
  });

  it('lets the gate be raised but never lowered', () => {
    const { store, cleanup } = openStore();
    try {
      expect(() =>
        makeSource(store, makeLogger(), [], MIN_RETURN_OBSERVATIONS + 100),
      ).not.toThrow();
      expect(() => makeSource(store, makeLogger(), [], 2)).toThrow(/must be at least/);
    } finally {
      cleanup();
    }
  });
});

describe('the gate protects autoTighten from a short series', () => {
  function makeTuning(): TuningStore & { thresholds: Record<string, number> } {
    const thresholds: Record<string, number> = { max_position_pct: 0.5 };
    return {
      thresholds,
      getAnalystWeights: () => ({}),
      setAnalystWeight: () => {},
      seedAnalystWeight: () => false,
      seedRiskThreshold: () => false,
      getStrategyParams: () => ({}),
      setStrategyParam: () => {},
      getRiskThresholds: () => ({ ...thresholds }),
      setRiskThreshold: (name, value) => {
        thresholds[name] = value;
      },
    };
  }

  const BACKTEST_REFERENCE_SHARPE = 1_000;

  const config: FeedbackConfig = {
    attribution_window_ms: MS_PER_DAY,
    weights: { floor: 0, ceiling: 1, max_step: 0.1, tighten_is: 'decrease' },
    strategy_params: {},
    risk_thresholds: {
      max_position_pct: { floor: 0.01, ceiling: 1, max_step: 0.1, tighten_is: 'decrease' },
    },
    kill_thresholds: {
      max_pbo: 0.05,
      min_oos_sharpe: 0.5,
      min_deflated_sharpe: 0.95,
      max_live_backtest_divergence: 0,
    },
  };

  it('does not fire on a ~10-observation series, because no suite is produced', () => {
    const { store, cleanup } = openStore();
    try {
      seed(store, 10);
      const tuning = makeTuning();
      const appended: unknown[] = [];
      const adjustments: AdjustmentLog = { append: (entry) => appended.push(entry) };
      const alerts: BreachAlertChannel = { postBreachAlert: () => {} };

      const sample = makeSource(store, makeLogger()).getDailyMetrics();
      expect(sample).toBeUndefined();

      if (sample !== undefined) {
        computeMetrics({
          clock: { now: () => new Date(SERIES_START) },
          daily: sample.daily,
          backtest_reference_sharpe: BACKTEST_REFERENCE_SHARPE,
          tuning,
          adjustments,
          config,
          alerts,
        });
      }

      expect(tuning.thresholds.max_position_pct).toBe(0.5);
      expect(appended).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('MUTATION GUARD: the same short series DOES auto-tighten if it reaches computeMetrics', () => {
    const { store, cleanup } = openStore();
    try {
      seed(store, 10);
      const tuning = makeTuning();
      const appended: unknown[] = [];

      const ungated = makeSource(store, makeLogger());
      // biome-ignore lint/complexity/useLiteralKeys: reaching past the gate on purpose.
      (ungated as unknown as Record<string, number>)['minReturnObservations'] = 2;

      const sample = ungated.getDailyMetrics();
      expect(sample).toBeDefined();

      computeMetrics({
        clock: { now: () => new Date(SERIES_START) },
        daily: (sample as { daily: never }).daily,
        backtest_reference_sharpe: BACKTEST_REFERENCE_SHARPE,
        tuning,
        adjustments: { append: (entry) => appended.push(entry) },
        config,
        alerts: { postBreachAlert: () => {} },
      });

      expect(tuning.thresholds.max_position_pct).toBeLessThan(0.5);
      expect(appended).not.toEqual([]);
    } finally {
      cleanup();
    }
  });
});

describe('SqliteDailyEquityMetricsSource — revalidation from the Stage 2 selection (#384)', () => {
  const NOW = new Date('2026-08-06T09:00:00Z');
  const CLOCK: Clock = { now: () => NOW };

  function selection(overrides: Partial<Stage2Selection> = {}): Stage2Selection {
    return {
      config_hash: 'cfg-a',
      asset_class: 'crypto',
      selected_at: new Date('2026-08-01T00:00:00Z'),
      window: { start: new Date('2024-01-01T00:00:00Z'), end: new Date('2026-01-01T00:00:00Z') },
      backtest_sharpe: 1.4,
      oos_sharpe: 0.9,
      fold_sharpes: [0.8, 1.0],
      pbo: 0.2,
      dsr: 0.42,
      n_trials: 24,
      overall_pass: false,
      ...overrides,
    };
  }

  function sourceWith(
    store: SqliteDailyEquityStore,
    logger: Logger,
    selections: Stage2Selection[],
  ): SqliteDailyEquityMetricsSource {
    return new SqliteDailyEquityMetricsSource({
      equity: store,
      trades: { getClosedTradesBetween: () => [] },
      logger,
      stage2Selections: { getLatestPerAssetClass: () => selections },
      clock: CLOCK,
    });
  }

  it('reports the snapshot from a fresh selection', () => {
    const { store, cleanup } = openStore();
    try {
      seed(store, MIN_RETURN_OBSERVATIONS + 1);

      const sample = sourceWith(store, makeLogger(), [selection()]).getDailyMetrics();

      expect(sample?.revalidation).toEqual({
        walk_forward_sharpe_distribution: [0.8, 1.0],
        deflated_sharpe: 0.42,
        pbo: 0.2,
      });
    } finally {
      cleanup();
    }
  });

  it('reports the WORSE asset class when both have one', () => {
    const { store, cleanup } = openStore();
    try {
      seed(store, MIN_RETURN_OBSERVATIONS + 1);

      const sample = sourceWith(store, makeLogger(), [
        selection({ asset_class: 'crypto', pbo: 0.9, dsr: 0.1, fold_sharpes: [0.1] }),
        selection({ asset_class: 'stocks', pbo: 0.01, dsr: 0.99, fold_sharpes: [1.5] }),
      ]).getDailyMetrics();

      expect(sample?.revalidation?.pbo).toBe(0.9);
    } finally {
      cleanup();
    }
  });

  it('stays absent when Stage 2 has never run', () => {
    const { store, cleanup } = openStore();
    try {
      seed(store, MIN_RETURN_OBSERVATIONS + 1);
      const logger = makeLogger();

      const sample = sourceWith(store, logger, []).getDailyMetrics();

      expect(sample?.daily).toBeDefined();
      expect(sample?.revalidation).toBeUndefined();
      expect(logger.entries.some((entry) => entry.message.includes('never persisted'))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('refuses a selection older than the freshness bound', () => {
    const { store, cleanup } = openStore();
    try {
      seed(store, MIN_RETURN_OBSERVATIONS + 1);
      const stale = new Date(NOW.getTime() - (DEFAULT_STAGE2_MAX_AGE_DAYS + 1) * 86_400_000);

      const sample = sourceWith(store, makeLogger(), [
        selection({ selected_at: stale }),
      ]).getDailyMetrics();

      expect(sample?.revalidation).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('refuses a selection whose PBO or DSR was never computed', () => {
    const { store, cleanup } = openStore();
    try {
      seed(store, MIN_RETURN_OBSERVATIONS + 1);

      const sample = sourceWith(store, makeLogger(), [selection({ pbo: null })]).getDailyMetrics();

      expect(sample?.revalidation).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('reports a FAILED Stage 2 verdict rather than suppressing it', () => {
    const { store, cleanup } = openStore();
    try {
      seed(store, MIN_RETURN_OBSERVATIONS + 1);

      const sample = sourceWith(store, makeLogger(), [
        selection({ overall_pass: false, pbo: 0.8 }),
      ]).getDailyMetrics();

      expect(sample?.revalidation?.pbo).toBe(0.8);
    } finally {
      cleanup();
    }
  });

  it('says why the lines are inert ONCE per process, not once per cycle', () => {
    const { store, cleanup } = openStore();
    try {
      seed(store, MIN_RETURN_OBSERVATIONS + 1);
      const logger = makeLogger();
      const source = sourceWith(store, logger, []);

      source.getDailyMetrics();
      source.getDailyMetrics();

      const inert = logger.entries.filter((entry) => entry.message.includes('no revalidation'));
      expect(inert).toHaveLength(1);
    } finally {
      cleanup();
    }
  });
});
