import { classifyMarkFreshness } from '../../providers/market-data-service/index.js';
import type { OrderIntent } from '../../shared/index.js';
import type { RiskDecision } from '../risk-manager/index.js';
import type {
  ApprovalOutcome,
  Verdict,
  VerdictConfig,
  VerdictDecision,
  VerdictInput,
} from './types.js';

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
  detail: VerdictDecision['no_go_detail'] = null,
  approvalPath: VerdictDecision['approval_path'] = 'automated',
  wouldRequireApproval = false,
): VerdictDecision {
  return {
    status: 'no_go',
    order: null,
    no_go_reason: reason,
    no_go_detail: detail,
    approval_path: approvalPath,
    would_require_approval: wouldRequireApproval,
    idempotency_key: idempotencyKey,
    timestamp: now,
  };
}

export function isMarketClosedFor(
  orderIntent: OrderIntent,
  config: Pick<VerdictConfig, 'allow_extended_hours'>,
  tradingCalendar: Pick<VerdictInput['tradingCalendar'], 'isOpen'>,
  now: Date,
): boolean {
  return (
    orderIntent.asset_class === 'stocks' &&
    !config.allow_extended_hours &&
    !tradingCalendar.isOpen(now) &&
    orderIntent.metadata.mandatory_flatten !== true
  );
}

export class VerdictImpl implements Verdict {
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: numbered gate sequence (1-6) with per-gate exemptions scoped by exact metadata flags (mandatory_flatten, unpriced_exit); extracting risks silently reordering a gate or widening an exemption's scope
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

    const signalAgeMs = now.getTime() - orderIntent.decided_at.getTime();
    const maxAgeMs = config.max_signal_age[orderIntent.asset_class];
    if (orderIntent.metadata.mandatory_flatten !== true && signalAgeMs > maxAgeMs) {
      return noGo('staleness', idempotencyKey, now, {
        measured_ms: signalAgeMs,
        bound_ms: maxAgeMs,
      });
    }

    if (orderIntent.metadata.unpriced_exit !== true) {
      const noGoOnPrice = await this.#priceGates(orderIntent, marketData, config, clock, now);
      if (noGoOnPrice !== null) return noGoOnPrice;
    }

    const alreadyActed = await positionStore.findByKey(idempotencyKey);
    if (alreadyActed) {
      return noGo('dedup', idempotencyKey, now);
    }

    if (isMarketClosedFor(orderIntent, config, tradingCalendar, now)) {
      return noGo('market_closed', idempotencyKey, now);
    }

    const breakerTripped =
      breakers.portfolio_tripped || breakers.asset_class_tripped[orderIntent.asset_class];
    if (breakerTripped) {
      return noGo('breaker', idempotencyKey, now);
    }

    if (!shouldEngageHitl(orderIntent, risk_decision, config)) {
      return {
        status: 'go',
        order: orderIntent,
        no_go_reason: null,
        no_go_detail: null,
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
      return {
        status: 'go',
        order: orderIntent,
        no_go_reason: null,
        no_go_detail: null,
        approval_path: 'automated',
        would_require_approval: true,
        idempotency_key: idempotencyKey,
        timestamp: now,
      };
    }

    if (outcome === 'timeout') {
      return noGo('timeout', idempotencyKey, now, null, 'human_timeout', true);
    }
    if (outcome === 'rejected') {
      return noGo('human_rejected', idempotencyKey, now, null, 'human', true);
    }

    return {
      status: 'go',
      order: orderIntent,
      no_go_reason: null,
      no_go_detail: null,
      approval_path: 'human',
      would_require_approval: true,
      idempotency_key: idempotencyKey,
      timestamp: now,
    };
  }

  async #priceGates(
    orderIntent: OrderIntent,
    marketData: VerdictInput['marketData'],
    config: VerdictConfig,
    clock: VerdictInput['clock'],
    now: Date,
  ): Promise<VerdictDecision | null> {
    const idempotencyKey = orderIntent.idempotency_key;
    const mark = await marketData.getMark(orderIntent.instrument, now);
    const readAt = clock.now();

    const boundMs = config.max_mark_age[orderIntent.asset_class];
    const freshness = classifyMarkFreshness(mark, readAt, boundMs);
    if (freshness.status !== 'fresh') {
      return noGo('stale_feed', idempotencyKey, now, {
        measured_ms: freshness.age_ms,
        bound_ms: freshness.status === 'stale' ? freshness.bound_ms : freshness.tolerance_ms,
      });
    }

    if (!(orderIntent.entry > 0)) {
      return noGo('drift', idempotencyKey, now);
    }
    const drift = Math.abs(mark.price - orderIntent.entry);
    const driftTolerance = orderIntent.entry * config.drift_tolerance_pct[orderIntent.asset_class];
    if (drift > driftTolerance) {
      return noGo('drift', idempotencyKey, now);
    }

    return null;
  }
}

export type { VerdictConfig, VerdictDecision, VerdictInput } from './types.js';
