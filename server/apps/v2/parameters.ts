export const UNSET: unique symbol = Symbol('unset');

export interface Parameter<T> {
  readonly name: string;
  readonly ticket: string;
  readonly value: T | typeof UNSET;
}

export class UnsetParameterError extends Error {
  readonly parameter: string;
  readonly ticket: string;

  constructor(parameter: string, ticket: string) {
    super(`${parameter} is not set: needs David (${ticket})`);
    this.name = 'UnsetParameterError';
    this.parameter = parameter;
    this.ticket = ticket;
  }
}

export function isSet<T>(parameter: Parameter<T>): parameter is Parameter<T> & { value: T } {
  return parameter.value !== UNSET;
}

export function requireSet<T>(parameter: Parameter<T>): T {
  if (!isSet(parameter)) throw new UnsetParameterError(parameter.name, parameter.ticket);
  return parameter.value;
}

export interface MoverCandidate {
  readonly symbol: string;
  readonly dayReturn: number;
  readonly dollarVolume: number;
}

type MoversSelectionRule = (
  candidates: readonly MoverCandidate[],
  count: number,
) => readonly string[];

interface SmallCapFloors {
  readonly minAverageDollarVolumeUsd: number;
  readonly minPriceUsd: number;
  readonly maxPositionFractionOfEquity: number;
}

interface Arm2EntryThresholds {
  readonly longAbove: number;
  readonly shortBelow: number;
}

function unset<T>(name: string, ticket: string): Parameter<T> {
  return { name, ticket, value: UNSET };
}

export const G4_MOVERS_SELECTION_RULE = unset<MoversSelectionRule>(
  'G4_MOVERS_SELECTION_RULE',
  '#1710',
);
export const G18_SOCIAL_SOURCE = unset<string>('G18_SOCIAL_SOURCE', '#1753');
export const G18_SMALL_CAP_FLOORS = unset<SmallCapFloors>('G18_SMALL_CAP_FLOORS', '#1753');
export const G18_SENTIMENT_DEDUP_RULE = unset<string>('G18_SENTIMENT_DEDUP_RULE', '#961');
export const ALPACA_SHORT_EQUITY_FLOOR_USD = unset<number>(
  'ALPACA_SHORT_EQUITY_FLOOR_USD',
  'doc 66 Q8',
);
export const ARM2_ENTRY_THRESHOLDS = unset<Arm2EntryThresholds>(
  'ARM2_ENTRY_THRESHOLDS',
  'doc 71 §6',
);

export const DEBATE_RISK_FRACTION = unset<number>('DEBATE_RISK_FRACTION', 'doc 66 G18 (2)');
export const DEBATE_TARGET_ATR_MULTIPLE = unset<number>(
  'DEBATE_TARGET_ATR_MULTIPLE',
  'ADR 0001 §5 item 9',
);

export const SHORTS_ENABLED = false;

export const DECLARED_PARAMETERS: readonly Parameter<unknown>[] = [
  G4_MOVERS_SELECTION_RULE,
  G18_SOCIAL_SOURCE,
  G18_SMALL_CAP_FLOORS,
  G18_SENTIMENT_DEDUP_RULE,
  ALPACA_SHORT_EQUITY_FLOOR_USD,
  ARM2_ENTRY_THRESHOLDS,
  DEBATE_RISK_FRACTION,
  DEBATE_TARGET_ATR_MULTIPLE,
];

export const CYCLE_LEVEL_PARAMETERS: readonly Parameter<unknown>[] = [
  ARM2_ENTRY_THRESHOLDS,
  G18_SOCIAL_SOURCE,
  G18_SENTIMENT_DEDUP_RULE,
  ALPACA_SHORT_EQUITY_FLOOR_USD,
  DEBATE_RISK_FRACTION,
  DEBATE_TARGET_ATR_MULTIPLE,
];
