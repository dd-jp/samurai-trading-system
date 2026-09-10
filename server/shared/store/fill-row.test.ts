import { type FillRow, fromFillRow } from './fill-row.js';
import { toStoredTimestamp } from './sqlite-utils.js';

function row(overrides: Partial<FillRow> = {}): FillRow {
  return {
    idempotency_key: 'lot',
    broker_fill_id: 'fill-1',
    leg: 'entry',
    price: 100,
    qty: 10,
    fee: 1,
    timestamp: toStoredTimestamp(new Date(1_000)),
    cost_breakdown_json: null,
    exit_reason: null,
    flatten_idempotency_key: null,
    fee_currency: null,
    ...overrides,
  };
}

describe('fromFillRow', () => {
  it('widens the timestamp and omits absent optionals', () => {
    const fill = fromFillRow(row());
    expect(fill.timestamp).toEqual(new Date(1_000));
    expect(fill.broker_fill_id).toBe('fill-1');
    expect('cost_breakdown' in fill).toBe(false);
    expect('exit_reason' in fill).toBe(false);
    expect('fee_currency' in fill).toBe(false);
  });

  it('carries every later-migration column when present', () => {
    const breakdown = { spread_cost: 1, commission: 0, slippage: 0, market_impact: 0 };
    const fill = fromFillRow(
      row({
        leg: 'exit',
        cost_breakdown_json: JSON.stringify(breakdown),
        exit_reason: 'flatten',
        flatten_idempotency_key: 'flatten-1',
        fee_currency: 'GBP',
      }),
    );
    expect(fill.cost_breakdown).toEqual(breakdown);
    expect(fill.exit_reason).toBe('flatten');
    expect(fill.flatten_idempotency_key).toBe('flatten-1');
    expect(fill.fee_currency).toBe('GBP');
  });
});
