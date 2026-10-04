import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  MarketData,
  RiskApprovedOrder,
  Sleeve,
  SleeveSpec,
} from '../../../contracts/index.js';
import {
  type BrokerAck,
  type LogEntry,
  type NormalizedFill,
  SimulatedClock,
  toBrokerFillId,
} from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { migratedMemoryStore } from '../../shared/store/migrated-template.js';
import { severityOf } from './alerts.js';
import { type CycleComposition, composeCycle } from './compose.js';
import { DryRunBrokerAdapter } from './execution/dry-run-broker.js';
import { V2OrderExecutor } from './execution/executor.js';
import {
  FLATTEN_POLL_MS,
  FlattenLedger,
  type FlattenTarget,
  flattenControl,
  flattenUnderLease,
} from './flatten.js';
import { FlattenLoop } from './flatten-loop.js';
import { CapitalConfigStore } from './risk/index.js';
import { RunLease } from './run-lease.js';

const D = '2026-10-02';
const MID_DAY = new Date(`${D}T14:00:00.000Z`);

const SPEC: SleeveSpec = {
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

const SLEEVE: Sleeve = {
  id: 'debate',
  spec: SPEC,
  universe: () => ({ instruments: [], refusals: [] }),
  decide: () => Promise.reject(new Error('a flatten never asks a sleeve to decide')),
};

const MARKET: MarketData = {
  lastBarBefore: () => ({
    date: '2026-10-01',
    open: 20,
    high: 20.5,
    low: 19.5,
    close: 20,
    volume: 1_000_000,
    rawClose: 20,
  }),
  barsBefore: () => [],
  gbpUsdAtYearStart: () => 1.25,
  gbpUsdYearStartFixDate: () => '2025-12-31',
};

class FakeAlpaca extends DryRunBrokerAdapter {
  readonly flattens: string[] = [];
  readonly cancelled: string[] = [];
  readonly fills: NormalizedFill[] = [];
  readonly filled = new Set<string>();
  flattenError: Error | undefined;
  cancelError: Error | undefined;
  hangOn: string | undefined;

  override submitFlatten(
    _instrument: string,
    _side: 'buy' | 'sell',
    _size: number,
    clientOrderId: string,
  ): Promise<BrokerAck> {
    if (clientOrderId === this.hangOn) return new Promise<never>(() => {});
    if (this.flattenError !== undefined) return Promise.reject(this.flattenError);
    this.flattens.push(clientOrderId);
    return Promise.resolve({
      client_order_id: clientOrderId,
      broker_order_ids: [`f-${clientOrderId}`],
      order_state: 'submitted',
    });
  }

  override cancel(...[clientOrderId = '']: string[]): Promise<void> {
    if (this.filled.has(clientOrderId)) return Promise.reject(new Error('order already filled'));
    if (this.cancelError !== undefined) return Promise.reject(this.cancelError);
    this.cancelled.push(clientOrderId);
    return Promise.resolve();
  }

  override fetchNewFills(): Promise<NormalizedFill[]> {
    return Promise.resolve(this.fills.splice(0));
  }

  fillEntry(clientOrderId: string, qty: number): void {
    this.filled.add(clientOrderId);
    this.fills.push({
      client_order_id: clientOrderId,
      broker_fill_id: toBrokerFillId(`fill-${clientOrderId}`),
      leg: 'entry',
      price: 25,
      qty,
      fee: 0,
      timestamp: MID_DAY.toISOString(),
    });
  }
}

interface Harness {
  readonly db: StoreHandle;
  readonly clock: SimulatedClock;
  readonly cycle: CycleComposition;
  readonly alpaca: FakeAlpaca;
  readonly logs: LogEntry[];
  readonly approved: RiskApprovedOrder[];
}

const opened: StoreHandle[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const db of opened.splice(0)) db.close();
});

function newStore(): StoreHandle {
  const db = migratedMemoryStore();
  opened.push(db);
  new CapitalConfigStore(db, new SimulatedClock(new Date('2026-01-01T00:00:00.000Z'))).setYear(
    2026,
    10_000,
    1_500,
  );
  return db;
}

function harness(db: StoreHandle = newStore(), now: Date = MID_DAY): Harness {
  const clock = new SimulatedClock(now);
  const alpaca = new FakeAlpaca();
  const simulated = new DryRunBrokerAdapter();
  const logs: LogEntry[] = [];
  const cycle = composeCycle({
    db,
    clock,
    logger: { log: (entry) => logs.push(entry) },
    market: MARKET,
    sleeves: [SLEEVE],
    openingDate: '2026-09-01',
    tradingDate: () => D,
    dryRun: false,
    brokerMode: 'paper',
    halfSpreadBps: () => 5,
    brokerAccess: (pricing) => ({
      executor: new V2OrderExecutor({
        brokers: { alpaca },
        simulatedBrokers: {
          alpaca: simulated,
          saxo: simulated,
          saxo_cfd_gbp: simulated,
          saxo_cfd_usd: simulated,
        },
        pricing,
        dryRun: false,
      }),
      brokerBooks: { read: () => Promise.reject(new Error('a flatten never reconciles')) },
    }),
  });
  const approved: RiskApprovedOrder[] = [];
  const approveExit = cycle.risk.approveExit.bind(cycle.risk);
  vi.spyOn(cycle.risk, 'approveExit').mockImplementation((request) => {
    const order = approveExit(request);
    approved.push(order);
    return order;
  });
  return { db, clock, cycle, alpaca, logs, approved };
}

function hold(h: Harness, bookId: string, instrument: string, qty = 4): void {
  h.cycle.books.applyFill(bookId, {
    instrument,
    venue: 'alpaca',
    side: 'buy',
    leg: 'entry',
    qty,
    priceGbp: 20,
    feeGbp: 0,
    clientOrderId: `held-${bookId}-${instrument}`,
    tradingDate: '2026-09-30',
    stopGbp: undefined,
    targetGbp: undefined,
  });
}

function restingEntry(h: Harness, bookId: string, instrument: string): string {
  const clientOrderId = `v2-${bookId.replace('/', '-')}-${D}-${instrument}`;
  h.cycle.journal.recordOrder({
    client_order_id: clientOrderId,
    decision_id: null,
    book_id: bookId,
    trading_date: D,
    instrument,
    venue: 'alpaca',
    leg: 'entry',
    side: 'buy',
    dry_run: false,
    outcome: bookId === 'debate/primary' ? 'submitted' : 'simulated',
    payload: { size: 3, price: 25, stop: 24, target: 27 },
  });
  return clientOrderId;
}

let controlKey = 0;

function control(db: StoreHandle, action: 'pause' | 'halt' | 'resume', at: Date = MID_DAY): number {
  controlKey += 1;
  const { lastInsertRowid } = db
    .prepare(
      'INSERT INTO v2_controls (action, reason, source, idempotency_key, set_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(action, 'test', 'telegram', `flatten-test-${controlKey}`, at.toISOString());
  return Number(lastInsertRowid);
}

function flattenRows(db: StoreHandle) {
  return db
    .prepare(
      'SELECT control_id, event, trading_date, outcome, detail FROM v2_flattens ORDER BY flatten_id',
    )
    .all() as {
    control_id: number;
    event: string;
    trading_date: string;
    outcome: string | null;
    detail: string | null;
  }[];
}

interface Looped {
  readonly loop: FlattenLoop;
  readonly notes: string[];
  readonly loopLogs: LogEntry[];
  readonly closed: string[];
  readonly flushes: { count: number };
}

function loopOver(
  h: Harness,
  lease: RunLease = new RunLease(h.db, h.clock),
  prime: () => Promise<void> = () => Promise.resolve(),
): Looped {
  const notes: string[] = [];
  const loopLogs: LogEntry[] = [];
  const closed: string[] = [];
  const flushes = { count: 0 };
  const ledger = new FlattenLedger(h.db, h.clock);
  const loop = new FlattenLoop({
    ledger,
    clock: h.clock,
    logger: { log: (entry) => loopLogs.push(entry) },
    openRoot: (tradingDate) => ({
      flatten: (target) => flattenUnderLease(lease, { cycle: h.cycle, ledger, prime }, target),
      close: () => closed.push(tradingDate),
    }),
    notify: (text) => {
      notes.push(text);
      return Promise.resolve();
    },
    flush: () => {
      flushes.count += 1;
      return Promise.resolve();
    },
  });
  return { loop, notes, loopLogs, closed, flushes };
}

describe('intraday flatten (#1894, David 2026-10-02)', () => {
  it('a flatten sent mid-day closes every position within one poll interval, through risk.approveExit', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const h = harness();
    hold(h, 'debate/primary', 'AAPL', 4);
    hold(h, 'debate/primary', 'MSFT', 2);
    hold(h, 'debate/no-macro-gate', 'AAPL', 4);
    const resting = restingEntry(h, 'debate/primary', 'NVDA');
    const shadowResting = restingEntry(h, 'debate/no-macro-gate', 'NVDA');
    const filledToday = restingEntry(h, 'debate/primary', 'TSLA');
    h.alpaca.fillEntry(filledToday, 3);
    const { loop, notes, closed, flushes } = loopOver(h);

    const stop = loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.approved).toEqual([]);
    expect(closed).toEqual([]);
    const controlId = control(h.db, 'halt');
    await vi.advanceTimersByTimeAsync(FLATTEN_POLL_MS);
    stop();

    expect(
      h.approved.map((order) => [
        order.kind,
        order.bookId,
        order.instrument,
        order.side,
        order.size,
      ]),
    ).toEqual([
      ['flatten', 'debate/primary', 'AAPL', 'sell', 4],
      ['flatten', 'debate/primary', 'MSFT', 'sell', 2],
      ['flatten', 'debate/primary', 'TSLA', 'sell', 3],
      ['flatten', 'debate/no-macro-gate', 'AAPL', 'sell', 4],
    ]);
    expect(h.alpaca.flattens).toEqual([
      `v2-debate-primary-${D}-AAPL-exit`,
      `v2-debate-primary-${D}-MSFT-exit`,
      `v2-debate-primary-${D}-TSLA-exit`,
    ]);
    expect(h.alpaca.cancelled).toEqual([resting]);
    expect(h.cycle.journal.orderFor(resting)?.outcome).toBe('cancelled');
    expect(h.cycle.journal.orderFor(shadowResting)?.outcome).toBe('cancelled');
    expect(h.cycle.journal.orderFor(`v2-debate-primary-${D}-AAPL-exit`)).toMatchObject({
      outcome: 'submitted',
      leg: 'exit',
      payload: { reason: 'manual_halt', size: 4 },
    });
    expect(h.cycle.journal.orderFor(`v2-debate-no-macro-gate-${D}-AAPL-exit`)).toMatchObject({
      outcome: 'simulated',
    });
    for (const [bookId, instrument] of [
      ['debate/primary', 'AAPL'],
      ['debate/primary', 'MSFT'],
      ['debate/primary', 'TSLA'],
      ['debate/no-macro-gate', 'AAPL'],
    ] as const) {
      expect(h.cycle.books.position(bookId, instrument)?.exitClientOrderId).toBe(
        `v2-${bookId.replace('/', '-')}-${D}-${instrument}-exit`,
      );
    }
    const detail =
      'cancelled 2 resting entries; 4 exits: submitted 3, simulated 1, dry-run 0, rejected 0';
    expect(flattenRows(h.db)).toEqual([
      { control_id: controlId, event: 'started', trading_date: D, outcome: null, detail: null },
      { control_id: controlId, event: 'finished', trading_date: D, outcome: 'closed', detail },
    ]);
    expect(notes).toEqual([
      `Flatten done (control ${controlId}): every position has its exit in flight. ${detail}`,
    ]);
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        level: 'info',
        event: 'v2_flatten_closed',
        message: `flatten of control ${controlId} (${D}): ${detail}`,
      }),
    );
    expect(closed).toEqual([D]);
    expect(flushes.count).toBe(2);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM v2_run_lease').get()).toEqual({ n: 0 });
  });

  it('a repeated poll never acts on the same flatten again', async () => {
    const h = harness();
    hold(h, 'debate/primary', 'AAPL');
    control(h.db, 'halt');
    const { loop, notes, closed } = loopOver(h);

    await loop.tick();
    await loop.tick();
    await loop.tick();

    expect(h.approved).toHaveLength(1);
    expect(h.alpaca.flattens).toEqual([`v2-debate-primary-${D}-AAPL-exit`]);
    expect(flattenRows(h.db).map((row) => row.event)).toEqual(['started', 'finished']);
    expect(notes).toHaveLength(1);
    expect(closed).toEqual([D]);
  });

  it('a tick while a pass is in flight joins it instead of starting another', async () => {
    const h = harness();
    hold(h, 'debate/primary', 'AAPL');
    control(h.db, 'halt');
    let primed: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      primed = resolve;
    });
    const { loop, closed } = loopOver(h, undefined, () => gate);

    const first = loop.tick();
    const second = loop.tick();
    const settled = loop.settled();
    primed();
    await Promise.all([first, second, settled]);

    expect(h.alpaca.flattens).toHaveLength(1);
    expect(closed).toEqual([D]);
    await expect(loop.settled()).resolves.toBeUndefined();
  });

  it('a crash mid-flatten resumes on restart on the original trading date and never resends a sent exit', async () => {
    const db = newStore();
    const before = harness(db);
    hold(before, 'debate/primary', 'AAPL');
    hold(before, 'debate/primary', 'MSFT');
    const controlId = control(db, 'halt');
    before.alpaca.hangOn = `v2-debate-primary-${D}-MSFT-exit`;
    void loopOver(before).loop.tick();
    await vi.waitFor(() => expect(before.alpaca.flattens).toHaveLength(1));
    expect(flattenRows(db).map((row) => row.event)).toEqual(['started']);

    const nextDay = new Date('2026-10-03T09:00:00.000Z');
    const after = harness(db, nextDay);
    const deadHolder = new RunLease(db, after.clock, () => false);
    const { loop, notes } = loopOver(after, deadHolder);
    await loop.tick();

    expect(before.alpaca.flattens).toEqual([`v2-debate-primary-${D}-AAPL-exit`]);
    expect(after.alpaca.flattens).toEqual([`v2-debate-primary-${D}-MSFT-exit`]);
    expect(after.approved.map((order) => order.instrument)).toEqual(['MSFT']);
    expect(flattenRows(db)).toEqual([
      expect.objectContaining({ control_id: controlId, event: 'started', trading_date: D }),
      expect.objectContaining({
        control_id: controlId,
        event: 'finished',
        trading_date: D,
        outcome: 'closed',
      }),
    ]);
    expect(notes).toHaveLength(1);
    await loop.tick();
    expect(after.alpaca.flattens).toHaveLength(1);
  });

  it('a failed exit leg finishes the flatten as failed, raises a critical alert, and is not retried by the poller', async () => {
    const h = harness();
    hold(h, 'debate/primary', 'AAPL');
    hold(h, 'debate/no-macro-gate', 'AAPL');
    const controlId = control(h.db, 'halt');
    h.alpaca.flattenError = new Error('venue closed');
    const { loop, notes, flushes } = loopOver(h);

    await loop.tick();

    const [, finished] = flattenRows(h.db);
    expect(finished).toEqual({
      control_id: controlId,
      event: 'finished',
      trading_date: D,
      outcome: 'failed',
      detail:
        'cancelled 0 resting entries; 2 exits: submitted 0, simulated 1, dry-run 0, rejected 1; ' +
        'no exit in flight for debate/primary AAPL',
    });
    const alert = h.logs.find((entry) => entry.event === 'v2_flatten_leg_failed');
    expect(alert).toMatchObject({
      level: 'error',
      message: `flatten of control ${controlId} (${D}): ${finished?.detail}`,
    });
    expect(alert === undefined ? undefined : severityOf(alert)).toBe('critical');
    expect(h.cycle.books.position('debate/primary', 'AAPL')?.exitClientOrderId).toBeUndefined();
    expect(notes).toEqual([]);
    expect(flushes.count).toBe(1);

    h.alpaca.flattenError = undefined;
    await loop.tick();
    expect(h.alpaca.flattens).toEqual([]);
    expect(flattenRows(h.db)).toHaveLength(2);
  });

  it('an entry that will not cancel fails the flatten and names the order', async () => {
    const h = harness();
    const resting = restingEntry(h, 'debate/primary', 'NVDA');
    control(h.db, 'halt');
    h.alpaca.cancelError = new Error('cancel refused');

    const result = await flattenControl(
      {
        cycle: h.cycle,
        ledger: new FlattenLedger(h.db, h.clock),
        prime: () => Promise.resolve(),
      },
      { controlId: 1, tradingDate: D },
    );

    expect(result).toEqual({
      outcome: 'failed',
      detail: `cancelled 0 resting entries; 0 exits: submitted 0, simulated 0, dry-run 0, rejected 0; entries still resting: ${resting}`,
    });
  });

  it('a position the halt exit cannot route fails the flatten with the halt refusal', async () => {
    const h = harness();
    hold(h, 'debate/primary', 'AAPL');
    const controlId = control(h.db, 'halt');
    vi.spyOn(h.cycle.executor, 'canRoute').mockReturnValue(false);

    const result = await flattenControl(
      { cycle: h.cycle, ledger: new FlattenLedger(h.db, h.clock), prime: () => Promise.resolve() },
      { controlId, tradingDate: D },
    );

    expect(result.outcome).toBe('failed');
    expect(result.detail).toBe(
      'cancelled 0 resting entries; 0 exits: submitted 0, simulated 0, dry-run 0, rejected 0; ' +
        'no exit in flight for debate/primary AAPL; ' +
        'halt could not exit AAPL in debate/primary: no route to alpaca',
    );
  });

  it('with no positions and nothing resting, the flatten closes at once and sends nothing', async () => {
    const h = harness();
    const controlId = control(h.db, 'halt');
    const { loop, notes } = loopOver(h);

    await loop.tick();

    expect(h.approved).toEqual([]);
    expect(h.alpaca.flattens).toEqual([]);
    expect(h.alpaca.cancelled).toEqual([]);
    const detail =
      'cancelled 0 resting entries; 0 exits: submitted 0, simulated 0, dry-run 0, rejected 0';
    expect(flattenRows(h.db).at(-1)).toEqual({
      control_id: controlId,
      event: 'finished',
      trading_date: D,
      outcome: 'closed',
      detail,
    });
    expect(notes).toEqual([
      `Flatten done (control ${controlId}): every position has its exit in flight. ${detail}`,
    ]);
  });

  it('leaves a pause (Telegram halt), a resumed flatten and an empty control table alone', async () => {
    const h = harness();
    hold(h, 'debate/primary', 'AAPL');
    const { loop, closed } = loopOver(h);

    await loop.tick();
    control(h.db, 'pause');
    await loop.tick();
    control(h.db, 'halt');
    control(h.db, 'resume');
    await loop.tick();

    expect(closed).toEqual([]);
    expect(h.approved).toEqual([]);
    expect(flattenRows(h.db)).toEqual([]);
  });

  it('acts on a new flatten after an earlier one finished', async () => {
    const h = harness();
    const first = control(h.db, 'halt');
    const { loop } = loopOver(h);
    await loop.tick();
    control(h.db, 'resume');
    hold(h, 'debate/primary', 'AAPL');
    const second = control(h.db, 'halt');

    await loop.tick();

    expect(flattenRows(h.db).map((row) => [row.control_id, row.event, row.outcome])).toEqual([
      [first, 'started', null],
      [first, 'finished', 'closed'],
      [second, 'started', null],
      [second, 'finished', 'closed'],
    ]);
    expect(h.alpaca.flattens).toEqual([`v2-debate-primary-${D}-AAPL-exit`]);
  });

  it('defers while another run holds the lease and acts at the next poll', async () => {
    const h = harness();
    hold(h, 'debate/primary', 'AAPL');
    const controlId = control(h.db, 'halt');
    const lease = new RunLease(h.db, h.clock);
    const release = lease.tryAcquire('cycle');
    const { loop, loopLogs, closed } = loopOver(h, lease);

    await loop.tick();

    expect(loopLogs).toEqual([
      {
        trace_id: 'v2-flatten',
        stage: 'v2',
        level: 'info',
        event: 'v2_flatten_deferred',
        message: `control ${controlId}: run lease held by cycle (pid ${process.pid}); retried at the next poll`,
      },
    ]);
    expect(flattenRows(h.db)).toEqual([]);
    expect(h.alpaca.flattens).toEqual([]);
    expect(closed).toEqual([D]);

    release?.();
    await loop.tick();
    expect(h.alpaca.flattens).toEqual([`v2-debate-primary-${D}-AAPL-exit`]);
  });

  it('a pass that throws stays unfinished, alerts critical, and is retried at the next poll', async () => {
    const h = harness();
    hold(h, 'debate/primary', 'AAPL');
    control(h.db, 'halt');
    const prime = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('bars unavailable'))
      .mockResolvedValue(undefined);
    const { loop, loopLogs, closed, notes } = loopOver(h, undefined, prime);

    await loop.tick();

    const failed = loopLogs.find((entry) => entry.event === 'v2_flatten_failed');
    expect(failed).toMatchObject({ level: 'error', message: 'bars unavailable' });
    expect(failed === undefined ? undefined : severityOf(failed)).toBe('critical');
    expect(flattenRows(h.db).map((row) => row.event)).toEqual(['started']);
    expect(closed).toEqual([D]);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM v2_run_lease').get()).toEqual({ n: 0 });

    await loop.tick();
    expect(h.alpaca.flattens).toEqual([`v2-debate-primary-${D}-AAPL-exit`]);
    expect(flattenRows(h.db).map((row) => row.event)).toEqual(['started', 'finished']);
    expect(notes).toHaveLength(1);
  });
});

describe('FlattenLedger', () => {
  it('starts a flatten once and dates a fresh one today', () => {
    const db = newStore();
    const clock = new SimulatedClock(MID_DAY);
    const ledger = new FlattenLedger(db, clock);
    const controlId = control(db, 'halt');
    const target: FlattenTarget = { controlId, tradingDate: D };

    expect(ledger.due(D)).toEqual(target);
    ledger.start(target);
    ledger.start({ controlId, tradingDate: '2026-10-05' });
    expect(ledger.due('2026-10-09')).toEqual(target);
    expect(flattenRows(db)).toEqual([
      { control_id: controlId, event: 'started', trading_date: D, outcome: null, detail: null },
    ]);
    ledger.finish(target, { outcome: 'closed', detail: 'done' });
    expect(ledger.due(D)).toBeUndefined();
    expect(() => ledger.finish(target, { outcome: 'failed', detail: 'again' })).toThrow(
      'v2_flattens is append-only',
    );
    expect(db.prepare('SELECT recorded_at FROM v2_flattens').all()).toEqual([
      { recorded_at: MID_DAY.toISOString() },
      { recorded_at: MID_DAY.toISOString() },
    ]);
  });

  it('refuses a finished row without an outcome and a started row with one', () => {
    const db = newStore();
    const controlId = control(db, 'halt');
    const insert = (event: string, outcome: string | null) =>
      db
        .prepare(
          `INSERT INTO v2_flattens (control_id, event, trading_date, outcome, detail, recorded_at)
           VALUES (?, ?, ?, ?, NULL, 't')`,
        )
        .run(controlId, event, D, outcome);
    expect(() => insert('finished', null)).toThrow(/CHECK constraint/);
    expect(() => insert('started', 'closed')).toThrow(/CHECK constraint/);
    expect(() => insert('finished', 'partly')).toThrow(/CHECK constraint/);
    expect(() =>
      db
        .prepare(
          `INSERT INTO v2_flattens (control_id, event, trading_date, outcome, detail, recorded_at)
           VALUES (999, 'started', ?, NULL, NULL, 't')`,
        )
        .run(D),
    ).toThrow(/FOREIGN KEY/);
  });
});
