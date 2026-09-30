import { describe, expect, it, vi } from 'vitest';
import type {
  BookFill,
  BookLedger,
  BrokerBook,
  BrokerBookReader,
  BrokerMode,
  ControlAction,
  LossBudgetState,
  MarketData,
  Sleeve,
  SleeveDecision,
  SleeveSpec,
} from '../../../contracts/index.js';
import { CfdCostModelUnsetError } from '../../../contracts/index.js';
import type { DailyBar } from '../../pipeline/momentum/index.js';
import {
  type BrokerAck,
  type BrokerAdapter,
  type LogEntry,
  type NativeBracketRequest,
  type NormalizedFill,
  type NormalizedOrder,
  type ProtectedExitRequest,
  SimulatedClock,
  toBrokerFillId,
} from '../../shared/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import {
  budgetChanges,
  type CycleDeps,
  calendarDaysBetween,
  runCycle,
  runEntryPass,
  vetoApplied,
} from './cycle.js';
import { addDays, BarsMarketData, TABLE_VENUE_SESSIONS } from './data/index.js';
import { DryRunBrokerAdapter } from './execution/dry-run-broker.js';
import { V2OrderExecutor } from './execution/executor.js';
import type { FillPricing } from './execution/simulated-costs.js';
import { Journal } from './journal/index.js';
import { storeView } from './reconcile.js';
import { CapitalConfigStore, ControlStore, PaperBooks, V2RiskGate } from './risk/index.js';
import { CYCLE_LEVEL_PARAMETERS, isSet, SleeveRegistry } from './signal/index.js';

const UNSET_CYCLE_PARAMETERS = CYCLE_LEVEL_PARAMETERS.filter((parameter) => !isSet(parameter));

const clock = new SimulatedClock(new Date('2026-09-25T07:00:00.000Z'));
const FX = 1.25;
const HALF_SPREAD_BPS = 5;

const shortAapl: SleeveDecision = {
  sleeve_id: 'debate',
  instrument: 'AAPL',
  venue: 'saxo_cfd_usd',
  direction: 'bearish',
  confidence: 1,
  action: 'enter_short',
  reason: 'judge bearish',
  price: 20,
  atr: 0.4,
  stop_price: 20.8,
  inputs_hash: 'h',
  debate_id: 'd',
  payload: {},
};

const longAapl: SleeveDecision = {
  sleeve_id: 'debate',
  instrument: 'AAPL',
  venue: 'alpaca',
  direction: 'bullish',
  confidence: 1,
  action: 'enter_long',
  reason: 'judge bullish',
  price: 20,
  atr: 0.4,
  stop_price: 19.2,
  inputs_hash: 'h',
  debate_id: 'd',
  payload: {},
};

function bar(date: string, overrides: Partial<DailyBar> = {}): DailyBar {
  return {
    date,
    open: 20,
    high: 20.5,
    low: 19.5,
    close: 20,
    volume: 1_000_000,
    rawClose: 20,
    ...overrides,
  };
}

class FakeAlpaca implements BrokerAdapter {
  readonly brackets: NativeBracketRequest[] = [];
  readonly flattens: string[] = [];
  readonly cancelled: string[] = [];
  readonly pending: NormalizedFill[] = [];
  readonly sinceSeen: Date[] = [];
  flattenError: Error | undefined;
  cancelError: Error | undefined;

  submitBracket(order: NativeBracketRequest): Promise<BrokerAck> {
    this.brackets.push(order);
    return Promise.resolve({
      client_order_id: order.client_order_id,
      broker_order_ids: ['a1'],
      order_state: 'submitted',
    });
  }

  fill(clientOrderId: string, leg: NormalizedFill['leg'], qty: number, price: number): void {
    this.pending.push({
      client_order_id: clientOrderId,
      broker_fill_id: toBrokerFillId(`alp-${clientOrderId}-${leg}`),
      leg,
      price,
      qty,
      fee: 0.5,
      timestamp: clock.now(),
    });
  }

  cumulative(
    clientOrderId: string,
    leg: NormalizedFill['leg'],
    filledQty: number,
    averagePrice: number,
  ): void {
    this.pending.push({
      client_order_id: clientOrderId,
      broker_fill_id: toBrokerFillId(`alp-${clientOrderId}-${leg}`),
      leg,
      price: averagePrice,
      qty: filledQty,
      fee: 0,
      timestamp: clock.now(),
      qty_is_cumulative: true,
    });
  }

  getOrder(): Promise<null> {
    return Promise.resolve(null);
  }

  resumeFlatten(_clientOrderId?: string, _instrument?: string): Promise<NormalizedOrder | null> {
    return Promise.resolve(null);
  }

  fetchNewFills(since: Date): Promise<NormalizedFill[]> {
    this.sinceSeen.push(since);
    return Promise.resolve(this.pending.splice(0));
  }

  resizeProtectiveLegs(): Promise<void> {
    return Promise.resolve();
  }

  rearmProtectiveLegs(
    _clientOrderId?: string,
    _instrument?: string,
    _side?: 'buy' | 'sell',
    _qty?: number,
    _stop?: number,
    _target?: number,
  ): Promise<void> {
    return Promise.resolve();
  }

  submitFlatten(
    _instrument: string,
    _side: 'buy' | 'sell',
    _size: number,
    clientOrderId: string,
  ): Promise<BrokerAck> {
    if (this.flattenError !== undefined) return Promise.reject(this.flattenError);
    this.flattens.push(clientOrderId);
    return Promise.resolve({
      client_order_id: clientOrderId,
      broker_order_ids: ['f1'],
      order_state: 'submitted',
    });
  }

  cancel(clientOrderId: string): Promise<void> {
    if (this.cancelError !== undefined) return Promise.reject(this.cancelError);
    this.cancelled.push(clientOrderId);
    return Promise.resolve();
  }

  getOpenPositions(): Promise<[]> {
    return Promise.resolve([]);
  }
}

interface Harness extends CycleDeps {
  readonly sleeve: Sleeve;
  readonly simulatedBroker: BrokerAdapter;
  readonly barsByDate: Map<string, DailyBar>;
  readonly setDecisions: (next: readonly SleeveDecision[]) => void;
  readonly setControl: (action: ControlAction, reason?: string) => void;
}

const TEST_SPEC: SleeveSpec = {
  capitalShare: 1,
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
  books: [
    { variant: 'primary', instantiated: true },
    { variant: 'no-macro-gate', instantiated: true },
  ],
};

const SPREAD_ONLY: FillPricing = {
  halfSpreadBps: () => HALF_SPREAD_BPS,
  impactBps: () => 0,
  fee: () => 0,
};

const MIRROR_CASH_TOLERANCE_GBP = 0.01;

function primaryBooksMirror(
  registry: SleeveRegistry,
  books: PaperBooks,
  journal: Journal,
): BrokerBookReader {
  return {
    read: (venue) => {
      const primaries = registry
        .ids()
        .flatMap((sleeveId) => books.forSleeve(sleeveId))
        .filter((book) => book.variant === 'primary');
      const view = storeView({ books, journal }, venue, primaries);
      const stops = [...view.positions].map(([instrument, qty]) => ({
        clientOrderId: `stop-${instrument}`,
        instrument,
        protects: qty > 0 ? ('long' as const) : ('short' as const),
      }));
      return Promise.resolve({
        positions: [...view.positions].map(([instrument, qty]) => ({ instrument, qty })),
        openOrders: [...view.openOrders, ...stops],
        cashQuote: view.cashGbp * (venue === 'alpaca' ? FX : 1),
      });
    },
  };
}

function harness(
  decisions: readonly SleeveDecision[],
  dryRun: boolean,
  alpaca?: BrokerAdapter,
  capitalYears: readonly number[] = [2026],
  spec: SleeveSpec = TEST_SPEC,
  pricing: FillPricing = SPREAD_ONLY,
  lossCapGbp = 1_500,
  secondSleeve?: Sleeve,
): Harness {
  const db = openSharedStore(':memory:');
  const capital = new CapitalConfigStore(db, clock);
  for (const year of capitalYears) capital.setYear(year, 1_000, lossCapGbp);
  let controlKey = 0;
  const registry = new SleeveRegistry();
  let current = decisions;
  const sleeve: Sleeve = {
    id: 'debate',
    spec,
    universe: () => ({
      instruments: current.map((decision) => decision.instrument),
      refusals: [{ scope: 'universe', parameter: 'P', ticket: '#1', message: 'unset' }],
    }),
    decide: () => Promise.resolve({ decisions: current, refusals: [] }),
  };
  registry.register(sleeve);
  if (secondSleeve !== undefined) registry.register(secondSleeve);
  const barsByDate = new Map<string, DailyBar>();
  const barFor = (_instrument: string, tradingDate: string) => {
    const dated = barsByDate.get(tradingDate);
    if (dated !== undefined) return dated;
    const previous = new Date(Date.parse(tradingDate) - 86_400_000).toISOString().slice(0, 10);
    return bar(previous);
  };
  const market: MarketData = {
    lastBarBefore: barFor,
    barsBefore: (instrument, tradingDate, count) => {
      if (instrument === 'THIN') return [];
      const overrides = [...barsByDate.values()];
      return Array.from({ length: count }, (_, back) => {
        const date = addDays(tradingDate, back - count);
        return overrides.find((dated) => dated.date === date) ?? bar(date);
      });
    },
    gbpUsdAtYearStart: () => FX,
  };
  const books = new PaperBooks(
    db,
    clock,
    capital,
    '2026-09-01',
    secondSleeve === undefined ? [sleeve] : [sleeve, secondSleeve],
  );
  const simulatedBroker = new DryRunBrokerAdapter();
  const journal = new Journal(db, clock);
  return {
    registry,
    sleeve,
    barsByDate,
    setDecisions: (next) => {
      current = next;
    },
    setControl: (action, reason = 'test') => {
      controlKey += 1;
      db.prepare(
        'INSERT INTO v2_controls (action, reason, source, idempotency_key, set_at) VALUES (?, ?, ?, ?, ?)',
      ).run(action, reason, 'test', `k${controlKey}`, clock.now().toISOString());
    },
    controls: new ControlStore(db),
    books,
    journal,
    brokerBooks: primaryBooksMirror(registry, books, journal),
    brokerMode: 'paper',
    reconcileCashToleranceGbp: MIRROR_CASH_TOLERANCE_GBP,
    risk: new V2RiskGate({
      books,
      capital,
      market,
      spec: (sleeveId) => (sleeveId === sleeve.id ? spec : (secondSleeve?.spec ?? spec)),
      venueRefusal: () => undefined,
    }),
    executor: new V2OrderExecutor({
      brokers: alpaca === undefined ? {} : { alpaca },
      simulatedBrokers: {
        alpaca: simulatedBroker,
        saxo: simulatedBroker,
        saxo_cfd_gbp: simulatedBroker,
        saxo_cfd_usd: simulatedBroker,
      },
      pricing,
      dryRun,
    }),
    simulatedBroker,
    market,
    clock,
    dryRun,
  };
}

function orders(deps: CycleDeps, bookId: string) {
  const db = (
    deps.journal as unknown as {
      db: { prepare: (sql: string) => { all: (id: string) => unknown[] } };
    }
  ).db;
  return db
    .prepare(
      'SELECT client_order_id, leg, side, outcome, payload FROM v2_orders WHERE book_id = ? ORDER BY client_order_id',
    )
    .all(bookId) as {
    client_order_id: string;
    leg: string;
    side: string;
    outcome: string;
    payload: string;
  }[];
}

function sizeShares(deps: CycleDeps, bookId: string, tradingDate: string, instrument: string) {
  const db = (
    deps.journal as unknown as {
      db: { prepare: (sql: string) => { get: (...a: unknown[]) => unknown } };
    }
  ).db;
  const row = db
    .prepare(
      'SELECT size_shares FROM v2_decisions WHERE book_id = ? AND trading_date = ? AND instrument = ?',
    )
    .get(bookId, tradingDate, instrument) as { size_shares: number } | undefined;
  return row?.size_shares;
}

const ENTRY_COST_GBP = (6 * 20) / FX;

function exitFill(deps: CycleDeps, clientOrderId: string) {
  const db = (
    deps.journal as unknown as {
      db: { prepare: (sql: string) => { get: (id: string) => unknown } };
    }
  ).db;
  return db
    .prepare("SELECT side, qty, price_gbp FROM v2_fills WHERE client_order_id = ? AND leg = 'exit'")
    .get(clientOrderId);
}

function loseInBook(
  books: BookLedger,
  bookId: string,
  date: string,
  loss: number,
  orderId: string,
): void {
  const entry: BookFill = {
    instrument: 'ZZZ',
    venue: 'alpaca',
    side: 'buy',
    leg: 'entry',
    qty: 1,
    priceGbp: 100 + loss,
    feeGbp: 0,
    clientOrderId: orderId,
    tradingDate: date,
  };
  books.applyFill(bookId, entry);
  books.applyFill(bookId, { ...entry, side: 'sell', priceGbp: 100 });
}

async function openBooks(deps: Harness): Promise<void> {
  await runCycle(deps, '2026-09-24');
  deps.setDecisions([]);
  await runCycle(deps, '2026-09-25');
}

describe('runCycle', () => {
  it('dry run: sizes, reaches the dry-run broker, submits nothing, and fills from the next bar', async () => {
    const deps = harness([longAapl], true);
    const report = await runCycle(deps, '2026-09-25');
    expect(report).toMatchObject({
      dry_run: true,
      skipped: false,
      sleeves: ['debate'],
      decisions: 1,
      entries: 2,
      exits: 0,
      fills: 0,
      submitted_orders: 0,
      simulated_orders: 1,
      dry_run_refusals: 1,
      rejected_orders: 0,
      macro: { macroDay: false, covered: true },
    });
    expect(report.refusals).toEqual([
      ...UNSET_CYCLE_PARAMETERS.map(
        (parameter) => `${parameter.name} is not set: needs David (${parameter.ticket})`,
      ),
      'P: unset',
    ]);
    expect(sizeShares(deps, 'debate/primary', '2026-09-25', 'AAPL')).toBe(6);
    expect(orders(deps, 'debate/primary')).toMatchObject([
      { client_order_id: 'v2-debate-primary-2026-09-25-AAPL', outcome: 'refused_dry_run' },
    ]);
    expect(orders(deps, 'debate/no-macro-gate')).toMatchObject([
      { client_order_id: 'v2-debate-no-macro-gate-2026-09-25-AAPL', outcome: 'simulated' },
    ]);
    expect(JSON.parse(orders(deps, 'debate/primary')[0]?.payload ?? '{}')).toMatchObject({
      size: 6,
      price: 20,
      stop: 19.2,
      target: expect.closeTo(21.2, 9),
    });
    expect(deps.books.positions('debate/primary')).toEqual([]);
    deps.setDecisions([]);
    const filled = await runCycle(deps, '2026-09-28');
    expect(filled).toMatchObject({ entries: 0, fills: 2 });
    for (const bookId of ['debate/primary', 'debate/no-macro-gate']) {
      expect(deps.books.position(bookId, 'AAPL')).toMatchObject({
        qty: 6,
        avgPriceGbp: expect.closeTo(ENTRY_COST_GBP / 6, 9),
        stopGbp: expect.closeTo(19.2 / FX, 9),
        targetGbp: expect.closeTo(21.2 / FX, 9),
        openedDate: '2026-09-28',
        marksHeld: 1,
      });
      expect(deps.books.cash(bookId)).toBeCloseTo(1_000 - ENTRY_COST_GBP, 9);
    }
    expect(filled.books).toMatchObject([
      {
        book_id: 'debate/primary',
        positions: 1,
        equity_gbp: expect.closeTo(1_000, 9),
        size_multiplier: 1,
      },
      { book_id: 'debate/no-macro-gate', positions: 1 },
    ]);
  });

  it('paper mode: the primary reaches the real broker, shadows stay simulated, macro days halve the primary only', async () => {
    const alpaca = new FakeAlpaca();
    const deps = harness([longAapl], false, alpaca);
    const fomc = await runCycle(deps, '2026-09-16');
    expect(fomc.macro).toMatchObject({ macroDay: true, sources: ['fomc'] });
    expect(fomc).toMatchObject({
      entries: 2,
      submitted_orders: 1,
      simulated_orders: 1,
      dry_run_refusals: 0,
      fills: 0,
    });
    expect(alpaca.brackets).toEqual([
      {
        client_order_id: 'v2-debate-primary-2026-09-16-AAPL',
        instrument: 'AAPL',
        asset_class: 'stocks',
        side: 'buy',
        size: 3,
        entry: 20,
        stop: 19.2,
        target: expect.closeTo(21.2, 9),
        time_in_force: 'gtc',
      },
    ]);
    expect(sizeShares(deps, 'debate/primary', '2026-09-16', 'AAPL')).toBe(3);
    expect(sizeShares(deps, 'debate/no-macro-gate', '2026-09-16', 'AAPL')).toBe(6);
    expect(orders(deps, 'debate/primary')).toMatchObject([{ outcome: 'submitted', leg: 'entry' }]);
    expect(deps.books.position('debate/primary', 'AAPL')).toBeUndefined();
    expect(deps.books.position('debate/no-macro-gate', 'AAPL')).toBeUndefined();
    alpaca.fill('v2-debate-primary-2026-09-16-AAPL', 'entry', 3, 20.01);
    deps.setDecisions([]);
    const next = await runCycle(deps, '2026-09-17');
    expect(next.fills).toBe(2);
    expect(deps.books.position('debate/no-macro-gate', 'AAPL')?.qty).toBe(6);
    expect(deps.books.position('debate/primary', 'AAPL')).toMatchObject({
      qty: 3,
      avgPriceGbp: expect.closeTo(20.01 / FX, 9),
    });
    expect(deps.books.cash('debate/primary')).toBeCloseTo(1_000 - (3 * 20.01 + 0.5) / FX, 9);
    expect(alpaca.cancelled).toEqual([]);
  });

  it('paper mode: an entry that never fills is cancelled on the next cycle and journalled as such', async () => {
    const alpaca = new FakeAlpaca();
    const deps = harness([longAapl], false, alpaca);
    await runCycle(deps, '2026-09-24');
    deps.setDecisions([]);
    await runCycle(deps, '2026-09-25');
    expect(alpaca.cancelled).toEqual(['v2-debate-primary-2026-09-24-AAPL']);
    expect(deps.journal.orderFor('v2-debate-primary-2026-09-24-AAPL')).toMatchObject({
      outcome: 'cancelled',
      payload: { cancelled: '2026-09-25' },
    });
    await runCycle(deps, '2026-09-26');
    expect(alpaca.cancelled).toHaveLength(1);
  });

  it('simulated books exit at the stop less half a spread on the next daily bar and the loss reaches the book', async () => {
    const deps = harness([longAapl], true);
    await openBooks(deps);
    deps.barsByDate.set('2026-09-28', bar('2026-09-25', { low: 19.0, high: 20.2 }));
    const report = await runCycle(deps, '2026-09-28');
    expect(report).toMatchObject({ exits: 2, simulated_orders: 2, fills: 2, submitted_orders: 0 });
    expect(deps.books.positions('debate/primary')).toEqual([]);
    const exitPrice = (19.2 * (1 - HALF_SPREAD_BPS / 10_000)) / FX;
    expect(deps.books.cash('debate/primary')).toBeCloseTo(
      1_000 - ENTRY_COST_GBP + 6 * exitPrice,
      9,
    );
    expect(deps.journal.orderFor('v2-debate-primary-2026-09-28-AAPL-exit')).toMatchObject({
      leg: 'exit',
      side: 'sell',
      outcome: 'simulated',
      payload: { size: 6, detail: 'bracket_leg_on_daily_bar', price: expect.closeTo(19.2, 9) },
    });
    expect(report.books[0]?.equity_gbp).toBeCloseTo(1_000 - ENTRY_COST_GBP + 6 * exitPrice, 9);
    const again = await runCycle(deps, '2026-09-29');
    expect(again.exits).toBe(0);
  });

  it('simulated books exit at the target when the stop is not touched, shorts mirrored', async () => {
    const deps = harness([longAapl], true);
    await openBooks(deps);
    deps.barsByDate.set('2026-09-28', bar('2026-09-25', { low: 19.3, high: 21.3 }));
    const report = await runCycle(deps, '2026-09-28');
    expect(report.exits).toBe(2);
    expect(
      deps.journal.orderFor('v2-debate-primary-2026-09-28-AAPL-exit')?.payload.price,
    ).toBeCloseTo(21.2, 9);
    expect(deps.books.positions('debate/primary')).toEqual([]);
  });

  it('a simulated target fills at the target and a stop across the spread and impact, both paying the fee', async () => {
    const pricing: FillPricing = {
      halfSpreadBps: () => HALF_SPREAD_BPS,
      impactBps: () => 3,
      fee: () => 0.5,
    };
    for (const [override, fill] of [
      [{ low: 19.3, high: 21.3 }, 21.2],
      [{ low: 19.0, high: 20.2 }, 19.2 * (1 - (HALF_SPREAD_BPS + 3) / 10_000)],
    ] as const) {
      const deps = harness([longAapl], true, undefined, [2026], TEST_SPEC, pricing);
      await openBooks(deps);
      deps.barsByDate.set('2026-09-28', bar('2026-09-25', override));
      await runCycle(deps, '2026-09-28');
      expect(deps.books.cash('debate/primary')).toBeCloseTo(
        1_000 - ENTRY_COST_GBP + (6 * fill) / FX - (2 * 0.5) / FX,
        9,
      );
    }
  });

  it('a bar touching the stop or the target exactly exits at that level', async () => {
    for (const [override, price] of [
      [{ low: 19.2, high: 20.2 }, 19.2],
      [{ low: 19.3, high: 21.2 }, 21.2],
    ] as const) {
      const deps = harness([longAapl], true);
      await openBooks(deps);
      deps.barsByDate.set('2026-09-28', bar('2026-09-25', override));
      const report = await runCycle(deps, '2026-09-28');
      expect(report.exits).toBe(2);
      expect(
        deps.journal.orderFor('v2-debate-primary-2026-09-28-AAPL-exit')?.payload.price,
      ).toBeCloseTo(price, 9);
    }
  });

  it('checks the legs against the bar rescaled from adjusted to raw prices', async () => {
    for (const [override, exits] of [
      [{ close: 10, low: 9.8, high: 10.3 }, 0],
      [{ close: 10, low: 9.55, high: 10.3 }, 2],
      [{ close: 10, low: 9.8, high: 10.62 }, 2],
    ] as const) {
      const deps = harness([longAapl], true);
      await openBooks(deps);
      deps.barsByDate.set('2026-09-28', bar('2026-09-25', { ...override, rawClose: 20 }));
      const report = await runCycle(deps, '2026-09-28');
      expect(report.exits).toBe(exits);
    }
  });

  it('checks short legs against the rescaled bar too', async () => {
    const short: SleeveDecision = shortAapl;
    for (const [override, price] of [
      [{ open: 10, close: 10, low: 9.5, high: 10.3 }, undefined],
      [{ open: 10, close: 10, low: 9.5, high: 10.45 }, 20.8],
      [{ open: 10, close: 10, low: 9.35, high: 10.3 }, 18.8],
    ] as const) {
      const deps = harness([short], true);
      await openBooks(deps);
      deps.barsByDate.set('2026-09-28', bar('2026-09-25', { ...override, rawClose: 20 }));
      await runCycle(deps, '2026-09-28');
      const exit = deps.journal.orderFor('v2-debate-primary-2026-09-28-AAPL-exit');
      if (price === undefined) expect(exit).toBeUndefined();
      else expect(exit?.payload.price).toBeCloseTo(price, 9);
    }
  });

  it('a bar touching both legs exits at the stop, for longs and shorts', async () => {
    const short: SleeveDecision = shortAapl;
    for (const [decision, override, price] of [
      [longAapl, { low: 19.0, high: 21.5 }, 19.2],
      [short, { low: 18.5, high: 21.0 }, 20.8],
    ] as const) {
      const deps = harness([decision], true);
      await openBooks(deps);
      deps.barsByDate.set('2026-09-28', bar('2026-09-25', override));
      expect((await runCycle(deps, '2026-09-28')).exits).toBe(2);
      expect(
        deps.journal.orderFor('v2-debate-primary-2026-09-28-AAPL-exit')?.payload.price,
      ).toBeCloseTo(price, 9);
    }
  });

  it('fills a simulated stop-exit at the open when the bar gaps through the stop, for longs and shorts', async () => {
    const short: SleeveDecision = shortAapl;
    for (const [decision, override, price] of [
      [longAapl, { open: 18.5, low: 18.2, high: 18.9 }, 18.5],
      [short, { open: 21.5, low: 21.2, high: 21.9 }, 21.5],
    ] as const) {
      const deps = harness([decision], true);
      await openBooks(deps);
      deps.barsByDate.set('2026-09-28', bar('2026-09-25', override));
      await runCycle(deps, '2026-09-28');
      expect(
        deps.journal.orderFor('v2-debate-primary-2026-09-28-AAPL-exit')?.payload.price,
      ).toBeCloseTo(price, 9);
    }
  });

  it('never fills a simulated stop-exit outside the bar range when the open is defective, for longs and shorts', async () => {
    const short: SleeveDecision = shortAapl;
    for (const [decision, override, price] of [
      [longAapl, { open: 15, low: 19, high: 19.5 }, 19],
      [longAapl, { open: 25, low: 18, high: 18.5 }, 18.5],
      [short, { open: 25, low: 20.5, high: 21 }, 21],
      [short, { open: 15, low: 22, high: 23 }, 22],
    ] as const) {
      const deps = harness([decision], true);
      await openBooks(deps);
      deps.barsByDate.set('2026-09-28', bar('2026-09-25', override));
      await runCycle(deps, '2026-09-28');
      expect(
        deps.journal.orderFor('v2-debate-primary-2026-09-28-AAPL-exit')?.payload.price,
      ).toBeCloseTo(price, 9);
    }
  });

  it('short brackets: the stop fires on the high, the target on the low, and neither inside', async () => {
    const short: SleeveDecision = shortAapl;
    for (const [override, price] of [
      [{ low: 19.5, high: 20.8 }, 20.8],
      [{ low: 18.8, high: 20.5 }, 18.8],
      [{ low: 18.9, high: 20.7 }, undefined],
    ] as const) {
      const deps = harness([short], true);
      await openBooks(deps);
      deps.barsByDate.set('2026-09-28', bar('2026-09-25', override));
      const report = await runCycle(deps, '2026-09-28');
      const exit = deps.journal.orderFor('v2-debate-primary-2026-09-28-AAPL-exit');
      if (price === undefined) {
        expect(report.exits).toBe(0);
        expect(exit).toBeUndefined();
        expect(deps.books.position('debate/primary', 'AAPL')?.qty).toBe(-6);
      } else {
        expect(report.exits).toBe(2);
        expect(exit).toMatchObject({ side: 'buy' });
        expect(exit?.payload.price).toBeCloseTo(price, 9);
      }
    }
  });

  it('paper mode: a bracket stop-leg fill on the entry order closes the position in GBP', async () => {
    const alpaca = new FakeAlpaca();
    const deps = harness([longAapl], false, alpaca);
    await runCycle(deps, '2026-09-25');
    expect(alpaca.sinceSeen.every((since) => since.getTime() === 0)).toBe(true);
    alpaca.fill('v2-debate-primary-2026-09-25-AAPL', 'entry', 6, 20);
    deps.setDecisions([]);
    await runCycle(deps, '2026-09-28');
    expect(alpaca.sinceSeen.at(-1)).toEqual(
      new Date(deps.books.lastDay('debate/primary')?.recordedAt ?? ''),
    );
    expect(deps.books.position('debate/primary', 'AAPL')).toMatchObject({
      qty: 6,
      stopGbp: expect.closeTo(19.2 / FX, 9),
      targetGbp: expect.closeTo(21.2 / FX, 9),
    });
    alpaca.fill('v2-debate-primary-2026-09-25-AAPL', 'stop', 6, 19.2);
    const report = await runCycle(deps, '2026-09-29');
    expect(report.fills).toBe(1);
    expect(deps.books.positions('debate/primary')).toEqual([]);
    expect(deps.books.cash('debate/primary')).toBeCloseTo(
      1_000 - (6 * 20 + 0.5) / FX + (6 * 19.2 - 0.5) / FX,
      9,
    );
    const db = (
      deps.journal as unknown as { db: { prepare: (sql: string) => { all: () => unknown[] } } }
    ).db;
    expect(
      db
        .prepare(
          "SELECT leg, side, price_gbp, fee_gbp FROM v2_fills WHERE book_id = 'debate/primary' ORDER BY leg",
        )
        .all(),
    ).toEqual([
      { leg: 'entry', side: 'buy', price_gbp: 20 / FX, fee_gbp: 0.5 / FX },
      { leg: 'stop', side: 'sell', price_gbp: 19.2 / FX, fee_gbp: 0.5 / FX },
    ]);
  });

  it('#1778: one oversized fill that flips long straight to short is journaled loudly, unbracketed', async () => {
    const alpaca = new FakeAlpaca();
    const deps = harness([longAapl], false, alpaca);
    await runCycle(deps, '2026-09-25');
    alpaca.fill('v2-debate-primary-2026-09-25-AAPL', 'entry', 6, 20);
    deps.setDecisions([]);
    await runCycle(deps, '2026-09-28');
    expect(deps.books.position('debate/primary', 'AAPL')?.qty).toBe(6);
    // Never passes through flat: one fill both closes the long and opens a short
    alpaca.fill('v2-debate-primary-2026-09-25-AAPL', 'stop', 15, 18);
    const report = await runCycle(deps, '2026-09-29');
    expect(deps.books.position('debate/primary', 'AAPL')).toMatchObject({
      qty: -9,
      avgPriceGbp: expect.closeTo(18 / FX, 9),
      stopGbp: undefined,
      targetGbp: undefined,
    });
    expect(report.refusals).toContainEqual(
      'debate/primary AAPL: a stop fill on v2-debate-primary-2026-09-25-AAPL left qty -9 ' +
        'where qty 6 held; a fill must never flip or open a position outside a fresh entry ' +
        '(#1778)',
    );
  });

  it('#1778: a stray closing fill on an already-flat position opens unbracketed and is journaled loudly', async () => {
    const alpaca = new FakeAlpaca();
    const deps = harness([longAapl], false, alpaca);
    await runCycle(deps, '2026-09-25');
    alpaca.fill('v2-debate-primary-2026-09-25-AAPL', 'entry', 6, 20);
    deps.setDecisions([]);
    await runCycle(deps, '2026-09-28');
    alpaca.fill('v2-debate-primary-2026-09-25-AAPL', 'stop', 6, 19.2);
    await runCycle(deps, '2026-09-29');
    expect(deps.books.positions('debate/primary')).toEqual([]);
    // Broker-side OCO race: the sibling target leg reports a fill after the stop already closed it
    alpaca.fill('v2-debate-primary-2026-09-25-AAPL', 'target', 6, 21.2);
    const report = await runCycle(deps, '2026-09-30');
    expect(deps.books.position('debate/primary', 'AAPL')).toMatchObject({
      qty: -6,
      avgPriceGbp: expect.closeTo(21.2 / FX, 9),
      stopGbp: undefined,
      targetGbp: undefined,
    });
    expect(report.refusals).toContainEqual(
      'debate/primary AAPL: a target fill on v2-debate-primary-2026-09-25-AAPL left qty -6 ' +
        'where no position was held; a fill must never flip or open a position outside a ' +
        'fresh entry (#1778)',
    );
    const db = (
      deps.journal as unknown as {
        db: { prepare: (sql: string) => { all: () => unknown[] } };
      }
    ).db;
    expect(
      db
        .prepare("SELECT book_id, instrument FROM v2_refusals WHERE parameter = 'CROSSING_FILL'")
        .all(),
    ).toEqual([{ book_id: 'debate/primary', instrument: 'AAPL' }]);
  });

  it('#1778: a crossing fill logs error (critical alert), not just a silent refusal', async () => {
    const alpaca = new FakeAlpaca();
    const deps = harness([longAapl], false, alpaca);
    const log = vi.fn();
    await runCycle({ ...deps, logger: { log } }, '2026-09-25');
    alpaca.fill('v2-debate-primary-2026-09-25-AAPL', 'entry', 6, 20);
    deps.setDecisions([]);
    await runCycle({ ...deps, logger: { log } }, '2026-09-28');
    alpaca.fill('v2-debate-primary-2026-09-25-AAPL', 'stop', 15, 18);
    await runCycle({ ...deps, logger: { log } }, '2026-09-29');
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'error',
        event: 'v2_crossing_fill',
        message: expect.stringContaining('(#1778)'),
      }),
    );
  });

  it('#1778: a partial stop fill resizes the position and keeps its stop/target', async () => {
    const alpaca = new FakeAlpaca();
    const deps = harness([longAapl], false, alpaca);
    await runCycle(deps, '2026-09-25');
    alpaca.fill('v2-debate-primary-2026-09-25-AAPL', 'entry', 6, 20);
    deps.setDecisions([]);
    await runCycle(deps, '2026-09-28');
    alpaca.fill('v2-debate-primary-2026-09-25-AAPL', 'stop', 4, 19.2);
    const report = await runCycle(deps, '2026-09-29');
    expect(report.refusals.some((refusal) => refusal.includes('(#1778)'))).toBe(false);
    expect(deps.books.position('debate/primary', 'AAPL')).toMatchObject({
      qty: 2,
      stopGbp: expect.closeTo(19.2 / FX, 9),
      targetGbp: expect.closeTo(21.2 / FX, 9),
    });
  });

  it('#1778: a cancel that keeps failing blocks a same-day opposite entry on the same instrument', async () => {
    const alpaca = new FakeAlpaca();
    const deps = harness([longAapl], false, alpaca);
    await runCycle(deps, '2026-09-25');
    alpaca.cancelError = new Error('venue closed');
    const short: SleeveDecision = shortAapl;
    deps.setDecisions([short]);
    await runCycle(deps, '2026-09-28');
    expect(orders(deps, 'debate/primary').map((order) => order.client_order_id)).toEqual([
      'v2-debate-primary-2026-09-25-AAPL',
    ]);
  });

  it('dry run never sweeps the paper broker', async () => {
    const alpaca = new FakeAlpaca();
    const deps = harness([longAapl], true, alpaca);
    await runCycle(deps, '2026-09-25');
    expect(alpaca.sinceSeen).toEqual([]);
    expect(alpaca.brackets).toEqual([]);
  });

  it('a bar dated before the entry never triggers a simulated exit', async () => {
    const deps = harness([longAapl], true);
    await openBooks(deps);
    deps.barsByDate.set('2026-09-28', bar('2026-09-23', { low: 1, high: 100 }));
    const report = await runCycle(deps, '2026-09-28');
    expect(report.exits).toBe(0);
    expect(deps.books.position('debate/primary', 'AAPL')?.qty).toBe(6);
  });

  it('time-stops a position after ten marks and fills the flatten at the next open, across the spread', async () => {
    const deps = harness([longAapl], true);
    const flatten = vi.spyOn(deps.simulatedBroker, 'submitFlatten');
    await openBooks(deps);
    const dates = [
      '2026-09-28',
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
      '2026-10-08',
    ];
    for (const date of dates) {
      expect((await runCycle(deps, date)).exits).toBe(0);
    }
    expect(deps.books.position('debate/primary', 'AAPL')?.marksHeld).toBe(10);
    const report = await runCycle(deps, '2026-10-09');
    expect(report).toMatchObject({ exits: 2, dry_run_refusals: 1, simulated_orders: 1, fills: 0 });
    expect(flatten).toHaveBeenCalledWith(
      'AAPL',
      'sell',
      6,
      'v2-debate-primary-2026-10-09-AAPL-exit',
    );
    expect(deps.journal.orderFor('v2-debate-primary-2026-10-09-AAPL-exit')).toMatchObject({
      outcome: 'refused_dry_run',
      payload: { marks_held: 10 },
    });
    expect(deps.journal.orderFor('v2-debate-no-macro-gate-2026-10-09-AAPL-exit')?.outcome).toBe(
      'simulated',
    );
    expect(deps.books.position('debate/primary', 'AAPL')?.exitClientOrderId).toBe(
      'v2-debate-primary-2026-10-09-AAPL-exit',
    );
    deps.barsByDate.set('2026-10-12', bar('2026-10-09', { open: 19, low: 18.9, high: 19.4 }));
    const filled = await runCycle(deps, '2026-10-12');
    expect(filled).toMatchObject({ exits: 0, fills: 2 });
    expect(flatten).toHaveBeenCalledTimes(2);
    expect(deps.books.positions('debate/primary')).toEqual([]);
    expect(deps.books.positions('debate/no-macro-gate')).toEqual([]);
    expect(deps.books.cash('debate/primary')).toBeCloseTo(
      1_000 - ENTRY_COST_GBP + (6 * 19 * (1 - HALF_SPREAD_BPS / 10_000)) / FX,
      9,
    );
  });

  it('the time stop sends nothing for a position it cannot route', async () => {
    const alpaca = new FakeAlpaca();
    const deps = harness([longAapl], false, alpaca);
    await runCycle(deps, '2026-09-25');
    alpaca.fill('v2-debate-primary-2026-09-25-AAPL', 'entry', 6, 20);
    deps.setDecisions([]);
    for (const date of [
      '2026-09-28',
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
      '2026-10-08',
      '2026-10-09',
    ]) {
      await runCycle(deps, date);
    }
    vi.spyOn(deps.executor, 'canRoute').mockReturnValue(false);
    const report = await runCycle(deps, '2026-10-12');
    expect(report.exits).toBe(0);
    expect(alpaca.flattens).toEqual([]);
  });

  it('paper mode: the time stop leaves the exit pending until the broker fill arrives', async () => {
    const alpaca = new FakeAlpaca();
    const deps = harness([longAapl], false, alpaca);
    await runCycle(deps, '2026-09-25');
    alpaca.fill('v2-debate-primary-2026-09-25-AAPL', 'entry', 6, 20);
    deps.setDecisions([]);
    const dates = [
      '2026-09-28',
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
      '2026-10-08',
      '2026-10-09',
    ];
    for (const date of dates) await runCycle(deps, date);
    const resume = vi.spyOn(alpaca, 'resumeFlatten');
    const report = await runCycle(deps, '2026-10-12');
    expect(report).toMatchObject({ exits: 2, submitted_orders: 1, simulated_orders: 1 });
    expect(alpaca.flattens).toEqual(['v2-debate-primary-2026-10-12-AAPL-exit']);
    expect(deps.books.position('debate/primary', 'AAPL')?.exitClientOrderId).toBe(
      'v2-debate-primary-2026-10-12-AAPL-exit',
    );
    const held = await runCycle(deps, '2026-10-13');
    expect(held.exits).toBe(0);
    expect(alpaca.flattens).toHaveLength(1);
    expect(resume).toHaveBeenCalledWith('v2-debate-primary-2026-10-12-AAPL-exit', 'AAPL');
    alpaca.fill('v2-debate-primary-2026-10-12-AAPL-exit', 'exit', 6, 19);
    await runCycle(deps, '2026-10-14');
    expect(deps.books.positions('debate/primary')).toEqual([]);
  });

  it('paper mode: a rejected flatten leaves no exit pending and is retried next cycle', async () => {
    const alpaca = new FakeAlpaca();
    const deps = harness([longAapl], false, alpaca);
    await runCycle(deps, '2026-09-25');
    alpaca.fill('v2-debate-primary-2026-09-25-AAPL', 'entry', 6, 20);
    deps.setDecisions([]);
    for (const day of [28, 29, 30]) await runCycle(deps, `2026-09-${day}`);
    for (const day of [1, 2, 5, 6, 7, 8, 9]) {
      await runCycle(deps, `2026-10-${String(day).padStart(2, '0')}`);
    }
    alpaca.flattenError = new Error('venue closed');
    const rejected = await runCycle(deps, '2026-10-12');
    expect(rejected).toMatchObject({ exits: 2, rejected_orders: 1, submitted_orders: 0 });
    expect(deps.journal.orderFor('v2-debate-primary-2026-10-12-AAPL-exit')).toMatchObject({
      outcome: 'rejected',
      payload: { detail: expect.stringContaining('venue closed') },
    });
    expect(deps.books.position('debate/primary', 'AAPL')?.exitClientOrderId).toBeUndefined();
    alpaca.flattenError = undefined;
    const retried = await runCycle(deps, '2026-10-13');
    expect(retried).toMatchObject({ exits: 1, submitted_orders: 1 });
    expect(alpaca.flattens).toEqual(['v2-debate-primary-2026-10-13-AAPL-exit']);
  });

  it('paper mode: a retry of a crashed day never resubmits a rejected time-stop flatten', async () => {
    const alpaca = new FakeAlpaca();
    const deps = harness([longAapl], false, alpaca);
    await runCycle(deps, '2026-09-25');
    alpaca.fill('v2-debate-primary-2026-09-25-AAPL', 'entry', 6, 20);
    deps.setDecisions([]);
    for (const day of [28, 29, 30]) await runCycle(deps, `2026-09-${day}`);
    for (const day of [1, 2, 5, 6, 7, 8, 9]) {
      await runCycle(deps, `2026-10-${String(day).padStart(2, '0')}`);
    }
    alpaca.flattenError = new Error('venue closed');
    vi.spyOn(deps.books, 'markDay').mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    await expect(runCycle(deps, '2026-10-12')).rejects.toThrow(/disk full/);
    alpaca.flattenError = undefined;
    const flatten = vi.spyOn(alpaca, 'submitFlatten');
    const retry = await runCycle(deps, '2026-10-12');
    expect(retry).toMatchObject({ skipped: false, exits: 0, submitted_orders: 0 });
    expect(flatten).not.toHaveBeenCalled();
    expect(deps.journal.orderFor('v2-debate-primary-2026-10-12-AAPL-exit')?.outcome).toBe(
      'rejected',
    );
  });

  it('skips a vetoed entry in every book but the no-veto shadow', async () => {
    const deps = harness([{ ...longAapl, veto: 'judge blocks' }], true, undefined, [2026], {
      ...TEST_SPEC,
      books: [
        { variant: 'primary', instantiated: true },
        { variant: 'no-veto', instantiated: true },
      ],
    });
    const report = await runCycle(deps, '2026-09-25');
    expect(report).toMatchObject({ decisions: 1, entries: 1, simulated_orders: 1 });
    expect(sizeShares(deps, 'debate/primary', '2026-09-25', 'AAPL')).toBe(0);
    expect(orders(deps, 'debate/primary')).toEqual([]);
    expect(orders(deps, 'debate/no-veto')).toMatchObject([
      { client_order_id: 'v2-debate-no-veto-2026-09-25-AAPL', outcome: 'simulated' },
    ]);
    const primary = {
      id: 'debate/primary',
      sleeve: 'debate',
      variant: 'primary',
      instantiated: true,
    } as const;
    expect(vetoApplied(primary, { ...longAapl, veto: 'x' })).toMatchObject({
      action: 'skip',
      reason: 'vetoed: x',
    });
    expect(vetoApplied(primary, longAapl)).toBe(longAapl);
    const skipped = {
      ...longAapl,
      action: 'skip',
      reason: 'short_unavailable:no_catalogue',
      veto: 'x',
    } as const;
    expect(vetoApplied(primary, skipped)).toBe(skipped);
  });

  it('gives a sleeve below its minimum capital no books and never asks it for a universe or decisions', async () => {
    const deps = harness([longAapl], true, undefined, [2026], {
      ...TEST_SPEC,
      minimumCapitalGbp: 1_001,
    });
    const universe = vi.spyOn(deps.sleeve, 'universe');
    const decide = vi.spyOn(deps.sleeve, 'decide');
    const report = await runCycle(deps, '2026-09-25');
    expect(report).toMatchObject({ decisions: 0, entries: 0, books: [] });
    expect(report.refusals.at(-1)).toBe(
      "SLEEVE_MINIMUM_CAPITAL: sleeve debate gets £0 of its £1000 share of 2026's £1000 (minimum £1001, capacity £Infinity): no allocation (doc 66 D8)",
    );
    expect(universe).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
  });

  it('journals an entry refused for uncovered volume and submits nothing for it', async () => {
    const deps = harness([{ ...longAapl, instrument: 'THIN' }, longAapl], true);
    const report = await runCycle(deps, '2026-09-25');
    expect(report).toMatchObject({ decisions: 2, entries: 2, simulated_orders: 1 });
    expect(sizeShares(deps, 'debate/primary', '2026-09-25', 'THIN')).toBe(0);
    const db = (
      deps.journal as unknown as { db: { prepare: (s: string) => { all: () => unknown[] } } }
    ).db;
    expect(
      db
        .prepare(
          "SELECT parameter, message, book_id, instrument FROM v2_refusals WHERE scope = 'entry'",
        )
        .all(),
    ).toEqual([
      {
        parameter: 'ADV_WINDOW_COVERAGE',
        message: 'debate/primary THIN: no_adv',
        book_id: 'debate/primary',
        instrument: 'THIN',
      },
      {
        parameter: 'ADV_WINDOW_COVERAGE',
        message: 'debate/no-macro-gate THIN: no_adv',
        book_id: 'debate/no-macro-gate',
        instrument: 'THIN',
      },
    ]);
  });

  it('a rerun of a marked date skips with a journal line and never touches the sleeve', async () => {
    const deps = harness([longAapl], true);
    await runCycle(deps, '2026-09-25');
    const decide = vi.spyOn(deps.sleeve, 'decide');
    const rerun = await runCycle(deps, '2026-09-25');
    expect(rerun).toMatchObject({
      skipped: true,
      entries: 0,
      refusals: ['cycle 2026-09-25 already marked: skipped'],
      books: [],
    });
    expect((await runCycle(deps, '2026-09-24')).skipped).toBe(true);
    expect(decide).not.toHaveBeenCalled();
    const db = (
      deps.journal as unknown as { db: { prepare: (s: string) => { all: () => unknown[] } } }
    ).db;
    expect(
      db.prepare("SELECT parameter, message FROM v2_refusals WHERE scope = 'cycle'").all(),
    ).toEqual([
      { parameter: 'TRADING_DATE', message: 'cycle 2026-09-25 already marked: skipped' },
      { parameter: 'TRADING_DATE', message: 'cycle 2026-09-24 already marked: skipped' },
    ]);
    await expect(runCycle(deps, 'nope')).rejects.toThrow(/bad ISO date/);
  });

  it('a crash between submit and mark does not resubmit or lose the day on retry', async () => {
    const alpaca = new FakeAlpaca();
    const deps = harness([longAapl], false, alpaca);
    vi.spyOn(deps.books, 'markDay').mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    await expect(runCycle(deps, '2026-09-25')).rejects.toThrow(/disk full/);
    expect(alpaca.brackets).toHaveLength(1);
    expect(deps.books.isMarked('2026-09-25')).toBe(false);
    const retry = await runCycle(deps, '2026-09-25');
    expect(retry).toMatchObject({ skipped: false, entries: 0, submitted_orders: 0 });
    expect(alpaca.brackets).toHaveLength(1);
    expect(deps.books.isMarked('2026-09-25')).toBe(true);
    expect(orders(deps, 'debate/primary')).toHaveLength(1);
  });

  it('skips an entry while a position in the name is open', async () => {
    const deps = harness([longAapl], true);
    await runCycle(deps, '2026-09-25');
    const report = await runCycle(deps, '2026-09-28');
    expect(report.entries).toBe(0);
    expect(deps.books.position('debate/primary', 'AAPL')?.qty).toBe(6);
  });

  it('rejects a missing stop and a broker error; a saxo primary entry simulates (#1400: no live Saxo adapter)', async () => {
    const saxo: SleeveDecision = {
      ...longAapl,
      instrument: 'CSP1',
      venue: 'saxo',
      atr: 1,
      stop_price: 18,
    };
    const noStop: SleeveDecision = { ...longAapl, instrument: 'NOSTOP', stop_price: undefined };
    const noAtr: SleeveDecision = { ...longAapl, instrument: 'NOATR', atr: undefined };
    const rejecting = new FakeAlpaca();
    vi.spyOn(rejecting, 'submitBracket').mockRejectedValue(new Error('422 target required'));
    const deps = harness([saxo, noStop, noAtr, longAapl], false, rejecting);
    const report = await runCycle(deps, '2026-09-25');
    expect(report).toMatchObject({
      decisions: 4,
      entries: 6,
      rejected_orders: 3,
      simulated_orders: 3,
      submitted_orders: 0,
    });
    expect(sizeShares(deps, 'debate/primary', '2026-09-25', 'NOATR')).toBe(0);
    expect(sizeShares(deps, 'debate/primary', '2026-09-25', 'CSP1')).toBe(2);
    expect(
      orders(deps, 'debate/primary').map((o) => [
        o.client_order_id,
        o.outcome,
        JSON.parse(o.payload).detail,
      ]),
    ).toEqual([
      ['v2-debate-primary-2026-09-25-AAPL', 'rejected', expect.stringContaining('422')],
      [
        'v2-debate-primary-2026-09-25-CSP1',
        'simulated',
        expect.stringContaining('dry run refused'),
      ],
      ['v2-debate-primary-2026-09-25-NOSTOP', 'rejected', 'no_stop_price'],
    ]);
    expect(
      orders(deps, 'debate/primary').map((o) => [o.client_order_id, JSON.parse(o.payload).target]),
    ).toEqual([
      ['v2-debate-primary-2026-09-25-AAPL', expect.closeTo(21.2, 9)],
      ['v2-debate-primary-2026-09-25-CSP1', 23],
      ['v2-debate-primary-2026-09-25-NOSTOP', undefined],
    ]);
    deps.setDecisions([]);
    await runCycle(deps, '2026-09-28');
    expect(deps.books.position('debate/no-macro-gate', 'CSP1')?.venue).toBe('saxo');
  });

  it('sends shorts as sells with the target below, and skips zero-size names', async () => {
    const short: SleeveDecision = { ...shortAapl, instrument: 'SHRT' };
    const pricy: SleeveDecision = {
      ...longAapl,
      instrument: 'PRICY',
      price: 5_000,
      atr: 100,
      stop_price: 4_800,
    };
    const skipped: SleeveDecision = {
      ...longAapl,
      instrument: 'SKIP',
      action: 'skip',
      reason: 'x',
    };
    const deps = harness([short, pricy, skipped], true);
    const report = await runCycle(deps, '2026-09-25');
    expect(report).toMatchObject({ decisions: 3, entries: 2, dry_run_refusals: 1 });
    expect(sizeShares(deps, 'debate/primary', '2026-09-25', 'PRICY')).toBe(0);
    expect(sizeShares(deps, 'debate/primary', '2026-09-25', 'SKIP')).toBe(0);
    expect(orders(deps, 'debate/primary')).toMatchObject([
      { client_order_id: 'v2-debate-primary-2026-09-25-SHRT', side: 'sell' },
    ]);
    expect(JSON.parse(orders(deps, 'debate/primary')[0]?.payload ?? '{}').target).toBeCloseTo(
      18.8,
      9,
    );
    deps.setDecisions([]);
    await runCycle(deps, '2026-09-28');
    expect(deps.books.position('debate/primary', 'SHRT')).toMatchObject({ qty: -6 });
  });

  it('journals an uncovered macro calendar, logs the report, and warns on unmatched fills and sweep failures', async () => {
    const alpaca = new FakeAlpaca();
    alpaca.fill('unknown-order', 'entry', 1, 1);
    const deps = harness([], false, alpaca);
    const log = vi.fn();
    const report = await runCycle({ ...deps, logger: { log } }, '2026-12-02');
    expect(report.macro).toMatchObject({ macroDay: true, covered: false });
    expect(report.refusals.some((refusal) => refusal.includes('fail-closed'))).toBe(true);
    expect(log).toHaveBeenCalledWith({
      trace_id: 'v2-2026-12-02',
      stage: 'v2',
      level: 'info',
      event: 'v2_cycle_complete',
      message: 'v2 cycle 2026-12-02: 0 decisions, 0 submitted',
      payload: report,
    });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'v2_fill_unmatched',
        level: 'warn',
        message: 'fill alp-unknown-order-entry matches no v2 order',
      }),
    );
    const db = (
      deps.journal as unknown as { db: { prepare: (s: string) => { all: () => unknown[] } } }
    ).db;
    expect(db.prepare('SELECT scope, parameter FROM v2_refusals ORDER BY rowid').all()).toEqual([
      ...UNSET_CYCLE_PARAMETERS.map((parameter) => ({
        scope: 'parameter',
        parameter: parameter.name,
      })),
      { scope: 'macro', parameter: 'MACRO_CALENDARS' },
      { scope: 'universe', parameter: 'P' },
    ]);
    vi.spyOn(alpaca, 'fetchNewFills').mockRejectedValue(new Error('alpaca down'));
    await runCycle({ ...deps, logger: { log } }, '2026-12-03');
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: 'v2_fill_sweep_failed' }));
  });

  it('journals a missing or stale calendar reference as a data refusal (#1791)', async () => {
    const deps = harness([], true);
    const market: MarketData = {
      ...deps.market,
      lastBarBefore: (instrument, tradingDate) =>
        instrument === 'SPY'
          ? bar('2026-09-19')
          : deps.market.lastBarBefore(instrument, tradingDate),
    };
    const fresh = await runCycle({ ...deps, market }, '2026-09-24');
    expect(fresh.refusals.some((refusal) => refusal.startsWith('SPY'))).toBe(false);
    const stale = await runCycle({ ...deps, market }, '2026-09-25');
    expect(stale.refusals).toContain(
      'SPY has no bar in the 5 days before 2026-09-25: every windowed read fails closed (postmortem §2)',
    );
    const db = (
      deps.journal as unknown as { db: { prepare: (s: string) => { all: () => unknown[] } } }
    ).db;
    expect(
      db.prepare("SELECT parameter, ticket FROM v2_refusals WHERE scope = 'data'").all(),
    ).toEqual([{ parameter: 'CALENDAR_REFERENCE', ticket: '#1791' }]);
  });

  it('journals each position marked from a stale bar or its entry price (#1804)', async () => {
    const deps = harness([longAapl], true);
    await runCycle(deps, '2026-09-25');
    await runCycle(deps, '2026-09-28');
    deps.setDecisions([]);
    expect(deps.books.position('debate/primary', 'AAPL')).toBeDefined();
    const withAapl = (aapl: DailyBar | undefined): MarketData => ({
      ...deps.market,
      lastBarBefore: (instrument, tradingDate) =>
        instrument === 'AAPL' ? aapl : deps.market.lastBarBefore(instrument, tradingDate),
    });
    const fresh = await runCycle({ ...deps, market: withAapl(bar('2026-09-24')) }, '2026-09-29');
    expect(fresh.refusals.filter((refusal) => refusal.includes('marked at'))).toEqual([]);
    const stale = await runCycle({ ...deps, market: withAapl(bar('2026-09-24')) }, '2026-09-30');
    expect(stale.refusals).toContain(
      'debate/primary AAPL: marked at the 2026-09-24 close, no bar in the 5 days before 2026-09-30',
    );
    const missing = await runCycle({ ...deps, market: withAapl(undefined) }, '2026-10-01');
    expect(missing.refusals).toContain(
      'debate/no-macro-gate AAPL: marked at the entry price, no bar in the 5 days before 2026-10-01',
    );
    const db = (
      deps.journal as unknown as { db: { prepare: (s: string) => { all: () => unknown[] } } }
    ).db;
    expect(
      db
        .prepare(
          "SELECT trading_date, scope, ticket, COUNT(*) AS n FROM v2_refusals WHERE parameter = 'MARK_FRESHNESS' GROUP BY trading_date",
        )
        .all(),
    ).toEqual([
      { trading_date: '2026-09-30', scope: 'data', ticket: '#1804', n: 2 },
      { trading_date: '2026-10-01', scope: 'data', ticket: '#1804', n: 2 },
    ]);
    expect(
      db
        .prepare(
          "SELECT book_id, instrument FROM v2_refusals WHERE parameter = 'MARK_FRESHNESS' AND trading_date = '2026-09-30' ORDER BY book_id",
        )
        .all(),
    ).toEqual([
      { book_id: 'debate/no-macro-gate', instrument: 'AAPL' },
      { book_id: 'debate/primary', instrument: 'AAPL' },
    ]);
  });

  it('blocks entries after a daily-cap breach, cancels the entries resting at that mark, and sizes by the previous mark multiplier', async () => {
    const deps = harness([longAapl], true);
    await runCycle(deps, '2026-09-25');
    deps.barsByDate.set(
      '2026-09-28',
      bar('2026-09-25', { low: 19.3, high: 20, close: 17, rawClose: 17 }),
    );
    deps.setDecisions([longAapl, { ...longAapl, instrument: 'MSFT' }]);
    const drop = await runCycle(deps, '2026-09-28');
    expect(drop.books[0]?.size_multiplier).toBe(0);
    expect(drop.entries).toBe(2);
    expect(deps.journal.orderFor('v2-debate-primary-2026-09-28-MSFT')?.outcome).toBe('cancelled');
    expect(drop.refusals).toContain(
      'debate/primary: daily loss cap at the 2026-09-28 mark cancelled resting entries: 1',
    );
    deps.setDecisions([{ ...longAapl, instrument: 'MSFT' }]);
    const blocked = await runCycle(deps, '2026-09-29');
    expect(blocked.entries).toBe(0);
    expect(sizeShares(deps, 'debate/primary', '2026-09-29', 'MSFT')).toBe(0);
    expect(blocked.books[0]?.size_multiplier).toBe(1);
    const resumed = await runCycle(deps, '2026-09-30');
    expect(resumed.entries).toBe(2);
  });

  it('runs no paper debate while no capital config is in force', async () => {
    const report = await runCycle(harness([longAapl], false, undefined, []), '2026-09-25');
    expect(report).toMatchObject({ decisions: 0, entries: 0, submitted_orders: 0 });
    expect(report.refusals).toContainEqual(
      expect.stringContaining('no capital config in force on 2026-09-25'),
    );
    expect(report.refusals).not.toContain('P: unset');
  });

  it('refuses entries in a year with no capital config yet still time-stops the open position', async () => {
    const deps = harness([longAapl], true);
    await runCycle(deps, '2026-12-11');
    deps.setDecisions([{ ...longAapl, instrument: 'MSFT' }]);
    for (const date of [
      '2026-12-14',
      '2026-12-15',
      '2026-12-16',
      '2026-12-17',
      '2026-12-18',
      '2026-12-21',
      '2026-12-22',
      '2026-12-23',
      '2026-12-24',
    ]) {
      await runCycle(deps, date);
    }
    deps.setDecisions([{ ...longAapl, instrument: 'NVDA' }]);
    const newYear = await runCycle(deps, '2027-01-04');
    expect(newYear).toMatchObject({ entries: 0, decisions: 1 });
    expect(newYear.refusals.some((refusal) => refusal.includes('no capital config'))).toBe(true);
    expect(sizeShares(deps, 'debate/primary', '2027-01-04', 'NVDA')).toBe(0);
    expect(deps.books.position('debate/primary', 'AAPL')?.marksHeld).toBe(10);
    const timeStop = await runCycle(deps, '2027-01-05');
    expect(timeStop).toMatchObject({ entries: 0, exits: 2 });
    expect(deps.journal.orderFor('v2-debate-primary-2027-01-05-AAPL-exit')).toMatchObject({
      outcome: 'refused_dry_run',
      payload: { approval: 'exit:v2-debate-primary-2027-01-05-AAPL-exit:3' },
    });
    await runCycle(deps, '2027-01-06');
    expect(deps.books.position('debate/no-macro-gate', 'AAPL')).toBeUndefined();
  });

  it('cancels a simulated entry whose limit no bar reached, as the paper order is cancelled', async () => {
    const deps = harness([longAapl], true);
    await runCycle(deps, '2026-09-24');
    deps.setDecisions([]);
    deps.barsByDate.set('before the order', bar('2026-09-23', { open: 19, low: 18 }));
    deps.barsByDate.set('2026-09-25', bar('2026-09-24', { open: 20.3, low: 20.01, high: 20.6 }));
    const report = await runCycle(deps, '2026-09-25');
    expect(report.fills).toBe(0);
    expect(deps.books.positions('debate/primary')).toEqual([]);
    expect(deps.journal.orderFor('v2-debate-primary-2026-09-24-AAPL')).toMatchObject({
      outcome: 'cancelled',
      payload: { cancelled: '2026-09-25' },
    });
    expect(deps.journal.orderFor('v2-debate-no-macro-gate-2026-09-24-AAPL')?.outcome).toBe(
      'cancelled',
    );
    expect((await runCycle(deps, '2026-09-28')).fills).toBe(0);
  });

  it('fills a simulated entry at the open across the spread when the bar gaps through the limit', async () => {
    const deps = harness([longAapl], true);
    await runCycle(deps, '2026-09-25');
    deps.setDecisions([]);
    deps.barsByDate.set('2026-09-28', bar('2026-09-25', { open: 19.6, low: 19.4, high: 20.1 }));
    await runCycle(deps, '2026-09-28');
    expect(deps.books.position('debate/primary', 'AAPL')?.avgPriceGbp).toBeCloseTo(
      (19.6 * (1 + HALF_SPREAD_BPS / 10_000)) / FX,
      9,
    );
  });

  it('never fills a simulated buy above its limit, even when the open inside it crosses the spread', async () => {
    const pricing: FillPricing = { halfSpreadBps: () => 50, impactBps: () => 0, fee: () => 0 };
    const deps = harness([longAapl], true, undefined, [2026], TEST_SPEC, pricing);
    await runCycle(deps, '2026-09-24');
    deps.setDecisions([]);
    deps.barsByDate.set('2026-09-25', bar('2026-09-24', { open: 19.99, low: 19.9 }));
    await runCycle(deps, '2026-09-25');
    expect(deps.books.position('debate/primary', 'AAPL')?.avgPriceGbp).toBeCloseTo(20 / FX, 9);
    const short: SleeveDecision = shortAapl;
    const shorts = harness([short], true, undefined, [2026], TEST_SPEC, pricing);
    await runCycle(shorts, '2026-09-24');
    shorts.setDecisions([]);
    shorts.barsByDate.set('2026-09-25', bar('2026-09-24', { open: 20.01, high: 20.1 }));
    await runCycle(shorts, '2026-09-25');
    expect(shorts.books.position('debate/primary', 'AAPL')?.avgPriceGbp).toBeCloseTo(20 / FX, 9);
  });

  it('under a halt, a simulated entry filled this cycle gets its flatten in the same cycle', async () => {
    const deps = harness([longAapl], true);
    await runCycle(deps, '2026-09-24');
    deps.setControl('halt');
    const report = await runCycle(deps, '2026-09-25');
    expect(report).toMatchObject({ entries: 0, exits: 2 });
    expect(deps.books.position('debate/primary', 'AAPL')?.exitClientOrderId).toBe(
      'v2-debate-primary-2026-09-25-AAPL-exit',
    );
    await runCycle(deps, '2026-09-28');
    expect(deps.books.positions('debate/primary')).toEqual([]);
    expect(deps.journal.orderFor('v2-debate-primary-2026-09-25-AAPL-exit')?.payload.reason).toBe(
      'manual_halt',
    );
  });

  it('keeps a simulated entry pending while no bar has come in, refusing a second entry meanwhile', async () => {
    const deps = harness([longAapl], true);
    await runCycle(deps, '2026-09-25');
    const real = deps.market.barsBefore;
    const noBarsYet = vi
      .spyOn(deps.market, 'barsBefore')
      .mockImplementation((instrument, date, count) =>
        count < 10 ? [] : real(instrument, date, count),
      );
    const waiting = await runCycle(deps, '2026-09-28');
    expect(waiting).toMatchObject({ decisions: 1, entries: 0, fills: 0 });
    expect(deps.journal.orderFor('v2-debate-primary-2026-09-25-AAPL')?.outcome).toBe(
      'refused_dry_run',
    );
    expect(deps.journal.orderFor('v2-debate-primary-2026-09-28-AAPL')).toBeUndefined();
    await runCycle(deps, '2026-09-30');
    expect(deps.journal.orderFor('v2-debate-primary-2026-09-25-AAPL')?.outcome).toBe(
      'refused_dry_run',
    );
    const expired = await runCycle(deps, '2026-10-01');
    expect(deps.journal.orderFor('v2-debate-primary-2026-09-25-AAPL')).toMatchObject({
      outcome: 'cancelled',
      payload: { cancelled: '2026-10-01' },
    });
    expect(expired.entries).toBe(2);
    noBarsYet.mockRestore();
  });

  it('a stop the fill bar also reaches exits the simulated entry the same bar, for longs and shorts', async () => {
    const short: SleeveDecision = shortAapl;
    for (const [decision, override, price, side] of [
      [longAapl, { low: 19.0, high: 21.5 }, 19.2, 'sell'],
      [longAapl, { open: 19.1, low: 18.9, high: 19.5 }, 19.1, 'sell'],
      [short, { low: 18.5, high: 21.0 }, 20.8, 'buy'],
      [short, { open: 20.9, low: 20.7, high: 21.1 }, 20.9, 'buy'],
    ] as const) {
      const deps = harness([decision], true);
      await runCycle(deps, '2026-09-25');
      deps.setDecisions([]);
      deps.barsByDate.set('2026-09-28', bar('2026-09-25', override));
      const report = await runCycle(deps, '2026-09-28');
      expect(report).toMatchObject({ fills: 4, exits: 2 });
      expect(deps.books.positions('debate/primary')).toEqual([]);
      expect(deps.journal.orderFor('v2-debate-primary-2026-09-28-AAPL-exit')).toMatchObject({
        side,
        outcome: 'simulated',
        payload: { detail: 'stop_on_entry_bar', price: expect.closeTo(price, 9) },
      });
    }
    const deps = harness([longAapl], true);
    await runCycle(deps, '2026-09-25');
    deps.setDecisions([]);
    deps.barsByDate.set('2026-09-28', bar('2026-09-25', { low: 19.0, high: 20.2 }));
    await runCycle(deps, '2026-09-28');
    expect(deps.books.cash('debate/primary')).toBeCloseTo(
      1_000 - ENTRY_COST_GBP + (6 * 19.2 * (1 - HALF_SPREAD_BPS / 10_000)) / FX,
      9,
    );
    const db = (
      deps.journal as unknown as { db: { prepare: (sql: string) => { all: () => unknown[] } } }
    ).db;
    expect(
      db
        .prepare("SELECT leg, side FROM v2_fills WHERE book_id = 'debate/primary' ORDER BY leg")
        .all(),
    ).toEqual([
      { leg: 'entry', side: 'buy' },
      { leg: 'exit', side: 'sell' },
    ]);
  });

  it('counts calendar days between marks and never negatively', () => {
    expect(calendarDaysBetween(undefined, '2026-09-25')).toBe(0);
    expect(calendarDaysBetween('2026-09-22', '2026-09-25')).toBe(3);
    expect(calendarDaysBetween('2026-09-25', '2026-09-28')).toBe(3);
    expect(calendarDaysBetween('2026-10-23', '2026-10-26')).toBe(3);
    expect(calendarDaysBetween('2026-09-25', '2026-09-25')).toBe(0);
    expect(calendarDaysBetween('2026-09-26', '2026-09-25')).toBe(0);
  });
});

describe('runCycle under a manual control', () => {
  const TEN_MARKS = [
    '2026-09-28',
    '2026-09-29',
    '2026-09-30',
    '2026-10-01',
    '2026-10-02',
    '2026-10-05',
    '2026-10-06',
    '2026-10-07',
    '2026-10-08',
  ];

  function refusalRows(deps: CycleDeps, tradingDate: string) {
    const db = (
      deps.journal as unknown as {
        db: { prepare: (sql: string) => { all: (date: string) => unknown[] } };
      }
    ).db;
    return db
      .prepare(
        "SELECT parameter, message FROM v2_refusals WHERE trading_date = ? AND scope = 'control'",
      )
      .all(tradingDate) as { parameter: string; message: string }[];
  }

  it('pause asks no sleeve to decide, enters nothing in any book, and journals why', async () => {
    const deps = harness([longAapl], true);
    const decide = vi.spyOn(deps.sleeve, 'decide');
    deps.setControl('pause', 'checking fills');
    const report = await runCycle(deps, '2026-09-25');
    expect(decide).not.toHaveBeenCalled();
    expect(report).toMatchObject({ decisions: 0, entries: 0, exits: 0 });
    expect(deps.books.positions('debate/primary')).toEqual([]);
    expect(deps.books.positions('debate/no-macro-gate')).toEqual([]);
    const [row] = refusalRows(deps, '2026-09-25');
    expect(row?.parameter).toBe('MANUAL_CONTROL');
    expect(row?.message).toMatch(
      /^manual pause since .* \(checking fills\): no sleeve decides; exits and resting stops run$/,
    );
    expect(report.refusals).toContain(row?.message);
  });

  it('pause keeps exits running: a stop touched while paused still closes every book', async () => {
    const deps = harness([longAapl], true);
    await runCycle(deps, '2026-09-25');
    deps.setControl('pause');
    deps.barsByDate.set('2026-09-28', bar('2026-09-25', { low: 19.0, high: 20.2 }));
    const report = await runCycle(deps, '2026-09-28');
    expect(report).toMatchObject({ exits: 2, decisions: 0 });
    expect(deps.books.positions('debate/primary')).toEqual([]);
    expect(deps.books.positions('debate/no-macro-gate')).toEqual([]);
  });

  it('pause keeps the time stop running', async () => {
    const deps = harness([longAapl], true);
    await openBooks(deps);
    for (const date of TEN_MARKS) await runCycle(deps, date);
    deps.setControl('pause');
    const report = await runCycle(deps, '2026-10-09');
    expect(report.exits).toBe(2);
    expect(deps.journal.orderFor('v2-debate-primary-2026-10-09-AAPL-exit')).toMatchObject({
      payload: { reason: 'time_stop' },
    });
    expect((await runCycle(deps, '2026-10-12')).fills).toBe(2);
    expect(deps.books.positions('debate/primary')).toEqual([]);
  });

  it('halt exits every position in every book at the next cycle and journals the reason', async () => {
    const deps = harness([longAapl], true);
    await runCycle(deps, '2026-09-25');
    const decide = vi.spyOn(deps.sleeve, 'decide');
    deps.setControl('halt', 'going away');
    const report = await runCycle(deps, '2026-09-28');
    expect(decide).not.toHaveBeenCalled();
    expect(report).toMatchObject({
      exits: 2,
      entries: 0,
      dry_run_refusals: 1,
      simulated_orders: 1,
    });
    expect(deps.journal.orderFor('v2-debate-primary-2026-09-28-AAPL-exit')).toMatchObject({
      leg: 'exit',
      side: 'sell',
      outcome: 'refused_dry_run',
      payload: { reason: 'manual_halt', size: 6 },
    });
    expect(deps.journal.orderFor('v2-debate-no-macro-gate-2026-09-28-AAPL-exit')).toMatchObject({
      outcome: 'simulated',
      payload: { reason: 'manual_halt' },
    });
    expect(refusalRows(deps, '2026-09-28')[0]?.message).toMatch(
      /^manual halt since .* \(going away\): no sleeve decides and every open position is exited$/,
    );
    const next = await runCycle(deps, '2026-09-29');
    expect(next).toMatchObject({ exits: 0, entries: 0, fills: 2 });
    expect(deps.books.positions('debate/primary')).toEqual([]);
    expect(deps.books.positions('debate/no-macro-gate')).toEqual([]);
  });

  it('halt shorts: the exit buys back at the next open, across the spread', async () => {
    const short: SleeveDecision = shortAapl;
    const deps = harness([short], true);
    await openBooks(deps);
    deps.setControl('halt');
    await runCycle(deps, '2026-09-28');
    expect(deps.journal.orderFor('v2-debate-primary-2026-09-28-AAPL-exit')?.side).toBe('buy');
    deps.barsByDate.set('2026-09-29', bar('2026-09-28', { open: 20.4, low: 20.3, high: 20.9 }));
    await runCycle(deps, '2026-09-29');
    expect(deps.books.positions('debate/primary')).toEqual([]);
    expect(exitFill(deps, 'v2-debate-primary-2026-09-28-AAPL-exit')).toEqual({
      side: 'buy',
      qty: 6,
      price_gbp: expect.closeTo((20.4 * (1 + HALF_SPREAD_BPS / 10_000)) / FX, 9),
    });
  });

  it('a simulated flatten fills at the first bar on or after its date, however many cycles were missed', async () => {
    const deps = harness([longAapl], true);
    await openBooks(deps);
    deps.setControl('halt');
    await runCycle(deps, '2026-09-28');
    deps.barsByDate.set('before the flatten', bar('2026-09-25', { open: 1, low: 1 }));
    deps.barsByDate.set('flatten day', bar('2026-09-28', { open: 19.5, low: 19.4 }));
    deps.barsByDate.set('2026-10-01', bar('2026-09-30', { open: 18 }));
    await runCycle(deps, '2026-10-01');
    expect(exitFill(deps, 'v2-debate-primary-2026-09-28-AAPL-exit')).toMatchObject({
      price_gbp: expect.closeTo((19.5 * (1 - HALF_SPREAD_BPS / 10_000)) / FX, 9),
    });
  });

  it('keeps a simulated flatten pending while no bar has come in: no second flatten, no bracket exit, a warning once stale', async () => {
    const deps = harness([longAapl], true);
    const flatten = vi.spyOn(deps.simulatedBroker, 'submitFlatten');
    await openBooks(deps);
    deps.setControl('halt');
    await runCycle(deps, '2026-09-28');
    const real = deps.market.barsBefore;
    const noBarsYet = vi
      .spyOn(deps.market, 'barsBefore')
      .mockImplementation((instrument, date, count) =>
        date > '2026-09-28' ? [] : real(instrument, date, count),
      );
    deps.barsByDate.set('2026-09-29', bar('2026-09-28', { low: 1 }));
    const quote = vi.spyOn(deps.executor, 'quoteSimulatedFill');
    const log = vi.fn();
    const waiting = await runCycle({ ...deps, logger: { log } }, '2026-09-29');
    expect(waiting).toMatchObject({ exits: 0, fills: 0 });
    expect(quote).not.toHaveBeenCalled();
    expect(flatten).toHaveBeenCalledTimes(2);
    expect(deps.books.position('debate/primary', 'AAPL')?.exitClientOrderId).toBe(
      'v2-debate-primary-2026-09-28-AAPL-exit',
    );
    await runCycle({ ...deps, logger: { log } }, '2026-10-03');
    const stale = (event: string) =>
      log.mock.calls
        .filter(([entry]) => entry.event === event && entry.level === 'warn')
        .map(([entry]) => entry.message);
    expect(stale('v2_simulated_flatten_stale')).toEqual([]);
    await runCycle({ ...deps, logger: { log } }, '2026-10-05');
    expect(stale('v2_simulated_flatten_stale')).toEqual([
      'debate/primary AAPL: flatten v2-debate-primary-2026-09-28-AAPL-exit has had no bar since 2026-09-28',
      'debate/no-macro-gate AAPL: flatten v2-debate-no-macro-gate-2026-09-28-AAPL-exit has had no bar since 2026-09-28',
    ]);
    noBarsYet.mockRestore();
    deps.setControl('resume');
    const filled = await runCycle(deps, '2026-10-06');
    expect(filled.fills).toBe(2);
    expect(deps.books.positions('debate/primary')).toEqual([]);
  });

  it('paper mode: halt cancels unfilled entries from earlier days and flattens the held position', async () => {
    const alpaca = new FakeAlpaca();
    const deps = harness([longAapl, { ...longAapl, instrument: 'MSFT' }], false, alpaca);
    await runCycle(deps, '2026-09-25');
    alpaca.fill('v2-debate-primary-2026-09-25-AAPL', 'entry', 6, 20);
    deps.setControl('halt');
    const report = await runCycle(deps, '2026-09-28');
    expect(report).toMatchObject({ exits: 3, submitted_orders: 1, entries: 0 });
    expect(alpaca.cancelled).toEqual(['v2-debate-primary-2026-09-25-MSFT']);
    expect(alpaca.flattens).toEqual(['v2-debate-primary-2026-09-28-AAPL-exit']);
    expect(deps.books.position('debate/primary', 'AAPL')?.exitClientOrderId).toBe(
      'v2-debate-primary-2026-09-28-AAPL-exit',
    );
    const pending = await runCycle(deps, '2026-09-29');
    expect(pending.exits).toBe(0);
    expect(alpaca.flattens).toHaveLength(1);
    expect(deps.books.position('debate/primary', 'AAPL')?.exitClientOrderId).toBe(
      'v2-debate-primary-2026-09-28-AAPL-exit',
    );
  });

  it('paper mode: a rejected halt flatten leaves no exit pending and is retried next cycle', async () => {
    const alpaca = new FakeAlpaca();
    const deps = harness([longAapl], false, alpaca);
    await runCycle(deps, '2026-09-25');
    alpaca.fill('v2-debate-primary-2026-09-25-AAPL', 'entry', 6, 20);
    deps.setControl('halt');
    alpaca.flattenError = new Error('venue closed');
    const rejected = await runCycle(deps, '2026-09-28');
    expect(rejected).toMatchObject({ rejected_orders: 1, submitted_orders: 0 });
    expect(deps.books.position('debate/primary', 'AAPL')?.exitClientOrderId).toBeUndefined();
    alpaca.flattenError = undefined;
    await runCycle(deps, '2026-09-29');
    expect(alpaca.flattens).toEqual(['v2-debate-primary-2026-09-29-AAPL-exit']);
  });

  it('halt leaves a position whose exit is already pending to that exit', async () => {
    const alpaca = new FakeAlpaca();
    const deps = harness([longAapl], false, alpaca);
    await runCycle(deps, '2026-09-25');
    alpaca.fill('v2-debate-primary-2026-09-25-AAPL', 'entry', 6, 20);
    deps.setDecisions([]);
    for (const date of [...TEN_MARKS, '2026-10-09']) await runCycle(deps, date);
    await runCycle(deps, '2026-10-12');
    expect(alpaca.flattens).toEqual(['v2-debate-primary-2026-10-12-AAPL-exit']);
    deps.setControl('halt');
    const resume = vi.spyOn(alpaca, 'resumeFlatten');
    const halted = await runCycle(deps, '2026-10-13');
    expect(halted.exits).toBe(0);
    expect(alpaca.flattens).toHaveLength(1);
    expect(resume).toHaveBeenCalledWith('v2-debate-primary-2026-10-12-AAPL-exit', 'AAPL');
  });

  it('a same-day retry under halt never resubmits an exit already journalled', async () => {
    const alpaca = new FakeAlpaca();
    const deps = harness([longAapl], false, alpaca);
    await runCycle(deps, '2026-09-25');
    alpaca.fill('v2-debate-primary-2026-09-25-AAPL', 'entry', 6, 20);
    deps.setControl('halt');
    alpaca.flattenError = new Error('venue closed');
    vi.spyOn(deps.books, 'markDay').mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    await expect(runCycle(deps, '2026-09-28')).rejects.toThrow(/disk full/);
    alpaca.flattenError = undefined;
    const retry = await runCycle(deps, '2026-09-28');
    expect(retry.submitted_orders).toBe(0);
    expect(alpaca.flattens).toEqual([]);
  });

  it('halt journals every position it cannot route instead of passing over it', async () => {
    const alpaca = new FakeAlpaca();
    const deps = harness([longAapl], false, alpaca);
    await runCycle(deps, '2026-09-25');
    alpaca.fill('v2-debate-primary-2026-09-25-AAPL', 'entry', 6, 20);
    await runCycle(deps, '2026-09-28');
    deps.setControl('halt');
    const real = deps.executor.canRoute.bind(deps.executor);
    vi.spyOn(deps.executor, 'canRoute').mockImplementation((route) =>
      route.bookVariant === 'primary' ? false : real(route),
    );
    const report = await runCycle(deps, '2026-09-29');
    const message = 'halt could not exit AAPL in debate/primary: no route to alpaca';
    expect(report.refusals).toContain(message);
    expect(refusalRows(deps, '2026-09-29')).toContainEqual({ parameter: 'MANUAL_HALT', message });
    const db = (
      deps.journal as unknown as { db: { prepare: (s: string) => { get: () => unknown } } }
    ).db;
    expect(
      db
        .prepare("SELECT book_id, instrument FROM v2_refusals WHERE parameter = 'MANUAL_HALT'")
        .get(),
    ).toEqual({ book_id: 'debate/primary', instrument: 'AAPL' });
    expect(alpaca.flattens).toEqual([]);
  });

  it('reads the control once per cycle: a halt set mid-cycle acts from the next cycle', async () => {
    const deps = harness([longAapl], true);
    await runCycle(deps, '2026-09-25');
    deps.setDecisions([]);
    vi.spyOn(deps.sleeve, 'decide').mockImplementationOnce(() => {
      deps.setControl('halt');
      return Promise.resolve({ decisions: [], refusals: [] });
    });
    const during = await runCycle(deps, '2026-09-28');
    expect(during.exits).toBe(0);
    expect(deps.books.positions('debate/primary')).toHaveLength(1);
    const after = await runCycle(deps, '2026-09-29');
    expect(after.exits).toBe(2);
  });

  it('resume lets sleeves decide and enter again', async () => {
    const deps = harness([longAapl], true);
    deps.setControl('pause');
    await runCycle(deps, '2026-09-25');
    deps.setControl('resume');
    const report = await runCycle(deps, '2026-09-28');
    expect(report.entries).toBe(2);
    expect(refusalRows(deps, '2026-09-28')).toEqual([]);
  });

  it('resume never lifts a loss-budget halt', async () => {
    const deps = harness([longAapl], true, undefined, [2026], TEST_SPEC, SPREAD_ONLY, 5);
    await runCycle(deps, '2026-09-25');
    deps.barsByDate.set(
      '2026-09-28',
      bar('2026-09-25', { low: 19.3, high: 20, close: 17, rawClose: 17 }),
    );
    const loss = await runCycle(deps, '2026-09-28');
    expect(deps.books.lastDay('debate/primary')?.state.halted).toBe(true);
    expect(loss.books[0]?.size_multiplier).toBe(0);
    deps.setControl('pause');
    await runCycle(deps, '2026-09-29');
    deps.setControl('resume');
    deps.setDecisions([{ ...longAapl, instrument: 'MSFT' }]);
    const resumed = await runCycle(deps, '2026-09-30');
    expect(sizeShares(deps, 'debate/primary', '2026-09-30', 'MSFT')).toBe(0);
    expect(resumed.books[0]?.size_multiplier).toBe(0);
  });
});

describe('runCycle: protected exits carry a native Alpaca bracket safely (#1801)', () => {
  const TEN_MARKS = [
    '2026-09-28',
    '2026-09-29',
    '2026-09-30',
    '2026-10-01',
    '2026-10-02',
    '2026-10-05',
    '2026-10-06',
    '2026-10-07',
    '2026-10-08',
  ];

  class FakeAlpacaProtected extends FakeAlpaca {
    readonly protectedExits: ProtectedExitRequest[] = [];
    readonly rearms: {
      clientOrderId: string;
      instrument: string;
      side: 'buy' | 'sell';
      qty: number;
      stop: number;
      target: number;
    }[] = [];
    protectedExitResult: (request: ProtectedExitRequest) => BrokerAck = (request) => ({
      client_order_id: request.clientOrderId,
      broker_order_ids: ['pf1'],
      order_state: 'submitted',
    });
    protectedExitError: Error | undefined;
    resumeResult: NormalizedOrder | null | undefined;

    submitProtectedExit(request: ProtectedExitRequest): Promise<BrokerAck> {
      this.protectedExits.push(request);
      if (this.protectedExitError !== undefined) return Promise.reject(this.protectedExitError);
      return Promise.resolve(this.protectedExitResult(request));
    }

    override resumeFlatten(
      clientOrderId: string,
      instrument: string,
    ): Promise<NormalizedOrder | null> {
      if (this.resumeResult !== undefined) return Promise.resolve(this.resumeResult);
      return super.resumeFlatten(clientOrderId, instrument);
    }

    override rearmProtectiveLegs(
      clientOrderId: string,
      instrument: string,
      side: 'buy' | 'sell',
      qty: number,
      stop: number,
      target: number,
    ): Promise<void> {
      this.rearms.push({ clientOrderId, instrument, side, qty, stop, target });
      return Promise.resolve();
    }
  }

  function refusalRows(deps: CycleDeps, tradingDate: string, scope: string) {
    const db = (
      deps.journal as unknown as {
        db: { prepare: (sql: string) => { all: (date: string, scope: string) => unknown[] } };
      }
    ).db;
    return db
      .prepare(
        'SELECT parameter, message, ticket FROM v2_refusals WHERE trading_date = ? AND scope = ?',
      )
      .all(tradingDate, scope) as { parameter: string; message: string; ticket: string }[];
  }

  it('kill line: a time stop closes a bracket-protected position through submitProtectedExit, carrying the entry id and native rearm prices', async () => {
    const alpaca = new FakeAlpacaProtected();
    const deps = harness([longAapl], false, alpaca);
    await runCycle(deps, '2026-09-25');
    alpaca.fill('v2-debate-primary-2026-09-25-AAPL', 'entry', 6, 20);
    deps.setDecisions([]);
    for (const date of [...TEN_MARKS, '2026-10-09']) await runCycle(deps, date);
    const timeStop = await runCycle(deps, '2026-10-12');

    expect(timeStop.exits).toBe(2);
    expect(alpaca.protectedExits).toHaveLength(1);
    const entryOrder = deps.journal.orderFor('v2-debate-primary-2026-09-25-AAPL');
    expect(alpaca.protectedExits[0]).toEqual({
      entryClientOrderId: 'v2-debate-primary-2026-09-25-AAPL',
      clientOrderId: 'v2-debate-primary-2026-10-12-AAPL-exit',
      instrument: 'AAPL',
      side: 'sell',
      size: 6,
      rearm: { stop: entryOrder?.payload.stop, target: entryOrder?.payload.target },
    });
    expect(deps.books.position('debate/primary', 'AAPL')?.exitClientOrderId).toBe(
      'v2-debate-primary-2026-10-12-AAPL-exit',
    );
  });

  it.each([
    ['a stop but no target', { target: undefined }],
    ['a target but no stop', { stop: undefined }],
  ])(
    'carries no rearm prices when the journalled entry has %s',
    async (_label, missing: { stop?: undefined; target?: undefined }) => {
      const alpaca = new FakeAlpacaProtected();
      const deps = harness([longAapl], false, alpaca);
      await runCycle(deps, '2026-09-25');
      alpaca.fill('v2-debate-primary-2026-09-25-AAPL', 'entry', 6, 20);
      const realOrderFor = deps.journal.orderFor.bind(deps.journal);
      vi.spyOn(deps.journal, 'orderFor').mockImplementation((clientOrderId: string) => {
        const order = realOrderFor(clientOrderId);
        if (order === undefined || clientOrderId !== 'v2-debate-primary-2026-09-25-AAPL')
          return order;
        return { ...order, payload: { ...order.payload, ...missing } };
      });
      deps.setControl('halt');
      await runCycle(deps, '2026-09-28');

      expect(alpaca.protectedExits).toHaveLength(1);
      expect(alpaca.protectedExits[0]?.rearm).toBeUndefined();
    },
  );

  it('kill line: a manual halt closes a bracket-protected position through submitProtectedExit', async () => {
    const alpaca = new FakeAlpacaProtected();
    const deps = harness([longAapl], false, alpaca);
    await runCycle(deps, '2026-09-25');
    alpaca.fill('v2-debate-primary-2026-09-25-AAPL', 'entry', 6, 20);
    deps.setControl('halt');
    const report = await runCycle(deps, '2026-09-28');

    expect(report).toMatchObject({ exits: 2, submitted_orders: 1 });
    expect(alpaca.protectedExits).toHaveLength(1);
    expect(alpaca.protectedExits[0]).toMatchObject({
      entryClientOrderId: 'v2-debate-primary-2026-09-25-AAPL',
      clientOrderId: 'v2-debate-primary-2026-09-28-AAPL-exit',
      side: 'sell',
      size: 6,
    });
    expect(deps.books.position('debate/primary', 'AAPL')?.exitClientOrderId).toBe(
      'v2-debate-primary-2026-09-28-AAPL-exit',
    );
  });

  it('a day flatten that expires with the position still held clears the exit marker, re-arms the protective legs, and retries the exit the same cycle while still halted', async () => {
    const alpaca = new FakeAlpacaProtected();
    const deps = harness([longAapl], false, alpaca);
    await runCycle(deps, '2026-09-25');
    alpaca.fill('v2-debate-primary-2026-09-25-AAPL', 'entry', 6, 20);
    deps.setControl('halt');
    await runCycle(deps, '2026-09-28');
    expect(deps.books.position('debate/primary', 'AAPL')?.exitClientOrderId).toBe(
      'v2-debate-primary-2026-09-28-AAPL-exit',
    );

    alpaca.resumeResult = {
      client_order_id: 'v2-debate-primary-2026-09-28-AAPL-exit',
      broker_order_ids: ['pf1'],
      order_state: 'expired',
      filled_qty: 0,
    };
    const next = await runCycle(deps, '2026-09-29');

    expect(alpaca.rearms).toHaveLength(1);
    const entryOrder = deps.journal.orderFor('v2-debate-primary-2026-09-25-AAPL');
    expect(alpaca.rearms[0]).toEqual({
      clientOrderId: 'v2-debate-primary-2026-09-25-AAPL',
      instrument: 'AAPL',
      side: 'buy',
      qty: 6,
      stop: entryOrder?.payload.stop,
      target: entryOrder?.payload.target,
    });
    expect(deps.journal.orderFor('v2-debate-primary-2026-09-29-AAPL-rearm')).toMatchObject({
      outcome: 'submitted',
      payload: {
        exit_client_order_id: 'v2-debate-primary-2026-09-28-AAPL-exit',
      },
    });

    // still halted: the position is retried for exit within the SAME cycle, never left
    // unprotected or unattended across a cycle boundary
    expect(deps.books.position('debate/primary', 'AAPL')?.exitClientOrderId).toBe(
      'v2-debate-primary-2026-09-29-AAPL-exit',
    );
    expect(alpaca.protectedExits.map((request) => request.clientOrderId)).toEqual([
      'v2-debate-primary-2026-09-28-AAPL-exit',
      'v2-debate-primary-2026-09-29-AAPL-exit',
    ]);
    expect(next.submitted_orders).toBeGreaterThanOrEqual(2);

    alpaca.resumeResult = undefined;
    alpaca.fill('v2-debate-primary-2026-09-29-AAPL-exit', 'exit', 6, 20);
    const resumed = await runCycle(deps, '2026-09-30');
    expect(resumed.fills).toBeGreaterThanOrEqual(1);
    expect(deps.books.positions('debate/primary')).toEqual([]);
  });

  it('journals a REARM_BACKSTOP refusal and does not guess when a backstop rearm has no journalled native price', async () => {
    const alpaca = new FakeAlpacaProtected();
    const deps = harness([longAapl], false, alpaca);
    await runCycle(deps, '2026-09-25');
    alpaca.fill('v2-debate-primary-2026-09-25-AAPL', 'entry', 6, 20);
    const realOrderFor = deps.journal.orderFor.bind(deps.journal);
    vi.spyOn(deps.journal, 'orderFor').mockImplementation((clientOrderId: string) => {
      const order = realOrderFor(clientOrderId);
      if (order === undefined || clientOrderId !== 'v2-debate-primary-2026-09-25-AAPL')
        return order;
      return { ...order, payload: { ...order.payload, stop: undefined, target: undefined } };
    });
    deps.setControl('halt');
    await runCycle(deps, '2026-09-28');

    alpaca.resumeResult = {
      client_order_id: 'v2-debate-primary-2026-09-28-AAPL-exit',
      broker_order_ids: ['pf1'],
      order_state: 'expired',
      filled_qty: 0,
    };
    const next = await runCycle(deps, '2026-09-29');

    expect(alpaca.rearms).toHaveLength(0);
    expect(refusalRows(deps, '2026-09-29', 'execution')).toContainEqual(
      expect.objectContaining({ parameter: 'REARM_BACKSTOP', ticket: '#1801' }),
    );
    expect(next.refusals.some((refusal) => refusal.includes('UNPROTECTED'))).toBe(true);
    // the backstop declines to guess, but the marker was still cleared, so the ordinary
    // halt-exit re-evaluation immediately retries the flatten within the same cycle
    expect(deps.books.position('debate/primary', 'AAPL')?.exitClientOrderId).toBe(
      'v2-debate-primary-2026-09-29-AAPL-exit',
    );
  });

  it('re-arms inline and re-throws when the day flatten submission itself fails, leaving no exit pending', async () => {
    const alpaca = new FakeAlpacaProtected();
    const deps = harness([longAapl], false, alpaca);
    await runCycle(deps, '2026-09-25');
    alpaca.fill('v2-debate-primary-2026-09-25-AAPL', 'entry', 6, 20);
    deps.setControl('halt');
    alpaca.protectedExitError = new Error('venue closed');
    const rejected = await runCycle(deps, '2026-09-28');

    expect(rejected).toMatchObject({ rejected_orders: 1 });
    expect(deps.books.position('debate/primary', 'AAPL')?.exitClientOrderId).toBeUndefined();
    alpaca.protectedExitError = undefined;
    await runCycle(deps, '2026-09-29');
    expect(alpaca.protectedExits).toHaveLength(2);
  });

  describe('#1831: a crossing fill auto-flattens the stray position', () => {
    it('a flip from long to short is flattened in the same cycle, carrying no fabricated rearm', async () => {
      const alpaca = new FakeAlpacaProtected();
      const deps = harness([longAapl], false, alpaca);
      await runCycle(deps, '2026-09-25');
      alpaca.fill('v2-debate-primary-2026-09-25-AAPL', 'entry', 6, 20);
      deps.setDecisions([]);
      await runCycle(deps, '2026-09-28');
      // Never passes through flat: one oversized stop fill both closes the long and opens a short
      alpaca.fill('v2-debate-primary-2026-09-25-AAPL', 'stop', 15, 18);
      const report = await runCycle(deps, '2026-09-29');

      expect(deps.books.position('debate/primary', 'AAPL')).toMatchObject({
        qty: -9,
        stray: true,
        exitClientOrderId: 'v2-debate-primary-2026-09-29-AAPL-exit',
      });
      expect(alpaca.protectedExits).toHaveLength(1);
      expect(alpaca.protectedExits[0]).toEqual({
        entryClientOrderId: 'v2-debate-primary-2026-09-25-AAPL',
        clientOrderId: 'v2-debate-primary-2026-09-29-AAPL-exit',
        instrument: 'AAPL',
        side: 'buy',
        size: 9,
        rearm: undefined,
      });
      expect(report.refusals).toContainEqual(
        'debate/primary AAPL: a stop fill on v2-debate-primary-2026-09-25-AAPL left qty -9 ' +
          'where qty 6 held; a fill must never flip or open a position outside a fresh entry ' +
          '(#1778)',
      );
      expect(deps.journal.orderFor('v2-debate-primary-2026-09-29-AAPL-exit')?.payload.reason).toBe(
        'crossing_fill',
      );
    });

    it('a stray whose flatten is still working is not resubmitted the next cycle', async () => {
      const alpaca = new FakeAlpacaProtected();
      const deps = harness([longAapl], false, alpaca);
      await runCycle(deps, '2026-09-25');
      alpaca.fill('v2-debate-primary-2026-09-25-AAPL', 'entry', 6, 20);
      deps.setDecisions([]);
      await runCycle(deps, '2026-09-28');
      alpaca.fill('v2-debate-primary-2026-09-25-AAPL', 'stop', 15, 18);
      await runCycle(deps, '2026-09-29');
      expect(alpaca.protectedExits).toHaveLength(1);

      alpaca.resumeResult = {
        client_order_id: 'v2-debate-primary-2026-09-29-AAPL-exit',
        broker_order_ids: ['pf1'],
        order_state: 'submitted',
        filled_qty: 0,
      };
      await runCycle(deps, '2026-09-30');

      expect(alpaca.protectedExits).toHaveLength(1);
      expect(deps.books.position('debate/primary', 'AAPL')?.exitClientOrderId).toBe(
        'v2-debate-primary-2026-09-29-AAPL-exit',
      );
    });

    it('a route that cannot be reached this cycle leaves the stray for the next cycle to flatten', async () => {
      const alpaca = new FakeAlpacaProtected();
      const deps = harness([longAapl], false, alpaca);
      await runCycle(deps, '2026-09-25');
      alpaca.fill('v2-debate-primary-2026-09-25-AAPL', 'entry', 6, 20);
      deps.setDecisions([]);
      await runCycle(deps, '2026-09-28');
      alpaca.fill('v2-debate-primary-2026-09-25-AAPL', 'stop', 15, 18);

      const real = deps.executor.canRoute.bind(deps.executor);
      vi.spyOn(deps.executor, 'canRoute').mockReturnValue(false);
      const blocked = await runCycle(deps, '2026-09-29');
      expect(alpaca.protectedExits).toHaveLength(0);
      expect(deps.books.position('debate/primary', 'AAPL')).toMatchObject({
        qty: -9,
        stray: true,
        exitClientOrderId: undefined,
      });
      expect(blocked.refusals).toContainEqual(expect.stringContaining('(#1778)'));

      vi.spyOn(deps.executor, 'canRoute').mockImplementation(real);
      await runCycle(deps, '2026-09-30');
      expect(alpaca.protectedExits).toHaveLength(1);
      expect(alpaca.protectedExits[0]).toMatchObject({
        clientOrderId: 'v2-debate-primary-2026-09-30-AAPL-exit',
        side: 'buy',
        size: 9,
        rearm: undefined,
      });
      expect(deps.books.position('debate/primary', 'AAPL')?.exitClientOrderId).toBe(
        'v2-debate-primary-2026-09-30-AAPL-exit',
      );
    });

    it('an expired stray flatten re-flattens the same cycle without fabricating a rearm', async () => {
      const alpaca = new FakeAlpacaProtected();
      const deps = harness([longAapl], false, alpaca);
      await runCycle(deps, '2026-09-25');
      alpaca.fill('v2-debate-primary-2026-09-25-AAPL', 'entry', 6, 20);
      deps.setDecisions([]);
      await runCycle(deps, '2026-09-28');
      alpaca.fill('v2-debate-primary-2026-09-25-AAPL', 'stop', 15, 18);
      await runCycle(deps, '2026-09-29');
      expect(deps.books.position('debate/primary', 'AAPL')?.exitClientOrderId).toBe(
        'v2-debate-primary-2026-09-29-AAPL-exit',
      );

      alpaca.resumeResult = {
        client_order_id: 'v2-debate-primary-2026-09-29-AAPL-exit',
        broker_order_ids: ['pf1'],
        order_state: 'expired',
        filled_qty: 0,
      };
      await runCycle(deps, '2026-09-30');

      expect(alpaca.rearms).toHaveLength(0);
      expect(refusalRows(deps, '2026-09-30', 'execution')).not.toContainEqual(
        expect.objectContaining({ parameter: 'REARM_BACKSTOP' }),
      );
      expect(alpaca.protectedExits.map((request) => request.clientOrderId)).toEqual([
        'v2-debate-primary-2026-09-29-AAPL-exit',
        'v2-debate-primary-2026-09-30-AAPL-exit',
      ]);
      expect(alpaca.protectedExits[1]).toMatchObject({ rearm: undefined, side: 'buy', size: 9 });
      expect(deps.books.position('debate/primary', 'AAPL')?.exitClientOrderId).toBe(
        'v2-debate-primary-2026-09-30-AAPL-exit',
      );
    });

    it('a late duplicate bracket leg opening from flat is flattened the same as a flip', async () => {
      const alpaca = new FakeAlpacaProtected();
      const deps = harness([longAapl], false, alpaca);
      await runCycle(deps, '2026-09-25');
      alpaca.fill('v2-debate-primary-2026-09-25-AAPL', 'entry', 6, 20);
      deps.setDecisions([]);
      await runCycle(deps, '2026-09-28');
      alpaca.fill('v2-debate-primary-2026-09-25-AAPL', 'target', 6, 25);
      await runCycle(deps, '2026-09-29');
      expect(deps.books.position('debate/primary', 'AAPL')).toBeUndefined();

      // A duplicate leg from the same native bracket firing after the other already closed it
      alpaca.fill('v2-debate-primary-2026-09-25-AAPL', 'stop', 4, 18);
      const report = await runCycle(deps, '2026-09-30');

      expect(deps.books.position('debate/primary', 'AAPL')).toMatchObject({
        qty: -4,
        stray: true,
        exitClientOrderId: 'v2-debate-primary-2026-09-30-AAPL-exit',
      });
      expect(alpaca.protectedExits).toHaveLength(1);
      expect(alpaca.protectedExits[0]).toEqual({
        entryClientOrderId: 'v2-debate-primary-2026-09-25-AAPL',
        clientOrderId: 'v2-debate-primary-2026-09-30-AAPL-exit',
        instrument: 'AAPL',
        side: 'buy',
        size: 4,
        rearm: undefined,
      });
      expect(report.refusals).toContainEqual(
        'debate/primary AAPL: a stop fill on v2-debate-primary-2026-09-25-AAPL left qty -4 ' +
          'where no position was held; a fill must never flip or open a position outside a ' +
          'fresh entry (#1778)',
      );
    });
  });
});

describe('#1873: Alpaca cumulative fills book as increments per broker order', () => {
  const ENTRY = 'v2-debate-primary-2026-09-25-AAPL';

  async function entered(log = vi.fn()) {
    const alpaca = new FakeAlpaca();
    const deps = { ...harness([longAapl], false, alpaca), logger: { log } };
    await runCycle(deps, '2026-09-25');
    deps.setDecisions([]);
    return { alpaca, deps, log };
  }

  function heldQty(deps: CycleDeps): number {
    return deps.books.position('debate/primary', 'AAPL')?.qty ?? 0;
  }

  function fillRows(deps: CycleDeps) {
    const db = (
      deps.journal as unknown as { db: { prepare: (sql: string) => { all: () => unknown[] } } }
    ).db;
    return db
      .prepare(
        "SELECT fill_id, leg, qty, price_gbp FROM v2_fills WHERE book_id = 'debate/primary' ORDER BY recorded_at, fill_id",
      )
      .all();
  }

  it('kill line: a partial then the complete report books the broker quantity at the true average', async () => {
    const { alpaca, deps, log } = await entered();
    alpaca.cumulative(ENTRY, 'entry', 4, 20);
    await runCycle(deps, '2026-09-28');
    expect(fillRows(deps)).toHaveLength(1);
    expect(heldQty(deps)).toBe(4);
    alpaca.cumulative(ENTRY, 'entry', 6, 20.2);
    const complete = await runCycle(deps, '2026-09-29');
    expect(complete.fills).toBe(1);
    expect(heldQty(deps)).toBe(6);
    expect(deps.books.position('debate/primary', 'AAPL')).toMatchObject({
      avgPriceGbp: expect.closeTo(20.2 / FX, 9),
      stopGbp: expect.closeTo(19.2 / FX, 9),
      targetGbp: expect.closeTo(21.2 / FX, 9),
    });
    expect(deps.books.cash('debate/primary')).toBeCloseTo(1_000 - (6 * 20.2) / FX, 9);
    expect(log.mock.calls.some(([entry]) => entry.level === 'warn')).toBe(false);
    expect(fillRows(deps)).toEqual([
      { fill_id: `alpaca:alp-${ENTRY}-entry`, leg: 'entry', qty: 4, price_gbp: 20 / FX },
      {
        fill_id: `alpaca:alp-${ENTRY}-entry#6`,
        leg: 'entry',
        qty: 2,
        price_gbp: expect.closeTo(20.6 / FX, 9),
      },
    ]);
  });

  it('kill line: a partial then cancel keeps the partial quantity however often it is re-reported', async () => {
    const { alpaca, deps } = await entered();
    alpaca.cumulative(ENTRY, 'entry', 4, 20);
    await runCycle(deps, '2026-09-28');
    for (const date of ['2026-09-29', '2026-09-30']) {
      alpaca.cumulative(ENTRY, 'entry', 4, 20);
      const report = await runCycle(deps, date);
      expect(report.fills).toBe(0);
      expect(heldQty(deps)).toBe(4);
    }
    expect(fillRows(deps)).toHaveLength(1);
  });

  it('kill line: duplicates and a stale report inside one sweep leave the latest cumulative quantity', async () => {
    const { alpaca, deps, log } = await entered();
    for (const qty of [4, 4, 6, 4, 6]) alpaca.cumulative(ENTRY, 'entry', qty, 20);
    await runCycle(deps, '2026-09-28');
    expect(fillRows(deps)).toHaveLength(2);
    expect(heldQty(deps)).toBe(6);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'warn',
        event: 'v2_fill_cumulative_behind',
        message: `alpaca:alp-${ENTRY}-entry reports cumulative qty 4 below the 6 already booked; ignored`,
      }),
    );
  });

  it('kill line: a report arriving after a later one books the later total once and never goes negative', async () => {
    const { alpaca, deps, log } = await entered();
    alpaca.cumulative(ENTRY, 'entry', 6, 20.2);
    alpaca.cumulative(ENTRY, 'entry', 4, 20);
    await runCycle(deps, '2026-09-28');
    expect(heldQty(deps)).toBe(6);
    alpaca.cumulative(ENTRY, 'entry', 4, 20);
    const report = await runCycle(deps, '2026-09-29');
    expect(report.fills).toBe(0);
    expect(heldQty(deps)).toBe(6);
    expect(deps.books.cash('debate/primary')).toBeCloseTo(1_000 - (6 * 20.2) / FX, 9);
    expect(
      log.mock.calls.filter(([entry]) => entry.event === 'v2_fill_cumulative_behind'),
    ).toHaveLength(2);
  });

  it('kill line: each leg order accumulates on its own, so a partial stop after a full entry resizes then closes', async () => {
    const { alpaca, deps } = await entered();
    alpaca.cumulative(ENTRY, 'entry', 6, 20);
    await runCycle(deps, '2026-09-28');
    alpaca.cumulative(ENTRY, 'entry', 6, 20);
    alpaca.cumulative(ENTRY, 'stop', 2, 19.2);
    await runCycle(deps, '2026-09-29');
    expect(heldQty(deps)).toBe(4);
    alpaca.cumulative(ENTRY, 'stop', 6, 19.1);
    const report = await runCycle(deps, '2026-09-30');
    expect(report.refusals.some((refusal) => refusal.includes('(#1778)'))).toBe(false);
    expect(heldQty(deps)).toBe(0);
    expect(deps.books.cash('debate/primary')).toBeCloseTo(
      1_000 - (6 * 20) / FX + (6 * 19.1) / FX,
      9,
    );
  });

  it('a discrete report is booked whole and stays idempotent on its id, never read as a running total', async () => {
    const { alpaca, deps } = await entered();
    alpaca.fill(ENTRY, 'entry', 4, 20);
    alpaca.fill(ENTRY, 'entry', 4, 20);
    await runCycle(deps, '2026-09-28');
    expect(heldQty(deps)).toBe(4);
    alpaca.fill(ENTRY, 'entry', 6, 20);
    await runCycle(deps, '2026-09-29');
    expect(heldQty(deps)).toBe(4);
  });

  it('warns and books at the running average when the carved increment price is unusable', async () => {
    const { alpaca, deps, log } = await entered();
    alpaca.cumulative(ENTRY, 'entry', 4, 30);
    await runCycle(deps, '2026-09-28');
    alpaca.cumulative(ENTRY, 'entry', 6, 20);
    await runCycle(deps, '2026-09-29');
    expect(heldQty(deps)).toBe(6);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'warn',
        event: 'v2_fill_increment_price_unusable',
        message: `alpaca:alp-${ENTRY}-entry: increment of 2 booked at the cumulative average 20`,
      }),
    );
  });
});

describe('budgetChanges', () => {
  const state = (over: Partial<LossBudgetState>): LossBudgetState => ({
    referenceEquityGbp: 1_000,
    ytdLossGbp: 600,
    sizeMultiplier: 1,
    halted: false,
    entriesBlockedAtNextFill: false,
    ...over,
  });
  const events = (before: LossBudgetState | undefined, after: LossBudgetState) =>
    budgetChanges('b', before, after).map((change) => [change.level, change.event]);

  it('alerts a book whose first-ever mark is already halted or stepped down', () => {
    expect(events(undefined, state({ halted: true, sizeMultiplier: 0 }))).toEqual([
      ['error', 'v2_loss_budget_halt'],
    ]);
    expect(events(undefined, state({ sizeMultiplier: 0.5 }))).toEqual([
      ['warn', 'v2_loss_budget_step'],
    ]);
    expect(events(undefined, state({}))).toEqual([]);
  });

  it('stays quiet while a halt or a size holds, and after a reset lifts it', () => {
    const halted = state({ halted: true, sizeMultiplier: 0 });
    expect(events(halted, halted)).toEqual([]);
    expect(events(state({ sizeMultiplier: 0.5 }), state({ sizeMultiplier: 0.5 }))).toEqual([]);
    expect(events(state({ sizeMultiplier: 0.25 }), state({ sizeMultiplier: 1 }))).toEqual([]);
    expect(events(state({ sizeMultiplier: 0.5 }), state({ sizeMultiplier: 0.25 }))).toEqual([
      ['warn', 'v2_loss_budget_step'],
    ]);
  });

  it('never reports the daily cap under a halt', () => {
    expect(
      events(undefined, state({ halted: true, sizeMultiplier: 0, entriesBlockedAtNextFill: true })),
    ).toEqual([['error', 'v2_loss_budget_halt']]);
  });
});

describe('runCycle: loss-budget alerts', () => {
  const drop = () => bar('2026-09-25', { low: 19.3, high: 20, close: 17, rawClose: 17 });

  function budgetEvents(lossCapGbp: number) {
    const deps = harness([longAapl], true, undefined, [2026], TEST_SPEC, SPREAD_ONLY, lossCapGbp);
    const events: [string, string | undefined, string][] = [];
    const logger = {
      log: (entry: LogEntry) => {
        if (entry.event?.startsWith('v2_loss_budget') || entry.event === 'v2_daily_loss_cap') {
          events.push([entry.level, entry.event, entry.message]);
        }
      },
    };
    return { deps: { ...deps, logger }, events };
  }

  const BOOKS = ['debate/primary', 'debate/no-macro-gate'];

  it('alerts a halt once, as an error, never as a step or a daily cap', async () => {
    const { deps, events } = budgetEvents(5);
    await runCycle(deps, '2026-09-25');
    deps.barsByDate.set('2026-09-28', drop());
    await runCycle(deps, '2026-09-28');
    deps.setDecisions([]);
    await runCycle(deps, '2026-09-29');
    expect(events).toEqual(
      BOOKS.map((book) => [
        'error',
        'v2_loss_budget_halt',
        `${book}: loss budget halts entries, year-to-date loss £14.40`,
      ]),
    );
  });

  it('alerts a size step-down and the daily cap as warnings, the step only once', async () => {
    const { deps, events } = budgetEvents(30);
    await runCycle(deps, '2026-09-25');
    deps.barsByDate.set('2026-09-28', drop());
    await runCycle(deps, '2026-09-28');
    deps.setDecisions([]);
    await runCycle(deps, '2026-09-29');
    expect(events).toEqual(
      BOOKS.flatMap((book) => [
        ['warn', 'v2_loss_budget_step', `${book}: entries sized at 0.5x, year-to-date loss £14.40`],
        ['warn', 'v2_daily_loss_cap', `${book}: daily loss cap blocks new entries`],
      ]),
    );
  });

  it('says nothing while the budget is untouched', async () => {
    const { deps, events } = budgetEvents(1_500);
    await runCycle(deps, '2026-09-25');
    await runCycle(deps, '2026-09-28');
    expect(events).toEqual([]);
  });
});

describe('runCycle: a mark that blocks entries cancels the resting ones', () => {
  const drop = () => bar('2026-09-25', { low: 19.3, high: 20, close: 17, rawClose: 17 });
  const msft: SleeveDecision = { ...longAapl, instrument: 'MSFT' };

  function budgetRows(deps: CycleDeps) {
    const db = (
      deps.journal as unknown as { db: { prepare: (sql: string) => { all: () => unknown[] } } }
    ).db;
    return db
      .prepare(
        "SELECT trading_date, scope, ticket, message FROM v2_refusals WHERE parameter = 'LOSS_BUDGET' ORDER BY message",
      )
      .all();
  }

  it('simulated books: the halting mark cancels the entry sent that cycle, so it never fills', async () => {
    const deps = harness([longAapl], true, undefined, [2026], TEST_SPEC, SPREAD_ONLY, 5);
    await runCycle(deps, '2026-09-25');
    deps.barsByDate.set('2026-09-28', drop());
    deps.setDecisions([msft]);
    const halted = await runCycle(deps, '2026-09-28');
    expect(halted.entries).toBe(2);
    expect(deps.books.lastDay('debate/primary')?.state.halted).toBe(true);
    expect(deps.journal.orderFor('v2-debate-primary-2026-09-28-MSFT')).toMatchObject({
      outcome: 'cancelled',
      payload: { cancelled: '2026-09-28' },
    });
    expect(deps.journal.orderFor('v2-debate-no-macro-gate-2026-09-28-MSFT')?.outcome).toBe(
      'cancelled',
    );
    expect(budgetRows(deps)).toEqual([
      {
        trading_date: '2026-09-28',
        scope: 'entry',
        ticket: '#1813',
        message:
          'debate/no-macro-gate: loss budget halt at the 2026-09-28 mark cancelled resting entries: 1',
      },
      {
        trading_date: '2026-09-28',
        scope: 'entry',
        ticket: '#1813',
        message:
          'debate/primary: loss budget halt at the 2026-09-28 mark cancelled resting entries: 1',
      },
    ]);
    const db = (
      deps.journal as unknown as { db: { prepare: (s: string) => { all: () => unknown[] } } }
    ).db;
    expect(
      db
        .prepare(
          "SELECT book_id, instrument FROM v2_refusals WHERE parameter = 'LOSS_BUDGET' ORDER BY book_id",
        )
        .all(),
    ).toEqual([
      { book_id: 'debate/no-macro-gate', instrument: null },
      { book_id: 'debate/primary', instrument: null },
    ]);
    const next = await runCycle(deps, '2026-09-29');
    expect(next.fills).toBe(0);
    expect(deps.books.position('debate/primary', 'MSFT')).toBeUndefined();
    expect(budgetRows(deps)).toHaveLength(2);
  });

  it('a crash between the mark and its cancels is repaired before the next cycle fills anything', async () => {
    const deps = harness([longAapl], true, undefined, [2026], TEST_SPEC, SPREAD_ONLY, 5);
    await runCycle(deps, '2026-09-25');
    deps.barsByDate.set('2026-09-28', drop());
    deps.setDecisions([msft]);
    // Simulates the crash losing every read of resting entries during this one cycle,
    // however many call sites now make one (#1785 added a cash-gate read in entries()) — a
    // fixed call count here would be re-broken by the next such addition
    const restingEntries = vi.spyOn(deps.journal, 'restingEntries').mockReturnValue([]);
    await runCycle(deps, '2026-09-28');
    expect(deps.journal.orderFor('v2-debate-primary-2026-09-28-MSFT')?.outcome).toBe(
      'refused_dry_run',
    );
    restingEntries.mockRestore();
    await runCycle(deps, '2026-09-29');
    expect(deps.journal.orderFor('v2-debate-primary-2026-09-28-MSFT')).toMatchObject({
      outcome: 'cancelled',
      payload: { cancelled: '2026-09-29' },
    });
    expect(deps.books.position('debate/primary', 'MSFT')).toBeUndefined();
    expect(budgetRows(deps)).toContainEqual({
      trading_date: '2026-09-29',
      scope: 'entry',
      ticket: '#1813',
      message:
        'debate/primary: loss budget halt at the 2026-09-28 mark cancelled resting entries: 1',
    });
    expect(budgetRows(deps)).toHaveLength(2);
  });

  it('paper: the halting mark cancels the Alpaca entry sent that cycle', async () => {
    const alpaca = new FakeAlpaca();
    const deps = harness([longAapl], false, alpaca, [2026], TEST_SPEC, SPREAD_ONLY, 5);
    await runCycle(deps, '2026-09-25');
    alpaca.fill('v2-debate-primary-2026-09-25-AAPL', 'entry', 6, 20);
    deps.barsByDate.set('2026-09-28', drop());
    deps.setDecisions([msft]);
    await runCycle(deps, '2026-09-28');
    expect(alpaca.cancelled).toEqual(['v2-debate-primary-2026-09-28-MSFT']);
    expect(deps.journal.orderFor('v2-debate-primary-2026-09-28-MSFT')?.outcome).toBe('cancelled');
  });

  it('paper: a resting entry on a route the executor cannot reach is left alone', async () => {
    const alpaca = new FakeAlpaca();
    const deps = harness([longAapl], false, alpaca, [2026], TEST_SPEC, SPREAD_ONLY, 5);
    await runCycle(deps, '2026-09-25');
    alpaca.fill('v2-debate-primary-2026-09-25-AAPL', 'entry', 6, 20);
    deps.barsByDate.set('2026-09-28', drop());
    deps.setDecisions([msft]);
    const real = deps.executor.canRoute.bind(deps.executor);
    vi.spyOn(deps.executor, 'canRoute').mockImplementation(
      (route) =>
        !(
          route.bookVariant === 'primary' &&
          deps.journal.orderFor('v2-debate-primary-2026-09-28-MSFT') !== undefined
        ) && real(route),
    );
    await runCycle(deps, '2026-09-28');
    expect(alpaca.cancelled).toEqual([]);
    expect(deps.journal.orderFor('v2-debate-primary-2026-09-28-MSFT')?.outcome).toBe('submitted');
  });

  it('paper: a cancel the venue refuses is logged, left resting, and not counted', async () => {
    const alpaca = new FakeAlpaca();
    const deps = harness([longAapl], false, alpaca, [2026], TEST_SPEC, SPREAD_ONLY, 5);
    await runCycle(deps, '2026-09-25');
    alpaca.fill('v2-debate-primary-2026-09-25-AAPL', 'entry', 6, 20);
    deps.barsByDate.set('2026-09-28', drop());
    deps.setDecisions([msft]);
    alpaca.cancelError = new Error('venue closed');
    const log = vi.fn();
    await runCycle({ ...deps, logger: { log } }, '2026-09-28');
    expect(deps.journal.orderFor('v2-debate-primary-2026-09-28-MSFT')?.outcome).toBe('submitted');
    expect(
      log.mock.calls.filter(
        ([entry]) =>
          entry.event === 'v2_cancel_failed' &&
          entry.level === 'warn' &&
          entry.message.startsWith('v2-debate-primary-2026-09-28-MSFT: '),
      ),
    ).toHaveLength(1);
    expect(budgetRows(deps)).toEqual([
      {
        trading_date: '2026-09-28',
        scope: 'entry',
        ticket: '#1813',
        message:
          'debate/no-macro-gate: loss budget halt at the 2026-09-28 mark cancelled resting entries: 1',
      },
    ]);
  });
});

describe('per-sleeve loss budgets (David 2026-09-30, #1941)', () => {
  it("a loss that halts one primary leaves another primary's sizing and next entry untouched", async () => {
    const share = 0.5;
    const specA: SleeveSpec = { ...TEST_SPEC, capitalShare: share };
    const specB: SleeveSpec = { ...TEST_SPEC, capitalShare: share };
    let trendDecisions: readonly SleeveDecision[] = [];
    const trend: Sleeve = {
      id: 'trend',
      spec: specB,
      universe: () => ({
        instruments: trendDecisions.map((decision) => decision.instrument),
        refusals: [],
      }),
      decide: () => Promise.resolve({ decisions: trendDecisions, refusals: [] }),
    };
    const deps = harness([], true, undefined, [2026], specA, SPREAD_ONLY, 600, trend);

    loseInBook(deps.books, 'debate/primary', '2026-09-25', 550, 'a');
    loseInBook(deps.books, 'trend/primary', '2026-09-25', 50, 'b');
    await runCycle(deps, '2026-09-25');

    expect(deps.books.lastDay('debate/primary')?.state).toMatchObject({
      halted: true,
      sizeMultiplier: 0,
    });
    expect(deps.books.lastDay('trend/primary')?.state).toMatchObject({
      halted: false,
      sizeMultiplier: 1,
    });

    trendDecisions = [{ ...longAapl, sleeve_id: 'trend' }];
    await runCycle(deps, '2026-09-28');

    expect(sizeShares(deps, 'trend/primary', '2026-09-28', 'AAPL')).toBeGreaterThan(0);
  });
});

describe('#1941: one Alpaca account across broker-routed books', () => {
  function twoPrimaries(dryRun: boolean, alpaca?: FakeAlpaca, trendInstrument = 'AAPL') {
    const spec: SleeveSpec = { ...TEST_SPEC, capitalShare: 0.5 };
    const decision = { ...longAapl, sleeve_id: 'trend', instrument: trendInstrument };
    const trend: Sleeve = {
      id: 'trend',
      spec,
      universe: () => ({ instruments: [trendInstrument], refusals: [] }),
      decide: () => Promise.resolve({ decisions: [decision], refusals: [] }),
    };
    return harness([longAapl], dryRun, alpaca, [2026], spec, SPREAD_ONLY, 1_500, trend);
  }

  it('refuses a second primary entry on a symbol another primary rests at the broker', async () => {
    const alpaca = new FakeAlpaca();
    const deps = twoPrimaries(false, alpaca);

    const report = await runCycle(deps, '2026-09-25');

    expect(alpaca.brackets.map((bracket) => bracket.client_order_id)).toEqual([
      'v2-debate-primary-2026-09-25-AAPL',
    ]);
    expect(orders(deps, 'trend/primary')).toEqual([]);
    expect(orders(deps, 'trend/no-macro-gate')).toMatchObject([{ outcome: 'simulated' }]);
    expect(report.refusals).toContain(
      'trend/primary AAPL: held or resting in debate/primary at alpaca',
    );
  });

  it('refuses it while the other primary holds the position', async () => {
    const alpaca = new FakeAlpaca();
    const deps = twoPrimaries(false, alpaca);
    await runCycle(deps, '2026-09-25');
    alpaca.fill('v2-debate-primary-2026-09-25-AAPL', 'entry', 6, 20);

    await runCycle(deps, '2026-09-28');

    expect(deps.books.position('debate/primary', 'AAPL')).toBeDefined();
    expect(orders(deps, 'trend/primary')).toEqual([]);
    const db = (
      deps.journal as unknown as { db: { prepare: (s: string) => { all: () => unknown[] } } }
    ).db;
    expect(
      db
        .prepare(
          "SELECT trading_date, scope, ticket, book_id, instrument FROM v2_refusals WHERE parameter = 'symbol_held_by_broker_book'",
        )
        .all(),
    ).toEqual([
      {
        trading_date: '2026-09-25',
        scope: 'entry',
        ticket: '#1941',
        book_id: 'trend/primary',
        instrument: 'AAPL',
      },
      {
        trading_date: '2026-09-28',
        scope: 'entry',
        ticket: '#1941',
        book_id: 'trend/primary',
        instrument: 'AAPL',
      },
    ]);
  });

  it('lets another primary enter a different symbol', async () => {
    const alpaca = new FakeAlpaca();
    const deps = twoPrimaries(false, alpaca, 'MSFT');

    await runCycle(deps, '2026-09-25');

    expect(alpaca.brackets.map((bracket) => bracket.client_order_id)).toEqual([
      'v2-debate-primary-2026-09-25-AAPL',
      'v2-trend-primary-2026-09-25-MSFT',
    ]);
  });

  it('lets both primaries enter in a dry run, where no book reaches the broker', async () => {
    const deps = twoPrimaries(true);

    await runCycle(deps, '2026-09-25');

    expect(orders(deps, 'debate/primary')).toHaveLength(1);
    expect(orders(deps, 'trend/primary')).toHaveLength(1);
  });
});

describe('#1785: gross-cash gate on entries and signal-driven exits', () => {
  // TEST_SPEC/£1,000 equity: each longAapl-shaped decision sizes to min(byRisk, byNotional)
  // = min(floor(5/(0.32*2))=7, floor(100/16)=6) = 6 shares at £20/1.25 = £16/share = £96
  // notional (matches the file's existing ENTRY_COST_GBP). 10 fit (£960 of £1,000); the 11th
  // has only £40 left and needs £96
  const instruments = Array.from({ length: 11 }, (_, index) => `SYM${index}`);
  const decisions: SleeveDecision[] = instruments.map((instrument) => ({
    ...longAapl,
    instrument,
  }));

  it('funds entries in list order and refuses the one that runs out of cash', async () => {
    const deps = harness(decisions, true);
    await runCycle(deps, '2026-09-25');
    for (const instrument of instruments.slice(0, 10)) {
      expect(deps.journal.orderFor(`v2-debate-primary-2026-09-25-${instrument}`)?.outcome).toBe(
        'refused_dry_run',
      );
    }
    const last = deps.journal.orderFor('v2-debate-primary-2026-09-25-SYM10');
    expect(last?.outcome).toBe('rejected');
    expect(last?.payload.detail).toBe('insufficient_cash');
  });

  it('never double-counts a held line: re-issuing enter_long for it costs no fresh cash', async () => {
    // Hold 5 lines first (£480 of £1,000 spent, ~£520 real cash left): if a held line's
    // re-issued enter_long were charged again, 5 * £96 = £480 would be deducted a second time
    // and leave ~£40, wrongly refusing the 6th, genuinely new line (needs £96)
    const deps = harness(decisions.slice(0, 5), true);
    await runCycle(deps, '2026-09-25');
    deps.setDecisions([]);
    await runCycle(deps, '2026-09-28');
    for (const instrument of instruments.slice(0, 5)) {
      expect(deps.books.position('debate/primary', instrument)).toBeDefined();
    }
    deps.setDecisions([...decisions.slice(0, 5), decisions[5] as SleeveDecision]);
    await runCycle(deps, '2026-09-29');
    expect(deps.journal.orderFor('v2-debate-primary-2026-09-29-SYM5')?.outcome).toBe(
      'refused_dry_run',
    );
    const sym5 = deps.journal.orderFor('v2-debate-primary-2026-09-29-SYM5');
    expect(sym5?.payload.detail).not.toBe('insufficient_cash');
  });

  it('a signal-driven exit rests, then flattens a held position once it resolves', async () => {
    const deps = harness([longAapl], true);
    await runCycle(deps, '2026-09-25');
    deps.setDecisions([]);
    await runCycle(deps, '2026-09-28');
    expect(deps.books.position('debate/primary', 'AAPL')).toBeDefined();
    deps.setDecisions([{ ...longAapl, action: 'exit' }]);
    await runCycle(deps, '2026-09-29');
    expect(deps.journal.orderFor('v2-debate-primary-2026-09-29-AAPL-exit')).toMatchObject({
      outcome: 'refused_dry_run',
      payload: { reason: 'signal_exit' },
    });
    expect(deps.books.position('debate/primary', 'AAPL')?.exitClientOrderId).toBe(
      'v2-debate-primary-2026-09-29-AAPL-exit',
    );
    deps.barsByDate.set('2026-09-30', bar('2026-09-29', { open: 19, low: 18.9, high: 19.4 }));
    const filled = await runCycle(deps, '2026-09-30');
    expect(filled.fills).toBeGreaterThan(0);
    expect(deps.books.position('debate/primary', 'AAPL')).toBeUndefined();
  });

  it('a signal-driven exit is a no-op with nothing held', async () => {
    const deps = harness([{ ...longAapl, action: 'exit' }], true);
    const report = await runCycle(deps, '2026-09-25');
    expect(deps.journal.orderFor('v2-debate-primary-2026-09-25-AAPL-exit')).toBeUndefined();
    expect(report.exits).toBe(0);
  });

  it('a signal-driven exit is a no-op once one is already resting', async () => {
    const deps = harness([longAapl], true);
    await runCycle(deps, '2026-09-25');
    deps.setDecisions([]);
    await runCycle(deps, '2026-09-28');
    deps.books.setExitPending('debate/primary', 'AAPL', 'stub-exit-already-resting');
    deps.setDecisions([{ ...longAapl, action: 'exit' }]);
    await runCycle(deps, '2026-09-29');
    expect(deps.journal.orderFor('v2-debate-primary-2026-09-29-AAPL-exit')).toBeUndefined();
    expect(deps.books.position('debate/primary', 'AAPL')?.exitClientOrderId).toBe(
      'stub-exit-already-resting',
    );
  });

  it('a signal-driven exit does not submit on a route the executor cannot reach', async () => {
    const deps = harness([longAapl], true);
    await runCycle(deps, '2026-09-25');
    deps.setDecisions([]);
    await runCycle(deps, '2026-09-28');
    vi.spyOn(deps.executor, 'canRoute').mockReturnValue(false);
    deps.setDecisions([{ ...longAapl, action: 'exit' }]);
    await runCycle(deps, '2026-09-29');
    expect(deps.journal.orderFor('v2-debate-primary-2026-09-29-AAPL-exit')).toBeUndefined();
    const held = deps.books.position('debate/primary', 'AAPL');
    expect(held).toBeDefined();
    expect(held?.exitClientOrderId).toBeUndefined();
  });

  it("counts a resting order's own notional against cash before sizing the next entry", async () => {
    // THIN's barsBefore is [] in this harness (see market.barsBefore above), so
    // fillSimulatedEntries sees simulateLimitEntry's bars.length === 0 case and leaves the order
    // genuinely pending rather than filling or cancelling it — the only way, in this fixture, to
    // carry a resting order's notional across a cycle boundary and into restingNotionalGbp
    const deps = harness([], true);
    const decisionId = deps.journal.recordDecision(
      'debate/primary',
      '2026-09-25',
      { ...longAapl, instrument: 'THIN' },
      6,
    );
    deps.journal.recordOrder({
      client_order_id: 'v2-debate-primary-2026-09-25-THIN',
      decision_id: decisionId,
      book_id: 'debate/primary',
      trading_date: '2026-09-25',
      instrument: 'THIN',
      venue: 'alpaca',
      leg: 'entry',
      side: 'buy',
      dry_run: true,
      outcome: 'refused_dry_run',
      payload: { size: 6, price: 20 },
    });
    const news = Array.from({ length: 10 }, (_, index) => ({
      ...longAapl,
      instrument: `NEW${index}`,
    }));
    deps.setDecisions(news);
    await runCycle(deps, '2026-09-28');
    // The resting THIN order's £96 notional leaves £904 of £1,000; 9 of the 10 new £96 entries
    // fit (£864), the 10th needs £960 — distinguishes the correct subtraction from ignoring,
    // inverting or mis-scaling the resting notional (any of those admits a 10th or refuses a 9th)
    for (const { instrument } of news.slice(0, 9)) {
      expect(deps.journal.orderFor(`v2-debate-primary-2026-09-28-${instrument}`)?.outcome).toBe(
        'refused_dry_run',
      );
    }
    const last = deps.journal.orderFor('v2-debate-primary-2026-09-28-NEW9');
    expect(last?.outcome).toBe('rejected');
    expect(last?.payload.detail).toBe('insufficient_cash');
  });

  it('does not reserve cash for an entry the broker genuinely rejects, so later entries in the same cycle still fund (doc 66 2026-09-28, #1785)', async () => {
    const deps = harness(decisions, true);
    const realSubmit = deps.executor.submit.bind(deps.executor);
    vi.spyOn(deps.executor, 'submit').mockImplementation((order) =>
      order.instrument === 'SYM0'
        ? Promise.resolve({
            outcome: 'rejected',
            detail: 'stub_broker_rejection',
            approvalId: order.approvalId,
          })
        : realSubmit(order),
    );
    await runCycle(deps, '2026-09-25');
    expect(deps.journal.orderFor('v2-debate-primary-2026-09-25-SYM0')?.outcome).toBe('rejected');
    // SYM0 was approved (sized, cash-gated) but the broker rejected it, so its £96 must never be
    // charged: the real £1,000 still funds all 10 remaining entries (£960). Charging it anyway
    // (the pre-fix bug) leaves £904, which fits only 9 and wrongly refuses SYM10 as insufficient_cash
    for (const instrument of instruments.slice(1)) {
      expect(deps.journal.orderFor(`v2-debate-primary-2026-09-25-${instrument}`)?.outcome).toBe(
        'refused_dry_run',
      );
    }
  });
});

describe('#1849: book gross notional cap', () => {
  const names = Array.from({ length: 10 }, (_, index) => `SHRT${index}`);
  const held = names.map((instrument) => ({ ...shortAapl, instrument }));

  it('refuses any entry that would push gross past 1x equity even though short proceeds left cash to spare', async () => {
    const deps = harness(held, true);
    await runCycle(deps, '2026-09-25');
    deps.setDecisions([]);
    await runCycle(deps, '2026-09-28');
    for (const instrument of names) {
      expect(deps.books.position('debate/primary', instrument)?.qty).toBe(-6);
    }
    expect(deps.books.cash('debate/primary')).toBeGreaterThan(1_500);

    deps.setDecisions([
      { ...shortAapl, instrument: 'ONEMORE' },
      { ...longAapl, instrument: 'LONGMORE' },
    ]);
    await runCycle(deps, '2026-09-29');
    for (const instrument of ['ONEMORE', 'LONGMORE']) {
      const order = deps.journal.orderFor(`v2-debate-primary-2026-09-29-${instrument}`);
      expect(order?.outcome).toBe('rejected');
      expect(order?.payload.detail).toBe('gross_cap');
    }
  });

  it('journals a gross_cap refusal against the BOOK_GROSS_NOTIONAL_CAP parameter', async () => {
    const deps = harness(held, true);
    await runCycle(deps, '2026-09-25');
    deps.setDecisions([]);
    await runCycle(deps, '2026-09-28');
    deps.setDecisions([{ ...shortAapl, instrument: 'ONEMORE' }]);
    await runCycle(deps, '2026-09-29');
    const db = (
      deps.journal as unknown as { db: { prepare: (s: string) => { all: () => unknown[] } } }
    ).db;
    expect(
      db
        .prepare(
          "SELECT book_id, instrument FROM v2_refusals WHERE parameter = 'BOOK_GROSS_NOTIONAL_CAP' ORDER BY book_id",
        )
        .all(),
    ).toContainEqual({ book_id: 'debate/primary', instrument: 'ONEMORE' });
  });
});

describe('#1849: CFD short venue path', () => {
  it('fills a CFD short on the simulated broker in paper mode and never touches Alpaca', async () => {
    const alpaca = new FakeAlpaca();
    const deps = harness([shortAapl], false, alpaca);
    await runCycle(deps, '2026-09-25');
    expect(alpaca.brackets).toHaveLength(0);
    expect(deps.journal.orderFor('v2-debate-primary-2026-09-25-AAPL')).toMatchObject({
      venue: 'saxo_cfd_usd',
      side: 'sell',
    });
    deps.setDecisions([]);
    await runCycle(deps, '2026-09-28');
    expect(deps.books.position('debate/primary', 'AAPL')).toMatchObject({
      venue: 'saxo_cfd_usd',
      qty: -6,
    });
    expect(alpaca.brackets).toHaveLength(0);
  });

  it('holds an Alpaca long and a CFD short together, each in its own venue', async () => {
    const alpaca = new FakeAlpaca();
    const deps = harness([longAapl, { ...shortAapl, instrument: 'SHRT' }], false, alpaca);
    await runCycle(deps, '2026-09-25');
    expect(alpaca.brackets.map((request) => request.instrument)).toEqual(['AAPL']);
    deps.setDecisions([]);
    await runCycle(deps, '2026-09-28');
    expect(deps.books.position('debate/primary', 'SHRT')).toMatchObject({
      venue: 'saxo_cfd_usd',
      qty: -6,
    });
    expect(deps.journal.orderFor('v2-debate-primary-2026-09-25-AAPL')).toMatchObject({
      venue: 'alpaca',
      side: 'buy',
    });
    expect(deps.journal.orderFor('v2-debate-primary-2026-09-25-SHRT')).toMatchObject({
      venue: 'saxo_cfd_usd',
      side: 'sell',
    });
  });

  it('exits a CFD short on the venue it was opened on', async () => {
    const deps = harness([shortAapl], true);
    await runCycle(deps, '2026-09-25');
    deps.setDecisions([]);
    await runCycle(deps, '2026-09-28');
    deps.setDecisions([{ ...shortAapl, action: 'exit' }]);
    await runCycle(deps, '2026-09-29');
    expect(deps.journal.orderFor('v2-debate-primary-2026-09-29-AAPL-exit')).toMatchObject({
      venue: 'saxo_cfd_usd',
      side: 'buy',
    });
  });
});

describe('#1849: a CFD fill with no cost model', () => {
  const cfdShort: SleeveDecision = { ...shortAapl, instrument: 'SHRT' };
  const unsetOnCfd = (state: { unset: boolean }): FillPricing => ({
    halfSpreadBps: () => HALF_SPREAD_BPS,
    impactBps: () => 0,
    fee: (venue) => {
      if (state.unset && venue.startsWith('saxo_cfd')) throw new CfdCostModelUnsetError();
      return 0;
    },
  });
  const refusalRows = (deps: Harness) =>
    (deps.journal as unknown as { db: { prepare: (s: string) => { all: () => unknown[] } } }).db
      .prepare(
        "SELECT book_id, instrument, scope FROM v2_refusals WHERE parameter = 'CFD_COST_MODEL' AND scope = 'fill'",
      )
      .all();

  it('leaves the CFD entry unfilled and journals it while the Alpaca-venue book fills and marks', async () => {
    const deps = harness(
      [longAapl, cfdShort],
      true,
      undefined,
      [2026],
      TEST_SPEC,
      unsetOnCfd({ unset: true }),
    );
    await runCycle(deps, '2026-09-25');
    deps.setDecisions([]);
    const report = await runCycle(deps, '2026-09-28');
    expect(deps.books.position('debate/primary', 'AAPL')).toMatchObject({ qty: 6 });
    expect(deps.books.position('debate/primary', 'SHRT')).toBeUndefined();
    expect(deps.books.lastDay('debate/primary')?.tradingDate).toBe('2026-09-28');
    expect(refusalRows(deps)).toContainEqual({
      book_id: 'debate/primary',
      instrument: 'SHRT',
      scope: 'fill',
    });
    expect(report.refusals.some((message) => message.includes('SHRT'))).toBe(true);
  });

  it('fills the CFD entry on a later cycle once the model exists', async () => {
    const state = { unset: true };
    const deps = harness([cfdShort], true, undefined, [2026], TEST_SPEC, unsetOnCfd(state));
    await runCycle(deps, '2026-09-25');
    deps.setDecisions([]);
    await runCycle(deps, '2026-09-28');
    expect(deps.books.position('debate/primary', 'SHRT')).toBeUndefined();
    state.unset = false;
    await runCycle(deps, '2026-09-29');
    expect(deps.books.position('debate/primary', 'SHRT')).toMatchObject({ qty: -6 });
  });

  it('leaves an open CFD short open and flagged when its stop fires, while the long still exits', async () => {
    const state = { unset: false };
    const deps = harness(
      [longAapl, cfdShort],
      true,
      undefined,
      [2026],
      TEST_SPEC,
      unsetOnCfd(state),
    );
    await openBooks(deps);
    expect(deps.books.position('debate/primary', 'SHRT')).toMatchObject({ qty: -6 });
    state.unset = true;
    deps.barsByDate.set('2026-09-28', bar('2026-09-25', { low: 19.0, high: 21 }));
    const report = await runCycle(deps, '2026-09-28');
    expect(deps.books.position('debate/primary', 'AAPL')).toBeUndefined();
    expect(deps.books.position('debate/primary', 'SHRT')).toMatchObject({ qty: -6 });
    expect(deps.journal.orderFor('v2-debate-primary-2026-09-28-SHRT-exit')).toBeUndefined();
    expect(refusalRows(deps)).toContainEqual({
      book_id: 'debate/primary',
      instrument: 'SHRT',
      scope: 'fill',
    });
    expect(report.refusals.some((message) => message.includes('SHRT'))).toBe(true);
    state.unset = false;
    deps.barsByDate.set('2026-09-29', bar('2026-09-28', { low: 19.0, high: 21 }));
    await runCycle(deps, '2026-09-29');
    expect(deps.books.position('debate/primary', 'SHRT')).toBeUndefined();
  });

  it('rethrows any other error from a fill quote', async () => {
    const boom: FillPricing = {
      halfSpreadBps: () => 0,
      impactBps: () => 0,
      fee: () => {
        throw new Error('boom');
      },
    };
    const deps = harness([longAapl], true, undefined, [2026], TEST_SPEC, boom);
    await runCycle(deps, '2026-09-25');
    deps.setDecisions([]);
    await expect(runCycle(deps, '2026-09-28')).rejects.toThrow('boom');
  });
});

describe('runCycle: positions held across a split (#1865)', () => {
  interface RawBar {
    readonly open: number;
    readonly high: number;
    readonly low: number;
    readonly close: number;
  }
  const PRE: RawBar = { open: 20, high: 20.5, low: 19.5, close: 20 };
  const TEN_TO_ONE: RawBar = { open: 2, high: 2.05, low: 1.95, close: 2 };
  const TWO_TO_ONE: RawBar = { open: 1, high: 1.02, low: 0.98, close: 1 };
  const THREE_FOR_TWO: RawBar = { open: 13.4, high: 13.7, low: 13, close: 40 / 3 };

  function seriesBar(date: string, raw: RawBar, factor: number): DailyBar {
    return {
      date,
      open: raw.open / factor,
      high: raw.high / factor,
      low: raw.low / factor,
      close: raw.close / factor,
      volume: 1_000_000,
      rawClose: raw.close,
    };
  }

  function seriesMarket(bars: readonly DailyBar[]): MarketData {
    return {
      lastBarBefore: (_instrument, tradingDate) =>
        bars.filter((dated) => dated.date < tradingDate).at(-1),
      barsBefore: (_instrument, tradingDate, count) =>
        bars.filter((dated) => dated.date < tradingDate).slice(-count),
      gbpUsdAtYearStart: () => FX,
    };
  }

  function withMarket(deps: Harness, bars: readonly DailyBar[]): CycleDeps {
    return { ...deps, market: seriesMarket(bars) };
  }

  const preSplit = (factor: number) => [
    seriesBar('2026-09-23', PRE, factor),
    seriesBar('2026-09-24', PRE, factor),
    seriesBar('2026-09-25', PRE, factor),
  ];

  const snapshot = [
    ...preSplit(10),
    seriesBar('2026-09-28', TEN_TO_ONE, 1),
    seriesBar('2026-09-29', TEN_TO_ONE, 1),
    seriesBar('2026-09-30', TEN_TO_ONE, 1),
  ];

  function hold(deps: Harness, qty: number, tradingDate = '2026-09-25', scale = 1): void {
    const long = qty > 0;
    deps.books.applyFill('debate/primary', {
      instrument: 'AAPL',
      venue: 'alpaca',
      side: long ? 'buy' : 'sell',
      leg: 'entry',
      qty: Math.abs(qty),
      priceGbp: (20 * scale) / FX,
      feeGbp: 0,
      clientOrderId: 'seed',
      tradingDate,
      stopGbp: ((long ? 19.2 : 20.8) * scale) / FX,
      targetGbp: ((long ? 21.2 : 18.8) * scale) / FX,
    });
  }

  function primary(deps: CycleDeps) {
    return deps.books.position('debate/primary', 'AAPL');
  }

  it('a 10:1 split does not stop the position out, rescales it, and keeps marked equity continuous', async () => {
    const deps = harness([], true);
    hold(deps, 6);
    const before = await runCycle(withMarket(deps, snapshot), '2026-09-28');
    expect(primary(deps)).toMatchObject({ qty: 6, splitFactor: 1 });
    const across = await runCycle(withMarket(deps, snapshot), '2026-09-29');
    expect(across.exits).toBe(0);
    expect(primary(deps)).toMatchObject({
      qty: 60,
      avgPriceGbp: expect.closeTo(2 / FX, 9),
      stopGbp: expect.closeTo(1.92 / FX, 9),
      targetGbp: expect.closeTo(2.12 / FX, 9),
      splitFactor: 10,
      splitAnchorDate: '2026-09-28',
    });
    expect(across.books[0]?.equity_gbp).toBeCloseTo(before.books[0]?.equity_gbp ?? 0, 9);
    expect(across.books[0]).toMatchObject({ size_multiplier: 1 });
    expect(deps.books.lastDay('debate/primary')?.state.halted).toBe(false);
    expect(deps.books.cash('debate/primary')).toBeCloseTo(1_000 - (6 * 20) / FX, 9);
  });

  it('still catches a real stop after the split on the rescaled level', async () => {
    const deps = harness([], true);
    hold(deps, 6);
    await runCycle(withMarket(deps, snapshot), '2026-09-28');
    const breach = seriesBar('2026-09-29', { ...TEN_TO_ONE, low: 1.9 }, 1);
    const bars = [...snapshot.slice(0, 4), breach];
    const report = await runCycle(withMarket(deps, bars), '2026-09-30');
    expect(report.exits).toBe(1);
    expect(deps.journal.orderFor('v2-debate-primary-2026-09-30-AAPL-exit')).toMatchObject({
      payload: { size: 60, detail: 'bracket_leg_on_daily_bar', price: expect.closeTo(1.92, 9) },
    });
    expect(primary(deps)).toBeUndefined();
  });

  const GAP_THROUGH_STOP: RawBar = { open: 1.8, high: 1.85, low: 1.75, close: 1.8 };

  it('a held position across a split whose next open gaps through the rescaled stop exits at the gap open on the rescaled qty, with no phantom loss', async () => {
    const deps = harness([], true);
    hold(deps, 6);
    const bars = [...snapshot.slice(0, 4), seriesBar('2026-09-29', GAP_THROUGH_STOP, 1)];
    await runCycle(withMarket(deps, bars), '2026-09-28');
    const splitDay = await runCycle(withMarket(deps, bars), '2026-09-29');
    expect(splitDay.exits).toBe(0);
    expect(primary(deps)).toMatchObject({
      qty: 60,
      stopGbp: expect.closeTo(1.92 / FX, 9),
      splitFactor: 10,
    });
    const gapDay = await runCycle(withMarket(deps, bars), '2026-09-30');
    expect(gapDay.exits).toBe(1);
    expect(deps.journal.orderFor('v2-debate-primary-2026-09-30-AAPL-exit')).toMatchObject({
      payload: { size: 60, price: expect.closeTo(1.8, 9) },
    });
    expect(primary(deps)).toBeUndefined();
    const proceedsGbp = (60 * 1.8 * (1 - HALF_SPREAD_BPS / 10_000)) / FX;
    expect(deps.books.cash('debate/primary')).toBeCloseTo(1_000 - (6 * 20) / FX + proceedsGbp, 9);
    expect(deps.books.lastDay('debate/primary')?.state.halted).toBe(false);
  });

  it('a simulated entry filled before a split and gapped through after it exits on the rescaled qty at the gap open', async () => {
    const deps = harness([longAapl], true);
    await runCycle(deps, '2026-09-25');
    deps.setDecisions([]);
    const bars = [
      seriesBar('2026-09-25', PRE, 10),
      seriesBar('2026-09-28', TEN_TO_ONE, 1),
      seriesBar('2026-09-29', TEN_TO_ONE, 1),
      seriesBar('2026-09-30', GAP_THROUGH_STOP, 1),
    ];
    await runCycle(withMarket(deps, bars), '2026-09-30');
    const filledQty = primary(deps)?.qty ?? 0;
    expect(filledQty).toBeGreaterThan(0);
    const report = await runCycle(withMarket(deps, bars), '2026-10-01');
    expect(report.exits).toBe(2);
    expect(deps.journal.orderFor('v2-debate-primary-2026-10-01-AAPL-exit')).toMatchObject({
      payload: { size: expect.closeTo(filledQty * 10, 9), price: expect.closeTo(1.8, 9) },
    });
    expect(primary(deps)).toBeUndefined();
  });

  it('detects a split when the latest bar is always factor 1 because history is re-adjusted on refresh', async () => {
    const deps = harness([], true);
    hold(deps, 6);
    await runCycle(withMarket(deps, preSplit(1)), '2026-09-28');
    expect(primary(deps)).toMatchObject({ qty: 6, splitFactor: 1 });
    const across = await runCycle(withMarket(deps, snapshot), '2026-09-29');
    expect(across.exits).toBe(0);
    expect(primary(deps)).toMatchObject({ qty: 60, splitFactor: 10 });
  });

  it('detects a split across skipped cycles and does not apply it twice', async () => {
    const deps = harness([], true);
    hold(deps, 6);
    await runCycle(withMarket(deps, snapshot), '2026-09-28');
    const late = await runCycle(withMarket(deps, snapshot), '2026-09-30');
    expect(late.exits).toBe(0);
    expect(primary(deps)).toMatchObject({ qty: 60, splitFactor: 10 });
    await runCycle(withMarket(deps, snapshot), '2026-10-01');
    await runCycle(withMarket(deps, snapshot), '2026-10-02');
    expect(primary(deps)).toMatchObject({ qty: 60, splitFactor: 10 });
  });

  it('a price crash that leaves the adjustment factor unchanged is a real move: no rescale, the stop fires at the crash open', async () => {
    const deps = harness([], true);
    hold(deps, 6);
    const crash = [...preSplit(1), seriesBar('2026-09-28', TEN_TO_ONE, 1)];
    const report = await runCycle(withMarket(deps, crash), '2026-09-29');
    expect(report.exits).toBe(1);
    expect(deps.journal.orderFor('v2-debate-primary-2026-09-29-AAPL-exit')).toMatchObject({
      payload: { size: 6, price: expect.closeTo(2, 9) },
    });
    expect(primary(deps)).toBeUndefined();
  });

  it('does not rescale a position opened after the split day', async () => {
    const deps = harness([], true);
    hold(deps, 6, '2026-09-30', 0.1);
    const report = await runCycle(withMarket(deps, snapshot), '2026-10-05');
    expect(report.exits).toBe(0);
    expect(primary(deps)).toMatchObject({ qty: 6, splitFactor: 1, splitAnchorDate: undefined });
  });

  it('does not rescale for dividend-sized factor steps', async () => {
    const deps = harness([], true);
    hold(deps, 6);
    const dividend = [
      seriesBar('2026-09-24', PRE, 1.004),
      seriesBar('2026-09-25', PRE, 1.004),
      seriesBar('2026-09-28', PRE, 1.11),
      seriesBar('2026-09-29', PRE, 1),
    ];
    await runCycle(withMarket(deps, dividend), '2026-09-30');
    expect(primary(deps)).toMatchObject({ qty: 6, splitFactor: 1 });
  });

  it('a short is rescaled the same way and its bracket stays intact', async () => {
    const deps = harness([], true);
    hold(deps, -6);
    await runCycle(withMarket(deps, snapshot), '2026-09-28');
    const across = await runCycle(withMarket(deps, snapshot), '2026-09-29');
    expect(across.exits).toBe(0);
    expect(primary(deps)).toMatchObject({
      qty: -60,
      stopGbp: expect.closeTo(2.08 / FX, 9),
      targetGbp: expect.closeTo(1.88 / FX, 9),
      splitFactor: 10,
    });
    expect(across.books[0]?.equity_gbp).toBeCloseTo(1_000, 9);
  });

  it('a 3:2 split leaves a fractional qty and keeps qty x price and equity', async () => {
    const deps = harness([], true);
    hold(deps, 3);
    const bars = [
      ...preSplit(1.5),
      seriesBar('2026-09-28', THREE_FOR_TWO, 1),
      seriesBar('2026-09-29', THREE_FOR_TWO, 1),
    ];
    await runCycle(withMarket(deps, bars), '2026-09-28');
    const across = await runCycle(withMarket(deps, bars), '2026-09-29');
    expect(across.exits).toBe(0);
    const held = primary(deps);
    expect(held?.qty).toBeCloseTo(4.5, 12);
    expect(held?.avgPriceGbp).toBeCloseTo(20 / 1.5 / FX, 9);
    expect(held?.stopGbp).toBeCloseTo(19.2 / 1.5 / FX, 9);
    expect(across.books[0]?.equity_gbp).toBeCloseTo(1_000, 9);
  });

  it('measures a second split from the anchor the first one left', async () => {
    const deps = harness([], true);
    hold(deps, 6);
    const bars = [
      ...preSplit(20),
      seriesBar('2026-09-28', TEN_TO_ONE, 2),
      seriesBar('2026-09-29', TEN_TO_ONE, 2),
      seriesBar('2026-09-30', TWO_TO_ONE, 1),
    ];
    await runCycle(withMarket(deps, bars), '2026-09-28');
    await runCycle(withMarket(deps, bars), '2026-09-29');
    expect(primary(deps)).toMatchObject({
      qty: 60,
      splitFactor: 10,
      splitAnchorDate: '2026-09-28',
    });
    await runCycle(withMarket(deps, bars), '2026-09-30');
    expect(primary(deps)).toMatchObject({ qty: 60, splitFactor: 10 });
    const second = await runCycle(withMarket(deps, bars), '2026-10-01');
    expect(second.exits).toBe(0);
    expect(primary(deps)).toMatchObject({
      qty: 120,
      stopGbp: expect.closeTo(0.96 / FX, 9),
      splitFactor: 20,
      splitAnchorDate: '2026-09-30',
    });
  });

  it('leaves a position alone when no bar exists to measure it against', async () => {
    const deps = harness([], true);
    hold(deps, 6);
    await runCycle(withMarket(deps, []), '2026-09-29');
    expect(primary(deps)).toMatchObject({ qty: 6, splitFactor: 1 });
    await runCycle(withMarket(deps, [seriesBar('2026-09-25', PRE, 10)]), '2026-09-30');
    expect(primary(deps)).toMatchObject({ qty: 6, splitFactor: 1 });
  });

  it('reads the split off the real bars-backed market, weekend gap included', async () => {
    const deps = harness([], true);
    hold(deps, 6, '2026-09-25');
    const weekend = [
      seriesBar('2026-09-24', PRE, 10),
      seriesBar('2026-09-25', PRE, 10),
      seriesBar('2026-09-28', TEN_TO_ONE, 1),
    ];
    const real = new BarsMarketData({ load: () => ({ symbol: 'AAPL', bars: weekend }) }, []);
    const market: MarketData = {
      lastBarBefore: (instrument, date) => real.lastBarBefore(instrument, date),
      barsBefore: (instrument, date, count) => real.barsBefore(instrument, date, count),
      gbpUsdAtYearStart: () => FX,
    };
    const report = await runCycle({ ...deps, market }, '2026-09-29');
    expect(report.exits).toBe(0);
    expect(primary(deps)).toMatchObject({ qty: 60, splitFactor: 10 });
  });

  it('rescales before a pending simulated flatten fills, so the flatten sells the post-split qty', async () => {
    const deps = harness([], true);
    hold(deps, 6);
    deps.setControl('halt');
    await runCycle(withMarket(deps, snapshot), '2026-09-28');
    expect(primary(deps)).toMatchObject({
      qty: 6,
      exitClientOrderId: 'v2-debate-primary-2026-09-28-AAPL-exit',
    });
    await runCycle(withMarket(deps, snapshot), '2026-09-29');
    expect(exitFill(deps, 'v2-debate-primary-2026-09-28-AAPL-exit')).toMatchObject({
      side: 'sell',
      qty: 60,
    });
    expect(primary(deps)).toBeUndefined();
    const proceeds = (60 * 2 * (1 - HALF_SPREAD_BPS / 10_000)) / FX;
    expect(deps.books.cash('debate/primary')).toBeCloseTo(1_000 - (6 * 20) / FX + proceeds, 9);
  });

  function loggedDeps(deps: Harness): { deps: Harness; entries: LogEntry[] } {
    const entries: LogEntry[] = [];
    return {
      deps: { ...deps, logger: { log: (entry: LogEntry) => entries.push(entry) } },
      entries,
    };
  }

  const eventsOf = (entries: readonly LogEntry[], event: string) =>
    entries.filter((entry) => entry.event === event);

  const RAW_FLAT: RawBar = { open: 20.4, high: 20.9, low: 20.1, close: 20.5 };

  it('does not rescale on a CNX-shaped adjusted-only step: adjusted close jumps 7.8x, raw moves 1.03x', async () => {
    const { deps, entries } = loggedDeps(harness([], true));
    hold(deps, 6);
    const restated = [
      ...preSplit(0.125),
      seriesBar('2026-09-28', RAW_FLAT, 1),
      seriesBar('2026-09-29', RAW_FLAT, 1),
    ];
    const report = await runCycle(withMarket(deps, restated), '2026-09-30');
    expect(report.exits).toBe(0);
    expect(primary(deps)).toMatchObject({ qty: 6, splitFactor: 1, splitAnchorDate: undefined });
    expect(report.books[0]?.equity_gbp).toBeGreaterThan(1_000);
    expect(eventsOf(entries, 'v2_split_rescaled')).toEqual([]);
    expect(eventsOf(entries, 'v2_split_implausible')).toMatchObject([
      { level: 'warn', message: expect.stringContaining('debate/primary AAPL') },
    ]);
  });

  it('does not rescale on a glitched adjusted close on the latest bar', async () => {
    const { deps, entries } = loggedDeps(harness([], true));
    hold(deps, 6);
    const glitched = [...preSplit(1), seriesBar('2026-09-28', PRE, 5)];
    await runCycle(withMarket(deps, glitched), '2026-09-29');
    expect(primary(deps)).toMatchObject({ qty: 6, splitFactor: 1 });
    expect(eventsOf(entries, 'v2_split_implausible')).toHaveLength(1);
  });

  it('still rescales a CHK-shaped 1:200 reverse split on a day the adjusted close also gapped 1.6x', async () => {
    const { deps, entries } = loggedDeps(harness([], true));
    hold(deps, 6);
    const afterSplit: RawBar = { open: 6400, high: 6450, low: 6350, close: 6400 };
    const reverse = [
      ...preSplit(0.005),
      seriesBar('2026-09-28', afterSplit, 1),
      seriesBar('2026-09-29', afterSplit, 1),
    ];
    await runCycle(withMarket(deps, reverse), '2026-09-30');
    expect(eventsOf(entries, 'v2_split_implausible')).toEqual([]);
    expect(eventsOf(entries, 'v2_split_rescaled')).toMatchObject([
      { message: expect.stringContaining('qty 6 -> 0.03') },
    ]);
  });

  it('anchors a simulated entry at its fill bar, so a split between the fill bar and the ingest cycle is rescaled', async () => {
    const deps = harness([longAapl], true);
    await runCycle(deps, '2026-09-25');
    deps.setDecisions([]);
    const bars = [
      seriesBar('2026-09-25', PRE, 10),
      seriesBar('2026-09-28', TEN_TO_ONE, 1),
      seriesBar('2026-09-29', TEN_TO_ONE, 1),
    ];
    await runCycle(withMarket(deps, bars), '2026-09-30');
    expect(primary(deps)).toMatchObject({ splitFactor: 1, splitAnchorDate: '2026-09-25' });
    const filledQty = primary(deps)?.qty ?? 0;
    await runCycle(withMarket(deps, bars), '2026-10-01');
    expect(primary(deps)).toMatchObject({
      qty: expect.closeTo(filledQty * 10, 9),
      splitFactor: 10,
      splitAnchorDate: '2026-09-29',
    });
  });

  it('a simulated entry filling into an already-held position leaves its split anchor untouched', async () => {
    const deps = harness([longAapl], true);
    await runCycle(deps, '2026-09-25');
    deps.setDecisions([]);
    hold(deps, 6, '2026-09-24');
    deps.books.applySplit('debate/primary', 'AAPL', 1, '2026-09-24');
    const report = await runCycle(deps, '2026-09-28');
    expect(report.fills).toBeGreaterThanOrEqual(1);
    expect(primary(deps)?.qty).toBeGreaterThan(6);
    expect(primary(deps)).toMatchObject({ splitFactor: 1, splitAnchorDate: '2026-09-24' });
  });

  it('logs each rescale', async () => {
    const entries: LogEntry[] = [];
    const deps = {
      ...harness([], true),
      logger: { log: (entry: LogEntry) => entries.push(entry) },
    };
    hold(deps, 6);
    await runCycle(withMarket(deps, snapshot), '2026-09-29');
    expect(entries.filter((entry) => entry.event === 'v2_split_rescaled')).toMatchObject([
      { level: 'info', message: 'debate/primary AAPL: qty 6 -> 60, levels / 10' },
    ]);
  });

  class SplitAlpaca extends FakeAlpaca {
    readonly rearms: { qty: number; stop: number; target: number }[] = [];
    resumeResult: NormalizedOrder | null = null;

    submitProtectedExit(request: ProtectedExitRequest): Promise<BrokerAck> {
      return Promise.resolve({
        client_order_id: request.clientOrderId,
        broker_order_ids: ['pf1'],
        order_state: 'submitted',
      });
    }

    override resumeFlatten(): Promise<NormalizedOrder | null> {
      return Promise.resolve(this.resumeResult);
    }

    override rearmProtectiveLegs(
      _clientOrderId?: string,
      _instrument?: string,
      _side?: 'buy' | 'sell',
      qty = 0,
      stop = 0,
      target = 0,
    ): Promise<void> {
      this.rearms.push({ qty, stop, target });
      return Promise.resolve();
    }
  }

  it('leaves a broker-held position unrescaled and warns that reconcile must take qty from the broker, while simulated shadow books still rescale', async () => {
    const alpaca = new SplitAlpaca();
    const { deps, entries } = loggedDeps(harness([longAapl], false, alpaca));
    await runCycle(deps, '2026-09-25');
    alpaca.fill('v2-debate-primary-2026-09-25-AAPL', 'entry', 6, 20);
    deps.setControl('halt');
    await runCycle(deps, '2026-09-28');
    await runCycle(withMarket(deps, snapshot), '2026-09-29');
    expect(primary(deps)).toMatchObject({ qty: 6, splitFactor: 1, splitAnchorDate: undefined });
    expect(eventsOf(entries, 'v2_split_broker_qty')).toMatchObject([
      { level: 'warn', message: expect.stringContaining('#1872') },
    ]);
    expect(eventsOf(entries, 'v2_split_rescaled')).toMatchObject([
      { message: expect.stringContaining('debate/no-macro-gate') },
    ]);
  });

  it('a backstop rearm after a recorded split uses the rescaled native prices, not the pre-split entry prices', async () => {
    const alpaca = new SplitAlpaca();
    const deps = harness([longAapl], false, alpaca);
    await runCycle(deps, '2026-09-25');
    alpaca.fill('v2-debate-primary-2026-09-25-AAPL', 'entry', 6, 20);
    deps.setControl('halt');
    await runCycle(deps, '2026-09-28');
    deps.books.applySplit('debate/primary', 'AAPL', 10, '2026-09-28');
    alpaca.resumeResult = {
      client_order_id: 'v2-debate-primary-2026-09-28-AAPL-exit',
      broker_order_ids: ['pf1'],
      order_state: 'expired',
      filled_qty: 0,
    };
    await runCycle(withMarket(deps, snapshot), '2026-09-29');
    expect(alpaca.rearms).toHaveLength(1);
    expect(alpaca.rearms[0]?.qty).toBe(60);
    expect(alpaca.rearms[0]?.stop).toBeCloseTo(1.92, 9);
    expect(alpaca.rearms[0]?.target).toBeCloseTo(2.12, 9);
  });
});

describe('runCycle: reconcile against the broker before entries (#1872)', () => {
  const longMsft: SleeveDecision = { ...longAapl, instrument: 'MSFT', inputs_hash: 'm' };
  const exitAapl: SleeveDecision = { ...longAapl, action: 'exit', reason: 'judge exit' };
  const PRIMARY_MSFT = 'v2-debate-primary-2026-09-28-MSFT';

  type Defect = (book: BrokerBook) => BrokerBook;

  function brokerWith(deps: Harness, defect: Defect): BrokerBookReader {
    return { read: async (venue) => defect(await deps.brokerBooks.read(venue)) };
  }

  function rows<T>(deps: CycleDeps, sql: string): T[] {
    const db = (deps.journal as unknown as { db: { prepare: (s: string) => { all: () => T[] } } })
      .db;
    return db.prepare(sql).all();
  }

  async function heldAaplThen(
    brokerBooks: (deps: Harness) => BrokerBookReader,
    tolerance: number | undefined,
    brokerMode: BrokerMode = 'paper',
  ) {
    const alpaca = new FakeAlpaca();
    const deps = harness([longAapl], false, alpaca);
    await runCycle(deps, '2026-09-25');
    alpaca.fill('v2-debate-primary-2026-09-25-AAPL', 'entry', 6, 20);
    deps.setDecisions([exitAapl, longMsft]);
    const logs: LogEntry[] = [];
    const report = await runCycle(
      {
        ...deps,
        brokerBooks: brokerBooks(deps),
        brokerMode,
        reconcileCashToleranceGbp: tolerance,
        logger: { log: (entry) => logs.push(entry) },
      },
      '2026-09-28',
    );
    return { alpaca, deps, report, logs };
  }

  it.each<[string, Defect, string, BrokerMode?]>([
    [
      'a broker position the store does not hold',
      (book) => ({
        ...book,
        positions: [...book.positions, { instrument: 'TSLA', qty: 2 }],
        openOrders: [
          ...book.openOrders,
          { clientOrderId: 'stop-TSLA', instrument: 'TSLA', protects: 'long' },
        ],
      }),
      'position_missing_in_store',
    ],
    [
      'a store position the broker does not hold',
      (book) => ({ ...book, positions: [], openOrders: [] }),
      'position_missing_at_broker',
    ],
    [
      'a quantity that differs',
      (book) => ({ ...book, positions: [{ instrument: 'AAPL', qty: 5 }] }),
      'position_qty',
    ],
    [
      'an open order the store does not know',
      (book) => ({
        ...book,
        openOrders: [
          ...book.openOrders,
          { clientOrderId: 'manual', instrument: 'TSLA', protects: null },
        ],
      }),
      'order_unknown_to_store',
    ],
    [
      'a held position the broker guards with no order',
      (book) => ({ ...book, openOrders: [] }),
      'position_unprotected',
    ],
    [
      'cash outside the tolerance',
      (book) => ({ ...book, cashQuote: book.cashQuote + 100 }),
      'cash',
      'live',
    ],
  ])(
    '%s: blocks primary entries, still exits, alerts critical and journals the diff',
    async (_name, defect, kind, brokerMode) => {
      const { alpaca, deps, report, logs } = await heldAaplThen(
        (harnessed) => brokerWith(harnessed, defect),
        MIRROR_CASH_TOLERANCE_GBP,
        brokerMode,
      );

      expect(alpaca.flattens).toEqual(['v2-debate-primary-2026-09-28-AAPL-exit']);
      expect(alpaca.brackets.map((order) => order.client_order_id)).not.toContain(PRIMARY_MSFT);
      expect(deps.journal.orderFor(PRIMARY_MSFT)).toBeUndefined();
      expect(sizeShares(deps, 'debate/primary', '2026-09-28', 'MSFT')).toBe(0);
      expect(deps.journal.orderFor('v2-debate-no-macro-gate-2026-09-28-MSFT')).toMatchObject({
        outcome: 'simulated',
      });
      expect(report.books.map((book) => book.book_id)).toEqual([
        'debate/primary',
        'debate/no-macro-gate',
      ]);
      expect(report.refusals).toContainEqual(
        expect.stringMatching(
          /^debate\/primary: entries blocked, alpaca broker reconcile mismatch: /,
        ),
      );
      expect(logs).toContainEqual(
        expect.objectContaining({ level: 'error', event: 'v2_reconcile_mismatch' }),
      );

      const [run] = rows<{ status: string; book_ids: string; diffs: string }>(
        deps,
        "SELECT status, book_ids, diffs FROM v2_reconciles WHERE trading_date = '2026-09-28' AND source = 'broker'",
      );
      expect(run?.status).toBe('mismatch');
      expect(JSON.parse(run?.book_ids ?? '[]')).toEqual(['debate/primary']);
      expect(JSON.parse(run?.diffs ?? '[]').map((diff: { kind: string }) => diff.kind)).toContain(
        kind,
      );
      expect(
        rows(
          deps,
          "SELECT book_id, parameter FROM v2_refusals WHERE scope = 'reconcile' AND trading_date = '2026-09-28'",
        ),
      ).toEqual([{ book_id: 'debate/primary', parameter: 'BROKER_RECONCILE' }]);
    },
  );

  it('a broker read failure blocks primary entries with a warning and never throws out of the cycle', async () => {
    const { alpaca, deps, report, logs } = await heldAaplThen(
      () => ({ read: () => Promise.reject(new Error('alpaca 503')) }),
      MIRROR_CASH_TOLERANCE_GBP,
    );

    expect(report.skipped).toBe(false);
    expect(alpaca.flattens).toEqual(['v2-debate-primary-2026-09-28-AAPL-exit']);
    expect(deps.journal.orderFor(PRIMARY_MSFT)).toBeUndefined();
    expect(logs).toContainEqual(
      expect.objectContaining({ level: 'warn', event: 'v2_reconcile_read_failed' }),
    );
    expect(
      rows(
        deps,
        "SELECT status, detail FROM v2_reconciles WHERE source = 'broker' AND trading_date = '2026-09-28'",
      ),
    ).toEqual([{ status: 'read_failed', detail: 'alpaca 503' }]);
  });

  it('a store throw inside reconcile blocks every book entry, still exits and alerts critical (#1927)', async () => {
    const alpaca = new FakeAlpaca();
    const deps = harness([longAapl], false, alpaca);
    await runCycle(deps, '2026-09-25');
    alpaca.fill('v2-debate-primary-2026-09-25-AAPL', 'entry', 6, 20);
    deps.setDecisions([exitAapl, longMsft]);
    vi.spyOn(deps.journal, 'recordReconcile').mockImplementation(() => {
      throw new Error('SQLITE_BUSY');
    });
    const logs: LogEntry[] = [];
    const report = await runCycle(
      { ...deps, logger: { log: (entry) => logs.push(entry) } },
      '2026-09-28',
    );

    expect(report.skipped).toBe(false);
    expect(alpaca.flattens).toEqual(['v2-debate-primary-2026-09-28-AAPL-exit']);
    expect(deps.journal.orderFor(PRIMARY_MSFT)).toBeUndefined();
    expect(deps.journal.orderFor('v2-debate-no-macro-gate-2026-09-28-MSFT')).toBeUndefined();
    expect(report.books.map((book) => book.book_id)).toEqual([
      'debate/primary',
      'debate/no-macro-gate',
    ]);
    expect(report.refusals).toEqual(
      expect.arrayContaining([
        'debate/primary: entries blocked, reconcile threw: SQLITE_BUSY',
        'debate/no-macro-gate: entries blocked, reconcile threw: SQLITE_BUSY',
      ]),
    );
    expect(logs).toContainEqual(
      expect.objectContaining({ level: 'error', event: 'v2_reconcile_threw' }),
    );
  });

  it('live: an unset cash tolerance fails closed, primary entries blocked through a refusal, no critical alert', async () => {
    const { deps, logs } = await heldAaplThen(
      (harnessed) => harnessed.brokerBooks,
      undefined,
      'live',
    );

    expect(deps.journal.orderFor(PRIMARY_MSFT)).toBeUndefined();
    expect(logs.filter((entry) => entry.event?.startsWith('v2_reconcile'))).toEqual([]);
    expect(
      rows(
        deps,
        "SELECT book_id, parameter FROM v2_refusals WHERE scope = 'reconcile' AND trading_date = '2026-09-28'",
      ),
    ).toEqual([{ book_id: 'debate/primary', parameter: 'RECONCILE_CASH_TOLERANCE_GBP' }]);
  });

  it('paper never compares cash (David 2026-09-29): a cash gap with no tolerance set blocks nothing', async () => {
    const { alpaca, deps, logs } = await heldAaplThen(
      (harnessed) =>
        brokerWith(harnessed, (book) => ({ ...book, cashQuote: book.cashQuote + 100 })),
      undefined,
      'paper',
    );

    expect(alpaca.brackets.map((order) => order.client_order_id)).toContain(PRIMARY_MSFT);
    expect(logs.filter((entry) => entry.event?.startsWith('v2_reconcile'))).toEqual([]);
    expect(rows(deps, "SELECT parameter FROM v2_refusals WHERE scope = 'reconcile'")).toEqual([]);
    expect(
      rows(
        deps,
        "SELECT status, detail FROM v2_reconciles WHERE source = 'broker' AND trading_date = '2026-09-28'",
      ),
    ).toEqual([
      { status: 'clean', detail: 'cash not compared on paper (David 2026-09-29, #1872)' },
    ]);
  });

  it('live compares cash: a gap inside the set tolerance is clean', async () => {
    const { alpaca } = await heldAaplThen(
      (harnessed) => brokerWith(harnessed, (book) => ({ ...book, cashQuote: book.cashQuote + 1 })),
      5,
      'live',
    );
    expect(alpaca.brackets.map((order) => order.client_order_id)).toContain(PRIMARY_MSFT);
  });

  it('a clean book lets entries through and records the clean run', async () => {
    const { alpaca, deps, logs } = await heldAaplThen(
      (harnessed) => harnessed.brokerBooks,
      MIRROR_CASH_TOLERANCE_GBP,
    );

    expect(alpaca.brackets.map((order) => order.client_order_id)).toContain(PRIMARY_MSFT);
    expect(logs.filter((entry) => entry.event?.startsWith('v2_reconcile'))).toEqual([]);
    expect(
      rows(
        deps,
        "SELECT venue, source, status FROM v2_reconciles WHERE trading_date = '2026-09-28' ORDER BY venue, source",
      ),
    ).toEqual([
      { venue: 'alpaca', source: 'broker', status: 'clean' },
      { venue: 'alpaca', source: 'simulated', status: 'clean' },
      { venue: 'saxo', source: 'simulated', status: 'clean' },
      { venue: 'saxo_cfd_gbp', source: 'simulated', status: 'clean' },
      { venue: 'saxo_cfd_usd', source: 'simulated', status: 'clean' },
    ]);
  });

  it('blocks only the run that finds the defect: the next clean run enters again', async () => {
    const { alpaca, deps } = await heldAaplThen(
      (harnessed) => brokerWith(harnessed, (book) => ({ ...book, positions: [] })),
      MIRROR_CASH_TOLERANCE_GBP,
    );
    deps.setDecisions([{ ...longMsft, inputs_hash: 'm2' }]);
    await runCycle(deps, '2026-09-29');
    expect(alpaca.brackets.map((order) => order.client_order_id)).toContain(
      'v2-debate-primary-2026-09-29-MSFT',
    );
  });
});

describe('runCycle: a held name whose series ends (doc 70 §2.4, #1911)', () => {
  const LAST_BAR = bar('2026-09-28', {
    open: 20.4,
    low: 20.3,
    high: 20.6,
    close: 20.4,
    rawClose: 20.4,
  });
  const LAST_CLOSE_GBP = (20.4 * (1 - HALF_SPREAD_BPS / 10_000)) / FX;
  const BOOKS = ['debate/primary', 'debate/no-macro-gate'] as const;
  const ENDED_LOGS = BOOKS.map((bookId) => [
    'info',
    `${bookId} AAPL: series ended 2026-09-28, closed at its last close (doc 70 §2.4)`,
  ]);

  function ended(deps: Harness, closeEndedSeries: boolean) {
    const log = vi.fn();
    const market: MarketData = {
      ...deps.market,
      lastBarBefore: (instrument, tradingDate) =>
        instrument === 'AAPL' && tradingDate > LAST_BAR.date
          ? LAST_BAR
          : deps.market.lastBarBefore(instrument, tradingDate),
      barsBefore: (instrument, tradingDate, count) =>
        deps.market
          .barsBefore(instrument, tradingDate, count)
          .filter((dated) => instrument !== 'AAPL' || dated.date <= LAST_BAR.date),
    };
    const run = (tradingDate: string) =>
      runCycle({ ...deps, market, logger: { log }, closeEndedSeries }, tradingDate);
    const endedLogs = () =>
      log.mock.calls
        .filter(([entry]) => entry.event === 'v2_series_ended_exit')
        .map(([entry]) => [entry.level, entry.message]);
    return { run, endedLogs };
  }

  const freshnessRefusals = (report: { refusals: readonly string[] }) =>
    report.refusals.filter((refusal) => refusal.includes('marked at'));

  const exitOrderId = (bookId: string, date: string) =>
    `v2-${bookId.replace('/', '-')}-${date}-AAPL-exit`;

  it('closes both books at the last close less half a spread once the last bar is 5 days stale, then stays flat', async () => {
    const deps = harness([longAapl], true);
    await openBooks(deps);
    const { run, endedLogs } = ended(deps, true);
    await run('2026-09-29');
    const lastFresh = await run('2026-10-03');
    expect(lastFresh.exits).toBe(0);
    expect(freshnessRefusals(lastFresh)).toEqual([]);
    for (const bookId of BOOKS) expect(deps.books.position(bookId, 'AAPL')).toBeDefined();

    const closing = await run('2026-10-04');
    expect(closing).toMatchObject({ exits: 2, simulated_orders: 2, fills: 2 });
    expect(freshnessRefusals(closing)).toEqual([]);
    for (const bookId of BOOKS) {
      const clientOrderId = exitOrderId(bookId, '2026-10-04');
      expect(deps.books.position(bookId, 'AAPL')).toBeUndefined();
      expect(deps.journal.orderFor(clientOrderId)).toMatchObject({
        leg: 'exit',
        side: 'sell',
        outcome: 'simulated',
        payload: { size: 6, detail: 'series_ended_at_last_close', price: 20.4 },
      });
      expect(exitFill(deps, clientOrderId)).toEqual({
        side: 'sell',
        qty: 6,
        price_gbp: expect.closeTo(LAST_CLOSE_GBP, 9),
      });
    }
    expect(endedLogs()).toEqual(ENDED_LOGS);

    const after = await run('2026-10-05');
    expect(after.exits).toBe(0);
    expect(freshnessRefusals(after)).toEqual([]);
    expect(endedLogs()).toEqual(ENDED_LOGS);
  });

  it('with the flag off keeps the position and journals the stale mark, as forward paper does (#1804)', async () => {
    const deps = harness([longAapl], true);
    await openBooks(deps);
    const { run, endedLogs } = ended(deps, false);
    const stale = await run('2026-10-04');
    expect(stale.exits).toBe(0);
    for (const bookId of BOOKS) expect(deps.books.position(bookId, 'AAPL')?.qty).toBe(6);
    expect(freshnessRefusals(stale)).toEqual(
      BOOKS.map(
        (bookId) =>
          `${bookId} AAPL: marked at the 2026-09-28 close, no bar in the 5 days before 2026-10-04`,
      ),
    );
    expect(endedLogs()).toEqual([]);
  });

  it('leaves a bracket leg on the last bar to close the position, with no second exit', async () => {
    const deps = harness([longAapl], true);
    await openBooks(deps);
    const touchesTarget = bar('2026-09-28', { low: 20.3, high: 21.3, close: 20.4, rawClose: 20.4 });
    const { endedLogs } = ended(deps, true);
    const report = await runCycle(
      {
        ...deps,
        closeEndedSeries: true,
        market: {
          ...deps.market,
          lastBarBefore: (instrument, tradingDate) =>
            instrument === 'AAPL'
              ? touchesTarget
              : deps.market.lastBarBefore(instrument, tradingDate),
        },
      },
      '2026-10-04',
    );
    expect(report.exits).toBe(2);
    for (const bookId of BOOKS) {
      expect(deps.books.position(bookId, 'AAPL')).toBeUndefined();
      expect(deps.journal.orderFor(exitOrderId(bookId, '2026-10-04'))?.payload).toMatchObject({
        detail: 'bracket_leg_on_daily_bar',
      });
    }
    expect(endedLogs()).toEqual([]);
  });

  it('keeps a CFD position whose close has no cost model open and unlogged until the model exists', async () => {
    const state = { unset: false };
    const pricing: FillPricing = {
      ...SPREAD_ONLY,
      fee: (venue) => {
        if (state.unset && venue.startsWith('saxo_cfd')) throw new CfdCostModelUnsetError();
        return 0;
      },
    };
    const deps = harness([shortAapl], true, undefined, [2026], TEST_SPEC, pricing);
    await openBooks(deps);
    const { run, endedLogs } = ended(deps, true);
    state.unset = true;
    const refused = await run('2026-10-04');
    expect(refused.exits).toBe(0);
    for (const bookId of BOOKS) expect(deps.books.position(bookId, 'AAPL')?.qty).toBe(-6);
    expect(endedLogs()).toEqual([]);
    state.unset = false;
    await run('2026-10-05');
    for (const bookId of BOOKS) expect(deps.books.position(bookId, 'AAPL')).toBeUndefined();
    expect(endedLogs()).toHaveLength(2);
  });

  it('keeps a pending CFD flatten with no cost model open, refused once per book and unlogged', async () => {
    const state = { unset: false };
    const pricing: FillPricing = {
      ...SPREAD_ONLY,
      fee: (venue) => {
        if (state.unset && venue.startsWith('saxo_cfd')) throw new CfdCostModelUnsetError();
        return 0;
      },
    };
    const deps = harness([shortAapl], true, undefined, [2026], TEST_SPEC, pricing);
    await openBooks(deps);
    const { run, endedLogs } = ended(deps, true);
    deps.setControl('halt');
    await run('2026-09-29');
    state.unset = true;
    const refused = await run('2026-10-04');
    expect(refused.fills).toBe(0);
    for (const bookId of BOOKS) expect(deps.books.position(bookId, 'AAPL')?.qty).toBe(-6);
    expect(endedLogs()).toEqual([]);
    const db = (
      deps.journal as unknown as { db: { prepare: (s: string) => { all: () => unknown[] } } }
    ).db;
    expect(
      db
        .prepare(
          "SELECT book_id FROM v2_refusals WHERE parameter = 'CFD_COST_MODEL' AND scope = 'fill' ORDER BY book_id",
        )
        .all(),
    ).toEqual([{ book_id: 'debate/no-macro-gate' }, { book_id: 'debate/primary' }]);
    state.unset = false;
    await run('2026-10-05');
    for (const bookId of BOOKS) expect(deps.books.position(bookId, 'AAPL')).toBeUndefined();
    expect(endedLogs()).toHaveLength(2);
  });

  it('fills a pending flatten at the last close and keeps its journalled reason', async () => {
    const deps = harness([longAapl], true);
    await openBooks(deps);
    const { run, endedLogs } = ended(deps, true);
    deps.setControl('halt');
    await run('2026-09-29');
    const waiting = await run('2026-10-03');
    expect(waiting.fills).toBe(0);
    deps.setControl('resume');
    const filled = await run('2026-10-04');
    expect(filled).toMatchObject({ exits: 0, fills: 2 });
    for (const bookId of BOOKS) {
      const clientOrderId = exitOrderId(bookId, '2026-09-29');
      expect(deps.books.position(bookId, 'AAPL')).toBeUndefined();
      expect(deps.journal.orderFor(clientOrderId)?.payload).toMatchObject({
        reason: 'manual_halt',
      });
      expect(exitFill(deps, clientOrderId)).toEqual({
        side: 'sell',
        qty: 6,
        price_gbp: expect.closeTo(LAST_CLOSE_GBP, 9),
      });
    }
    expect(endedLogs()).toEqual(ENDED_LOGS);
  });
});

describe('runCycle with per-venue sessions (#1933)', () => {
  const longIsf: SleeveDecision = { ...longAapl, instrument: 'ISF', venue: 'saxo' };
  const BOOKS = ['debate/primary', 'debate/no-macro-gate'];

  function sessioned(decisions: readonly SleeveDecision[], now: string): Harness {
    return {
      ...harness(decisions, true),
      clock: new SimulatedClock(new Date(now)),
      venueSessions: TABLE_VENUE_SESSIONS,
    };
  }

  function sitOuts(deps: CycleDeps) {
    const db = (
      deps.journal as unknown as { db: { prepare: (s: string) => { all: () => unknown[] } } }
    ).db;
    return db
      .prepare(
        "SELECT scope, parameter, book_id, instrument, message FROM v2_refusals WHERE ticket = '#1933' ORDER BY rowid",
      )
      .all();
  }

  function entryInstruments(deps: CycleDeps, bookId: string) {
    return orders(deps, bookId)
      .filter((order) => order.leg === 'entry')
      .map((order) => order.client_order_id.split('-').at(-1));
  }

  it('Thanksgiving: US names sit out with venue_closed while LSE names enter', async () => {
    const deps = sessioned([longAapl, longIsf], '2026-11-26T06:30:00.000Z');
    const report = await runCycle(deps, '2026-11-26');
    expect(report).toMatchObject({ decisions: 2, entries: 2 });
    for (const bookId of BOOKS) {
      expect(entryInstruments(deps, bookId)).toEqual(['ISF']);
      expect(sizeShares(deps, bookId, '2026-11-26', 'AAPL')).toBe(0);
    }
    expect(sitOuts(deps)).toEqual(
      BOOKS.map((bookId) => ({
        scope: 'entry',
        parameter: 'venue_closed',
        book_id: bookId,
        instrument: 'AAPL',
        message: `${bookId} AAPL: alpaca entry sits out (venue_closed)`,
      })),
    );
    expect(report.refusals).toContain('debate/primary AAPL: alpaca entry sits out (venue_closed)');
  });

  it('Thanksgiving sits a US CFD short out too', async () => {
    const deps = sessioned([shortAapl], '2026-11-26T06:30:00.000Z');
    await runCycle(deps, '2026-11-26');
    for (const bookId of BOOKS) expect(entryInstruments(deps, bookId)).toEqual([]);
    expect(sitOuts(deps)).toMatchObject(
      BOOKS.map((bookId) => ({ parameter: 'venue_closed', book_id: bookId, instrument: 'AAPL' })),
    );
  });

  it('an LSE-only holiday sits the LSE names out and the US names enter', async () => {
    const deps = sessioned([longAapl, longIsf], '2026-12-28T06:30:00.000Z');
    await runCycle(deps, '2026-12-28');
    for (const bookId of BOOKS) expect(entryInstruments(deps, bookId)).toEqual(['AAPL']);
    expect(sitOuts(deps)).toMatchObject(
      BOOKS.map((bookId) => ({ parameter: 'venue_closed', book_id: bookId, instrument: 'ISF' })),
    );
  });

  it.each([
    ['2026-09-30T06:30:00.000Z', ['AAPL', 'ISF'], []],
    ['2026-09-30T07:00:00.000Z', ['AAPL'], ['ISF']],
    ['2026-09-30T13:30:00.000Z', [], ['AAPL', 'ISF']],
  ])('a run starting %s enters %j and refuses %j as a late wake', async (now, entered, late) => {
    const deps = sessioned([longAapl, longIsf], now);
    await runCycle(deps, '2026-09-30');
    expect(entryInstruments(deps, 'debate/primary')).toEqual(entered);
    expect(
      (sitOuts(deps) as { parameter: string; book_id: string; instrument: string }[])
        .filter((row) => row.book_id === 'debate/primary')
        .map((row) => [row.parameter, row.instrument]),
    ).toEqual(late.map((instrument) => ['late_wake_entry_cutoff', instrument]));
  });

  function slowDebate(deps: Harness, debateEndsAt: string): Harness {
    const registry = new SleeveRegistry();
    registry.register({
      ...deps.sleeve,
      decide: (...args: Parameters<Sleeve['decide']>) => {
        (deps.clock as SimulatedClock).advanceTo(new Date(debateEndsAt));
        return deps.sleeve.decide(...args);
      },
    });
    return { ...deps, registry };
  }

  it('an on-time run whose debate drags past both opens still enters in both books', async () => {
    const deps = slowDebate(
      sessioned([longAapl, longIsf], '2026-09-30T06:30:00.000Z'),
      '2026-09-30T14:00:00.000Z',
    );
    const report = await runCycle(deps, '2026-09-30');
    expect(deps.clock.now().toISOString()).toBe('2026-09-30T14:00:00.000Z');
    expect(report.entries).toBe(4);
    for (const bookId of BOOKS) expect(entryInstruments(deps, bookId)).toEqual(['AAPL', 'ISF']);
    expect(sitOuts(deps)).toEqual([]);
  });

  it.each([
    ['2026-09-30T06:30:00.000Z', '2026-09-30T14:00:00.000Z', ['AAPL', 'ISF']],
    ['2026-09-30T13:30:00.000Z', '2026-09-30T06:30:00.000Z', []],
  ])('judges the cutoff by a run start of %s, not the cycle clock of %s', async (started, now, entered) => {
    const deps = { ...sessioned([longAapl, longIsf], now), runStartedAt: new Date(started) };
    await runCycle(deps, '2026-09-30');
    for (const bookId of BOOKS) expect(entryInstruments(deps, bookId)).toEqual(entered);
  });

  it('a late wake still exits and marks', async () => {
    const deps = sessioned([longAapl], '2026-09-24T06:30:00.000Z');
    await openBooks(deps);
    const late = { ...deps, clock: new SimulatedClock(new Date('2026-09-28T20:00:00.000Z')) };
    late.setDecisions([{ ...longAapl, action: 'exit' }]);
    const report = await runCycle(late, '2026-09-28');
    expect(report).toMatchObject({ skipped: false, exits: 2 });
    expect(deps.books.lastDay('debate/primary')?.tradingDate).toBe('2026-09-28');
  });

  it('a day a venue is closed does not count toward the time stop of its names', async () => {
    const deps = sessioned([longAapl, longIsf], '2026-11-24T06:30:00.000Z');
    await runCycle(deps, '2026-11-24');
    deps.setDecisions([]);
    await runCycle(deps, '2026-11-25');
    const marks = () =>
      ['AAPL', 'ISF'].map((instrument) => [
        instrument,
        deps.books.position('debate/no-macro-gate', instrument)?.marksHeld,
      ]);
    expect(marks()).toEqual([
      ['AAPL', 1],
      ['ISF', 1],
    ]);
    await runCycle(deps, '2026-11-26');
    expect(marks()).toEqual([
      ['AAPL', 1],
      ['ISF', 2],
    ]);
    await runCycle(deps, '2026-11-27');
    expect(marks()).toEqual([
      ['AAPL', 2],
      ['ISF', 3],
    ]);
  });

  it('exits a US name on Thanksgiving when its exit is signalled', async () => {
    const deps = sessioned([longAapl], '2026-11-24T06:30:00.000Z');
    await runCycle(deps, '2026-11-24');
    deps.setDecisions([]);
    await runCycle(deps, '2026-11-25');
    deps.setDecisions([{ ...longAapl, action: 'exit' }]);
    const report = await runCycle(deps, '2026-11-26');
    expect(report.exits).toBe(2);
    expect(
      deps.journal.orderFor('v2-debate-no-macro-gate-2026-11-26-AAPL-exit')?.payload,
    ).toMatchObject({ reason: 'signal_exit' });
    expect(sitOuts(deps)).toEqual([]);
  });

  it('never gates the intraday entry pass, which trades inside the session by design', async () => {
    const deps = sessioned([], '2026-09-30T15:00:00.000Z');
    const report = await runEntryPass(deps, {
      tradingDate: '2026-09-30',
      sleeveId: 'debate',
      decisionsFor: () => [longAapl],
      entryOrderId: (book, instrument, date) => `sig-${book.id}-${date}-${instrument}`,
      blockedBookIds: new Set(),
    });
    expect(report.entries).toBe(2);
    expect(sitOuts(deps)).toEqual([]);
  });
});
