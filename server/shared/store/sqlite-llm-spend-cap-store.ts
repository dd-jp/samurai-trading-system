import type { StoreHandle } from './open-shared-store.js';
import { toStoredTimestamp } from './sqlite-utils.js';

interface LlmSpendCapRow {
  budget_usd: number | null;
  armed_at: string;
}

export interface LlmSpendCapState {
  budgetUsd: number | null;
  armedAt: string | null;
}

export class SqliteLlmSpendCapStore {
  constructor(private readonly db: StoreHandle) {}

  arm(budgetUsd: number | null, armedAt: Date): void {
    this.db
      .prepare('REPLACE INTO llm_spend_cap (id, budget_usd, armed_at) VALUES (1, ?, ?)')
      .run(budgetUsd, toStoredTimestamp(armedAt));
  }

  read(): LlmSpendCapState {
    const row = this.db
      .prepare('SELECT budget_usd, armed_at FROM llm_spend_cap WHERE id = 1')
      .get() as LlmSpendCapRow | undefined;
    if (row === undefined) return { budgetUsd: null, armedAt: null };
    const budgetUsd =
      row.budget_usd !== null && Number.isFinite(row.budget_usd) ? row.budget_usd : null;
    return { budgetUsd, armedAt: row.armed_at };
  }
}
