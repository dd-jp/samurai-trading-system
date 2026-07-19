/**
 * In-memory implementations of the Feedback Loop's store ports (#91) —
 * concrete implementations, not test-only mocks, mirroring
 * src/trader/fixture-setup-store.ts and
 * src/debate-engine/debate-log-store.ts's `InMemoryDebateLogStore`. The real
 * SQLite-backed stores are deferred: no shared store exists anywhere in the
 * codebase yet.
 */
import type { ClosedTrade, ClosedTradeStore, TuningStore } from '../shared/types.js';
import type { Adjustment, AdjustmentLog } from './types.js';

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

  setRiskThreshold(name: string, value: number): void {
    this.thresholds[name] = value;
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
