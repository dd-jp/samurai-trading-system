/**
 * In-memory implementations of the Feedback Loop's store ports (#91) —
 * concrete implementations, not test-only mocks, mirroring
 * server/pipeline/trader/fixture-setup-store.ts and
 * server/pipeline/debate-engine/debate-log-store.ts's `InMemoryDebateLogStore`.
 *
 * These are no longer the only implementations: `SqliteTuningStore`,
 * `SqliteClosedTradeStore` and `SqliteAdjustmentLog` sit beside this file and
 * are what production wires. These survive as the in-memory pair for tests.
 */
import type { ClosedTrade, ClosedTradeStore, TuningStore } from '../../shared/index.js';
import { assertThresholdWithinBounds } from '../../shared/index.js';
import type { OutsideBenchmarkSample } from '../outside-benchmark/index.js';
import type {
  Adjustment,
  AdjustmentLog,
  ArmComparisonSample,
  ArmComparisonSampleStore,
  BreachAlert,
  BreachAlertChannel,
  OutsideBenchmarkSampleStore,
  PersistedArmComparisonSample,
} from './types.js';

export class InMemoryClosedTradeStore implements ClosedTradeStore {
  private readonly trades: ClosedTrade[];

  constructor(trades: ClosedTrade[] = []) {
    this.trades = [...trades];
  }

  /** Half-open at the start, so consecutive cycles partition the timeline. */
  getClosedTradesBetween(from: Date, to: Date): ClosedTrade[] {
    return this.trades.filter(
      (trade) =>
        trade.closed_at.getTime() > from.getTime() && trade.closed_at.getTime() <= to.getTime(),
    );
  }
}

export class InMemoryTuningStore implements TuningStore {
  private readonly weights: Record<string, number>;
  private readonly params: Record<string, number>;
  private readonly thresholds: Record<string, number>;

  constructor(
    initial: {
      weights?: Record<string, number>;
      params?: Record<string, number>;
      thresholds?: Record<string, number>;
    } = {},
  ) {
    this.weights = { ...initial.weights };
    this.params = { ...initial.params };
    this.thresholds = { ...initial.thresholds };
  }

  // Copies out, so a caller holding a returned map cannot mutate the dials
  // behind the store's back — every write goes through a setter and is
  // therefore auditable.
  getAnalystWeights(): Record<string, number> {
    return { ...this.weights };
  }

  /**
   * First-write-wins, mirroring `SqliteTuningStore.seedAnalystWeight` (#371).
   * Single-threaded here, so the atomicity the SQLite version needs is free —
   * what a fixture must preserve is the SEMANTIC: an existing row is never
   * overwritten, and the return value says who wrote it.
   */
  seedAnalystWeight(analyst_id: string, weight: number): boolean {
    if (this.weights[analyst_id] !== undefined) {
      return false;
    }
    this.weights[analyst_id] = weight;
    return true;
  }

  setAnalystWeight(analyst_id: string, weight: number): void {
    this.weights[analyst_id] = weight;
  }

  getStrategyParams(): Record<string, number> {
    return { ...this.params };
  }

  setStrategyParam(name: string, value: number): void {
    this.params[name] = value;
  }

  getRiskThresholds(): Record<string, number> {
    return { ...this.thresholds };
  }

  /**
   * Clamped exactly as `SqliteTuningStore` is (#638). A fixture that accepted
   * a bound crossing the real store refuses would let a test prove the
   * Feedback Loop can do something it cannot — which is worse than no fixture.
   */
  setRiskThreshold(name: string, value: number): void {
    assertThresholdWithinBounds(name, value, 'InMemoryTuningStore.setRiskThreshold');
    this.thresholds[name] = value;
  }

  /** First-write-wins, mirroring `SqliteTuningStore.seedRiskThreshold` (#433). */
  seedRiskThreshold(name: string, value: number): boolean {
    assertThresholdWithinBounds(name, value, 'InMemoryTuningStore.seedRiskThreshold');
    if (this.thresholds[name] !== undefined) {
      return false;
    }
    this.thresholds[name] = value;
    return true;
  }
}

export class InMemoryAdjustmentLog implements AdjustmentLog {
  private readonly entries: Adjustment[] = [];

  append(entry: Adjustment): void {
    this.entries.push(entry);
  }

  /** Append-only: the log is read back in write order, never edited. */
  getEntries(): readonly Adjustment[] {
    return this.entries;
  }
}

/**
 * In-memory arm-comparison samples (#971) — the offline/backtest pair for
 * `SqliteArmComparisonSampleStore`, same relationship every other store on this
 * file has to its SQLite twin.
 */
export class InMemoryArmComparisonSampleStore implements ArmComparisonSampleStore {
  private readonly samples: ArmComparisonSample[] = [];

  append(sample: ArmComparisonSample): void {
    this.samples.push(sample);
  }

  /**
   * Most-recently-computed first, `asOf`-bounded — the SQLite store's contract.
   * Substitutable with `SqliteArmComparisonSampleStore` (#1483): both return
   * the real, non-null `refused_pass_count` a fresh `ArmComparisonSample`
   * carries, since the SQLite store only reads NULL back for a row `append`
   * itself never wrote — never for one it did.
   */
  getRecent(limit: number, asOf: Date): PersistedArmComparisonSample[] {
    return this.samples
      .filter((sample) => sample.computed_at.getTime() <= asOf.getTime())
      .sort((a, b) => b.computed_at.getTime() - a.computed_at.getTime())
      .slice(0, limit);
  }
}

/**
 * In-memory `OutsideBenchmarkSampleStore` (#981) — the arm store's sibling.
 *
 * Rows, not cycles: with two benchmarks a `limit` of 10 is five cycles' worth,
 * matching `SqliteOutsideBenchmarkSampleStore.getRecent`'s contract exactly so
 * a caller cannot pass a test against this and fail against SQLite.
 */
export class InMemoryOutsideBenchmarkSampleStore implements OutsideBenchmarkSampleStore {
  private readonly samples: OutsideBenchmarkSample[] = [];

  append(sample: OutsideBenchmarkSample): void {
    this.samples.push(sample);
  }

  getRecent(limit: number, asOf: Date): OutsideBenchmarkSample[] {
    return this.samples
      .filter((sample) => sample.computed_at.getTime() <= asOf.getTime())
      .sort(
        (a, b) =>
          b.computed_at.getTime() - a.computed_at.getTime() ||
          a.performance.benchmark.localeCompare(b.performance.benchmark),
      )
      .slice(0, limit);
  }
}

/** Records posted breach alerts (#93) — a concrete trade-channel fixture, not a mock. */
export class InMemoryBreachAlertChannel implements BreachAlertChannel {
  private readonly alerts: BreachAlert[] = [];

  postBreachAlert(alert: BreachAlert): void {
    this.alerts.push(alert);
  }

  getAlerts(): readonly BreachAlert[] {
    return this.alerts;
  }
}
