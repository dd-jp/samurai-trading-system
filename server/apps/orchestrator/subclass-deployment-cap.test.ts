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

const D5_PUBLISHED_LEG = 750;

describe("ADR-0018 D5's fractions reproduce the ADR's own figures", () => {
  it('puts a 3x index ETP at ~£260 and a single-stock ETP at ~£190 on the £750 leg D5 was written against', () => {
    const fractions = subclassDeploymentCapFractionsOfEquity();

    expect((fractions.index_etp_3x as number) * D5_PUBLISHED_LEG).toBeCloseTo(262.5, 6);
    expect((fractions.single_stock_etp_3x as number) * D5_PUBLISHED_LEG).toBeCloseTo(187.5, 6);
  });

  it('applies D5 to the WHOLE book, because the book is now all equity', () => {
    const fractions = subclassDeploymentCapFractionsOfEquity();

    expect(fractions.index_etp_3x).toBe(D5_DEPLOYMENT_FRACTION_OF_EQUITY_LEG.index_etp_3x);
    expect(fractions.single_stock_etp_3x).toBe(
      D5_DEPLOYMENT_FRACTION_OF_EQUITY_LEG.single_stock_etp_3x,
    );
  });

  it('resolves to £350 / £250 on the £1,000 book, up from £175 / £125 under the split', () => {
    const fractions = subclassDeploymentCapFractionsOfEquity();

    expect(LIVE_BOOK_GBP).toBe(1_000);
    expect((fractions.index_etp_3x as number) * LIVE_BOOK_GBP).toBeCloseTo(350, 6);
    expect((fractions.single_stock_etp_3x as number) * LIVE_BOOK_GBP).toBeCloseTo(250, 6);
  });

  it('carries the single-stock overshoot as a named constant, not a bare 0.25', () => {
    expect(D5_DEPLOYMENT_FRACTION_OF_EQUITY_LEG.single_stock_etp_3x).toBe(0.25);
    expect(D5_DEPLOYMENT_FRACTION_OF_EQUITY_LEG.index_etp_3x).toBe(0.35);
  });

  it('measures no envelope for crypto rather than inventing one', () => {
    expect(D5_DEPLOYMENT_FRACTION_OF_EQUITY_LEG.crypto).toBeNull();
    expect(subclassDeploymentCapFractionsOfEquity().crypto).toBeNull();
  });

  it('is based on nothing the Feedback Loop can move', () => {
    expect(RISK_THRESHOLD_KEYS).toContain('per_asset_class_cap_fraction_of_equity_stocks');
    expect(RISK_THRESHOLD_KEYS).not.toContain('per_subclass_deployment_cap');
  });
});

describe('the envelope arms itself off the universe', () => {
  it('is NOT declared on DEFAULT_UNIVERSE, which holds no leveraged ETPs', () => {
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
    expect(RISK_CAP_EQUITY_FRACTIONS.max_position_size_fraction_of_equity).toBeLessThan(
      subclassDeploymentCapFractionsOfEquity().index_etp_3x as number,
    );
  });
});

describe('the Trader and the Risk Manager classify from ONE derivation (#739)', () => {
  it('hands the composed trader config the same map the D5 gate arms on', () => {
    const universe: readonly UniverseInstrument[] = [
      { asset: '3USL', asset_class: 'stocks', subclass: 'index_etp_3x' },
      { asset: '3LAP', asset_class: 'stocks', subclass: 'single_stock_etp_3x' },
    ];

    const configs = buildStartingProfileConfigs(universe);

    expect(configs.traderConfig.subclass_of).toEqual({
      '3USL': 'index_etp_3x',
      '3LAP': 'single_stock_etp_3x',
    });
    expect(configs.riskConfig.per_subclass_deployment_cap?.subclass_of).toEqual(
      configs.traderConfig.subclass_of,
    );
    expect(configs.universe).toBe(universe);

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
