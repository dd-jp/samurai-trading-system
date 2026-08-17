/**
 * In-memory implementations of the Feedback Loop's store ports (#91) —
 * concrete implementations, not test-only mocks, mirroring
 * server/pipeline/trader/fixture-setup-store.ts and
 * server/pipeline/debate-engine/debate-log-store.ts's `InMemoryDebateLogStore`.
 *
 * These are no longer the only implementations: `SqliteTuningStore`,
 * `SqliteClosedTradeStore` and `SqliteAdjustmentLog` sit beside this file and
 * are what production wires. These survive as the in-memory pair for tests and
 * for the offline backtest, where a database file would be pure overhead.
 */
import type { ClosedTrade, ClosedTradeStore, TuningStore } from '../../shared/index.js';
import { assertThresholdWithinBounds } from '../../shared/index.js';
import type { Adjustment, AdjustmentLog, BreachAlert, BreachAlertChannel } from './types.js';

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
