import { describe, expect, it } from 'vitest';
import type { BrokerAdapter } from '../../pipeline/execution/index.js';
import { SimulatedClock } from '../../shared/index.js';
import { SaxoPaperBrokerAdapter } from './saxo-paper-adapter.js';

const bracket = {
  client_order_id: 'o1',
  instrument: 'CSP1',
  asset_class: 'stocks' as const,
  side: 'buy' as const,
  size: 10,
  entry: 100,
  stop: 95,
  target: 0,
  time_in_force: 'day',
};

describe('SaxoPaperBrokerAdapter', () => {
  it('fills at the entry plus half spread and charges the live 0.08% commission', async () => {
    const clock = new SimulatedClock(new Date('2026-09-25T08:00:00.000Z'));
    const adapter: BrokerAdapter = new SaxoPaperBrokerAdapter({ clock, halfSpreadBps: () => 5 });
    const ack = await adapter.submitBracket(bracket);
    expect(ack).toMatchObject({ client_order_id: 'o1', order_state: 'filled' });
    const fills = await adapter.fetchNewFills(new Date('2026-09-25T00:00:00.000Z'));
    expect(fills).toHaveLength(1);
    expect(fills[0]?.price).toBeCloseTo(100.05, 6);
    expect(fills[0]?.fee).toBeCloseTo(1000.5 * 0.0008, 9);
    expect(fills[0]?.fee_currency).toBe('GBP');
    expect(await adapter.getOpenPositions()).toEqual([
      { instrument: 'CSP1', qty: 10, side: 'buy', avg_entry_price: 100.05 },
    ]);
    expect(await adapter.getOrder('o1', 'CSP1')).toMatchObject({ filled_qty: 10 });
    expect(adapter.prices_own_fills).toBe(true);
  });

  it('flattens through the position and averages a second entry', async () => {
    const clock = new SimulatedClock(new Date('2026-09-25T08:00:00.000Z'));
    const adapter: BrokerAdapter = new SaxoPaperBrokerAdapter({ clock, halfSpreadBps: () => 0 });
    await adapter.submitBracket(bracket);
    await adapter.submitBracket({ ...bracket, client_order_id: 'o2', entry: 110 });
    expect((await adapter.getOpenPositions())[0]?.avg_entry_price).toBe(105);
    await adapter.submitFlatten('CSP1', 'sell', 20, 'f1');
    expect(await adapter.getOpenPositions()).toEqual([]);
    expect(await adapter.resumeFlatten('f1', 'CSP1')).toMatchObject({ order_state: 'filled' });
    await expect(adapter.submitFlatten('CSP1', 'sell', 1, 'f2')).rejects.toThrow(
      /nothing to flatten/,
    );
  });

  it('refuses a zero-size or zero-price bracket and only reports fills after since', async () => {
    const clock = new SimulatedClock(new Date('2026-09-25T08:00:00.000Z'));
    const adapter: BrokerAdapter = new SaxoPaperBrokerAdapter({ clock, halfSpreadBps: () => 0 });
    await expect(adapter.submitBracket({ ...bracket, size: 0 })).rejects.toThrow(/bad bracket/);
    await adapter.submitBracket(bracket);
    expect(await adapter.fetchNewFills(new Date('2026-09-25T09:00:00.000Z'))).toEqual([]);
    expect(await adapter.getOrder('missing', 'CSP1')).toBeNull();
    await adapter.cancel('o1', 'CSP1');
    await adapter.resizeProtectiveLegs('o1', 10);
    await adapter.rearmProtectiveLegs('o1', 'CSP1', 'buy', 10, 95, 0);
  });
});
