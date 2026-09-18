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
  BreakerConfig,
  BreakerEvalInput,
  VolatilityReading,
} from './breakers.js';
export { CircuitBreakers } from './breakers.js';
export { countryForInstrument } from './cii-mapping.js';
export type { CorrelationConfig } from './correlation.js';
export { computeCorrelationEstimate } from './correlation.js';
export type { RiskCriticProducer } from './critic.js';
export { buildRiskCriticProducer } from './critic.js';
export { SqliteRiskCriticStore } from './critic-store.js';
export {
  BookValuationError,
  computePortfolioView,
  MarkReadError,
  StaleMarkError,
  unrealizedFor,
} from './portfolio-view.js';
export {
  RISK_THRESHOLD_KEYS,
  type RiskThresholdSource,
  resolveRiskConfig,
  riskThresholdsFrom,
} from './risk-thresholds.js';
export type { BreakerStatePersistence } from './sqlite-breaker-state-store.js';
export { SqliteBreakerStateStore } from './sqlite-breaker-state-store.js';
export type {
  BreakerState,
  EvaluatedCondition,
  InvalidationObservable,
  PersistedBreakerState,
  PortfolioView,
  RiskConfig,
  RiskCriticVerdict,
  RiskDecision,
  RiskInput,
  SessionBasis,
  SessionBasisByClass,
  SubclassDeploymentCap,
} from './types.js';

export const RISK_CRITIC_SKIPPED_REASON =
  'risk_critic: skipped — no critic verdict was supplied for this evaluation';

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

function committedExposureFor(portfolio: PortfolioView, instrument: string): number {
  return (
    (portfolio.exposure_by_instrument[instrument] ?? 0) +
    (portfolio.reserved_exposure_by_instrument[instrument] ?? 0)
  );
}

function committedExposureForClass(
  portfolio: PortfolioView,
  assetClass: RiskInput['intent']['asset_class'],
): number {
  return portfolio.exposure_by_class[assetClass] + portfolio.reserved_exposure_by_class[assetClass];
}

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

function applyEntryCapGates(
  config: RiskConfig,
  intent: RiskInput['intent'],
  portfolio: PortfolioView,
  correlation: RiskInput['correlation'],
  notional: number,
  reasons: string[],
): { notional: number; bindingConstraint: string | null } {
  let bindingConstraint: string | null = null;
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
  return { notional, bindingConstraint };
}

export class RiskManagerImpl implements RiskManager {
  constructor(
    private readonly config: RiskConfig,
    private readonly thresholds?: RiskThresholdSource,
  ) {}

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: ordered gate pipeline — the sequence of early returns IS the spec's step numbering (see doc above), each one placed deliberately relative to the others; extracting risks silently reordering a gate
  evaluate(input: RiskInput): RiskDecision {
    const { intent, portfolio, breakers, correlation, cii, critic, next_breaker_state } = input;

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
    const reservedInstruments = Object.entries(portfolio.reserved_exposure_by_instrument);
    if (reservedInstruments.length > 0) {
      reasons.push(
        `in_flight_reservation: ${portfolio.reserved_gross_exposure} of submitted-but-unfilled ` +
          `notional counts as deployed against every cap below (` +
          `${reservedInstruments.map(([name, value]) => `${name}=${value}`).join(', ')})`,
      );
    }
    let bindingConstraint: string | null = null;
    const originalNotional = intent.size * intent.entry;
    let notional = originalNotional;

    const submittableSize = (value: number): number => {
      const raw = value === originalNotional ? intent.size : value / intent.entry;
      return config.whole_share_sizing ? Math.floor(raw) : raw;
    };

    const gatesResult = applyEntryCapGates(
      config,
      intent,
      portfolio,
      correlation,
      notional,
      reasons,
    );
    notional = gatesResult.notional;
    if (gatesResult.bindingConstraint !== null) bindingConstraint = gatesResult.bindingConstraint;

    const finalSize = notional / intent.entry;

    if (notional < config.min_viable_size) {
      reasons.push(
        `min_viable_size: trimmed notional ${notional} below viable minimum ${config.min_viable_size}`,
      );
      return rejected('min_viable_size', reasons);
    }

    const criticReview = this.applyCriticReview(critic, notional, reasons);
    if (criticReview.rejectedBinding !== null) {
      return rejected(criticReview.rejectedBinding, reasons);
    }
    notional = criticReview.notional;
    if (criticReview.bindingConstraint !== null) bindingConstraint = criticReview.bindingConstraint;

    const approvedSize = submittableSize(notional);

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

  private applyCriticReview(
    critic: RiskCriticVerdict | undefined,
    notional: number,
    reasons: string[],
  ): { rejectedBinding: string | null; notional: number; bindingConstraint: string | null } {
    if (critic === undefined) {
      reasons.push(RISK_CRITIC_SKIPPED_REASON);
      return { rejectedBinding: null, notional, bindingConstraint: null };
    }

    reasons.push(...invalidationReasons(critic));

    const criticTrim = applyCritic(critic, notional, reasons);
    if (criticTrim.rejected) {
      return { rejectedBinding: 'risk_critic:reject', notional, bindingConstraint: null };
    }
    const breached = breachedConditions(critic);
    if (breached.length > 0) {
      return { rejectedBinding: INVALIDATED_BINDING_CONSTRAINT, notional, bindingConstraint: null };
    }
    if (criticTrim.changed) {
      return {
        rejectedBinding: null,
        notional: criticTrim.notional,
        bindingConstraint: 'risk_critic:trim',
      };
    }
    return { rejectedBinding: null, notional, bindingConstraint: null };
  }
}

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

function trippedBreakerTier(
  breakers: BreakerState,
  assetClass: RiskInput['intent']['asset_class'],
): string | null {
  if (breakers.portfolio_tripped) return 'portfolio';
  if (breakers.asset_class_tripped[assetClass]) return assetClass;
  return null;
}

type EntryCapGate = (
  config: RiskConfig,
  intent: RiskInput['intent'],
  portfolio: PortfolioView,
  correlation: RiskInput['correlation'],
) => { name: string; allowedAdditional: number } | null;

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

const perTradeSizeCap: EntryCapGate = (config, intent, portfolio) => {
  if (isD5ArmedWithNumericFraction(config, intent.instrument)) return null;
  return {
    name: 'per_trade_size_cap',
    allowedAdditional: config.max_position_size_fraction_of_equity * portfolio.equity,
  };
};

const perAssetExposureCap: EntryCapGate = (config, intent, portfolio) => {
  if (isD5ArmedWithNumericFraction(config, intent.instrument)) return null;
  return {
    name: 'per_asset_exposure_cap',
    allowedAdditional:
      config.per_asset_cap_fraction_of_equity * portfolio.equity -
      committedExposureFor(portfolio, intent.instrument),
  };
};

const perAssetClassExposureCap: EntryCapGate = (config, intent, portfolio) => ({
  name: 'per_asset_class_exposure_cap',
  allowedAdditional:
    config.per_asset_class_cap_fraction_of_equity[intent.asset_class] * portfolio.equity -
    committedExposureForClass(portfolio, intent.asset_class),
});

const portfolioGrossExposureCap: EntryCapGate = (config, _intent, portfolio) => ({
  name: 'portfolio_gross_exposure_cap',
  allowedAdditional:
    config.portfolio_gross_cap_fraction_of_equity * portfolio.equity -
    (portfolio.gross_exposure + portfolio.reserved_gross_exposure),
});

const concentrationCorrelationCap: EntryCapGate = (config, intent, portfolio, correlation) => {
  const correlatedInstruments = Object.entries(correlation.correlations)
    .filter(([, corr]) => Math.abs(corr) >= config.concentration.threshold)
    .map(([instrument]) => instrument);
  if (correlatedInstruments.length === 0) return null;

  const correlatedSet = [intent.instrument, ...correlatedInstruments];
  const existingCorrelatedExposure = correlatedSet.reduce(
    (sum, instrument) => sum + committedExposureFor(portfolio, instrument),
    0,
  );
  return {
    name: 'concentration_correlation_cap',
    allowedAdditional:
      config.concentration.cap_fraction_of_equity * portfolio.equity - existingCorrelatedExposure,
  };
};

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

  const ceiling = declared.equity_ceiling;
  if (ceiling !== undefined) {
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

  const cappedEquity =
    ceiling === undefined ? portfolio.equity : Math.min(portfolio.equity, ceiling.book);
  const cap = capFraction * cappedEquity;

  const deployedToSubclass = [
    ...new Set([
      ...Object.keys(portfolio.exposure_by_instrument),
      ...Object.keys(portfolio.reserved_exposure_by_instrument),
    ]),
  ]
    .filter((instrument) => declared.subclass_of[instrument] === subclass)
    .reduce((sum, instrument) => sum + committedExposureFor(portfolio, instrument), 0);

  return {
    name: 'per_subclass_deployment_cap',
    allowedAdditional: cap - deployedToSubclass,
  };
};

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
