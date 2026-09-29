import { describe, expect, it } from 'vitest';
import type {
  BookSpec,
  MarketData,
  Sleeve,
  SleeveDecision,
  SleeveSpec,
} from '../../../contracts/index.js';
import { SimulatedClock } from '../../shared/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import { type CycleCompositionOptions, composeCycle } from './compose.js';
import { CapitalConfigStore } from './risk/index.js';

const clock = new SimulatedClock(new Date('2026-09-25T12:00:00.000Z'));
const flat = () => undefined;

const PRIMARY_SPEC: SleeveSpec = {
  capitalShare: 0.5,
  minimumCapitalGbp: 0,
  capacityGbp: Number.POSITIVE_INFINITY,
  validation: 'forward-paper',
  macroGate: true,
  sizing: {
    riskFraction: 0.005,
    stopAtrMultiple: 2,
    targetAtrMultiple: 3,
    timeStopTradingDays: 10,
    advShare: 0.01,
    advWindowBars: 20,
  },
  books: [{ variant: 'primary', instantiated: true }],
};

function primary(id: string): Sleeve {
  return {
    id,
    spec: PRIMARY_SPEC,
    universe: () => ({ instruments: [], refusals: [] }),
    decide: () => Promise.resolve({ decisions: [], refusals: [] }),
  };
}

const market: MarketData = {
  lastBarBefore: () => undefined,
  barsBefore: () => [],
  gbpUsdAtYearStart: () => 1.27,
};

function options(overrides: Partial<CycleCompositionOptions> = {}): CycleCompositionOptions {
  const db = openSharedStore(':memory:');
  new CapitalConfigStore(db, clock).setYear(2026, 1_500, 1_500);
  return {
    db,
    clock,
    logger: { log: () => undefined },
    market,
    sleeves: [primary('debate'), primary('trend')],
    openingDate: '2026-09-25',
    tradingDate: () => '2026-09-25',
    dryRun: true,
    halfSpreadBps: () => 5,
    ...overrides,
  };
}

const lose = (
  books: ReturnType<typeof composeCycle>['books'],
  bookId: string,
  loss: number,
  orderId: string,
) => {
  books.applyFill(bookId, {
    instrument: 'AAPL',
    venue: 'alpaca',
    side: 'buy',
    leg: 'entry',
    qty: 1,
    priceGbp: 100 + loss,
    feeGbp: 0,
    clientOrderId: orderId,
    tradingDate: '2026-09-25',
  });
  books.applyFill(bookId, {
    instrument: 'AAPL',
    venue: 'alpaca',
    side: 'sell',
    leg: 'exit',
    qty: 1,
    priceGbp: 100,
    feeGbp: 0,
    clientOrderId: orderId,
    tradingDate: '2026-09-25',
  });
  return books.markDay(bookId, '2026-09-25', flat, 1).state;
};

describe('composeCycle: loss-budget pooling opt-out (#1799, ruled 2026-09-28)', () => {
  it('pools primary books by default, matching paper/live (compose.ts leaves the flag unset)', () => {
    const { books } = composeCycle(options());
    lose(books, 'debate/primary', 1_000, 'a');
    lose(books, 'trend/primary', 600, 'b');

    books.settlePrimaryBudgets('2026-09-25');

    expect(books.lastDay('trend/primary')?.state).toMatchObject({
      halted: true,
      sizeMultiplier: 0,
    });
  });

  it('keeps each primary on its own isolated budget when pooledLossBudget is explicitly false (backtest)', () => {
    const { books } = composeCycle(options({ pooledLossBudget: false }));
    lose(books, 'debate/primary', 1_000, 'a');
    const trendState = lose(books, 'trend/primary', 600, 'b');
    expect(trendState).toMatchObject({ halted: false, sizeMultiplier: 0.25 });

    books.settlePrimaryBudgets('2026-09-25');

    expect(books.lastDay('trend/primary')?.state).toMatchObject({
      halted: false,
      sizeMultiplier: 0.25,
    });
  });
});

describe('composeCycle: costMultiple scales every modelled cost leg (doc 67 "2x modelled cost")', () => {
  const REQUEST = { instrument: 'AAPL', side: 'buy' as const, qty: 10, price: 100 };

  it('scales the spread+impact slippage linearly, so 2x doubles the price move off mid', () => {
    const base = composeCycle(options({ costMultiple: 1 })).executor.quoteSimulatedFill('alpaca', {
      ...REQUEST,
      crossesSpread: true,
    });
    const doubled = composeCycle(options({ costMultiple: 2 })).executor.quoteSimulatedFill(
      'alpaca',
      { ...REQUEST, crossesSpread: true },
    );

    expect(base.price).toBeGreaterThan(REQUEST.price);
    expect(doubled.price - REQUEST.price).toBeCloseTo(2 * (base.price - REQUEST.price), 10);
  });

  it('scales the modelled fee linearly, isolated from price by never crossing the spread', () => {
    const base = composeCycle(options({ costMultiple: 1 })).executor.quoteSimulatedFill('alpaca', {
      ...REQUEST,
      crossesSpread: false,
    });
    const doubled = composeCycle(options({ costMultiple: 2 })).executor.quoteSimulatedFill(
      'alpaca',
      { ...REQUEST, crossesSpread: false },
    );

    expect(base.price).toBe(REQUEST.price);
    expect(base.fee).toBeGreaterThan(0);
    expect(doubled.fee).toBeCloseTo(2 * base.fee, 10);
  });

  it('defaults to costMultiple 1 when the option is left unset', () => {
    const defaulted = composeCycle(options()).executor.quoteSimulatedFill('alpaca', {
      ...REQUEST,
      crossesSpread: true,
    });
    const explicit = composeCycle(options({ costMultiple: 1 })).executor.quoteSimulatedFill(
      'alpaca',
      { ...REQUEST, crossesSpread: true },
    );

    expect(defaulted).toEqual(explicit);
  });
});

describe('composeCycle: CFD cost model (#1849, #1850)', () => {
  const book: BookSpec = {
    id: 'debate/primary',
    sleeve: 'debate',
    variant: 'primary',
    instantiated: true,
  };
  const cfdShort: SleeveDecision = {
    sleeve_id: 'debate',
    instrument: 'AAPL',
    venue: 'saxo_cfd_usd',
    direction: 'bearish',
    confidence: 1,
    action: 'enter_short',
    reason: 'r',
    price: 20,
    atr: 0.4,
    stop_price: 20.8,
    inputs_hash: 'h',
    debate_id: 'd',
    payload: {},
  };
  const richMarket: MarketData = {
    ...market,
    barsBefore: (_instrument, _date, count) =>
      Array.from({ length: count }, (_, back) => {
        const date = new Date(Date.parse('2026-09-24') - back * 86_400_000)
          .toISOString()
          .slice(0, 10);
        return { date, open: 20, high: 20, low: 20, close: 20, volume: 1_000_000, rawClose: 20 };
      }).reverse(),
  };
  const request = (composed: ReturnType<typeof composeCycle>) =>
    composed.risk.approveEntry({
      book,
      decision: cfdShort,
      clientOrderId: 'c1',
      tradingDate: '2026-09-25',
      equityGbp: 1_000,
      macroDay: false,
    });
  const fill = (side: 'buy' | 'sell', qty: number, price: number) => ({
    instrument: 'AAPL',
    side,
    qty,
    price,
    crossesSpread: false,
  });

  it('refuses a CFD entry as cfd_cost_model_unset while no model is injected', () => {
    const composed = composeCycle(options({ market: richMarket }));
    expect(request(composed)).toEqual({
      size: 0,
      order: undefined,
      refusal: 'cfd_cost_model_unset',
    });
  });

  it('approves the same entry once a model is injected, and prices CFD fills through it', () => {
    const cfdCostModel = {
      fee: (_side: 'buy' | 'sell', qty: number, price: number) => qty * price * 0.001,
    };
    const composed = composeCycle(options({ market: richMarket, cfdCostModel }));
    expect(request(composed).order).toBeDefined();
    expect(composed.executor.quoteSimulatedFill('saxo_cfd_usd', fill('sell', 10, 100))).toEqual({
      price: 100,
      fee: 1,
    });
  });

  it('scales the injected CFD fee by costMultiple like every other modelled cost', () => {
    const composed = composeCycle(options({ cfdCostModel: { fee: () => 1 }, costMultiple: 2 }));
    expect(composed.executor.quoteSimulatedFill('saxo_cfd_gbp', fill('buy', 1, 1)).fee).toBe(2);
  });

  it('throws when a CFD fill is priced with no model rather than fee-free', () => {
    const composed = composeCycle(options());
    expect(() => composed.executor.quoteSimulatedFill('saxo_cfd_gbp', fill('buy', 1, 1))).toThrow(
      'needs #1850',
    );
  });
});
