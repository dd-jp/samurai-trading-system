/**
 * #1196: `read()` must let a caller tell "armed uncapped" (a row exists,
 * `budget_usd IS NULL`) apart from "never armed" (no row at all) — the
 * discrimination `arm()` already persists via `armed_at` and `read()` used to
 * throw away
 */
import { describe, expect, it } from 'vitest';
import { openSharedStore, type StoreHandle } from './open-shared-store.js';
import { SqliteLlmSpendCapStore } from './sqlite-llm-spend-cap-store.js';
import { toStoredTimestamp } from './sqlite-utils.js';

const ARMED_AT = new Date('2026-08-05T14:00:00Z');

function makeDb(): StoreHandle {
  return openSharedStore(':memory:');
}

describe('SqliteLlmSpendCapStore.read', () => {
  it('reports never-armed when no row has ever been written', () => {
    const state = new SqliteLlmSpendCapStore(makeDb()).read();
    expect(state).toEqual({ budgetUsd: null, armedAt: null });
  });

  it('distinguishes armed-uncapped from never-armed: both carry a null budget, only one carries armed_at', () => {
    const db = makeDb();
    new SqliteLlmSpendCapStore(db).arm(null, ARMED_AT);

    const state = new SqliteLlmSpendCapStore(db).read();
    expect(state.budgetUsd).toBeNull();
    expect(state.armedAt).not.toBeNull();
  });

  it('reports the armed dollar ceiling', () => {
    const db = makeDb();
    new SqliteLlmSpendCapStore(db).arm(275, ARMED_AT);

    expect(new SqliteLlmSpendCapStore(db).read().budgetUsd).toBe(275);
  });

  // The additional defect this ticket also closes: a $0 cap is the MOST
  // restrictive state possible and must not collapse into "uncapped" or
  // "never armed"
  it('reports an armed $0 cap as 0, not null', () => {
    const db = makeDb();
    new SqliteLlmSpendCapStore(db).arm(0, ARMED_AT);

    const state = new SqliteLlmSpendCapStore(db).read();
    expect(state.budgetUsd).toBe(0);
    expect(state.armedAt).not.toBeNull();
  });

  it('round-trips armed_at through the exact toStoredTimestamp format written at arm time', () => {
    const db = makeDb();
    new SqliteLlmSpendCapStore(db).arm(50, ARMED_AT);

    expect(new SqliteLlmSpendCapStore(db).read().armedAt).toBe(toStoredTimestamp(ARMED_AT));
  });

  it('a later arm() replaces the previous row, including its armed_at', () => {
    const db = makeDb();
    const store = new SqliteLlmSpendCapStore(db);
    store.arm(50, new Date('2026-08-01T00:00:00Z'));
    store.arm(275, ARMED_AT);

    const state = store.read();
    expect(state.budgetUsd).toBe(275);
    expect(state.armedAt).toBe(toStoredTimestamp(ARMED_AT));
  });

  it('treats a non-finite stored budget as uncapped rather than rendering Infinity%, without losing armed_at', () => {
    const db = makeDb();
    // Bypasses `arm()`'s typed signature to simulate a REAL column value
    // `arm()` would never write today, matching the existing defensive read
    db.prepare('REPLACE INTO llm_spend_cap (id, budget_usd, armed_at) VALUES (1, ?, ?)').run(
      Number.POSITIVE_INFINITY,
      toStoredTimestamp(ARMED_AT),
    );

    const state = new SqliteLlmSpendCapStore(db).read();
    expect(state.budgetUsd).toBeNull();
    expect(state.armedAt).toBe(toStoredTimestamp(ARMED_AT));
  });
});
