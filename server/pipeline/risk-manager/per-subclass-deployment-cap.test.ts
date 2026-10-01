import { describe, expect, it } from 'vitest';

import type { Clock, InstrumentSubclass, OrderIntent } from '../../shared/index.js';
import { PerSubclassCapUnresolvableError, RiskManagerImpl } from './index.js';
import { RISK_THRESHOLD_KEYS } from './risk-thresholds.js';
import type {
  BreakerState,
  CorrelationEstimate,
  PersistedBreakerState,
  PortfolioView,
  RiskConfig,
  RiskDecision,
  SubclassDeploymentCap,
} from './types.js';

const EQUITY_LEG = 750;
const INDEX_CAP = 0.35 * EQUITY_LEG;
const SINGLE_STOCK_CAP = 0.25 * EQUITY_LEG;

const PORTFOLIO_EQUITY = 100_000;

const SUBCLASS_OF: Record<string, InstrumentSubclass> = {
  '3USL': 'index_etp_3x',
  '3UKL': 'index_etp_3x',
  '3LAP': 'single_stock_etp_3x',
  'BTC-USD': 'crypto',
};

const DEPLOYMENT_CAP: SubclassDeploymentCap = {
  subclass_of: SUBCLASS_OF,
  cap_fraction_of_equity: {
    index_etp_3x: INDEX_CAP / PORTFOLIO_EQUITY,
    single_stock_etp_3x: SINGLE_STOCK_CAP / PORTFOLIO_EQUITY,
    crypto: null,
  },
};

const configWith = (cap: SubclassDeploymentCap | undefined): RiskConfig => ({
  max_position_size_fraction_of_equity: 1_000,
  per_asset_cap_fraction_of_equity: 1_000,
  per_asset_class_cap_fraction_of_equity: { crypto: 1_000, stocks: 1_000 },
  portfolio_gross_cap_fraction_of_equity: 1_000,
  concentration: { cap_fraction_of_equity: 1_000, threshold: 0.7 },
  min_viable_size: 10,
  whole_share_sizing: false,
  cii_threshold: 70,
  max_mark_age: { crypto: 2 * 60_000, stocks: 15 * 60_000 },
  ...(cap === undefined ? {} : { per_subclass_deployment_cap: cap }),
});

const NO_BREAKERS: BreakerState = {
  portfolio_tripped: false,
  asset_class_tripped: { crypto: false, stocks: false },
  armed_breakers: [],
};

const NO_CORRELATION: CorrelationEstimate = {
  correlations: {},
  insufficient_history: [],
};

const portfolioWith = (
  exposure: Record<string, number>,
  equity: number = PORTFOLIO_EQUITY,
  reserved: Record<string, number> = {},
): PortfolioView => ({
  equity,
  peak_equity: PORTFOLIO_EQUITY,
  drawdown_pct: 0,
  exposure_by_instrument: exposure,
  exposure_by_class: { crypto: 0, stocks: 0 },
  gross_exposure: Object.values(exposure).reduce((sum, e) => sum + e, 0),
  reserved_exposure_by_instrument: reserved,
  reserved_exposure_by_class: { crypto: 0, stocks: 0 },
  reserved_gross_exposure: Object.values(reserved).reduce((sum, e) => sum + e, 0),
  daily_pnl: {
    crypto: { known: true, pct: 0 },
    stocks: { known: true, pct: 0 },
    portfolio: { known: true, pct: 0 },
  },
  consecutive_losses: 0,
  unvalued_instruments: [],
});

const CLOCK: Clock = { now: () => new Date('2026-08-19T14:35:00Z') };

const NO_PERSISTED_BREAKERS: PersistedBreakerState[] = [
  { tier: 'portfolio_drawdown', tripped: false, tripped_at: null, reset_at: null, reason: null },
  { tier: 'kill_switch', tripped: false, tripped_at: null, reset_at: null, reason: null },
];

const intentFor = (instrument: string, notional: number): OrderIntent => ({
  idempotency_key: `key-${instrument}-${notional}`,
  instrument,
  asset_class: instrument === 'BTC-USD' ? 'crypto' : 'stocks',
  side: 'buy',
  intent_type: 'entry',
  size: notional,
  entry: 1,
  stop: 0.9,
  target: 1.2,
  time_in_force: 'day',
  decision_timestamp: new Date('2026-08-19T14:35:00Z'),
  decided_at: new Date('2026-08-19T14:35:00Z'),
  metadata: {
    debate_id: 'debate-1',
    conviction: 0.8,
    converged: true,
    sizing: {
      base_risk_fraction: 0.01,
      conviction_multiplier: 1,
      vol_floor_factor: 1,
      non_converged_haircut: 1,
      cosine_multiplier: 1,
    },
    cosine_precedent: { neighbor_count: 0, weighted_mean_r: null, no_precedent: true },
  },
});

const decide = (
  intent: OrderIntent,
  exposure: Record<string, number> = {},
  cap: SubclassDeploymentCap | null = DEPLOYMENT_CAP,
  equity: number = PORTFOLIO_EQUITY,
  reserved: Record<string, number> = {},
) =>
  new RiskManagerImpl(configWith(cap ?? undefined)).evaluate({
    trace_id: 'trace-d5',
    intent,
    clock: CLOCK,
    portfolio: portfolioWith(exposure, equity, reserved),
    breakers: NO_BREAKERS,
    next_breaker_state: NO_PERSISTED_BREAKERS,
    correlation: NO_CORRELATION,
    cii: {},
    mode: 'paper',
  });

const finalSizeOf = (decision: RiskDecision): number => {
  const { modifications } = decision;
  if (modifications === null) {
    throw new Error(
      `expected a sized decision, got ${decision.status} bound by ${decision.binding_constraint}`,
    );
  }
  return modifications.final_size;
};

describe('ADR-0018 D5 deployment envelope', () => {
  it('sizes a 3x index ETP to 35% of the equity leg', () => {
    const decision = decide(intentFor('3USL', 10_000));

    expect(decision.status).toBe('approved');
    expect(finalSizeOf(decision)).toBeCloseTo(INDEX_CAP, 6);
    expect(decision.binding_constraint).toBe('per_subclass_deployment_cap');
  });

  it('sizes a 3x single-stock ETP to 25%, a DIFFERENT cap under the same asset_class', () => {
    const decision = decide(intentFor('3LAP', 10_000));

    expect(finalSizeOf(decision)).toBeCloseTo(SINGLE_STOCK_CAP, 6);
    expect(SINGLE_STOCK_CAP).toBeLessThan(INDEX_CAP);
  });

  it('resolves the envelope against the equity read of THIS decision, not a frozen amount', () => {
    const full = decide(intentFor('3USL', 10_000), {}, DEPLOYMENT_CAP, PORTFOLIO_EQUITY);
    const halved = decide(intentFor('3USL', 10_000), {}, DEPLOYMENT_CAP, PORTFOLIO_EQUITY / 2);

    expect(finalSizeOf(full)).toBeCloseTo(INDEX_CAP, 6);
    expect(finalSizeOf(halved)).toBeCloseTo(INDEX_CAP / 2, 6);
    expect(finalSizeOf(halved)).toBeLessThan(finalSizeOf(full));
    expect(halved.binding_constraint).toBe('per_subclass_deployment_cap');
  });

  it('nets across every instrument of the subclass, not per position', () => {
    const decision = decide(intentFor('3UKL', 10_000), { '3USL': 200 });

    expect(finalSizeOf(decision)).toBeCloseTo(INDEX_CAP - 200, 6);
  });

  it('nets a scale_in against the position it adds to', () => {
    const scaleIn = { ...intentFor('3USL', 10_000), intent_type: 'scale_in' as const };
    const decision = decide(scaleIn, { '3USL': INDEX_CAP });

    expect(decision.status).toBe('rejected');
    expect(decision.binding_constraint).toBe('min_viable_size');

    const withRoom = decide(scaleIn, { '3USL': INDEX_CAP - 100 });
    expect(withRoom.status).toBe('approved');
    expect(withRoom.binding_constraint).toBe('per_subclass_deployment_cap');
    expect(finalSizeOf(withRoom)).toBeCloseTo(100, 6);
  });

  it('#740: admits a second index ETP within the envelope, refuses a third once it is exhausted — keyed on the subclass cap, not a position count', () => {
    const threeTickerCap: SubclassDeploymentCap = {
      ...DEPLOYMENT_CAP,
      subclass_of: { ...SUBCLASS_OF, '3IGL': 'index_etp_3x' },
    };

    const first = decide(intentFor('3USL', INDEX_CAP - 50), {}, threeTickerCap);
    expect(first.status).toBe('approved');
    expect(finalSizeOf(first)).toBeCloseTo(INDEX_CAP - 50, 6);

    const second = decide(intentFor('3UKL', 10_000), { '3USL': INDEX_CAP - 50 }, threeTickerCap);
    expect(second.status).toBe('approved');
    expect(finalSizeOf(second)).toBeCloseTo(50, 6);
    expect(second.binding_constraint).toBe('per_subclass_deployment_cap');

    const third = decide(
      intentFor('3IGL', 10_000),
      { '3USL': INDEX_CAP - 50, '3UKL': 50 },
      threeTickerCap,
    );
    expect(third.status).toBe('rejected');
    expect(third.binding_constraint).toBe('min_viable_size');
  });

  describe('#1019 — nets submitted-but-unfilled exposure, not only filled', () => {
    it('shares the envelope with a sibling whose order is in flight and has no fill yet', () => {
      const decision = decide(intentFor('3UKL', 10_000), {}, DEPLOYMENT_CAP, PORTFOLIO_EQUITY, {
        '3USL': 200,
      });

      expect(finalSizeOf(decision)).toBeCloseTo(INDEX_CAP - 200, 6);
      expect(decision.binding_constraint).toBe('per_subclass_deployment_cap');
    });

    it('produces the same envelope whether the sibling is filled or still in flight', () => {
      const filled = decide(intentFor('3UKL', 10_000), { '3USL': 200 });
      const inFlight = decide(intentFor('3UKL', 10_000), {}, DEPLOYMENT_CAP, PORTFOLIO_EQUITY, {
        '3USL': 200,
      });

      expect(finalSizeOf(inFlight)).toBeCloseTo(finalSizeOf(filled), 6);
    });

    it('nets a PARTLY filled sibling once, across both halves of its lot', () => {
      const decision = decide(
        intentFor('3UKL', 10_000),
        { '3USL': 120 },
        DEPLOYMENT_CAP,
        PORTFOLIO_EQUITY,
        { '3USL': 80 },
      );

      expect(finalSizeOf(decision)).toBeCloseTo(INDEX_CAP - 200, 6);
    });

    it('refuses outright once in-flight orders alone have exhausted the envelope', () => {
      const decision = decide(intentFor('3UKL', 10_000), {}, DEPLOYMENT_CAP, PORTFOLIO_EQUITY, {
        '3USL': INDEX_CAP,
      });

      expect(decision.status).toBe('rejected');
      expect(decision.binding_constraint).toBe('min_viable_size');
    });

    it('leaves an in-flight order in ANOTHER subclass out of the netting', () => {
      const decision = decide(intentFor('3USL', 10_000), {}, DEPLOYMENT_CAP, PORTFOLIO_EQUITY, {
        '3LAP': 180,
      });

      expect(finalSizeOf(decision)).toBeCloseTo(INDEX_CAP, 6);
    });

    it('records the reservation on the decision so the risk_log row explains the trim', () => {
      const decision = decide(intentFor('3UKL', 10_000), {}, DEPLOYMENT_CAP, PORTFOLIO_EQUITY, {
        '3USL': 200,
      });

      expect(decision.reasons).toContainEqual(expect.stringContaining('in_flight_reservation'));
      expect(decision.reasons).toContainEqual(expect.stringContaining('3USL=200'));
    });
  });

  it('leaves exposure in OTHER subclasses out of the netting', () => {
    const decision = decide(intentFor('3USL', 10_000), { '3LAP': 180, 'BTC-USD': 500 });

    expect(finalSizeOf(decision)).toBeCloseTo(INDEX_CAP, 6);
  });

  it('does not bind on a subclass D5 measured no envelope for', () => {
    const decision = decide(intentFor('BTC-USD', 10_000));

    expect(finalSizeOf(decision)).toBe(10_000);
    expect(decision.binding_constraint).toBeNull();
  });

  it('is inert when no envelope is declared at all', () => {
    const decision = decide(intentFor('3USL', 10_000), {}, null);

    expect(finalSizeOf(decision)).toBe(10_000);
  });

  it('throws on an unclassified instrument rather than sizing unbounded', () => {
    expect(() => decide(intentFor('SPY', 10_000))).toThrow(/SPY has no subclass/);
    expect(() => decide(intentFor('SPY', 10_000))).toThrow(/ADR-0018 D5/);
  });

  it('#726: the unclassified-instrument throw carries a structured binding_constraint naming the instrument', () => {
    try {
      decide(intentFor('SPY', 10_000));
      expect.unreachable('expected perSubclassDeploymentCap to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(PerSubclassCapUnresolvableError);
      const typed = error as PerSubclassCapUnresolvableError;
      expect(typed.instrument).toBe('SPY');
      expect(typed.bindingConstraint).toBe(
        'per_subclass_deployment_cap:unclassified_instrument:SPY',
      );
    }
  });

  it('throws on a subclass missing from the cap record rather than sizing on NaN', () => {
    const holed = {
      subclass_of: SUBCLASS_OF,
      cap_fraction_of_equity: {
        single_stock_etp_3x: SINGLE_STOCK_CAP / PORTFOLIO_EQUITY,
        crypto: null,
      },
    } as unknown as SubclassDeploymentCap;

    expect(() => decide(intentFor('3USL', 10_000), {}, holed)).toThrow(
      /carries no cap for that subclass/,
    );
    expect(() => decide(intentFor('3USL', 10_000), {}, holed)).toThrow(/index_etp_3x/);

    expect(finalSizeOf(decide(intentFor('3LAP', 10_000), {}, holed))).toBeCloseTo(
      SINGLE_STOCK_CAP,
      6,
    );
  });

  it('#726: the missing-cap throw carries a structured binding_constraint naming the subclass', () => {
    const holed = {
      subclass_of: SUBCLASS_OF,
      cap_fraction_of_equity: {
        single_stock_etp_3x: SINGLE_STOCK_CAP / PORTFOLIO_EQUITY,
        crypto: null,
      },
    } as unknown as SubclassDeploymentCap;

    try {
      decide(intentFor('3USL', 10_000), {}, holed);
      expect.unreachable('expected perSubclassDeploymentCap to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(PerSubclassCapUnresolvableError);
      const typed = error as PerSubclassCapUnresolvableError;
      expect(typed.instrument).toBe('3USL');
      expect(typed.bindingConstraint).toBe(
        'per_subclass_deployment_cap:no_cap_for_subclass:index_etp_3x',
      );
    }
  });

  it('rejects rather than scaling in when the subclass is already at its envelope', () => {
    const decision = decide(intentFor('3USL', 10_000), { '3USL': INDEX_CAP });

    expect(decision.status).toBe('rejected');
    expect(decision.binding_constraint).toBe('min_viable_size');
  });

  it('lets the forced flatten out of a subclass the cap record does not carry', () => {
    const holed = {
      subclass_of: SUBCLASS_OF,
      cap_fraction_of_equity: {
        single_stock_etp_3x: SINGLE_STOCK_CAP / PORTFOLIO_EQUITY,
        crypto: null,
      },
    } as unknown as SubclassDeploymentCap;
    const flatten = { ...intentFor('3USL', 10_000), intent_type: 'exit' as const };

    const decision = decide(flatten, { '3USL': INDEX_CAP }, holed);

    expect(decision.status).toBe('approved');
    expect(decision.binding_constraint).toBeNull();
    expect(finalSizeOf(decision)).toBe(10_000);
  });

  it('is not a Feedback Loop dial', () => {
    expect(RISK_THRESHOLD_KEYS).not.toContain('per_subclass_deployment_cap');
    expect(RISK_THRESHOLD_KEYS.some((key) => key.includes('subclass'))).toBe(false);
  });
});

describe('#888 — equity_ceiling: the fraction resolves against the declared BOOK, not raw portfolio.equity', () => {
  const BOOK = PORTFOLIO_EQUITY;
  const TOLERANCE = 0.05;

  const capWithCeiling = (
    refuse_above_tolerance = TOLERANCE,
    same_currency_verified = true,
  ): SubclassDeploymentCap => ({
    ...DEPLOYMENT_CAP,
    equity_ceiling: { book: BOOK, refuse_above_tolerance, same_currency_verified },
  });

  it('is unaffected when equity_ceiling is absent — every fixture above proves this, asserted once here explicitly', () => {
    expect(DEPLOYMENT_CAP.equity_ceiling).toBeUndefined();
    const decision = decide(intentFor('3USL', 10_000), {}, DEPLOYMENT_CAP, PORTFOLIO_EQUITY);
    expect(decision.binding_constraint).toBe('per_subclass_deployment_cap');
    expect(finalSizeOf(decision)).toBeCloseTo(INDEX_CAP, 6);
  });

  it('clamps resolution to the book once equity is ABOVE it, within tolerance', () => {
    const withinTolerance = BOOK * 1.02;

    const decision = decide(intentFor('3USL', 10_000), {}, capWithCeiling(), withinTolerance);

    expect(decision.status).toBe('approved');
    expect(decision.binding_constraint).toBe('per_subclass_deployment_cap');
    expect(finalSizeOf(decision)).toBeCloseTo(INDEX_CAP, 6);
  });

  it('leaves sizing untouched below the book — the ceiling only ever clamps DOWN', () => {
    const belowBook = BOOK * 0.5;

    const decision = decide(intentFor('3USL', 10_000), {}, capWithCeiling(), belowBook);

    expect(decision.status).toBe('approved');
    expect(finalSizeOf(decision)).toBeCloseTo(INDEX_CAP / 2, 6);
  });

  it('REFUSES the entry once equity clears the tolerance above the book, rather than sizing on the wider figure', () => {
    const farOverBook = BOOK * 1.5;

    expect(() => decide(intentFor('3USL', 10_000), {}, capWithCeiling(), farOverBook)).toThrow(
      /per_subclass_deployment_cap's declared book/,
    );
  });

  it('the refusal is a PerSubclassCapUnresolvableError with a structured binding_constraint naming the instrument', () => {
    const farOverBook = BOOK * 1.5;

    try {
      decide(intentFor('3USL', 10_000), {}, capWithCeiling(), farOverBook);
      expect.unreachable('expected perSubclassDeploymentCap to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(PerSubclassCapUnresolvableError);
      const typed = error as PerSubclassCapUnresolvableError;
      expect(typed.instrument).toBe('3USL');
      expect(typed.bindingConstraint).toBe('per_subclass_deployment_cap:equity_exceeds_book:3USL');
    }
  });

  it('sits exactly at the tolerance boundary: refuses just past it, caps right at it', () => {
    const justUnder = BOOK * 1.05 - 1;
    const justAt = BOOK * 1.05;
    const justOver = BOOK * 1.05 + 1;

    expect(
      decide(intentFor('3USL', 10_000), {}, capWithCeiling(), justUnder).binding_constraint,
    ).toBe('per_subclass_deployment_cap');
    expect(decide(intentFor('3USL', 10_000), {}, capWithCeiling(), justAt).binding_constraint).toBe(
      'per_subclass_deployment_cap',
    );
    expect(() => decide(intentFor('3USL', 10_000), {}, capWithCeiling(), justOver)).toThrow();
  });

  it('an exit still bypasses the ceiling entirely — the refusal must never be able to trap a flatten', () => {
    const flatten = { ...intentFor('3USL', 10_000), intent_type: 'exit' as const };

    const decision = decide(flatten, { '3USL': INDEX_CAP }, capWithCeiling(), BOOK * 10);

    expect(decision.status).toBe('approved');
    expect(decision.binding_constraint).toBeNull();
  });
});

describe('#949 — equity_ceiling refuses on currency mismatch, UNCONDITIONALLY, until same_currency_verified', () => {
  const BOOK = PORTFOLIO_EQUITY;

  const CAP_NO_VERIFICATION: SubclassDeploymentCap = {
    ...DEPLOYMENT_CAP,
    equity_ceiling: { book: BOOK, refuse_above_tolerance: 0.05 },
  };

  it('refuses even when equity is BELOW the book — proving this is not an overfunding check', () => {
    const belowBook = BOOK * 0.5;

    expect(() => decide(intentFor('3USL', 10_000), {}, CAP_NO_VERIFICATION, belowBook)).toThrow(
      /currency mismatch, cannot verify funding/,
    );
  });

  it('refuses at a realistic FX-inflated but genuinely correctly-funded value', () => {
    const fxInflatedButCorrect = BOOK * 1.27;

    expect(() =>
      decide(intentFor('3USL', 10_000), {}, CAP_NO_VERIFICATION, fxInflatedButCorrect),
    ).toThrow(/currency mismatch, cannot verify funding/);
  });

  it('refuses even when equity exactly equals the book — no numeric coincidence exempts it', () => {
    expect(() => decide(intentFor('3USL', 10_000), {}, CAP_NO_VERIFICATION, BOOK)).toThrow(
      /currency mismatch, cannot verify funding/,
    );
  });

  it('the binding_constraint is currency_mismatch, distinguishable from equity_exceeds_book', () => {
    try {
      decide(intentFor('3USL', 10_000), {}, CAP_NO_VERIFICATION, BOOK * 1.5);
      expect.unreachable('expected perSubclassDeploymentCap to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(PerSubclassCapUnresolvableError);
      const typed = error as PerSubclassCapUnresolvableError;
      expect(typed.instrument).toBe('3USL');
      expect(typed.bindingConstraint).toBe('per_subclass_deployment_cap:currency_mismatch:3USL');
      expect(typed.bindingConstraint).not.toContain('equity_exceeds_book');
      expect(typed.message).not.toMatch(/more than \d+% *above it/);
    }
  });

  it('same_currency_verified: true restores the pre-#949 clamp/refuse arithmetic — the escape hatch this flag exists for', () => {
    const verified: SubclassDeploymentCap = {
      ...DEPLOYMENT_CAP,
      equity_ceiling: { book: BOOK, refuse_above_tolerance: 0.05, same_currency_verified: true },
    };
    const withinTolerance = BOOK * 1.02;

    const decision = decide(intentFor('3USL', 10_000), {}, verified, withinTolerance);

    expect(decision.status).toBe('approved');
    expect(finalSizeOf(decision)).toBeCloseTo(INDEX_CAP, 6);
  });

  it('an exit still bypasses the currency-mismatch refusal — must never be able to trap a flatten', () => {
    const flatten = { ...intentFor('3USL', 10_000), intent_type: 'exit' as const };

    const decision = decide(flatten, { '3USL': INDEX_CAP }, CAP_NO_VERIFICATION, BOOK * 10);

    expect(decision.status).toBe('approved');
    expect(decision.binding_constraint).toBeNull();
  });
});

describe('D5 refusal wording and the generic caps it replaces', () => {
  const messageOf = (run: () => unknown): string => {
    try {
      run();
    } catch (error) {
      if (error instanceof PerSubclassCapUnresolvableError) return error.message;
      throw error;
    }
    throw new Error('expected a PerSubclassCapUnresolvableError');
  };

  const tightGenericCaps = (cap: SubclassDeploymentCap): RiskConfig => ({
    ...configWith(cap),
    max_position_size_fraction_of_equity: 0.001,
    per_asset_cap_fraction_of_equity: 0.002,
  });

  const evaluateWith = (config: RiskConfig, instrument: string) =>
    new RiskManagerImpl(config).evaluate({
      trace_id: 'trace-d5',
      intent: intentFor(instrument, 10_000),
      clock: CLOCK,
      portfolio: portfolioWith({}),
      breakers: NO_BREAKERS,
      next_breaker_state: NO_PERSISTED_BREAKERS,
      correlation: NO_CORRELATION,
      cii: {},
      mode: 'paper',
    });

  it('lets a D5 envelope replace the per-trade and per-asset caps for an instrument it sizes', () => {
    const decision = evaluateWith(tightGenericCaps(DEPLOYMENT_CAP), '3USL');

    expect(decision.binding_constraint).toBe('per_subclass_deployment_cap');
    expect(finalSizeOf(decision)).toBeCloseTo(INDEX_CAP, 6);
  });

  it('keeps the per-trade cap for a subclass D5 measured no envelope for', () => {
    const decision = evaluateWith(tightGenericCaps(DEPLOYMENT_CAP), 'BTC-USD');

    expect(decision.binding_constraint).toBe('per_trade_size_cap');
    expect(finalSizeOf(decision)).toBeCloseTo(100, 6);
  });

  it('keeps the generic caps when no envelope is declared', () => {
    const { per_subclass_deployment_cap: _, ...withoutD5 } = tightGenericCaps(DEPLOYMENT_CAP);
    const decision = evaluateWith(withoutD5, '3USL');

    expect(decision.binding_constraint).toBe('per_trade_size_cap');
  });

  it('lists the known instruments in the unclassified refusal, or says none', () => {
    expect(messageOf(() => decide(intentFor('SPY', 10_000)))).toBe(
      'per_subclass_deployment_cap is declared but SPY has no subclass (known: 3USL, 3UKL, ' +
        "3LAP, BTC-USD). ADR-0018 D5's deployment envelope cannot be resolved without one, and " +
        'the alternative to this throw is sizing the position with no envelope at all. Add the ' +
        'instrument to the pool file.',
    );
    const empty = { subclass_of: {}, cap_fraction_of_equity: {} } as SubclassDeploymentCap;
    expect(messageOf(() => decide(intentFor('SPY', 10_000), {}, empty))).toContain(
      '(known: none).',
    );
  });

  it('lists the known subclasses in the missing-cap refusal, or says none', () => {
    const holed = {
      subclass_of: SUBCLASS_OF,
      cap_fraction_of_equity: { crypto: null, index_etp_1x: null },
    } as unknown as SubclassDeploymentCap;
    expect(messageOf(() => decide(intentFor('3USL', 10_000), {}, holed))).toBe(
      "per_subclass_deployment_cap declares 3USL as 'index_etp_3x' but carries no cap for that " +
        "subclass (known: crypto, index_etp_1x). ADR-0018 D5's envelope cannot be resolved without one, and " +
        'the alternative to this throw is sizing the position with no envelope at all. Add the ' +
        'subclass to the cap record.',
    );
    const bare = { subclass_of: SUBCLASS_OF, cap_fraction_of_equity: {} } as SubclassDeploymentCap;
    expect(messageOf(() => decide(intentFor('3USL', 10_000), {}, bare))).toContain(
      '(known: none).',
    );
  });

  it('words the equity_ceiling currency refusal exactly', () => {
    const unverified: SubclassDeploymentCap = {
      ...DEPLOYMENT_CAP,
      equity_ceiling: { book: 1_000, refuse_above_tolerance: 0.05 },
    };
    expect(messageOf(() => decide(intentFor('3USL', 10_000), {}, unverified, 900))).toBe(
      'per_subclass_deployment_cap: currency mismatch, cannot verify funding — ' +
        "equity_ceiling's declared book (1000) is GBP but portfolio.equity (900) is read from " +
        "Alpaca's USD-denominated GET /v2/account. #1180 added a configured GBP->USD rate for " +
        'the SIZING inlet and deliberately did not arm this comparison with it: a rate error ' +
        "is proportional at the Trader's ask and absolute here, where it decides a total " +
        'refusal against a few percent of tolerance. Refusing to arm rather than silently ' +
        'compare GBP to USD. Resolve with a live FX-rate feed, or by running a venue whose ' +
        "account read reports the book's own currency — Saxo GET /port/v1/balances, wired as " +
        'saxoFunding (#1509), which arms equity_ceiling.same_currency_verified via ' +
        'armSameCurrencyCeilings when it does.',
    );
  });

  it('words the equity_ceiling over-funding refusal exactly', () => {
    const verified: SubclassDeploymentCap = {
      ...DEPLOYMENT_CAP,
      equity_ceiling: { book: 1_000, refuse_above_tolerance: 0.05, same_currency_verified: true },
    };
    expect(messageOf(() => decide(intentFor('3USL', 10_000), {}, verified, 2_000))).toBe(
      "per_subclass_deployment_cap's declared book is 1000 but portfolio.equity is 2000, more " +
        "than 5% above it. ADR-0018 D5's envelope was measured against the declared book " +
        '(#888), and an account funded this far past it invalidates every sizing assumption ' +
        'built on that book, not just this one fraction. Refusing to size this entry — re-fund ' +
        'the account down to the declared book, or raise the book deliberately.',
    );
  });
});
