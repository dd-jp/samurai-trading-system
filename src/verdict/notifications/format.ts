/**
 * Pure message formatting for the trade channel (ticket #81). See
 * docs/specs/verdict-spec.md ("Module: Human-in-the-Loop" — "Context shown").
 * No formatting decisions here read live state; given the same decision +
 * risk decision the message text is always the same.
 */
import type { RiskDecision } from '../../risk-manager/index.js';
import type { ApprovalRequest, VerdictDecision } from '../types.js';

function orderContextLines(riskDecision: RiskDecision): string[] {
  const order = riskDecision.order_intent;
  if (!order) return [];
  return [
    `Instrument: ${order.instrument} (${order.asset_class})`,
    `Side: ${order.side} ${order.intent_type}`,
    `Size: ${order.size}`,
    `Entry: ${order.entry} | Stop: ${order.stop} | Target: ${order.target}`,
    `Conviction: ${order.metadata.conviction} | Converged: ${order.metadata.converged}`,
    `Cosine precedent: neighbors=${order.metadata.cosine_precedent.neighbor_count}, ` +
      `weighted_mean_r=${order.metadata.cosine_precedent.weighted_mean_r ?? 'n/a'}, ` +
      `no_precedent=${order.metadata.cosine_precedent.no_precedent}`,
    `Risk snapshot: drawdown_pct=${riskDecision.risk_snapshot.drawdown_pct}, ` +
      `armed_breakers=${riskDecision.risk_snapshot.armed_breakers.join(', ') || 'none'}`,
  ];
}

/** Formats the final go/no-go result for the trade channel (verdict-spec story 14). */
export function formatDecisionMessage(
  decision: VerdictDecision,
  riskDecision: RiskDecision,
): string {
  const headline =
    decision.status === 'go' ? 'GO' : `NO-GO (${decision.no_go_reason ?? 'unknown'})`;
  const lines = [
    `Verdict: ${headline}`,
    `Approval path: ${decision.approval_path}`,
    ...orderContextLines(riskDecision),
    `Idempotency key: ${decision.idempotency_key}`,
  ];
  return lines.join('\n');
}

/** Formats a HITL approval request for the trade channel (verdict-spec story 12). */
export function formatApprovalRequest(request: ApprovalRequest): string {
  const lines = [
    'Approval requested',
    ...orderContextLines(request.risk_decision),
    `Timeout: ${request.timeout_ms}ms`,
  ];
  return lines.join('\n');
}
