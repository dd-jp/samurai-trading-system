/**
 * #1135 — the profile side of the generic caps' equity base, and the
 * measurement that decided paper does not carry one.
 *
 * The pipeline-side behaviour is pinned in
 * `server/pipeline/risk-manager/generic-cap-equity-ceiling.test.ts`. This file
 * asserts what the SHIPPED profiles hand it, against the issue's own reported
 * paper equity — the numbers in #1135's table are what these assertions are
 * derived from, so a regression reproduces the table rather than merely
 * failing.
 */

import type {
  BreakerState,
  PortfolioView,
  RiskConfig,
  RiskInput,
} from '../../pipeline/risk-manager/index.js';
import { RiskManagerImpl } from '../../pipeline/risk-manager/index.js';
import type { Clock, OrderIntent } from '../../shared/index.js';
import { LIVE_MAX_CAPITAL_ENV_VAR, liveStartingProfile } from './live-profile.js';
import {
  buildStartingProfileConfigs,
  LIVE_BOOK_SIZING_USD,
  RISK_CAP_EQUITY_FRACTIONS,
} from './paper-profile.js';

/** #1112's reported session-open paper equity — the figure #1135's table is computed against. */
const PAPER_EQUITY = 99_876.86;

/** ADR-0018 D5's single-stock position at the £1,000 book (~£250), in the USD the caps are read in. */
const BOOK_SIZED_POSITION_USD = 0.25 * LIVE_BOOK_SIZING_USD;

const clock: Clock = { now: () => new Date('2026-09-14T14:00:00Z') };

function portfolio(equity: number): PortfolioView {
  return {
    equity,
    peak_equity: equity,
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
  };
}

const breakers: BreakerState = {
  portfolio_tripped: false,
  asset_class_tripped: { crypto: false, stocks: false },
  armed_breakers: [],
};

function intent(instrument: string, entry: number, size: number): OrderIntent {
  return {
    idempotency_key: `${instrument}-2026-09-14T14:00:00Z`,
    instrument,
    asset_class: 'stocks',
    side: 'buy',
    intent_type: 'entry',
    size,
    entry,
    stop: entry * 0.98,
    target: entry * 1.04,
    time_in_force: 'day',
    decision_timestamp: clock.now(),
    decided_at: clock.now(),
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
  };
}

function decide(
  config: RiskConfig,
  equity: number,
  order: OrderIntent,
  correlations: Record<string, number> = {},
) {
  const input: RiskInput = {
    trace_id: 'trace-1135',
    intent: order,
    clock,
    portfolio: portfolio(equity),
    breakers,
    next_breaker_state: [],
    correlation: { correlations, insufficient_history: [] },
    cii: {},
    mode: 'paper',
  };
  return new RiskManagerImpl(config).evaluate(input);
}

/**
 * The shipped ladder, tightest first: each gate's `binding_constraint` and the
 * `RISK_CAP_EQUITY_FRACTIONS` value behind it.
 */
const LADDER = [
  ['per_trade_size_cap', RISK_CAP_EQUITY_FRACTIONS.max_position_size_fraction_of_equity],
  ['per_asset_exposure_cap', RISK_CAP_EQUITY_FRACTIONS.per_asset_cap_fraction_of_equity],
  ['concentration_correlation_cap', RISK_CAP_EQUITY_FRACTIONS.concentration_cap_fraction_of_equity],
  [
    'per_asset_class_exposure_cap',
    RISK_CAP_EQUITY_FRACTIONS.per_asset_class_cap_fraction_of_equity_stocks,
  ],
  [
    'portfolio_gross_exposure_cap',
    RISK_CAP_EQUITY_FRACTIONS.portfolio_gross_cap_fraction_of_equity,
  ],
] as const;

const LOOSE = 1_000;

/** Loosens every gate tighter than `gate` so the one under test is the one that trims. */
function loosenedBelow(config: RiskConfig, gate: string): RiskConfig {
  const rank = LADDER.findIndex(([name]) => name === gate);
  const loosen = new Set<string>(LADDER.slice(0, rank).map(([name]) => name));
  // The shipped live `riskConfig` also arms `live_book_ceiling`, whose
  // currency-mismatch refusal (#949/#1180) throws ahead of every gate — so a
  // live-config decision cannot be observed at all with it armed. Dropped here
  // to measure the caps; that refusal is not this ticket's.
  const { live_book_ceiling: _unarmed, ...armedCaps } = config;
  return {
    ...armedCaps,
    ...(loosen.has('per_trade_size_cap') ? { max_position_size_fraction_of_equity: LOOSE } : {}),
    ...(loosen.has('per_asset_exposure_cap') ? { per_asset_cap_fraction_of_equity: LOOSE } : {}),
    ...(loosen.has('concentration_correlation_cap')
      ? { concentration: { ...config.concentration, cap_fraction_of_equity: LOOSE } }
      : {}),
    ...(loosen.has('per_asset_class_exposure_cap')
      ? { per_asset_class_cap_fraction_of_equity: { crypto: LOOSE, stocks: LOOSE } }
      : {}),
  };
}

/** What one gate actually admits, measured through `evaluate()` on a whole-account ask. */
function admittedNotional(config: RiskConfig, gate: string, equity: number): number {
  const decision = decide(loosenedBelow(config, gate), equity, intent('SPY', 1, equity), {
    QQQ: 0.95,
  });
  expect(decision.binding_constraint).toBe(gate);
  return decision.order_intent?.size ?? 0;
}

describe('#1135 — which profiles declare a generic-cap equity base', () => {
  it('the live profile carries the declared book, converted to the currency equity is read in', () => {
    const profile = liveStartingProfile(LIVE_BOOK_SIZING_USD);

    expect(profile.riskConfig.generic_cap_equity_ceiling_usd).toBe(LIVE_BOOK_SIZING_USD);
    expect(LIVE_BOOK_SIZING_USD).toBe(1_270);
  });

  it("the paper profile carries none — Alpaca's simulated balance is not the book", () => {
    expect(buildStartingProfileConfigs().riskConfig.generic_cap_equity_ceiling_usd).toBeUndefined();
  });

  it('names the book, not the operator ceiling — a wider ceiling does not widen the caps', () => {
    // The independence that makes a #1112 regression CAUGHT rather than
    // mirrored: the caps' base comes from LIVE_BOOK_GBP through `riskConfig`,
    // never from SAMURAI_LIVE_MAX_CAPITAL_USD through `TraderStepDeps`.
    const profile = liveStartingProfile(LIVE_BOOK_SIZING_USD * 50);

    expect(profile.capitalCeilingUsd).toBe(LIVE_BOOK_SIZING_USD * 50);
    expect(profile.riskConfig.generic_cap_equity_ceiling_usd).toBe(LIVE_BOOK_SIZING_USD);
    expect(LIVE_MAX_CAPITAL_ENV_VAR).toBe('SAMURAI_LIVE_MAX_CAPITAL_USD');
  });
});

describe("#1135 — the issue's table, measured through evaluate()", () => {
  const config = liveStartingProfile(LIVE_BOOK_SIZING_USD).riskConfig;

  it.each(LADDER)('%s admits its fraction of the book, not of broker equity', (gate, fraction) => {
    // Floored: the shipped profiles set `whole_share_sizing`, and the ask is
    // priced at 1 so a share IS a dollar here.
    expect(admittedNotional(config, gate, PAPER_EQUITY)).toBe(
      Math.floor(fraction * LIVE_BOOK_SIZING_USD),
    );
  });

  it.each(LADDER)('%s no longer sits 16-40x above a book-sized position', (gate) => {
    // #1135's table: 4x / 8x / 32x / 40x / 16x of the whole £1,000 book, so
    // even the tightest cap sat ~16x above one D5 single-stock position.
    const admitted = admittedNotional(config, gate, PAPER_EQUITY);

    expect(admitted / BOOK_SIZED_POSITION_USD).toBeLessThan(2.1);
    expect(admitted).toBeLessThanOrEqual(LIVE_BOOK_SIZING_USD);
  });

  it.each(LADDER)('%s was 16-40x above it while the base was raw equity', (gate) => {
    const { generic_cap_equity_ceiling_usd: _dropped, ...unclamped } = config;

    const admitted = admittedNotional(unclamped, gate, PAPER_EQUITY);

    expect(admitted / BOOK_SIZED_POSITION_USD).toBeGreaterThan(15);
  });
});

describe('#1135 — why paper carries no base (measured, not asserted)', () => {
  // The Trader already sizes against the converted book since #1112, so these
  // are realistic paper asks: one or two shares of a DEFAULT_UNIVERSE name.
  const asks: ReadonlyArray<readonly [string, number, number]> = [
    ['SPY', 600, 1],
    ['QQQ', 500, 1],
    ['AAPL', 230, 2],
    ['TSLA', 400, 1],
  ];

  it.each(asks)('%s is approved under the shipped paper profile', (instrument, price, size) => {
    const decision = decide(
      buildStartingProfileConfigs().riskConfig,
      PAPER_EQUITY,
      intent(instrument, price, size),
    );

    expect(decision.status).toBe('approved');
    expect(decision.order_intent?.size).toBe(size);
  });

  it.each(
    asks,
  )('%s would floor to zero shares if paper clamped to the book', (instrument, price, size) => {
    const decision = decide(
      {
        ...buildStartingProfileConfigs().riskConfig,
        generic_cap_equity_ceiling_usd: LIVE_BOOK_SIZING_USD,
      },
      PAPER_EQUITY,
      intent(instrument, price, size),
    );

    expect(decision.status).toBe('rejected');
    expect(decision.binding_constraint).toBe('whole_share_sizing:rounds_to_zero');
  });
});
