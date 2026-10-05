import type {
  CfdBorrowModel,
  CfdCostModel,
  CfdCosts,
  CfdFinancingModel,
  CfdSpreadModel,
  SleeveSpec,
} from '../../../../contracts/index.js';
import {
  SAXO_CFD_COMMISSION,
  SAXO_CFD_FINANCING,
  SAXO_CFD_SPREAD,
  saxoCfdBorrow,
} from '../data/index.js';
import type { VolTargetSizing } from '../risk/index.js';

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

export interface Arm2EntryThresholds {
  readonly longAbove: number;
  readonly shortBelow: number;
}

function unset<T>(name: string, ticket: string): Parameter<T> {
  return { name, ticket, value: UNSET };
}

function set<T>(name: string, ticket: string, value: T): Parameter<T> {
  return { name, ticket, value };
}

export const G18_SOCIAL_SOURCE = unset<string>('G18_SOCIAL_SOURCE', '#1753');
export const G18_SMALL_CAP_FLOORS = unset<SmallCapFloors>('G18_SMALL_CAP_FLOORS', '#1753');
export const G18_SENTIMENT_DEDUP_RULE = unset<string>('G18_SENTIMENT_DEDUP_RULE', '#1753');
export const ALPACA_SHORT_EQUITY_FLOOR_USD = unset<number>(
  'ALPACA_SHORT_EQUITY_FLOOR_USD',
  'doc 66 Q8',
);
// Zero reproduces the technical analyst's own read exactly (`directionFrom`,
// `server/apps/v2/signal/debate-sleeve.ts`): SMA-200 cross as the structural gate, no
// further filter on r63 (#1773 proposal comment)
export const ARM2_ENTRY_THRESHOLDS = set<Arm2EntryThresholds>('ARM2_ENTRY_THRESHOLDS', '#1773', {
  longAbove: 0,
  shortBelow: 0,
});
export const LSE_LIQUIDITY_SCREEN = set<number>('LSE_LIQUIDITY_SCREEN', '#1774', 750_000);
// David 2026-10-02, #1927 comment 5959952395 (doc 66 pre-live items ruling 2): £5 on the anchor
// delta, the venue-currency gap converted at the day's rate
export const RECONCILE_CASH_TOLERANCE_GBP = set<number>('RECONCILE_CASH_TOLERANCE_GBP', '#1927', 5);

// #1774, David 2026-09-29 (option 1): on one USD ranking no LSE name reaches the 20
// (ISF ~53M GBP/day against billions), so LSE holds a reserved share of the liquidity half;
// the count is the builder's default until David sets it
export const LSE_RESERVED_SLOTS = 4;

// David's 2026-09-29 chat ruling, #1866 comment 5893163984 item 4 (UK CFD shorts): refuse above
// 2% a year; extended to US CFD shorts by David 2026-09-29 (#1849)
export const CFD_SHORT_MAX_BORROW_RATE_PER_YEAR = 0.02;

// ADR item 19: #1850's figures are sourced, not ruled; the sources sit on each in cfd-tariff.ts
export const CFD_COST_MODEL = set<CfdCostModel>('CFD_COST_MODEL', '#1850', SAXO_CFD_COMMISSION);
export const CFD_SPREAD_MODEL = set<CfdSpreadModel>('CFD_SPREAD_MODEL', '#1850', SAXO_CFD_SPREAD);
export const CFD_FINANCING_MODEL = set<CfdFinancingModel>(
  'CFD_FINANCING_MODEL',
  '#1850',
  SAXO_CFD_FINANCING,
);
export const CFD_BORROW_MODEL = set<CfdBorrowModel>(
  'CFD_BORROW_MODEL',
  '#1850',
  saxoCfdBorrow(CFD_SHORT_MAX_BORROW_RATE_PER_YEAR),
);
export const CFD_RESTING_STOP_VERIFIED = unset<boolean>('CFD_RESTING_STOP_VERIFIED', '#1916');
// Setting it is a new counted trial (CLAUDE.md), so it stays unset until David pre-declares the
// target, window and sleeves; unset, every sleeve sizes exactly as before
export const VOL_TARGET_SIZING = unset<VolTargetSizing>('VOL_TARGET_SIZING', '#1860');

export function declaredVolTarget(
  parameter: Parameter<VolTargetSizing> = VOL_TARGET_SIZING,
): VolTargetSizing | undefined {
  return isSet(parameter) ? parameter.value : undefined;
}

export interface CfdEntryGate {
  readonly parameter: Parameter<unknown>;
  readonly refusal: string;
}

export const CFD_ENTRY_GATES: readonly CfdEntryGate[] = [
  { parameter: CFD_COST_MODEL, refusal: 'cfd_cost_model_unset' },
  { parameter: CFD_SPREAD_MODEL, refusal: 'cfd_spread_model_unset' },
  { parameter: CFD_FINANCING_MODEL, refusal: 'cfd_financing_model_unset' },
  { parameter: CFD_BORROW_MODEL, refusal: 'cfd_borrow_model_unset' },
  { parameter: CFD_RESTING_STOP_VERIFIED, refusal: 'cfd_resting_stop_unverified' },
];

export function cfdEntryRefusal(
  gates: readonly CfdEntryGate[] = CFD_ENTRY_GATES,
): string | undefined {
  return gates.find(({ parameter }) => parameter.value === UNSET || parameter.value === false)
    ?.refusal;
}

type CfdCostParameters = { readonly [K in keyof CfdCosts]: Parameter<CfdCosts[K]> };

const CFD_COST_PARAMETERS: CfdCostParameters = {
  fee: CFD_COST_MODEL,
  spread: CFD_SPREAD_MODEL,
  financing: CFD_FINANCING_MODEL,
  borrow: CFD_BORROW_MODEL,
};

export function declaredCfdCosts(
  parameters: CfdCostParameters = CFD_COST_PARAMETERS,
): CfdCosts | undefined {
  const { fee, spread, financing, borrow } = parameters;
  if (!isSet(fee) || !isSet(spread) || !isSet(financing) || !isSet(borrow)) return undefined;
  return { fee: fee.value, spread: spread.value, financing: financing.value, borrow: borrow.value };
}

// doc 66 ruling (l): keep SGLN, SSLN (PHGP, PHSP are alternates doc 70 noted, not
// separately committed lines), but no order in a complex line until David records
// the Saxo appropriateness test as taken (his admin); recorded 2026-09-29 (#1774 (b))
export const SAXO_APPROPRIATENESS_TEST_TAKEN = true;

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

export const ARM2_SLEEVE_ID = 'arm2';

// #1773: arm 2 never routes a real order (its only book variant is not 'primary', so
// `V2OrderExecutor.simulates()` always simulates it), so its capital share is notional —
// it sizes and seeds its shadow book (same start capital as debate, Q14) but is excluded
// from `assertCapitalShares`' account-wide ceiling, which sums only sleeves that can hold
// a real fill (doc 66, 2026-09-28 addition)
export const ARM2_SLEEVE_SPEC: SleeveSpec = {
  capitalShare: DEBATE_CAPITAL_SHARE,
  minimumCapitalGbp: 0,
  capacityGbp: Number.POSITIVE_INFINITY,
  validation: 'forward-paper',
  macroGate: true,
  sizing: DEBATE_SLEEVE_SPEC.sizing,
  books: [{ variant: 'technical-only', instantiated: true }],
};

export const SIGNALS_SLEEVE_ID = 'signals';
export const SIGNAL_MIN_REWARD_R = 2;
// David 2026-09-30 (#1941): the whole idle 70% paper share, the loss and daily caps following it
const SIGNALS_CAPITAL_SHARE = 0.7;
const SIGNALS_NO_TIME_STOP_TRADING_DAYS = 1_000_000;

// Sized on R = entry - stop: the decision's atr is R and the stop sits one "ATR" below entry
export const SIGNALS_SLEEVE_SPEC: SleeveSpec = {
  capitalShare: SIGNALS_CAPITAL_SHARE,
  minimumCapitalGbp: 0,
  capacityGbp: Number.POSITIVE_INFINITY,
  validation: 'forward-paper',
  macroGate: false,
  sizing: {
    riskFraction: DEBATE_RISK_FRACTION,
    stopAtrMultiple: 1,
    targetAtrMultiple: SIGNAL_MIN_REWARD_R,
    timeStopTradingDays: SIGNALS_NO_TIME_STOP_TRADING_DAYS,
    advShare: DEBATE_ADV_SHARE,
    advWindowBars: DEBATE_ADV_WINDOW_BARS,
  },
  books: [
    { variant: 'primary', instantiated: true },
    { variant: 'no-veto', instantiated: true },
  ],
};

// A sleeve missing here is a build gap, not a trading-state check
export const SLEEVE_SPECS_BY_ID: Readonly<Record<string, SleeveSpec>> = {
  [DEBATE_SLEEVE_ID]: DEBATE_SLEEVE_SPEC,
  [ARM2_SLEEVE_ID]: ARM2_SLEEVE_SPEC,
  [SIGNALS_SLEEVE_ID]: SIGNALS_SLEEVE_SPEC,
};

export const MOVERS_MIN_DOLLAR_VOLUME_USD = 50_000_000;

export const DECLARED_PARAMETERS: readonly Parameter<unknown>[] = [
  G18_SOCIAL_SOURCE,
  G18_SMALL_CAP_FLOORS,
  G18_SENTIMENT_DEDUP_RULE,
  ALPACA_SHORT_EQUITY_FLOOR_USD,
  ARM2_ENTRY_THRESHOLDS,
  LSE_LIQUIDITY_SCREEN,
  ...CFD_ENTRY_GATES.map(({ parameter }) => parameter),
  RECONCILE_CASH_TOLERANCE_GBP,
  VOL_TARGET_SIZING,
];

// The cycle journals only the unset ones; ARM2_ENTRY_THRESHOLDS (#1773, set) stays out of it
// but stays in DECLARED_PARAMETERS
export const CYCLE_LEVEL_PARAMETERS: readonly Parameter<unknown>[] = [
  G18_SOCIAL_SOURCE,
  G18_SENTIMENT_DEDUP_RULE,
  ALPACA_SHORT_EQUITY_FLOOR_USD,
  ...CFD_ENTRY_GATES.map(({ parameter }) => parameter),
];
