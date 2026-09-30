import { describe, expect, it } from 'vitest';
import type { BrokerAdapter } from '../../../shared/index.js';
import { DryRunBrokerAdapter, DryRunRefusedError } from './dry-run-broker.js';

describe('DryRunBrokerAdapter', () => {
  it('refuses every submission and never reports a fill, position or order', async () => {
    const broker: BrokerAdapter = new DryRunBrokerAdapter();
    await expect(
      broker.submitBracket({
        client_order_id: 'o1',
        instrument: 'AAPL',
        asset_class: 'stocks',
        side: 'buy',
        size: 3,
        entry: 100,
        stop: 95,
        target: 110,
        time_in_force: 'gtc',
      }),
    ).rejects.toThrow(
      new DryRunRefusedError({ client_order_id: 'o1', instrument: 'AAPL', kind: 'bracket' }),
    );
    await expect(broker.submitFlatten('AAPL', 'sell', 3, 'f1')).rejects.toThrow(
      new DryRunRefusedError({ client_order_id: 'f1', instrument: 'AAPL', kind: 'flatten' }),
    );
    expect(await broker.fetchNewFills(new Date(0))).toEqual([]);
    expect(await broker.getOpenPositions()).toEqual([]);
    expect(await broker.getOrder('o1', 'AAPL')).toBeNull();
    expect(await broker.resumeFlatten('f1', 'AAPL')).toBeNull();
    await broker.cancel('o1', 'AAPL');
    await broker.resizeProtectiveLegs('o1', 1);
    await broker.rearmProtectiveLegs('o1', 'AAPL', 'buy', 1, 0.5, 0);
  });
});
