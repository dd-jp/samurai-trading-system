import { describe, expect, it, vi } from 'vitest';
import type { MarketData, Sleeve, SleeveDecision, SleeveSpec } from '../../../contracts/index.js';
import type {
  BrokerAck,
  BrokerAdapter,
  NativeBracketRequest,
  NormalizedFill,
} from '../../pipeline/execution/index.js';
import type { DailyBar } from '../../pipeline/momentum/index.js';
import { SimulatedClock, toBrokerFillId } from '../../shared/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import { type CycleDeps, calendarDaysBetween, runCycle, vetoApplied } from './cycle.js';
import { addDays } from './data/index.js';
import { DryRunBrokerAdapter } from './execution/dry-run-broker.js';
import { V2OrderExecutor } from './execution/executor.js';
import type { FillPricing } from './execution/simulated-costs.js';
import { Journal } from './journal/index.js';
import { CapitalConfigStore, PaperBooks, V2RiskGate } from './risk/index.js';
import { CYCLE_LEVEL_PARAMETERS, SleeveRegistry } from './signal/index.js';

const clock = new SimulatedClock(new Date('2026-09-25T07:00:00.000Z'));
const FX = 1.25;
const HALF_SPREAD_BPS = 5;

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

  getOrder(): Promise<null> {
    return Promise.resolve(null);
  }

  resumeFlatten(): Promise<null> {
    return Promise.resolve(null);
  }

  fetchNewFills(since: Date): Promise<NormalizedFill[]> {
    this.sinceSeen.push(since);
    return Promise.resolve(this.pending.splice(0));
  }

  resizeProtectiveLegs(): Promise<void> {
    return Promise.resolve();
  }

  rearmProtectiveLegs(): Promise<void> {
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
}

const TEST_SPEC: SleeveSpec = {
  minimumCapitalGbp: 0,
  capacityGbp: Number.POSITIVE_INFINITY,
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

function harness(
  decisions: readonly SleeveDecision[],
  dryRun: boolean,
  alpaca?: BrokerAdapter,
  capitalYears: readonly number[] = [2026],
  spec: SleeveSpec = TEST_SPEC,
  pricing: FillPricing = SPREAD_ONLY,
): Harness {
  const db = openSharedStore(':memory:');
  const capital = new CapitalConfigStore(db, clock);
  for (const year of capitalYears) capital.setYear(year, 1_000, 1_500);
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
  const barsByDate = new Map<string, DailyBar>();
  const barFor = (_instrument: string, tradingDate: string) => {
    const dated = barsByDate.get(tradingDate);
    if (dated !== undefined) return dated;
    const previous = new Date(Date.parse(tradingDate) - 86_400_000).toISOString().slice(0, 10);
    return bar(previous);
  };
  const market: MarketData = {
    lastBarBefore: barFor,
    barsBefore: (instrument, tradingDate, count) =>
      instrument === 'THIN'
        ? []
        : Array.from({ length: count }, (_, back) => bar(addDays(tradingDate, back - count))),
    gbpUsdAtYearStart: () => FX,
  };
  const books = new PaperBooks(db, clock, capital, '2026-09-01', [sleeve]);
  const simulatedBroker = new DryRunBrokerAdapter({
    venue: 'alpaca',
    pricing,
    markPrice: (instrument) => barFor(instrument, clock.now().toISOString().slice(0, 10))?.rawClose,
    clock,
  });
  return {
    registry,
    sleeve,
    barsByDate,
    setDecisions: (next) => {
      current = next;
    },
    books,
    journal: new Journal(db, clock),
    risk: new V2RiskGate({ books, capital, market, spec: () => spec }),
    executor: new V2OrderExecutor({
      brokers: alpaca === undefined ? {} : { alpaca },
      simulatedBrokers: { alpaca: simulatedBroker, saxo: simulatedBroker },
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

const ENTRY_COST_GBP = (6 * 20 * (1 + HALF_SPREAD_BPS / 10_000)) / FX;

describe('runCycle', () => {
  it('dry run: sizes, reaches the dry-run broker, submits nothing, and ingests simulated fills', async () => {
    const deps = harness([longAapl], true);
    const report = await runCycle(deps, '2026-09-25');
    expect(report).toMatchObject({
      dry_run: true,
      skipped: false,
      sleeves: ['debate'],
      decisions: 1,
      entries: 2,
      exits: 0,
      fills: 2,
      submitted_orders: 0,
      simulated_orders: 1,
      dry_run_refusals: 1,
      rejected_orders: 0,
      macro: { macroDay: false, covered: true },
    });
    expect(report.refusals).toEqual([
      ...CYCLE_LEVEL_PARAMETERS.map(
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
    for (const bookId of ['debate/primary', 'debate/no-macro-gate']) {
      expect(deps.books.position(bookId, 'AAPL')).toMatchObject({
        qty: 6,
        avgPriceGbp: expect.closeTo(ENTRY_COST_GBP / 6, 9),
        stopGbp: expect.closeTo(19.2 / FX, 9),
        targetGbp: expect.closeTo(21.2 / FX, 9),
        marksHeld: 1,
      });
      expect(deps.books.cash(bookId)).toBeCloseTo(1_000 - ENTRY_COST_GBP, 9);
    }
    expect(report.books).toMatchObject([
      {
        book_id: 'debate/primary',
        positions: 1,
        equity_gbp: expect.closeTo(1_000 - ENTRY_COST_GBP + 96, 9),
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
      fills: 1,
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
    expect(deps.books.position('debate/no-macro-gate', 'AAPL')?.qty).toBe(6);
    alpaca.fill('v2-debate-primary-2026-09-16-AAPL', 'entry', 3, 20.01);
    deps.setDecisions([]);
    const next = await runCycle(deps, '2026-09-17');
    expect(next.fills).toBe(1);
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
    await runCycle(deps, '2026-09-25');
    deps.setDecisions([]);
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
    await runCycle(deps, '2026-09-25');
    deps.setDecisions([]);
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
      await runCycle(deps, '2026-09-25');
      deps.setDecisions([]);
      deps.barsByDate.set('2026-09-28', bar('2026-09-25', override));
      await runCycle(deps, '2026-09-28');
      const entry = (6 * 20 * (1 + (HALF_SPREAD_BPS + 3) / 10_000)) / FX;
      expect(deps.books.cash('debate/primary')).toBeCloseTo(
        1_000 - entry + (6 * fill) / FX - (2 * 0.5) / FX,
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
      await runCycle(deps, '2026-09-25');
      deps.setDecisions([]);
      deps.barsByDate.set('2026-09-28', bar('2026-09-25', override));
      const report = await runCycle(deps, '2026-09-28');
      expect(report.exits).toBe(2);
      expect(
        deps.journal.orderFor('v2-debate-primary-2026-09-28-AAPL-exit')?.payload.price,
      ).toBeCloseTo(price, 9);
    }
  });

  it('a bar touching both legs exits at the stop, for longs and shorts', async () => {
    const short: SleeveDecision = {
      ...longAapl,
      action: 'enter_short',
      stop_price: 20.8,
    };
    for (const [decision, override, price] of [
      [longAapl, { low: 19.0, high: 21.5 }, 19.2],
      [short, { low: 18.5, high: 21.0 }, 20.8],
    ] as const) {
      const deps = harness([decision], true);
      await runCycle(deps, '2026-09-25');
      deps.setDecisions([]);
      deps.barsByDate.set('2026-09-28', bar('2026-09-25', override));
      expect((await runCycle(deps, '2026-09-28')).exits).toBe(2);
      expect(
        deps.journal.orderFor('v2-debate-primary-2026-09-28-AAPL-exit')?.payload.price,
      ).toBeCloseTo(price, 9);
    }
  });

  it('short brackets: the stop fires on the high, the target on the low, and neither inside', async () => {
    const short: SleeveDecision = {
      ...longAapl,
      action: 'enter_short',
      stop_price: 20.8,
    };
    for (const [override, price] of [
      [{ low: 19.5, high: 20.8 }, 20.8],
      [{ low: 18.8, high: 20.5 }, 18.8],
      [{ low: 18.9, high: 20.7 }, undefined],
    ] as const) {
      const deps = harness([short], true);
      await runCycle(deps, '2026-09-25');
      deps.setDecisions([]);
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

  it('dry run never sweeps the paper broker', async () => {
    const alpaca = new FakeAlpaca();
    const deps = harness([longAapl], true, alpaca);
    await runCycle(deps, '2026-09-25');
    expect(alpaca.sinceSeen).toEqual([]);
    expect(alpaca.brackets).toEqual([]);
  });

  it('a bar dated before the entry never triggers a simulated exit', async () => {
    const deps = harness([longAapl], true);
    await runCycle(deps, '2026-09-25');
    deps.setDecisions([]);
    deps.barsByDate.set('2026-09-28', bar('2026-09-23', { low: 1, high: 100 }));
    const report = await runCycle(deps, '2026-09-28');
    expect(report.exits).toBe(0);
    expect(deps.books.position('debate/primary', 'AAPL')?.qty).toBe(6);
  });

  it('time-stops a position after ten marks through the broker flatten path', async () => {
    const deps = harness([longAapl], true);
    const flatten = vi.spyOn(deps.simulatedBroker, 'submitFlatten');
    await runCycle(deps, '2026-09-25');
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
    ];
    for (const date of dates) {
      expect((await runCycle(deps, date)).exits).toBe(0);
    }
    expect(deps.books.position('debate/primary', 'AAPL')?.marksHeld).toBe(10);
    const report = await runCycle(deps, '2026-10-09');
    expect(report).toMatchObject({ exits: 2, dry_run_refusals: 1, simulated_orders: 1, fills: 2 });
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
    expect(deps.books.positions('debate/primary')).toEqual([]);
    expect(deps.books.cash('debate/primary')).toBeCloseTo(
      1_000 - ENTRY_COST_GBP + (6 * 20 * (1 - HALF_SPREAD_BPS / 10_000)) / FX,
      9,
    );
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
    expect(report).toMatchObject({ exits: 1, submitted_orders: 1 });
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
    expect(rejected).toMatchObject({ exits: 1, rejected_orders: 1, submitted_orders: 0 });
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
    const skipped = { ...longAapl, action: 'skip', reason: 'shorts_disabled', veto: 'x' } as const;
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
      "SLEEVE_MINIMUM_CAPITAL: sleeve debate gets £0 of 2026's £1000 (minimum £1001, capacity £Infinity): no allocation (doc 66 D8)",
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
      db.prepare("SELECT parameter, message FROM v2_refusals WHERE scope = 'entry'").all(),
    ).toEqual([
      { parameter: 'ADV_WINDOW_COVERAGE', message: 'debate/primary THIN: no_adv' },
      { parameter: 'ADV_WINDOW_COVERAGE', message: 'debate/no-macro-gate THIN: no_adv' },
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

  it('rejects an entry for a venue without a broker, without a stop, and on a broker error', async () => {
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
      rejected_orders: 4,
      simulated_orders: 2,
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
      ['v2-debate-primary-2026-09-25-CSP1', 'rejected', 'no_broker_for_venue:saxo'],
      ['v2-debate-primary-2026-09-25-NOSTOP', 'rejected', 'no_stop_price'],
    ]);
    expect(
      orders(deps, 'debate/primary').map((o) => [o.client_order_id, JSON.parse(o.payload).target]),
    ).toEqual([
      ['v2-debate-primary-2026-09-25-AAPL', expect.closeTo(21.2, 9)],
      ['v2-debate-primary-2026-09-25-CSP1', 23],
      ['v2-debate-primary-2026-09-25-NOSTOP', undefined],
    ]);
    expect(deps.books.position('debate/no-macro-gate', 'CSP1')?.venue).toBe('saxo');
  });

  it('sends shorts as sells with the target below, and skips zero-size names', async () => {
    const short: SleeveDecision = {
      ...longAapl,
      instrument: 'SHRT',
      action: 'enter_short',
      stop_price: 20.8,
    };
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
      expect.objectContaining({ event: 'v2_fill_unmatched', level: 'warn' }),
    );
    const db = (
      deps.journal as unknown as { db: { prepare: (s: string) => { all: () => unknown[] } } }
    ).db;
    expect(db.prepare('SELECT scope, parameter FROM v2_refusals ORDER BY rowid').all()).toEqual([
      ...CYCLE_LEVEL_PARAMETERS.map((parameter) => ({
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

  it('blocks entries after a daily-cap breach and sizes by the previous mark multiplier', async () => {
    const deps = harness([longAapl], true);
    await runCycle(deps, '2026-09-25');
    deps.barsByDate.set(
      '2026-09-28',
      bar('2026-09-25', { low: 19.3, high: 20, close: 17, rawClose: 17 }),
    );
    const drop = await runCycle(deps, '2026-09-28');
    expect(drop.books[0]?.size_multiplier).toBe(0);
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
    await runCycle(deps, '2026-12-14');
    deps.setDecisions([{ ...longAapl, instrument: 'MSFT' }]);
    for (const date of [
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
    expect(deps.books.position('debate/no-macro-gate', 'AAPL')).toBeUndefined();
  });

  it('counts calendar days between marks and never negatively', () => {
    expect(calendarDaysBetween(undefined, '2026-09-25')).toBe(0);
    expect(calendarDaysBetween('2026-09-22', '2026-09-25')).toBe(3);
    expect(calendarDaysBetween('2026-09-25', '2026-09-25')).toBe(0);
    expect(calendarDaysBetween('2026-09-26', '2026-09-25')).toBe(0);
  });
});
