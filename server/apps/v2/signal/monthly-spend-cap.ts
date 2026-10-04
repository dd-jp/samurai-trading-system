import type { SpendCap, SpendCapVerdict } from '../../../shared/debate/index.js';
import type { Clock, Logger } from '../../../shared/index.js';
import { describeThrownSafely } from '../../../shared/index.js';
import type { StoreHandle } from '../../../shared/store/index.js';
import { toStoredTimestamp } from '../../../shared/store/index.js';

export const LLM_MONTHLY_BUDGET_USD = 30;

export function utcMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export class SqliteMonthlySpendCap implements SpendCap {
  constructor(
    private readonly db: StoreHandle,
    private readonly clock: Clock,
    private readonly budgetUsd: number = LLM_MONTHLY_BUDGET_USD,
    private readonly logger?: Logger,
  ) {
    if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
      throw new Error(
        `SqliteMonthlySpendCap: budget must be positive and finite (got ${budgetUsd})`,
      );
    }
  }

  check(): SpendCapVerdict {
    const since = toStoredTimestamp(utcMonthStart(this.clock.now()));
    let spent: number;
    try {
      const row = this.db
        .prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM llm_spend WHERE timestamp >= ?')
        .get(since) as { total: number };
      spent = row.total;
    } catch (error) {
      this.logger?.log({
        trace_id: 'v2-spend-cap',
        stage: 'v2',
        level: 'error',
        event: 'v2_llm_spend_cap_read_failed',
        message: `monthly LLM spend cap cannot read llm_spend; refusing: ${describeThrownSafely(error)}`,
        payload: { budget_usd: this.budgetUsd, since },
      });
      return {
        admitted: false,
        spent_usd: Number.NaN,
        budget_usd: this.budgetUsd,
        kind: 'read_fault',
        reason: 'monthly spend cap unreadable (fail-closed)',
      };
    }
    if (!Number.isFinite(spent)) {
      return {
        admitted: false,
        spent_usd: spent,
        budget_usd: this.budgetUsd,
        kind: 'corrupt_ledger',
        reason: 'llm_spend month total is not finite (fail-closed)',
      };
    }
    if (spent >= this.budgetUsd) {
      return {
        admitted: false,
        spent_usd: spent,
        budget_usd: this.budgetUsd,
        kind: 'budget',
        reason: `monthly LLM cap reached: $${spent.toFixed(2)} of $${this.budgetUsd.toFixed(2)} since ${since}`,
      };
    }
    return { admitted: true, spent_usd: spent, budget_usd: this.budgetUsd };
  }
}
