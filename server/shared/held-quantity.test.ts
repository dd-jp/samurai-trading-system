import {
  coversQty,
  heldQuantitiesFor,
  heldQuantityFromFills,
  isFlat,
  totalHeldQuantity,
} from './held-quantity.js';
import { toBrokerFillId } from './types/records.js';
import type { Fill, OpenPosition } from './types.js';

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
    const recorded = heldQuantityFromFills('lot', fills);
    const persisted = { idempotency_key: 'lot', filled_size: 0.3 + 0.3 + 0.4 } as OpenPosition;
    const [derived] = await heldQuantitiesFor([persisted], async () => new Map([['lot', 0.25]]));
    expect(recorded.held).toBe(derived?.held);
    expect(recorded.filledSize).toBe(1);
    expect(recorded.exitQty).toBe(0.25);
    expect(totalHeldQuantity([recorded])).toBe(recorded.held);
  });

  it('counts every non-entry leg as closing quantity', () => {
    const fills = [fill('entry', 1), fill('stop', 0.4), fill('target', 0.3), fill('exit', 0.3)];
    expect(heldQuantityFromFills('lot', fills).exitQty).toBeCloseTo(1, 12);
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
    const recorded = heldQuantityFromFills('lot', fills);
    expect(recorded.exitQty).not.toBe(recorded.filledSize);
    expect(isFlat(recorded)).toBe(true);
  });

  it('is the same judgement as coversQty', () => {
    expect(isFlat({ filledSize: 1, exitQty: 0.9 })).toBe(coversQty(0.9, 1));
    expect(isFlat({ filledSize: 1, exitQty: 0.9 })).toBe(false);
  });
});
