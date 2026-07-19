/**
 * `renderPerformance` (#97 acceptance criteria): current analyst weights +
 * rolling attribution + daily MetricsSuite. Asserts on formatted output
 * given a fake `QueryStore`, not on real store/database behavior
 * (cli-spec.md "Testing Decisions").
 */
import { describe, expect, it } from 'vitest';
import type { MetricsSuite } from '../cost-model-backtest/validation-types.js';
import { renderPerformance } from './render-performance.js';
import type { AttributionSummary, QueryStore } from './types.js';

const AS_OF = new Date('2026-07-19T12:00:00Z');

function makeMetricsSuite(overrides: Partial<MetricsSuite> = {}): MetricsSuite {
  return {
    sharpe: 1.5,
    sortino: 2.1,
    calmar: 0.9,
    max_drawdown: 0.12,
    profit_factor: 1.8,
    expectancy: 0.3,
    skew: 0.1,
    kurtosis: 2.9,
    turnover: 0.5,
    exposure: 0.4,
    ...overrides,
  };
}

function fakeStore(overrides: Partial<QueryStore> = {}): QueryStore {
  return {
    getRecentDebates: () => [],
    getTickStatus: () => null,
    getOpenPositions: () => [],
    getVerdictHistory: () => [],
    getAnalystWeights: () => ({}),
    getAttribution: () => ({}),
    getDailyMetrics: () => makeMetricsSuite(),
    getMark: () => {
      throw new Error('not used in these tests');
    },
    ...overrides,
  };
}

describe('renderPerformance', () => {
  it('shows current per-analyst weights', () => {
    const store = fakeStore({
      getAnalystWeights: () => ({ 'analyst-technical-1': 0.6, 'analyst-sentiment-1': 0.4 }),
    });

    const output = renderPerformance(store, AS_OF);

    expect(output).toContain('analyst-technical-1');
    expect(output).toContain('weight=0.6');
    expect(output).toContain('analyst-sentiment-1');
    expect(output).toContain('weight=0.4');
  });

  it('shows rolling attribution per analyst', () => {
    const attribution: Record<string, AttributionSummary> = {
      'analyst-technical-1': { analyst_id: 'analyst-technical-1', rolling_r: 1.2, window_days: 30 },
    };
    const store = fakeStore({ getAttribution: () => attribution });

    const output = renderPerformance(store, AS_OF);

    expect(output).toContain('analyst-technical-1');
    expect(output).toContain('rolling_r=1.2');
    expect(output).toContain('window_days=30');
  });

  it('shows the full daily MetricsSuite, not a single vanity number', () => {
    const store = fakeStore({
      getDailyMetrics: () =>
        makeMetricsSuite({
          sharpe: 1.23,
          sortino: 2.34,
          calmar: 0.45,
          max_drawdown: 0.15,
          profit_factor: 1.9,
          expectancy: 0.25,
          skew: -0.2,
          kurtosis: 3.1,
          turnover: 0.6,
          exposure: 0.5,
        }),
    });

    const output = renderPerformance(store, AS_OF);

    expect(output).toContain('sharpe=1.23');
    expect(output).toContain('sortino=2.34');
    expect(output).toContain('calmar=0.45');
    expect(output).toContain('max_drawdown=0.15');
    expect(output).toContain('profit_factor=1.9');
    expect(output).toContain('expectancy=0.25');
    expect(output).toContain('skew=-0.2');
    expect(output).toContain('kurtosis=3.1');
    expect(output).toContain('turnover=0.6');
    expect(output).toContain('exposure=0.5');
  });

  it('renders sane empty states when there are no weights or attribution', () => {
    const store = fakeStore();

    const output = renderPerformance(store, AS_OF);

    expect(output).toContain('No analyst weights.');
    expect(output).toContain('No attribution data.');
  });
});
