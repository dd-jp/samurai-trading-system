import { describe, expect, it } from 'vitest';
import { unpricedFillMessage } from './alpaca.js';

describe('Alpaca broker alert messages', () => {
  it('names the fill, its order, size and how long it has gone unpriced', () => {
    expect(
      unpricedFillMessage({
        venue: 'alpaca',
        client_order_id: 'v2-debate-primary-2026-09-28-AAPL',
        broker_fill_id: 'f1',
        leg: 'stop',
        instrument: 'AAPL',
        qty: 3,
        first_seen_at: new Date('2026-09-28T14:00:00Z'),
        unpriced_for_ms: 5_430_000,
        age_out_ms: 86_400_000,
      }),
    ).toBe(
      'AAPL stop fill f1 (order v2-debate-primary-2026-09-28-AAPL, qty 3) unpriced for 91 min',
    );
  });
});
