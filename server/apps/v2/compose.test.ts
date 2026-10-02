import { describe, expect, it, vi } from 'vitest';
import type {
  BookSpec,
  CfdCostModel,
  CfdCosts,
  MarketData,
  Sleeve,
  SleeveDecision,
  SleeveSpec,
} from '../../../contracts/index.js';
import { SimulatedClock } from '../../shared/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import { type CycleCompositionOptions, composeCycle } from './compose.js';
import type { AlpacaBrokerClient } from './execution/index.js';
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
    brokerMode: 'paper',
    halfSpreadBps: () => 5,
    ...overrides,
  };
}

function cfdCosts(fee: CfdCostModel['fee'], halfSpreadBps = 0): CfdCosts {
  return {
    fee: { fee },
    spread: { halfSpreadBps: () => halfSpreadBps },
    financing: { dailyRate: () => 0 },
    borrow: { dailyRate: () => 0 },
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

describe('composeCycle: per-sleeve loss budgets (David 2026-09-30, #1941)', () => {
  it('keeps each primary on its own budget: one halting leaves the other at its own step', () => {
    const { books } = composeCycle(options());
    expect(lose(books, 'debate/primary', 1_000, 'a')).toMatchObject({ halted: true });
    lose(books, 'trend/primary', 600, 'b');

    expect(books.lastDay('trend/primary')?.state).toMatchObject({
      halted: false,
      sizeMultiplier: 0.25,
    });
  });
});

describe('composeCycle: the cycle transaction seam (#1984)', () => {
  it('rolls back the books when the work inside it throws', () => {
    const { atomically, books } = composeCycle(options());
    const loseThenFail = () => {
      lose(books, 'debate/primary', 10, 'seam');
      throw new Error('disk full');
    };
    expect(() => atomically?.(loseThenFail)).toThrow('disk full');
    expect(books.lastDay('debate/primary')).toBeUndefined();
    expect(books.cash('debate/primary')).toBe(composeCycle(options()).books.cash('debate/primary'));
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

  it('refuses a CFD entry as cfd_resting_stop_unverified while that gate alone is unset', () => {
    const composed = composeCycle(options({ market: richMarket }));
    expect(request(composed)).toEqual({
      size: 0,
      order: undefined,
      refusal: 'cfd_resting_stop_unverified',
    });
  });

  it('refuses a CFD entry with whatever the injected CFD gate names, even with a model', () => {
    const composed = composeCycle(
      options({
        market: richMarket,
        cfdCosts: cfdCosts(() => 0),
        cfdEntryRefusal: () => 'cfd_resting_stop_unverified',
      }),
    );
    expect(request(composed)).toEqual({
      size: 0,
      order: undefined,
      refusal: 'cfd_resting_stop_unverified',
    });
  });

  it('approves the same entry once the gate passes, and prices CFD fills through the model', () => {
    const composed = composeCycle(
      options({
        market: richMarket,
        cfdCosts: cfdCosts((_venue, _side, qty, price) => qty * price * 0.001),
        cfdEntryRefusal: () => undefined,
      }),
    );
    expect(request(composed).order).toBeDefined();
    expect(composed.executor.quoteSimulatedFill('saxo_cfd_usd', fill('sell', 10, 100))).toEqual({
      price: 100,
      fee: 1,
    });
  });

  it('scales the injected CFD fee by costMultiple like every other modelled cost', () => {
    const composed = composeCycle(options({ cfdCosts: cfdCosts(() => 1), costMultiple: 2 }));
    expect(composed.executor.quoteSimulatedFill('saxo_cfd_gbp', fill('buy', 1, 1)).fee).toBe(2);
  });

  it('refuses to compose when CFD entries can open but no cost model would price their exits', () => {
    expect(() => composeCycle(options({ cfdEntryRefusal: () => undefined }))).toThrow(
      /stranded \(#1850\)/,
    );
    expect(() =>
      composeCycle(options({ cfdEntryRefusal: () => 'cfd_resting_stop_unverified' })),
    ).not.toThrow();
  });

  it('prices a crossing CFD fill off the CFD spread model and a cash fill off the cash spread', () => {
    const composed = composeCycle(
      options({
        market: richMarket,
        cfdCosts: cfdCosts(() => 0, 30),
        cfdEntryRefusal: () => undefined,
      }),
    );
    const crossing = { ...fill('buy', 1, 100), crossesSpread: true };
    const cash = composed.executor.quoteSimulatedFill('saxo', crossing).price;
    const cfd = composed.executor.quoteSimulatedFill('saxo_cfd_gbp', crossing).price;
    expect(cfd - cash).toBeCloseTo((100 * (30 - 5)) / 10_000, 9);
  });

  it('wires CFD financing and the catalogue borrow quote into the daily mark', () => {
    const composed = composeCycle(
      options({
        cfdCosts: {
          ...cfdCosts(() => 0),
          financing: { dailyRate: () => 0.001 },
          borrow: { dailyRate: (_venue, quoted) => quoted ?? 1 },
        },
        quotedCfdBorrowPerDay: (instrument) => (instrument === 'AAPL' ? 0.0002 : undefined),
      }),
    );
    composed.books.applyFill('debate/primary', {
      instrument: 'AAPL',
      venue: 'saxo_cfd_usd',
      side: 'sell',
      leg: 'entry',
      qty: 2,
      priceGbp: 50,
      feeGbp: 0,
      clientOrderId: 'short-1',
      tradingDate: '2026-09-25',
    });
    composed.books.markDay('debate/primary', '2026-09-25', () => 50, 2);
    const row = composed.books.lastDay('debate/primary');
    expect(row?.cfdFinancingAccrualGbp).toBeCloseTo(100 * 0.001 * 2, 12);
    expect(row?.cfdBorrowAccrualGbp).toBeCloseTo(100 * 0.0002 * 2, 12);
  });

  it('hands the borrow model no quote when no catalogue source is wired, so its fallback prices it', () => {
    const composed = composeCycle(
      options({
        cfdCosts: {
          ...cfdCosts(() => 0),
          borrow: { dailyRate: (_venue, quoted) => (quoted === undefined ? 0.003 : 1) },
        },
      }),
    );
    composed.books.applyFill('debate/primary', {
      instrument: 'AAPL',
      venue: 'saxo_cfd_usd',
      side: 'sell',
      leg: 'entry',
      qty: 1,
      priceGbp: 50,
      feeGbp: 0,
      clientOrderId: 'short-2',
      tradingDate: '2026-09-25',
    });
    const day = composed.books.markDay('debate/primary', '2026-09-25', () => 50, 1);
    expect(day.cfdFinancingAccrualGbp).toBe(0);
    expect(day.cfdBorrowAccrualGbp).toBeCloseTo(50 * 0.003, 12);
  });

  it('throws when a CFD fill is priced with no model rather than fee-free', () => {
    const composed = composeCycle(options());
    expect(() => composed.executor.quoteSimulatedFill('saxo_cfd_gbp', fill('buy', 1, 1))).toThrow(
      'needs #1850',
    );
  });
});

describe('composeCycle: broker reconcile wiring (#1872)', () => {
  it('reads the broker book from the same Alpaca client the executor trades through', async () => {
    const alpacaClient = {
      getPositions: vi.fn(async () => [{ symbol: 'AAPL', qty: '6', side: 'long' }]),
      listOpenOrders: vi.fn(async () => [
        {
          client_order_id: 'stop-1',
          symbol: 'AAPL',
          side: 'sell',
          type: 'stop',
          qty: '6',
          stop_price: '180.5',
        },
      ]),
      getAccount: vi.fn(async () => ({ cash: '127', equity: '127' })),
    } as unknown as AlpacaBrokerClient;
    const composed = composeCycle(options({ dryRun: false, alpacaClient }));

    expect(await composed.brokerBooks.read('alpaca')).toEqual({
      positions: [{ instrument: 'AAPL', qty: 6 }],
      openOrders: [
        { clientOrderId: 'stop-1', instrument: 'AAPL', protects: 'long', qty: 6, stopPrice: 180.5 },
      ],
      cashQuote: 127,
    });
    expect(composed.executor.simulates({ bookVariant: 'primary', venue: 'alpaca' })).toBe(false);
  });

  it('threads the broker mode into the Alpaca client it builds, so live never borrows the paper credentials', () => {
    vi.stubEnv('ALPACA_API_KEY', 'paper-key');
    vi.stubEnv('ALPACA_API_SECRET', 'paper-secret');
    vi.stubEnv('ALPACA_LIVE_API_KEY', '');
    vi.stubEnv('ALPACA_LIVE_API_SECRET', '');
    try {
      expect(() => composeCycle(options({ dryRun: false, brokerMode: 'paper' }))).not.toThrow();
      expect(() => composeCycle(options({ dryRun: false, brokerMode: 'live' }))).toThrow(
        'ALPACA_LIVE_API_KEY',
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('a dry run has no broker to read, and the cash tolerance stays unset until David rules', async () => {
    const composed = composeCycle(options());
    await expect(composed.brokerBooks.read('alpaca')).rejects.toThrow('every route is simulated');
    expect(composed.reconcileCashToleranceGbp).toBeUndefined();
    expect(composed.brokerMode).toBe('paper');
    expect(composeCycle(options({ brokerMode: 'live' })).brokerMode).toBe('live');
    expect(composeCycle(options({ reconcileCashToleranceGbp: 5 })).reconcileCashToleranceGbp).toBe(
      5,
    );
  });
});
