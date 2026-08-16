/**
 * A6 (#703) — ADR-0018 D5's deployment envelope.
 *
 * D5 is the record's only drawdown protection on the intraday product: deploy
 * ~35% of the equity leg to 3x index ETPs and ~25% to 3x single-stock ETPs,
 * holding measured max drawdown at 23.1% and 26.2%. The envelope is measured
 * drift-removed with zero edge assumed, so it binds regardless of how good the
 * signal turns out to be.
 *
 * The tests that matter here are the ones covering the ways this ships green
 * and holds nothing: a cap that does not net across the subclass, a cap that
 * never becomes the binding constraint, and a dial that can widen it.
 */
import { describe, expect, it } from 'vitest';

import type { InstrumentSubclass, OrderIntent } from '../../shared/index.js';
import { RiskManagerImpl } from './index.js';
import { RISK_THRESHOLD_KEYS } from './risk-thresholds.js';
import type {
  BreakerState,
  CorrelationEstimate,
  PortfolioView,
  RiskConfig,
  SubclassDeploymentCap,
} from './types.js';

/** A £750 equity leg, so the caps below are ADR-0018 D5's own figures. */
const EQUITY_LEG = 750;
const INDEX_CAP = 0.35 * EQUITY_LEG; // 262.50 — D5's "~£260"
const SINGLE_STOCK_CAP = 0.25 * EQUITY_LEG; // 187.50 — D5's "~£190"

const SUBCLASS_OF: Record<string, InstrumentSubclass> = {
  '3USL': 'index_etp_3x',
  '3UKL': 'index_etp_3x',
  '3LAP': 'single_stock_etp_3x',
  'BTC-USD': 'crypto',
};

const DEPLOYMENT_CAP: SubclassDeploymentCap = {
  subclass_of: SUBCLASS_OF,
  cap: {
    index_etp_3x: INDEX_CAP,
    single_stock_etp_3x: SINGLE_STOCK_CAP,
    crypto: null,
  },
};

/**
 * Every other cap set far above D5's, so the subclass gate is the one that can
 * bind and `binding_constraint` is unambiguous. The "does it bind in a real
 * profile" question is a separate test below.
 */
const configWith = (cap: SubclassDeploymentCap | undefined): RiskConfig => ({
  max_position_size: 1_000_000,
  per_asset_cap: 1_000_000,
  per_asset_class_cap: { crypto: 1_000_000, stocks: 1_000_000 },
  portfolio_gross_cap: 1_000_000,
  concentration: { cap: 1_000_000, threshold: 0.7 },
  min_viable_size: 10,
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

const portfolioWith = (exposure: Record<string, number>): PortfolioView => ({
  equity: 100_000,
  gross_exposure: Object.values(exposure).reduce((sum, e) => sum + e, 0),
  exposure_by_instrument: exposure,
  exposure_by_class: { crypto: 0, stocks: 0 },
  drawdown_pct: 0,
  daily_pnl_pct: 0,
  daily_pnl_pct_by_class: { crypto: 0, stocks: 0 },
  open_position_count: Object.keys(exposure).length,
});

/** One entry at $1/share, so `size` reads directly as notional. */
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
  // `null` means "declare no envelope". Not `undefined`, which a default
  // parameter cannot distinguish from an omitted argument.
  cap: SubclassDeploymentCap | null = DEPLOYMENT_CAP,
) =>
  new RiskManagerImpl(configWith(cap ?? undefined)).evaluate({
    intent,
    portfolio: portfolioWith(exposure),
    breakers: NO_BREAKERS,
    correlation: NO_CORRELATION,
  });

describe('ADR-0018 D5 deployment envelope', () => {
  it('sizes a 3x index ETP to 35% of the equity leg', () => {
    const decision = decide(intentFor('3USL', 10_000));

    expect(decision.status).toBe('approved');
    expect(decision.modifications.final_size).toBeCloseTo(INDEX_CAP, 6);
    expect(decision.binding_constraint).toBe('per_subclass_deployment_cap');
  });

  it('sizes a 3x single-stock ETP to 25%, a DIFFERENT cap under the same asset_class', () => {
    // Both instruments are `asset_class: 'stocks'`. If the gate were keyed on
    // asset class rather than subclass, these two would get the same envelope
    // and D5 would be unimplemented while looking implemented.
    const decision = decide(intentFor('3LAP', 10_000));

    expect(decision.modifications.final_size).toBeCloseTo(SINGLE_STOCK_CAP, 6);
    expect(SINGLE_STOCK_CAP).toBeLessThan(INDEX_CAP);
  });

  it('nets across every instrument of the subclass, not per position', () => {
    // The defect this test exists for: `allowedAdditional: cap` (the
    // `perTradeSizeCap` shape) would let a second index ETP take the FULL
    // envelope again, putting 70% of the leg into a subclass measured to hold
    // 23.1% drawdown at 35%. Two different tickers, one envelope.
    const decision = decide(intentFor('3UKL', 10_000), { '3USL': 200 });

    expect(decision.modifications.final_size).toBeCloseTo(INDEX_CAP - 200, 6);
  });

  it('nets a scale_in against the position it adds to', () => {
    // `buildBracket` sizes a scale_in exactly like an entry because "Risk
    // enforces the exposure cap downstream" (trader/decide.ts). Entry at the
    // full envelope followed by a scale_in at the full envelope is the other
    // route to double deployment.
    const scaleIn = { ...intentFor('3USL', 10_000), intent_type: 'scale_in' as const };
    const decision = decide(scaleIn, { '3USL': INDEX_CAP });

    expect(decision.status).toBe('rejected');
    expect(decision.binding_constraint).toBe('min_viable_size');
  });

  it('leaves exposure in OTHER subclasses out of the netting', () => {
    // A single-stock holding must not consume the index envelope.
    const decision = decide(intentFor('3USL', 10_000), { '3LAP': 180, 'BTC-USD': 500 });

    expect(decision.modifications.final_size).toBeCloseTo(INDEX_CAP, 6);
  });

  it('does not bind on a subclass D5 measured no envelope for', () => {
    // `crypto: null` is "the study covers the two ETP subclasses and nothing
    // else", not a number waiting to be guessed. `per_asset_class_cap.crypto`
    // still bounds it.
    const decision = decide(intentFor('BTC-USD', 10_000));

    expect(decision.modifications.final_size).toBe(10_000);
    expect(decision.binding_constraint).toBeNull();
  });

  it('is inert when no envelope is declared at all', () => {
    // The backtest harness and every test predating subclasses.
    const decision = decide(intentFor('3USL', 10_000), {}, null);

    expect(decision.modifications.final_size).toBe(10_000);
  });

  it('throws on an unclassified instrument rather than sizing unbounded', () => {
    // The alternative to this throw is full deployment. A partly-populated
    // pool file is a mistake to surface, not one to size around.
    expect(() => decide(intentFor('SPY', 10_000))).toThrow(/SPY has no subclass/);
    expect(() => decide(intentFor('SPY', 10_000))).toThrow(/ADR-0018 D5/);
  });

  it('is not a Feedback Loop dial', () => {
    // D5 binds regardless of signal quality. A dial would let the loop widen
    // the envelope in exactly the run where it had learned to be confident.
    expect(RISK_THRESHOLD_KEYS).not.toContain('per_subclass_deployment_cap');
    expect(RISK_THRESHOLD_KEYS.some((key) => key.includes('subclass'))).toBe(false);
  });
});
