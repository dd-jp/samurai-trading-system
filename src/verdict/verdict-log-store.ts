/**
 * In-memory `VerdictLogStore` for #206 — the port's non-SQLite reference
 * implementation, mirroring src/debate-engine/debate-log-store.ts's
 * `InMemoryDebateLogStore` and src/dashboard/fixture-store.ts's
 * `InMemoryQueryStore`. See docs/specs/shared-sqlite-store-spec.md
 * ("Verdict" — `verdict_log`). The real SQLite-backed store is
 * `./sqlite-verdict-log-store.ts`'s `SqliteVerdictLogStore` (#302) — the
 * shared store (#193) has existed since before this class's #206 doc
 * comment last said otherwise; nothing in production actually constructed
 * either implementation until #302 wired `SqliteVerdictLogStore` into
 * `direct-bind.ts`'s `buildVerdictStep`.
 *
 * Its `rows` map is written but, as of #302, never read back anywhere in
 * this codebase (its own test only asserts `writeLog` doesn't throw, and
 * `LoggingVerdict`'s tests now use a port-shaped `{ writeLog: vi.fn() }`
 * fake instead — see logging-verdict.test.ts). It stays because it encodes
 * the table's real semantics (one row per `trace_id`, last write wins,
 * `VerdictLogStore`-shaped) more precisely than a bare spy would, for
 * whichever future test or non-SQLite composition root wants that. If that
 * need never materializes, this class — not just its `getByTraceId` — is
 * the next thing to cut.
 *
 * No `getByTraceId` (#306): the port doesn't declare one (see its doc
 * comment in shared/types.ts for why), and grepping this class's only
 * non-test construction sites found none — every caller that reads
 * `verdict_log` back does so with raw SQL against `SharedStore`
 * (`OrphanVerdictScanner`, the Dashboard's `SqliteQueryStore`), not through
 * this port-typed store. A prior version of this class had a `getByTraceId`
 * that only its own tests ever called; dropping it removes implementation
 * surface the port never promised and no production code depended on.
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
}
