import { toBrokerFillId } from '../../shared/index.js';
import {
  type BookedRow,
  type CumulativeIncrement,
  type CumulativeObservation,
  cumulativeIncrement,
} from './cumulative-feed.js';

const BASE = 'order-1';

function row(id: string, qty: number, price: number, fee = 0): BookedRow {
  return { broker_fill_id: toBrokerFillId(id), qty, price, fee };
}

function observe(qty: number, price: number, fee = 0): CumulativeObservation {
  return { broker_fill_id: toBrokerFillId(BASE), qty, price, fee };
}

interface Case {
  name: string;
  booked: BookedRow[];
  observation: CumulativeObservation;
  expected: CumulativeIncrement | null;
}

const CASES: Case[] = [
  {
    name: 'first observation with no booked row: nothing to difference against',
    booked: [],
    observation: observe(50, 100),
    expected: null,
  },
  {
    name: 'only other orders booked: still no prior for this id',
    booked: [row('order-2', 50, 100), row('order-2#80', 30, 101)],
    observation: observe(50, 100),
    expected: null,
  },
  {
    name: 're-poll at the same cumulative: null',
    booked: [row(BASE, 50, 100)],
    observation: observe(50, 100),
    expected: null,
  },
  {
    name: 're-poll at the same cumulative after a prior top-up: base + suffixed rows sum to it',
    booked: [row(BASE, 50, 100), row('order-1#80', 30, 101)],
    observation: observe(80, 100.375),
    expected: null,
  },
  {
    name: 'shrinking cumulative: ignored rather than un-booked',
    booked: [row(BASE, 50, 100)],
    observation: observe(30, 100),
    expected: null,
  },
  {
    name: 'delta within QTY_EPSILON_RELATIVE noise: null',
    booked: [row(BASE, 50, 100)],
    observation: observe(50 + 50 * 1e-13, 100),
    expected: null,
  },
  {
    name: 'positive increment: quantity delta, price that makes the cumulative average true',
    booked: [row(BASE, 50, 100)],
    observation: observe(100, 101),
    expected: {
      broker_fill_id: toBrokerFillId('order-1#100'),
      qty: 50,
      price: 102,
      fee: 0,
      bookedQty: 50,
      derivedPrice: 102,
      priceDegraded: false,
    },
  },
  {
    name: 'second increment differences against base AND earlier top-up rows',
    booked: [row(BASE, 50, 100), row('order-1#80', 30, 101)],
    observation: observe(100, 100.5),
    expected: {
      broker_fill_id: toBrokerFillId('order-1#100'),
      qty: 20,
      price: (100.5 * 100 - (100 * 50 + 101 * 30)) / 20,
      fee: 0,
      bookedQty: 80,
      derivedPrice: (100.5 * 100 - (100 * 50 + 101 * 30)) / 20,
      priceDegraded: false,
    },
  },
  {
    name: 'fee delta: cumulative venue fee minus the charged total already booked',
    booked: [row(BASE, 50, 100, 0.5)],
    observation: observe(100, 100, 0.8),
    expected: {
      broker_fill_id: toBrokerFillId('order-1#100'),
      qty: 50,
      price: 100,
      fee: 0.8 - 0.5,
      bookedQty: 50,
      derivedPrice: 100,
      priceDegraded: false,
    },
  },
  {
    name: 'negative fee clamp: a shrinking venue fee total credits nothing',
    booked: [row(BASE, 50, 100, 1)],
    observation: observe(100, 100, 0.4),
    expected: {
      broker_fill_id: toBrokerFillId('order-1#100'),
      qty: 50,
      price: 100,
      fee: 0,
      bookedQty: 50,
      derivedPrice: 100,
      priceDegraded: false,
    },
  },
  {
    name: 'degraded price (non-positive derived): quantity books at the venue average, flagged',
    booked: [row(BASE, 50, 100)],
    observation: observe(60, 80),
    expected: {
      broker_fill_id: toBrokerFillId('order-1#60'),
      qty: 10,
      price: 80,
      fee: 0,
      bookedQty: 50,
      derivedPrice: (80 * 60 - 100 * 50) / 10,
      priceDegraded: true,
    },
  },
  {
    name: 'degraded price (exactly zero derived): flagged, not treated as usable',
    booked: [row(BASE, 50, 100)],
    observation: observe(100, 50),
    expected: {
      broker_fill_id: toBrokerFillId('order-1#100'),
      qty: 50,
      price: 50,
      fee: 0,
      bookedQty: 50,
      derivedPrice: 0,
      priceDegraded: true,
    },
  },
  {
    name: 'degraded price (non-finite derived): flagged, venue average used',
    booked: [row(BASE, 50, 100)],
    observation: observe(100, Number.NaN),
    expected: {
      broker_fill_id: toBrokerFillId('order-1#100'),
      qty: 50,
      price: Number.NaN,
      fee: 0,
      bookedQty: 50,
      derivedPrice: Number.NaN,
      priceDegraded: true,
    },
  },
];

describe('cumulativeIncrement', () => {
  it.each(CASES)('$name', ({ booked, observation, expected }) => {
    expect(cumulativeIncrement(booked, observation)).toEqual(expected);
  });

  it('does not mutate its inputs', () => {
    const booked = [row(BASE, 50, 100)];
    const observation = observe(100, 101);
    const bookedBefore = structuredClone(booked);
    const observationBefore = structuredClone(observation);
    cumulativeIncrement(booked, observation);
    expect(booked).toEqual(bookedBefore);
    expect(observation).toEqual(observationBefore);
  });
});
