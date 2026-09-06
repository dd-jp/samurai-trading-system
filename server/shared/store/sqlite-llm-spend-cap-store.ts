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
  armed_at: string;
}

/**
 * What `read()` hands back: the ceiling (or `null` for uncapped) alongside
 * `armed_at`, which is the only thing that tells a caller "armed uncapped"
 * apart from "never armed" — both have `budgetUsd: null`, but only the first
 * has a non-null `armedAt` (#1196).
 */
export interface LlmSpendCapState {
  budgetUsd: number | null;
  /** `armed_at`, verbatim off the row — already a `toStoredTimestamp` string. `null` iff no row exists. */
  armedAt: string | null;
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
   * The armed ceiling plus `armed_at` — armed uncapped and never armed at all
   * DO differ in consequence (that is this ticket, #1196), and `armed_at` is
   * the field that carries the difference: present with `budgetUsd: null`
   * means "armed, deliberately uncapped"; `null` means no row was ever
   * written, i.e. nothing may be enforcing anything.
   *
   * Honest limit (review round 2, MINOR 2): a corrupt REAL column nullified
   * below alongside an INTACT `armed_at` is indistinguishable on the wire
   * from a genuine "armed, deliberately uncapped" row — `budgetUsd: null` +
   * a real `armedAt` means both. `arm()` is the only writer and is typed
   * `number | null` (never a non-finite value), and both `production.ts`
   * call sites pass a finite literal or `null`, so this is a DB-corruption
   * tail with no live write path — not defended against beyond this note.
   */
  read(): LlmSpendCapState {
    const row = this.db
      .prepare('SELECT budget_usd, armed_at FROM llm_spend_cap WHERE id = 1')
      .get() as LlmSpendCapRow | undefined;
    if (row === undefined) return { budgetUsd: null, armedAt: null };
    // A non-finite REAL divides into a meter that renders as `Infinity%`.
    const budgetUsd =
      row.budget_usd !== null && Number.isFinite(row.budget_usd) ? row.budget_usd : null;
    return { budgetUsd, armedAt: row.armed_at };
  }
}
