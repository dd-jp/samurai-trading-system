import { describe, expect, it } from 'vitest';
import type { MarketData, Sleeve, SleeveSpec } from '../../../contracts/index.js';
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
