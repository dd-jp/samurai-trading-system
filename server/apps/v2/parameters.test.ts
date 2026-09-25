import { describe, expect, it } from 'vitest';
import {
  ALPACA_SHORT_EQUITY_FLOOR_USD,
  ARM2_ENTRY_THRESHOLDS,
  CYCLE_LEVEL_PARAMETERS,
  DEBATE_RISK_FRACTION,
  DEBATE_TARGET_ATR_MULTIPLE,
  DECLARED_PARAMETERS,
  G4_MOVERS_SELECTION_RULE,
  G18_SENTIMENT_DEDUP_RULE,
  G18_SMALL_CAP_FLOORS,
  G18_SOCIAL_SOURCE,
  isSet,
  type Parameter,
  requireSet,
  SHORTS_ENABLED,
  UNSET,
  UnsetParameterError,
} from './parameters.js';

describe('parameters', () => {
  it('every declared parameter is unset and names its ticket', () => {
    expect(DECLARED_PARAMETERS).toEqual([
      G4_MOVERS_SELECTION_RULE,
      G18_SOCIAL_SOURCE,
      G18_SMALL_CAP_FLOORS,
      G18_SENTIMENT_DEDUP_RULE,
      ALPACA_SHORT_EQUITY_FLOOR_USD,
      ARM2_ENTRY_THRESHOLDS,
      DEBATE_RISK_FRACTION,
      DEBATE_TARGET_ATR_MULTIPLE,
    ]);
    expect(
      CYCLE_LEVEL_PARAMETERS.every((parameter) => DECLARED_PARAMETERS.includes(parameter)),
    ).toBe(true);
    for (const parameter of DECLARED_PARAMETERS) {
      expect(parameter.value).toBe(UNSET);
      expect(isSet(parameter)).toBe(false);
      expect(parameter.ticket.length).toBeGreaterThan(0);
      expect(() => requireSet(parameter)).toThrow(UnsetParameterError);
    }
  });

  it('requireSet throws naming the parameter and ticket', () => {
    let caught: unknown;
    try {
      requireSet(G4_MOVERS_SELECTION_RULE);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnsetParameterError);
    const error = caught as UnsetParameterError;
    expect(error.parameter).toBe('G4_MOVERS_SELECTION_RULE');
    expect(error.ticket).toBe('#1710');
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
});
