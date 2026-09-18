import type { BacktestReport } from './types.js';

export interface ConfigTrialLog {
  recordTrial(config_hash: string, result: BacktestReport): void;

  distinctTrialCount(): number;

  getTrial(config_hash: string): BacktestReport | undefined;
}

export class InMemoryConfigTrialLog implements ConfigTrialLog {
  private readonly trials = new Map<string, BacktestReport>();

  recordTrial(config_hash: string, result: BacktestReport): void {
    if (config_hash.length === 0) {
      throw new Error('recordTrial: config_hash must not be empty — it is the trial identity.');
    }

    if (result.config_hash !== config_hash) {
      throw new Error(
        `recordTrial: report config_hash '${result.config_hash}' does not match the key ` +
          `'${config_hash}'. A trial logged under the wrong key corrupts N.`,
      );
    }

    this.trials.set(config_hash, result);
  }

  distinctTrialCount(): number {
    return this.trials.size;
  }

  getTrial(config_hash: string): BacktestReport | undefined {
    return this.trials.get(config_hash);
  }
}
