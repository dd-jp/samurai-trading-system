/**
 * Risk Manager (Stage 4) — core check pipeline (ticket #76).
 * See docs/specs/risk-manager-spec.md (Module: Check Pipeline).
 *
 * Ordered, monotonic risk-reducing gate: long-only book -> breakers ->
 * per-trade -> per-asset -> per-asset-class -> portfolio -> concentration ->
 * min-size. Every step trims notional exposure or hard-rejects; nothing ever
 * increases size or loosens a stop. Exits skip every entry gate and pass
 * through verbatim.
 *
 * `PortfolioView` (#78), `BreakerState` (#77), and `CorrelationEstimate`
 * (#50, correlation.ts) are consumed as pre-built inputs — this pipeline
 * does not compute exposure, drawdown, breaker trips, or correlations
 * itself.
 *
 * The CII soft signal (#205, ADR-0002) runs alongside this pipeline as a
 * purely advisory check — it reads `RiskInput.cii` (pre-fetched by
 * `CiiConsumer`, market-intelligence/worldmonitor-adapter/cii-consumer.ts)
 * and appends to `RiskDecision.warnings`, but never participates in trimming
 * or rejecting.
 */
import { countryForInstrument } from './cii-mapping.js';
import {
  breachedConditions,
  INVALIDATED_BINDING_CONSTRAINT,
  invalidationReasons,
} from './invalidation.js';
import { type RiskThresholdSource, resolveRiskConfig } from './risk-thresholds.js';
import type {
  BreakerState,
  PortfolioView,
  RiskConfig,
  RiskCriticVerdict,
  RiskDecision,
  RiskInput,
  RiskManager,
} from './types.js';

export type {
  AutoReArmPolicy,
  BreakerConfig,
  BreakerEvalInput,
  VolatilityBreakerConfig,
  VolatilityReading,
} from './breakers.js';
export { CircuitBreakers } from './breakers.js';
export { countryForInstrument, trackedCountries } from './cii-mapping.js';
export type { CorrelationConfig, CorrelationEstimateInput } from './correlation.js';
export { computeCorrelationEstimate } from './correlation.js';
export type {
  BuildRiskCriticProducerOptions,
  CriticHeldPosition,
  LlmRiskCriticProducerOptions,
  ParsedCriticResponse,
  ReplayRiskCriticProducerOptions,
  RiskCriticProducer,
  RiskCriticRequest,
} from './critic.js';
export {
  buildRiskCriticProducer,
  DEFAULT_CRITIC_BUDGET_MS,
  LlmRiskCriticProducer,
  parseCriticVerdict,
  ReplayRiskCriticProducer,
  renderCriticPrompt,
} from './critic.js';
export { InMemoryRiskCriticStore, SqliteRiskCriticStore } from './critic-store.js';
export type { EvaluateConditionsInput, ValidatedConditions } from './invalidation.js';
export {
  breachedConditions,
  evaluateConditions,
  INVALIDATED_BINDING_CONSTRAINT,
  invalidationReasons,
  MAX_INVALIDATION_CONDITIONS,
  NO_CONDITIONS_REASON,
  validateConditions,
} from './invalidation.js';
export type { PortfolioAccountingInput } from './portfolio-view.js';
export {
  BookValuationError,
  computePortfolioView,
  MarkReadError,
  StaleMarkError,
  unrealizedFor,
} from './portfolio-view.js';
export {
  RISK_THRESHOLD_KEYS,
  type RiskThresholdKey,
  type RiskThresholdSource,
  resolveRiskConfig,
  riskThresholdsFrom,
} from './risk-thresholds.js';
export type { BreakerStatePersistence } from './sqlite-breaker-state-store.js';
export { SqliteBreakerStateStore } from './sqlite-breaker-state-store.js';
export type {
  BreakerState,
  CorrelationEstimate,
  DailyPnl,
  DailyPnlByClass,
  DroppedCondition,
  EvaluatedCondition,
  InvalidationCondition,
  InvalidationConditionState,
  InvalidationDropReason,
  InvalidationObservable,
  PersistedBreakerState,
  PortfolioView,
  RiskConfig,
  RiskCriticLog,
  RiskCriticStore,
  RiskCriticVerdict,
  RiskDecision,
  RiskInput,
  RiskManager,
  SessionBasis,
  SessionBasisByClass,
  SubclassDeploymentCap,
} from './types.js';

/**
 * `RiskInput.next_breaker_state` (#203) is only ever echoed onto
 * `RiskDecision.next_breaker_state` below — `evaluate()` stays pure and
 * never computes or mutates breaker state itself. The caller (whoever
 * called `CircuitBreakers.getPersistedState()` to build this input)
 * persists the echoed value to the `breaker_state` table after each call.
 */

/**
 * The reason pushed when step 7 runs with no verdict on `RiskInput.critic`.
 *
 * EXPORTED, and that is load-bearing since #957. `buildRiskStep`
 * (apps/orchestrator/production/direct-bind.ts) evaluates once with no verdict
 * and consults the critic only when that pass actually REACHED step 7 — the
 * presence of this reason is how it knows. A string matched by hand in the
 * caller would be a cross-module contract nothing enforces; one constant, read
 * from both sides, cannot drift.
 */
export const RISK_CRITIC_SKIPPED_REASON =
  'risk_critic: skipped — no critic verdict was supplied for this evaluation';

/**
 * CII soft signal (#205, ADR-0002): runs alongside the check pipeline, not
 * as one of its ordered steps — purely advisory, never consulted by any trim
 * or reject decision above. Fires on the country's absolute CII level (not
 * delta), so a sustained high-risk exposure warns every cycle it's
 * evaluated. An unmapped instrument or a country with no cached score
 * produces no warning.
 */
function ciiWarnings(instrument: string, cii: Record<string, number>, threshold: number): string[] {
  const country = countryForInstrument(instrument);
  if (country === null) {
    return [];
  }
  const score = cii[country];
  if (score === undefined || score <= threshold) {
    return [];
  }
  return [`macro_risk_flag:${country}`];
}

/**
 * Correlation warm-up warning (#303). Step 6 treats an instrument absent from
 * `correlation.correlations` as not correlated — the warm-up fallback
 * documented in risk-manager-spec.md, "Module: Correlation Warm-up
 * Visibility". That is unchanged here: this produces advisory tags only and
 * is never consulted by a trim or a reject.
 *
 * What it fixes is the conflation. An empty `correlations` map is produced
 * both by a portfolio of genuinely independent holdings and by a portfolio
 * with no overlapping history at all — the day-1-of-a-soak case, where the
 * concentration cap is silently inert precisely while the first positions go
 * on. `insufficient_history` names the second case so the decision states it.
 */
function correlationWarmupWarnings(insufficientHistory: string[]): string[] {
  return insufficientHistory.map((instrument) => `correlation_warmup:${instrument}`);
}

function snapshot(portfolio: PortfolioView, breakers: BreakerState): RiskDecision['risk_snapshot'] {
  return {
    exposure: {
      ...portfolio.exposure_by_instrument,
      crypto: portfolio.exposure_by_class.crypto,
      stocks: portfolio.exposure_by_class.stocks,
      portfolio: portfolio.gross_exposure,
    },
    drawdown_pct: portfolio.drawdown_pct,
    armed_breakers: breakers.armed_breakers,
  };
}

/** Trims `currentNotional` down to `allowedAdditional` (floored at 0) if it exceeds it. Never increases. */
function trimToAllowed(
  currentNotional: number,
  allowedAdditional: number,
  name: string,
  reasons: string[],
): { notional: number; changed: boolean } {
  const cap = Math.max(allowedAdditional, 0);
  if (currentNotional <= cap) {
    return { notional: currentNotional, changed: false };
  }
  reasons.push(
    `${name}: trimmed notional from ${currentNotional} to ${cap} (exceeded allowed exposure)`,
  );
  return { notional: cap, changed: true };
}

export class RiskManagerImpl implements RiskManager {
  /**
   * `thresholds` is the live `risk_thresholds` table (#433). Optional, because
   * a backtest or a unit test has no store and the static config is the whole
   * truth there — but on the production path it is supplied, and without it
   * `autoTighten`'s defensive response to a kill-line breach changes no
   * decision at all (feedback-loop-spec.md "Module: Guardrailed Tuning").
   */
  constructor(
    private readonly config: RiskConfig,
    private readonly thresholds?: RiskThresholdSource,
  ) {}

  /**
   * The check pipeline: exit pass-through, then the circuit-breaker gate,
   * then `ENTRY_CAP_GATES` in declared order, then the min-viable re-check
   * and the critic review. The ordering IS the spec's step numbering — each
   * gate's own doc says what it caps.
   */
  evaluate(input: RiskInput): RiskDecision {
    const { intent, portfolio, breakers, correlation, cii, critic, next_breaker_state } = input;

    // Resolved per call, not per construction. That is the entire point of the
    // ticket: a threshold the Feedback Loop tightened between two ticks has to
    // bind on the second one, and a config frozen in the constructor cannot.
    //
    // SKIPPED for an exit intent (#766). `resolveRiskConfig` re-checks the
    // WHOLE `risk_thresholds` row set against the in-code clamp
    // (threshold-bounds.ts) on every call and THROWS on a crossing — that is
    // the point of the clamp, but until this fix the throw was raised ahead
    // of the `intent_type === 'exit'` branch below, so an out-of-bound row
    // aborted an exit intent exactly like an entry one. An exit bypasses
    // every entry gate and consults `config` nowhere in the branch below —
    // `cii_threshold` is the one field the exit's `warnings` calculation
    // reads, and it is deliberately excluded from `RISK_THRESHOLD_KEYS`
    // (risk-thresholds.ts: "drives a WARNING, not a limit"), so
    // `resolveRiskConfig` never changes it — `config.cii_threshold` is
    // byte-identical whether or not the live table is consulted. Skipping the
    // resolve therefore changes NOTHING about what an exit decides; it only
    // removes exits' exposure to a corrupt threshold row they never needed.
    // ADR-0014's flat-by-close flatten rides the exit path, and a bad
    // threshold row stranding open positions through the close would be a
    // materially worse defect than the audibility gap #766 was filed for.
    const { config } =
      intent.intent_type === 'exit' || !this.thresholds
        ? { config: this.config }
        : resolveRiskConfig(this.config, this.thresholds.getRiskThresholds());

    const warnings = [
      ...ciiWarnings(intent.instrument, cii, config.cii_threshold),
      ...correlationWarmupWarnings(correlation.insufficient_history),
    ];
    const decisionBase = {
      warnings,
      risk_snapshot: snapshot(portfolio, breakers),
      next_breaker_state,
    };
    const rejected = (binding_constraint: string, reasons: string[]): RiskDecision => ({
      status: 'rejected',
      order_intent: null,
      modifications: null,
      binding_constraint,
      reasons,
      ...decisionBase,
    });

    if (intent.intent_type === 'exit') {
      return {
        status: 'approved',
        order_intent: intent,
        modifications: {
          original_size: intent.size,
          final_size: intent.size,
          stop_tightened: false,
        },
        binding_constraint: null,
        reasons: ['exit: bypasses all entry gates, passes through verbatim'],
        ...decisionBase,
      };
    }

    // #1511: long-only book, David's 2026-09-14 decision. A `sell` intent
    // reaching HERE (below the exit early-return above) is never a close —
    // it is `sideFor`'s bearish-direction answer on an instrument with no
    // held lot (`routeDecision` only ever builds `intent_type: 'entry'` when
    // `positions.length === 0`, decide.ts), i.e. a short. GIA equities do not
    // size or cost a short (no borrow, no margin model, ADR-0016/0018 sized
    // the leveraged-ETP universe long-only), so this refuses unconditionally
    // rather than sizing one. A "down" thesis belongs on the paired inverse
    // line if the universe carries it — that routing is a Trader concern, not
    // this gate's.
    //
    // Scoped to `config.long_only_instruments` — the ACTUAL Saxo-venue set
    // the run is configured to trade (`saxoTradeableUniverse()`,
    // production/saxo-venue.ts), threaded in from `paperStartingProfile`'s
    // `bookCurrency === 'GBP'` branch. `asset_class === 'stocks'` was the
    // first-pass discriminator here and was wrong: it also caught the Alpaca
    // paper universe (`DEFAULT_UNIVERSE`, also `asset_class: 'stocks'`),
    // which trades no venue this decision named. See `RiskConfig`'s own doc
    // comment for why `per_subclass_deployment_cap.subclass_of` is not the
    // discriminator either (it under-refuses unmeasured Saxo rows).
    //
    // Placed here rather than in `ENTRY_CAP_GATES`: this is a structural
    // refusal, not a sizing cap, so it should not pay for a portfolio/breaker
    // read it has no use for — and unlike `ENTRY_CAP_GATES`'s monotonic
    // trim-only contract, this one REJECTS outright, which the gates array
    // does not otherwise do (the two `PerSubclassCapUnresolvableError` gates
    // throw instead of returning a decision — this is a genuine `rejected()`
    // both ends can act on).
    if (intent.side === 'sell' && config.long_only_instruments?.has(intent.instrument)) {
      const binding = 'long_only_book';
      const positionClaim = intent.intent_type === 'entry' ? 'with no held lot' : 'on a scale_in';
      return rejected(binding, [
        `${binding}: refusing a sell ${intent.intent_type} on ${intent.instrument} ${positionClaim} ` +
          '— #1511 decided a long-only book for the Saxo GIA equity leg. A sell that is not an ' +
          'exit is a short on the long ETP: not sized or costed (no borrow/margin model, ' +
          'ADR-0016/0018 sized this universe long-only); a "down" thesis routes to the paired ' +
          'inverse line if it is in the universe.',
      ]);
    }

    // #841: an entry may not be sized against a book that was only partly
    // valued. `computePortfolioView` normally refuses to produce such a view
    // at all, and on the entry path it still does — but the exit path now
    // takes a degraded one deliberately (`unvaluable_marks: 'exclude'`), so
    // "no degraded view can exist" stopped being a property of the type and
    // became a property of one call site in the composition root. This is the
    // guard that puts it back in the gate: every cap below reads an absent
    // instrument as ZERO exposure, so a book missing a position is a book
    // whose per-asset, per-subclass and gross caps are all too wide.
    //
    // Placed BELOW the exit branch on purpose — an exit is what the degraded
    // view exists to let through, and it consults none of these caps.
    if (portfolio.unvalued_instruments.length > 0) {
      const binding = 'unvalued_book';
      return rejected(binding, [
        `${binding}: ${portfolio.unvalued_instruments.length} held instrument(s) could not be ` +
          `valued (${portfolio.unvalued_instruments.join(', ')}), so every exposure cap below ` +
          'would read them as zero exposure and allow a larger entry than the book supports. ' +
          'Exits are unaffected (they return above this line).',
      ]);
    }

    const trippedTier = trippedBreakerTier(breakers, intent.asset_class);
    if (trippedTier !== null) {
      const binding = `circuit_breaker:${trippedTier}`;
      return rejected(binding, [
        `${binding}: new entries halted (armed: ${
          breakers.armed_breakers.length > 0 ? breakers.armed_breakers.join(', ') : 'none'
        })`,
      ]);
    }

    const reasons: string[] = [];
    let bindingConstraint: string | null = null;
    const originalNotional = intent.size * intent.entry;
    let notional = originalNotional;

    /**
     * #941, second site. The Trader floors the entry it PROPOSES; every gate
     * below trims a notional and the size is re-derived by dividing, which
     * re-introduces the fraction the Trader removed. Both sites are needed:
     * without the Trader's floor an untrimmed entry is fractional, without
     * this one a trimmed entry is.
     *
     * `Math.floor`, not rounding, for the same reason as in `decide.ts` —
     * rounding up would restore exposure a cap gate had just removed, which
     * is the one direction this must never move.
     *
     * The `originalNotional` short-circuit is not an optimisation. When no
     * gate binds, `notional / intent.entry` is a float round-trip of a value
     * the Trader already floored, and it can land a hair BELOW the integer
     * (93 as 92.999...), which a floor would then take to 92 — a silent
     * one-share haircut on the untrimmed path. Returning `intent.size`
     * verbatim when nothing trimmed it is exact by construction.
     */
    const submittableSize = (value: number): number => {
      const raw = value === originalNotional ? intent.size : value / intent.entry;
      return config.whole_share_sizing ? Math.floor(raw) : raw;
    };

    for (const gate of ENTRY_CAP_GATES) {
      const cap = gate(config, intent, portfolio, correlation);
      if (cap === null) continue;
      const { notional: trimmed, changed } = trimToAllowed(
        notional,
        cap.allowedAdditional,
        cap.name,
        reasons,
      );
      notional = trimmed;
      if (changed) bindingConstraint = cap.name;
    }

    // Deliberately NOT quantised: this is the reported pre-quantisation size,
    // and flooring it here would move a number the caps reason about as a side
    // effect of a venue fix. Quantisation happens once, at the emit below.
    const finalSize = notional / intent.entry;

    if (notional < config.min_viable_size) {
      reasons.push(
        `min_viable_size: trimmed notional ${notional} below viable minimum ${config.min_viable_size}`,
      );
      return rejected('min_viable_size', reasons);
    }

    // Risk-critic review (#204; producer built by #957 in `critic.ts`).
    if (critic === undefined) {
      // Fails open BY RECORD, not silently (review 2026-08-06 B3): a decision
      // the critic never saw must stay distinguishable from one it actually
      // passed. Since #957 this is the producer's failure path — a provider
      // error, a spend-cap refusal, an unreadable answer, or a backtest
      // replaying history the critic never saw — rather than the permanent
      // state it used to be. The mechanical steps above remain the safety net.
      reasons.push(RISK_CRITIC_SKIPPED_REASON);
    }
    if (critic) {
      // The invalidation half (#994), recorded BEFORE the prose branch acts so
      // that the condition states and every validator drop reason land on
      // `reasons` on every path — a clean pass, a trim, a prose reject and a
      // breach reject alike. Ordering then decides only which
      // `binding_constraint` wins, never what is audited.
      reasons.push(...invalidationReasons(critic));

      const criticTrim = applyCritic(critic, notional, reasons);
      if (criticTrim.rejected) {
        return rejected('risk_critic:reject', reasons);
      }
      // #997 Q2b: a MEASURED breach rejects even when the prose said `pass`.
      // The producer never pre-computes this — it reports `verdict: 'pass'`
      // beside a `breached` condition and `evaluate()` holds the authority,
      // which is ADR-0003's seam exactly and keeps the persisted row honest
      // about what the model actually said. The constraint is its own, so
      // "how often do prose and predicates disagree?" stays answerable: this
      // line is reached only when the prose verdict did NOT itself reject.
      //
      // `unevaluable` is deliberately absent from this test. A data gap must
      // never block a trade (`devils-advocate-spec.md`:94), and an absent or
      // empty `conditions` list — a pre-fold row, or a malformed conditions
      // half — yields no breaches and therefore no effect at all.
      const breached = breachedConditions(critic);
      if (breached.length > 0) {
        return rejected(INVALIDATED_BINDING_CONSTRAINT, reasons);
      }
      if (criticTrim.changed) {
        notional = criticTrim.notional;
        bindingConstraint = 'risk_critic:trim';
      }
    }

    const approvedSize = submittableSize(notional);

    // The dust floor has to be re-tested on what will ACTUALLY be submitted.
    // The `min_viable_size` check above ran on the pre-floor notional, and
    // flooring only ever reduces it: £110 of trimmed notional at an entry of
    // £60 is 1.83 shares, floors to 1, and submits £60 against a config that
    // just declared anything under £100 to be dust. A quantity grid can turn
    // a viable order into a sub-viable one, so the floor is checked on both
    // sides of it.
    //
    // Two reasons, not one, and for the same reason `decide.ts` keeps
    // `rounds_to_zero_shares` distinct from `below_min_notional`: a soak log
    // must distinguish "the venue's grid ate the whole position" from "what
    // survived the caps was dust". The zero case is the strictly worse one —
    // there is no order left at all.
    const approvedNotional = approvedSize * intent.entry;
    if (approvedSize <= 0) {
      reasons.push(
        `whole_share_sizing: trimmed notional ${notional} at entry ${intent.entry} is less than one whole share`,
      );
      return rejected('whole_share_sizing:rounds_to_zero', reasons);
    }
    if (approvedNotional < config.min_viable_size) {
      reasons.push(
        `min_viable_size: quantised notional ${approvedNotional} below viable minimum ${config.min_viable_size}`,
      );
      return rejected('min_viable_size:quantised', reasons);
    }

    // `modifications` carries only sizes, so a reader cannot tell a cap trim
    // from a grid floor by comparing them — and `binding_constraint` names
    // the cap. Recorded in `reasons` instead, which is the audit channel, so
    // an under-deployed entry is attributable without re-deriving the grid.
    if (config.whole_share_sizing && approvedSize !== finalSize) {
      reasons.push(
        `whole_share_sizing: floored size from ${finalSize} to ${approvedSize} (whole shares)`,
      );
    }

    return {
      status: 'approved',
      order_intent: { ...intent, size: approvedSize },
      modifications: {
        original_size: intent.size,
        final_size: approvedSize,
        stop_tightened: false,
      },
      binding_constraint: bindingConstraint,
      reasons,
      ...decisionBase,
    };
  }
}

/**
 * Thrown by `perSubclassDeploymentCap` (#726) when the gate cannot resolve an
 * envelope for the intent's own instrument — no subclass recorded for it, or a
 * subclass recorded with no cap declared for it. Carries `bindingConstraint`
 * pre-formatted so the catch in `direct-bind.ts`'s `buildRiskStep` can write
 * the `risk_log` row this throw would otherwise leave absent (see that gate's
 * doc comment for why the throw itself is not softened) without re-parsing
 * the message or re-deriving which subclass was the problem.
 */
export class PerSubclassCapUnresolvableError extends Error {
  constructor(
    message: string,
    readonly instrument: string,
    readonly bindingConstraint: string,
  ) {
    super(message);
    this.name = 'PerSubclassCapUnresolvableError';
  }
}

/** The circuit-breaker gate — halts new entries + scale-ins, fail fast. */
function trippedBreakerTier(
  breakers: BreakerState,
  assetClass: RiskInput['intent']['asset_class'],
): string | null {
  if (breakers.portfolio_tripped) return 'portfolio';
  if (breakers.asset_class_tripped[assetClass]) return assetClass;
  return null;
}

/**
 * One entry cap: how much ADDITIONAL notional this gate allows, under its
 * binding-constraint name — or `null` when the gate does not apply to this
 * intent. Evaluated in `ENTRY_CAP_GATES` order; monotonic risk-reducing by
 * construction, since `trimToAllowed` only ever trims.
 */
type EntryCapGate = (
  config: RiskConfig,
  intent: RiskInput['intent'],
  portfolio: PortfolioView,
  correlation: RiskInput['correlation'],
) => { name: string; allowedAdditional: number } | null;

/**
 * Whether D5 is ARMED for this instrument with a NUMERIC fraction — the
 * predicate `perTradeSizeCap`, `perAssetExposureCap`, and
 * `perSubclassDeploymentCap` must agree on (#886, extended to
 * `perAssetExposureCap` by #932), so it lives once, here, rather than each
 * gate re-deriving "is this instrument classified" and drifting on what that
 * means.
 *
 * Deliberately NOT "has a `subclass_of` entry": a subclass with a `null`
 * fraction (crypto, today — doc 18 covers only the two leveraged-ETP
 * subclasses) means D5 measured no envelope at all, so exempting
 * `per_trade_size_cap` there would leave the instrument with NO per-trade
 * bound whatsoever — strictly looser than today, and not what #886 ruled.
 * An instrument absent from `subclass_of` (undefined) is likewise not
 * exempt: `perSubclassDeploymentCap` throws on it, so keeping the generic
 * cap is fail-closed either way.
 */
function isD5ArmedWithNumericFraction(
  config: RiskConfig,
  instrument: RiskInput['intent']['instrument'],
): boolean {
  const declared = config.per_subclass_deployment_cap;
  if (declared === undefined) return false;
  const subclass = declared.subclass_of[instrument];
  if (subclass === undefined) return false;
  return typeof declared.cap_fraction_of_equity[subclass] === 'number';
}

/**
 * #886: David's ruling on the anchor-vs-equity mismatch this gate used to
 * have with D5 (`server/pipeline/risk-manager/index.ts:513`) — "D5's own
 * fraction … is the sole drawdown authority once an instrument is
 * subclass-classified. `per_trade_size_cap` becomes the cap for unclassified
 * instruments only." A D5-classified instrument with a numeric fraction
 * therefore skips this gate entirely (`null`) rather than being trimmed to
 * whichever of the two caps is smaller.
 */
const perTradeSizeCap: EntryCapGate = (config, intent, portfolio) => {
  if (isD5ArmedWithNumericFraction(config, intent.instrument)) return null;
  return {
    name: 'per_trade_size_cap',
    allowedAdditional: config.max_position_size_fraction_of_equity * portfolio.equity,
  };
};

/**
 * #932: extends #886's ruling to this cap. D5 caps DEPLOYMENT into one
 * subclass and this cap caps EXPOSURE to one instrument — not the same claim,
 * which is why #886 correctly left it alone — but `per_asset_cap_fraction_of_equity`
 * (10%) is tighter than either D5 fraction (35%/25%), so a full-envelope
 * D5-classified entry was still trimmed here even after #886's fix, just at a
 * different gate. Once an instrument is D5-classified with a numeric
 * fraction, D5 is the sole per-instrument drawdown authority for it on this
 * axis too, so this gate skips entirely (`null`) exactly as `perTradeSizeCap`
 * does — see `isD5ArmedWithNumericFraction`'s docstring for why "armed with a
 * numeric fraction" (not merely "has a `subclass_of` entry") is the right
 * predicate.
 *
 * With this gate skipped, `perSubclassDeploymentCap` (below) is the sole
 * per-instrument *deployment-fraction* bound left for a D5-classified
 * instrument — see that gate's "Netted across the subclass" paragraph for
 * how it holds that role across MULTIPLE concurrently-armed instruments in
 * the same subclass, not just one. `concentrationCorrelationCap` (below) is
 * a second, independent bound: it carries no D5-armed guard, so it still
 * applies to a D5-classified instrument's size unchanged, binding whenever
 * correlation data is present and the correlated set's exposure exceeds
 * `config.concentration.cap_fraction_of_equity`.
 */
const perAssetExposureCap: EntryCapGate = (config, intent, portfolio) => {
  if (isD5ArmedWithNumericFraction(config, intent.instrument)) return null;
  return {
    name: 'per_asset_exposure_cap',
    allowedAdditional:
      config.per_asset_cap_fraction_of_equity * portfolio.equity -
      (portfolio.exposure_by_instrument[intent.instrument] ?? 0),
  };
};

const perAssetClassExposureCap: EntryCapGate = (config, intent, portfolio) => ({
  name: 'per_asset_class_exposure_cap',
  allowedAdditional:
    config.per_asset_class_cap_fraction_of_equity[intent.asset_class] * portfolio.equity -
    portfolio.exposure_by_class[intent.asset_class],
});

const portfolioGrossExposureCap: EntryCapGate = (config, _intent, portfolio) => ({
  name: 'portfolio_gross_exposure_cap',
  allowedAdditional:
    config.portfolio_gross_cap_fraction_of_equity * portfolio.equity - portfolio.gross_exposure,
});

/**
 * Concentration check (v2 dynamic correlation matrix, #50). Instruments
 * absent from `correlation.correlations` are treated as not correlated —
 * that's the warm-up fallback, not a special case here. #303 deliberately
 * did NOT change that: an under-`min_bars` pair still cannot bind this cap.
 * It is surfaced as a `correlation_warmup:` warning instead, so the
 * inertness is stated rather than inferred from silence.
 */
const concentrationCorrelationCap: EntryCapGate = (config, intent, portfolio, correlation) => {
  const correlatedInstruments = Object.entries(correlation.correlations)
    .filter(([, corr]) => Math.abs(corr) >= config.concentration.threshold)
    .map(([instrument]) => instrument);
  if (correlatedInstruments.length === 0) return null;

  const correlatedSet = [intent.instrument, ...correlatedInstruments];
  const existingCorrelatedExposure = correlatedSet.reduce(
    (sum, instrument) => sum + (portfolio.exposure_by_instrument[instrument] ?? 0),
    0,
  );
  return {
    name: 'concentration_correlation_cap',
    allowedAdditional:
      config.concentration.cap_fraction_of_equity * portfolio.equity - existingCorrelatedExposure,
  };
};

/**
 * ADR-0018 D5's deployment envelope (#703, step A6) — max notional across
 * every instrument of the intent's subclass.
 *
 * **Netted across the subclass, not per position.** The tempting form is
 * `allowedAdditional: cap`, matching `perTradeSizeCap`, and it is wrong twice
 * over: `buildBracket` sizes a `scale_in` exactly like an entry precisely
 * because "Risk enforces the exposure cap downstream" (trader/decide.ts), so a
 * non-netted cap admits entry-at-35% then scale-in-at-35%; and two different
 * 3x index ETPs held at once would each get the full envelope. Either voids
 * the 23.1% drawdown figure the fraction was measured to hold. D5's envelope
 * is "35% of the leg deployed to 3x index ETPs", so the sum is what binds.
 *
 * Instruments absent from `subclass_of` are skipped by the netting filter
 * (`undefined !== subclass`) rather than throwing — a legacy or manually-held
 * position should not be able to break sizing for an unrelated name. Only the
 * INTENT's own instrument must be classified, and that one throws.
 *
 * **This netting is what makes this gate the sole per-instrument
 * deployment-fraction bound for a D5-classified instrument, once #932
 * exempts it from `per_asset_cap`** — `concentrationCorrelationCap` (above)
 * is a second, independent bound (correlation-based, not deployment-based)
 * that still applies to a D5-classified instrument's size unchanged.
 * `deployedToSubclass` sums `exposure_by_instrument` across every instrument
 * the pool file classifies into the intent's subclass, not just the
 * intent's own instrument, so N concurrently-armed names in
 * `single_stock_etp_3x` share ONE 25%-of-equity envelope rather than each
 * reaching 25% independently — exactly the "two different 3x index ETPs …
 * would each get the full envelope" failure mode the paragraph above names
 * and nets away. ADR-0018 D5 states the envelope the same way: "35% of the
 * leg deployed to 3x index ETPs", a subclass aggregate, not a per-name
 * allowance. See `d5-trader-cap-agreement.test.ts`'s "#959" describe block
 * for the concurrent-instrument coverage.
 *
 * **What the throw can and cannot reach, since it fires on the live decision
 * path.** `evaluate()` returns at `intent.intent_type === 'exit'` BEFORE the
 * `ENTRY_CAP_GATES` loop is entered, so no throw in any gate — this one
 * included — can block an exit. Flat-by-close therefore cannot be stopped by a
 * stale pool file, which matters because a flatten that silently stops running
 * is the defect class #670/#706 were filed for. **The blast radius is no
 * longer just one unclassified instrument (#888 review fix-up added a second
 * refusal path).** An instrument absent from `subclass_of` still refuses ITS
 * OWN entries alone, every tick, until the pool file is corrected — that part
 * is unchanged. But an OVERFUNDED account now refuses much wider than that:
 * this gate's own `equity_ceiling` refuses every D5-classified instrument's
 * entries once armed, and `liveBookCeiling` (this file, below) refuses EVERY
 * instrument's entries — classified or not — regardless of pool-file state,
 * because it reads `config.live_book_ceiling` directly rather than resolving
 * through `subclass_of`. Both are the intended reading of their respective
 * triggers (a half-populated pool file; an overfunded account) and remedies
 * (correct the pool file; re-fund the account down to the declared book, or
 * raise the book deliberately) — both strictly safer than entering unbounded.
 *
 * **That "one instrument" bound is a claim about a caller, so here is the
 * caller.** `SequentialTickRunner.runInstrument` deliberately has no try/catch;
 * the containment is one level up, in `tick-loop.ts`'s `worker()`, which wraps
 * each `runInstrument` call in its own try/catch (#507) precisely so one
 * instrument throwing cannot reject the worker's `Promise.all` entry and settle
 * the whole tick while sibling instruments are still mid-pipeline. The throw
 * becomes a logged `TickOutcome.error` and a durable `audit_log` row for that
 * instrument alone. Without #507's catch this throw WOULD take down the tick
 * for every instrument, so if that catch is ever removed, this gate must be
 * revisited with it — the two are coupled, and only this comment says so.
 *
 * **What the throw cost, and #726's fix.** This is the only entry gate that
 * throws rather than returning a decision, and `riskLog.write` in
 * `production/direct-bind.ts` runs only AFTER `evaluate()` returns normally —
 * so on its own a refused instrument would write **no `risk_log` row**. #726
 * closed that: `buildRiskStep` wraps the `evaluate()` call in a try/catch and,
 * on a `PerSubclassCapUnresolvableError`, writes a `risk_log` row with
 * `status: 'error'` and `binding_constraint` set from the error's own
 * `bindingConstraint` (naming the unclassified instrument or subclass) BEFORE
 * re-throwing — the throw itself is untouched and still propagates to #507's
 * catch in `tick-loop.ts` for the `audit_log` row and the log line. The row is
 * additive, not a substitute: #507's catch still runs unchanged.
 *
 * Returning a rejected decision instead WOULD have closed the original gap
 * too, and that was rejected deliberately: a rejection is quiet, and a
 * half-populated pool file that merely declines entries can run for days
 * looking like a market with no setups. The throw is chosen for being
 * impossible to ignore — #726 made the audit gap it left behind not free, not
 * the throw itself.
 */
const perSubclassDeploymentCap: EntryCapGate = (config, intent, portfolio) => {
  const declared = config.per_subclass_deployment_cap;
  if (declared === undefined) return null;

  const subclass = declared.subclass_of[intent.instrument];
  if (subclass === undefined) {
    throw new PerSubclassCapUnresolvableError(
      `per_subclass_deployment_cap is declared but ${intent.instrument} has no subclass ` +
        `(known: ${Object.keys(declared.subclass_of).join(', ') || 'none'}). ADR-0018 D5's ` +
        `deployment envelope cannot be resolved without one, and the alternative to this throw ` +
        `is sizing the position with no envelope at all. Add the instrument to the pool file.`,
      intent.instrument,
      `per_subclass_deployment_cap:unclassified_instrument:${intent.instrument}`,
    );
  }

  // `cap` is total over `InstrumentSubclass` at COMPILE time only. `subclass_of`
  // is built from the pool file at the composition root, so a subclass string
  // that reaches here without a row in `cap` is a runtime possibility the type
  // cannot exclude — and `undefined` is the one value that must not fall
  // through. `undefined - deployedToSubclass` is `NaN`, `trimToAllowed` does
  // `Math.max(NaN, 0) === NaN`, `notional <= NaN` is false so it "trims" to
  // `NaN`, and `NaN < config.min_viable_size` is false too — so the intent
  // clears both this gate and the min-viable floor with no envelope at all.
  // That is the exact failure D5 exists to prevent, arriving silently.
  const capFraction: number | null | undefined = declared.cap_fraction_of_equity[subclass];
  if (capFraction === undefined) {
    throw new PerSubclassCapUnresolvableError(
      `per_subclass_deployment_cap declares ${intent.instrument} as '${subclass}' but carries no ` +
        `cap for that subclass (known: ` +
        `${Object.keys(declared.cap_fraction_of_equity).join(', ') || 'none'}). ADR-0018 ` +
        `D5's envelope cannot be resolved without one, and the alternative to this throw is sizing ` +
        `the position with no envelope at all. Add the subclass to the cap record.`,
      intent.instrument,
      `per_subclass_deployment_cap:no_cap_for_subclass:${subclass}`,
    );
  }
  if (capFraction === null) return null;

  // #888 — the equity this fraction resolves against is the DECLARED BOOK
  // (`equity_ceiling.book`), not raw `portfolio.equity`, once the two
  // diverge. `portfolio.equity` is one blended broker figure with no
  // per-leg accounting, so it equals the book only by coincidence of how the
  // account happens to be funded at this instant; funding it past the book
  // must not silently widen every position the same fractions size.
  const ceiling = declared.equity_ceiling;
  if (ceiling !== undefined) {
    // #949, re-affirmed by #1180 — `book` is GBP, `portfolio.equity` is read
    // from Alpaca's USD-denominated `GET /v2/account`
    // (production/account-state.ts:129), so this comparison cannot verify
    // funding in EITHER direction until it is known to compare like-for-like
    // — not just above `refuseAbove`, where the previous behaviour merely
    // gave the wrong REASON, but also below it, where a stale FX rate could
    // have let a genuinely wrong funding level clamp and pass silently.
    // Refuse outright, before the numeric comparison, rather than let either
    // failure mode reach it.
    //
    // **A configured rate now exists (`SIZING_USD_PER_GBP`) and this gate
    // still refuses — by design, not by staleness.** See
    // `same_currency_verified`'s doc comment (types.ts) for the arithmetic:
    // the rate's own drift is larger than `refuse_above_tolerance`, so arming
    // this with it would make FX movement indistinguishable from the
    // overfunding the refusal exists to catch.
    if (!ceiling.same_currency_verified) {
      throw new PerSubclassCapUnresolvableError(
        'per_subclass_deployment_cap: currency mismatch, cannot verify funding — ' +
          `equity_ceiling's declared book (${ceiling.book}) is GBP but portfolio.equity ` +
          `(${portfolio.equity}) is read from Alpaca's USD-denominated GET /v2/account. #1180 ` +
          'added a configured GBP->USD rate for the SIZING inlet and deliberately did not arm ' +
          "this comparison with it: a rate error is proportional at the Trader's ask and " +
          'absolute here, where it decides a total refusal against a few percent of tolerance. ' +
          'Refusing to arm rather than silently compare GBP to USD. Resolve with a live FX-rate ' +
          "feed, or by running a venue whose account read reports the book's own currency — " +
          'Saxo GET /port/v1/balances/me, wired as saxoFunding (#1509), which arms ' +
          'equity_ceiling.same_currency_verified via armSameCurrencyCeilings when it does.',
        intent.instrument,
        `per_subclass_deployment_cap:currency_mismatch:${intent.instrument}`,
      );
    }
    const refuseAbove = ceiling.book * (1 + ceiling.refuse_above_tolerance);
    if (portfolio.equity > refuseAbove) {
      // The backstop half of the fix: an account funded THIS far past the
      // declared book does not merely make this one cap too generous — it
      // invalidates the other assumptions the book was sized against too
      // (the breaker baselines, the drawdown envelope D5's fractions were
      // measured to hold). Refusing the entry outright, rather than quietly
      // capping and moving on, is what turns that into something the
      // operator has to notice and correct, per #888's chosen resolution.
      throw new PerSubclassCapUnresolvableError(
        `per_subclass_deployment_cap's declared book is ${ceiling.book} but portfolio.equity is ` +
          `${portfolio.equity}, more than ${(ceiling.refuse_above_tolerance * 100).toFixed(0)}% ` +
          `above it. ADR-0018 D5's envelope was measured against the declared book (#888), and an ` +
          'account funded this far past it invalidates every sizing assumption built on that ' +
          'book, not just this one fraction. Refusing to size this entry — re-fund the account ' +
          'down to the declared book, or raise the book deliberately.',
        intent.instrument,
        `per_subclass_deployment_cap:equity_exceeds_book:${intent.instrument}`,
      );
    }
  }

  // Resolved against the equity read of THIS decision (#739), which is the
  // whole point of the fractional form: a frozen cash cap is a rising fraction
  // of a falling book, so it stops bounding drawdown at the first loss. Below
  // the declared book (or when no book is declared at all) that equity read
  // is `portfolio.equity` unclamped; at or above the book (within tolerance)
  // it is clamped to the book, per #888 — the whole point of `equity_ceiling`.
  const cappedEquity =
    ceiling === undefined ? portfolio.equity : Math.min(portfolio.equity, ceiling.book);
  const cap = capFraction * cappedEquity;

  const deployedToSubclass = Object.entries(portfolio.exposure_by_instrument)
    .filter(([instrument]) => declared.subclass_of[instrument] === subclass)
    .reduce((sum, [, exposure]) => sum + exposure, 0);

  return {
    name: 'per_subclass_deployment_cap',
    allowedAdditional: cap - deployedToSubclass,
  };
};

/**
 * #888 review fix-up — the account-level counterpart of
 * `perSubclassDeploymentCap`'s `equity_ceiling`, armed INDEPENDENTLY of
 * universe classification.
 *
 * `perSubclassDeploymentCap`'s `equity_ceiling` refusal only fires once an
 * instrument is D5-classified (`declared.subclass_of[intent.instrument]`
 * resolves) — and `DEFAULT_UNIVERSE` (scheduler.ts), the universe
 * `liveStartingProfile()` actually boots on, classifies nothing today. This
 * gate reads `config.live_book_ceiling` instead, a sibling field set by
 * `buildStartingProfileConfigs` whenever a book is supplied (live only),
 * with no dependency on `subclass_of` — so an overfunded live account
 * refuses EVERY entry, on EVERY instrument, from the first tick, not just
 * the ones the pool file happens to classify. See
 * `RiskConfig['live_book_ceiling']`'s doc comment (types.ts) for the full
 * "why doesn't the existing mechanism cover this" account.
 *
 * Placed in `ENTRY_CAP_GATES` rather than ahead of the exit early-return in
 * `evaluate()` on purpose: a throw above that early return would block
 * exits and flat-by-close too (the exact defect class `guards-before-early-
 * returns` was filed for) — living in the gates array inherits the
 * structural guarantee that only entries ever reach it.
 *
 * **Returns `null`, never a cap.** This gate is a pure refusal (throw) or
 * pass-through — it does not itself narrow `allowedAdditional`, because
 * `perSubclassDeploymentCap`'s own `equity_ceiling` clamp already does that
 * job once an instrument IS classified. Duplicating the clamp here would
 * double-count for a classified instrument and do nothing for an
 * unclassified one (no fraction to clamp).
 *
 * **Currency mismatch, guarded rather than flagged (#949), and PERMANENTLY so
 * as of #1180 — read `live_book_ceiling`'s doc comment (types.ts) for the
 * full account.** `ceiling.book` is GBP; `portfolio.equity` is sourced from
 * Alpaca's account balance, which is USD. Below, `same_currency_verified`
 * guards the numeric comparison entirely: absent/`false` refuses to arm
 * BEFORE the comparison runs, in either direction — this used to only
 * "misfire" (refuse a correctly funded GBP account, or fail to refuse one,
 * depending on the prevailing rate); now it refuses unconditionally with a
 * `currency_mismatch` binding_constraint, distinguishable from the
 * `equity_exceeds_book` refusal below.
 *
 * #1180 converted the SIZING inlet at a configured rate and left this refusal
 * standing on purpose — the refusal's cause is not "no rate exists" but "no
 * rate accurate enough for a percentage-point funding test exists". The
 * arithmetic is on `same_currency_verified` (types.ts).
 */
const liveBookCeiling: EntryCapGate = (config, intent, portfolio) => {
  const ceiling = config.live_book_ceiling;
  if (ceiling === undefined) return null;

  if (!ceiling.same_currency_verified) {
    throw new PerSubclassCapUnresolvableError(
      'live_book_ceiling: currency mismatch, cannot verify funding — ' +
        `live_book_ceiling's declared book (${ceiling.book}) is GBP but portfolio.equity ` +
        `(${portfolio.equity}) is read from Alpaca's USD-denominated GET /v2/account. #1180 added ` +
        'a configured GBP->USD rate for the SIZING inlet and deliberately did not arm this ' +
        "comparison with it: a rate error is proportional at the Trader's ask and absolute here, " +
        'where it decides a total refusal against a few percent of tolerance. So this ' +
        'account-level check (#888 review fix-up, arms regardless of whether any instrument is ' +
        'D5-classified yet) refuses to arm rather than silently compare GBP to USD. Resolve with ' +
        "a live FX-rate feed, or by running a venue whose account read reports the book's own " +
        'currency — Saxo GET /port/v1/balances/me, wired as saxoFunding (#1509), which arms ' +
        'live_book_ceiling.same_currency_verified via armSameCurrencyCeilings when it does.',
      intent.instrument,
      `live_book_ceiling:currency_mismatch:${intent.instrument}`,
    );
  }

  const refuseAbove = ceiling.book * (1 + ceiling.refuse_above_tolerance);
  if (portfolio.equity > refuseAbove) {
    throw new PerSubclassCapUnresolvableError(
      `live_book_ceiling's declared book is ${ceiling.book} but portfolio.equity is ` +
        `${portfolio.equity}, more than ${(ceiling.refuse_above_tolerance * 100).toFixed(0)}% ` +
        'above it. This account-level check (#888 review fix-up) arms regardless of whether any ' +
        'instrument is D5-classified yet — an account funded this far past the declared book ' +
        'invalidates every sizing assumption built on that book, not just a classified ' +
        "subclass's. Refusing to size this entry — re-fund the account down to the declared " +
        'book, or raise the book deliberately.',
      intent.instrument,
      `live_book_ceiling:equity_exceeds_book:${intent.instrument}`,
    );
  }

  return null;
};

/** Spec steps 2–6 plus ADR-0018 D5, in binding order. The array IS the pipeline. */
const ENTRY_CAP_GATES: readonly EntryCapGate[] = [
  liveBookCeiling,
  perTradeSizeCap,
  perAssetExposureCap,
  perAssetClassExposureCap,
  perSubclassDeploymentCap,
  portfolioGrossExposureCap,
  concentrationCorrelationCap,
];

function applyCritic(
  critic: { verdict: RiskCriticVerdict['verdict']; max_notional: number | null; reasoning: string },
  notional: number,
  reasons: string[],
): { changed: boolean; notional: number; rejected: boolean } {
  if (critic.verdict === 'pass' || critic.verdict === 'unavailable') {
    // Nothing to apply. `notional` goes back untouched — before #957 this
    // branch echoed the SHARE COUNT back in a field named `notional`, inert
    // only because the caller ignores the value when `changed` is false. That
    // path is reachable for the first time now, so it returns the real thing.
    return { changed: false, notional, rejected: false };
  }

  if (critic.verdict === 'reject') {
    reasons.push(`risk_critic: ${critic.reasoning}`);
    return { changed: true, notional, rejected: true };
  }

  const criticCap = critic.max_notional ?? notional;
  if (criticCap >= notional) {
    return { changed: false, notional, rejected: false };
  }

  reasons.push(
    `risk_critic: trimmed notional from ${notional} to ${criticCap} (${critic.reasoning})`,
  );
  return { changed: true, notional: criticCap, rejected: false };
}
