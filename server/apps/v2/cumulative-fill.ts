import type { RecordedFillPart, V2Fill } from '../../../contracts/index.js';
import { QTY_EPSILON_RELATIVE } from '../../shared/index.js';

export interface FillIncrement {
  readonly idSuffix: string;
  readonly qty: number;
  readonly price: number;
  readonly fee: number;
  readonly priceDegraded: boolean;
}

export type CumulativeVerdict =
  | { readonly kind: 'increment'; readonly increment: FillIncrement }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'behind'; readonly bookedQty: number };

type Observed = Pick<V2Fill, 'qty' | 'price' | 'fee'>;

export function wholeFill(fill: Observed): FillIncrement {
  return { idSuffix: '', qty: fill.qty, price: fill.price, fee: fill.fee, priceDegraded: false };
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

// Parts are journalled in GBP at their own trading date's rate; the venue reports its
// cumulative average in quote currency, so the booked notional goes back to quote currency
// at each part's own rate before the increment is carved out of the cumulative total
export function cumulativeIncrement(
  parts: readonly RecordedFillPart[],
  observed: Observed,
  quotePerGbpOn: (tradingDate: string) => number,
): CumulativeVerdict {
  if (parts.length === 0) return { kind: 'increment', increment: wholeFill(observed) };
  const bookedQty = sum(parts.map((part) => part.qty));
  const delta = observed.qty - bookedQty;
  const tolerance = Math.abs(observed.qty) * QTY_EPSILON_RELATIVE;
  if (delta < -tolerance) return { kind: 'behind', bookedQty };
  if (delta <= tolerance) return { kind: 'duplicate' };
  const native = parts.map((part) => {
    const fx = quotePerGbpOn(part.trading_date);
    return { notional: part.qty * part.price_gbp * fx, fee: part.fee_gbp * fx };
  });
  const bookedNotional = sum(native.map((part) => part.notional));
  const bookedFee = sum(native.map((part) => part.fee));
  const derived = (observed.price * observed.qty - bookedNotional) / delta;
  const priceDegraded = !(Number.isFinite(derived) && derived > 0);
  return {
    kind: 'increment',
    increment: {
      idSuffix: `#${observed.qty}`,
      qty: delta,
      price: priceDegraded ? observed.price : derived,
      fee: Math.max(0, observed.fee - bookedFee),
      priceDegraded,
    },
  };
}
