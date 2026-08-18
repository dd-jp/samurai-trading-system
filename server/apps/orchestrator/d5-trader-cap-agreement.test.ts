/**
 * #800 — what the Trader and the D5 gate each think `portfolio.equity`
 * denominates, asserted through the composition root.
 *
 * The defect #800 filed: the Trader sized an entry at
 * `D5_INDEX_ETP_DEPLOYMENT_FRACTION x portfolio.equity` while the Risk
 * Manager's D5 gate allowed `EQUITY_LEG_FRACTION_OF_CAPITAL (0.5) x` the same
 * product, so an armed entry would have been trimmed to exactly half the
 * Trader's intent. David's 2026-08-18 ruling (the book is £1,000, all equity)
 * removed the leg-to-account conversion that scaler was, and the first
 * describe below asserts the two sides now resolve to the same fraction.
 *
 * The second describe is the more consequential half, and it was found by
 * these tests rather than reasoned to: **D5's envelope is unreachable in the
 * shipped profile at every book size**, because `max_position_size` is 5% of
 * the same equity D5 takes 35% of. See its comment.
 */
import { describe, expect, it } from 'vitest';

import { RiskManagerImpl } from '../../pipeline/risk-manager/index.js';
import type {
  BreakerState,
  CorrelationEstimate,
  PersistedBreakerState,
  PortfolioView,
  RiskConfig,
} from '../../pipeline/risk-manager/types.js';
import {
  D5_INDEX_ETP_DEPLOYMENT_FRACTION,
  D5_SINGLE_STOCK_ETP_DEPLOYMENT_FRACTION,
} from '../../pipeline/trader/subclass-bracket.js';
import type { Clock, OrderIntent } from '../../shared/index.js';
import {
  buildStartingProfileConfigs,
  LIVE_BOOK_GBP,
  RISK_CAP_EQUITY_FRACTIONS,
} from './paper-profile.js';
import type { UniverseInstrument } from './types.js';

/** One classified instrument per D5 subclass, so the gate is armed. */
const UNIVERSE: readonly UniverseInstrument[] = [
  { asset: '3USL', asset_class: 'stocks', subclass: 'index_etp_3x' },
  { asset: '3LAP', asset_class: 'stocks', subclass: 'single_stock_etp_3x' },
];

/** The book, per ADR-0015's 2026-08-18 amendment. */
const EQUITY = LIVE_BOOK_GBP;

const CLOCK: Clock = { now: () => new Date('2026-08-19T14:35:00Z') };

const NO_BREAKERS: BreakerState = {
  portfolio_tripped: false,
  asset_class_tripped: { crypto: false, stocks: false },
  armed_breakers: [],
};

const NO_PERSISTED_BREAKERS: PersistedBreakerState[] = [
  { tier: 'portfolio_drawdown', tripped: false, tripped_at: null, reset_at: null, reason: null },
  { tier: 'kill_switch', tripped: false, tripped_at: null, reset_at: null, reason: null },
];

const NO_CORRELATION: CorrelationEstimate = { correlations: {}, insufficient_history: [] };

const portfolioWith = (equity: number, exposure: Record<string, number>): PortfolioView => ({
  equity,
  peak_equity: equity,
  drawdown_pct: 0,
  exposure_by_instrument: exposure,
  exposure_by_class: {
    crypto: 0,
    stocks: Object.values(exposure).reduce((sum, e) => sum + e, 0),
  },
  gross_exposure: Object.values(exposure).reduce((sum, e) => sum + e, 0),
  daily_pnl: {
    crypto: { known: true, pct: 0 },
    stocks: { known: true, pct: 0 },
    portfolio: { known: true, pct: 0 },
  },
  consecutive_losses: 0,
  unvalued_instruments: [],
});

/** £1/share, so `size` reads directly as notional. */
const intentFor = (
  instrument: string,
  notional: number,
  intentType: 'entry' | 'scale_in',
): OrderIntent => ({
  idempotency_key: `key-${instrument}-${intentType}`,
  instrument,
  asset_class: 'stocks',
  side: 'buy',
  intent_type: intentType,
  size: notional,
  entry: 1,
  stop: 0.9,
  target: 1.2,
  time_in_force: 'day',
  decision_timestamp: new Date('2026-08-19T14:35:00Z'),
  metadata: {
    debate_id: 'debate-800',
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

const shippedConfig = (equity = EQUITY): RiskConfig =>
  buildStartingProfileConfigs(equity, UNIVERSE).riskConfig;

/**
 * The shipped config with every cap OTHER than D5 lifted out of the way.
 *
 * Necessary because — see the second describe — the generic per-trade cap
 * binds first in the shipped profile at every equity, so a behavioural
 * assertion about D5 would otherwise be an assertion about `max_position_size`
 * wearing D5's name. The lifted caps are named individually rather than
 * spread over, so a newly added cap does not silently join them.
 */
const d5InIsolation = (equity = EQUITY): RiskConfig => ({
  ...shippedConfig(equity),
  max_position_size: Number.MAX_SAFE_INTEGER,
  per_asset_cap: Number.MAX_SAFE_INTEGER,
  per_asset_class_cap: { crypto: Number.MAX_SAFE_INTEGER, stocks: Number.MAX_SAFE_INTEGER },
  portfolio_gross_cap: Number.MAX_SAFE_INTEGER,
  concentration: { cap: Number.MAX_SAFE_INTEGER, threshold: 0.7 },
});

const decide = (
  config: RiskConfig,
  intent: OrderIntent,
  exposure: Record<string, number> = {},
  equity = EQUITY,
) =>
  new RiskManagerImpl(config).evaluate({
    trace_id: 'trace-800',
    intent,
    clock: CLOCK,
    portfolio: portfolioWith(equity, exposure),
    breakers: NO_BREAKERS,
    next_breaker_state: NO_PERSISTED_BREAKERS,
    correlation: NO_CORRELATION,
    cii: {},
    mode: 'paper',
  });

describe('#800 — the Trader intent and the D5 cap agree by construction', () => {
  it('arms the gate at the Trader\'s OWN fractions, unscaled', () => {
    // The 2x itself, asserted where it lived: as an equality between the
    // Trader's named constants and the fractions the composition root hands
    // the gate. Under `EQUITY_LEG_FRACTION_OF_CAPITAL = 0.5` these differed by
    // exactly a factor of two, and no test compared them.
    const caps = shippedConfig().per_subclass_deployment_cap?.cap_fraction_of_equity;

    expect(caps?.index_etp_3x).toBe(D5_INDEX_ETP_DEPLOYMENT_FRACTION);
    expect(caps?.single_stock_etp_3x).toBe(D5_SINGLE_STOCK_ETP_DEPLOYMENT_FRACTION);
  });

  it('does NOT trim an armed index entry sized at the Trader\'s intent', () => {
    const intended = D5_INDEX_ETP_DEPLOYMENT_FRACTION * EQUITY; // £350 on the book

    const decision = decide(d5InIsolation(), intentFor('3USL', intended, 'entry'));

    expect(decision.status).not.toBe('rejected');
    expect(decision.modifications?.final_size).toBeCloseTo(intended, 6);
    expect(decision.binding_constraint).not.toBe('per_subclass_deployment_cap');
  });

  it('does NOT trim an armed single-stock entry either', () => {
    const intended = D5_SINGLE_STOCK_ETP_DEPLOYMENT_FRACTION * EQUITY; // £250

    const decision = decide(d5InIsolation(), intentFor('3LAP', intended, 'entry'));

    expect(decision.status).not.toBe('rejected');
    expect(decision.modifications?.final_size).toBeCloseTo(intended, 6);
    expect(decision.binding_constraint).not.toBe('per_subclass_deployment_cap');
  });

  it('still binds a subclass already deployed into — the gate is not disarmed', () => {
    // The agreement above must not be reachable by the cap having stopped
    // binding at all, which is how this ships green and holds nothing. D5's
    // cap is per SUBCLASS, so an existing position consumes headroom.
    const deployed = D5_INDEX_ETP_DEPLOYMENT_FRACTION * EQUITY * 0.5; // £175

    const decision = decide(
      d5InIsolation(),
      intentFor('3USL', D5_INDEX_ETP_DEPLOYMENT_FRACTION * EQUITY, 'entry'),
      { '3USL': deployed },
    );

    expect(decision.binding_constraint).toBe('per_subclass_deployment_cap');
    expect(decision.modifications?.final_size).toBeCloseTo(deployed, 6);
  });

  it('leaves NO room for a scale-in once an entry took the full envelope — #800 AC3 is NOT satisfied', () => {
    // Recorded as behaviour, not asserted as desirable. `buildBracket` sizes a
    // `scale_in` exactly like an entry (decide.ts:391), so a first fill at the
    // full envelope leaves `allowedAdditional <= 0` and every scale-in is
    // trimmed to zero, then rejected under `min_viable_size`.
    //
    // Unscaling the cap neither caused this nor can fix it: it follows from
    // the Trader sizing ONE entry AT the whole envelope. Resolving it is a
    // Trader-side or ADR-0018 D5 decision — entries size below the envelope to
    // leave headroom, or scale-ins are ruled out for D5-capped subclasses —
    // and it is the half of #800 that survives David's capital ruling.
    const full = D5_INDEX_ETP_DEPLOYMENT_FRACTION * EQUITY;

    const decision = decide(d5InIsolation(), intentFor('3USL', full, 'scale_in'), {
      '3USL': full,
    });

    expect(decision.status).toBe('rejected');
    expect(decision.binding_constraint).toBe('min_viable_size');
  });
});

describe("D5's envelope is unreachable in the SHIPPED profile, at every book size", () => {
  it('trims the Trader\'s D5-sized entry to the 5% per-trade cap instead', () => {
    // Found by these tests, not reasoned to. `max_position_size` is 5% of
    // equity and D5's index envelope is 35% of the SAME equity, so the generic
    // per-trade cap binds first — the Trader asks for £350 on the £1,000 book
    // and gets £50, with `per_trade_size_cap` recorded as binding on every
    // entry.
    const intended = D5_INDEX_ETP_DEPLOYMENT_FRACTION * EQUITY;

    const decision = decide(shippedConfig(), intentFor('3USL', intended, 'entry'));

    expect(decision.binding_constraint).toBe('per_trade_size_cap');
    expect(decision.modifications?.final_size).toBeCloseTo(
      RISK_CAP_EQUITY_FRACTIONS.max_position_size * EQUITY,
      6,
    );
  });

  it('is SCALE-INVARIANT — a bigger book does not make D5 bind', () => {
    // The existing note in `subclass-deployment-cap.test.ts` reads this as an
    // artefact of the $100k paper anchor ("the paper soak is not a test of
    // D5"). It is not an artefact: both caps are fractions of the same equity,
    // so 5% < 35% holds at every book size and D5 can never be the binding
    // constraint on a first entry. What follows matters for #798 — the
    // ~41.8% drawdown envelope is measured at f = 0.25, and the shipped
    // profile deploys 0.05.
    for (const equity of [1_000, 1_500, 100_000]) {
      const decision = decide(
        shippedConfig(equity),
        intentFor('3USL', D5_INDEX_ETP_DEPLOYMENT_FRACTION * equity, 'entry'),
        {},
        equity,
      );

      expect(decision.binding_constraint).toBe('per_trade_size_cap');
    }

    expect(RISK_CAP_EQUITY_FRACTIONS.max_position_size).toBeLessThan(
      D5_SINGLE_STOCK_ETP_DEPLOYMENT_FRACTION,
    );
  });
});
