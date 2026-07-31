/**
 * In-memory `VerdictLogStore` for #206 — a concrete implementation of the
 * port (not a test-only mock), mirroring src/debate-engine/debate-log-store.ts's
 * `InMemoryDebateLogStore` and src/dashboard/fixture-store.ts's
 * `InMemoryQueryStore`. See docs/specs/shared-sqlite-store-spec.md
 * ("Verdict" — `verdict_log`): the real SQLite-backed store is deferred (no
 * shared store exists anywhere in the codebase yet — #193 is still open).
 */
import type { VerdictLog, VerdictLogStore } from '../shared/index.js';
import type { VerdictDecision, VerdictInput } from './types.js';

/**
 * Constructs the persisted `VerdictLog` row from a resolved `VerdictDecision`.
 * `trace_id`/`instrument` aren't reliably readable off `decision` alone
 * (`decision.order` is null on a no-go), so both are read from the
 * `VerdictInput` that produced it — the caller already has both in hand
 * around the `decide()` call. `risk_decision.order_intent` is non-null by
 * `VerdictInput`'s contract ("approved only", verdict-spec.md); `decide()`
 * itself throws on a null `order_intent` before any gate runs, so a resolved
 * `decision` implies it was present.
 */
export function buildVerdictLog(input: VerdictInput, decision: VerdictDecision): VerdictLog {
  const orderIntent = input.risk_decision.order_intent;
  if (!orderIntent) {
    throw new Error(
      'buildVerdictLog requires an approved RiskDecision with a non-null order_intent',
    );
  }
  return {
    trace_id: input.trace_id,
    idempotency_key: decision.idempotency_key,
    instrument: orderIntent.instrument,
    status: decision.status,
    no_go_reason: decision.no_go_reason,
    hitl_override: decision.approval_path !== 'automated',
    timestamp: decision.timestamp,
  };
}

export class InMemoryVerdictLogStore implements VerdictLogStore {
  private readonly rows = new Map<string, VerdictLog>();

  writeLog(entry: VerdictLog): void {
    this.rows.set(entry.trace_id, entry);
  }

  getByTraceId(trace_id: string): VerdictLog | undefined {
    return this.rows.get(trace_id);
  }
}
