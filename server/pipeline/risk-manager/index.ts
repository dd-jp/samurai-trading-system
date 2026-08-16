/**
 * Risk Manager (Stage 4) — core check pipeline (ticket #76).
 * See docs/specs/risk-manager-spec.md (Module: Check Pipeline).
 *
 * Ordered, monotonic risk-reducing gate: breakers -> per-trade -> per-asset
 * -> per-asset-class -> portfolio -> concentration -> min-size. Every step
 * trims notional exposure or hard-rejects; nothing ever increases size or
 * loosens a stop. Exits skip every entry gate and pass through verbatim.
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
export type { PortfolioAccountingInput } from './portfolio-view.js';
export { computePortfolioView } from './portfolio-view.js';
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
    const { config } = this.thresholds
      ? resolveRiskConfig(this.config, this.thresholds.getRiskThresholds())
      : { config: this.config };

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
    let notional = intent.size * intent.entry;

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

    const finalSize = notional / intent.entry;

    if (notional < config.min_viable_size) {
      reasons.push(
        `min_viable_size: trimmed notional ${notional} below viable minimum ${config.min_viable_size}`,
      );
      return rejected('min_viable_size', reasons);
    }

    // Risk-critic review (#204).
    if (critic === undefined) {
      // Fails open BY RECORD, not silently (review 2026-08-06 B3): no producer
      // for the critic exists yet, and until one does, every decision must be
      // distinguishable from one the critic actually passed. The mechanical
      // steps above remain the safety net.
      reasons.push('risk_critic: skipped — no critic verdict was supplied for this evaluation');
    }
    if (critic) {
      const criticTrim = applyCritic(critic, notional, finalSize, reasons);
      if (criticTrim.rejected) {
        return rejected('risk_critic:reject', reasons);
      }
      if (criticTrim.changed) {
        notional = criticTrim.notional;
        bindingConstraint = 'risk_critic:trim';
      }
    }

    return {
      status: 'approved',
      order_intent: { ...intent, size: notional / intent.entry },
      modifications: {
        original_size: intent.size,
        final_size: notional / intent.entry,
        stop_tightened: false,
      },
      binding_constraint: bindingConstraint,
      reasons,
      ...decisionBase,
    };
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

const perTradeSizeCap: EntryCapGate = (config) => ({
  name: 'per_trade_size_cap',
  allowedAdditional: config.max_position_size,
});

const perAssetExposureCap: EntryCapGate = (config, intent, portfolio) => ({
  name: 'per_asset_exposure_cap',
  allowedAdditional:
    config.per_asset_cap - (portfolio.exposure_by_instrument[intent.instrument] ?? 0),
});

const perAssetClassExposureCap: EntryCapGate = (config, intent, portfolio) => ({
  name: 'per_asset_class_exposure_cap',
  allowedAdditional:
    config.per_asset_class_cap[intent.asset_class] -
    portfolio.exposure_by_class[intent.asset_class],
});

const portfolioGrossExposureCap: EntryCapGate = (config, _intent, portfolio) => ({
  name: 'portfolio_gross_exposure_cap',
  allowedAdditional: config.portfolio_gross_cap - portfolio.gross_exposure,
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
    allowedAdditional: config.concentration.cap - existingCorrelatedExposure,
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
 * **What the throw can and cannot reach, since it fires on the live decision
 * path.** `evaluate()` returns at `intent.intent_type === 'exit'` BEFORE the
 * `ENTRY_CAP_GATES` loop is entered, so no throw in any gate — this one
 * included — can block an exit. Flat-by-close therefore cannot be stopped by a
 * stale pool file, which matters because a flatten that silently stops running
 * is the defect class #670/#706 were filed for. The blast radius is exactly:
 * one unclassified instrument's ENTRIES refuse, every tick, until the pool file
 * is corrected. That refusal is the intended reading of a half-populated pool
 * file, and it is strictly safer than the alternative of entering unbounded.
 */
const perSubclassDeploymentCap: EntryCapGate = (config, intent, portfolio) => {
  const declared = config.per_subclass_deployment_cap;
  if (declared === undefined) return null;

  const subclass = declared.subclass_of[intent.instrument];
  if (subclass === undefined) {
    throw new Error(
      `per_subclass_deployment_cap is declared but ${intent.instrument} has no subclass ` +
        `(known: ${Object.keys(declared.subclass_of).join(', ') || 'none'}). ADR-0018 D5's ` +
        `deployment envelope cannot be resolved without one, and the alternative to this throw ` +
        `is sizing the position with no envelope at all. Add the instrument to the pool file.`,
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
  const cap: number | null | undefined = declared.cap[subclass];
  if (cap === undefined) {
    throw new Error(
      `per_subclass_deployment_cap declares ${intent.instrument} as '${subclass}' but carries no ` +
        `cap for that subclass (known: ${Object.keys(declared.cap).join(', ') || 'none'}). ADR-0018 ` +
        `D5's envelope cannot be resolved without one, and the alternative to this throw is sizing ` +
        `the position with no envelope at all. Add the subclass to the cap record.`,
    );
  }
  if (cap === null) return null;

  const deployedToSubclass = Object.entries(portfolio.exposure_by_instrument)
    .filter(([instrument]) => declared.subclass_of[instrument] === subclass)
    .reduce((sum, [, exposure]) => sum + exposure, 0);

  return {
    name: 'per_subclass_deployment_cap',
    allowedAdditional: cap - deployedToSubclass,
  };
};

/** Spec steps 2–6 plus ADR-0018 D5, in binding order. The array IS the pipeline. */
const ENTRY_CAP_GATES: readonly EntryCapGate[] = [
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
  finalSize: number,
  reasons: string[],
): { changed: boolean; notional: number; rejected: boolean } {
  if (critic.verdict === 'pass' || critic.verdict === 'unavailable') {
    return {
      changed: false,
      notional: finalSize * (critic.verdict === 'pass' ? 1 : 1),
      rejected: false,
    };
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
