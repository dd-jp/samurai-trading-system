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
 * The second and third describes are #886's territory: David's ruling on
 * this ticket made D5 the sole drawdown authority for a classified
 * instrument, and exempted it from `per_trade_size_cap` entirely — resolved
 * against live `portfolio.equity` at evaluate time, with no boot-time anchor
 * left for the two sides to disagree about. `per_asset_cap_fraction_of_equity`
 * (10%) is NOT exempted, and is tighter than either D5 fraction (35%/25%), so
 * it remains a real, documented gap on a full-envelope ask — the second
 * describe pins that gap rather than hiding it. The third describe carries
 * #886's still-open acceptance criterion: an armed D5 entry lands at the
 * Trader's intended size through the SHIPPED profile, no cap lifted out of
 * the way, at the reference book and below it.
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

/**
 * The shipped profile's `RiskConfig`, for the classified `UNIVERSE`.
 *
 * #886 deleted the equity/ceiling anchor `buildStartingProfileConfigs` used
 * to take: every cap is now a FRACTION, resolved against whatever
 * `portfolio.equity` `decide()` is given below, so this config no longer
 * varies with the book size being traded — only the universe arms it.
 */
const shippedConfig = (): RiskConfig => buildStartingProfileConfigs(UNIVERSE).riskConfig;

/**
 * The LIVE profile's `RiskConfig` for the same classified `UNIVERSE` — the
 * one config that actually carries `per_subclass_deployment_cap.equity_ceiling`
 * (#888). `shippedConfig()` above is the PAPER wiring, and deliberately does
 * not: `d5EnvelopeFor` only sets the ceiling when a book is passed, and
 * `buildStartingProfileConfigs`'s only caller that passes one is
 * `liveStartingProfile` (live-profile.ts). Built directly from
 * `buildStartingProfileConfigs(UNIVERSE, LIVE_BOOK_GBP)` rather than via
 * `liveStartingProfile()` itself, so this file stays independent of the
 * capital-ceiling env var and the live-mode startup warning log.
 */
const liveShippedConfig = (): RiskConfig =>
  buildStartingProfileConfigs(UNIVERSE, LIVE_BOOK_GBP).riskConfig;

/**
 * The shipped config with every cap OTHER than D5 lifted out of the way.
 *
 * Necessary for the first describe below, which is about the D5 gate alone
 * agreeing with the Trader's own fractions — not about where the OTHER five
 * caps happen to sit. The lifted caps are named individually rather than
 * spread over, so a newly added cap does not silently join them. A fraction
 * of `1e6` rather than `Number.MAX_SAFE_INTEGER`: these are multiplied by
 * `portfolio.equity` now, and `1e6 x equity` stays comfortably inside the
 * safe integer range for every equity this file uses, which
 * `MAX_SAFE_INTEGER x equity` would not.
 */
const d5InIsolation = (): RiskConfig => ({
  ...shippedConfig(),
  max_position_size_fraction_of_equity: 1e6,
  per_asset_cap_fraction_of_equity: 1e6,
  per_asset_class_cap_fraction_of_equity: { crypto: 1e6, stocks: 1e6 },
  portfolio_gross_cap_fraction_of_equity: 1e6,
  concentration: { cap_fraction_of_equity: 1e6, threshold: 0.7 },
});

/** `d5InIsolation`, built off `liveShippedConfig()` — for the #888 tests below, which need `equity_ceiling` armed. */
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
    // The 2x itself, asserted where it lived: as an equality between the
    // Trader's named constants and the fractions the composition root hands
    // the gate. Under `EQUITY_LEG_FRACTION_OF_CAPITAL = 0.5` these differed by
    // exactly a factor of two, and no test compared them.
    const caps = shippedConfig().per_subclass_deployment_cap?.cap_fraction_of_equity;

    expect(caps?.index_etp_3x).toBe(D5_INDEX_ETP_DEPLOYMENT_FRACTION);
    expect(caps?.single_stock_etp_3x).toBe(D5_SINGLE_STOCK_ETP_DEPLOYMENT_FRACTION);
  });

  it('#888: only the LIVE profile carries equity_ceiling — paper is deliberately unbounded to the book', () => {
    // The regression this pins: an earlier version of `d5EnvelopeFor` set
    // `equity_ceiling` unconditionally for every caller, which would have
    // made every classified paper entry refuse against Alpaca's simulated
    // ~$100,000 balance. `buildStartingProfileConfigs`'s book argument is
    // `undefined` unless a caller supplies one, and `liveStartingProfile`
    // (live-profile.ts) is the only caller that does.
    expect(shippedConfig().per_subclass_deployment_cap?.equity_ceiling).toBeUndefined();
    expect(liveShippedConfig().per_subclass_deployment_cap?.equity_ceiling).toEqual({
      book: LIVE_BOOK_GBP,
      refuse_above_tolerance: expect.any(Number),
    });
  });

  it("does NOT trim an armed index entry sized at the Trader's intent", () => {
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

  it('#888 FIXED: caps against the BOOK once funded equity drifts moderately above it — LIVE profile only', () => {
    // The precondition the deletion of `EQUITY_LEG_FRACTION_OF_CAPITAL` rested
    // on, asserted rather than only written down. That constant was an
    // account -> leg conversion: `portfolio.equity` is the whole Alpaca
    // account (`production/account-state.ts:129`, one blended `GET /v2/account`
    // figure — there is no per-leg accounting and no Trading212Adapter),
    // while D5's fractions are of the LEG. Deleting it was correct exactly
    // while the funded equity equals the book — and #888 closed the gap that
    // left open above it: `d5EnvelopeFor` now hands the LIVE gate a live
    // `book / equity` conversion (`equity_ceiling`), exactly what #885's body
    // named as the repair, rather than a re-introduced static constant.
    //
    // `d5InIsolationLive()`, not `d5InIsolation()`: the ceiling is only ever
    // set for the live profile (see `d5EnvelopeFor`'s docstring, paper-profile.ts) —
    // a paper run's simulated ~$100,000 balance must never be clamped to the
    // £1,000 book, or every classified paper entry would refuse.
    //
    // Within `D5_BOOK_REFUSE_ABOVE_TOLERANCE` (5%) of the book, the gate caps
    // resolution AT the book instead of refusing outright — a small funding
    // drift (a dividend credit, a stray fee) should not halt trading.
    const withinTolerance = LIVE_BOOK_GBP * 1.02; // £1,020 — 2% over, inside the 5% tolerance
    const intended = D5_INDEX_ETP_DEPLOYMENT_FRACTION * withinTolerance; // £357, NOT what should size

    const decision = decide(
      d5InIsolationLive(),
      intentFor('3USL', intended, 'entry'),
      {},
      withinTolerance,
    );

    expect(decision.status).not.toBe('rejected');
    // Capped at the BOOK, not the account: 0.35 x £1,000 = £350, not 0.35 x
    // £1,020 = £357 — the overshoot the pre-#888 gate would have allowed.
    expect(decision.modifications?.final_size).toBeCloseTo(
      D5_INDEX_ETP_DEPLOYMENT_FRACTION * LIVE_BOOK_GBP,
      6,
    );
    expect(decision.binding_constraint).toBe('per_subclass_deployment_cap');
  });

  it('#888 FIXED: REFUSES the entry once funded equity clears the tolerance, rather than sizing on the wider figure — LIVE profile only', () => {
    // The scenario this test used to pin as the (undesired) status quo:
    // £1,500 funded on a £1,000 book, 50% over — far past the 5% tolerance.
    // Pre-#888 the same 35% resolved against the account: £525, not £350.
    // Post-#888 the gate refuses the entry outright rather than silently
    // widening it, per the chosen backstop (Option 2, combined with the
    // book-relative cap above as Option 1) — but only for the LIVE profile;
    // see `d5InIsolationLive()`.
    const overfunded = 1_500;
    const intended = D5_INDEX_ETP_DEPLOYMENT_FRACTION * overfunded;

    expect(intended).toBeCloseTo(525, 6);
    expect(intended).toBeGreaterThan(D5_INDEX_ETP_DEPLOYMENT_FRACTION * LIVE_BOOK_GBP);

    expect(() =>
      decide(d5InIsolationLive(), intentFor('3USL', intended, 'entry'), {}, overfunded),
    ).toThrow(/per_subclass_deployment_cap's declared book/);
  });

  it('leaves NO room for a scale-in once an entry took the full envelope — #897, unresolved', () => {
    // Recorded as behaviour, not asserted as desirable. `buildBracket` sizes a
    // `scale_in` exactly like an entry (decide.ts:391), so a first fill at the
    // full envelope leaves `allowedAdditional <= 0` and every scale-in is
    // trimmed to zero, then rejected under `min_viable_size`.
    //
    // Unscaling the cap neither caused this nor can fix it: it follows from
    // the Trader sizing ONE entry AT the whole envelope. Resolving it is a
    // Trader-side or ADR-0018 D5 decision — entries size below the envelope to
    // leave headroom, or scale-ins are ruled out for D5-capped subclasses —
    // and it is the half of #800 that survives David's capital ruling. #800
    // itself closed once its denominator question resolved; this gap is now
    // owned by #897, which must stay OPEN while this test asserts the gap.
    const full = D5_INDEX_ETP_DEPLOYMENT_FRACTION * EQUITY;

    const decision = decide(d5InIsolation(), intentFor('3USL', full, 'scale_in'), {
      '3USL': full,
    });

    expect(decision.status).toBe('rejected');
    expect(decision.binding_constraint).toBe('min_viable_size');
  });
});

describe('#886 fixed the per-trade cap for D5 instruments — per_asset_cap remains the unclosed gap', () => {
  it('no longer trims a full-envelope D5 ask via the per-trade cap — that cap is now EXEMPT for a classified instrument', () => {
    // The bug this ticket closed: pre-#886, `per_trade_size_cap` returned
    // `config.max_position_size` (5% of equity) for EVERY intent, classified
    // or not, and 5% < 35%/25% meant it always bound ahead of D5. It is now
    // `null` for a D5-classified instrument (`isD5ArmedWithNumericFraction`,
    // risk-manager/index.ts) regardless of the ask size.
    const intended = D5_INDEX_ETP_DEPLOYMENT_FRACTION * EQUITY; // the full envelope, £350

    const decision = decide(shippedConfig(), intentFor('3USL', intended, 'entry'), {}, EQUITY);

    expect(decision.binding_constraint).not.toBe('per_trade_size_cap');
  });

  it('still trims a full-envelope D5 ask — now via per_asset_cap, the gap #886 did not close', () => {
    // `per_asset_cap_fraction_of_equity` is 10% — tighter than either D5
    // fraction — and it was never a candidate for the same exemption: D5
    // caps DEPLOYMENT into one subclass, per_asset_cap caps EXPOSURE to one
    // instrument, and the two are not the same claim. Documented in
    // `paper-profile.ts` and `live-money-gates.ts` (#886's own entry) as the
    // gap this ticket left open, pinned here rather than only in prose.
    const intended = D5_INDEX_ETP_DEPLOYMENT_FRACTION * EQUITY; // £350

    const decision = decide(shippedConfig(), intentFor('3USL', intended, 'entry'), {}, EQUITY);

    expect(decision.binding_constraint).toBe('per_asset_exposure_cap');
    expect(decision.modifications?.final_size).toBeCloseTo(
      RISK_CAP_EQUITY_FRACTIONS.per_asset_cap_fraction_of_equity * EQUITY,
      6,
    );
  });

  it('is SCALE-INVARIANT — both caps are fractions of the same equity, so book size does not change which one binds', () => {
    // The property that replaces the retired "unreachable at every book size"
    // finding: 10% < 35% holds at every equity. Fixing the per-trade cap did
    // not touch this ordering.
    //
    // This runs through equity = 100,000 deliberately: `shippedConfig()` is
    // the PAPER wiring, which never sets `equity_ceiling` (#888 — the book
    // ceiling only ever arms for the LIVE profile, see
    // `d5-trader-cap-agreement.test.ts`'s `liveShippedConfig()` and
    // `d5EnvelopeFor`'s docstring in paper-profile.ts). A paper run's
    // simulated ~$100,000 balance must remain scale-invariant with this
    // ordering exactly as before #888 — that is the property #888's fix was
    // designed not to break.
    for (const equity of [200, LIVE_BOOK_GBP, 100_000]) {
      const decision = decide(
        shippedConfig(),
        intentFor('3USL', D5_INDEX_ETP_DEPLOYMENT_FRACTION * equity, 'entry'),
        {},
        equity,
      );

      expect(decision.binding_constraint).toBe('per_asset_exposure_cap');
    }

    expect(RISK_CAP_EQUITY_FRACTIONS.per_asset_cap_fraction_of_equity).toBeLessThan(
      D5_SINGLE_STOCK_ETP_DEPLOYMENT_FRACTION,
    );
  });

  it('#888: the LIVE profile is NOT scale-invariant above the book — the book ceiling refuses the entry first', () => {
    // The live-profile mirror of the scale-invariance test above: `liveShippedConfig()`
    // carries `equity_ceiling` (the book), so at equity = 100,000 (far past
    // the book and its 5% tolerance) D5's own ceiling now binds before
    // `per_asset_exposure_cap` is ever consulted — the gate refuses the entry
    // outright rather than sizing it against an account 100x the declared
    // book, which the pre-#888 gate would have done silently at whichever cap
    // was numerically tighter. This is deliberately asymmetric with the paper
    // case: a LIVE account funded 100x its declared book is a real anomaly to
    // refuse; a PAPER account simulated at $100,000 is normal and must not be
    // refused (previous test).
    const equity = 100_000;

    expect(() =>
      decide(
        liveShippedConfig(),
        intentFor('3USL', D5_INDEX_ETP_DEPLOYMENT_FRACTION * equity, 'entry'),
        {},
        equity,
      ),
    ).toThrow(/per_subclass_deployment_cap's declared book/);
  });
});

describe('#886 acceptance criterion — an armed D5 entry lands at the intended size through the SHIPPED profile', () => {
  // Not `d5InIsolation` — the point is that NOTHING is lifted out of the way.
  // `decide.ts:575` stacks `convictionMultiplier x non_converged_haircut x
  // cosine_multiplier` onto D5's fraction, so a real Trader ask is
  // `D5_fraction x M x equity` for M in (0, 1.5], not necessarily the full
  // envelope. `CONVICTION_FACTOR` picks an M under `per_asset_cap`'s 10%
  // ceiling (the one cap the describe above shows is still real for this
  // subclass), so this proves the FIX — D5 exempt from `per_trade_size_cap`
  // — at a size the shipped profile actually clears end to end, rather than
  // proving it only with five other caps manually disabled.
  const CONVICTION_FACTOR = 0.2;

  it('index_etp_3x: lands at the intended size at the reference book (£1,000)', () => {
    const intended = D5_INDEX_ETP_DEPLOYMENT_FRACTION * CONVICTION_FACTOR * EQUITY; // £70

    const decision = decide(shippedConfig(), intentFor('3USL', intended, 'entry'), {}, EQUITY);

    expect(decision.status).toBe('approved');
    expect(decision.binding_constraint).toBeNull();
    expect(decision.modifications?.final_size).toBeCloseTo(intended, 6);
  });

  it('index_etp_3x: lands at the intended size BELOW the reference book too — there is no anchor left to fall below', () => {
    // Pre-#886, `per_trade_size_cap` was a STATIC cash figure fixed at boot,
    // so this equity/anchor split was exactly where the fix mattered most
    // (`#886 — the ordering above is anchor-relative` used to assert the
    // BUG here). There is no boot-time anchor any more for the two to
    // diverge over — this is now a redundant check on that, not a live risk.
    const equity = 200; // inside ADR-0017's £100-200 ramp
    const intended = D5_INDEX_ETP_DEPLOYMENT_FRACTION * CONVICTION_FACTOR * equity; // £14

    const decision = decide(shippedConfig(), intentFor('3USL', intended, 'entry'), {}, equity);

    expect(decision.status).toBe('approved');
    expect(decision.binding_constraint).toBeNull();
    expect(decision.modifications?.final_size).toBeCloseTo(intended, 6);
  });

  it('single_stock_etp_3x: the same holds for the other D5 subclass, at and below the reference book', () => {
    for (const equity of [EQUITY, 200]) {
      const intended = D5_SINGLE_STOCK_ETP_DEPLOYMENT_FRACTION * CONVICTION_FACTOR * equity;

      const decision = decide(shippedConfig(), intentFor('3LAP', intended, 'entry'), {}, equity);

      expect(decision.status).toBe('approved');
      expect(decision.binding_constraint).toBeNull();
      expect(decision.modifications?.final_size).toBeCloseTo(intended, 6);
    }
  });
});
