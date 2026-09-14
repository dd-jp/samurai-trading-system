/**
 * #1135 — the five generic entry caps resolve against the DECLARED BOOK when
 * one is declared, not against raw broker equity.
 *
 * The property under test is "caught, not mirrored": a run whose Trader has
 * lost its `capitalCeilingUsd` (the #1112 defect) asks for a position sized off
 * ~100x equity, and these caps must trim it and name the gate — which they
 * cannot do while they multiply the same unclamped `portfolio.equity` the bug
 * scales with.
 */

import type { Clock, OrderIntent } from '../../shared/index.js';
import { RiskManagerImpl } from './index.js';
import { RISK_THRESHOLD_KEYS } from './risk-thresholds.js';
import type {
  BreakerState,
  CorrelationEstimate,
  PersistedBreakerState,
  PortfolioView,
  RiskConfig,
  RiskInput,
} from './types.js';

const fixedClock: Clock = { now: () => new Date('2026-09-14T14:00:00Z') };

/** #1112's own reported session-open paper equity, and the £1,000 book at `SIZING_USD_PER_GBP`. */
const BROKER_EQUITY = 99_876.86;
const BOOK_USD = 1_270;

/** The shipped fractions (`RISK_CAP_EQUITY_FRACTIONS`, paper-profile.ts), restated so this file stays a pipeline test. */
const FRACTIONS = {
  per_trade: 0.05,
  per_asset: 0.1,
  per_class_stocks: 0.4,
  gross: 0.5,
  concentration: 0.2,
} as const;

function makeConfig(overrides: Partial<RiskConfig> = {}): RiskConfig {
  return {
    max_position_size_fraction_of_equity: FRACTIONS.per_trade,
    per_asset_cap_fraction_of_equity: FRACTIONS.per_asset,
    per_asset_class_cap_fraction_of_equity: { crypto: 0.2, stocks: FRACTIONS.per_class_stocks },
    portfolio_gross_cap_fraction_of_equity: FRACTIONS.gross,
    concentration: { cap_fraction_of_equity: FRACTIONS.concentration, threshold: 0.7 },
    min_viable_size: 10,
    whole_share_sizing: false,
    cii_threshold: 70,
    max_mark_age: { crypto: 2 * 60_000, stocks: 15 * 60_000 },
    ...overrides,
  };
}

function makePortfolio(overrides: Partial<PortfolioView> = {}): PortfolioView {
  return {
    equity: BROKER_EQUITY,
    peak_equity: BROKER_EQUITY,
    drawdown_pct: 0,
    exposure_by_instrument: {},
    exposure_by_class: { crypto: 0, stocks: 0 },
    gross_exposure: 0,
    daily_pnl: {
      crypto: { known: true, pct: 0 },
      stocks: { known: true, pct: 0 },
      portfolio: { known: true, pct: 0 },
    },
    consecutive_losses: 0,
    unvalued_instruments: [],
    ...overrides,
  };
}

function makeIntent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    idempotency_key: 'SPY-2026-09-14T14:00:00Z',
    instrument: 'SPY',
    asset_class: 'stocks',
    side: 'buy',
    intent_type: 'entry',
    size: 1,
    entry: 1,
    stop: 0.98,
    target: 1.04,
    time_in_force: 'day',
    decision_timestamp: fixedClock.now(),
    decided_at: fixedClock.now(),
    metadata: {
      debate_id: 'debate-1135',
      conviction: 0.7,
      converged: true,
      sizing: {
        base_risk_fraction: 0.01,
        conviction_multiplier: 1,
        vol_floor_factor: 1,
        non_converged_haircut: 1,
        cosine_multiplier: 1,
      },
      cosine_precedent: { neighbor_count: 5, weighted_mean_r: 0.4, no_precedent: false },
    },
    ...overrides,
  };
}

const breakers: BreakerState = {
  portfolio_tripped: false,
  asset_class_tripped: { crypto: false, stocks: false },
  armed_breakers: [],
};

const persisted: PersistedBreakerState[] = [];

function makeInput(overrides: Partial<RiskInput> = {}): RiskInput {
  return {
    trace_id: 'trace-1135',
    intent: makeIntent(),
    clock: fixedClock,
    portfolio: makePortfolio(),
    breakers,
    next_breaker_state: persisted,
    correlation: { correlations: {}, insufficient_history: [] } satisfies CorrelationEstimate,
    cii: {},
    mode: 'live',
    ...overrides,
  };
}

/** The whole account asked for at an entry of 1, so whichever gate is armed is the one that trims. */
const WHOLE_ACCOUNT_ASK = makeIntent({ size: BROKER_EQUITY, entry: 1 });

describe('#1135 — the five generic caps resolve against min(equity, declared book)', () => {
  it.each([
    ['per_trade_size_cap', FRACTIONS.per_trade, {}],
    [
      'per_asset_exposure_cap',
      FRACTIONS.per_asset,
      { max_position_size_fraction_of_equity: 10 } satisfies Partial<RiskConfig>,
    ],
    [
      'per_asset_class_exposure_cap',
      FRACTIONS.per_class_stocks,
      {
        max_position_size_fraction_of_equity: 10,
        per_asset_cap_fraction_of_equity: 10,
      } satisfies Partial<RiskConfig>,
    ],
    [
      'portfolio_gross_exposure_cap',
      FRACTIONS.gross,
      {
        max_position_size_fraction_of_equity: 10,
        per_asset_cap_fraction_of_equity: 10,
        per_asset_class_cap_fraction_of_equity: { crypto: 10, stocks: 10 },
      } satisfies Partial<RiskConfig>,
    ],
  ])('%s trims to its fraction of the book, not of broker equity', (gate, fraction, loosened) => {
    const manager = new RiskManagerImpl(
      makeConfig({ ...loosened, generic_cap_equity_ceiling_usd: BOOK_USD }),
    );

    const decision = manager.evaluate(makeInput({ intent: WHOLE_ACCOUNT_ASK }));

    expect(decision.binding_constraint).toBe(gate);
    expect(decision.order_intent?.size).toBeCloseTo(fraction * BOOK_USD, 6);
  });

  it('concentration_correlation_cap trims to its fraction of the book', () => {
    const manager = new RiskManagerImpl(
      makeConfig({
        max_position_size_fraction_of_equity: 10,
        per_asset_cap_fraction_of_equity: 10,
        per_asset_class_cap_fraction_of_equity: { crypto: 10, stocks: 10 },
        portfolio_gross_cap_fraction_of_equity: 10,
        generic_cap_equity_ceiling_usd: BOOK_USD,
      }),
    );

    const decision = manager.evaluate(
      makeInput({
        intent: WHOLE_ACCOUNT_ASK,
        correlation: { correlations: { QQQ: 0.95 }, insufficient_history: [] },
      }),
    );

    expect(decision.binding_constraint).toBe('concentration_correlation_cap');
    expect(decision.order_intent?.size).toBeCloseTo(FRACTIONS.concentration * BOOK_USD, 6);
  });

  it('catches the #1112 regression shape — a Trader ask sized off unclamped equity is trimmed and named', () => {
    // The defect #1112 fixed was a ceiling that existed in config and never
    // reached the Trader's sizing inlet. The caps carry the book through a
    // DIFFERENT path (`RiskConfig`, not `TraderStepDeps`), which is the only
    // reason they can still bound an ask the regression re-inflates.
    const manager = new RiskManagerImpl(makeConfig({ generic_cap_equity_ceiling_usd: BOOK_USD }));
    const unclampedAsk = makeIntent({ size: 100, entry: 499.38 });

    const decision = manager.evaluate(makeInput({ intent: unclampedAsk }));

    expect(decision.binding_constraint).toBe('per_trade_size_cap');
    expect((decision.order_intent?.size ?? 0) * unclampedAsk.entry).toBeCloseTo(
      FRACTIONS.per_trade * BOOK_USD,
      6,
    );
  });

  it('leaves every cap on raw equity when no book is declared (paper, backtest, every pre-#1135 fixture)', () => {
    const manager = new RiskManagerImpl(makeConfig());

    const decision = manager.evaluate(makeInput({ intent: WHOLE_ACCOUNT_ASK }));

    expect(decision.binding_constraint).toBe('per_trade_size_cap');
    expect(decision.order_intent?.size).toBeCloseTo(FRACTIONS.per_trade * BROKER_EQUITY, 6);
  });

  it('clamps DOWN only — a book above funded equity leaves the caps on equity', () => {
    const manager = new RiskManagerImpl(
      makeConfig({ generic_cap_equity_ceiling_usd: BROKER_EQUITY * 10 }),
    );

    const decision = manager.evaluate(makeInput({ intent: WHOLE_ACCOUNT_ASK }));

    expect(decision.order_intent?.size).toBeCloseTo(FRACTIONS.per_trade * BROKER_EQUITY, 6);
  });

  it('refuses to construct on a ceiling that would read as "no bound" (#569)', () => {
    for (const bad of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
      expect(
        () => new RiskManagerImpl(makeConfig({ generic_cap_equity_ceiling_usd: bad })),
      ).toThrow('generic_cap_equity_ceiling_usd');
    }
  });

  it('leaves the D5 per-subclass gate on its own equity read', () => {
    // ADR-0018 D5 carries its own GBP `equity_ceiling` (#888) against a
    // refusal tolerance the USD figure here must not reach (#1180). Wiring the
    // shared base into it would be a currency change on a refusal threshold.
    const manager = new RiskManagerImpl(
      makeConfig({
        // Loosened far enough that even CLAMPED to the book they cannot bind
        // before D5 does — the point of the test is which equity D5 reads.
        max_position_size_fraction_of_equity: 1_000,
        per_asset_cap_fraction_of_equity: 1_000,
        per_asset_class_cap_fraction_of_equity: { crypto: 1_000, stocks: 1_000 },
        portfolio_gross_cap_fraction_of_equity: 1_000,
        concentration: { cap_fraction_of_equity: 1_000, threshold: 0.7 },
        generic_cap_equity_ceiling_usd: BOOK_USD,
        per_subclass_deployment_cap: {
          subclass_of: { SPY: 'index_etp_3x' },
          cap_fraction_of_equity: { index_etp_3x: 0.35, single_stock_etp_3x: 0.25, crypto: null },
        },
      }),
    );

    const decision = manager.evaluate(makeInput({ intent: WHOLE_ACCOUNT_ASK }));

    expect(decision.binding_constraint).toBe('per_subclass_deployment_cap');
    expect(decision.order_intent?.size).toBeCloseTo(0.35 * BROKER_EQUITY, 6);
  });

  it('is not a Feedback Loop dial — the declared book is not tunable', () => {
    expect(RISK_THRESHOLD_KEYS).not.toContain('generic_cap_equity_ceiling_usd');
  });
});
