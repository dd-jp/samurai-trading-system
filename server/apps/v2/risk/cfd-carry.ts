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

const NO_CFD_CARRY: CfdCarry = { financingGbp: 0, borrowGbp: 0 };

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

export function cfdCarryAccrual(
  positions: readonly Position[],
  markGbp: MarkPriceGbp,
  calendarDays: number,
  rates: CfdCarryRates | undefined,
): CfdCarry {
  if (rates === undefined) return NO_CFD_CARRY;
  let financingGbp = 0;
  let borrowGbp = 0;
  for (const held of positions.filter((position) => isCfdVenue(position.venue))) {
    const carry = positionCarry(held, markGbp, calendarDays, rates);
    financingGbp += carry.financingGbp;
    borrowGbp += carry.borrowGbp;
  }
  return { financingGbp, borrowGbp };
}
