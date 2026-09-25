import { describe, expect, it } from 'vitest';
import type { BrokerAdapter } from '../../pipeline/execution/index.js';
import { DryRunBrokerAdapter, DryRunRefusedError } from './dry-run-broker.js';

describe('DryRunBrokerAdapter', () => {
  it('refuses every submission and records it', async () => {
    const dryRun = new DryRunBrokerAdapter();
    const adapter: BrokerAdapter = dryRun;
    await expect(
      adapter.submitBracket({
        client_order_id: 'o1',
        instrument: 'AAPL',
        asset_class: 'stocks',
        side: 'buy',
        size: 1,
        entry: 1,
        stop: 0.5,
        target: 0,
        time_in_force: 'day',
      }),
    ).rejects.toBeInstanceOf(DryRunRefusedError);
    await expect(adapter.submitFlatten('AAPL', 'sell', 1, 'f1')).rejects.toBeInstanceOf(
      DryRunRefusedError,
    );
    expect(dryRun.refused.map((entry) => [entry.kind, entry.client_order_id])).toEqual([
      ['bracket', 'o1'],
      ['flatten', 'f1'],
    ]);
    expect(await adapter.getOpenPositions()).toEqual([]);
    expect(await adapter.fetchNewFills(new Date(0))).toEqual([]);
    expect(await adapter.getOrder('o1', 'AAPL')).toBeNull();
    expect(await adapter.resumeFlatten('f1', 'AAPL')).toBeNull();
    await adapter.cancel('o1', 'AAPL');
    await adapter.resizeProtectiveLegs('o1', 1);
    await adapter.rearmProtectiveLegs('o1', 'AAPL', 'buy', 1, 0.5, 0);
  });
});
