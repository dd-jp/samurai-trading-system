import { describe, expect, it } from 'vitest';
import type { BrokerAdapter } from '../../pipeline/execution/index.js';
import { SimulatedClock } from '../../shared/index.js';
import { DryRunBrokerAdapter, DryRunRefusedError, spreadAdjusted } from './dry-run-broker.js';

const clock = new SimulatedClock(new Date('2026-09-25T07:00:00.000Z'));

function adapter(markPrice: () => number | undefined = () => 50): DryRunBrokerAdapter {
  return new DryRunBrokerAdapter({ halfSpreadBps: () => 10, markPrice, clock });
}

describe('DryRunBrokerAdapter', () => {
  it('refuses every submission and simulates the fill at the price plus or minus half a spread', async () => {
    const dryRun = adapter();
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
    ).toEqual([
      ['o1', 'entry', 3, 100.1, 0],
      ['f1', 'exit', 3, 49.95, 0],
    ]);
    expect(fills[0]?.timestamp).toEqual(clock.now());
    expect(fills.map((fill) => fill.broker_fill_id)).toEqual(['dry-o1-entry', 'dry-f1-exit']);
    expect(await broker.fetchNewFills(new Date(0))).toEqual([]);
    expect(await broker.getOpenPositions()).toEqual([]);
    expect(await broker.getOrder('o1', 'AAPL')).toBeNull();
    expect(await broker.resumeFlatten('f1', 'AAPL')).toBeNull();
    await broker.cancel('o1', 'AAPL');
    await broker.resizeProtectiveLegs('o1', 1);
    await broker.rearmProtectiveLegs('o1', 'AAPL', 'buy', 1, 0.5, 0);
  });

  it('sells short entries below the price and leaves a flatten unfilled without a mark', async () => {
    const dryRun = adapter(() => undefined);
    await dryRun
      .submitBracket({
        client_order_id: 's1',
        instrument: 'X',
        asset_class: 'stocks',
        side: 'sell',
        size: 1,
        entry: 100,
        stop: 105,
        target: 90,
        time_in_force: 'gtc',
      })
      .catch(() => undefined);
    await dryRun.submitFlatten('X', 'buy', 1, 'f2').catch(() => undefined);
    const fills = await dryRun.fetchNewFills(new Date(0));
    expect(fills.map((fill) => [fill.client_order_id, fill.price])).toEqual([['s1', 99.9]]);
  });

  it('spreadAdjusted moves a buy up and a sell down by the half spread', () => {
    expect(spreadAdjusted(200, 'buy', 25)).toBeCloseTo(200.5, 9);
    expect(spreadAdjusted(200, 'sell', 25)).toBeCloseTo(199.5, 9);
    expect(spreadAdjusted(200, 'buy', 0)).toBe(200);
  });
});
