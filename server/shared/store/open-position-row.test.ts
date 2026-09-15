import {
  fromOpenPositionRow,
  type OpenPositionRow,
  parseModelledCostBreakdownColumn,
} from './open-position-row.js';
import { toStoredTimestamp } from './sqlite-utils.js';

const BREAKDOWN = { spread_cost: 1, commission: 0.5, slippage: 0.25, market_impact: 0 };
// Deliberately distinct from BREAKDOWN so a mapper crossing the two columns fails
const PROTECTIVE_BREAKDOWN = {
  spread_cost: 2,
  commission: 0.75,
  slippage: 0.5,
  market_impact: 0.125,
};

function row(overrides: Partial<OpenPositionRow> = {}): OpenPositionRow {
  return {
    idempotency_key: 'lot',
    debate_id: 'debate',
    instrument: 'AAPL',
    asset_class: 'stocks',
    side: 'buy',
    intent_type: 'entry',
    requested_size: 10,
    filled_size: 10,
    avg_entry_price: 100,
    stop: 95,
    target: 110,
    order_state: 'filled',
    broker_order_ids: '["broker-1"]',
    opened_at: toStoredTimestamp(new Date(1_000)),
    decision_timestamp: toStoredTimestamp(new Date(500)),
    conviction: 0.6,
    converged: 1,
    residual_unprotected_since: null,
    residual_rearm_alerted_at: null,
    residual_rearm_unsupported_alerted_at: null,
    decision_price: null,
    quote_bid: null,
    quote_ask: null,
    quote_mid: null,
    quote_observed_at: null,
    modelled_cost_breakdown_json: null,
    modelled_protective_exit_cost_breakdown_json: null,
    abandon_reason: null,
    ...overrides,
  };
}

describe('fromOpenPositionRow', () => {
  it('widens timestamps, booleans and JSON columns and omits absent optionals', () => {
    const position = fromOpenPositionRow(row());
    expect(position.opened_at).toEqual(new Date(1_000));
    expect(position.decision_timestamp).toEqual(new Date(500));
    expect(position.converged).toBe(true);
    expect(position.broker_order_ids).toEqual(['broker-1']);
    expect('decision_price' in position).toBe(false);
    expect('modelled_cost_breakdown' in position).toBe(false);
    expect('modelled_protective_exit_cost_breakdown' in position).toBe(false);
    expect('abandon_reason' in position).toBe(false);
  });

  it('carries every migration-0037, 0056 and 0061 column when present', () => {
    const position = fromOpenPositionRow(
      row({
        decision_price: 100.5,
        quote_bid: 100,
        quote_ask: 101,
        quote_mid: 100.5,
        quote_observed_at: toStoredTimestamp(new Date(400)),
        modelled_cost_breakdown_json: JSON.stringify(BREAKDOWN),
        modelled_protective_exit_cost_breakdown_json: JSON.stringify(PROTECTIVE_BREAKDOWN),
        abandon_reason: 'wedged_zero_fill',
        order_state: 'abandoned',
      }),
    );
    expect(position.decision_price).toBe(100.5);
    expect(position.quote_observed_at).toEqual(new Date(400));
    expect(position.modelled_cost_breakdown).toEqual(BREAKDOWN);
    expect(position.modelled_protective_exit_cost_breakdown).toEqual(PROTECTIVE_BREAKDOWN);
    expect(position.abandon_reason).toBe('wedged_zero_fill');
  });
});

describe('parseModelledCostBreakdownColumn', () => {
  it.each([
    ['invalid JSON', '{not json'],
    ['an array', '[1,2,3,4]'],
    ['a missing field', JSON.stringify({ spread_cost: 1, commission: 1, slippage: 1 })],
    ['a non-finite field', '{"spread_cost":1,"commission":1,"slippage":1,"market_impact":"x"}'],
  ])('reads %s as absent rather than throwing', (_label, raw) => {
    expect(parseModelledCostBreakdownColumn(raw)).toBeNull();
  });

  it('rebuilds a well-formed breakdown from its four checked numbers', () => {
    expect(parseModelledCostBreakdownColumn(JSON.stringify(BREAKDOWN))).toEqual(BREAKDOWN);
  });
});
