import { describe, expect, it } from 'vitest';
import {
  ALPACA_SHORT_EQUITY_FLOOR_USD,
  ARM2_ENTRY_THRESHOLDS,
  CYCLE_LEVEL_PARAMETERS,
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
  requireSet,
  SAXO_APPROPRIATENESS_TEST_TAKEN,
  SHORTS_ENABLED,
  UNSET,
  UnsetParameterError,
} from './parameters.js';

describe('parameters', () => {
  it('every David-owned parameter names its ticket; unresolved ones are unset', () => {
    expect(DECLARED_PARAMETERS).toEqual([
      G18_SOCIAL_SOURCE,
      G18_SMALL_CAP_FLOORS,
      G18_SENTIMENT_DEDUP_RULE,
      ALPACA_SHORT_EQUITY_FLOOR_USD,
      ARM2_ENTRY_THRESHOLDS,
      LSE_LIQUIDITY_SCREEN,
    ]);
    expect(CYCLE_LEVEL_PARAMETERS).toEqual([
      G18_SOCIAL_SOURCE,
      G18_SENTIMENT_DEDUP_RULE,
      ALPACA_SHORT_EQUITY_FLOOR_USD,
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

  it("the LSE liquidity floor is David's $1M answer, measured in GBP (#1774)", () => {
    expect(requireSet(LSE_LIQUIDITY_SCREEN)).toBe(1_000_000);
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

  it('shorts are off', () => {
    expect(SHORTS_ENABLED).toBe(false);
  });

  it('the Saxo appropriateness test is not yet recorded as taken (doc 66 ruling (l))', () => {
    expect(SAXO_APPROPRIATENESS_TEST_TAKEN).toBe(false);
  });
});
