/**
 * A6 (#703) — ADR-0018 D5's fractions, and the arithmetic that proves the base
 * is right.
 *
 * D5 states two figures against the £750 equity leg ADR-0015 originally split
 * out: ~£260 for a 3x index ETP and ~£190 for a 3x single-stock ETP.
 * Reproducing them is the whole check on the choice of base — the rejected alternative
 * (`per_asset_class_cap_stocks`) reproduces nothing, because it is a fraction
 * of the ACCOUNT and is a Feedback Loop dial besides.
 */
import { describe, expect, it } from 'vitest';

import { RISK_THRESHOLD_KEYS } from '../../pipeline/risk-manager/index.js';
import {
  buildStartingProfileConfigs,
  D5_DEPLOYMENT_FRACTION_OF_EQUITY_LEG,
  d5EnvelopeFor,
  LIVE_BOOK_GBP,
  paperStartingProfile,
  RISK_CAP_EQUITY_FRACTIONS,
  subclassDeploymentCapFractionsOfEquity,
  subclassOfUniverse,
} from './paper-profile.js';
import { DEFAULT_UNIVERSE } from './scheduler.js';
import type { UniverseInstrument } from './types.js';

/**
 * The leg D5's published cash figures were CALIBRATED against (ADR-0015 as
 * written: £1,500 split £750/£750). Kept as a provenance check on the choice
 * of base, not as the live book — see `LIVE_BOOK_GBP`, which is £1,000
 * all-equity since David's 2026-08-18 ruling on #800.
 */
const D5_PUBLISHED_LEG = 750;

describe("ADR-0018 D5's fractions reproduce the ADR's own figures", () => {
  it('puts a 3x index ETP at ~£260 and a single-stock ETP at ~£190 on the £750 leg D5 was written against', () => {
    // The fractions are the rule (#739); the cash figures are what they
    // resolve to at the leg D5 was calibrated on, which is the check that the
    // base is right rather than a cap the system stores
    const fractions = subclassDeploymentCapFractionsOfEquity();

    expect((fractions.index_etp_3x as number) * D5_PUBLISHED_LEG).toBeCloseTo(262.5, 6);
    expect((fractions.single_stock_etp_3x as number) * D5_PUBLISHED_LEG).toBeCloseTo(187.5, 6);
  });

  it('applies D5 to the WHOLE book, because the book is now all equity', () => {
    // David, 2026-08-18 (#800): crypto cancelled, the equity book takes
    // £1,000. There is no leg to be a fraction of any more, so the 0.5 scaler
    // that encoded ADR-0015's £750/£750 split is gone and D5's fractions reach
    // `portfolio.equity` unscaled. Asserted as an IDENTITY rather than as a
    // number so re-introducing any scaler fails here
    const fractions = subclassDeploymentCapFractionsOfEquity();

    expect(fractions.index_etp_3x).toBe(D5_DEPLOYMENT_FRACTION_OF_EQUITY_LEG.index_etp_3x);
    expect(fractions.single_stock_etp_3x).toBe(
      D5_DEPLOYMENT_FRACTION_OF_EQUITY_LEG.single_stock_etp_3x,
    );
  });

  it('resolves to £350 / £250 on the £1,000 book, up from £175 / £125 under the split', () => {
    // The consequence of the ruling, stated where it can be read rather than
    // discovered in a soak: the cash at risk per position roughly DOUBLES
    // The single-stock row is f = 0.25 unscaled — exactly the fraction
    // ADR-0018 D5 published, and the one whose measured drawdown is ~41.8%
    // against CONTEXT.md's 20-25% tolerance (#798)
    const fractions = subclassDeploymentCapFractionsOfEquity();

    expect(LIVE_BOOK_GBP).toBe(1_000);
    expect((fractions.index_etp_3x as number) * LIVE_BOOK_GBP).toBeCloseTo(350, 6);
    expect((fractions.single_stock_etp_3x as number) * LIVE_BOOK_GBP).toBeCloseTo(250, 6);
  });

  it('carries the single-stock overshoot as a named constant, not a bare 0.25', () => {
    // At the declared brackets the measured drawdown is ~41.8%, ~17 pp above
    // CONTEXT.md's 20-25% band (D5's #729 verification note, 2026-08-17 —
    // D5's own published ~1.2 pp was measured at a bracket it does not
    // declare). The overshoot is accepted rather than sized away, and the
    // named constant is where that is stated, so a reader meeting the number
    // meets the citation with it
    expect(D5_DEPLOYMENT_FRACTION_OF_EQUITY_LEG.single_stock_etp_3x).toBe(0.25);
    expect(D5_DEPLOYMENT_FRACTION_OF_EQUITY_LEG.index_etp_3x).toBe(0.35);
  });

  it('measures no envelope for crypto rather than inventing one', () => {
    expect(D5_DEPLOYMENT_FRACTION_OF_EQUITY_LEG.crypto).toBeNull();
    expect(subclassDeploymentCapFractionsOfEquity().crypto).toBeNull();
  });

  it('is based on nothing the Feedback Loop can move', () => {
    // The disqualifying property of the rejected base: it is a live dial, so
    // D5's envelope would widen at runtime. D5 is measured drift-removed with
    // zero edge assumed and must not be contingent on what the loop learns
    expect(RISK_THRESHOLD_KEYS).toContain('per_asset_class_cap_fraction_of_equity_stocks');
    expect(RISK_THRESHOLD_KEYS).not.toContain('per_subclass_deployment_cap');
  });
});

describe('the envelope arms itself off the universe', () => {
  it('is NOT declared on DEFAULT_UNIVERSE, which holds no leveraged ETPs', () => {
    // ADR-0018 prices leveraged ETPs; the default universe is
    // SPY/QQQ/AAPL/TSLA/BTC/ETH. Declaring the field with an empty
    // `subclass_of` would make every entry throw instead
    expect(d5EnvelopeFor(DEFAULT_UNIVERSE)).toBeUndefined();
    expect(paperStartingProfile('paper').riskConfig.per_subclass_deployment_cap).toBeUndefined();
  });

  it('arms the moment the pool file supplies a subclass', () => {
    const universe: readonly UniverseInstrument[] = [
      { asset: '3USL', asset_class: 'stocks', subclass: 'index_etp_3x' },
      { asset: 'BTC-USD', asset_class: 'crypto' },
    ];

    const declared = d5EnvelopeFor(universe);

    expect(declared?.subclass_of).toEqual({ '3USL': 'index_etp_3x' });
    expect(
      (declared?.cap_fraction_of_equity.index_etp_3x as number) * D5_PUBLISHED_LEG,
    ).toBeCloseTo(262.5, 6);
  });
});

describe('what the paper profile actually enforces (#886)', () => {
  it('per_trade_size_cap no longer dominates a classified instrument — it is exempt', () => {
    // Until #886, `per_trade_size_cap` was a STATIC cash figure (5% of an
    // assumed anchor) while D5 resolved against live equity, so which cap
    // bound depended on the gap between the two (#886's finding). #886 ruled
    // D5 the sole drawdown authority for a classified instrument and made
    // `per_trade_size_cap` skip it entirely
    // (`isD5ArmedWithNumericFraction`, risk-manager/index.ts) — so the
    // domination this block used to assert here is retired, not merely
    // re-scaled. The gate-level assertion (through `RiskManagerImpl.evaluate`,
    // not this file's arithmetic) lives in `d5-trader-cap-agreement.test.ts`,
    // including the acceptance-criteria test and the gap #886 did NOT close
    // (`per_asset_cap_fraction_of_equity` still binds ahead of D5)
    expect(RISK_CAP_EQUITY_FRACTIONS.max_position_size_fraction_of_equity).toBeLessThan(
      subclassDeploymentCapFractionsOfEquity().index_etp_3x as number,
    );
  });
});

describe('the Trader and the Risk Manager classify from ONE derivation (#739)', () => {
  it('hands the composed trader config the same map the D5 gate arms on', () => {
    // The composition root is where a per-subclass table stops being a table
    // nothing consults. Two independently built maps would let the stage that
    // SIZES a position and the stage that CAPS it disagree about what the
    // instrument is, and the disagreement would be invisible in every log
    // Built against a CLASSIFIED universe on purpose: with `DEFAULT_UNIVERSE`
    // the expected and actual maps are both `{}`, so the assertion passes
    // whether or not the composition root carries the classification at all
    const universe: readonly UniverseInstrument[] = [
      { asset: '3USL', asset_class: 'stocks', subclass: 'index_etp_3x' },
      { asset: '3LAP', asset_class: 'stocks', subclass: 'single_stock_etp_3x' },
    ];

    const configs = buildStartingProfileConfigs(universe);

    expect(configs.traderConfig.subclass_of).toEqual({
      '3USL': 'index_etp_3x',
      '3LAP': 'single_stock_etp_3x',
    });
    // The same rows arm the Risk Manager's envelope, from the same argument
    expect(configs.riskConfig.per_subclass_deployment_cap?.subclass_of).toEqual(
      configs.traderConfig.subclass_of,
    );
    expect(configs.universe).toBe(universe);

    // And the default profile is unarmed, because `DEFAULT_UNIVERSE` is
    expect(paperStartingProfile('paper').traderConfig.subclass_of).toEqual({});
  });

  it('arms both stages off the same universe rows, or neither', () => {
    const universe: readonly UniverseInstrument[] = [
      { asset: '3USL', asset_class: 'stocks', subclass: 'index_etp_3x' },
      { asset: '3LAP', asset_class: 'stocks', subclass: 'single_stock_etp_3x' },
      { asset: 'BTC-USD', asset_class: 'crypto' },
    ];

    expect(subclassOfUniverse(universe)).toEqual(d5EnvelopeFor(universe)?.subclass_of);
    expect(subclassOfUniverse(DEFAULT_UNIVERSE)).toEqual({});
    expect(d5EnvelopeFor(DEFAULT_UNIVERSE)).toBeUndefined();
  });
});
