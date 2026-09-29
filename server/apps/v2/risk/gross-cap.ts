import type { EntryRoom } from '../../../../contracts/index.js';

export const BOOK_GROSS_NOTIONAL_CAP_OF_EQUITY = 1;

export function grossRoomGbp(equityGbp: number, grossNotionalGbp: number): number {
  return equityGbp * BOOK_GROSS_NOTIONAL_CAP_OF_EQUITY - grossNotionalGbp;
}

export function entryRoomRefusal(
  notionalGbp: number,
  room: EntryRoom,
): 'insufficient_cash' | 'gross_cap' | undefined {
  if (notionalGbp > room.cashGbp) return 'insufficient_cash';
  return notionalGbp > room.grossGbp ? 'gross_cap' : undefined;
}
