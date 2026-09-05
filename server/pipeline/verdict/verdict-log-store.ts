/**
 * `buildVerdictLog` — constructs a `VerdictLog` row from a resolved
 * `VerdictDecision`. See docs/specs/shared-sqlite-store-spec.md ("Verdict" —
 * `verdict_log`) and `./sqlite-verdict-log-store.ts`'s `SqliteVerdictLogStore`
 * (#302), the port's production implementation.
 *
 * This file previously also held `InMemoryVerdictLogStore`, the port's
 * non-SQLite reference implementation (#206) — removed in #302's review pass
 * (kimi-3-review) once dropping `getByTraceId` (#306) left it with zero
 * consumers: nothing in production ever constructed it (that gap is what
 * #302 fixed, by wiring `SqliteVerdictLogStore` instead), its `rows` map was
 * written but never read back by anything, and its own test
 * (`'a written decision...'`) only asserted `writeLog` doesn't throw — which
 * `Map.set` can't meaningfully fail at. `LoggingVerdict`'s tests now use a
 * port-shaped `{ writeLog: vi.fn() }` fake (logging-verdict.test.ts) instead
 * of a concrete class, per docs/coding-standards.md's "grep for consumers;
 * if none exist outside the file's own module, it's dead — remove it."
 */
import type { VerdictLog } from '../../shared/index.js';
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
    no_go_detail_measured_ms: decision.no_go_detail?.measured_ms ?? null,
    no_go_detail_bound_ms: decision.no_go_detail?.bound_ms ?? null,
    hitl_override: decision.approval_path !== 'automated',
    timestamp: decision.timestamp,
  };
}
