import type { TuningStore } from '../../shared/index.js';
import { assertThresholdWithinBounds } from '../../shared/index.js';
import type { OutsideBenchmarkSample } from '../outside-benchmark/index.js';
import type {
  ArmComparisonSample,
  ArmComparisonSampleStore,
  BreachAlert,
  BreachAlertChannel,
  OutsideBenchmarkSampleStore,
  PersistedArmComparisonSample,
} from './types.js';

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

  getAnalystWeights(): Record<string, number> {
    return { ...this.weights };
  }

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

  setRiskThreshold(name: string, value: number): void {
    assertThresholdWithinBounds(name, value, 'InMemoryTuningStore.setRiskThreshold');
    this.thresholds[name] = value;
  }

  seedRiskThreshold(name: string, value: number): boolean {
    assertThresholdWithinBounds(name, value, 'InMemoryTuningStore.seedRiskThreshold');
    if (this.thresholds[name] !== undefined) {
      return false;
    }
    this.thresholds[name] = value;
    return true;
  }
}

export class InMemoryArmComparisonSampleStore implements ArmComparisonSampleStore {
  private readonly samples: ArmComparisonSample[] = [];

  append(sample: ArmComparisonSample): void {
    this.samples.push(sample);
  }

  getRecent(limit: number, asOf: Date): PersistedArmComparisonSample[] {
    return this.samples
      .filter((sample) => sample.computed_at.getTime() <= asOf.getTime())
      .sort((a, b) => b.computed_at.getTime() - a.computed_at.getTime())
      .slice(0, limit);
  }
}

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

export class InMemoryBreachAlertChannel implements BreachAlertChannel {
  private readonly alerts: BreachAlert[] = [];

  postBreachAlert(alert: BreachAlert): void {
    this.alerts.push(alert);
  }

  getAlerts(): readonly BreachAlert[] {
    return this.alerts;
  }
}
