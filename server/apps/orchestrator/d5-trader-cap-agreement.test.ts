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
 * left for the two sides to disagree about. Writing #886's own
 * acceptance-criteria test at a realistic (not full-envelope) ask size
 * surfaced that `per_asset_cap_fraction_of_equity` (10%) was NOT exempted by
 * #886 and is tighter than either D5 fraction (35%/25%), so a full-envelope
 * ask was still trimmed — just at a different gate — until #932 extended the
 * same exemption to `per_asset_cap`. The second describe now pins that FIX
 * (it used to pin the gap; the history is kept in its own comments rather
 * than deleted). The third describe carries #886's still-open acceptance
 * criterion: an armed D5 entry lands at the Trader's intended size through
 * the SHIPPED profile, no cap lifted out of the way, at the reference book
 * and below it.
 *
 * The last three tests of the first describe are #897's, resolved 2026-09-03:
 * the Trader's first tranche now sizes to `deployment x (1 -
 * headroom_reserve_fraction)` while this gate's cap stays at the full
 * fraction, so a scale-in is admissible. They used to be one test pinning the
 * opposite as a known gap.
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

/**
 * One classified instrument per D5 subclass, so the gate is armed, plus one
 * `crypto`-subclassed instrument — `D5_DEPLOYMENT_FRACTION_OF_EQUITY_LEG`
 * carries `null` for `crypto` (no measured envelope), so
 * `isD5ArmedWithNumericFraction` is false for it even though it IS
 * classified. Used below (#932) to prove the `per_asset_cap` exemption is
 * scoped to a NUMERIC D5 fraction, not to "classified at all".
 */
const UNIVERSE: readonly UniverseInstrument[] = [
  { asset: '3USL', asset_class: 'stocks', subclass: 'index_etp_3x' },
  { asset: '3LAP', asset_class: 'stocks', subclass: 'single_stock_etp_3x' },
  { asset: 'BTC-USD', asset_class: 'crypto', subclass: 'crypto' },
];

/** The book, per ADR-0015's 2026-08-18 amendment. */
const EQUITY = LIVE_BOOK_GBP;

/**
 * The share of a D5 envelope the FIRST tranche takes, per #897 — the rest is
 * the scale-in headroom the tests at the end of the first describe draw on.
 */
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
    // #949 — the shipped live profile does not (and today cannot) assert
    // `same_currency_verified`: no FX-rate provider or same-currency broker
    // adapter exists, so `d5EnvelopeFor` leaves it unset and the currency
    // guard stays armed on every real live tick. See the "#949" describe
    // block below for what that guard does.
    expect(
      liveShippedConfig().per_subclass_deployment_cap?.equity_ceiling?.same_currency_verified,
    ).toBeUndefined();
  });

  it('does NOT trim an armed entry sized at the FULL index envelope', () => {
    // **#897 (2026-09-03) changed what "the Trader's intent" means, and this
    // test deliberately did NOT follow it.** `riskFractionFor` now reserves
    // 10% of the envelope, so the largest size the Trader can emit for this
    // subclass is 31.5% of equity (£315), not 35% (£350). This test keeps
    // asking at the FULL £350 on purpose: the property under test is that
    // `per_subclass_deployment_cap` still ADMITS the whole envelope, which is
    // exactly what makes the reserved £35 reachable by a later `scale_in`
    // (see the "#897" describe below). Were this rescaled to £315 it would
    // stop witnessing the cap's ceiling at all, and the reserve would look
    // like a cap change rather than a Trader-side change.
    const intended = D5_INDEX_ETP_DEPLOYMENT_FRACTION * EQUITY; // £350 — the envelope, ABOVE one Trader ask

    const decision = decide(d5InIsolation(), intentFor('3USL', intended, 'entry'));

    expect(decision.status).not.toBe('rejected');
    expect(decision.modifications?.final_size).toBeCloseTo(intended, 6);
    expect(decision.binding_constraint).not.toBe('per_subclass_deployment_cap');
  });

  it('does NOT trim an armed single-stock entry at its full envelope either', () => {
    // Same reading as above: post-#897 one Trader ask tops out at £225, and
    // the £250 here is the envelope the cap must keep admitting.
    const intended = D5_SINGLE_STOCK_ETP_DEPLOYMENT_FRACTION * EQUITY; // £250 — the envelope

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

  it('#949 SUPERSEDES #888: the book-relative clamp is UNREACHABLE on the shipped live profile — currency mismatch refuses first', () => {
    // #888's clamp arithmetic (below, still real and still tested directly
    // against the gate in per-subclass-deployment-cap.test.ts's "#888"
    // describe block) required `same_currency_verified: true` to run at all,
    // once #949 added that guard — and `d5EnvelopeFor` (paper-profile.ts)
    // never sets it: the only caller that may is `armSameCurrencyCeilings`
    // (#1509), from a Saxo account read, on a venue that refuses `live`. So
    // on the ACTUAL shipped live profile this
    // clamp can never fire: `liveBookCeiling` (which sits first in
    // `ENTRY_CAP_GATES` and is unconditional once `live_book_ceiling` is
    // set) refuses on currency mismatch before `perSubclassDeploymentCap`'s
    // `equity_ceiling` is ever reached, at ANY equity — including this one,
    // £1,020 on a £1,000 book, which #888 previously clamped to £350.
    const withinTolerance = LIVE_BOOK_GBP * 1.02; // £1,020 — 2% over, inside the (now unreachable) 5% tolerance
    const intended = D5_INDEX_ETP_DEPLOYMENT_FRACTION * withinTolerance;

    expect(() =>
      decide(d5InIsolationLive(), intentFor('3USL', intended, 'entry'), {}, withinTolerance),
    ).toThrow(/currency mismatch, cannot verify funding/);
  });

  it('#949 SUPERSEDES #888: the far-overfunded refusal now reads as a currency problem, not an overfunding one — LIVE profile only', () => {
    // The scenario this test used to pin: £1,500 funded on a £1,000 book,
    // 50% over — far past the 5% tolerance. Pre-#888 the same 35% resolved
    // against the account: £525, not £350. #888 made the gate refuse this
    // outright rather than silently widen it; #949 changes WHY it refuses —
    // `liveBookCeiling` (first in `ENTRY_CAP_GATES`) now refuses on currency
    // mismatch BEFORE the £1,500-vs-£1,000 comparison is even made, so the
    // error is diagnosable as "cannot verify funding", not "you are
    // overfunded" — the misdiagnosis #949 was filed over, since a
    // correctly-funded £1,000 account reads as ~$1,270+ via Alpaca and would
    // have hit this exact "overfunded" message for being funded correctly.
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
      // The old over-book reason's distinguishing phrase must be absent.
      expect(message).not.toMatch(/more than \d+% *above it/);
    }
  });

  it("#949: same_currency_verified: true restores liveBookCeiling's pre-#949 over-book refusal — the escape hatch this flag exists for", () => {
    // The gap this pins: every test above that used to reach
    // `liveBookCeiling`'s `refuseAbove` comparison (the two `#949 SUPERSEDES
    // #888` tests, the `#888 review fix-up` test, and the `#888: the LIVE
    // profile is NOT scale-invariant` test) was rewritten to assert the NEW
    // currency-mismatch throw instead, which left the account-level
    // `equity_exceeds_book` throw itself with zero coverage anywhere in the
    // suite — a future edit could delete it and nothing would go red. The
    // per-subclass `equity_ceiling` mirror of this is still covered, via
    // `capWithCeiling`'s `same_currency_verified = true` default in
    // per-subclass-deployment-cap.test.ts's "#888" describe block; this is
    // the account-level counterpart.
    const baseConfig = d5InIsolationLive();
    const baseLiveBookCeiling = baseConfig.live_book_ceiling;
    if (!baseLiveBookCeiling) {
      throw new Error('expected liveShippedConfig() to always set live_book_ceiling');
    }
    const withVerifiedBookCeiling: RiskConfig = {
      ...baseConfig,
      live_book_ceiling: { ...baseLiveBookCeiling, same_currency_verified: true },
    };
    const overfunded = 1_500; // 50% over the £1,000 book — past the 5% tolerance
    const intended = D5_INDEX_ETP_DEPLOYMENT_FRACTION * overfunded;

    try {
      decide(withVerifiedBookCeiling, intentFor('3USL', intended, 'entry'), {}, overfunded);
      expect.unreachable('expected liveBookCeiling to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      // The pre-#949 over-book reason, not the currency-mismatch one.
      expect(message).toMatch(/more than \d+% *above it/);
      expect(message).not.toMatch(/currency mismatch, cannot verify funding/);
      expect((error as { bindingConstraint?: string }).bindingConstraint).toBe(
        'live_book_ceiling:equity_exceeds_book:3USL',
      );
    }
  });

  it('LEAVES room for a scale-in after the first fill — #897, resolved 2026-09-03', () => {
    // This test used to pin the OPPOSITE, as a recorded gap: pre-#897 the
    // Trader sized one entry AT the whole envelope, so `allowedAdditional <= 0`
    // from the first fill onward and every scale-in was trimmed to zero and
    // rejected under `min_viable_size`. David ruled that accidental (option 2
    // on #897) — D5 is an envelope to draw on, not a per-position-and-done
    // budget — and `riskFractionFor` now sizes the first tranche at
    // `deployment x (1 - headroom_reserve_fraction)`.
    //
    // The reserve lives on the TRADER side only. This gate's
    // `cap_fraction_of_equity` is deliberately still the full 0.35, which is
    // exactly what makes the reserved slice reachable here; applying the
    // reserve to the cap as well would move the ceiling down with the entry
    // and leave nothing to scale into.
    //
    // What this test does NOT cover: `whole_share_sizing`'s one-share floor.
    // `intentFor` prices every share at £1 (`entry: 1`), so £35 of headroom is
    // 35 whole shares here regardless of what an LSE ETP actually costs. The
    // per-share ceiling the reserve implies is recorded on
    // `SubclassBracket.headroom_reserve_fraction`, not asserted anywhere.
    const firstFill = D5_INDEX_ETP_DEPLOYMENT_FRACTION * RESERVED * EQUITY; // £315
    const headroom = D5_INDEX_ETP_DEPLOYMENT_FRACTION * EQUITY - firstFill; // £35

    const decision = decide(d5InIsolation(), intentFor('3USL', firstFill, 'scale_in'), {
      '3USL': firstFill,
    });

    expect(decision.status).not.toBe('rejected');
    // Trimmed to the reserved headroom EXACTLY, and by the D5 gate — "not
    // rejected" alone would also pass if the cap had stopped binding at all,
    // which is the failure the "#800" describe above guards against by name.
    expect(decision.modifications?.final_size).toBeCloseTo(headroom, 6);
    expect(decision.binding_constraint).toBe('per_subclass_deployment_cap');
    expect(headroom).toBeGreaterThan(shippedConfig().min_viable_size);
  });

  it('admits exactly ONE top-up, not a ladder — the second scale-in is rejected', () => {
    // The other half of #897's resolution, and what keeps it consistent with
    // #708's rejection of the tranche ladder: once the reserved slice is
    // consumed the envelope is genuinely spent, and a further scale-in trims to
    // zero and is rejected under `min_viable_size` exactly as before. The
    // reserve buys one tranche of headroom, not an open-ended schedule.
    const full = D5_INDEX_ETP_DEPLOYMENT_FRACTION * EQUITY; // £350 — first fill plus its top-up
    const ask = D5_INDEX_ETP_DEPLOYMENT_FRACTION * RESERVED * EQUITY;

    const decision = decide(d5InIsolation(), intentFor('3USL', ask, 'scale_in'), {
      '3USL': full,
    });

    expect(decision.status).toBe('rejected');
    expect(decision.binding_constraint).toBe('min_viable_size');
  });

  it('leaves scale-in room on the single-stock row too, at a smaller slice', () => {
    // Per-subclass, so it has to hold on both rows — and the single-stock row
    // reserves LESS cash (£25 against £35) despite the identical 10% reserve,
    // because it reserves 10% of a smaller envelope. That ordering is why the
    // single-stock row is the one that loses admissibility first as equity
    // falls (boundary £400 against £285.71 — see
    // `SubclassBracket.headroom_reserve_fraction`).
    const firstFill = D5_SINGLE_STOCK_ETP_DEPLOYMENT_FRACTION * RESERVED * EQUITY; // £225
    const headroom = D5_SINGLE_STOCK_ETP_DEPLOYMENT_FRACTION * EQUITY - firstFill; // £25

    const decision = decide(d5InIsolation(), intentFor('3LAP', firstFill, 'scale_in'), {
      '3LAP': firstFill,
    });

    expect(decision.status).not.toBe('rejected');
    expect(decision.modifications?.final_size).toBeCloseTo(headroom, 6);
    expect(decision.binding_constraint).toBe('per_subclass_deployment_cap');
    const indexHeadroom = D5_INDEX_ETP_DEPLOYMENT_FRACTION * EQUITY * (1 - RESERVED); // £35
    expect(headroom).toBeLessThan(indexHeadroom);
  });

  it(
    '#888 review fix-up: liveStartingProfile() itself refuses an overfunded ' +
      'entry through the REAL composition root, with NO hand-classified universe',
    () => {
      // The gap the review found: every #888 test above builds `RiskConfig`
      // from a hand-classified `UNIVERSE` fixture passed DIRECTLY to
      // `buildStartingProfileConfigs`, bypassing `liveStartingProfile()`
      // entirely — so nothing exercised the actual shipped live composition
      // root, which calls `buildStartingProfileConfigs(undefined,
      // LIVE_BOOK_GBP)` and therefore defaults to `DEFAULT_UNIVERSE`
      // (scheduler.ts), which carries NO subclass classification today.
      // `d5EnvelopeFor` returns `undefined` for an unclassified universe
      // (paper-profile.ts), so `per_subclass_deployment_cap` — and with it
      // `equity_ceiling` — is `undefined` on the real path, proven below.
      const profile = liveStartingProfile(2_000);

      expect(profile.riskConfig.per_subclass_deployment_cap).toBeUndefined();

      // Yet the account-level `live_book_ceiling` (this review's fix) is
      // armed regardless — it does not read `subclass_of` at all.
      expect(profile.riskConfig.live_book_ceiling).toEqual({
        book: LIVE_BOOK_GBP,
        refuse_above_tolerance: expect.any(Number),
      });

      // An account funded well past the book (£1,500 on a £1,000 book, 50%
      // over) refuses the entry outright through the real live profile, on
      // an instrument `DEFAULT_UNIVERSE` never classifies (SPY), proving the
      // refusal does not depend on the pool file at all. #949 — the reason
      // is now `currency_mismatch`, not `equity_exceeds_book`: see the "#949"
      // test below for why that distinction is load-bearing at THIS value.
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

      // And an exit is unaffected — the gate lives in `ENTRY_CAP_GATES`,
      // below the exit early-return, not ahead of it.
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
      // The exact scenario #949 was filed over, through the actual shipped
      // live composition root (not a hand-built fixture): at typical
      // GBP/USD rates (~1.25-1.35), a correctly-funded £1,000 book reads as
      // roughly $1,250-$1,350 over Alpaca's `GET /v2/account` — already past
      // `live_book_ceiling`'s 5% tolerance (£1,050) under a naive same-units
      // comparison, so the PRE-#949 gate would have refused this CORRECTLY
      // FUNDED account with "your account is overfunded", which is false.
      // 1,270 sits squarely in that band.
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
        // Diagnosable as a currency problem...
        expect(message).toMatch(/currency mismatch, cannot verify funding/);
        // ...NOT as an overfunding one — the old reason's distinguishing
        // phrase, which would have told the operator to re-fund an account
        // that is already correctly funded, must be absent.
        expect(message).not.toMatch(/more than \d+% *above it/);
        expect((error as { bindingConstraint?: string }).bindingConstraint).toBe(
          'live_book_ceiling:currency_mismatch:SPY',
        );
      }
    },
  );
});

describe('#886 fixed per_trade_size_cap for D5 instruments; #932 fixed per_asset_cap — neither cap trims a full-envelope D5 ask any more', () => {
  // HISTORY, kept rather than deleted: this describe used to be titled
  // "#886 fixed the per-trade cap for D5 instruments — per_asset_cap remains
  // the unclosed gap", and its second test used to PIN the #932 bug (asserted
  // `binding_constraint` was `'per_asset_exposure_cap'` and the final size was
  // trimmed to 10% of equity, not D5's 35%/25%). David's #932 ruling extended
  // #886's reasoning — "D5's own fraction is the sole drawdown authority once
  // an instrument is subclass-classified" — from `per_trade_size_cap` to
  // `per_asset_cap` too, since both are per-instrument axes even though they
  // cap different claims (deployment vs. exposure). `perAssetExposureCap`
  // (risk-manager/index.ts) now also skips a D5-classified instrument
  // entirely, via the same `isD5ArmedWithNumericFraction` predicate.

  it('no longer trims a full-envelope D5 ask via the per-trade cap — that cap is EXEMPT for a classified instrument (#886)', () => {
    // The bug this ticket closed: pre-#886, `per_trade_size_cap` returned
    // `config.max_position_size` (5% of equity) for EVERY intent, classified
    // or not, and 5% < 35%/25% meant it always bound ahead of D5. It is now
    // `null` for a D5-classified instrument (`isD5ArmedWithNumericFraction`,
    // risk-manager/index.ts) regardless of the ask size.
    const intended = D5_INDEX_ETP_DEPLOYMENT_FRACTION * EQUITY; // the full envelope, £350

    const decision = decide(shippedConfig(), intentFor('3USL', intended, 'entry'), {}, EQUITY);

    expect(decision.binding_constraint).not.toBe('per_trade_size_cap');
  });

  it('#932 FIXED: no longer trims a full-envelope D5 ask via per_asset_cap either', () => {
    // `per_asset_cap_fraction_of_equity` is 10% — tighter than either D5
    // fraction — and #886 correctly left it alone: D5 caps DEPLOYMENT into
    // one subclass, per_asset_cap caps EXPOSURE to one instrument, and the
    // two are not the same claim. But the practical consequence was the same
    // shape #886 fixed, so #932 extended the exemption here too. The entry
    // now lands at D5's own fraction, unmodified, with NO binding constraint
    // at all — nothing in `ENTRY_CAP_GATES` trims an exactly-full-envelope ask.
    const intended = D5_INDEX_ETP_DEPLOYMENT_FRACTION * EQUITY; // £350

    const decision = decide(shippedConfig(), intentFor('3USL', intended, 'entry'), {}, EQUITY);

    expect(decision.status).toBe('approved');
    expect(decision.binding_constraint).not.toBe('per_asset_exposure_cap');
    expect(decision.binding_constraint).toBeNull();
    expect(decision.modifications?.final_size).toBeCloseTo(intended, 6);
  });

  it('the same holds for the single-stock subclass', () => {
    const intended = D5_SINGLE_STOCK_ETP_DEPLOYMENT_FRACTION * EQUITY; // £250

    const decision = decide(shippedConfig(), intentFor('3LAP', intended, 'entry'), {}, EQUITY);

    expect(decision.status).toBe('approved');
    expect(decision.binding_constraint).not.toBe('per_asset_exposure_cap');
    expect(decision.binding_constraint).toBeNull();
    expect(decision.modifications?.final_size).toBeCloseTo(intended, 6);
  });

  it('is SCALE-INVARIANT — the fix holds at every book size, not just the reference book', () => {
    // This runs through equity = 100,000 deliberately: `shippedConfig()` is
    // the PAPER wiring, which never sets `equity_ceiling` (#888 — the book
    // ceiling only ever arms for the LIVE profile, see
    // `d5-trader-cap-agreement.test.ts`'s `liveShippedConfig()` and
    // `d5EnvelopeFor`'s docstring in paper-profile.ts). A paper run's
    // simulated ~$100,000 balance must remain scale-invariant with this
    // ordering exactly as before #888 — that is the property #888's fix was
    // designed not to break, and #932's fix does not touch either.
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
    // The exemption is scoped to `isD5ArmedWithNumericFraction`, not to
    // "has a `subclass_of` entry". `BTC-USD` IS classified (`crypto`), but
    // `D5_DEPLOYMENT_FRACTION_OF_EQUITY_LEG.crypto` is `null` — no measured
    // envelope — so `per_asset_cap` must still bind for it exactly as it
    // always has, proving #932's fix is scoped to a NUMERIC D5 fraction
    // rather than widening the cap for every classified instrument.
    //
    // `max_position_size_fraction_of_equity` (5%) is lifted here, and ONLY
    // that: it is tighter than `per_asset_cap_fraction_of_equity` (10%) and
    // sits ahead of it in `ENTRY_CAP_GATES`, so for a NON-exempt instrument it
    // always binds first and `per_asset_cap` could never be observed to bind
    // at all — true before #932 too, and not the property under test here.
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
    // The live-profile mirror of the scale-invariance test above:
    // `liveShippedConfig()` carries both `equity_ceiling` (per-subclass) and
    // `live_book_ceiling` (account-level, review fix-up), so at equity =
    // 100,000 (far past the book and its 5% tolerance) a book ceiling now
    // binds before `per_asset_exposure_cap` is ever consulted — the gate
    // refuses the entry outright rather than sizing it against an account
    // 100x the declared book, which the pre-#888 gate would have done
    // silently at whichever cap was numerically tighter. This is deliberately
    // asymmetric with the paper case: a LIVE account funded 100x its declared
    // book is a real anomaly to refuse; a PAPER account simulated at $100,000
    // is normal and must not be refused (previous test).
    //
    // **Review fix-up: the throw comes from `liveBookCeiling`, the
    // account-level gate, which sits first in `ENTRY_CAP_GATES` — not from
    // `perSubclassDeploymentCap`'s `equity_ceiling`.** Both are armed here,
    // but `liveBookCeiling` is the one that also covers `DEFAULT_UNIVERSE`
    // (no classification), which is why it goes first.
    //
    // #949 — the refusal now fires as `currency_mismatch`, before the
    // 100,000-vs-book comparison is even made; see the "#949" describe block
    // for why that is the correct reading at every equity, not just this one.
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
  // Not `d5InIsolation` — the point is that NOTHING is lifted out of the way.
  // `decide.ts:575` stacks `convictionMultiplier x non_converged_haircut x
  // cosine_multiplier` onto D5's fraction, so a real Trader ask is
  // `D5_fraction x M x equity` for M in (0, 1.5], not necessarily the full
  // envelope. `CONVICTION_FACTOR` picks an M under `per_asset_cap`'s 10%
  // ceiling (the one cap the describe above shows is still real for this
  // subclass), so this proves the FIX — D5 exempt from `per_trade_size_cap`
  // — at a size the shipped profile actually clears end to end, rather than
  // proving it only with five other caps manually disabled.
  //
  // **Post-#897 note.** `riskFractionFor` now multiplies by
  // `(1 - headroom_reserve_fraction)`, so a real full-conviction ask is
  // `D5_fraction x 0.9 x equity`. That does NOT change what this describe
  // measures: `M` here is an arbitrary conviction multiplier well under 1,
  // the ask is hand-constructed rather than read off the Trader, and the
  // property is that no cap in the shipped profile trims whatever the Trader
  // asks for. Rescaling `CONVICTION_FACTOR` by the reserve would just pick a
  // different arbitrary M and prove the same thing.
  const CONVICTION_FACTOR = 0.2;

  /**
   * The shipped config with the venue's whole-share grid (#941) lifted, and
   * ONLY that.
   *
   * `intentFor` models size as a cash amount at `entry: 1`, which is what lets
   * these tests state the D5 arithmetic in pounds. Under
   * `whole_share_sizing` that fixture's "share" is a pound, so £69.99 of
   * envelope floors to £69 and the assertion below stops being about the cap
   * arithmetic it exists to pin. The grid itself is tested where it belongs,
   * in `risk-manager/index.test.ts`, and its interaction with the shipped
   * profile is pinned by the last test in this describe.
   */
  const d5WithoutTheVenueGrid = (): RiskConfig => ({
    ...shippedConfig(),
    whole_share_sizing: false,
  });

  it('index_etp_3x: lands at the intended size at the reference book (£1,000)', () => {
    const intended = D5_INDEX_ETP_DEPLOYMENT_FRACTION * CONVICTION_FACTOR * EQUITY; // £70

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
    // Pre-#886, `per_trade_size_cap` was a STATIC cash figure fixed at boot,
    // so this equity/anchor split was exactly where the fix mattered most
    // (`#886 — the ordering above is anchor-relative` used to assert the
    // BUG here). There is no boot-time anchor any more for the two to
    // diverge over — this is now a redundant check on that, not a live risk.
    const equity = 200; // inside ADR-0017's £100-200 ramp
    const intended = D5_INDEX_ETP_DEPLOYMENT_FRACTION * CONVICTION_FACTOR * equity; // £14

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
    // The one thing `d5WithoutTheVenueGrid` lifts, asserted rather than
    // assumed: nothing above changes which cap binds, the approved size is
    // just floored on the way out. `69` and not `70` because
    // `0.35 * 0.2 * 1000` is 69.99999999999999 in IEEE-754 — the floor is
    // toward less exposure even when the shortfall is a float artefact.
    const intended = D5_INDEX_ETP_DEPLOYMENT_FRACTION * CONVICTION_FACTOR * EQUITY;

    const decision = decide(shippedConfig(), intentFor('3USL', intended, 'entry'), {}, EQUITY);

    expect(decision.status).toBe('approved');
    expect(decision.binding_constraint).toBeNull();
    expect(decision.modifications?.final_size).toBe(69);
  });
});

describe('#959 — multiple D5-armed instruments in the SAME subclass share one envelope, not one each', () => {
  // #932 exempts a D5-classified instrument from `per_asset_cap` entirely
  // (above) — a single instrument reaches D5's own fraction unbound by the
  // 10% per-asset ceiling. `perSubclassDeploymentCap` (risk-manager/index.ts)
  // nets `deployedToSubclass` across every instrument the pool file
  // classifies into the intent's subclass, not just the intent's own
  // instrument, so a SECOND D5-armed instrument in the same subclass shares
  // that envelope rather than getting its own independent 25%. This describe
  // block covers the concurrent-instrument case.
  //
  // Two REAL `single_stock_etp_3x` tickers from the actual pool
  // (lse-etp-pool.ts) rather than the single-instrument-per-subclass
  // `UNIVERSE` fixture above: `3LTS` (GraniteShares 3x Long Tesla) and
  // `NVD3` (Leverage Shares 3x NVIDIA). `single_stock_etp_3x` is chosen over
  // `index_etp_3x` because its fraction (0.25) keeps every figure below
  // integral on the £1,000 reference book, so `whole_share_sizing` never
  // bites and no `d5WithoutTheVenueGrid`-style variant is needed.
  const MULTI_UNIVERSE: readonly UniverseInstrument[] = [
    { asset: '3LTS', asset_class: 'stocks', subclass: 'single_stock_etp_3x' },
    { asset: 'NVD3', asset_class: 'stocks', subclass: 'single_stock_etp_3x' },
  ];

  const multiConfig = (): RiskConfig => buildStartingProfileConfigs(MULTI_UNIVERSE).riskConfig;

  /**
   * D5's own fraction for `single_stock_etp_3x` — £250 on the £1,000 book.
   *
   * The ENVELOPE, which post-#897 is larger than any single Trader ask
   * (£225); as in the #800 describe above, these tests probe the shared cap's
   * ceiling deliberately, not the Trader's emitted size.
   */
  const FULL_ENVELOPE = D5_SINGLE_STOCK_ETP_DEPLOYMENT_FRACTION * EQUITY;
  const PER_ASSET_CAP = RISK_CAP_EQUITY_FRACTIONS.per_asset_cap_fraction_of_equity * EQUITY; // £100

  it('(a) neither instrument is capped individually at 10% via per_asset_cap — each lands ABOVE that ceiling, unclipped', () => {
    // This proves the #932 per-asset-cap exemption applies independently to
    // a SECOND D5-armed instrument in the subclass, not just the first: each
    // half (£125) is above the £100 per-asset ceiling that would have bound
    // it pre-#932, and both land unclipped. Asserting the landed size is
    // strictly greater than `PER_ASSET_CAP`, not merely "not that binding
    // constraint", closes the tautology a size-under-10% fixture would leave
    // open (per this file's own precedent at
    // `RISK_CAP_EQUITY_FRACTIONS.per_asset_cap_fraction_of_equity`, above).
    //
    // This test does NOT discriminate combined-subclass netting from
    // isolated per-instrument accounting: NVD3's £125 ask fits under £250
    // headroom either way (isolated: NVD3 alone has no prior exposure of its
    // own; combined: £250 envelope - £125 already deployed by 3LTS = £125
    // remaining). Test (b), below, asks for MORE than the true combined
    // headroom — that is what actually proves netting.
    const half = FULL_ENVELOPE / 2; // £125 — 12.5% of equity, over the 10% per-asset ceiling
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
    // `3LTS` already holds £150 (15% of equity — itself above the 10%
    // per-asset ceiling, proving the #932 exemption still applies to IT
    // individually). `NVD3` then asks for D5's FULL envelope (£250), as if it
    // were the only instrument armed in the subclass. If the two instruments
    // were bounded independently, `NVD3` would land at the full £250
    // (combined 3LTS + NVD3 = £400, 40% of equity — well past the 25%
    // subclass envelope D5's 41.8% drawdown figure was measured to hold).
    // `perSubclassDeploymentCap` nets across BOTH instruments instead, so the
    // remaining headroom is £250 (cap) - £150 (already deployed) = £100, and
    // `NVD3` is trimmed to exactly that — not to its own 25%.
    const alreadyDeployed = FULL_ENVELOPE * 0.6; // £150
    const askedAsIfAlone = FULL_ENVELOPE; // £250 — what NVD3 would land at if uncapped by the shared envelope

    const decision = decide(
      multiConfig(),
      intentFor('NVD3', askedAsIfAlone, 'entry'),
      { '3LTS': alreadyDeployed },
      EQUITY,
    );

    expect(decision.status).toBe('approved');
    expect(decision.binding_constraint).toBe('per_subclass_deployment_cap');
    const expectedHeadroom = FULL_ENVELOPE - alreadyDeployed; // £100
    expect(decision.modifications?.final_size).toBeCloseTo(expectedHeadroom, 6);
    // The combined exposure across both instruments, after this fill, is
    // exactly the shared envelope — never the doubled £400 independent
    // bounding would have allowed.
    expect(alreadyDeployed + (decision.modifications?.final_size ?? 0)).toBeCloseTo(
      FULL_ENVELOPE,
      6,
    );
    expect(decision.reasons).toEqual(
      expect.arrayContaining([expect.stringContaining('per_subclass_deployment_cap: trimmed')]),
    );
  });

  it('(b, exhausted case) once BOTH instruments together have consumed the shared envelope, a further entry in the subclass is rejected, not sized at its own 25%', () => {
    // Combined £250 already deployed across the two names (any split), the
    // subclass envelope is fully consumed — a third ask in the SAME subclass
    // (here, a scale-in on `3LTS`) gets zero headroom from
    // `per_subclass_deployment_cap` and is rejected as dust, exactly the
    // shape `#897`'s single-instrument scale-in test pins for one name. The
    // `binding_constraint` on the returned decision names `min_viable_size`,
    // not `per_subclass_deployment_cap`, because `evaluate()`'s dust-floor
    // check overwrites it once notional is trimmed to zero — matching this
    // file's existing `#897` precedent above.
    const eachHalf = FULL_ENVELOPE / 2; // £125 + £125 = £250, the full shared envelope

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
