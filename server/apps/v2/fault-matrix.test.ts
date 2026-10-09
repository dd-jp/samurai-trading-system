import { describe, expect, it, vi } from 'vitest';
import type {
  MarketData,
  Sleeve,
  SleeveDecision,
  SleeveSpec,
  V2Bar,
} from '../../../contracts/index.js';
import type { LogEntry } from '../../shared/index.js';
import { SimulatedClock } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { migratedMemoryStore } from '../../shared/store/migrated-template.js';
import { type CycleComposition, composeCycle } from './compose.js';
import { runCycle } from './cycle.js';
import { addDays, bothVenuesClosed, TABLE_VENUE_SESSIONS } from './data/index.js';
import { AlpacaBrokerProviderError } from './execution/alpaca/alpaca-broker-errors.js';
import type {
  AlpacaAccount,
  AlpacaBracketOrderRequest,
  AlpacaBrokerClient,
  AlpacaMarketOrderRequest,
  AlpacaOcoOrderRequest,
  AlpacaOrder,
  AlpacaPosition,
} from './execution/alpaca/alpaca-client.js';
import type { FaultKind } from './journal/faults.js';
import { CapitalConfigStore } from './risk/index.js';
import { type LeaseWait, RunLease, withRunLease } from './run-lease.js';

const FX = 1.25;
const OPEN = new Set(['new', 'accepted', 'held', 'partially_filled']);
// The open listing and filled-bracket legs as measured in #2086
const LISTED_OPEN = new Set(['new', 'accepted', 'partially_filled']);

const SPEC: SleeveSpec = {
  capitalShare: 1,
  minimumCapitalGbp: 0,
  capacityGbp: Number.POSITIVE_INFINITY,
  validation: 'forward-paper',
  macroGate: false,
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

function longEntry(instrument: string): SleeveDecision {
  return {
    sleeve_id: 'debate',
    instrument,
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
}

const entryId = (date: string, instrument: string) => `v2-debate-primary-${date}-${instrument}`;
const AAPL_ENTRY = entryId('2026-09-28', 'AAPL');

class FakeAlpacaClient implements AlpacaBrokerClient {
  readonly orders: AlpacaOrder[] = [];
  readonly cancelled: string[] = [];
  down: Error | undefined;
  rejectNextSubmit: Error | undefined;
  ocoStopStatus = 'held';

  #reachable(): void {
    if (this.down !== undefined) throw this.down;
  }

  submitOrder(request: AlpacaBracketOrderRequest): Promise<AlpacaOrder> {
    return this.#answer(() => {
      const rejection = this.rejectNextSubmit;
      this.rejectNextSubmit = undefined;
      if (rejection !== undefined) throw rejection;
      this.#refuseReused(request.client_order_id, 'submitOrder');
      const id = `alp-${this.orders.length + 1}`;
      const leg = (suffix: string, type: 'limit' | 'stop', price: string) => ({
        id: `${id}-${suffix}`,
        client_order_id: `${id}-${suffix}-uuid`,
        side: request.side === 'buy' ? ('sell' as const) : ('buy' as const),
        qty: request.qty,
        type,
        status: 'held',
        filled_qty: '0',
        filled_avg_price: null,
        filled_at: null,
        ...(type === 'stop' ? { stop_price: price } : { limit_price: price }),
      });
      const order: AlpacaOrder = {
        id,
        client_order_id: request.client_order_id,
        symbol: request.symbol,
        side: request.side,
        qty: request.qty,
        order_class: 'bracket',
        type: 'limit',
        status: 'new',
        filled_qty: '0',
        filled_avg_price: null,
        filled_at: null,
        limit_price: request.limit_price,
        legs: [
          leg('tp', 'limit', request.take_profit.limit_price),
          leg('sl', 'stop', request.stop_loss.stop_price),
        ],
      };
      this.orders.push(order);
      return structuredClone(order);
    });
  }

  submitMarketOrder(request: AlpacaMarketOrderRequest): Promise<AlpacaOrder> {
    return this.#answer(() => {
      const order: AlpacaOrder = {
        id: `alp-${this.orders.length + 1}`,
        client_order_id: request.client_order_id,
        symbol: request.symbol,
        side: request.side,
        qty: request.qty,
        order_class: 'simple',
        type: 'market',
        status: 'accepted',
        filled_qty: '0',
        filled_avg_price: null,
        filled_at: null,
      };
      this.orders.push(order);
      return structuredClone(order);
    });
  }

  // The OCO wire is unmeasured (#2090 item 1): the parent is the take-profit limit and the stop is
  // its one leg, as Alpaca's order docs describe it, resting in `ocoStopStatus`
  submitOcoOrder(request: AlpacaOcoOrderRequest): Promise<AlpacaOrder> {
    return this.#answer(() => {
      this.#refuseReused(request.client_order_id, 'submitOcoOrder');
      const id = `alp-${this.orders.length + 1}`;
      const order: AlpacaOrder = {
        id,
        client_order_id: request.client_order_id,
        symbol: request.symbol,
        side: request.side,
        qty: request.qty,
        order_class: 'oco',
        type: 'limit',
        status: 'new',
        filled_qty: '0',
        filled_avg_price: null,
        filled_at: null,
        limit_price: request.take_profit.limit_price,
        legs: [
          {
            id: `${id}-sl`,
            client_order_id: `${id}-sl-uuid`,
            side: request.side,
            qty: request.qty,
            type: 'stop',
            status: this.ocoStopStatus,
            filled_qty: '0',
            filled_avg_price: null,
            filled_at: null,
            stop_price: request.stop_loss.stop_price,
          },
        ],
      };
      this.orders.push(order);
      return structuredClone(order);
    });
  }

  cancelOrder(alpacaOrderId: string): Promise<void> {
    return this.#answer(() => {
      const parts = this.orders.flatMap((order) => [order, ...(order.legs ?? [])]);
      const target = parts.find((part) => part.id === alpacaOrderId && OPEN.has(part.status));
      if (target !== undefined) target.status = 'canceled';
      this.cancelled.push(alpacaOrderId);
    });
  }

  getOrder(alpacaOrderId: string): Promise<AlpacaOrder> {
    return this.#answer(() => {
      const order = this.orders.find((candidate) => candidate.id === alpacaOrderId);
      if (order !== undefined) return structuredClone(order);
      const leg = this.orders
        .flatMap((parent) => this.#flatLegs(parent))
        .find((candidate) => candidate.id === alpacaOrderId);
      if (leg === undefined) throw new Error(`404 no order ${alpacaOrderId}`);
      return leg;
    });
  }

  getOrderByClientOrderId(clientOrderId: string): Promise<AlpacaOrder | null> {
    return this.#answer(() => {
      const order = this.orders.find((candidate) => candidate.client_order_id === clientOrderId);
      return order === undefined ? null : structuredClone(order);
    });
  }

  listOpenOrders(): Promise<AlpacaOrder[]> {
    return this.#answer(() => this.orders.flatMap((order) => this.#openParts(order)));
  }

  listOrderHistory(symbols: readonly string[]): Promise<AlpacaOrder[]> {
    return this.#answer(() =>
      structuredClone(this.orders.filter((order) => symbols.includes(order.symbol)).reverse()),
    );
  }

  getPositions(): Promise<AlpacaPosition[]> {
    return this.#answer(() =>
      [...this.#netQty()].flatMap(([symbol, qty]) =>
        qty === 0
          ? []
          : [
              {
                symbol,
                qty: String(Math.abs(qty)),
                side: qty > 0 ? ('long' as const) : ('short' as const),
                avg_entry_price: '20',
              },
            ],
      ),
    );
  }

  getAccount(): Promise<AlpacaAccount> {
    return this.#answer(() => ({ cash: '100000', equity: '100000' }));
  }

  fillEntry(clientOrderId: string, price: number, at: Date): void {
    const order = this.#byClientId(clientOrderId);
    Object.assign(order, {
      status: 'filled',
      filled_qty: order.qty,
      filled_avg_price: String(price),
      filled_at: at.toISOString(),
    });
    for (const leg of order.legs ?? []) leg.status = leg.type === 'stop' ? 'held' : 'new';
  }

  triggerStop(clientOrderId: string, price: number, at: Date): void {
    const order = this.#byClientId(clientOrderId);
    for (const leg of order.legs ?? []) {
      const filled = leg.type === 'stop';
      Object.assign(leg, {
        status: filled ? 'filled' : 'canceled',
        filled_qty: filled ? order.qty : '0',
        filled_avg_price: filled ? String(price) : null,
        filled_at: filled ? at.toISOString() : null,
      });
    }
  }

  restingStop(clientOrderId: string): string | undefined {
    const stop = this.#byClientId(clientOrderId).legs?.find((leg) => leg.type === 'stop');
    return stop !== undefined && OPEN.has(stop.status) ? (stop.stop_price ?? undefined) : undefined;
  }

  bracketsFor(symbol: string): number {
    return this.#ordersOf(symbol, 'bracket');
  }

  ocosFor(symbol: string): number {
    return this.#ordersOf(symbol, 'oco');
  }

  restingStops(symbol: string): (string | null | undefined)[] {
    return this.orders
      .filter((order) => order.symbol === symbol)
      .flatMap((order) => order.legs ?? [])
      .filter((leg) => leg.type === 'stop' && OPEN.has(leg.status))
      .map((leg) => leg.stop_price);
  }

  #ordersOf(symbol: string, orderClass: string): number {
    return this.orders.filter(
      (order) => order.symbol === symbol && order.order_class === orderClass,
    ).length;
  }

  #refuseReused(clientOrderId: string, call: string): void {
    if (this.orders.some((order) => order.client_order_id === clientOrderId)) {
      throw new AlpacaBrokerProviderError(
        `Alpaca API error: 422 client_order_id must be unique (${call})`,
        422,
        '40010001',
        'client_order_id must be unique',
        'POST',
      );
    }
  }

  #byClientId(clientOrderId: string): AlpacaOrder {
    const order = this.orders.find((candidate) => candidate.client_order_id === clientOrderId);
    if (order === undefined) throw new Error(`fake: no order ${clientOrderId}`);
    return order;
  }

  #flatLegs(order: AlpacaOrder): AlpacaOrder[] {
    return (order.legs ?? []).map((leg) => ({
      ...structuredClone(leg),
      client_order_id: leg.client_order_id ?? leg.id,
      symbol: order.symbol,
      side: leg.side ?? order.side,
      qty: leg.qty ?? order.qty,
      order_class: order.order_class,
    }));
  }

  #openParts(order: AlpacaOrder): AlpacaOrder[] {
    const { legs: _legs, ...parent } = structuredClone(order);
    const listedLegs = this.#flatLegs(order).filter((leg) => LISTED_OPEN.has(leg.status));
    return LISTED_OPEN.has(order.status) ? [parent, ...listedLegs] : listedLegs;
  }

  #netQty(): Map<string, number> {
    const net = new Map<string, number>();
    const add = (symbol: string, side: 'buy' | 'sell', qty: string) =>
      net.set(symbol, (net.get(symbol) ?? 0) + (side === 'buy' ? 1 : -1) * Number(qty));
    for (const order of this.orders) {
      if (order.status === 'filled') add(order.symbol, order.side, order.filled_qty);
      const closing = order.side === 'buy' ? 'sell' : 'buy';
      for (const leg of order.legs ?? []) {
        if (leg.status === 'filled') add(order.symbol, closing, leg.filled_qty);
      }
    }
    return net;
  }

  #answer<T>(work: () => T): Promise<T> {
    try {
      this.#reachable();
      return Promise.resolve(work());
    } catch (error) {
      return Promise.reject(error);
    }
  }
}

function dailyBar(date: string): V2Bar {
  return {
    date,
    open: 20,
    high: 20.5,
    low: 19.5,
    close: 20,
    volume: 1_000_000,
    rawClose: 20,
  };
}

class FakeMarket implements MarketData {
  lastBarOn: string | undefined;

  lastBarBefore(_instrument: string, tradingDate: string): V2Bar | undefined {
    return dailyBar(this.#lastDate(tradingDate));
  }

  barsBefore(_instrument: string, tradingDate: string, count: number): readonly V2Bar[] {
    const last = this.#lastDate(tradingDate);
    return Array.from({ length: count }, (_, back) => dailyBar(addDays(last, back + 1 - count)));
  }

  gbpUsdAtYearStart(): number {
    return FX;
  }

  gbpUsdYearStartFixDate(): string {
    return '2025-12-31';
  }

  gbpUsdOnDay() {
    return { gbpUsd: FX, fixDate: '2025-12-31' };
  }

  #lastDate(tradingDate: string): string {
    const dayBefore = addDays(tradingDate, -1);
    return this.lastBarOn !== undefined && this.lastBarOn < dayBefore ? this.lastBarOn : dayBefore;
  }
}

interface Drill {
  readonly db: StoreHandle;
  readonly clock: SimulatedClock;
  readonly broker: FakeAlpacaClient;
  readonly market: FakeMarket;
  readonly logs: LogEntry[];
  cycle: CycleComposition;
  decisions: readonly SleeveDecision[];
  run(tradingDate: string, at?: string): ReturnType<typeof runCycle>;
  restart(): void;
  faultKinds(tradingDate: string): [FaultKind, string][];
  refusalParameters(tradingDate: string): string[];
  reconciles(tradingDate: string): string[];
  protectingStops(tradingDate: string): unknown[];
}

function drill(options: { sessions?: boolean } = {}): Drill {
  const db = migratedMemoryStore();
  const clock = new SimulatedClock(new Date('2026-01-01T00:00:00.000Z'));
  new CapitalConfigStore(db, clock).setYear(2026, 1_000, 1_500);
  const broker = new FakeAlpacaClient();
  const market = new FakeMarket();
  const logs: LogEntry[] = [];
  let tradingDate = '2026-09-28';
  let decisions: readonly SleeveDecision[] = [];
  const sleeve: Sleeve = {
    id: 'debate',
    spec: SPEC,
    universe: () => ({ instruments: decisions.map((d) => d.instrument), refusals: [] }),
    decide: () => Promise.resolve({ decisions, refusals: [] }),
  };
  const compose = (): CycleComposition =>
    composeCycle({
      db,
      clock,
      logger: { log: (entry) => logs.push(entry) },
      market,
      sleeves: [sleeve],
      openingDate: '2026-09-01',
      tradingDate: () => tradingDate,
      dryRun: false,
      brokerMode: 'paper',
      halfSpreadBps: () => 5,
      alpacaClient: broker,
      venueSessions: options.sessions === true ? TABLE_VENUE_SESSIONS : undefined,
    });
  const rows = <T>(sql: string, date: string) => db.prepare(sql).all(date) as T[];
  const state: Drill = {
    db,
    clock,
    broker,
    market,
    logs,
    cycle: compose(),
    get decisions() {
      return decisions;
    },
    set decisions(next) {
      decisions = next;
    },
    run: (date, at = `${date}T06:30:00.000Z`) => {
      tradingDate = date;
      clock.advanceTo(new Date(at));
      return runCycle(state.cycle, date);
    },
    restart: () => {
      state.cycle = compose();
    },
    faultKinds: (date) =>
      state.cycle.faults.faultsOn(date).map((fault) => [fault.kind, fault.code]),
    refusalParameters: (date) =>
      rows<{ parameter: string }>(
        'SELECT parameter FROM v2_refusals WHERE trading_date = ?',
        date,
      ).map((row) => row.parameter),
    reconciles: (date) =>
      rows<{ status: string }>(
        "SELECT status FROM v2_reconciles WHERE trading_date = ? AND venue = 'alpaca' ORDER BY reconcile_id",
        date,
      ).map((row) => row.status),
    protectingStops: (date) =>
      rows<{ protecting_stops: string }>(
        "SELECT protecting_stops FROM v2_reconciles WHERE trading_date = ? AND venue = 'alpaca' AND source = 'broker'",
        date,
      ).flatMap((row) => JSON.parse(row.protecting_stops) as unknown[]),
  };
  return state;
}

async function holdAapl(subject: Drill): Promise<void> {
  subject.decisions = [longEntry('AAPL')];
  await subject.run('2026-09-28');
  subject.broker.fillEntry(AAPL_ENTRY, 20, subject.clock.now());
  subject.decisions = [];
  await subject.run('2026-09-29');
}

describe('Step 4b fault matrix (#1747)', () => {
  it('baseline: a held position has one bracket, its stop resting, a clean reconcile and no fault', async () => {
    const subject = drill();
    await holdAapl(subject);
    expect(subject.cycle.books.position('debate/primary', 'AAPL')?.qty).toBeGreaterThan(0);
    expect(subject.broker.restingStop(AAPL_ENTRY)).toBe('19.20');
    expect(subject.reconciles('2026-09-29')).toEqual(['clean']);
    expect(subject.faultKinds('2026-09-29')).toEqual([]);
    expect(subject.protectingStops('2026-09-29')).toEqual([
      {
        clientOrderId: 'alp-1-sl-uuid',
        instrument: 'AAPL',
        protects: 'long',
        qty: 6,
        stopPrice: 19.2,
      },
    ]);
  });

  it('a bracket stop cancelled at the venue still reconciles unprotected through the held-leg read (#2086)', async () => {
    const subject = drill();
    await holdAapl(subject);
    const stop = subject.broker.orders[0]?.legs?.find((leg) => leg.type === 'stop');
    if (stop === undefined) throw new Error('drill: no stop leg');
    stop.status = 'canceled';
    await subject.run('2026-09-30');
    expect(subject.reconciles('2026-09-30')[0]).toBe('mismatch');
    expect(subject.faultKinds('2026-09-30')).toContainEqual([
      'missed_stop',
      'position_unprotected',
    ]);
  });

  it.each(['held', 'new'])(
    're-arm: a stop cancelled at the venue is re-armed as an OCO whose stop rests %s, and the next run reconciles clean with no second cancel (#2090)',
    async (ocoStopStatus) => {
      const subject = drill();
      subject.broker.ocoStopStatus = ocoStopStatus;
      await holdAapl(subject);
      const stop = subject.broker.orders[0]?.legs?.find((leg) => leg.type === 'stop');
      if (stop === undefined) throw new Error('drill: no stop leg');
      stop.status = 'canceled';
      await subject.run('2026-09-30');
      expect(subject.reconciles('2026-09-30')).toEqual(['mismatch']);
      expect(subject.broker.ocosFor('AAPL')).toBe(1);
      expect(subject.broker.restingStops('AAPL')).toEqual(['19.20']);
      const cancels = [...subject.broker.cancelled];
      subject.restart();
      await subject.run('2026-10-01');
      expect(subject.reconciles('2026-10-01')).toEqual(['clean']);
      expect(subject.refusalParameters('2026-10-01')).not.toContain('BROKER_RECONCILE');
      expect(subject.faultKinds('2026-10-01')).toEqual([]);
      expect(subject.broker.cancelled).toEqual(cancels);
      expect(subject.broker.ocosFor('AAPL')).toBe(1);
      expect(subject.broker.restingStops('AAPL')).toEqual(['19.20']);
      const oco = subject.broker.orders.find((order) => order.order_class === 'oco');
      expect(subject.protectingStops('2026-10-01')).toEqual([
        expect.objectContaining({
          clientOrderId: oco?.legs?.[0]?.client_order_id,
          stopPrice: 19.2,
        }),
      ]);
    },
  );

  it('a filled bracket whose stop leg Alpaca holds off the open listing reconciles clean and is never re-armed (#2086)', async () => {
    const subject = drill();
    await holdAapl(subject);
    await subject.run('2026-09-30');
    expect(subject.reconciles('2026-09-29')).toEqual(['clean']);
    expect(subject.reconciles('2026-09-30')).toEqual(['clean']);
    expect(subject.refusalParameters('2026-09-30')).not.toContain('BROKER_RECONCILE');
    expect(subject.broker.cancelled).toEqual([]);
    expect(subject.broker.restingStop(AAPL_ENTRY)).toBe('19.20');
  });

  it('broker API down: no entry, the run still marks, the resting stop is untouched, both failed reads are ledgered', async () => {
    const subject = drill();
    await holdAapl(subject);
    subject.broker.down = new Error('connect ECONNREFUSED paper-api.alpaca.markets');
    subject.decisions = [longEntry('MSFT')];
    const report = await subject.run('2026-09-30');
    expect(report).toMatchObject({ skipped: false, submitted_orders: 0, rejected_orders: 0 });
    expect(subject.cycle.journal.orderFor(entryId('2026-09-30', 'MSFT'))).toBeUndefined();
    expect(subject.refusalParameters('2026-09-30')).toContain('BROKER_RECONCILE_READ');
    expect(subject.cycle.books.isMarked('2026-09-30')).toBe(true);
    expect(subject.broker.restingStop(AAPL_ENTRY)).toBe('19.20');
    expect(subject.broker.cancelled).toEqual([]);
    expect(subject.cycle.books.position('debate/primary', 'AAPL')?.qty).toBeGreaterThan(0);
    expect(subject.reconciles('2026-09-30')).toEqual(['read_failed']);
    expect(subject.faultKinds('2026-09-30')).toEqual(
      expect.arrayContaining([
        ['failed_broker_call', 'v2_fill_sweep_failed'],
        ['failed_broker_call', 'BROKER_RECONCILE_READ'],
      ]),
    );
    subject.broker.down = undefined;
    await subject.run('2026-10-01');
    expect(subject.broker.bracketsFor('MSFT')).toBe(1);
    expect(subject.reconciles('2026-10-01')).toEqual(['clean']);
  });

  it('rejected order: journalled rejected, no position or reserved cash, ledgered, and reconcile stays clean', async () => {
    const subject = drill();
    subject.broker.rejectNextSubmit = new AlpacaBrokerProviderError(
      'Alpaca API error: 403 insufficient buying power (submitOrder)',
      403,
      '40310000',
      'insufficient buying power',
      'POST',
    );
    subject.decisions = [longEntry('AAPL')];
    const cash = subject.cycle.books.cash('debate/primary');
    const report = await subject.run('2026-09-28');
    expect(report).toMatchObject({ rejected_orders: 1, submitted_orders: 0 });
    expect(subject.cycle.journal.orderFor(AAPL_ENTRY)).toMatchObject({
      outcome: 'rejected',
      payload: {
        detail:
          'alpaca submitBracket failed (status 403, code 40310000): insufficient buying power',
      },
    });
    expect(subject.cycle.books.position('debate/primary', 'AAPL')).toBeUndefined();
    expect(subject.cycle.books.cash('debate/primary')).toBe(cash);
    expect(subject.faultKinds('2026-09-28')).toEqual([['failed_broker_call', 'entry_rejected']]);
    subject.decisions = [];
    await subject.run('2026-09-29');
    expect(subject.reconciles('2026-09-29')).toEqual(['clean']);
    expect(subject.broker.bracketsFor('AAPL')).toBe(0);
  });

  it('stale data: no entry on an uncovered window, the held mark and the calendar reference are ledgered stale, the stop rests', async () => {
    const subject = drill();
    await holdAapl(subject);
    subject.market.lastBarOn = '2026-09-22';
    subject.decisions = [longEntry('MSFT')];
    const report = await subject.run('2026-09-30');
    expect(report.submitted_orders).toBe(0);
    expect(subject.broker.bracketsFor('MSFT')).toBe(0);
    expect(subject.refusalParameters('2026-09-30')).toEqual(
      expect.arrayContaining(['CALENDAR_REFERENCE', 'ADV_WINDOW_COVERAGE', 'MARK_FRESHNESS']),
    );
    expect(subject.faultKinds('2026-09-30')).toEqual(
      expect.arrayContaining([
        ['stale_bar', 'CALENDAR_REFERENCE'],
        ['stale_bar', 'MARK_FRESHNESS'],
      ]),
    );
    expect(subject.broker.restingStop(AAPL_ENTRY)).toBe('19.20');
    expect(subject.cycle.books.position('debate/primary', 'AAPL')?.qty).toBeGreaterThan(0);
  });

  // 2026-10-25 to 2026-11-01 London is on GMT while New York is still on EDT, so the US open is
  // 13:30 UTC that week and 14:30 UTC the week after
  it('clock/DST: the US entry cutoff follows New York across the change, so one UTC instant is late one week and in time the next', async () => {
    const subject = drill({ sessions: true });
    subject.decisions = [longEntry('AAPL')];
    await subject.run('2026-10-27', '2026-10-27T13:45:00.000Z');
    expect(subject.broker.bracketsFor('AAPL')).toBe(0);
    expect(subject.refusalParameters('2026-10-27')).toContain('late_wake_entry_cutoff');
    await subject.run('2026-11-03', '2026-11-03T13:45:00.000Z');
    expect(subject.broker.bracketsFor('AAPL')).toBe(1);
    expect(subject.refusalParameters('2026-11-03')).not.toContain('late_wake_entry_cutoff');
  });

  it('holiday: a US-closed day sits the Alpaca entry out, and a day both venues closed is not a missed run', async () => {
    const subject = drill({ sessions: true });
    subject.decisions = [longEntry('AAPL')];
    await subject.run('2026-11-26');
    expect(subject.broker.bracketsFor('AAPL')).toBe(0);
    expect(subject.refusalParameters('2026-11-26')).toContain('venue_closed');
    subject.decisions = [];
    await subject.run('2026-12-24');
    subject.cycle.faults.recordMissedRuns(
      () => subject.cycle.books.lastDay('debate/primary')?.tradingDate,
      '2026-12-29',
      bothVenuesClosed,
    );
    expect(subject.faultKinds('2026-12-25')).toEqual([]);
    expect(subject.faultKinds('2026-12-28')).toEqual([['missed_run', 'CYCLE_NOT_RUN']]);
  });

  it('duplicate run (lease): a second process waits out the held lease and fails without running the cycle', async () => {
    const subject = drill();
    subject.decisions = [longEntry('AAPL')];
    const holder = new RunLease(subject.db, subject.clock, () => true, 1_001);
    const release = holder.tryAcquire('signals');
    const second = new RunLease(subject.db, subject.clock, () => true, 1_002);
    let nowMs = 0;
    const wait: LeaseWait = {
      timeoutMs: 10,
      pollMs: 5,
      sleep: () => Promise.resolve(),
      nowMs: () => {
        nowMs += 5;
        return nowMs;
      },
    };
    const cycle = vi.fn(() => subject.run('2026-09-28'));
    await expect(withRunLease(second, 'cycle', wait, cycle)).rejects.toThrow(
      /run lease not acquired for cycle .* held by signals \(pid 1001\)/,
    );
    expect(cycle).not.toHaveBeenCalled();
    expect(subject.broker.orders).toEqual([]);
    release?.();
    await withRunLease(second, 'cycle', wait, cycle);
    expect(subject.broker.bracketsFor('AAPL')).toBe(1);
  });

  it('duplicate run (same date): a rerun of a marked date skips and sends nothing to the broker', async () => {
    const subject = drill();
    subject.decisions = [longEntry('AAPL')];
    await subject.run('2026-09-28');
    const rerun = await subject.run('2026-09-28', '2026-09-28T07:00:00.000Z');
    expect(rerun).toMatchObject({ skipped: true, submitted_orders: 0 });
    expect(subject.broker.bracketsFor('AAPL')).toBe(1);
  });

  it('crash mid-order (after the journal): the retry of the unmarked date sends no second bracket and marks the day', async () => {
    const subject = drill();
    subject.decisions = [longEntry('AAPL')];
    vi.spyOn(subject.cycle.books, 'markDay').mockImplementationOnce(() => {
      throw new Error('SIGKILL');
    });
    await expect(subject.run('2026-09-28')).rejects.toThrow('SIGKILL');
    subject.restart();
    const retry = await subject.run('2026-09-28', '2026-09-28T07:00:00.000Z');
    expect(retry).toMatchObject({ skipped: false, submitted_orders: 0 });
    expect(subject.broker.bracketsFor('AAPL')).toBe(1);
    expect(subject.cycle.books.isMarked('2026-09-28')).toBe(true);
    expect(subject.reconciles('2026-09-28')).toEqual(['clean', 'clean']);
  });

  // David 2026-10-04 (#1747): the entry is journalled pending before it is sent, so a crash
  // between the send and its outcome leaves an id the next run finds at the venue
  it('crash mid-order (after the send): the retry finds the pending entry at the broker, reconciles clean and books its fill', async () => {
    const subject = drill();
    subject.decisions = [longEntry('AAPL')];
    vi.spyOn(subject.cycle.journal, 'settleOrder').mockImplementationOnce(() => {
      throw new Error('SIGKILL');
    });
    await expect(subject.run('2026-09-28')).rejects.toThrow('SIGKILL');
    expect(subject.broker.bracketsFor('AAPL')).toBe(1);
    expect(subject.cycle.journal.orderFor(AAPL_ENTRY)?.outcome).toBe('pending');
    subject.restart();
    const retry = await subject.run('2026-09-28', '2026-09-28T07:00:00.000Z');
    expect(retry).toMatchObject({ skipped: false, submitted_orders: 0 });
    expect(subject.broker.bracketsFor('AAPL')).toBe(1);
    expect(subject.cycle.journal.orderFor(AAPL_ENTRY)).toMatchObject({
      outcome: 'submitted',
      payload: { detail: 'submitted', resolved: '2026-09-28', approval: expect.any(String) },
    });
    expect(subject.reconciles('2026-09-28')).toEqual(['clean', 'clean']);
    expect(subject.faultKinds('2026-09-28')).toEqual([
      ['stuck_order', 'v2_pending_order_resolved'],
    ]);
    subject.broker.fillEntry(AAPL_ENTRY, 20, subject.clock.now());
    subject.decisions = [longEntry('MSFT')];
    await subject.run('2026-09-29');
    expect(subject.cycle.books.position('debate/primary', 'AAPL')?.qty).toBe(6);
    expect(subject.reconciles('2026-09-29')).toEqual(['clean']);
    expect(subject.broker.bracketsFor('MSFT')).toBe(1);
    expect(subject.broker.restingStop(AAPL_ENTRY)).toBe('19.20');
    expect(subject.faultKinds('2026-09-29')).toEqual([]);
  });

  it('crash mid-order (before the send): the pending entry the broker never saw resolves rejected, a missed entry with no position', async () => {
    const subject = drill();
    subject.decisions = [longEntry('AAPL')];
    const cash = subject.cycle.books.cash('debate/primary');
    vi.spyOn(subject.cycle.executor, 'submit').mockRejectedValueOnce(new Error('SIGKILL'));
    await expect(subject.run('2026-09-28')).rejects.toThrow('SIGKILL');
    expect(subject.cycle.journal.orderFor(AAPL_ENTRY)?.outcome).toBe('pending');
    subject.restart();
    const retry = await subject.run('2026-09-28', '2026-09-28T07:00:00.000Z');
    expect(retry).toMatchObject({ skipped: false, submitted_orders: 0 });
    expect(subject.broker.orders).toEqual([]);
    expect(subject.cycle.journal.orderFor(AAPL_ENTRY)).toMatchObject({
      outcome: 'rejected',
      payload: { detail: expect.stringMatching(/^not_sent: /), resolved: '2026-09-28' },
    });
    expect(subject.cycle.journal.restingEntries('debate/primary')).toEqual([]);
    expect(subject.reconciles('2026-09-28')).toEqual(['clean', 'clean']);
    expect(subject.faultKinds('2026-09-28')).toEqual([
      ['stuck_order', 'v2_pending_order_resolved'],
    ]);
    expect(subject.cycle.books.position('debate/primary', 'AAPL')).toBeUndefined();
    expect(subject.cycle.books.cash('debate/primary')).toBe(cash);
    await subject.run('2026-09-29');
    expect(subject.broker.bracketsFor('AAPL')).toBe(1);
    expect(subject.reconciles('2026-09-29')).toEqual(['clean']);
  });

  it('restart with an open position: a fresh process reconciles clean, leaves the stop resting and books its later fill', async () => {
    const subject = drill();
    await holdAapl(subject);
    const held = subject.cycle.books.position('debate/primary', 'AAPL')?.qty;
    subject.restart();
    subject.decisions = [longEntry('AAPL')];
    await subject.run('2026-09-30');
    expect(subject.broker.bracketsFor('AAPL')).toBe(1);
    expect(subject.broker.cancelled).toEqual([]);
    expect(subject.reconciles('2026-09-30')).toEqual(['clean']);
    expect(subject.cycle.books.position('debate/primary', 'AAPL')?.qty).toBe(held);
    subject.broker.triggerStop(AAPL_ENTRY, 19.2, subject.clock.now());
    subject.restart();
    subject.decisions = [];
    await subject.run('2026-10-01');
    expect(subject.cycle.books.position('debate/primary', 'AAPL')).toBeUndefined();
    expect(subject.reconciles('2026-10-01')).toEqual(['clean']);
    expect(subject.faultKinds('2026-10-01')).toEqual([]);
  });

  it.todo('Mac asleep: a missed launchd wake and the late-wake cutoff on the real host (#2002)');
  it.todo('broker partial fill: protective legs on a part-filled, then cancelled, bracket (#1938)');
});
