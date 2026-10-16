import { describe, expect, it } from 'vitest';
import { SAXO_CFD_COMMISSION, SAXO_CFD_FINANCING, SAXO_CFD_SPREAD } from '../data/index.js';
import { CROSS_ASSET_TREND_CANDIDATE_ID } from './cross-asset-trend.js';
import { MEAN_REVERSION_CANDIDATE_ID } from './mean-reversion.js';
import { ALL_PINS, DEBATER_PINS, JUDGE_PIN, PRE_DIGEST_ALL_PINS, pinDigest } from './models.js';
import {
  ALPACA_SHORT_EQUITY_FLOOR_USD,
  ARM2_ENTRY_THRESHOLDS,
  ARM2_SLEEVE_ID,
  bookPinDigest,
  bookPreDigestPinDigest,
  CFD_BORROW_MODEL,
  CFD_COST_MODEL,
  CFD_ENTRY_GATES,
  CFD_FINANCING_MODEL,
  CFD_RESTING_STOP_VERIFIED,
  CFD_SHORT_MAX_BORROW_RATE_PER_YEAR,
  CFD_SLEEVE_IDS,
  CFD_SPREAD_MODEL,
  type CfdEntryGate,
  CYCLE_LEVEL_PARAMETERS,
  cfdEntryRefusal,
  DEBATE_RISK_FRACTION,
  DEBATE_SLEEVE_ID,
  DEBATE_SLEEVE_SPEC,
  DEBATE_TARGET_ATR_MULTIPLE,
  DEBATE_TIME_STOP_TRADING_DAYS,
  DECLARED_PARAMETERS,
  declaredCfdCosts,
  declaredVolTarget,
  G18_SENTIMENT_DEDUP_RULE,
  G18_SMALL_CAP_FLOORS,
  G18_SOCIAL_SOURCE,
  isSet,
  LSE_LIQUIDITY_SCREEN,
  MOVERS_MIN_DOLLAR_VOLUME_USD,
  type Parameter,
  RECONCILE_CASH_TOLERANCE_GBP,
  requireSet,
  SAXO_APPROPRIATENESS_TEST_TAKEN,
  SIGNALS_SLEEVE_ID,
  SIGNALS_SLEEVE_SPEC,
  SLEEVE_PINS_BY_ID,
  SLEEVE_SPECS_BY_ID,
  UK_STOCK_CFD_ENABLED,
  UK_STOCK_SCREENS,
  UNSET,
  UnsetParameterError,
  ukStockCfdRefusal,
  VOL_TARGET_SIZING,
  withheldParameters,
} from './parameters.js';
import { VOL_TARGET_INDEX_CANDIDATE_ID } from './vol-target-index.js';

const CFD_GATE_PARAMETERS = [
  CFD_COST_MODEL,
  CFD_SPREAD_MODEL,
  CFD_FINANCING_MODEL,
  CFD_BORROW_MODEL,
  CFD_RESTING_STOP_VERIFIED,
];

const CFD_COST_PARAMETERS: readonly Parameter<unknown>[] = [
  CFD_COST_MODEL,
  CFD_SPREAD_MODEL,
  CFD_FINANCING_MODEL,
  CFD_BORROW_MODEL,
];

const SET_PARAMETERS: readonly Parameter<unknown>[] = [
  ARM2_ENTRY_THRESHOLDS,
  LSE_LIQUIDITY_SCREEN,
  UK_STOCK_SCREENS,
  RECONCILE_CASH_TOLERANCE_GBP,
  ...CFD_GATE_PARAMETERS,
];

describe('parameters', () => {
  it('every David-owned parameter names its ticket; unresolved ones are unset', () => {
    expect(DECLARED_PARAMETERS).toEqual([
      G18_SOCIAL_SOURCE,
      G18_SMALL_CAP_FLOORS,
      G18_SENTIMENT_DEDUP_RULE,
      ALPACA_SHORT_EQUITY_FLOOR_USD,
      ARM2_ENTRY_THRESHOLDS,
      LSE_LIQUIDITY_SCREEN,
      UK_STOCK_SCREENS,
      UK_STOCK_CFD_ENABLED,
      ...CFD_GATE_PARAMETERS,
      RECONCILE_CASH_TOLERANCE_GBP,
      VOL_TARGET_SIZING,
    ]);
    expect(CYCLE_LEVEL_PARAMETERS).toEqual([
      G18_SOCIAL_SOURCE,
      G18_SENTIMENT_DEDUP_RULE,
      ALPACA_SHORT_EQUITY_FLOOR_USD,
      ...CFD_GATE_PARAMETERS,
      UK_STOCK_CFD_ENABLED,
    ]);
    for (const parameter of DECLARED_PARAMETERS) {
      expect(parameter.ticket.length).toBeGreaterThan(0);
      if (SET_PARAMETERS.includes(parameter)) continue;
      expect(parameter.value).toBe(UNSET);
      expect(isSet(parameter)).toBe(false);
      expect(() => requireSet(parameter)).toThrow(UnsetParameterError);
    }
  });

  it('arm 2 entry thresholds are approved and resolved (#1773)', () => {
    expect(isSet(ARM2_ENTRY_THRESHOLDS)).toBe(true);
    expect(requireSet(ARM2_ENTRY_THRESHOLDS)).toEqual({ longAbove: 0, shortBelow: 0 });
    expect(ARM2_ENTRY_THRESHOLDS.ticket).toBe('#1773');
    expect(CYCLE_LEVEL_PARAMETERS).not.toContain(ARM2_ENTRY_THRESHOLDS);
  });

  it("the reconcile cash tolerance is David's GBP 5, owned by #1927, and never refuses a paper cycle (David 2026-10-02)", () => {
    expect(requireSet(RECONCILE_CASH_TOLERANCE_GBP)).toBe(5);
    expect(RECONCILE_CASH_TOLERANCE_GBP.ticket).toBe('#1927');
    expect(CYCLE_LEVEL_PARAMETERS).not.toContain(RECONCILE_CASH_TOLERANCE_GBP);
  });

  it("the LSE liquidity floor is David's $750k answer, measured in GBP (#1774)", () => {
    expect(requireSet(LSE_LIQUIDITY_SCREEN)).toBe(750_000);
    expect(CYCLE_LEVEL_PARAMETERS).not.toContain(LSE_LIQUIDITY_SCREEN);
  });

  it("the UK stock screens are David's 2026-09-29 floors, owned by #1914", () => {
    expect(requireSet(UK_STOCK_SCREENS)).toEqual({
      minAdvGbp: 5_000_000,
      maxSpreadBps: 25,
      minPricePence: 100,
    });
    expect(UK_STOCK_SCREENS.ticket).toBe('#1914');
    expect(CYCLE_LEVEL_PARAMETERS).not.toContain(UK_STOCK_SCREENS);
  });

  it('keeps every UK single-stock CFD route shut until David opens it (#1914 kill line)', () => {
    expect(UK_STOCK_CFD_ENABLED.value).toBe(UNSET);
    expect(ukStockCfdRefusal()).toBe('uk_stock_cfd_disabled');
    expect(ukStockCfdRefusal({ ...UK_STOCK_CFD_ENABLED, value: false })).toBe(
      'uk_stock_cfd_disabled',
    );
    expect(ukStockCfdRefusal({ ...UK_STOCK_CFD_ENABLED, value: true })).toBeUndefined();
    expect(withheldParameters()).toContainEqual(
      expect.objectContaining({ parameter: 'UK_STOCK_CFD_ENABLED', ticket: '#1914' }),
    );
  });

  it('carries the pre-declared Step 3 trial values from the spec', () => {
    expect(DEBATE_RISK_FRACTION).toBe(0.005);
    expect(DEBATE_TARGET_ATR_MULTIPLE).toBe(3);
    expect(DEBATE_TIME_STOP_TRADING_DAYS).toBe(10);
    expect(MOVERS_MIN_DOLLAR_VOLUME_USD).toBe(50_000_000);
  });

  it('vol-target sizing stays unset until David pre-declares the trial, and off the cycle journal (#1860)', () => {
    expect(VOL_TARGET_SIZING.ticket).toBe('#1860');
    expect(isSet(VOL_TARGET_SIZING)).toBe(false);
    expect(declaredVolTarget()).toBeUndefined();
    expect(CYCLE_LEVEL_PARAMETERS).not.toContain(VOL_TARGET_SIZING);
    const sizing = { annualTargetVol: 0.15, windowBars: 20, sleeveIds: ['arm2'] };
    expect(declaredVolTarget({ name: 'X', ticket: '#0', value: sizing })).toBe(sizing);
  });

  it('requireSet throws naming the parameter and ticket', () => {
    let caught: unknown;
    try {
      requireSet(G18_SMALL_CAP_FLOORS);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnsetParameterError);
    const error = caught as UnsetParameterError;
    expect(error.parameter).toBe('G18_SMALL_CAP_FLOORS');
    expect(error.ticket).toBe('#1753');
    expect(error.message).toContain('needs David');
  });

  it('requireSet returns a set value', () => {
    const set: Parameter<number> = { name: 'X', ticket: '#0', value: 3 };
    expect(isSet(set)).toBe(true);
    expect(requireSet(set)).toBe(3);
  });

  it('#1850 sets the four CFD cost models to the Saxo tariff; the borrow ceiling is the ruled 2% a year', () => {
    expect(CFD_COST_PARAMETERS.map((parameter) => [parameter.ticket, isSet(parameter)])).toEqual([
      ['#1850', true],
      ['#1850', true],
      ['#1850', true],
      ['#1850', true],
    ]);
    expect(requireSet(CFD_COST_MODEL)).toBe(SAXO_CFD_COMMISSION);
    expect(requireSet(CFD_SPREAD_MODEL)).toBe(SAXO_CFD_SPREAD);
    expect(requireSet(CFD_FINANCING_MODEL)).toBe(SAXO_CFD_FINANCING);
    expect(requireSet(CFD_BORROW_MODEL).dailyRate('saxo_cfd_usd', undefined)).toBeCloseTo(
      0.02 / 360,
      15,
    );
    expect(CFD_SHORT_MAX_BORROW_RATE_PER_YEAR).toBe(0.02);
  });

  it('sets the resting stop as verified (#1916, SIM drill 2026-10-09), so every CFD entry gate admits', () => {
    expect(CFD_RESTING_STOP_VERIFIED.ticket).toBe('#1916');
    expect(CFD_RESTING_STOP_VERIFIED.value).toBe(true);
    expect(cfdEntryRefusal()).toBeUndefined();
  });

  describe('declaredCfdCosts', () => {
    it('bundles the four set models', () => {
      expect(declaredCfdCosts()).toEqual({
        fee: SAXO_CFD_COMMISSION,
        spread: SAXO_CFD_SPREAD,
        financing: SAXO_CFD_FINANCING,
        borrow: requireSet(CFD_BORROW_MODEL),
      });
    });

    it.each(['fee', 'spread', 'financing', 'borrow'] as const)(
      'is undefined when %s is unset, so no CFD fill is half-priced',
      (key) => {
        const parameters = {
          fee: CFD_COST_MODEL,
          spread: CFD_SPREAD_MODEL,
          financing: CFD_FINANCING_MODEL,
          borrow: CFD_BORROW_MODEL,
          [key]: { name: key, ticket: '#1850', value: UNSET },
        };
        expect(declaredCfdCosts(parameters)).toBeUndefined();
      },
    );
  });

  describe('cfdEntryRefusal', () => {
    const setGate = (gate: CfdEntryGate, value: unknown = {}): CfdEntryGate => ({
      ...gate,
      parameter: { ...gate.parameter, value },
    });
    const allSet = CFD_ENTRY_GATES.map((gate) => setGate(gate, true));

    it('admits a CFD entry only when all five gates are set', () => {
      expect(cfdEntryRefusal(allSet)).toBeUndefined();
    });

    it.each([
      ['CFD_COST_MODEL', 'cfd_cost_model_unset'],
      ['CFD_SPREAD_MODEL', 'cfd_spread_model_unset'],
      ['CFD_FINANCING_MODEL', 'cfd_financing_model_unset'],
      ['CFD_BORROW_MODEL', 'cfd_borrow_model_unset'],
      ['CFD_RESTING_STOP_VERIFIED', 'cfd_resting_stop_unverified'],
    ])('refuses when only %s is unset, naming it', (name, refusal) => {
      const gates = CFD_ENTRY_GATES.map((gate) =>
        setGate(gate, gate.parameter.name === name ? UNSET : true),
      );
      expect(cfdEntryRefusal(gates)).toBe(refusal);
    });

    it('refuses a resting stop set to false as unverified', () => {
      const gates = allSet.map((gate) =>
        gate.parameter.name === 'CFD_RESTING_STOP_VERIFIED' ? setGate(gate, false) : gate,
      );
      expect(cfdEntryRefusal(gates)).toBe('cfd_resting_stop_unverified');
    });

    it('withholds a false gate as it withholds an unset one, naming each (#2104)', () => {
      const gates = allSet.map((gate) =>
        gate.parameter.name === 'CFD_RESTING_STOP_VERIFIED'
          ? setGate(gate, false)
          : gate.parameter.name === 'CFD_COST_MODEL'
            ? setGate(gate, UNSET)
            : gate,
      );
      expect(withheldParameters(gates.map(({ parameter }) => parameter))).toEqual([
        {
          parameter: 'CFD_COST_MODEL',
          ticket: '#1850',
          message: 'CFD_COST_MODEL is not set: needs David (#1850)',
        },
        {
          parameter: 'CFD_RESTING_STOP_VERIFIED',
          ticket: '#1916',
          message: 'CFD_RESTING_STOP_VERIFIED is false: needs David (#1916)',
        },
      ]);
      expect(withheldParameters(allSet.map(({ parameter }) => parameter))).toEqual([]);
    });

    it('names the first unset gate in order when several are missing', () => {
      const allUnset = CFD_ENTRY_GATES.map((gate) => setGate(gate, UNSET));
      expect(cfdEntryRefusal(allUnset)).toBe('cfd_cost_model_unset');
      expect(cfdEntryRefusal([...allUnset].reverse())).toBe('cfd_resting_stop_unverified');
    });
  });

  it('allows CFD routes to the debate sleeve and arm 2 only (doc 66 (f), #1858, #2105, #2143)', () => {
    expect(CFD_SLEEVE_IDS).toEqual(['debate', 'arm2', 'arm2-vol-target', 'arm2-uk-pool']);
    for (const cfdFree of [
      SIGNALS_SLEEVE_ID,
      CROSS_ASSET_TREND_CANDIDATE_ID,
      MEAN_REVERSION_CANDIDATE_ID,
      VOL_TARGET_INDEX_CANDIDATE_ID,
    ]) {
      expect(CFD_SLEEVE_IDS).not.toContain(cfdFree);
    }
  });

  it('the Saxo appropriateness test is recorded as taken (doc 66 ruling (l), #1774 (b))', () => {
    expect(SAXO_APPROPRIATENESS_TEST_TAKEN).toBe(true);
  });
});

describe('sleeve pin sets (#1747, David 2026-10-04 and 2026-10-10)', () => {
  it('declares a pin set for every sleeve that has a spec', () => {
    expect(Object.keys(SLEEVE_PINS_BY_ID).sort()).toEqual(Object.keys(SLEEVE_SPECS_BY_ID).sort());
  });

  it('pins every debate book to all three debaters, the idle rotation seat included, and the judge', () => {
    expect(DEBATER_PINS.map((pin) => pin.seat)).toEqual(['sonnet', 'gpt', 'deepseek']);
    for (const { variant } of DEBATE_SLEEVE_SPEC.books) {
      expect(bookPinDigest(DEBATE_SLEEVE_ID, variant)).toBe(pinDigest(ALL_PINS));
    }
  });

  it('pins the signals primary to the judge alone, so a debater swap leaves it alone', () => {
    expect(bookPinDigest(SIGNALS_SLEEVE_ID, 'primary')).toBe(pinDigest([JUDGE_PIN]));
  });

  it('gives arm 2 and every no-veto book the empty set, so they never reset', () => {
    const none = pinDigest([]);
    expect(bookPinDigest(ARM2_SLEEVE_ID, 'technical-only')).toBe(none);
    expect(SIGNALS_SLEEVE_SPEC.books.map((book) => book.variant)).toContain('no-veto');
    expect(bookPinDigest(SIGNALS_SLEEVE_ID, 'no-veto')).toBe(none);
    expect(bookPinDigest(DEBATE_SLEEVE_ID, 'no-veto')).toBe(none);
  });

  it('has no digest for a sleeve with no declared pins', () => {
    expect(bookPinDigest('trend', 'primary')).toBeUndefined();
  });
});

describe('pins before #2110 (David 2026-10-12, #2121)', () => {
  it('puts the debate books on Sonnet 5, so an undigested debate entry is not under the current pins', () => {
    expect(PRE_DIGEST_ALL_PINS.map((pin) => pin.wire)).toEqual([
      'anthropic/claude-sonnet-5',
      'openai/gpt-5.5',
      'deepseek/deepseek-v4-pro-0813',
      'anthropic/claude-opus-5.5',
    ]);
    expect(bookPreDigestPinDigest(DEBATE_SLEEVE_ID, 'primary')).toBe(
      pinDigest(PRE_DIGEST_ALL_PINS),
    );
    expect(bookPreDigestPinDigest(DEBATE_SLEEVE_ID, 'primary')).not.toBe(
      bookPinDigest(DEBATE_SLEEVE_ID, 'primary'),
    );
  });

  it('matches the current pins wherever they have not changed', () => {
    for (const [sleeve, variant] of [
      [SIGNALS_SLEEVE_ID, 'primary'],
      [SIGNALS_SLEEVE_ID, 'no-veto'],
      [ARM2_SLEEVE_ID, 'technical-only'],
      [DEBATE_SLEEVE_ID, 'no-veto'],
    ] as const) {
      expect(bookPreDigestPinDigest(sleeve, variant)).toBe(bookPinDigest(sleeve, variant));
    }
    expect(bookPreDigestPinDigest('trend', 'primary')).toBeUndefined();
  });
});
