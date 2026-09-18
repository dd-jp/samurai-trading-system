import type { VerdictLog } from '../../shared/index.js';
import type { VerdictDecision, VerdictInput } from './types.js';

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
