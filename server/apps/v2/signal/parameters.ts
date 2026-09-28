import type { SleeveSpec } from '../../../../contracts/index.js';

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
export const LSE_LIQUIDITY_SCREEN = unset<number>('LSE_LIQUIDITY_SCREEN', '#1774');

export const SHORTS_ENABLED = false;

// doc 66 ruling (l): keep SGLN, SSLN (PHGP, PHSP are alternates doc 70 noted, not
// separately committed lines), but no order in a complex line until David records
// the Saxo appropriateness test as taken (his admin)
export const SAXO_APPROPRIATENESS_TEST_TAKEN = false;

export const DEBATE_RISK_FRACTION = 0.005;
export const DEBATE_STOP_ATR_MULTIPLE = 2;
export const DEBATE_TARGET_ATR_MULTIPLE = 3;
export const DEBATE_TIME_STOP_TRADING_DAYS = 10;
const DEBATE_ADV_SHARE = 0.01;
const DEBATE_ADV_WINDOW_BARS = 20;

// Q14: 30% to debate, the 70% to S2 passers; S1 holds it in cash until one passes
const DEBATE_CAPITAL_SHARE = 0.3;

export const DEBATE_SLEEVE_ID = 'debate';

export const DEBATE_SLEEVE_SPEC: SleeveSpec = {
  capitalShare: DEBATE_CAPITAL_SHARE,
  minimumCapitalGbp: 0,
  capacityGbp: Number.POSITIVE_INFINITY,
  validation: 'forward-paper',
  macroGate: true,
  sizing: {
    riskFraction: DEBATE_RISK_FRACTION,
    stopAtrMultiple: DEBATE_STOP_ATR_MULTIPLE,
    targetAtrMultiple: DEBATE_TARGET_ATR_MULTIPLE,
    timeStopTradingDays: DEBATE_TIME_STOP_TRADING_DAYS,
    advShare: DEBATE_ADV_SHARE,
    advWindowBars: DEBATE_ADV_WINDOW_BARS,
  },
  books: [
    { variant: 'primary', instantiated: true },
    { variant: 'no-macro-gate', instantiated: true },
    { variant: 'no-sentiment', instantiated: false },
    { variant: 'no-social', instantiated: false },
    { variant: 'large-cap-only', instantiated: false },
  ],
};

// A sleeve missing here is a build gap, not a trading-state check
export const SLEEVE_SPECS_BY_ID: Readonly<Record<string, SleeveSpec>> = {
  [DEBATE_SLEEVE_ID]: DEBATE_SLEEVE_SPEC,
};

export const MOVERS_MIN_DOLLAR_VOLUME_USD = 50_000_000;

export const DECLARED_PARAMETERS: readonly Parameter<unknown>[] = [
  G18_SOCIAL_SOURCE,
  G18_SMALL_CAP_FLOORS,
  G18_SENTIMENT_DEDUP_RULE,
  ALPACA_SHORT_EQUITY_FLOOR_USD,
  ARM2_ENTRY_THRESHOLDS,
  LSE_LIQUIDITY_SCREEN,
];

export const CYCLE_LEVEL_PARAMETERS: readonly Parameter<unknown>[] = [
  ARM2_ENTRY_THRESHOLDS,
  G18_SOCIAL_SOURCE,
  G18_SENTIMENT_DEDUP_RULE,
  ALPACA_SHORT_EQUITY_FLOOR_USD,
];
