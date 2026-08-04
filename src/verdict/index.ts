/**
 * Verdict (Stage 5) — core gate sequence (#79) plus the HITL automation
 * dial and flag-based routing (#80).
 * See docs/specs/verdict-spec.md (Module: Gate Sequence, Module:
 * Human-in-the-Loop).
 *
 * Deterministic decision gate: staleness -> drift -> dedup -> market-open ->
 * breaker re-check -> HITL. First failing gate short-circuits to `no_go`
 * with its reason; a full pass (auto or human-approved) produces `go`.
 *
 * HITL only engages per the per-asset-class automation dial: `manual`
 * always engages it, `auto` never does, `semi_auto` engages it only when a
 * flag is set (non-converged, no-precedent, size-over, or near-limit —
 * `risk_decision.modifications != null`).
 */
import type { RiskDecision } from '../risk-manager/index.js';
import type { OrderIntent } from '../shared/index.js';
import type {
  ApprovalOutcome,
  Verdict,
  VerdictConfig,
  VerdictDecision,
  VerdictInput,
} from './types.js';

/** True if any semi_auto flag is set (verdict-spec.md "Module: Human-in-the-Loop"). */
function isFlagged(
  orderIntent: OrderIntent,
  riskDecision: RiskDecision,
  flagThresholds: VerdictConfig['flag_thresholds'],
): boolean {
  return (
    orderIntent.metadata.converged === false ||
    orderIntent.metadata.cosine_precedent.no_precedent ||
    orderIntent.size > flagThresholds.size_over ||
    riskDecision.modifications != null
  );
}

/** Whether the HITL gate engages, per the per-asset-class automation dial. */
function shouldEngageHitl(
  orderIntent: OrderIntent,
  riskDecision: RiskDecision,
  config: VerdictConfig,
): boolean {
  const level = config.automation_level[orderIntent.asset_class];
  if (level === 'manual') return true;
  if (level === 'auto') return false;
  return isFlagged(orderIntent, riskDecision, config.flag_thresholds);
}

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

    // Gate 6: HITL — engaged per the automation dial + flags, else automated go.
    if (!shouldEngageHitl(orderIntent, risk_decision, config)) {
      return {
        status: 'go',
        order: orderIntent,
        no_go_reason: null,
        approval_path: 'automated',
        would_require_approval: false,
        idempotency_key: idempotencyKey,
        timestamp: now,
      };
    }

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

export { LoggingVerdict } from './logging-verdict.js';
export type { ApprovalCallbackPayload } from './notifications/approval-callback-verifier.js';
export {
  signApprovalCallback,
  verifyApprovalCallback,
} from './notifications/approval-callback-verifier.js';
export { TradeChannel } from './notifications/composite-channel.js';
export { DiscordChannel } from './notifications/discord-channel.js';
export { formatApprovalRequest, formatDecisionMessage } from './notifications/format.js';
export { parseAllowedUserIds } from './notifications/telegram/allowlist.js';
export type {
  CorrelationTarget,
  CorrelationTokenPair,
} from './notifications/telegram/correlation-tokens.js';
export {
  CorrelationTokenStore,
  tokenLogPrefix,
} from './notifications/telegram/correlation-tokens.js';
export type { TelegramApprovalGatewayOptions } from './notifications/telegram/telegram-approval-gateway.js';
export { TelegramApprovalGateway } from './notifications/telegram/telegram-approval-gateway.js';
export type {
  CallbackAuditLog,
  TelegramBotApiClientOptions,
} from './notifications/telegram/telegram-bot-api-client.js';
export { TelegramBotApiClient } from './notifications/telegram/telegram-bot-api-client.js';
export type { TelegramError } from './notifications/telegram/telegram-errors.js';
export {
  isRetryableTelegramError,
  TelegramProviderError,
  TelegramRateLimitError,
  TelegramTimeoutError,
} from './notifications/telegram/telegram-errors.js';
export { TelegramChannel } from './notifications/telegram-channel.js';
export type {
  ApprovalButtonTarget,
  ApprovalCallback,
  DiscordClient,
  TelegramClient,
  TradeChannelNotifier,
} from './notifications/types.js';
export type { ApprovalRequestSender } from './notifications/verified-approval-channel.js';
export { SignedApprovalChannel } from './notifications/verified-approval-channel.js';
export { SqliteVerdictLogStore } from './sqlite-verdict-log-store.js';
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
