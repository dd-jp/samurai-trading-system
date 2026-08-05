import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeMetrics as libraryComputeMetrics } from '../../cost-model-backtest/index.js';
import type {
  AdjustmentLog,
  BreachAlertChannel,
  FeedbackConfig,
  TuningStore,
} from '../../feedback-loop/index.js';
import { computeMetrics } from '../../feedback-loop/index.js';
import type { ClosedTrade } from '../../shared/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import { SqliteDailyEquityStore } from '../sqlite-daily-equity-store.js';
import type { LogEntry, Logger } from '../types.js';
import {
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

/**
 * `count` daily observations on consecutive UTC midnights, wobbling around
 * 100_000 so the series has non-zero variance (a flat account has no Sharpe and
 * `computeMetrics` rightly throws on it).
 *
 * `dayOffsets` lets a test punch a hole in the calendar without changing
 * anything else — that is how the even-spacing behaviour is exercised.
 */
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
      // One more observation than returns required — n observations give n−1.
      seed(store, MIN_RETURN_OBSERVATIONS + 1);
      const sample = makeSource(store, makeLogger()).getDailyMetrics();

      expect(sample).toBeDefined();
      expect(Number.isFinite(sample?.daily.sharpe)).toBe(true);
      expect(Number.isFinite(sample?.daily.max_drawdown)).toBe(true);
      // Daily, never a revalidation snapshot: walk-forward/DSR/PBO are computed
      // offline on their own cadence, not derived from an equity series.
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

      // Recomputed here from the raw equities, so this pins BOTH halves of the
      // derivation independently of the implementation:
      //
      // - the returns are `(E_t − E_{t−1}) / E_{t−1}` — equity returns, not
      //   realized-PnL-over-capital, which is the whole point of #345;
      // - `periodsPerYear` is 365, the UTC-day cadence the portfolio boundary
      //   actually advances at. 252 (the trading-day count) would silently
      //   over-annualize every ratio in the suite by ~1.2x, and nothing else in
      //   the system would notice.
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
      // MIN observations => MIN−1 returns => exactly one short.
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
      // What a 14-day paper soak (#238) actually produces.
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

      // `getDailyMetrics` is called once per feedback cycle, so one line per
      // call is one line per day. An unattended soak must not receive the same
      // sentence 20,000 times (the failure #342 fixed for the heartbeat).
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
      // A long-enough series with a missing midnight near the end: the process
      // was down across one boundary. Everything before the hole is unusable as
      // a contiguous trailing run, so the remainder is too short to evaluate.
      seed(store, MIN_RETURN_OBSERVATIONS + 1, { skipDay: MIN_RETURN_OBSERVATIONS - 4 });
      const logger = makeLogger();

      expect(makeSource(store, logger).getDailyMetrics()).toBeUndefined();
      // Only the post-gap tail counted, not the full row count.
      expect(logger.entries[0]?.payload).toMatchObject({ usable_returns: 4 });
    } finally {
      cleanup();
    }
  });

  it('uses only the contiguous trailing run when a gap sits before enough fresh data', () => {
    const { store, cleanup } = openStore();
    try {
      // Ancient stretch, hole, then a full usable run.
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
        // A wiped-out account. Dividing by 0 gives Infinity/NaN, and NaN
        // compares false against every kill threshold — the lines would stop
        // firing silently instead of failing.
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
      // Day 0 is a zero — an account that was empty before it was funded, which
      // is the ordinary case for a new deployment, not a disaster.
      store.append(new Date(SERIES_START), 0, new Date(SERIES_START), true);
      for (let i = 1; i <= MIN_RETURN_OBSERVATIONS + 1; i += 1) {
        const at = new Date(SERIES_START + i * MS_PER_DAY);
        store.append(at, 100_000 + (i % 5) * 300, at, true);
      }

      // The backward walk must STOP at the zero and keep the tail. Rejecting the
      // whole series instead would mean one bad historical row disables the
      // kill-lines permanently — the series only ever grows, so that row never
      // ages out.
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

      // Zero variance: `computeMetrics` throws by design. The port's contract is
      // `undefined` for "no suite this cycle", and an exception escaping into
      // the daily timer would be logged as a failed feedback cycle.
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
      // The floor is a safety property of a path that writes risk thresholds,
      // not a preference a config may switch off.
      expect(() => makeSource(store, makeLogger(), [], 2)).toThrow(/must be at least/);
    } finally {
      cleanup();
    }
  });
});

/**
 * The gate's reason for existing, tested end-to-end rather than by inspection:
 * a breach does not merely report, it WRITES every risk threshold toward its
 * extreme and appends to the `AdjustmentLog`.
 */
describe('the gate protects autoTighten from a short series', () => {
  function makeTuning(): TuningStore & { thresholds: Record<string, number> } {
    const thresholds: Record<string, number> = { max_position_pct: 0.5 };
    return {
      thresholds,
      getAnalystWeights: () => ({}),
      setAnalystWeight: () => {},
      getStrategyParams: () => ({}),
      setStrategyParam: () => {},
      getRiskThresholds: () => ({ ...thresholds }),
      setRiskThreshold: (name, value) => {
        thresholds[name] = value;
      },
    };
  }

  /**
   * Set above anything the short fixture can report, so the divergence line
   * breaches on live-below-reference rather than on the fixture's sign.
   *
   * The number needs to be this big, and that is the finding rather than a test
   * quirk: the 10-observation series below — a near-flat sawtooth account that
   * ends roughly where it started — reports an ANNUALIZED SHARPE OF ~20.9.
   * `liveBacktestDivergence` floors at 0 when live is at or above the reference,
   * so a reference of, say, 5 would see that 20.9 as outperformance and never
   * breach. A 9-return sample can produce essentially any Sharpe it likes; that
   * is precisely the noise `MIN_RETURN_OBSERVATIONS` exists to keep away from a
   * function that writes risk thresholds.
   */
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
      // Deliberately hair-trigger: ANY shortfall against the reference breaches.
      // If a short series ever reached `computeMetrics`, this would fire.
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

      // The orchestrator's own contract: no sample means `computeMetrics` is
      // never called. Nothing was written.
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

      // The gate removed — exactly what a regression that drops the minimum
      // would produce. This asserts the danger is real, so the test above is
      // proving something rather than restating a tautology.
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

      // A 9-return sample stepped a real risk threshold toward its floor.
      expect(tuning.thresholds.max_position_pct).toBeLessThan(0.5);
      expect(appended).not.toEqual([]);
    } finally {
      cleanup();
    }
  });
});
