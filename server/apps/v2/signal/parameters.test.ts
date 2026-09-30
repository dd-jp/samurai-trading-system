import { describe, expect, it } from 'vitest';
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
  SIGNAL_BUY_STOP_BRACKET_VERIFIED,
  UNSET,
  UnsetParameterError,
} from './parameters.js';

const CFD_GATE_PARAMETERS = [
  CFD_COST_MODEL,
  CFD_SPREAD_MODEL,
  CFD_FINANCING_MODEL,
  CFD_BORROW_MODEL,
  CFD_RESTING_STOP_VERIFIED,
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
      SIGNAL_BUY_STOP_BRACKET_VERIFIED,
    ]);
    expect(CYCLE_LEVEL_PARAMETERS).toEqual([
      G18_SOCIAL_SOURCE,
      G18_SENTIMENT_DEDUP_RULE,
      ALPACA_SHORT_EQUITY_FLOOR_USD,
      ...CFD_GATE_PARAMETERS,
      SIGNAL_BUY_STOP_BRACKET_VERIFIED,
    ]);
    for (const parameter of DECLARED_PARAMETERS) {
      expect(parameter.ticket.length).toBeGreaterThan(0);
      if (parameter === ARM2_ENTRY_THRESHOLDS || parameter === LSE_LIQUIDITY_SCREEN) continue;
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

  it('the reconcile cash tolerance is unset and never refuses a paper cycle (#1872, David 2026-09-29)', () => {
    expect(isSet(RECONCILE_CASH_TOLERANCE_GBP)).toBe(false);
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

  it('the CFD cost model is unset until #1850 and the borrow ceiling is the ruled 2% a year', () => {
    expect(isSet(CFD_COST_MODEL)).toBe(false);
    expect(CFD_COST_MODEL.ticket).toBe('#1850');
    expect(CFD_SHORT_MAX_BORROW_RATE_PER_YEAR).toBe(0.02);
  });

  it('the CFD spread, financing and borrow models are unset until #1850, the resting stop until #1916', () => {
    expect([CFD_SPREAD_MODEL, CFD_FINANCING_MODEL, CFD_BORROW_MODEL].map((p) => p.ticket)).toEqual([
      '#1850',
      '#1850',
      '#1850',
    ]);
    expect(CFD_RESTING_STOP_VERIFIED.ticket).toBe('#1916');
    expect(cfdEntryRefusal()).toBe('cfd_cost_model_unset');
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
        gate.parameter.name === name ? gate : setGate(gate, true),
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
