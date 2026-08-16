/**
 * A6 (#703) — ADR-0018 D5's fractions, and the arithmetic that proves the base
 * is right.
 *
 * D5 states two figures against ADR-0015's £750 equity leg: ~£260 for a 3x
 * index ETP and ~£190 for a 3x single-stock ETP. Reproducing them is the whole
 * check on the choice of base — the rejected alternative
 * (`per_asset_class_cap_stocks`) reproduces nothing, because it is a fraction
 * of the ACCOUNT and is a Feedback Loop dial besides.
 */
import { describe, expect, it } from 'vitest';

import { RISK_THRESHOLD_KEYS } from '../../pipeline/risk-manager/index.js';
import {
  D5_DEPLOYMENT_FRACTION_OF_EQUITY_LEG,
  d5EnvelopeFor,
  EQUITY_LEG_FRACTION_OF_CAPITAL,
  PAPER_ACCOUNT_EQUITY_ANCHOR,
  paperStartingProfile,
  RISK_CAP_EQUITY_FRACTIONS,
  subclassDeploymentCapsFor,
} from './paper-profile.js';
import { DEFAULT_UNIVERSE } from './scheduler.js';
import type { UniverseInstrument } from './types.js';

/** ADR-0015: £1,500 live, split £750 equity / £750 crypto (#660). */
const LIVE_CAPITAL = 1_500;

describe("ADR-0018 D5's fractions reproduce the ADR's own figures", () => {
  it('puts a 3x index ETP at ~£260 and a single-stock ETP at ~£190 on a £750 leg', () => {
    const caps = subclassDeploymentCapsFor(LIVE_CAPITAL);

    expect(caps.index_etp_3x).toBeCloseTo(262.5, 6); // D5's "~£260"
    expect(caps.single_stock_etp_3x).toBeCloseTo(187.5, 6); // D5's "~£190"
  });

  it('splits the leg per ADR-0015 rather than per a risk cap', () => {
    expect(EQUITY_LEG_FRACTION_OF_CAPITAL * LIVE_CAPITAL).toBe(750);
  });

  it('carries the single-stock overshoot as a named constant, not a bare 0.25', () => {
    // 26.2% measured drawdown is ~1.2 pp above CONTEXT.md's 20-25% band. D5
    // accepts the overshoot explicitly; the constant is where that is stated,
    // so a reader meeting the number meets the citation with it.
    expect(D5_DEPLOYMENT_FRACTION_OF_EQUITY_LEG.single_stock_etp_3x).toBe(0.25);
    expect(D5_DEPLOYMENT_FRACTION_OF_EQUITY_LEG.index_etp_3x).toBe(0.35);
  });

  it('measures no envelope for crypto rather than inventing one', () => {
    expect(D5_DEPLOYMENT_FRACTION_OF_EQUITY_LEG.crypto).toBeNull();
    expect(subclassDeploymentCapsFor(LIVE_CAPITAL).crypto).toBeNull();
  });

  it('is based on nothing the Feedback Loop can move', () => {
    // The disqualifying property of the rejected base: it is a live dial, so
    // D5's envelope would widen at runtime. D5 is measured drift-removed with
    // zero edge assumed and must not be contingent on what the loop learns.
    expect(RISK_THRESHOLD_KEYS).toContain('per_asset_class_cap_stocks');
    expect(RISK_THRESHOLD_KEYS).not.toContain('per_subclass_deployment_cap');
  });
});

describe('the envelope arms itself off the universe', () => {
  it('is NOT declared on DEFAULT_UNIVERSE, which holds no leveraged ETPs', () => {
    // ADR-0018 prices leveraged ETPs; the default universe is
    // SPY/QQQ/AAPL/TSLA/BTC/ETH. Declaring the field with an empty
    // `subclass_of` would make every entry throw instead.
    expect(d5EnvelopeFor(DEFAULT_UNIVERSE, PAPER_ACCOUNT_EQUITY_ANCHOR)).toBeUndefined();
    expect(paperStartingProfile('paper').riskConfig.per_subclass_deployment_cap).toBeUndefined();
  });

  it('arms the moment the pool file supplies a subclass', () => {
    const universe: readonly UniverseInstrument[] = [
      { asset: '3USL', asset_class: 'stocks', subclass: 'index_etp_3x' },
      { asset: 'BTC-USD', asset_class: 'crypto' },
    ];

    const declared = d5EnvelopeFor(universe, LIVE_CAPITAL);

    expect(declared?.subclass_of).toEqual({ '3USL': 'index_etp_3x' });
    expect(declared?.cap.index_etp_3x).toBeCloseTo(262.5, 6);
  });
});

describe('what the paper profile actually enforces', () => {
  it('would be dominated by the per-trade cap even if armed — D5 is a live protection', () => {
    // Stated here rather than discovered in a soak: on a $100k paper anchor
    // the 5% per-trade cap ($5,000) is far tighter than a D5 index envelope of
    // 35% of the $50k leg ($17,500), so `per_trade_size_cap` trims first every
    // time. The paper soak is not a test of D5.
    const perTrade = RISK_CAP_EQUITY_FRACTIONS.max_position_size * PAPER_ACCOUNT_EQUITY_ANCHOR;
    const d5Index = subclassDeploymentCapsFor(PAPER_ACCOUNT_EQUITY_ANCHOR).index_etp_3x;

    expect(perTrade).toBe(5_000);
    expect(d5Index).toBe(17_500);
    expect(perTrade).toBeLessThan(d5Index as number);
  });
});
