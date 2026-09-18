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
  D5_SCALE_IN_HEADROOM_RESERVE_FRACTION,
  D5_SINGLE_STOCK_ETP_DEPLOYMENT_FRACTION,
} from '../../pipeline/trader/subclass-bracket.js';
import type { Clock, OrderIntent } from '../../shared/index.js';
import { liveStartingProfile } from './live-profile.js';
import {
  buildStartingProfileConfigs,
  LIVE_BOOK_GBP,
  RISK_CAP_EQUITY_FRACTIONS,
} from './paper-profile.js';
import type { UniverseInstrument } from './types.js';

const UNIVERSE: readonly UniverseInstrument[] = [
  { asset: '3USL', asset_class: 'stocks', subclass: 'index_etp_3x' },
  { asset: '3LAP', asset_class: 'stocks', subclass: 'single_stock_etp_3x' },
  { asset: 'BTC-USD', asset_class: 'crypto', subclass: 'crypto' },
];

const EQUITY = LIVE_BOOK_GBP;

const RESERVED = 1 - D5_SCALE_IN_HEADROOM_RESERVE_FRACTION;

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

const portfolioWith = (
  equity: number,
  exposure: Record<string, number>,
  reserved: Record<string, number> = {},
): PortfolioView => ({
  equity,
  peak_equity: equity,
  drawdown_pct: 0,
  exposure_by_instrument: exposure,
  exposure_by_class: {
    crypto: 0,
    stocks: Object.values(exposure).reduce((sum, e) => sum + e, 0),
  },
  gross_exposure: Object.values(exposure).reduce((sum, e) => sum + e, 0),
  reserved_exposure_by_instrument: reserved,
  reserved_exposure_by_class: {
    crypto: 0,
    stocks: Object.values(reserved).reduce((sum, e) => sum + e, 0),
  },
  reserved_gross_exposure: Object.values(reserved).reduce((sum, e) => sum + e, 0),
  daily_pnl: {
    crypto: { known: true, pct: 0 },
    stocks: { known: true, pct: 0 },
    portfolio: { known: true, pct: 0 },
  },
  consecutive_losses: 0,
  unvalued_instruments: [],
});

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
  decided_at: new Date('2026-08-19T14:35:00Z'),
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

const shippedConfig = (): RiskConfig => buildStartingProfileConfigs(UNIVERSE).riskConfig;

const liveShippedConfig = (): RiskConfig =>
  buildStartingProfileConfigs(UNIVERSE, LIVE_BOOK_GBP).riskConfig;

const d5InIsolation = (): RiskConfig => ({
  ...shippedConfig(),
  max_position_size_fraction_of_equity: 1e6,
  per_asset_cap_fraction_of_equity: 1e6,
  per_asset_class_cap_fraction_of_equity: { crypto: 1e6, stocks: 1e6 },
  portfolio_gross_cap_fraction_of_equity: 1e6,
  concentration: { cap_fraction_of_equity: 1e6, threshold: 0.7 },
});

const d5InIsolationLive = (): RiskConfig => ({
  ...liveShippedConfig(),
  max_position_size_fraction_of_equity: 1e6,
  per_asset_cap_fraction_of_equity: 1e6,
  per_asset_class_cap_fraction_of_equity: { crypto: 1e6, stocks: 1e6 },
  portfolio_gross_cap_fraction_of_equity: 1e6,
  concentration: { cap_fraction_of_equity: 1e6, threshold: 0.7 },
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
  it("arms the gate at the Trader's OWN fractions, unscaled", () => {
    const caps = shippedConfig().per_subclass_deployment_cap?.cap_fraction_of_equity;

    expect(caps?.index_etp_3x).toBe(D5_INDEX_ETP_DEPLOYMENT_FRACTION);
    expect(caps?.single_stock_etp_3x).toBe(D5_SINGLE_STOCK_ETP_DEPLOYMENT_FRACTION);
  });

  it('#888: only the LIVE profile carries equity_ceiling — paper is deliberately unbounded to the book', () => {
    expect(shippedConfig().per_subclass_deployment_cap?.equity_ceiling).toBeUndefined();
    expect(liveShippedConfig().per_subclass_deployment_cap?.equity_ceiling).toEqual({
      book: LIVE_BOOK_GBP,
      refuse_above_tolerance: expect.any(Number),
    });
    expect(
      liveShippedConfig().per_subclass_deployment_cap?.equity_ceiling?.same_currency_verified,
    ).toBeUndefined();
  });

  it('does NOT trim an armed entry sized at the FULL index envelope', () => {
    const intended = D5_INDEX_ETP_DEPLOYMENT_FRACTION * EQUITY;

    const decision = decide(d5InIsolation(), intentFor('3USL', intended, 'entry'));

    expect(decision.status).not.toBe('rejected');
    expect(decision.modifications?.final_size).toBeCloseTo(intended, 6);
    expect(decision.binding_constraint).not.toBe('per_subclass_deployment_cap');
  });

  it('does NOT trim an armed single-stock entry at its full envelope either', () => {
    const intended = D5_SINGLE_STOCK_ETP_DEPLOYMENT_FRACTION * EQUITY;

    const decision = decide(d5InIsolation(), intentFor('3LAP', intended, 'entry'));

    expect(decision.status).not.toBe('rejected');
    expect(decision.modifications?.final_size).toBeCloseTo(intended, 6);
    expect(decision.binding_constraint).not.toBe('per_subclass_deployment_cap');
  });

  it('still binds a subclass already deployed into — the gate is not disarmed', () => {
    const deployed = D5_INDEX_ETP_DEPLOYMENT_FRACTION * EQUITY * 0.5;

    const decision = decide(
      d5InIsolation(),
      intentFor('3USL', D5_INDEX_ETP_DEPLOYMENT_FRACTION * EQUITY, 'entry'),
      { '3USL': deployed },
    );

    expect(decision.binding_constraint).toBe('per_subclass_deployment_cap');
    expect(decision.modifications?.final_size).toBeCloseTo(deployed, 6);
  });

  it('#949 SUPERSEDES #888: the book-relative clamp is UNREACHABLE on the shipped live profile — currency mismatch refuses first', () => {
    const withinTolerance = LIVE_BOOK_GBP * 1.02;
    const intended = D5_INDEX_ETP_DEPLOYMENT_FRACTION * withinTolerance;

    expect(() =>
      decide(d5InIsolationLive(), intentFor('3USL', intended, 'entry'), {}, withinTolerance),
    ).toThrow(/currency mismatch, cannot verify funding/);
  });

  it('#949 SUPERSEDES #888: the far-overfunded refusal now reads as a currency problem, not an overfunding one — LIVE profile only', () => {
    const overfunded = 1_500;
    const intended = D5_INDEX_ETP_DEPLOYMENT_FRACTION * overfunded;

    expect(intended).toBeCloseTo(525, 6);
    expect(intended).toBeGreaterThan(D5_INDEX_ETP_DEPLOYMENT_FRACTION * LIVE_BOOK_GBP);

    try {
      decide(d5InIsolationLive(), intentFor('3USL', intended, 'entry'), {}, overfunded);
      expect.unreachable('expected liveBookCeiling to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toMatch(/currency mismatch, cannot verify funding/);
      expect(message).not.toMatch(/more than \d+% *above it/);
    }
  });

  it("#949: same_currency_verified: true restores liveBookCeiling's pre-#949 over-book refusal — the escape hatch this flag exists for", () => {
    const baseConfig = d5InIsolationLive();
    const baseLiveBookCeiling = baseConfig.live_book_ceiling;
    if (!baseLiveBookCeiling) {
      throw new Error('expected liveShippedConfig() to always set live_book_ceiling');
    }
    const withVerifiedBookCeiling: RiskConfig = {
      ...baseConfig,
      live_book_ceiling: { ...baseLiveBookCeiling, same_currency_verified: true },
    };
    const overfunded = 1_500;
    const intended = D5_INDEX_ETP_DEPLOYMENT_FRACTION * overfunded;

    try {
      decide(withVerifiedBookCeiling, intentFor('3USL', intended, 'entry'), {}, overfunded);
      expect.unreachable('expected liveBookCeiling to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toMatch(/more than \d+% *above it/);
      expect(message).not.toMatch(/currency mismatch, cannot verify funding/);
      expect((error as { bindingConstraint?: string }).bindingConstraint).toBe(
        'live_book_ceiling:equity_exceeds_book:3USL',
      );
    }
  });

  it('LEAVES room for a scale-in after the first fill — #897, resolved 2026-09-03', () => {
    const firstFill = D5_INDEX_ETP_DEPLOYMENT_FRACTION * RESERVED * EQUITY;
    const headroom = D5_INDEX_ETP_DEPLOYMENT_FRACTION * EQUITY - firstFill;

    const decision = decide(d5InIsolation(), intentFor('3USL', firstFill, 'scale_in'), {
      '3USL': firstFill,
    });

    expect(decision.status).not.toBe('rejected');
    expect(decision.modifications?.final_size).toBeCloseTo(headroom, 6);
    expect(decision.binding_constraint).toBe('per_subclass_deployment_cap');
    expect(headroom).toBeGreaterThan(shippedConfig().min_viable_size);
  });

  it('admits exactly ONE top-up, not a ladder — the second scale-in is rejected', () => {
    const full = D5_INDEX_ETP_DEPLOYMENT_FRACTION * EQUITY;
    const ask = D5_INDEX_ETP_DEPLOYMENT_FRACTION * RESERVED * EQUITY;

    const decision = decide(d5InIsolation(), intentFor('3USL', ask, 'scale_in'), {
      '3USL': full,
    });

    expect(decision.status).toBe('rejected');
    expect(decision.binding_constraint).toBe('min_viable_size');
  });

  it('leaves scale-in room on the single-stock row too, at a smaller slice', () => {
    const firstFill = D5_SINGLE_STOCK_ETP_DEPLOYMENT_FRACTION * RESERVED * EQUITY;
    const headroom = D5_SINGLE_STOCK_ETP_DEPLOYMENT_FRACTION * EQUITY - firstFill;

    const decision = decide(d5InIsolation(), intentFor('3LAP', firstFill, 'scale_in'), {
      '3LAP': firstFill,
    });

    expect(decision.status).not.toBe('rejected');
    expect(decision.modifications?.final_size).toBeCloseTo(headroom, 6);
    expect(decision.binding_constraint).toBe('per_subclass_deployment_cap');
    const indexHeadroom = D5_INDEX_ETP_DEPLOYMENT_FRACTION * EQUITY * (1 - RESERVED);
    expect(headroom).toBeLessThan(indexHeadroom);
  });

  it(
    '#888 review fix-up: liveStartingProfile() itself refuses an overfunded ' +
      'entry through the REAL composition root, with NO hand-classified universe',
    () => {
      const profile = liveStartingProfile(2_000);

      expect(profile.riskConfig.per_subclass_deployment_cap).toBeUndefined();

      expect(profile.riskConfig.live_book_ceiling).toEqual({
        book: LIVE_BOOK_GBP,
        refuse_above_tolerance: expect.any(Number),
      });

      const overfunded = 1_500;
      const spyIntent: OrderIntent = {
        ...intentFor('SPY', 100, 'entry'),
        asset_class: 'stocks',
      };

      expect(() =>
        new RiskManagerImpl(profile.riskConfig).evaluate({
          trace_id: 'trace-888-review',
          intent: spyIntent,
          clock: CLOCK,
          portfolio: portfolioWith(overfunded, {}),
          breakers: NO_BREAKERS,
          next_breaker_state: NO_PERSISTED_BREAKERS,
          correlation: NO_CORRELATION,
          cii: {},
          mode: 'live',
        }),
      ).toThrow(/currency mismatch, cannot verify funding/);

      const exitDecision = new RiskManagerImpl(profile.riskConfig).evaluate({
        trace_id: 'trace-888-review-exit',
        intent: { ...spyIntent, intent_type: 'exit' },
        clock: CLOCK,
        portfolio: portfolioWith(overfunded, { SPY: 100 }),
        breakers: NO_BREAKERS,
        next_breaker_state: NO_PERSISTED_BREAKERS,
        correlation: NO_CORRELATION,
        cii: {},
        mode: 'live',
      });
      expect(exitDecision.status).toBe('approved');
    },
  );

  it(
    '#949: a REALISTIC, genuinely correctly-funded £1,000 account refuses through the REAL live ' +
      'composition root — diagnosable as a currency problem, not an overfunding one',
    () => {
      const profile = liveStartingProfile(2_000);
      const genuinelyCorrectlyFundedReadAsUsd = 1_270;
      const spyIntent: OrderIntent = {
        ...intentFor('SPY', 100, 'entry'),
        asset_class: 'stocks',
      };

      try {
        new RiskManagerImpl(profile.riskConfig).evaluate({
          trace_id: 'trace-949-realistic',
          intent: spyIntent,
          clock: CLOCK,
          portfolio: portfolioWith(genuinelyCorrectlyFundedReadAsUsd, {}),
          breakers: NO_BREAKERS,
          next_breaker_state: NO_PERSISTED_BREAKERS,
          correlation: NO_CORRELATION,
          cii: {},
          mode: 'live',
        });
        expect.unreachable('expected liveBookCeiling to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        const message = (error as Error).message;
        expect(message).toMatch(/currency mismatch, cannot verify funding/);
        expect(message).not.toMatch(/more than \d+% *above it/);
        expect((error as { bindingConstraint?: string }).bindingConstraint).toBe(
          'live_book_ceiling:currency_mismatch:SPY',
        );
      }
    },
  );
});

describe('#886 fixed per_trade_size_cap for D5 instruments; #932 fixed per_asset_cap — neither cap trims a full-envelope D5 ask any more', () => {
  it('no longer trims a full-envelope D5 ask via the per-trade cap — that cap is EXEMPT for a classified instrument (#886)', () => {
    const intended = D5_INDEX_ETP_DEPLOYMENT_FRACTION * EQUITY;

    const decision = decide(shippedConfig(), intentFor('3USL', intended, 'entry'), {}, EQUITY);

    expect(decision.binding_constraint).not.toBe('per_trade_size_cap');
  });

  it('#932 FIXED: no longer trims a full-envelope D5 ask via per_asset_cap either', () => {
    const intended = D5_INDEX_ETP_DEPLOYMENT_FRACTION * EQUITY;

    const decision = decide(shippedConfig(), intentFor('3USL', intended, 'entry'), {}, EQUITY);

    expect(decision.status).toBe('approved');
    expect(decision.binding_constraint).not.toBe('per_asset_exposure_cap');
    expect(decision.binding_constraint).toBeNull();
    expect(decision.modifications?.final_size).toBeCloseTo(intended, 6);
  });

  it('the same holds for the single-stock subclass', () => {
    const intended = D5_SINGLE_STOCK_ETP_DEPLOYMENT_FRACTION * EQUITY;

    const decision = decide(shippedConfig(), intentFor('3LAP', intended, 'entry'), {}, EQUITY);

    expect(decision.status).toBe('approved');
    expect(decision.binding_constraint).not.toBe('per_asset_exposure_cap');
    expect(decision.binding_constraint).toBeNull();
    expect(decision.modifications?.final_size).toBeCloseTo(intended, 6);
  });

  it('is SCALE-INVARIANT — the fix holds at every book size, not just the reference book', () => {
    for (const equity of [200, LIVE_BOOK_GBP, 100_000]) {
      const decision = decide(
        shippedConfig(),
        intentFor('3USL', D5_INDEX_ETP_DEPLOYMENT_FRACTION * equity, 'entry'),
        {},
        equity,
      );

      expect(decision.status).toBe('approved');
      expect(decision.binding_constraint).not.toBe('per_asset_exposure_cap');
    }
  });

  it('does NOT leak the exemption to a NON-NUMERIC-fraction subclass — per_asset_cap still binds where D5 measured no envelope', () => {
    const perTradeCapLifted: RiskConfig = {
      ...shippedConfig(),
      max_position_size_fraction_of_equity: 1e6,
    };
    const cryptoIntent: OrderIntent = {
      ...intentFor('BTC-USD', 500, 'entry'),
      asset_class: 'crypto',
    };

    const decision = decide(perTradeCapLifted, cryptoIntent, {}, EQUITY);

    expect(decision.binding_constraint).toBe('per_asset_exposure_cap');
    expect(decision.modifications?.final_size).toBeCloseTo(
      RISK_CAP_EQUITY_FRACTIONS.per_asset_cap_fraction_of_equity * EQUITY,
      6,
    );
    expect(RISK_CAP_EQUITY_FRACTIONS.per_asset_cap_fraction_of_equity).toBeLessThan(
      D5_SINGLE_STOCK_ETP_DEPLOYMENT_FRACTION,
    );
  });

  it('#888: the LIVE profile is NOT scale-invariant above the book — the book ceiling refuses the entry first', () => {
    const equity = 100_000;

    expect(() =>
      decide(
        liveShippedConfig(),
        intentFor('3USL', D5_INDEX_ETP_DEPLOYMENT_FRACTION * equity, 'entry'),
        {},
        equity,
      ),
    ).toThrow(/currency mismatch, cannot verify funding/);
  });
});

describe('#886 acceptance criterion — an armed D5 entry lands at the intended size through the SHIPPED profile', () => {
  const CONVICTION_FACTOR = 0.2;

  const d5WithoutTheVenueGrid = (): RiskConfig => ({
    ...shippedConfig(),
    whole_share_sizing: false,
  });

  it('index_etp_3x: lands at the intended size at the reference book (£1,000)', () => {
    const intended = D5_INDEX_ETP_DEPLOYMENT_FRACTION * CONVICTION_FACTOR * EQUITY;

    const decision = decide(
      d5WithoutTheVenueGrid(),
      intentFor('3USL', intended, 'entry'),
      {},
      EQUITY,
    );

    expect(decision.status).toBe('approved');
    expect(decision.binding_constraint).toBeNull();
    expect(decision.modifications?.final_size).toBeCloseTo(intended, 6);
  });

  it('index_etp_3x: lands at the intended size BELOW the reference book too — there is no anchor left to fall below', () => {
    const equity = 200;
    const intended = D5_INDEX_ETP_DEPLOYMENT_FRACTION * CONVICTION_FACTOR * equity;

    const decision = decide(
      d5WithoutTheVenueGrid(),
      intentFor('3USL', intended, 'entry'),
      {},
      equity,
    );

    expect(decision.status).toBe('approved');
    expect(decision.binding_constraint).toBeNull();
    expect(decision.modifications?.final_size).toBeCloseTo(intended, 6);
  });

  it('single_stock_etp_3x: the same holds for the other D5 subclass, at and below the reference book', () => {
    for (const equity of [EQUITY, 200]) {
      const intended = D5_SINGLE_STOCK_ETP_DEPLOYMENT_FRACTION * CONVICTION_FACTOR * equity;

      const decision = decide(
        d5WithoutTheVenueGrid(),
        intentFor('3LAP', intended, 'entry'),
        {},
        equity,
      );

      expect(decision.status).toBe('approved');
      expect(decision.binding_constraint).toBeNull();
      expect(decision.modifications?.final_size).toBeCloseTo(intended, 6);
    }
  });

  it('the SHIPPED profile then quantises that same entry to the venue grid (#941)', () => {
    const intended = D5_INDEX_ETP_DEPLOYMENT_FRACTION * CONVICTION_FACTOR * EQUITY;

    const decision = decide(shippedConfig(), intentFor('3USL', intended, 'entry'), {}, EQUITY);

    expect(decision.status).toBe('approved');
    expect(decision.binding_constraint).toBeNull();
    expect(decision.modifications?.final_size).toBe(69);
  });
});

describe('#959 — multiple D5-armed instruments in the SAME subclass share one envelope, not one each', () => {
  const MULTI_UNIVERSE: readonly UniverseInstrument[] = [
    { asset: '3LTS', asset_class: 'stocks', subclass: 'single_stock_etp_3x' },
    { asset: 'NVD3', asset_class: 'stocks', subclass: 'single_stock_etp_3x' },
  ];

  const multiConfig = (): RiskConfig => buildStartingProfileConfigs(MULTI_UNIVERSE).riskConfig;

  const FULL_ENVELOPE = D5_SINGLE_STOCK_ETP_DEPLOYMENT_FRACTION * EQUITY;
  const PER_ASSET_CAP = RISK_CAP_EQUITY_FRACTIONS.per_asset_cap_fraction_of_equity * EQUITY;

  it('(a) neither instrument is capped individually at 10% via per_asset_cap — each lands ABOVE that ceiling, unclipped', () => {
    const half = FULL_ENVELOPE / 2;
    expect(half).toBeGreaterThan(PER_ASSET_CAP);

    const first = decide(multiConfig(), intentFor('3LTS', half, 'entry'), {}, EQUITY);
    expect(first.status).toBe('approved');
    expect(first.binding_constraint).toBeNull();
    expect(first.modifications?.final_size).toBeCloseTo(half, 6);

    const second = decide(
      multiConfig(),
      intentFor('NVD3', half, 'entry'),
      { '3LTS': half },
      EQUITY,
    );
    expect(second.status).toBe('approved');
    expect(second.binding_constraint).toBeNull();
    expect(second.modifications?.final_size).toBeCloseTo(half, 6);
    expect(second.modifications?.final_size).toBeGreaterThan(PER_ASSET_CAP);
  });

  it('(b) the combined exposure is bounded by the shared subclass envelope — a second instrument does NOT get its own independent 25%', () => {
    const alreadyDeployed = FULL_ENVELOPE * 0.6;
    const askedAsIfAlone = FULL_ENVELOPE;

    const decision = decide(
      multiConfig(),
      intentFor('NVD3', askedAsIfAlone, 'entry'),
      { '3LTS': alreadyDeployed },
      EQUITY,
    );

    expect(decision.status).toBe('approved');
    expect(decision.binding_constraint).toBe('per_subclass_deployment_cap');
    const expectedHeadroom = FULL_ENVELOPE - alreadyDeployed;
    expect(decision.modifications?.final_size).toBeCloseTo(expectedHeadroom, 6);
    expect(alreadyDeployed + (decision.modifications?.final_size ?? 0)).toBeCloseTo(
      FULL_ENVELOPE,
      6,
    );
    expect(decision.reasons).toEqual(
      expect.arrayContaining([expect.stringContaining('per_subclass_deployment_cap: trimmed')]),
    );
  });

  it('(b, exhausted case) once BOTH instruments together have consumed the shared envelope, a further entry in the subclass is rejected, not sized at its own 25%', () => {
    const eachHalf = FULL_ENVELOPE / 2;

    const decision = decide(
      multiConfig(),
      intentFor('3LTS', eachHalf, 'scale_in'),
      { '3LTS': eachHalf, NVD3: eachHalf },
      EQUITY,
    );

    expect(decision.status).toBe('rejected');
    expect(decision.binding_constraint).toBe('min_viable_size');
  });
});
