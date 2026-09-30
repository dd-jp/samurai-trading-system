import { describe, expect, it } from 'vitest';
import type { RecordedFillPart } from '../../../contracts/index.js';
import { cumulativeIncrement, wholeFill } from './cumulative-fill.js';

const FX_BY_DATE: Record<string, number> = { '2026-09-28': 1.25, '2026-09-29': 1.5 };
const fxOn = (date: string) => FX_BY_DATE[date] ?? Number.NaN;

function part(qty: number, price: number, fee: number, date = '2026-09-28'): RecordedFillPart {
  const fx = fxOn(date);
  return { qty, price_gbp: price / fx, fee_gbp: fee / fx, trading_date: date };
}

describe('wholeFill', () => {
  it('books the report as it stands, under the bare id', () => {
    expect(wholeFill({ qty: 6, price: 20, fee: 0.5 })).toEqual({
      idSuffix: '',
      qty: 6,
      price: 20,
      fee: 0.5,
      priceDegraded: false,
    });
  });
});

describe('cumulativeIncrement', () => {
  it('books the first report whole under the bare id', () => {
    expect(cumulativeIncrement([], { qty: 4, price: 20, fee: 0.3 }, fxOn)).toEqual({
      kind: 'increment',
      increment: { idSuffix: '', qty: 4, price: 20, fee: 0.3, priceDegraded: false },
    });
  });

  it('carves the increment price and fee out of the running average and total fee', () => {
    const verdict = cumulativeIncrement(
      [part(4, 20, 0.3)],
      { qty: 10, price: 20.6, fee: 0.5 },
      fxOn,
    );
    expect(verdict).toEqual({
      kind: 'increment',
      increment: {
        idSuffix: '#10',
        qty: 6,
        price: expect.closeTo(21, 9),
        fee: expect.closeTo(0.2, 9),
        priceDegraded: false,
      },
    });
  });

  it('converts each booked part back at its own trading date rate', () => {
    const verdict = cumulativeIncrement(
      [part(2, 20, 0, '2026-09-28'), part(2, 22, 0, '2026-09-29')],
      { qty: 6, price: 22, fee: 0 },
      fxOn,
    );
    expect(verdict).toMatchObject({
      kind: 'increment',
      increment: { idSuffix: '#6', qty: 2, price: expect.closeTo(24, 9) },
    });
  });

  it('never books a negative fee when the venue reports less fee than booked', () => {
    const verdict = cumulativeIncrement([part(4, 20, 1)], { qty: 6, price: 20, fee: 0.5 }, fxOn);
    expect(verdict).toMatchObject({ kind: 'increment', increment: { fee: 0 } });
  });

  it('treats a report equal to the booked quantity as a duplicate', () => {
    expect(
      cumulativeIncrement([part(4, 20, 0), part(6, 21, 0)], { qty: 10, price: 20.6, fee: 0 }, fxOn),
    ).toEqual({
      kind: 'duplicate',
    });
  });

  it('treats a report within float noise of the booked quantity as a duplicate, either side', () => {
    const booked = [part(0.1, 20, 0), part(0.2, 20, 0)];
    expect(cumulativeIncrement(booked, { qty: 0.3, price: 20, fee: 0 }, fxOn).kind).toBe(
      'duplicate',
    );
    expect(
      cumulativeIncrement([part(0.3, 20, 0)], { qty: 0.1 + 0.2, price: 20, fee: 0 }, fxOn).kind,
    ).toBe('duplicate');
  });

  it('reports a cumulative quantity below the booked one as behind, never a negative fill', () => {
    expect(cumulativeIncrement([part(10, 20, 0)], { qty: 6, price: 20, fee: 0 }, fxOn)).toEqual({
      kind: 'behind',
      bookedQty: 10,
    });
  });

  it('falls back to the running average when the carved price is not positive', () => {
    const verdict = cumulativeIncrement([part(4, 30, 0)], { qty: 6, price: 10, fee: 0 }, fxOn);
    expect(verdict).toEqual({
      kind: 'increment',
      increment: { idSuffix: '#6', qty: 2, price: 10, fee: 0, priceDegraded: true },
    });
  });

  it('falls back to the running average when the carved price is exactly zero', () => {
    const verdict = cumulativeIncrement([part(4, 30, 0)], { qty: 6, price: 20, fee: 0 }, fxOn);
    expect(verdict).toMatchObject({ increment: { price: 20, priceDegraded: true } });
  });

  it('falls back to the running average when a part date has no rate', () => {
    const verdict = cumulativeIncrement(
      [{ qty: 4, price_gbp: 16, fee_gbp: 0, trading_date: '2020-01-01' }],
      { qty: 6, price: 20, fee: 0 },
      fxOn,
    );
    expect(verdict).toMatchObject({ increment: { qty: 2, price: 20, priceDegraded: true } });
  });
});
