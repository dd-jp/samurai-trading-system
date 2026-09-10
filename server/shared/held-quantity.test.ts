import {
  coversQty,
  heldQuantitiesFor,
  heldQuantityFromFills,
  isFlat,
  weightedAvgPrice,
} from './held-quantity.js';
import { toBrokerFillId } from './types/records.js';
import type { Fill, OpenPosition } from './types.js';

function openPosition(filled_size: number): OpenPosition {
  return {
    idempotency_key: 'lot',
    debate_id: 'debate',
    instrument: 'AAPL',
    asset_class: 'stocks',
    side: 'buy',
    intent_type: 'entry',
    requested_size: filled_size,
    filled_size,
    avg_entry_price: 100,
    stop: 95,
    target: 110,
    order_state: 'filled',
    broker_order_ids: ['broker-1'],
    opened_at: new Date(0),
    decision_timestamp: new Date(0),
    conviction: 0.6,
    converged: true,
  };
}

function fill(leg: Fill['leg'], qty: number): Fill {
  return {
    idempotency_key: 'lot',
    broker_fill_id: toBrokerFillId(`${leg}-${qty}-${Math.random()}`),
    leg,
    price: 100,
    qty,
    fee: 0,
    timestamp: new Date(0),
  };
}

describe('heldQuantityFromFills', () => {
  it('agrees with heldQuantitiesFor when filled_size is the entry-fill sum', async () => {
    const fills = [fill('entry', 0.3), fill('entry', 0.3), fill('entry', 0.4), fill('exit', 0.25)];
    const recorded = heldQuantityFromFills(fills);
    const persisted = openPosition(0.3 + 0.3 + 0.4);
    const [derived] = await heldQuantitiesFor([persisted], async () => new Map([['lot', 0.25]]));
    expect(recorded.held).toBe(derived?.held);
    expect(recorded.filledSize).toBe(1);
    expect(recorded.exitQty).toBe(0.25);
  });

  it('counts every non-entry leg as closing quantity', () => {
    const fills = [fill('entry', 1), fill('stop', 0.4), fill('target', 0.3), fill('exit', 0.3)];
    expect(heldQuantityFromFills(fills).exitQty).toBeCloseTo(1, 12);
  });
});

describe('weightedAvgPrice', () => {
  it('weights by quantity and reads zero for no quantity', () => {
    expect(weightedAvgPrice([])).toBe(0);
    expect(
      weightedAvgPrice([
        { ...fill('entry', 1), price: 100 },
        { ...fill('entry', 3), price: 104 },
      ]),
    ).toBe(103);
  });
});

describe('isFlat', () => {
  it('reads a lot flat under the ADR-0005 tolerance even when tranche order differs', () => {
    const fills = [
      fill('entry', 0.3),
      fill('entry', 0.3),
      fill('entry', 0.4),
      fill('exit', 0.7),
      fill('exit', 0.2),
      fill('exit', 0.1),
    ];
    const recorded = heldQuantityFromFills(fills);
    expect(recorded.exitQty).not.toBe(recorded.filledSize);
    expect(isFlat(recorded)).toBe(true);
  });

  it('is the same judgement as coversQty', () => {
    expect(isFlat({ filledSize: 1, exitQty: 0.9 })).toBe(coversQty(0.9, 1));
    expect(isFlat({ filledSize: 1, exitQty: 0.9 })).toBe(false);
  });
});
