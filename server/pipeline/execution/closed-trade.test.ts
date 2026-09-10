import type { ExitFill, Fill, OpenPosition } from '../../shared/index.js';
import { toBrokerFillId } from '../../shared/index.js';
import { closedTrade, modelledCostCharged } from './closed-trade.js';

const BREAKDOWN = { spread_cost: 1, commission: 1, slippage: 0, market_impact: 0 };

function fill(overrides: Partial<Fill> & { leg: Fill['leg']; qty: number; price: number }): Fill {
  return {
    idempotency_key: 'lot',
    broker_fill_id: toBrokerFillId(`${overrides.leg}-${overrides.price}-${overrides.qty}`),
    fee: 0,
    timestamp: new Date(0),
    ...overrides,
  };
}

function exitFill(overrides: Partial<ExitFill> & { qty: number; price: number }): ExitFill {
  return { ...fill({ leg: 'exit', ...overrides }), leg: overrides.leg ?? 'exit' } as ExitFill;
}

const position: OpenPosition = {
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
  broker_order_ids: ['broker-1'],
  opened_at: new Date(1_000),
  decision_timestamp: new Date(1_000),
  conviction: 0.6,
  converged: true,
};

describe('closedTrade', () => {
  const entryFills = [fill({ leg: 'entry', qty: 10, price: 100, fee: 1 })];

  it('signs the gross against the lot direction and nets every fee', () => {
    const exits = [exitFill({ qty: 10, price: 110, fee: 2, timestamp: new Date(5_000) })];
    const long = closedTrade(position, {
      filledSize: 10,
      avgEntryPrice: 100,
      entryFills,
      exitFills: exits,
    });
    expect(long.realized_pnl_net).toBe(100 - 3);
    expect(long.fees_total).toBe(3);
    expect(long.closed_at).toEqual(new Date(5_000));
    expect(long.stop).toBe(95);

    const short = closedTrade(
      { ...position, side: 'sell' },
      { filledSize: 10, avgEntryPrice: 100, entryFills, exitFills: exits },
    );
    expect(short.realized_pnl_net).toBe(-100 - 3);
  });

  it('names the close by the journalled exit reason over the mechanical leg', () => {
    const lot = { filledSize: 10, avgEntryPrice: 100, entryFills };
    expect(
      closedTrade(position, {
        ...lot,
        exitFills: [exitFill({ qty: 10, price: 101, exit_reason: 'flatten' })],
      }).close_reason,
    ).toBe('flatten');
    expect(
      closedTrade(position, { ...lot, exitFills: [exitFill({ qty: 10, price: 101 })] })
        .close_reason,
    ).toBe('exit');
    expect(
      closedTrade(position, { ...lot, exitFills: [exitFill({ qty: 10, price: 90, leg: 'stop' })] })
        .close_reason,
    ).toBe('stop');
  });

  it('takes the closing fill as the last exit in order', () => {
    const exits = [
      exitFill({ qty: 4, price: 101, leg: 'target', timestamp: new Date(2_000) }),
      exitFill({ qty: 6, price: 99, leg: 'stop', timestamp: new Date(3_000) }),
    ];
    const trade = closedTrade(position, {
      filledSize: 10,
      avgEntryPrice: 100,
      entryFills,
      exitFills: exits,
    });
    expect(trade.close_reason).toBe('stop');
    expect(trade.closed_at).toEqual(new Date(3_000));
    expect(trade.realized_pnl_net).toBeCloseTo((99.8 - 100) * 10 - 1, 12);
  });
});

describe('modelledCostCharged', () => {
  const chargedEntry = [fill({ leg: 'entry', qty: 1, price: 1, cost_breakdown: BREAKDOWN })];

  it('requires a breakdown on every entry and flatten leg', () => {
    expect(
      modelledCostCharged(chargedEntry, [
        exitFill({ qty: 1, price: 1, cost_breakdown: BREAKDOWN }),
      ]),
    ).toBe(true);
    expect(modelledCostCharged(chargedEntry, [exitFill({ qty: 1, price: 1 })])).toBe(false);
    expect(
      modelledCostCharged(
        [fill({ leg: 'entry', qty: 1, price: 1 })],
        [exitFill({ qty: 1, price: 1, cost_breakdown: BREAKDOWN })],
      ),
    ).toBe(false);
  });

  it('does not veto on protective legs nothing models', () => {
    expect(modelledCostCharged(chargedEntry, [exitFill({ qty: 1, price: 1, leg: 'stop' })])).toBe(
      true,
    );
    expect(modelledCostCharged(chargedEntry, [exitFill({ qty: 1, price: 1, leg: 'target' })])).toBe(
      true,
    );
  });
});
