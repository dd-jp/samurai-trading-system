import { toBrokerFillId } from '../../shared/index.js';
import { splitFlattenFills } from './flatten-attribution.js';
import type { NormalizedFill } from './types.js';

const BREAKDOWN = { spread_cost: 4, commission: 8, slippage: 2, market_impact: 1 };

function rawFill(overrides: Partial<NormalizedFill> & { qty: number }): NormalizedFill {
  return {
    client_order_id: 'flatten-1',
    broker_fill_id: toBrokerFillId('venue-1'),
    leg: 'entry',
    price: 100,
    fee: 1,
    timestamp: new Date(0),
    qty_is_cumulative: true,
    ...overrides,
  };
}

function split(rawFills: NormalizedFill[], totalShare: [string, number][], size = 10) {
  return splitFlattenFills({
    clientOrderId: 'flatten-1',
    rawFills,
    lotKeys: totalShare.map(([key]) => key),
    totalShare: new Map(totalShare),
    attribution: { exit_reason: 'flatten', modelled_cost_breakdown: BREAKDOWN, size },
  });
}

describe('splitFlattenFills', () => {
  it('allocates FIFO across the named lots, capped at each journalled share', () => {
    const result = split(
      [rawFill({ qty: 10 })],
      [
        ['lot-a', 4],
        ['lot-b', 6],
      ],
    );
    expect(result.splits.get('lot-a')?.map((fill) => fill.qty)).toEqual([4]);
    expect(result.splits.get('lot-b')?.map((fill) => fill.qty)).toEqual([6]);
    expect([...result.remaining]).toEqual([
      ['lot-a', 0],
      ['lot-b', 0],
    ]);
    expect(result.outcomes[0]?.leftover).toBe(0);
    expect(result.outcomes[0]?.attributed).toEqual([
      { idempotency_key: 'lot-a', broker_fill_id: toBrokerFillId('venue-1:lot-a') },
      { idempotency_key: 'lot-b', broker_fill_id: toBrokerFillId('venue-1:lot-b') },
    ]);
  });

  it('reports the quantity no named lot could absorb as leftover', () => {
    const result = split([rawFill({ qty: 12 })], [['lot-a', 10]]);
    expect(result.splits.get('lot-a')?.[0]?.qty).toBe(10);
    expect(result.outcomes[0]?.leftover).toBe(2);
  });

  it('leaves the unconsumed share of an under-filled flatten as a residual', () => {
    const result = split(
      [rawFill({ qty: 5 })],
      [
        ['lot-a', 4],
        ['lot-b', 6],
      ],
    );
    expect(result.splits.has('lot-b')).toBe(true);
    expect(result.remaining.get('lot-a')).toBe(0);
    expect(result.remaining.get('lot-b')).toBe(5);
  });

  it('counts an earlier raw fill against a share before allocating a later one', () => {
    const result = split(
      [
        rawFill({ broker_fill_id: toBrokerFillId('venue-1'), qty: 6 }),
        rawFill({ broker_fill_id: toBrokerFillId('venue-2'), qty: 4 }),
      ],
      [
        ['lot-a', 4],
        ['lot-b', 6],
      ],
    );
    expect(result.splits.get('lot-a')?.map((fill) => fill.qty)).toEqual([4]);
    expect(result.splits.get('lot-b')?.map((fill) => fill.qty)).toEqual([2, 4]);
    expect(result.outcomes.map((outcome) => outcome.leftover)).toEqual([0, 0]);
  });

  it('re-keys every split to the lot as a plain exit fill of the flatten', () => {
    const [fill] =
      split([rawFill({ qty: 10, leg: 'stop' })], [['lot-a', 10]]).splits.get('lot-a') ?? [];
    expect(fill).toMatchObject({
      leg: 'exit',
      exit_reason: 'flatten',
      flatten_idempotency_key: 'flatten-1',
      broker_fill_id: 'venue-1:lot-a',
      qty_is_cumulative: false,
    });
  });

  it('omits exit_reason for a journal row written before it was recorded', () => {
    const result = splitFlattenFills({
      clientOrderId: 'flatten-1',
      rawFills: [rawFill({ qty: 10 })],
      lotKeys: ['lot-a'],
      totalShare: new Map([['lot-a', 10]]),
      attribution: { exit_reason: null, modelled_cost_breakdown: null, size: 10 },
    });
    const [fill] = result.splits.get('lot-a') ?? [];
    expect(fill).not.toHaveProperty('exit_reason');
    expect(fill).not.toHaveProperty('cost_breakdown');
    expect(fill?.fee).toBe(1);
  });

  it('prorates the modelled cost by the submission size so two raw fills sum to one estimate', () => {
    const result = split(
      [
        rawFill({ broker_fill_id: toBrokerFillId('venue-1'), qty: 4, fee: 0 }),
        rawFill({ broker_fill_id: toBrokerFillId('venue-2'), qty: 6, fee: 0 }),
      ],
      [['lot-a', 10]],
      10,
    );
    const fills = result.splits.get('lot-a') ?? [];
    expect(fills.map((fill) => fill.cost_breakdown?.commission)).toEqual([3.2, 4.8]);
    expect(
      fills.reduce((sum, fill) => sum + (fill.cost_breakdown?.spread_cost ?? 0), 0),
    ).toBeCloseTo(BREAKDOWN.spread_cost, 12);
    expect(fills.map((fill) => fill.fee)).toEqual([3.2, 4.8]);
  });

  it('tops the venue fee up to the modelled commission share instead of stacking them', () => {
    const [fill] =
      split([rawFill({ qty: 10, fee: 20 })], [['lot-a', 10]]).splits.get('lot-a') ?? [];
    expect(fill?.fee).toBe(20);
    expect(fill?.cost_breakdown?.commission).toBe(8);
  });

  it('keeps the adapter-priced breakdown of a simulated fill rather than substituting the estimate', () => {
    const priced = { spread_cost: 1, commission: 1, slippage: 1, market_impact: 1 };
    const [fill] =
      split([rawFill({ qty: 10, cost_breakdown: priced })], [['lot-a', 10]]).splits.get('lot-a') ??
      [];
    expect(fill?.cost_breakdown).toEqual(priced);
  });

  it('attaches no breakdown to a corrupted zero-size submission', () => {
    const [fill] = split([rawFill({ qty: 10 })], [['lot-a', 10]], 0).splits.get('lot-a') ?? [];
    expect(fill).not.toHaveProperty('cost_breakdown');
    expect(Number.isFinite(fill?.fee)).toBe(true);
  });
});
