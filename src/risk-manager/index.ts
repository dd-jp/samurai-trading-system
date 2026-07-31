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
import type {
  BreakerState,
  PortfolioView,
  RiskConfig,
  RiskCriticVerdict,
  RiskDecision,
  RiskInput,
  RiskManager,
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
  constructor(private readonly config: RiskConfig) {}

  evaluate(input: RiskInput): RiskDecision {
    const { intent, portfolio, breakers, correlation, cii, critic, next_breaker_state } = input;
    const warnings = ciiWarnings(intent.instrument, cii, this.config.cii_threshold);

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
        warnings,
        risk_snapshot: snapshot(portfolio, breakers),
        next_breaker_state,
      };
    }

    // Step 1: circuit-breaker gate — halts new entries + scale-ins, fail fast.
    const trippedTier = breakers.portfolio_tripped
      ? 'portfolio'
      : breakers.asset_class_tripped[intent.asset_class]
        ? intent.asset_class
        : null;
    if (trippedTier !== null) {
      const bindingConstraint = `circuit_breaker:${trippedTier}`;
      return {
        status: 'rejected',
        order_intent: null,
        modifications: null,
        binding_constraint: bindingConstraint,
        reasons: [
          `${bindingConstraint}: new entries halted (armed: ${
            breakers.armed_breakers.length > 0 ? breakers.armed_breakers.join(', ') : 'none'
          })`,
        ],
        warnings,
        risk_snapshot: snapshot(portfolio, breakers),
        next_breaker_state,
      };
    }

    const reasons: string[] = [];
    let bindingConstraint: string | null = null;
    let notional = intent.size * intent.entry;

    // Step 2: per-trade size cap.
    {
      const { notional: trimmed, changed } = trimToAllowed(
        notional,
        this.config.max_position_size,
        'per_trade_size_cap',
        reasons,
      );
      notional = trimmed;
      if (changed) bindingConstraint = 'per_trade_size_cap';
    }

    // Step 3: per-asset exposure cap.
    {
      const existing = portfolio.exposure_by_instrument[intent.instrument] ?? 0;
      const { notional: trimmed, changed } = trimToAllowed(
        notional,
        this.config.per_asset_cap - existing,
        'per_asset_exposure_cap',
        reasons,
      );
      notional = trimmed;
      if (changed) bindingConstraint = 'per_asset_exposure_cap';
    }

    // Step 4: per-asset-class exposure cap.
    {
      const existing = portfolio.exposure_by_class[intent.asset_class];
      const cap = this.config.per_asset_class_cap[intent.asset_class];
      const { notional: trimmed, changed } = trimToAllowed(
        notional,
        cap - existing,
        'per_asset_class_exposure_cap',
        reasons,
      );
      notional = trimmed;
      if (changed) bindingConstraint = 'per_asset_class_exposure_cap';
    }

    // Step 5: portfolio gross exposure cap.
    {
      const { notional: trimmed, changed } = trimToAllowed(
        notional,
        this.config.portfolio_gross_cap - portfolio.gross_exposure,
        'portfolio_gross_exposure_cap',
        reasons,
      );
      notional = trimmed;
      if (changed) bindingConstraint = 'portfolio_gross_exposure_cap';
    }

    // Step 6: concentration check (v2 dynamic correlation matrix, #50).
    // Instruments absent from `correlation.correlations` are treated as not
    // correlated — that's the warm-up fallback, not a special case here.
    const correlatedInstruments = Object.entries(correlation.correlations)
      .filter(([, corr]) => Math.abs(corr) >= this.config.concentration.threshold)
      .map(([instrument]) => instrument);
    if (correlatedInstruments.length > 0) {
      const correlatedSet = [intent.instrument, ...correlatedInstruments];
      const existingCorrelatedExposure = correlatedSet.reduce(
        (sum, instrument) => sum + (portfolio.exposure_by_instrument[instrument] ?? 0),
        0,
      );
      const { notional: trimmed, changed } = trimToAllowed(
        notional,
        this.config.concentration.cap - existingCorrelatedExposure,
        'concentration_correlation_cap',
        reasons,
      );
      notional = trimmed;
      if (changed) bindingConstraint = 'concentration_correlation_cap';
    }

    const finalSize = notional / intent.entry;

    // Step 7: min-viable-size re-check.
    if (notional < this.config.min_viable_size) {
      reasons.push(
        `min_viable_size: trimmed notional ${notional} below viable minimum ${this.config.min_viable_size}`,
      );
      return {
        status: 'rejected',
        order_intent: null,
        modifications: null,
        binding_constraint: 'min_viable_size',
        reasons,
        warnings,
        risk_snapshot: snapshot(portfolio, breakers),
        next_breaker_state,
      };
    }

    // Step 8: risk-critic review (#204).
    const criticWarnings = warnings;
    if (critic) {
      const criticTrim = applyCritic(critic, notional, finalSize, reasons);
      if (criticTrim.rejected) {
        return {
          status: 'rejected',
          order_intent: null,
          modifications: null,
          binding_constraint: 'risk_critic:reject',
          reasons,
          warnings: criticWarnings,
          risk_snapshot: snapshot(portfolio, breakers),
          next_breaker_state,
        };
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
      warnings: criticWarnings,
      risk_snapshot: snapshot(portfolio, breakers),
      next_breaker_state,
    };
  }
}

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
