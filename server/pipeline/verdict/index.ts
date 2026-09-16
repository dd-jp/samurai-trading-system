/**
 * Verdict (Stage 5): deterministic gate sequence — staleness -> stale_feed
 * -> drift -> dedup -> market-open -> breaker re-check -> HITL. First
 * failing gate short-circuits to `no_go`; a full pass produces `go`.
 *
 * THIS FILE IS THE NUMBERING AUTHORITY: staleness=1, stale_feed=2a,
 * drift=2, dedup=3, market-open=4, breaker=5, HITL=6, in execution order.
 * `2a` is this file's own convention, adopted so inserting `stale_feed`
 * ahead of `drift` didn't shift numbers already in use elsewhere. Cite a
 * gate by its `no_go_reason` name first, the number only as a
 * parenthetical. HITL (6) has no `no_go_reason` of its own — it refuses
 * with `timeout` or `human_rejected` — so it's cited by role, never as a
 * union member.
 *
 * `staleness` bounds how old our DECISION is; `stale_feed` bounds how old
 * the PRICE is. Neither implies the other.
 *
 * Two exemptions, both narrowed by a typed marker on the intent, both
 * belonging to ADR-0014's mandatory flat-by-close exit:
 * - `metadata.unpriced_exit`: a flatten built while the mark source was
 *   stalled carries no reference price, so `stale_feed` and `drift` are
 *   skipped for it (see `#priceGates`).
 * - `metadata.mandatory_flatten`: every flat-by-close flatten skips
 *   `staleness` (1) and `market_closed` (4), because it acts on the clock
 *   rather than on the opinion those gates bound.
 *
 * Both markers are set only at `buildFlattenExit`, the sole production
 * site that constructs an exit intent, so the exemption cannot widen by
 * accident. `unpriced_exit` implies `mandatory_flatten` (both come off
 * `exit_reason: 'flatten'`), so an unpriced flatten skips all four gates;
 * dedup (3), the breaker (5) and HITL (6) always run.
 *
 * HITL engages per the per-asset-class automation dial: `manual` always
 * engages it, `auto` never does, `semi_auto` engages it only when a flag
 * is set (non-converged, no-precedent, size-over, or near-limit).
 */
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

/** True if any semi_auto flag is set (verdict-spec.md "Module: Human-in-the-Loop") */
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
 * Refuses a `VerdictConfig` whose dial engages the human-in-the-loop gate.
 * Called from the composition root, not `VerdictImpl` — the HITL path
 * still has tests that construct the verdict directly.
 *
 * The gate is UNSOUND, not merely unused: the freshness gates run before
 * the approval `await` and are never re-evaluated, so an approval
 * returning after `human_timeout` can submit at a price checked that long
 * ago. This refuses at the moment the dial is turned, on every production
 * boot — a comment at the call site guards nothing.
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

/** Whether the HITL gate engages, per the per-asset-class automation dial */
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

    // Gate 1: staleness — signal age vs the per-asset-class bound, measured
    // from `decided_at`, NOT `decision_timestamp`. `decision_timestamp` is
    // the 1h debate-bar coordinate, floored and kept stable across ticks
    // sharing a bar — never a wall-clock reading, so age grew structurally
    // toward 60 minutes purely from where in the bar a tick landed.
    // `decided_at` is `clock.now()` read at intent-build time and never
    // floored, so two decisions of equal real freshness measure equal.
    //
    // The mandatory flat-by-close flatten skips this gate (and only it,
    // here): it does not act on an opinion at all, so bounding it by any
    // freshness measure is the wrong question — the lot must close before
    // the session ends regardless of what the debate that opened it now
    // thinks. Scoped by `metadata.mandatory_flatten`, set only by
    // `buildFlattenExit`, so an entry or a discretionary exit
    // (signal_decay, direction_flip) is never exempted. Dedup (3) and the
    // breaker re-check (5) still run for a priced flatten; an unpriced one
    // additionally skips the price gates, since `unpriced_exit` implies
    // this marker — see the file header.
    const signalAgeMs = now.getTime() - orderIntent.decided_at.getTime();
    const maxAgeMs = config.max_signal_age[orderIntent.asset_class];
    if (orderIntent.metadata.mandatory_flatten !== true && signalAgeMs > maxAgeMs) {
      // The age and the bound travel with the refusal, since `staleness`
      // and `stale_feed` measure different quantities (opinion age vs
      // price age) and a bare reason can't distinguish which
      return noGo('staleness', idempotencyKey, now, {
        measured_ms: signalAgeMs,
        bound_ms: maxAgeMs,
      });
    }

    // The unpriced mandatory flatten (`metadata.unpriced_exit`) skips both
    // price gates: `buildFlattenExit` emits a zero entry/stop/target when
    // the mark could not be read at all, and neither gate below can reason
    // about that — drift would reject on `!(entry > 0)`, and stale_feed
    // asks how old a price is that was never obtained. The mark is not
    // re-read here either: re-issuing it would pay a second ~30s primary
    // timeout on the tick trying to get flat before the close.
    //
    // `unpriced_exit` implies `mandatory_flatten` (both come off
    // `exit_reason: 'flatten'`), so `staleness` (1) and `market_closed` (4)
    // have already been skipped by the time control reaches here — four
    // gates total, not the two this branch skips. Dedup (3), the breaker
    // (5) and HITL (6) still run unconditionally.
    if (orderIntent.metadata.unpriced_exit !== true) {
      const noGoOnPrice = await this.#priceGates(orderIntent, marketData, config, clock, now);
      if (noGoOnPrice !== null) return noGoOnPrice;
    }

    // Gate 3: idempotency dedup — existing order/fill for this key
    const alreadyActed = await positionStore.findByKey(idempotencyKey);
    if (alreadyActed) {
      return noGo('dedup', idempotencyKey, now);
    }

    // Gate 4: market-open (stocks only; crypto is 24/7 and skips). The
    // mandatory flatten also skips this: it reacts to the clock rather
    // than gating on it, so ordinary Trader->Risk->Verdict latency
    // crossing the bell is not new information — refusing here left a lot
    // open through the close, the exact failure ADR-0014 exists to
    // prevent. Whether the venue then fills is a separate question
    // `executeExit` resolves on its own.
    if (orderIntent.asset_class === 'stocks' && !config.allow_extended_hours) {
      if (!tradingCalendar.isOpen(now) && orderIntent.metadata.mandatory_flatten !== true) {
        return noGo('market_closed', idempotencyKey, now);
      }
    }

    // Gate 5: fire-time kill-switch / breaker re-check
    const breakerTripped =
      breakers.portfolio_tripped || breakers.asset_class_tripped[orderIntent.asset_class];
    if (breakerTripped) {
      return noGo('breaker', idempotencyKey, now);
    }

    // Gate 6: HITL — engaged per the automation dial + flags, else automated go
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

    // KNOWN HAZARD IF THE DIAL IS EVER TURNED BACK: the freshness gates
    // ran above and are never re-evaluated after this await returns, so an
    // approval returning after `human_timeout` can submit at a stale
    // price. Not guarded here deliberately — `automation_level` is `auto`
    // so this branch is unreachable, and a check on an unreachable path is
    // a dead mechanism nothing exercises. The right fix is async approval
    // (Verdict returns `pending`, a poller resumes it), not a re-check —
    // that also removes the human from blocking the whole instrument pass
    // (`max_concurrent_instruments: 1` plus an in-pass await).
    const outcome: ApprovalOutcome = await approvals.requestApproval({
      order_intent: orderIntent,
      risk_decision,
      trace_id: input.trace_id,
      timeout_ms: config.human_timeout,
    });

    if (mode === 'backtest') {
      // Bypassed-but-recorded: the `await` above already ran. Reached only
      // when the injected channel actually resolves; overrides the answer
      // to `go` and records `would_require_approval: true`, since outside
      // backtest this decision would have required a real one
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

  /**
   * Gates 2a and 2 — the two that need a PRICE — as one read. Extracted
   * verbatim: both still run on ONE `getMark`, in order `stale_feed` then
   * `drift`, so the caller can skip both together for an intent with no
   * reference price at all.
   *
   * Returns the `no_go` to short-circuit on, or `null` when both gates pass.
   */
  async #priceGates(
    orderIntent: OrderIntent,
    marketData: VerdictInput['marketData'],
    config: VerdictConfig,
    clock: VerdictInput['clock'],
    now: Date,
  ): Promise<VerdictDecision | null> {
    const idempotencyKey = orderIntent.idempotency_key;
    const mark = await marketData.getMark(orderIntent.instrument, now);
    // Freshness is judged at the instant the mark ARRIVED (`readAt`), not
    // the `now` the read was issued with — a stalled vendor fetch (no
    // failover, ~30s retry budget) can put them minutes apart.
    const readAt = clock.now();

    // Gate 2a: FEED staleness — how long ago the market last spoke,
    // measured off `Mark.observed_at`. Ordered before drift, on the SAME
    // mark that gate reads: a stale mark breaks the drift comparison in
    // both directions (frozen-at-entry passes wrongly, frozen-far-away
    // fires drift for the wrong reason), so running this first keeps a
    // `drift` verdict about real movement and a dead feed reported as
    // dead.
    //
    // Distinct from gate 1: that bounds decision age, this bounds price
    // age. Both must hold.
    const boundMs = config.max_mark_age[orderIntent.asset_class];
    const freshness = classifyMarkFreshness(mark, readAt, boundMs);
    if (freshness.status !== 'fresh') {
      // `measured_ms` keeps `classifyMarkFreshness`'s sign: negative means
      // the mark was stamped ahead of us (clock disagreement), positive
      // means the feed went quiet (bound is `max_mark_age`)
      return noGo('stale_feed', idempotencyKey, now, {
        measured_ms: freshness.age_ms,
        bound_ms: freshness.status === 'stale' ? freshness.bound_ms : freshness.tolerance_ms,
      });
    }

    // Gate 2: drift — current price vs the bracket's entry, as a FRACTION
    // of entry (absolute distance can't be set correctly across
    // instruments of different price). Fails closed on a non-positive
    // entry: `entry * pct` would invert the comparison for a negative
    // entry rather than bound it. The unpriced flatten never reaches here
    // — it's excluded by the caller.
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

export { LoggingVerdict } from './logging-verdict.js';
export { TelegramBotApiClient } from './notifications/telegram/telegram-bot-api-client.js';
export { TelegramChannel } from './notifications/telegram-channel.js';
export type { TelegramClient, TradeChannelNotifier } from './notifications/types.js';
export { NotifyingVerdict } from './notifying-verdict.js';
export { SqliteVerdictLogStore } from './sqlite-verdict-log-store.js';
export type {
  ApprovalChannel,
  ApprovalOutcome,
  ApprovalRequest,
  PositionStore,
  VerdictConfig,
  VerdictDecision,
  VerdictInput,
} from './types.js';
