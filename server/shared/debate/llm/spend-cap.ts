import type { Logger } from '../../index.js';
import { currentTraceId, describeThrownSafely } from '../../index.js';
import type { StoreHandle } from '../../store/index.js';

export type SpendCapRefusalKind = 'budget' | 'corrupt_ledger' | 'read_fault';

export type SpendCapVerdict =
  | {
      admitted: true;
      spent_usd: number;
      budget_usd: number;
    }
  | {
      admitted: false;
      spent_usd: number;
      budget_usd: number;
      reason?: string;
      kind: SpendCapRefusalKind;
    };

export const BUDGET_REMEDY =
  'THIS DOES NOT RESOLVE ITSELF: the budget does not refill with time, so every ' +
  'subsequent check will refuse identically until an operator raises the cap or starts ' +
  'the run from a fresh store — a restart alone does not reset it, because the window ' +
  'is the whole llm_spend table (ADR-0008).';

export const READ_FAULT_REMEDY =
  'THIS IS A SPEND-LEDGER READ FAULT, NOT A SPENT BUDGET: llm_spend could not be ' +
  'queried — see llm_spend_cap_read_failed for what threw. If the cause was transient ' +
  '(a lock, a momentary I/O hiccup) the next check recovers on its own; if it persists, ' +
  'an operator needs to fix the underlying fault. Unlike a budget refusal, do not assume ' +
  'every subsequent check will refuse identically — and do not assume it clears, either.';

export const CORRUPT_LEDGER_REMEDY =
  'THIS IS A CORRUPT SPEND LEDGER, NOT A SPENT BUDGET: llm_spend.cost_usd summed to a ' +
  'non-finite number, which means at least one row is bad. This does not clear on its ' +
  'own — an operator needs to find and repair the row before the cap can enforce ' +
  'correctly again.';

export function spendCapRefusalRemedy(kind: SpendCapRefusalKind): string {
  switch (kind) {
    case 'budget':
      return BUDGET_REMEDY;
    case 'read_fault':
      return READ_FAULT_REMEDY;
    case 'corrupt_ledger':
      return CORRUPT_LEDGER_REMEDY;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

export interface SpendCap {
  check(instrument?: string): SpendCapVerdict;
}

export const UNCAPPED_SPEND: SpendCap = {
  check: () => ({ admitted: true, spent_usd: 0, budget_usd: Number.POSITIVE_INFINITY }),
};

export class SqliteSpendCap implements SpendCap {
  #budgetAnnounced = false;
  #faultAnnounced = false;

  constructor(
    private readonly db: StoreHandle,
    private readonly budgetUsd: number,
    private readonly logger?: Logger,
    private readonly onBreach?: (verdict: Extract<SpendCapVerdict, { admitted: false }>) => void,
  ) {
    if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
      throw new Error(
        `SqliteSpendCap: budget must be a positive, finite number of USD (got ${budgetUsd}). ` +
          'A zero or negative ceiling would refuse every debate and read as a dead pipeline; ' +
          'omit the cap entirely (UNCAPPED_SPEND) if that is what is wanted.',
      );
    }
  }

  startingTotal(): SpendCapVerdict {
    return this.check();
  }

  check(): SpendCapVerdict {
    let spent: number;
    try {
      const row = this.db
        .prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM llm_spend')
        .get() as { total: number } | undefined;
      spent = row?.total ?? 0;
    } catch (error) {
      const message = describeThrownSafely(error);
      this.logger?.log({
        trace_id: currentTraceId() ?? 'spend-cap',
        stage: 'debate',
        event: 'llm_spend_cap_read_failed',
        level: 'error',
        message:
          'LLM spend cap could not read llm_spend and is REFUSING new debates (fail-closed). ' +
          `No trade will be taken until this is fixed: ${message}`,
        payload: { budget_usd: this.budgetUsd },
      });
      return this.#refuse('read_fault', {
        spent_usd: Number.NaN,
        budget_usd: this.budgetUsd,
        reason: 'spend cap unreadable (fail-closed)',
      });
    }

    if (!Number.isFinite(spent)) {
      return this.#refuse('corrupt_ledger', {
        spent_usd: spent,
        budget_usd: this.budgetUsd,
        reason: 'llm_spend total is not a finite number (fail-closed)',
      });
    }

    if (spent >= this.budgetUsd) {
      return this.#refuse('budget', {
        spent_usd: spent,
        budget_usd: this.budgetUsd,
        reason: `LLM spend cap reached: $${spent.toFixed(2)} of $${this.budgetUsd.toFixed(2)} spent`,
      });
    }

    return { admitted: true, spent_usd: spent, budget_usd: this.budgetUsd };
  }

  #refuse(
    kind: SpendCapRefusalKind,
    details: { spent_usd: number; budget_usd: number; reason?: string },
  ): SpendCapVerdict {
    const refused: SpendCapVerdict = { admitted: false, ...details, kind };

    if (kind === 'budget') {
      if (this.#budgetAnnounced) return refused;
      this.#budgetAnnounced = true;
    } else {
      if (this.#faultAnnounced) return refused;
      this.#faultAnnounced = true;
    }

    try {
      this.onBreach?.(refused);
    } catch (error) {
      this.logger?.log({
        trace_id: currentTraceId() ?? 'spend-cap',
        stage: 'debate',
        event: 'llm_spend_cap_alert_send_failed',
        level: 'warn',
        message:
          'LLM spend cap breached, and the breach alert channel threw — the refusal stands, ' +
          `but nothing reached an operator: ${describeThrownSafely(error)}`,
        payload: { budget_usd: refused.budget_usd, spent_usd: refused.spent_usd },
      });
    }

    return refused;
  }
}
