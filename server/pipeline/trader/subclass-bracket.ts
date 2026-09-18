import type { InstrumentSubclass } from '../../shared/index.js';

export interface SubclassBracket {
  take_profit_pct: number;
  stop_pct: number;
  deployment_fraction: number;
  round_trip_cost_pct: number;
  headroom_reserve_fraction: number;
}

export const D5_INDEX_ETP_DEPLOYMENT_FRACTION = 0.35;

export const D5_SINGLE_STOCK_ETP_DEPLOYMENT_FRACTION = 0.25;

export const D5_SCALE_IN_HEADROOM_RESERVE_FRACTION = 0.1;

export type SubclassBracketTable = Readonly<Record<InstrumentSubclass, SubclassBracket | null>>;

export const ADR_0018_SUBCLASS_BRACKETS: SubclassBracketTable = {
  index_etp_3x: {
    take_profit_pct: 0.02,
    stop_pct: 0.0216,
    deployment_fraction: D5_INDEX_ETP_DEPLOYMENT_FRACTION,
    round_trip_cost_pct: 0.0018,
    headroom_reserve_fraction: D5_SCALE_IN_HEADROOM_RESERVE_FRACTION,
  },
  single_stock_etp_3x: {
    take_profit_pct: 0.06,
    stop_pct: 0.0625,
    deployment_fraction: D5_SINGLE_STOCK_ETP_DEPLOYMENT_FRACTION,
    round_trip_cost_pct: 0.0041,
    headroom_reserve_fraction: D5_SCALE_IN_HEADROOM_RESERVE_FRACTION,
  },
  crypto: null,
};

export function riskFractionFor(bracket: SubclassBracket): number {
  return bracket.deployment_fraction * bracket.stop_pct * (1 - bracket.headroom_reserve_fraction);
}

export class SubclassBracketUnresolvableError extends Error {
  constructor(
    message: string,
    readonly instrument: string,
  ) {
    super(message);
    this.name = 'SubclassBracketUnresolvableError';
  }
}

function assertValidHeadroomReserve(
  bracket: SubclassBracket,
  subclass: InstrumentSubclass,
  instrument: string,
): void {
  const reserve = bracket.headroom_reserve_fraction;
  if (!Number.isFinite(reserve) || reserve < 0 || reserve >= 1) {
    throw new SubclassBracketUnresolvableError(
      `${instrument} is classified '${subclass}', whose bracket declares ` +
        `headroom_reserve_fraction = ${String(reserve)} — outside [0, 1). ` +
        `It is a FRACTION of the D5 envelope, not a percentage — 10% is 0.1, not ` +
        `10. Outside that range riskFractionFor goes negative or to zero, and every entry in this ` +
        `subclass is silently skipped as below_min_notional rather than refused visibly.`,
      instrument,
    );
  }
}

export function resolveSubclassBracket(
  instrument: string,
  subclassOf: Readonly<Record<string, InstrumentSubclass>>,
  brackets: SubclassBracketTable,
): SubclassBracket | null {
  if (Object.keys(subclassOf).length === 0) return null;

  const subclass = subclassOf[instrument];
  if (subclass === undefined) {
    throw new SubclassBracketUnresolvableError(
      `subclass_of is populated but ${instrument} has no subclass ` +
        `(known: ${Object.keys(subclassOf).join(', ')}). ADR-0018 D3's frozen bracket and D5's ` +
        `deployment envelope cannot be resolved without one, and the alternative to this throw ` +
        `is sizing the position on another subclass's numbers. Add the instrument to the pool file.`,
      instrument,
    );
  }

  const bracket: SubclassBracket | null | undefined = brackets[subclass];
  if (bracket === undefined || bracket === null) {
    throw new SubclassBracketUnresolvableError(
      `${instrument} is classified '${subclass}', for which no frozen bracket is declared. ` +
        `ADR-0018 sets brackets for the two leveraged-ETP subclasses only — crypto's are ` +
        `explicitly not set by it, and crypto is out of scope (ADR-0014's 2026-08-16 ` +
        `amendment) — so there is no measured geometry to enter this instrument on.`,
      instrument,
    );
  }

  assertValidHeadroomReserve(bracket, subclass, instrument);

  return bracket;
}
