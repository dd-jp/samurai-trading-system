import { describe, expect, it, vi } from 'vitest';
import type { BrokerAdapter } from '../../../pipeline/execution/index.js';
import { SimulatedClock } from '../../../shared/index.js';
import { DryRunBrokerAdapter, DryRunRefusedError } from './dry-run-broker.js';

const clock = new SimulatedClock(new Date('2026-09-25T07:00:00.000Z'));

function adapter(
  markPrice: () => number | undefined = () => 50,
  fee = vi.fn(() => 7),
): DryRunBrokerAdapter {
  const pricing = { halfSpreadBps: () => 10, impactBps: () => 0, fee };
  return new DryRunBrokerAdapter({ venue: 'saxo', pricing, markPrice, clock });
}

describe('DryRunBrokerAdapter', () => {
  it('refuses every submission, queues no entry fill, and fills a flatten at the mark across the spread with the venue fee', async () => {
    const fee = vi.fn(() => 7);
    const dryRun = adapter(() => 50, fee);
    const broker: BrokerAdapter = dryRun;
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
    await expect(broker.submitFlatten('AAPL', 'sell', 3, 'f1')).rejects.toBeInstanceOf(
      DryRunRefusedError,
    );
    const fills = await broker.fetchNewFills(new Date(0));
    expect(
      fills.map((fill) => [fill.client_order_id, fill.leg, fill.qty, fill.price, fill.fee]),
    ).toEqual([['f1', 'exit', 3, 49.95, 7]]);
    expect(fee.mock.calls).toEqual([['saxo', 'sell', 3, 49.95]]);
    expect(fills[0]?.timestamp).toEqual(clock.now());
    expect(fills.map((fill) => fill.broker_fill_id)).toEqual(['dry-f1-exit']);
    expect(await broker.fetchNewFills(new Date(0))).toEqual([]);
    expect(await broker.getOpenPositions()).toEqual([]);
    expect(await broker.getOrder('o1', 'AAPL')).toBeNull();
    expect(await broker.resumeFlatten('f1', 'AAPL')).toBeNull();
    await broker.cancel('o1', 'AAPL');
    await broker.resizeProtectiveLegs('o1', 1);
    await broker.rearmProtectiveLegs('o1', 'AAPL', 'buy', 1, 0.5, 0);
  });

  it('buys a short flatten back above the mark and leaves it unfilled without a mark', async () => {
    let mark: number | undefined = 100;
    const dryRun = adapter(() => mark);
    await dryRun.submitFlatten('X', 'buy', 1, 'f2').catch(() => undefined);
    mark = undefined;
    await dryRun.submitFlatten('X', 'buy', 1, 'f3').catch(() => undefined);
    const fills = await dryRun.fetchNewFills(new Date(0));
    expect(fills.map((fill) => [fill.client_order_id, fill.leg, fill.price])).toEqual([
      ['f2', 'exit', 100.1],
    ]);
  });
});
