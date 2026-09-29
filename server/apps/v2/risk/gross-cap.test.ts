import { describe, expect, it } from 'vitest';
import { BOOK_GROSS_NOTIONAL_CAP_OF_EQUITY, entryRoomRefusal, grossRoomGbp } from './gross-cap.js';

describe('grossRoomGbp', () => {
  it('is 1x equity less the gross already held or resting', () => {
    expect(BOOK_GROSS_NOTIONAL_CAP_OF_EQUITY).toBe(1);
    expect(grossRoomGbp(2_000, 0)).toBe(2_000);
    expect(grossRoomGbp(2_000, 1_500)).toBe(500);
    expect(grossRoomGbp(2_000, 2_000)).toBe(0);
  });

  it('goes negative once the book is over the cap, so nothing more fits', () => {
    expect(grossRoomGbp(2_000, 2_500)).toBe(-500);
  });

  it('follows equity down as well as up', () => {
    expect(grossRoomGbp(1_500, 1_000)).toBe(500);
    expect(grossRoomGbp(2_500, 1_000)).toBe(1_500);
  });
});

describe('entryRoomRefusal', () => {
  const room = { cashGbp: 1_000, grossGbp: 400 };

  it('admits a notional up to and including the gross room', () => {
    expect(entryRoomRefusal(399, room)).toBeUndefined();
    expect(entryRoomRefusal(400, room)).toBeUndefined();
  });

  it('refuses one pence over the gross room as gross_cap', () => {
    expect(entryRoomRefusal(400.01, room)).toBe('gross_cap');
  });

  it('admits up to and refuses one pence over the cash room as insufficient_cash', () => {
    const cashTight = { cashGbp: 400, grossGbp: 1_000 };
    expect(entryRoomRefusal(400, cashTight)).toBeUndefined();
    expect(entryRoomRefusal(400.01, cashTight)).toBe('insufficient_cash');
  });

  it('names cash first when both are exceeded', () => {
    expect(entryRoomRefusal(2_000, room)).toBe('insufficient_cash');
  });

  it('is the only gate a short faces when short proceeds have inflated cash', () => {
    expect(entryRoomRefusal(600, { cashGbp: 5_000, grossGbp: 400 })).toBe('gross_cap');
  });

  it('refuses everything on an exhausted room', () => {
    expect(entryRoomRefusal(1, { cashGbp: 1_000, grossGbp: 0 })).toBe('gross_cap');
    expect(entryRoomRefusal(1, { cashGbp: 1_000, grossGbp: -50 })).toBe('gross_cap');
  });
});
