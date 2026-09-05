/**
 * The ceiling ADR-0008's spend cap is enforcing, published for readers
 * (#1140, migration `0047`).
 *
 * `SqliteSpendCap` polices `llm_spend` against `ProductionConfig.llmBudgetUsd`
 * inside the orchestrator process. The dashboard runs in a SECOND process and
 * cannot see that config object, so before this the client drew its meter
 * against its own `LLM_SPEND_CAP_USD = 50` — a number linked to the enforced
 * one by nothing, on a surface ADR-0008 says the budget will move on ("can
 * increase for live trading").
 *
 * This is the seam that removes the second copy: the composition root arms the
 * cap and records the SAME value here, in the same `if/else` that constructs
 * the enforcer, so the wire and the enforcer can only disagree if someone
 * edits two lines three lines apart.
 *
 * Lives in `shared/store` rather than under either app because both read it —
 * the orchestrator writes, the dashboard reads. The WRITE is still the
 * orchestrator's: `production.ts` passes a handle guarded as `'orchestrator'`,
 * which is what `llm_spend_cap`'s entry in `STAGE_OWNED_TABLES` declares.
 */

import type { SharedStore } from './open-shared-store.js';
import { toStoredTimestamp } from './sqlite-utils.js';

interface LlmSpendCapRow {
  budget_usd: number | null;
}

export class SqliteLlmSpendCapStore {
  constructor(private readonly db: SharedStore) {}

  /**
   * Records the ceiling this process is enforcing, replacing whatever the
   * previous run left: a run started with a raised budget that inherited its
   * predecessor's $50 would report a breach the enforcer is not enforcing.
   * `null` is a recordable state, not a missing write — see the header.
   */
  arm(budgetUsd: number | null, armedAt: Date): void {
    this.db
      .prepare('REPLACE INTO llm_spend_cap (id, budget_usd, armed_at) VALUES (1, ?, ?)')
      .run(budgetUsd, toStoredTimestamp(armedAt));
  }

  /**
   * The armed ceiling, or `null` when nothing bounds the spend — armed
   * uncapped and never armed at all differ in cause, not in consequence.
   */
  read(): number | null {
    const row = this.db.prepare('SELECT budget_usd FROM llm_spend_cap WHERE id = 1').get() as
      | LlmSpendCapRow
      | undefined;
    const budget = row?.budget_usd ?? null;
    // A non-finite REAL divides into a meter that renders as `Infinity%`.
    return budget !== null && Number.isFinite(budget) ? budget : null;
  }
}
