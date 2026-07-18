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
 */
import type {
  BreakerState,
  PortfolioView,
  RiskConfig,
  RiskDecision,
  RiskInput,
  RiskManager,
} from './types.js';

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
    const { intent, portfolio, breakers, correlation } = input;

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
        risk_snapshot: snapshot(portfolio, breakers),
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
        risk_snapshot: snapshot(portfolio, breakers),
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
        risk_snapshot: snapshot(portfolio, breakers),
      };
    }

    return {
      status: 'approved',
      order_intent: { ...intent, size: finalSize },
      modifications: {
        original_size: intent.size,
        final_size: finalSize,
        // No check in the documented pipeline tightens a stop; reserved for
        // future checks (e.g. circuit-breaker-adjacent volatility trims).
        stop_tightened: false,
      },
      binding_constraint: bindingConstraint,
      reasons,
      risk_snapshot: snapshot(portfolio, breakers),
    };
  }
}
