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
 * THIS FILE IS THE NUMBERING AUTHORITY (#1254): staleness=1, stale_feed=2a,
 * drift=2, dedup=3, market-open=4, breaker=5, HITL=6, in execution order.
 * The two price gates (`stale_feed`, `drift`) are commented inside
 * `#priceGates` near the bottom of this file, not inline with the rest —
 * read the numbers above, not file order. Cite a gate by its `no_go_reason`
 * name first, the number only as a parenthetical, and take the number from
 * here: `2a` is this file's own convention, adopted so #641's insertion of
 * `stale_feed` ahead of `drift` didn't shift the numbers already in use.
 * `verdict-spec.md` instead used to number every gate as its own full
 * integer, with no `2a`, so its scheme gave `stale_feed` "2" and pushed
 * drift, dedup, market-open, breaker and HITL each up by one — which made
 * "gate 3" mean opposite things, drift there vs. dedup here, depending on
 * which document a reader carried the number in from. Resolved by naming
 * first everywhere outside this file, `index.test.ts` included. The
 * one gate with no `no_go_reason` to name is HITL (6), which refuses with
 * `timeout` or `human_rejected` and is therefore cited by role, unbackticked,
 * as "the HITL gate (6)"; `hitl` is not a member of the union and must not be
 * written as though it were.
 *
 * The first two gates read as one word and are two different questions:
 * `staleness` bounds how old our DECISION is, `stale_feed` (#641) bounds how
 * old the PRICE is. Neither implies the other.
 *
 * TWO exemptions exist, both narrowed by a typed marker on the intent and both
 * belonging to ADR-0014's MANDATORY flat-by-close exit — the one order the
 * horizon does not make optional:
 *
 * - `metadata.unpriced_exit` (#826): the flatten built while the mark source
 *   was stalled carries no reference price at all, so `stale_feed` and `drift`
 *   are skipped for it — see `#priceGates` and the branch that guards it.
 * - `metadata.mandatory_flatten` (#894, widened by #1388): EVERY flat-by-close
 *   flatten skips `staleness` (gate 1) AND `market_closed` (gate 4), because
 *   it acts on the clock rather than on the opinion whose age/session those
 *   gates bound. See gate 1 and gate 4 for the two different arguments that
 *   land on the same marker.
 *
 * Neither marker is derivable from the clock or from `intent_type`; both are
 * set at the single Trader site that constructs an exit (`buildFlattenExit`)
 * — the only PRODUCTION-code site that constructs one. The smoke harness's
 * `exitPathOrder` (`server/apps/orchestrator/smoke-run.ts`) is a second producer of
 * an exit intent this stage sees: it builds one with `exit_reason: 'flatten'`
 * and neither marker, and drives it through this same `VerdictImpl` via
 * `exitPathVerdict`. Benign — the intent carries neither marker, so no gate
 * is skipped by exemption; it reaches `go` in the harness because its
 * bracket is non-zero, its `decided_at` is fresh, its asset class is
 * crypto so gate 4 (market-open) does not apply, and the harness config
 * widens `max_mark_age` to 24h for the fixture's one frozen mark
 * (`EXIT_PATH_VERDICT_CONFIG`, `smoke-run.ts`) rather than `stale_feed`
 * clearing on the mark's own merits. The claim above is about production
 * code's exemption markers, not about every caller of `decide` reaching
 * `go` by the same route.
 *
 * THE TWO STACK, ONE WAY. `unpriced_exit` is reachable only on that site's
 * `exit_reason: 'flatten'` branch, and `exit_reason: 'flatten'` alone is what
 * sets `mandatory_flatten`, so every `unpriced_exit` intent is by construction
 * also a `mandatory_flatten` and skips FOUR gates: `staleness`, `stale_feed`,
 * `drift` and `market_closed`. The reverse does not hold: a flatten whose
 * mark read succeeded carries `mandatory_flatten` without `unpriced_exit` and
 * skips `staleness` and `market_closed` alone. Under either marker, dedup (3)
 * and the breaker re-check (5) and HITL (6) still run unconditionally.
 *
 * HITL only engages per the per-asset-class automation dial: `manual`
 * always engages it, `auto` never does, `semi_auto` engages it only when a
 * flag is set (non-converged, no-precedent, size-over, or near-limit —
 * `risk_decision.modifications != null`).
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
    // from `decided_at`, NOT `decision_timestamp` (#1190).
    //
    // `decision_timestamp` is the 1h DEBATE BAR coordinate (`bar_timestamp`,
    // floored by `floorToBar`/`DEBATE_BAR_TIMEFRAME_MS`), kept stable across
    // every tick that shares a bar because the idempotency key and
    // `OpenPosition.decision_timestamp` need that stability. It was never a
    // wall-clock reading, so a decision made 55 minutes into its bar measured
    // as old as one made seconds into it — signal age grew structurally
    // toward 60 minutes purely as a function of where in the bar the tick
    // landed, against a 15-minute `max_signal_age.stocks`: 23 `staleness`
    // no-gos with zero stale feeds behind them. `decided_at` is `clock.now()`
    // read at the top of the Trader function that built the intent (`asOf` in
    // `decide.ts`) and never floored, so two decisions of equal real freshness
    // now measure equal regardless of where their shared bar puts them.
    //
    // #894 — THE MANDATORY FLAT-BY-CLOSE FLATTEN SKIPS THIS GATE, AND ONLY IT.
    //
    // Kept even though `decided_at` also comes out fresh for a flatten (it is
    // read the same way, at the same site): the exemption's reason was never
    // about which clock reading the gate used, it is that a flat-by-close
    // exit does not act on an OPINION at all, so bounding it by any freshness
    // measure is the wrong question — the lot must close before the session
    // ends whatever the debate that opened it now thinks. Same structural
    // argument #826 made for the price gates one branch below. Before #1190
    // this exemption was also load-bearing for a second, accidental reason:
    // without it, every flat-by-close flatten measured 26-56 minutes old
    // against `decision_timestamp` and was refused on a healthy feed as
    // readily as a degraded one. `decided_at` removes that accident; the
    // exemption stays because the underlying reason never depended on it.
    //
    // Scoped by `metadata.mandatory_flatten` — set by `buildFlattenExit` only
    // for `exit_reason: 'flatten'` — so the exemption cannot widen by
    // accident. An entry never carries the marker, and neither do the two
    // discretionary exits (`signal_decay`, `direction_flip`), which ARE acting
    // on an opinion and stay bounded here exactly as before. Every later gate
    // still runs for a PRICED flatten: dedup (3) is what stops a repeated
    // flatten double-submitting, and the breaker re-check (5) still applies.
    // An UNPRICED one additionally skips the two price gates at the branch
    // below, since `unpriced_exit` implies this marker — see the file header.
    //
    // This gate has effectively no PRODUCTION trigger left. `asOf` is read at
    // Trader intent-build time (`decide.ts`, before the mark/bars/precedent
    // reads so a slow data fetch still counts), Verdict runs in the same tick
    // right after Risk, and the Risk Critic is bounded at 10s (#957) — so
    // `now - decided_at` here is bounded far under both the 5-minute crypto
    // and 15-minute stocks bounds in every real run. The issue's "a genuinely
    // stale decision must still no-go" requirement is proved by fixtures
    // (`index.test.ts`'s `staleExit()`) and, for the #894 exemption
    // specifically, by an injected clock gap in
    // `flat-by-close-to-execution.test.ts` — not by a reachable production
    // scenario. A real trigger would need a stalled Trader/Risk stage, which
    // has no test coverage of its own; nothing here claims one.
    const signalAgeMs = now.getTime() - orderIntent.decided_at.getTime();
    const maxAgeMs = config.max_signal_age[orderIntent.asset_class];
    if (orderIntent.metadata.mandatory_flatten !== true && signalAgeMs > maxAgeMs) {
      // #1111: the age and the bound travel with the refusal. Without them a
      // `staleness` row says only that SOMETHING was too old, and the two
      // gates that can say that measure different quantities — this one the
      // opinion's age, `stale_feed` the price's. Reconstructing which, and by
      // how much, meant joining `verdict_log` back to `debate_log` by hand.
      return noGo('staleness', idempotencyKey, now, {
        measured_ms: signalAgeMs,
        bound_ms: maxAgeMs,
      });
    }

    // #826 — THE UNPRICED MANDATORY FLATTEN SKIPS BOTH PRICE GATES.
    //
    // `buildFlattenExit` emits an `entry`/`stop`/`target` of zero, flagged
    // `metadata.unpriced_exit`, when the instrument's own mark could not be
    // read at all and ADR-0014's flat-by-close window is open. Neither gate
    // below can reason about such an intent: gate 2 measures drift FROM the
    // bracket's entry and would reject on `!(entry > 0)`, and gate 2a asks how
    // old a price is that was never obtained. Running them would turn the
    // Trader's deliberate degradation into a `no_go` — the missed exit #826
    // exists to remove, moved one stage later.
    //
    // The mark is not even READ on this branch. During the stall it is the
    // failing call, and re-issuing it here would pay a second primary timeout
    // (~30s per `AlpacaHttpDataClient`'s retry budget) on the tick that is
    // trying to get flat before the close.
    //
    // Scoped by the flag alone, so the healthy path is byte-identical: an exit
    // that HAS a mark still drifts and still ages, and a normally-priced
    // flatten is gated exactly as before. Dedup (3) and the breaker re-check
    // (5) and HITL (6) still run unconditionally, and none of them GATES on a
    // price: dedup and the breaker evaluate no price at all, and whether HITL
    // ENGAGES turns on the automation dial and the flag set, not on the
    // bracket. That is a claim about what routes the intent, not about what
    // the route carries, and not about what a human then decides — the HITL
    // round trip hands a human the whole `order_intent` (`ApprovalRequest`,
    // `types.ts`), so once engaged the bracket a reviewer sees is three
    // zeros, and their verdict is their own. The dedup gate in particular is
    // what keeps a repeated flatten from double-submitting while the feed is
    // down.
    //
    // `staleness` (gate 1) and `market_closed` (gate 4) do NOT still run for
    // such an intent, and this is the one place that is easy to get wrong:
    // `unpriced_exit` is only ever set alongside `mandatory_flatten` (both
    // come off `exit_reason: 'flatten'` at `buildFlattenExit`), so gate 1's
    // #894 exemption and gate 4's #1388 exemption have both already fired by
    // the time control reaches here. Four gates are skipped for an unpriced
    // flatten, not the two this branch skips.
    if (orderIntent.metadata.unpriced_exit !== true) {
      const noGoOnPrice = await this.#priceGates(orderIntent, marketData, config, clock, now);
      if (noGoOnPrice !== null) return noGoOnPrice;
    }

    // Gate 3: idempotency dedup — existing order/fill for this key.
    const alreadyActed = await positionStore.findByKey(idempotencyKey);
    if (alreadyActed) {
      return noGo('dedup', idempotencyKey, now);
    }

    // Gate 4: market-open (stocks only; crypto is 24/7 and skips).
    //
    // #1388 — THE MANDATORY FLATTEN ALSO SKIPS THIS GATE, THE SAME WAY IT
    // SKIPS GATE 1.
    //
    // #894 exempted `staleness` alone and left this gate unconditional,
    // reasoning "a shut venue cannot fill" — but that reasoning answers the
    // wrong question. A flat-by-close flatten does not GATE on the clock the
    // way an entry should; it REACTS to the clock, so a few seconds of
    // ordinary Trader->Risk->Verdict latency crossing the bell is not new
    // information, it is the same decision arriving late. Measured on the
    // live paper store, 2026-09-08: a flatten decided at 19:59:56.454Z —
    // inside ADR-0014's window — was refused `market_closed` at
    // 20:00:06.125Z, leaving the lot open through the close, the exact
    // failure ADR-0014 exists to prevent.
    //
    // Whether the venue then actually fills is a separate question this gate
    // does not need to answer: `execute.ts`'s `executeExit` already resolves
    // whatever the broker returns — filled, rejected, cancelled, or left
    // 'submitting' for reconcile on an ambiguous failure — without assuming
    // acceptance. Letting the order through costs nothing beyond what a
    // normal flatten already costs.
    //
    // Unconditional, exactly like gate 1's exemption and scoped by the same
    // marker: see the file header for why `metadata.mandatory_flatten` and
    // not `exit_reason` is the right thing to test.
    if (orderIntent.asset_class === 'stocks' && !config.allow_extended_hours) {
      if (!tradingCalendar.isOpen(now) && orderIntent.metadata.mandatory_flatten !== true) {
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
        no_go_detail: null,
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
      // Bypassed-but-recorded: the `await` above already ran, so this branch
      // shields nothing from a channel that throws instead of answering —
      // the composition root's own fallback (`UnwiredApprovalChannel`)
      // refuses here exactly as it would in any other mode. Reached only
      // when the injected channel actually resolved, this overrides its
      // answer to `go` and records `would_require_approval: true`, because
      // outside backtest this decision would have required a real one.
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
   * Gates 2a and 2 — the two that need a PRICE — as one read (#826).
   *
   * Extracted verbatim from the gate sequence, not rewritten: both still run
   * on ONE `getMark`, still in the order `stale_feed` then `drift`, and still
   * fail closed on a non-positive entry. The extraction exists so the caller
   * can skip both together for an intent that has no reference price at all,
   * without a second `getMark` or a partially-applied gate.
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
    // #1111: freshness is judged at the instant the mark ARRIVED, not at the
    // `now` the read was issued with. `now` is still the point-in-time
    // coordinate the read is made AGAINST — the two are the same question only
    // when the fetch is instant, and a stalled vendor fetch (`getMark` has no
    // failover and a ~30s retry budget) makes them minutes apart.
    const readAt = clock.now();

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
    const boundMs = config.max_mark_age[orderIntent.asset_class];
    const freshness = classifyMarkFreshness(mark, readAt, boundMs);
    if (freshness.status !== 'fresh') {
      // `measured_ms` keeps `classifyMarkFreshness`'s sign, which is what
      // separates the two faults on the row: negative means the mark was
      // stamped ahead of us (clock disagreement, bounded by the receipt
      // tolerance), positive means the feed went quiet (bounded by
      // `max_mark_age`). The instrument is already a `verdict_log` column, so
      // what the row was missing is the pair of numbers, not the name.
      return noGo('stale_feed', idempotencyKey, now, {
        measured_ms: freshness.age_ms,
        bound_ms: freshness.status === 'stale' ? freshness.bound_ms : freshness.tolerance_ms,
      });
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
    // The #826 unpriced flatten does not reach here at all; it is excluded by
    // the caller, precisely so this refusal keeps its meaning.
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
export type { ApprovalCallbackPayload } from './notifications/approval-callback-verifier.js';
export {
  signApprovalCallback,
  verifyApprovalCallback,
} from './notifications/approval-callback-verifier.js';
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
