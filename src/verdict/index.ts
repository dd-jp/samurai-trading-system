/**
 * Verdict (Stage 5) — core gate sequence (ticket #79).
 * See docs/specs/verdict-spec.md (Module: Gate Sequence).
 *
 * Deterministic decision gate: staleness -> drift -> dedup -> market-open ->
 * breaker re-check -> HITL. First failing gate short-circuits to `no_go`
 * with its reason; a full pass (auto or human-approved) produces `go`.
 *
 * The HITL automation dial (manual/semi_auto/auto per asset class) and its
 * flag-based routing are #80 — here the gate always engages once reached;
 * `would_require_approval` is simply recorded `true` whenever it does.
 */
import type { ApprovalOutcome, Verdict, VerdictDecision, VerdictInput } from './types.js';

function noGo(
  reason: NonNullable<VerdictDecision['no_go_reason']>,
  idempotencyKey: string,
  now: Date,
  approvalPath: VerdictDecision['approval_path'] = 'automated',
  wouldRequireApproval = false,
): VerdictDecision {
  return {
    status: 'no_go',
    order: null,
    no_go_reason: reason,
    approval_path: approvalPath,
    would_require_approval: wouldRequireApproval,
    idempotency_key: idempotencyKey,
    timestamp: now,
  };
}

export class VerdictImpl implements Verdict {
  async decide(input: VerdictInput): Promise<VerdictDecision> {
    const {
      risk_decision,
      clock,
      marketData,
      tradingCalendar,
      positionStore,
      breakers,
      config,
      mode,
      approvals,
    } = input;

    const orderIntent = risk_decision.order_intent;
    if (!orderIntent) {
      throw new Error(
        'Verdict.decide requires an approved RiskDecision with a non-null order_intent',
      );
    }

    const idempotencyKey = orderIntent.idempotency_key;
    const now = clock.now();

    // Gate 1: staleness — signal age vs the per-asset-class bound.
    const signalAgeMs = now.getTime() - orderIntent.decision_timestamp.getTime();
    const maxAgeMs = config.max_signal_age[orderIntent.asset_class];
    if (signalAgeMs > maxAgeMs) {
      return noGo('staleness', idempotencyKey, now);
    }

    // Gate 2: drift — current price vs the bracket's entry.
    const mark = await marketData.getMark(orderIntent.instrument, now);
    const drift = Math.abs(mark.price - orderIntent.entry);
    if (drift > config.drift_tolerance) {
      return noGo('drift', idempotencyKey, now);
    }

    // Gate 3: idempotency dedup — existing order/fill for this key.
    const alreadyActed = await positionStore.findByKey(idempotencyKey);
    if (alreadyActed) {
      return noGo('dedup', idempotencyKey, now);
    }

    // Gate 4: market-open (stocks only; crypto is 24/7 and skips).
    if (orderIntent.asset_class === 'stocks' && !config.allow_extended_hours) {
      if (!tradingCalendar.isOpen(now)) {
        return noGo('market_closed', idempotencyKey, now);
      }
    }

    // Gate 5: fire-time kill-switch / breaker re-check.
    const breakerTripped =
      breakers.portfolio_tripped || breakers.asset_class_tripped[orderIntent.asset_class];
    if (breakerTripped) {
      return noGo('breaker', idempotencyKey, now);
    }

    // Gate 6: HITL — engaged unconditionally once every automated gate has passed.
    const outcome: ApprovalOutcome = await approvals.requestApproval({
      order_intent: orderIntent,
      risk_decision,
      trace_id: input.trace_id,
      timeout_ms: config.human_timeout,
    });

    if (mode === 'backtest') {
      // Bypassed-but-recorded: the channel auto-approves, but the gate was
      // reached, so it would have required approval outside backtest.
      return {
        status: 'go',
        order: orderIntent,
        no_go_reason: null,
        approval_path: 'automated',
        would_require_approval: true,
        idempotency_key: idempotencyKey,
        timestamp: now,
      };
    }

    if (outcome === 'timeout') {
      return noGo('timeout', idempotencyKey, now, 'human_timeout', true);
    }
    if (outcome === 'rejected') {
      return noGo('human_rejected', idempotencyKey, now, 'human', true);
    }

    return {
      status: 'go',
      order: orderIntent,
      no_go_reason: null,
      approval_path: 'human',
      would_require_approval: true,
      idempotency_key: idempotencyKey,
      timestamp: now,
    };
  }
}

export type {
  ApprovalChannel,
  ApprovalOutcome,
  ApprovalRequest,
  PositionStore,
  Verdict,
  VerdictConfig,
  VerdictDecision,
  VerdictInput,
} from './types.js';
