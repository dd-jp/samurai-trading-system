/**
 * Verdict (Stage 5) — core gate sequence (#79) plus the HITL automation
 * dial and flag-based routing (#80).
 * See docs/specs/verdict-spec.md (Module: Gate Sequence, Module:
 * Human-in-the-Loop).
 *
 * Deterministic decision gate: staleness -> stale_feed -> drift -> dedup ->
 * market-open -> breaker re-check -> HITL. First failing gate short-circuits
 * to `no_go` with its reason; a full pass (auto or human-approved) produces
 * `go`.
 *
 * The first two gates read as one word and are two different questions:
 * `staleness` bounds how old our DECISION is, `stale_feed` (#641) bounds how
 * old the PRICE is. Neither implies the other.
 *
 * HITL only engages per the per-asset-class automation dial: `manual`
 * always engages it, `auto` never does, `semi_auto` engages it only when a
 * flag is set (non-converged, no-precedent, size-over, or near-limit —
 * `risk_decision.modifications != null`).
 */
import { isMarkStale } from '../../providers/market-data-service/index.js';
import type { OrderIntent } from '../../shared/index.js';
import type { RiskDecision } from '../risk-manager/index.js';
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

/**
 * Refuses a `VerdictConfig` whose dial engages the human-in-the-loop gate
 * (#434, review on PR #455). Called from the composition root, not from
 * `VerdictImpl` — the HITL path still has tests, and they construct the
 * verdict directly.
 *
 * The gate is not merely unused, it is UNSOUND. The freshness gates
 * (staleness, stale_feed, drift) run before the approval `await` and are never
 * re-evaluated, so an
 * approval returning after `human_timeout` submits at a price last checked
 * that long ago: with `max_signal_age.crypto` at 5 minutes and a 15-minute
 * human timeout, a gate that reads as a freshness guarantee is not one.
 *
 * Documented at the call site since ADR-0007, but a comment guards nothing —
 * the dial is a config value, flipped by someone who has not read it. This
 * refuses at the moment it is actually turned, and unlike an in-branch
 * re-check it is not a guard on an unreachable path (#430): it runs on every
 * production boot.
 *
 * Both engaging levels are covered, not just `semi_auto`. `manual` reaches
 * the same `await` through the same two already-evaluated gates.
 */
export function assertAutomationLevelSupported(config: VerdictConfig): void {
  const engaging = (['crypto', 'stocks'] as const).filter(
    (assetClass) => config.automation_level[assetClass] !== 'auto',
  );
  if (engaging.length === 0) return;

  throw new Error(
    `VerdictConfig.automation_level engages the human-in-the-loop gate for ` +
      `${engaging.map((c) => `${c}='${config.automation_level[c]}'`).join(', ')}, ` +
      'but that gate is unsound: the staleness and drift gates run BEFORE the approval ' +
      'await and are never re-checked, so an approval returning after human_timeout ' +
      'submits at a price older than max_signal_age allows. ADR-0007 set this dial to ' +
      "'auto' and recommends async approval (Verdict returns pending, a poller resumes " +
      'it) rather than re-running the two gates — which also removes the human from the ' +
      'instrument pass, the actual reason the gate was dropped. Land that first (#434).',
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

    // Gate 2: drift — current price vs the bracket's entry, as a FRACTION of
    // that entry (#381). Absolute price distance cannot be set correctly for
    // more than one instrument at a time; see `VerdictConfig.drift_tolerance_pct`.
    //
    // Fails closed on a non-positive entry: `entry * pct` would be zero or
    // negative there, which would either reject everything or — worse, for a
    // negative entry — invert the comparison into a gate that passes on
    // unbounded drift. A bracket with no positive entry price is not a bracket
    // this gate can reason about, so it is refused rather than waved through.
    const mark = await marketData.getMark(orderIntent.instrument, now);

    // Gate 2a: FEED staleness (#641) — how long ago the market last spoke,
    // measured off `Mark.observed_at`.
    //
    // Ordered BEFORE the drift gate, and on the same `mark` that gate reads
    // rather than a second fetch. A stale mark does not merely weaken the
    // drift comparison, it breaks it in both directions: a price frozen at the
    // bracket's entry passes a gate that is supposed to be measuring live
    // movement, and one frozen far from it fires a `drift` no-go that names
    // the wrong cause. Running this first means a `drift` verdict always
    // refers to real movement, and a dead feed is reported as a dead feed.
    //
    // Distinct from gate 1: that bounds how old our DECISION is, this bounds
    // how old the PRICE is. Both must hold — see `VerdictConfig.max_mark_age`.
    if (isMarkStale(mark, now, config.max_mark_age[orderIntent.asset_class])) {
      return noGo('stale_feed', idempotencyKey, now);
    }

    if (!(orderIntent.entry > 0)) {
      return noGo('drift', idempotencyKey, now);
    }
    const drift = Math.abs(mark.price - orderIntent.entry);
    const driftTolerance = orderIntent.entry * config.drift_tolerance_pct[orderIntent.asset_class];
    if (drift > driftTolerance) {
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

    // KNOWN HAZARD IF THE DIAL IS EVER TURNED BACK (#434, ADR-0007).
    //
    // The freshness gates (staleness, stale_feed, drift) ran ABOVE, and
    // nothing re-evaluates
    // them after this await returns. So an approved trade submits at a price
    // last checked `human_timeout` ago: with `max_signal_age.crypto` at 5
    // minutes and `human_timeout` at 15, a 15-minute-old approval sails past a
    // 5-minute staleness bound, because the gate that bounds staleness has
    // already run. Gate 1 reads as a freshness guarantee here and is not one.
    //
    // NOT guarded now, deliberately. `automation_level` is `auto`, this branch
    // is unreachable, and adding a check to an unreachable path is the exact
    // dead-mechanism pattern #430 exists to stop — it would be a guard nothing
    // exercises, aging next to the code it claims to protect.
    //
    // The right fix is not a re-check anyway: ADR-0007 recommends ASYNC
    // approval — Verdict returns `pending`, the intent persists, a poller
    // resumes it — which removes the human from the instrument pass entirely.
    // That was the actual reason the gate was dropped: `max_concurrent_
    // instruments: 1` plus an in-pass `await` means one pending tap blocks the
    // whole universe. Any real `semi_auto` needs that, not two re-run gates.
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
export { DiscordChannel } from './notifications/discord-channel.js';
export { formatApprovalRequest, formatDecisionMessage } from './notifications/format.js';
export { isNotableVerdict } from './notifications/notable-verdict.js';
export { parseAllowedUserIds } from './notifications/telegram/allowlist.js';
export type {
  CorrelationTarget,
  CorrelationTokenPair,
} from './notifications/telegram/correlation-tokens.js';
export {
  CorrelationTokenStore,
  tokenLogPrefix,
} from './notifications/telegram/correlation-tokens.js';
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
export { NotifyingVerdict } from './notifying-verdict.js';
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
