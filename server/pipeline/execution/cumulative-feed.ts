import type { BrokerFillId, Fill } from '../../shared/index.js';
import { QTY_EPSILON_RELATIVE, toBrokerFillId } from '../../shared/index.js';
import type { NormalizedFill } from './types.js';

const TOP_UP_ID_SEPARATOR = '#';

export type BookedRow = Pick<Fill, 'broker_fill_id' | 'qty' | 'price' | 'fee'>;

export type CumulativeObservation = Pick<
  NormalizedFill,
  'broker_fill_id' | 'qty' | 'price' | 'fee'
>;

export interface CumulativeIncrement {
  broker_fill_id: BrokerFillId;
  qty: number;
  price: number;
  fee: number;
  bookedQty: number;
  derivedPrice: number;
  priceDegraded: boolean;
}

export function cumulativeIncrement(
  booked: ReadonlyArray<BookedRow>,
  observation: CumulativeObservation,
): CumulativeIncrement | null {
  const base = observation.broker_fill_id;
  const prefix = `${base}${TOP_UP_ID_SEPARATOR}`;
  const priors = booked.filter(
    (row) => row.broker_fill_id === base || row.broker_fill_id.startsWith(prefix),
  );
  if (priors.length === 0) return null;

  const bookedQty = priors.reduce((sum, row) => sum + row.qty, 0);
  const delta = observation.qty - bookedQty;
  if (!(delta > Math.abs(observation.qty) * QTY_EPSILON_RELATIVE)) return null;

  const bookedNotional = priors.reduce((sum, row) => sum + row.price * row.qty, 0);
  const derivedPrice = (observation.price * observation.qty - bookedNotional) / delta;
  const priceIsUsable = Number.isFinite(derivedPrice) && derivedPrice > 0;

  return {
    broker_fill_id: toBrokerFillId(`${prefix}${observation.qty}`),
    qty: delta,
    price: priceIsUsable ? derivedPrice : observation.price,
    fee: Math.max(0, observation.fee - priors.reduce((sum, row) => sum + row.fee, 0)),
    bookedQty,
    derivedPrice,
    priceDegraded: !priceIsUsable,
  };
}
