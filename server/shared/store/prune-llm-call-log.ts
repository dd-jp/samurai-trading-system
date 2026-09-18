import type { StoreHandle } from './open-shared-store.js';

export const DEFAULT_MAX_LLM_CALL_ROWS = 5_000;

export function pruneLlmCallLog(db: StoreHandle, maxRows: number): number {
  return db
    .prepare(
      `DELETE FROM llm_call_log
        WHERE id <= (SELECT id FROM llm_call_log ORDER BY id DESC LIMIT 1 OFFSET ?)`,
    )
    .run(maxRows).changes;
}
