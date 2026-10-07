import { describe, expect, it } from 'vitest';
import { SAXO_CFD_COMMISSION, SAXO_CFD_FINANCING, SAXO_CFD_SPREAD } from '../data/index.js';
import {
  ALPACA_SHORT_EQUITY_FLOOR_USD,
  ARM2_ENTRY_THRESHOLDS,
  CFD_BORROW_MODEL,
  CFD_COST_MODEL,
  CFD_ENTRY_GATES,
  CFD_FINANCING_MODEL,
  CFD_RESTING_STOP_VERIFIED,
  CFD_SHORT_MAX_BORROW_RATE_PER_YEAR,
  CFD_SPREAD_MODEL,
  type CfdEntryGate,
  CYCLE_LEVEL_PARAMETERS,
  cfdEntryRefusal,
  DEBATE_RISK_FRACTION,
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
  UNSET,
  UnsetParameterError,
  VOL_TARGET_SIZING,
} from './parameters.js';

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
  RECONCILE_CASH_TOLERANCE_GBP,
  ...CFD_COST_PARAMETERS,
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
      ...CFD_GATE_PARAMETERS,
      RECONCILE_CASH_TOLERANCE_GBP,
      VOL_TARGET_SIZING,
    ]);
    expect(CYCLE_LEVEL_PARAMETERS).toEqual([
      G18_SOCIAL_SOURCE,
      G18_SENTIMENT_DEDUP_RULE,
      ALPACA_SHORT_EQUITY_FLOOR_USD,
      ...CFD_GATE_PARAMETERS,
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

  it('with the cost models set, only the resting stop (#1916) still refuses a CFD entry', () => {
    expect(CFD_RESTING_STOP_VERIFIED.ticket).toBe('#1916');
    expect(isSet(CFD_RESTING_STOP_VERIFIED)).toBe(false);
    expect(cfdEntryRefusal()).toBe('cfd_resting_stop_unverified');
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

    it('names the first unset gate in order when several are missing', () => {
      expect(cfdEntryRefusal([...CFD_ENTRY_GATES].reverse())).toBe('cfd_resting_stop_unverified');
    });
  });

  it('the Saxo appropriateness test is recorded as taken (doc 66 ruling (l), #1774 (b))', () => {
    expect(SAXO_APPROPRIATENESS_TEST_TAKEN).toBe(true);
  });
});
