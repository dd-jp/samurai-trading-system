import type { Clock } from '../../shared/index.js';
import { ThresholdBoundViolationError } from '../../shared/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import { InMemoryTuningStore } from './fixture-stores.js';
import { assertKillThresholdsWithinBounds } from './metrics.js';
import { SqliteTuningStore } from './sqlite-tuning-store.js';
import type { KillThresholds } from './types.js';

const NOW = new Date('2026-07-19T00:00:00Z');
const clock: Clock = { now: () => NOW };

function makeSqliteStore(): SqliteTuningStore {
  return new SqliteTuningStore(openSharedStore(':memory:'), clock);
}

function makeKillThresholds(overrides: Partial<KillThresholds> = {}): KillThresholds {
  return {
    max_pbo: 0.05,
    min_oos_sharpe: 0.5,
    min_deflated_sharpe: 0.95,
    max_live_backtest_divergence: 0.5,
    ...overrides,
  };
}

describe.each([
  {
    label: 'SqliteTuningStore',
    make: () =>
      makeSqliteStore() as {
        setRiskThreshold(name: string, value: number): void;
        seedRiskThreshold(name: string, value: number): boolean;
        getRiskThresholds(): Record<string, number>;
      },
  },
  { label: 'InMemoryTuningStore', make: () => new InMemoryTuningStore() },
])('$label — the Feedback Loop write door (#638)', ({ make }) => {
  it('writes an unguarded dial freely — the loop keeps its working levers', () => {
    const store = make();
    store.setRiskThreshold('max_position_size', 900);

    expect(store.getRiskThresholds()).toEqual({ max_position_size: 900 });
  });

  it('refuses a write that would loosen PBO past the one hard kill criterion', () => {
    const store = make();

    expect(() => store.setRiskThreshold('max_pbo', 0.5)).toThrow(ThresholdBoundViolationError);
    expect(store.getRiskThresholds()).toEqual({});
  });

  it('refuses a write past every guarded breaker line', () => {
    const store = make();

    expect(() => store.setRiskThreshold('max_drawdown_pct', 0.9)).toThrow(
      ThresholdBoundViolationError,
    );
    expect(() => store.setRiskThreshold('recovery_drawdown_pct', 0.9)).toThrow(
      ThresholdBoundViolationError,
    );
    expect(() => store.setRiskThreshold('daily_loss_pct', 0.5)).toThrow(
      ThresholdBoundViolationError,
    );
    expect(() => store.setRiskThreshold('daily_loss_pct_crypto', 0.5)).toThrow(
      ThresholdBoundViolationError,
    );
    expect(() => store.setRiskThreshold('daily_loss_pct_stocks', 0.5)).toThrow(
      ThresholdBoundViolationError,
    );
  });

  it('refuses a write that would lower either Sharpe kill line', () => {
    const store = make();

    expect(() => store.setRiskThreshold('min_oos_sharpe', 0.1)).toThrow(
      ThresholdBoundViolationError,
    );
    expect(() => store.setRiskThreshold('min_deflated_sharpe', 0.1)).toThrow(
      ThresholdBoundViolationError,
    );
  });

  it('guards the SEED path too — a first write is still a write', () => {
    const store = make();

    expect(() => store.seedRiskThreshold('max_pbo', 0.5)).toThrow(ThresholdBoundViolationError);
    expect(store.getRiskThresholds()).toEqual({});
  });
});

describe('assertKillThresholdsWithinBounds (#638)', () => {
  it('accepts the shipped paper kill lines', () => {
    expect(() => assertKillThresholdsWithinBounds(makeKillThresholds(), 'test')).not.toThrow();
  });

  it('refuses a softened PBO line', () => {
    expect(() =>
      assertKillThresholdsWithinBounds(makeKillThresholds({ max_pbo: 0.11 }), 'test'),
    ).toThrow(ThresholdBoundViolationError);
  });

  it('refuses a lowered OOS Sharpe line', () => {
    expect(() =>
      assertKillThresholdsWithinBounds(makeKillThresholds({ min_oos_sharpe: 0.2 }), 'test'),
    ).toThrow(/min_oos_sharpe/);
  });

  it('refuses a lowered deflated-Sharpe line', () => {
    expect(() =>
      assertKillThresholdsWithinBounds(makeKillThresholds({ min_deflated_sharpe: 0.5 }), 'test'),
    ).toThrow(/min_deflated_sharpe/);
  });

  it('leaves max_live_backtest_divergence unguarded — no document states a line for it', () => {
    expect(() =>
      assertKillThresholdsWithinBounds(
        makeKillThresholds({ max_live_backtest_divergence: 99 }),
        'test',
      ),
    ).not.toThrow();
  });

  it('says nothing about an ABSENT block — that is a missing-config failure, not a crossing', () => {
    expect(() => assertKillThresholdsWithinBounds(undefined, 'test')).not.toThrow();
  });
});
