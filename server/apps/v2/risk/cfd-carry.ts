import type {
  CfdBorrowModel,
  CfdFinancingModel,
  MarkPriceGbp,
  Position,
} from '../../../../contracts/index.js';
import { isCfdVenue } from '../data/index.js';

export interface CfdCarryRates {
  readonly financing: CfdFinancingModel;
  readonly borrow: CfdBorrowModel;
  readonly quotedBorrowPerDay: (instrument: string) => number | undefined;
}

export interface CfdCarry {
  readonly financingGbp: number;
  readonly borrowGbp: number;
}

function positionCarry(
  held: Position,
  markGbp: MarkPriceGbp,
  calendarDays: number,
  rates: CfdCarryRates,
): CfdCarry {
  const notionalGbp = Math.abs(
    held.qty * (markGbp(held.instrument, held.venue) ?? held.avgPriceGbp),
  );
  const accrued = (dailyRate: number) => notionalGbp * dailyRate * calendarDays;
  if (held.qty > 0) {
    return { financingGbp: accrued(rates.financing.dailyRate(held.venue, 'long')), borrowGbp: 0 };
  }
  return {
    financingGbp: accrued(rates.financing.dailyRate(held.venue, 'short')),
    borrowGbp: accrued(
      rates.borrow.dailyRate(held.venue, rates.quotedBorrowPerDay(held.instrument)),
    ),
  };
}

export interface CfdPositionCarry extends CfdCarry {
  readonly position: Position;
}

export function cfdPositionCarry(
  positions: readonly Position[],
  markGbp: MarkPriceGbp,
  calendarDays: number,
  rates: CfdCarryRates | undefined,
): CfdPositionCarry[] {
  if (rates === undefined) return [];
  return positions
    .filter((position) => isCfdVenue(position.venue))
    .map((position) => ({ position, ...positionCarry(position, markGbp, calendarDays, rates) }));
}

export function cfdCarryAccrual(carried: readonly CfdPositionCarry[]): CfdCarry {
  let financingGbp = 0;
  let borrowGbp = 0;
  for (const carry of carried) {
    financingGbp += carry.financingGbp;
    borrowGbp += carry.borrowGbp;
  }
  return { financingGbp, borrowGbp };
}
