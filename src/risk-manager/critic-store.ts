import type { RiskCriticLog, RiskCriticStore } from './types.js';

export class InMemoryRiskCriticStore implements RiskCriticStore {
  private readonly rows = new Map<string, RiskCriticLog>();

  writeVerdict(entry: RiskCriticLog): void {
    this.rows.set(entry.debate_id, entry);
  }

  getByDebateId(debate_id: string): RiskCriticLog | undefined {
    return this.rows.get(debate_id);
  }
}
