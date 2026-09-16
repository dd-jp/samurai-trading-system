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

/** A £750 equity leg, so the caps below are ADR-0018 D5's own figures */
const EQUITY_LEG = 750;
const INDEX_CAP = 0.35 * EQUITY_LEG; // 262.50 — D5's "~£260"
const SINGLE_STOCK_CAP = 0.25 * EQUITY_LEG; // 187.50 — D5's "~£190"

/**
 * The equity every case below is decided against. The caps are declared as
 * FRACTIONS of it (#739), so the cash figures above are what the gate resolves
 * to at this equity rather than what it stores — which is the whole change: a
 * frozen amount is a rising fraction of a falling book.
 */
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

/**
 * Every other cap set far above D5's (1000x equity, so it never binds
 * regardless of the fixture's equity), so the subclass gate is the one that
 * can bind and `binding_constraint` is unambiguous. The "does it bind in a
 * real profile" question is a separate test below.
 */
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
  /**
   * Submitted-but-unfilled notional (#1019) — the write-ahead rows a fill
   * poll has not yet advanced. Kept as a separate argument, not folded into
   * `exposure`, because the whole question these tests ask is whether the
   * gate nets the two together.
   */
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
  // `known: true` throughout: an unknown daily P&L is its own rejection
  // (`daily_pnl_unknown:portfolio`), and every assertion here is about which
  // CAP bound the size, so nothing upstream of the caps may reject first
  daily_pnl: {
    crypto: { known: true, pct: 0 },
    stocks: { known: true, pct: 0 },
    portfolio: { known: true, pct: 0 },
  },
  consecutive_losses: 0,
  unvalued_instruments: [],
});

const CLOCK: Clock = { now: () => new Date('2026-08-19T14:35:00Z') };

/** Nothing tripped, so no breaker can pre-empt the cap under test */
const NO_PERSISTED_BREAKERS: PersistedBreakerState[] = [
  { tier: 'portfolio_drawdown', tripped: false, tripped_at: null, reset_at: null, reason: null },
  { tier: 'kill_switch', tripped: false, tripped_at: null, reset_at: null, reason: null },
];

/** One entry at $1/share, so `size` reads directly as notional */
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
  // `null` means "declare no envelope". Not `undefined`, which a default
  // parameter cannot distinguish from an omitted argument
  cap: SubclassDeploymentCap | null = DEPLOYMENT_CAP,
  equity: number = PORTFOLIO_EQUITY,
  /** Submitted-but-unfilled notional (#1019) — see `portfolioWith` */
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

/**
 * `modifications` is null on a REJECTED decision, so an unguarded
 * `decision.modifications.final_size` would fail with a null property access
 * rather than by naming the decision that actually arrived. Every assertion
 * below is about a size, so a rejection is always the more interesting news.
 */
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
    // Both instruments are `asset_class: 'stocks'`. If the gate were keyed on
    // asset class rather than subclass, these two would get the same envelope
    // and D5 would be unimplemented while looking implemented
    const decision = decide(intentFor('3LAP', 10_000));

    expect(finalSizeOf(decision)).toBeCloseTo(SINGLE_STOCK_CAP, 6);
    expect(SINGLE_STOCK_CAP).toBeLessThan(INDEX_CAP);
  });

  it('resolves the envelope against the equity read of THIS decision, not a frozen amount', () => {
    // The discriminator for #739, and the only assertion a fixed-cash
    // regression cannot also pass: same intent, same config, two equity reads
    // A frozen £262 is 34.9% of a £750 book and 58.2% of a £450 one, so under
    // the old form exposure rises as a fraction of equity exactly as equity
    // falls and the drawdown bound stops bounding at the first loss
    const full = decide(intentFor('3USL', 10_000), {}, DEPLOYMENT_CAP, PORTFOLIO_EQUITY);
    const halved = decide(intentFor('3USL', 10_000), {}, DEPLOYMENT_CAP, PORTFOLIO_EQUITY / 2);

    expect(finalSizeOf(full)).toBeCloseTo(INDEX_CAP, 6);
    expect(finalSizeOf(halved)).toBeCloseTo(INDEX_CAP / 2, 6);
    expect(finalSizeOf(halved)).toBeLessThan(finalSizeOf(full));
    expect(halved.binding_constraint).toBe('per_subclass_deployment_cap');
  });

  it('nets across every instrument of the subclass, not per position', () => {
    // The defect this test exists for: `allowedAdditional: cap` (the
    // `perTradeSizeCap` shape) would let a second index ETP take the FULL
    // envelope again, putting 70% of the leg into a subclass measured to hold
    // 23.1% drawdown at 35%. Two different tickers, one envelope.
    const decision = decide(intentFor('3UKL', 10_000), { '3USL': 200 });

    expect(finalSizeOf(decision)).toBeCloseTo(INDEX_CAP - 200, 6);
  });

  it('nets a scale_in against the position it adds to', () => {
    // `buildBracket` sizes a scale_in exactly like an entry because "Risk
    // enforces the exposure cap downstream" (trader/decide.ts). Entry at the
    // full envelope followed by a scale_in at the full envelope is the other
    // route to double deployment
    const scaleIn = { ...intentFor('3USL', 10_000), intent_type: 'scale_in' as const };
    const decision = decide(scaleIn, { '3USL': INDEX_CAP });

    expect(decision.status).toBe('rejected');
    expect(decision.binding_constraint).toBe('min_viable_size');

    // This is the one assertion here whose expected outcome is a REJECTION, so
    // it is the one that could go green for a reason other than D5 — a stale
    // mark under `CLOCK`, an unknown daily P&L, a breaker. The control: the
    // same intent under a wider envelope must be APPROVED and sized by the
    // subclass gate. If anything upstream were rejecting, this would reject too.
    const withRoom = decide(scaleIn, { '3USL': INDEX_CAP - 100 });
    expect(withRoom.status).toBe('approved');
    expect(withRoom.binding_constraint).toBe('per_subclass_deployment_cap');
    expect(finalSizeOf(withRoom)).toBeCloseTo(100, 6);
  });

  it('#740: admits a second index ETP within the envelope, refuses a third once it is exhausted — keyed on the subclass cap, not a position count', () => {
    // Three DIFFERENT tickers, not three calls against one instrument: if the
    // gate were counting positions rather than netting notional, nothing
    // here would distinguish it from a "max 2 positions" rule. `'3IGL'` is a
    // third index_etp_3x ticker with no counterpart elsewhere in this file
    const threeTickerCap: SubclassDeploymentCap = {
      ...DEPLOYMENT_CAP,
      subclass_of: { ...SUBCLASS_OF, '3IGL': 'index_etp_3x' },
    };

    // First entry deploys all but £50 of the £262.50 envelope
    const first = decide(intentFor('3USL', INDEX_CAP - 50), {}, threeTickerCap);
    expect(first.status).toBe('approved');
    expect(finalSizeOf(first)).toBeCloseTo(INDEX_CAP - 50, 6);

    // A second, DIFFERENT instrument in the same subclass is admitted — but
    // only for the £50 of room the envelope has left, not its own full cap
    const second = decide(intentFor('3UKL', 10_000), { '3USL': INDEX_CAP - 50 }, threeTickerCap);
    expect(second.status).toBe('approved');
    expect(finalSizeOf(second)).toBeCloseTo(50, 6);
    expect(second.binding_constraint).toBe('per_subclass_deployment_cap');

    // A third, again DIFFERENT, instrument arrives once the subclass is fully
    // deployed and is refused outright — never forwarded as a sliver
    const third = decide(
      intentFor('3IGL', 10_000),
      { '3USL': INDEX_CAP - 50, '3UKL': 50 },
      threeTickerCap,
    );
    expect(third.status).toBe('rejected');
    expect(third.binding_constraint).toBe('min_viable_size');
  });

  /**
   * #1019. Every case above states the netting against exposure the book has
   * already RECOGNISED. These state it against exposure that has been
   * submitted to the venue and not come back — the window
   * `exposure_by_instrument` reports as zero, which at #1013's width 6 is
   * where every sibling in a tick actually lands.
   */
  describe('#1019 — nets submitted-but-unfilled exposure, not only filled', () => {
    it('shares the envelope with a sibling whose order is in flight and has no fill yet', () => {
      // The defect: the sibling's write-ahead row values at `filled_size ×
      // mark` = 0, so before this fix `deployedToSubclass` summed to zero and
      // this second name took the FULL envelope a moment after the first one
      // did — 70% of the book into a subclass measured to hold 23.1%
      // drawdown at 35%
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
      // A `submitted` lot that has taken half its fill contributes its filled
      // half to `exposure_by_instrument` and its remainder to the
      // reservation. Double-counting either half would over-tighten; counting
      // neither is the original defect
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
    // A single-stock holding must not consume the index envelope
    const decision = decide(intentFor('3USL', 10_000), { '3LAP': 180, 'BTC-USD': 500 });

    expect(finalSizeOf(decision)).toBeCloseTo(INDEX_CAP, 6);
  });

  it('does not bind on a subclass D5 measured no envelope for', () => {
    // `crypto: null` is "the study covers the two ETP subclasses and nothing
    // else", not a number waiting to be guessed. `per_asset_class_cap.crypto`
    // still bounds it
    const decision = decide(intentFor('BTC-USD', 10_000));

    expect(finalSizeOf(decision)).toBe(10_000);
    expect(decision.binding_constraint).toBeNull();
  });

  it('is inert when no envelope is declared at all', () => {
    // The backtest harness and every test predating subclasses
    const decision = decide(intentFor('3USL', 10_000), {}, null);

    expect(finalSizeOf(decision)).toBe(10_000);
  });

  it('throws on an unclassified instrument rather than sizing unbounded', () => {
    // The alternative to this throw is full deployment. A partly-populated
    // pool file is a mistake to surface, not one to size around
    expect(() => decide(intentFor('SPY', 10_000))).toThrow(/SPY has no subclass/);
    expect(() => decide(intentFor('SPY', 10_000))).toThrow(/ADR-0018 D5/);
  });

  it('#726: the unclassified-instrument throw carries a structured binding_constraint naming the instrument', () => {
    // `direct-bind.ts`'s `buildRiskStep` catches this to write the `risk_log`
    // row the throw would otherwise leave absent (#726) — it reads
    // `bindingConstraint` directly rather than re-parsing the message, so this
    // field is load-bearing for that fix, not incidental
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
    // `cap` is total over `InstrumentSubclass` at COMPILE time only, and
    // `subclass_of` is assembled from the pool file at runtime — so this pair
    // is constructible and the type cannot forbid it. The cast is exactly what
    // an assembled-at-runtime config would produce
    //
    // What made this worth a throw rather than a `?? 0`: `undefined` did not
    // fail loudly, it failed INVISIBLY. `undefined - deployed` is `NaN`,
    // `Math.max(NaN, 0)` is `NaN`, `notional <= NaN` is false so `trimToAllowed`
    // "trims" to `NaN` — and then `NaN < min_viable_size` is false too, so the
    // intent cleared BOTH this gate and the min-viable floor carrying no
    // envelope at all. A silent full deployment is the one outcome D5 exists
    // to prevent, so the test asserts the throw AND the NaN it replaced
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

    // The subclasses that ARE in the record still price normally — one hole
    // refuses one subclass, it does not disarm the gate
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
    // `allowedAdditional` goes NEGATIVE here (0 - 262.5). `trimToAllowed`
    // floors it at 0, and a 0 notional then falls below `min_viable_size` —
    // so the outcome is a rejection, not a zero-size order sent to a broker
    const decision = decide(intentFor('3USL', 10_000), { '3USL': INDEX_CAP });

    expect(decision.status).toBe('rejected');
    expect(decision.binding_constraint).toBe('min_viable_size');
  });

  it('lets the forced flatten out of a subclass the cap record does not carry', () => {
    // The sharpest edge on the throw above. ADR-0014's flat-by-close reaches
    // this stage as an `exit`, and risk-manager-spec's invariant is that no
    // gate may block it — a suppressed flatten holds a position overnight
    //
    // The throw is on the ENTRY-gate path, which `evaluate` returns before
    // reaching for an exit. That ordering is the whole safety argument, and it
    // is one refactor away from being wrong: hoisting the cap lookup above the
    // exit branch would turn a config hole into an un-exitable position, and
    // every other test here would still pass. This is the one that would fail.
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
    // Sized at the full residual: an exit trimmed to an envelope is a partial
    // flatten, which leaves the overnight position the invariant forbids
    expect(finalSizeOf(decision)).toBe(10_000);
  });

  it('is not a Feedback Loop dial', () => {
    // D5 binds regardless of signal quality. A dial would let the loop widen
    // the envelope in exactly the run where it had learned to be confident
    expect(RISK_THRESHOLD_KEYS).not.toContain('per_subclass_deployment_cap');
    expect(RISK_THRESHOLD_KEYS.some((key) => key.includes('subclass'))).toBe(false);
  });
});

describe('#888 — equity_ceiling: the fraction resolves against the declared BOOK, not raw portfolio.equity', () => {
  // The book equals `PORTFOLIO_EQUITY` here deliberately, so `capFraction *
  // book === INDEX_CAP`, the SAME cash figure the unclamped tests above
  // resolve to — the ceiling tests below are then directly comparable to
  // them, rather than needing a second cash constant. A book far below
  // `PORTFOLIO_EQUITY` would additionally trip `min_viable_size` on this
  // fixture's `capFraction` (calibrated to £750-leg-scale cash figures at
  // £100,000 equity, not at ADR-0018's real 0.35/0.25), which is not what
  // these tests are about
  const BOOK = PORTFOLIO_EQUITY;
  const TOLERANCE = 0.05;

  // `same_currency_verified: true` by default — this whole describe block is
  // about the book-relative clamp/refuse ARITHMETIC (#888), which #949 now
  // gates behind that flag (see the describe block below). Defaulting it to
  // `true` here keeps these fixtures exercising that arithmetic directly,
  // as they did before #949; no production caller ever sets it (#949's
  // currency-mismatch describe block below covers the shipped default)
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
    expect(finalSizeOf(decision)).toBeCloseTo(INDEX_CAP, 6); // 35% of £100,000, unclamped
  });

  it('clamps resolution to the book once equity is ABOVE it, within tolerance', () => {
    // This is the "sizes on the account" defect #888 was filed for,
    // reproduced directly against the gate rather than through the
    // composition root: fund 2% past the book and, pre-#888, the cap would
    // have resolved 2% wider too
    const withinTolerance = BOOK * 1.02; // 2% over, inside the 5% tolerance

    const decision = decide(intentFor('3USL', 10_000), {}, capWithCeiling(), withinTolerance);

    expect(decision.status).toBe('approved');
    expect(decision.binding_constraint).toBe('per_subclass_deployment_cap');
    // Clamped at the BOOK, not the funded 2%-over figure
    expect(finalSizeOf(decision)).toBeCloseTo(INDEX_CAP, 6);
  });

  it('leaves sizing untouched below the book — the ceiling only ever clamps DOWN', () => {
    const belowBook = BOOK * 0.5;

    const decision = decide(intentFor('3USL', 10_000), {}, capWithCeiling(), belowBook);

    expect(decision.status).toBe('approved');
    expect(finalSizeOf(decision)).toBeCloseTo(INDEX_CAP / 2, 6);
  });

  it('REFUSES the entry once equity clears the tolerance above the book, rather than sizing on the wider figure', () => {
    const farOverBook = BOOK * 1.5; // 50% over — well past the 5% tolerance

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
    // Mirrors the existing "lets the forced flatten out" test above: the
    // throw lives on the entry-gate path, and `evaluate()` returns for an
    // exit before that path is ever reached
    const flatten = { ...intentFor('3USL', 10_000), intent_type: 'exit' as const };

    const decision = decide(flatten, { '3USL': INDEX_CAP }, capWithCeiling(), BOOK * 10);

    expect(decision.status).toBe('approved');
    expect(decision.binding_constraint).toBeNull();
  });
});

describe('#949 — equity_ceiling refuses on currency mismatch, UNCONDITIONALLY, until same_currency_verified', () => {
  // `book` is GBP; the only funding read this codebase has (Alpaca's
  // `GET /v2/account`, `production/account-state.ts:129`) is USD, with no FX
  // conversion. #888's clamp/refuse arithmetic above therefore cannot tell a
  // correctly-funded account from an overfunded one at ANY equity value —
  // not just the ones numerically above the book — so `same_currency_verified`
  // absent/`false` must refuse before that arithmetic ever runs, regardless
  // of whether `portfolio.equity` reads above, at, or below `book`. No
  // production caller sets the flag today (see `d5EnvelopeFor`,
  // paper-profile.ts); the describe block above is what exercising it looks
  // like once a same-currency comparison exists
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
    // The scenario #949 was filed over: a correctly-funded GBP book reads as
    // a numerically LARGER USD figure over Alpaca's API (~1.25-1.35x at
    // typical GBP/USD rates), which the pre-#949 gate misread as overfunding
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
      // The old over-book reason's distinguishing phrase must be absent —
      // this refusal is diagnosable as a currency problem, not a funding one
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
