import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AnthropicMessageRequest } from '../../pipeline/debate-engine/index.js';
import type { DailyBar } from '../../pipeline/momentum/index.js';
import { ParquetBarStore } from '../../providers/bar-store/index.js';
import { SimulatedClock } from '../../shared/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import type { VenueSessionGate } from './data/index.js';
import type { AlpacaBrokerClient, AlpacaOrder } from './execution/alpaca/alpaca-client.js';
import { composeV2Root } from './index.js';
import { type ReplayCliOptions, replayFromFiles } from './replay-cli.js';
import { CapitalConfigStore } from './risk/index.js';
import type { ModelPin } from './signal/index.js';
import { ScriptedTransport } from './signal/index.js';

const ORIGIN = Date.UTC(2026, 0, 1);
const dateAt = (day: number) => new Date(ORIGIN + day * 86_400_000).toISOString().slice(0, 10);
const ENTRY_DAY = dateAt(260);
const FILL_DAY = dateAt(261);
const STOP_DAY = dateAt(262);
const OPEN_EVERY_DAY: VenueSessionGate = {
  entrySitOut: () => undefined,
  timeStopPausedVenues: () => [],
};

function rising(base: number): DailyBar[] {
  const bars: DailyBar[] = [];
  for (let i = 0; i <= 262; i += 1) {
    const close = base * (1 + 0.001 * i);
    bars.push({
      date: dateAt(i),
      open: close,
      high: close * 1.01,
      low: close * 0.99,
      close,
      volume: 1_000_000,
      rawClose: close,
    });
  }
  return bars;
}

type Leg = NonNullable<AlpacaOrder['legs']>[number];

interface Broker {
  filledShare: number;
  stopFilledAt: string | undefined;
  stopAtReconcile: boolean;
}

function paperAlpaca(clock: SimulatedClock, broker: Broker): AlpacaBrokerClient {
  const orders: AlpacaOrder[] = [];
  const filledQty = (order: AlpacaOrder) => Math.floor(Number(order.qty) * broker.filledShare);
  const view = (order: AlpacaOrder): AlpacaOrder => {
    const qty = filledQty(order);
    const [target, stop] = order.legs as [Leg, Leg];
    return {
      ...order,
      status: qty < Number(order.qty) ? 'partially_filled' : 'filled',
      filled_qty: String(qty),
      filled_avg_price: qty > 0 ? (order.limit_price ?? null) : null,
      filled_at: qty > 0 ? clock.now().toISOString() : null,
      legs: [
        target,
        {
          ...stop,
          ...(broker.stopFilledAt === undefined
            ? {}
            : {
                status: 'filled',
                filled_qty: String(qty),
                filled_avg_price: String(Number(order.limit_price) * 0.95),
                filled_at: broker.stopFilledAt,
              }),
        },
      ],
    };
  };
  const held = () => (broker.stopFilledAt === undefined ? orders.filter(filledQty) : []);
  return {
    submitOrder: vi.fn((request) => {
      const id = `alp-${orders.length + 1}`;
      const leg = (suffix: string, type: Leg['type']): Leg => ({
        id: `${id}-${suffix}`,
        type,
        status: 'held',
        filled_qty: '0',
        filled_avg_price: null,
        filled_at: null,
      });
      const order: AlpacaOrder = {
        id,
        client_order_id: request.client_order_id,
        symbol: request.symbol,
        side: request.side,
        qty: request.qty,
        order_class: 'bracket',
        status: 'accepted',
        filled_qty: '0',
        filled_avg_price: null,
        filled_at: null,
        limit_price: request.limit_price,
        legs: [
          leg('tp', 'limit'),
          { ...leg('sl', 'stop'), stop_price: request.stop_loss.stop_price },
        ],
      };
      orders.push(order);
      return Promise.resolve(order);
    }),
    getOrder: vi.fn((id: string) => {
      const order = orders.find((candidate) => candidate.id === id);
      return order === undefined
        ? Promise.reject(new Error(`no order ${id}`))
        : Promise.resolve(view(order));
    }),
    getOrderByClientOrderId: vi.fn((clientOrderId: string) => {
      const order = orders.find((candidate) => candidate.client_order_id === clientOrderId);
      return Promise.resolve(order === undefined ? null : view(order));
    }),
    submitMarketOrder: vi.fn().mockRejectedValue(new Error('unused')),
    submitOcoOrder: vi.fn().mockRejectedValue(new Error('unused')),
    cancelOrder: vi.fn().mockResolvedValue(undefined),
    listOpenOrders: vi.fn(() =>
      Promise.resolve(
        held().map((order) => ({
          ...order,
          id: `${order.id}-sl`,
          client_order_id: `${order.client_order_id}-stop`,
          side: order.side === 'buy' ? ('sell' as const) : ('buy' as const),
          type: 'stop',
          order_class: 'simple',
          status: 'new',
          qty: String(filledQty(order)),
          filled_qty: '0',
          stop_price: order.legs?.[1]?.stop_price ?? null,
        })),
      ),
    ),
    getPositions: vi.fn(() =>
      Promise.resolve(
        held().map((order) => ({
          symbol: order.symbol,
          qty: String(filledQty(order)),
          side: order.side === 'buy' ? ('long' as const) : ('short' as const),
          avg_entry_price: order.limit_price ?? '0',
        })),
      ),
    ),
    getAccount: vi.fn(() => {
      if (broker.stopAtReconcile) {
        broker.stopAtReconcile = false;
        broker.stopFilledAt = clock.now().toISOString();
      }
      return Promise.resolve({ cash: '100000', equity: '100000' });
    }),
  };
}

function answer(clock: SimulatedClock) {
  return (request: AnthropicMessageRequest): string => {
    clock.advanceTo(new Date(clock.now().getTime() + 1_000));
    const prompt = request.messages[0]?.content ?? '';
    if (prompt.includes('Mediator persona')) {
      return '{"stance":"bullish","rationale":"trend agrees","converged":true}';
    }
    return prompt.includes('Bull persona')
      ? '{"stance":"bullish","rationale":"above the 200-day"}'
      : '{"stance":"bearish","rationale":"stretched"}';
  };
}

let directory: string;
let options: ReplayCliOptions;

function journalRows(sql: string): unknown[] {
  const db = new BetterSqlite3(options.storePath, { readonly: true });
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'v2-replay-paper-'));
  const barStoreRoot = join(directory, 'parquet');
  const store = await ParquetBarStore.open(barStoreRoot);
  await store.write('alpaca', [
    { symbol: 'UP', bars: rising(2) },
    { symbol: 'SPY', bars: rising(20) },
  ]);
  store.close();
  const constituentsPath = join(directory, 'constituents.csv');
  writeFileSync(constituentsPath, 'date,tickers\n2016-01-04,"UP"\n');
  const fxPath = join(directory, 'fx.csv');
  writeFileSync(fxPath, 'DATE,XUDLUSS\n31 Dec 2025,1.25\n02 Jan 2026,1.26\n');
  const spreadsPath = join(directory, 'spreads.csv');
  writeFileSync(spreadsPath, 'symbol,sessions,median_half_spread_bps\nUP,10,2\n');
  const storePath = join(directory, 'paper.sqlite');
  const seed = openSharedStore(storePath);
  new CapitalConfigStore(seed, new SimulatedClock(new Date('2026-01-01T00:00:00.000Z'))).setYear(
    2026,
    100_000,
    1_500,
  );
  seed.close();
  options = {
    tradingDate: STOP_DAY,
    storePath,
    barStoreRoot,
    constituentsPath,
    fxPath,
    spreadsPath,
    saxoSpreadsPath: join(directory, 'absent-saxo-spreads.csv'),
    cfdCataloguePath: join(directory, 'absent-catalogue.json'),
    venueSessions: OPEN_EVERY_DAY,
  };
  const clock = new SimulatedClock(new Date(`${ENTRY_DAY}T07:30:00.000Z`));
  const broker: Broker = { filledShare: 0, stopFilledAt: undefined, stopAtReconcile: false };
  const alpacaClient = paperAlpaca(clock, broker);
  const days: [string, Partial<Broker>][] = [
    [ENTRY_DAY, { filledShare: 0.5 }],
    [FILL_DAY, { filledShare: 1 }],
    [STOP_DAY, { stopAtReconcile: true }],
  ];
  for (const [tradingDate, state] of days) {
    clock.advanceTo(new Date(`${tradingDate}T07:30:00.000Z`));
    Object.assign(broker, state);
    const root = composeV2Root({
      tradingDate,
      dryRun: false,
      storePath,
      barStoreRoot,
      constituentsPath,
      fxPath,
      spreadsPath,
      saxoSpreadsPath: options.saxoSpreadsPath,
      cfdCataloguePath: options.cfdCataloguePath,
      clock,
      logger: { log: () => {} },
      venueSessions: OPEN_EVERY_DAY,
      transportFor: (pin: ModelPin) => new ScriptedTransport(pin, answer(clock)),
      newsSource: { headlines: () => Promise.resolve([]) },
      alpacaClient,
    });
    try {
      await root.run();
    } finally {
      root.close();
    }
  }
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('replay of a paper store against journalled Alpaca fills', () => {
  it('reconciles each paper day clean, the venue stop sized and priced as the ledger holds it', () => {
    expect(
      journalRows("SELECT trading_date, status FROM v2_reconciles WHERE source = 'broker'"),
    ).toEqual(
      [ENTRY_DAY, FILL_DAY, STOP_DAY].map((date) => ({ trading_date: date, status: 'clean' })),
    );
  });

  it('journals a partial entry fill, its cumulative remainder and a stop fill booked at the second sweep', () => {
    const fills = journalRows(
      `SELECT trading_date, leg, fill_id, qty FROM v2_fills
        WHERE book_id = 'debate/primary' ORDER BY rowid`,
    ) as { trading_date: string; leg: string; fill_id: string; qty: number }[];
    const [partial, remainder, stop] = fills;
    const total = (partial?.qty ?? 0) + (remainder?.qty ?? 0);
    expect(fills).toEqual([
      {
        trading_date: ENTRY_DAY,
        leg: 'entry',
        fill_id: 'alpaca:alp-1',
        qty: Math.floor(total / 2),
      },
      {
        trading_date: FILL_DAY,
        leg: 'entry',
        fill_id: `alpaca:alp-1#${total}`,
        qty: total - Math.floor(total / 2),
      },
      { trading_date: STOP_DAY, leg: 'stop', fill_id: 'alpaca:alp-1-sl', qty: total },
    ]);
    expect(stop?.qty).toBeGreaterThan(1);
    expect(
      journalRows(
        `SELECT f.recorded_at > (SELECT MIN(r.recorded_at) FROM v2_reconciles r
                                  WHERE r.trading_date = f.trading_date) AS after_reconcile
           FROM v2_fills f WHERE f.trading_date = '${STOP_DAY}' AND f.book_id = 'debate/primary'`,
      ),
    ).toEqual([{ after_reconcile: 1 }]);
  });

  it.each([ENTRY_DAY, FILL_DAY, STOP_DAY])('replays %s identical', async (tradingDate) => {
    const result = await replayFromFiles({ ...options, tradingDate });
    expect(result.divergences).toEqual([]);
    expect(result.orders + result.fills).toBeGreaterThan(0);
  });

  it('journals the modelled slippage on the broker entry and no other book gets one (#1884)', () => {
    expect(
      journalRows(
        `SELECT book_id, json_extract(payload, '$.modelled_slippage_bps') > 2 AS above_spread
           FROM v2_orders WHERE leg = 'entry' AND trading_date = '${ENTRY_DAY}'
          ORDER BY book_id`,
      ),
    ).toEqual([
      { book_id: 'arm2/technical-only', above_spread: null },
      { book_id: 'debate/no-macro-gate', above_spread: null },
      { book_id: 'debate/primary', above_spread: 1 },
    ]);
  });

  it('replays a day journalled before #1884, whose orders carry no modelled slippage, identical', async () => {
    const before = join(directory, 'before-1884.sqlite');
    copyFileSync(options.storePath, before);
    const db = new BetterSqlite3(before);
    try {
      const stripped = db
        .prepare(`UPDATE v2_orders SET payload = json_remove(payload, '$.modelled_slippage_bps')`)
        .run();
      expect(stripped.changes).toBeGreaterThan(0);
    } finally {
      db.close();
    }
    for (const tradingDate of [ENTRY_DAY, FILL_DAY, STOP_DAY]) {
      const result = await replayFromFiles({ ...options, storePath: before, tradingDate });
      expect(result.divergences).toEqual([]);
    }
  });

  it('shows a half-spread refresh since the day as an orders divergence', async () => {
    const refreshed = join(directory, 'refreshed-spreads.csv');
    writeFileSync(refreshed, 'symbol,sessions,median_half_spread_bps\nUP,10,9\n');
    const result = await replayFromFiles({
      ...options,
      tradingDate: ENTRY_DAY,
      spreadsPath: refreshed,
    });
    expect(result.divergences).toMatchObject([
      { kind: 'row_field', stage: 'orders', field: 'payload' },
    ]);
  });
});
