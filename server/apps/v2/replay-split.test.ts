import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AnthropicMessageRequest } from '../../pipeline/debate-engine/index.js';
import type { AlpacaBrokerClient, AlpacaOrder } from '../../pipeline/execution/index.js';
import type { DailyBar } from '../../pipeline/momentum/index.js';
import { ParquetBarStore } from '../../providers/bar-store/index.js';
import { SimulatedClock } from '../../shared/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import type { VenueSessionGate } from './data/index.js';
import { composeV2Root } from './index.js';
import { type ReplayCliOptions, replayFromFiles } from './replay-cli.js';
import { CapitalConfigStore } from './risk/index.js';
import type { ModelPin } from './signal/index.js';
import { ScriptedTransport } from './signal/index.js';

const ORIGIN = Date.UTC(2026, 0, 1);
const dateAt = (day: number) => new Date(ORIGIN + day * 86_400_000).toISOString().slice(0, 10);
const ENTRY_DAY = dateAt(260);
const SPLIT_BAR = 261;
const SPLIT_DAY = dateAt(262);
const DAY_AFTER = dateAt(263);
const BROKER_FILLED_AT = `${ENTRY_DAY}T15:00:00.000Z`;
const OPEN_EVERY_DAY: VenueSessionGate = {
  entrySitOut: () => undefined,
  timeStopPausedVenues: () => [],
};

function rising(base: number, splitRatio = 1): DailyBar[] {
  const bars: DailyBar[] = [];
  for (let i = 0; i <= 263; i += 1) {
    const close = base * (1 + 0.001 * i);
    bars.push({
      date: dateAt(i),
      open: close,
      high: close * 1.01,
      low: close * 0.99,
      close,
      volume: 1_000_000,
      rawClose: i < SPLIT_BAR ? close * splitRatio : close,
    });
  }
  return bars;
}

type Leg = NonNullable<AlpacaOrder['legs']>[number];

interface Broker {
  filled: boolean;
  positionScale: number;
}

function splitAlpaca(broker: Broker): AlpacaBrokerClient {
  const orders: AlpacaOrder[] = [];
  const view = (order: AlpacaOrder): AlpacaOrder =>
    broker.filled
      ? {
          ...order,
          status: 'filled',
          filled_qty: order.qty,
          filled_avg_price: order.limit_price ?? null,
          filled_at: BROKER_FILLED_AT,
        }
      : order;
  const held = () => (broker.filled ? orders : []);
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
        legs: [leg('tp', 'limit'), leg('sl', 'stop')],
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
        })),
      ),
    ),
    getPositions: vi.fn(() =>
      Promise.resolve(
        held().map((order) => ({
          symbol: order.symbol,
          qty: String(Number(order.qty) * broker.positionScale),
          side: order.side === 'buy' ? ('long' as const) : ('short' as const),
          avg_entry_price: order.limit_price ?? '0',
        })),
      ),
    ),
    getAccount: vi.fn(() => Promise.resolve({ cash: '100000', equity: '100000' })),
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

function journalRows(sql: string, storePath = options.storePath): unknown[] {
  const db = new BetterSqlite3(storePath, { readonly: true });
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

function tamperedCopy(name: string, sql: string): string {
  const storePath = join(directory, `${name}.sqlite`);
  copyFileSync(options.storePath, storePath);
  const db = new BetterSqlite3(storePath);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
  return storePath;
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'v2-replay-split-'));
  const barStoreRoot = join(directory, 'parquet');
  const store = await ParquetBarStore.open(barStoreRoot);
  await store.write('alpaca', [
    { symbol: 'UP', bars: rising(2, 2) },
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
    tradingDate: SPLIT_DAY,
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
  const broker: Broker = { filled: false, positionScale: 1 };
  const alpacaClient = splitAlpaca(broker);
  const days: [string, Broker][] = [
    [ENTRY_DAY, { filled: false, positionScale: 1 }],
    [SPLIT_DAY, { filled: true, positionScale: 2 }],
    [DAY_AFTER, { filled: true, positionScale: 2 }],
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

describe('replay of positions held across a 2:1 split (#1983)', () => {
  it('journals the broker fill time and every rescale of the held positions', () => {
    expect(
      journalRows(
        `SELECT trading_date, leg, filled_at FROM v2_fills WHERE book_id = 'debate/primary'`,
      ),
    ).toEqual([{ trading_date: SPLIT_DAY, leg: 'entry', filled_at: BROKER_FILLED_AT }]);
    expect(
      journalRows(
        `SELECT trading_date, book_id, source, ratio, anchor_date, qty_after / qty_before AS scale
           FROM v2_rescales ORDER BY rescale_id`,
      ),
    ).toEqual([
      {
        trading_date: SPLIT_DAY,
        book_id: 'debate/primary',
        source: 'anchor',
        ratio: 1,
        anchor_date: ENTRY_DAY,
        scale: 1,
      },
      {
        trading_date: SPLIT_DAY,
        book_id: 'debate/primary',
        source: 'detector',
        ratio: 2,
        anchor_date: dateAt(SPLIT_BAR),
        scale: 2,
      },
      ...['arm2/technical-only', 'debate/no-macro-gate'].map((book_id) => ({
        trading_date: SPLIT_DAY,
        book_id,
        source: 'entry',
        ratio: 2,
        anchor_date: dateAt(SPLIT_BAR),
        scale: 2,
      })),
    ]);
    expect(
      journalRows(
        `SELECT DISTINCT status FROM v2_reconciles WHERE trading_date >= '${SPLIT_DAY}'
           AND source = 'broker'`,
      ),
    ).toEqual([{ status: 'clean' }]);
  });

  it.each([ENTRY_DAY, SPLIT_DAY, DAY_AFTER])('replays %s identical', async (tradingDate) => {
    const result = await replayFromFiles({ ...options, tradingDate });
    expect(result.divergences).toEqual([]);
    expect(result.decisions).toBeGreaterThan(0);
  });

  it('rebuilds the day after at its pre-split quantity, a book divergence, without the split day rescales', async () => {
    const storePath = tamperedCopy(
      'no-rescales',
      `DROP TRIGGER v2_rescales_no_delete; DELETE FROM v2_rescales;`,
    );
    const result = await replayFromFiles({ ...options, storePath, tradingDate: DAY_AFTER });
    expect(result.divergences[0]).toMatchObject({
      kind: 'book_state',
      stage: 'book',
      field: 'invested_gbp',
    });
  });

  it('holds a store that journals no rescale, as one written before #1983, to its other rows only', async () => {
    const storePath = tamperedCopy(
      'before-1983',
      `DROP TRIGGER v2_rescales_no_delete; DELETE FROM v2_rescales;`,
    );
    const result = await replayFromFiles({ ...options, storePath, tradingDate: SPLIT_DAY });
    expect(result.divergences).toEqual([]);
  });

  it('misses the anchor and the rescale when the broker fill is served at its sweep time', async () => {
    const storePath = tamperedCopy(
      'undated-fill',
      `DROP TRIGGER IF EXISTS v2_fills_no_update; UPDATE v2_fills SET filled_at = NULL;`,
    );
    const result = await replayFromFiles({ ...options, storePath, tradingDate: SPLIT_DAY });
    expect(result.divergences).toContainEqual({
      kind: 'row_missing',
      stage: 'rescales',
      key: `debate/primary|UP|detector|${dateAt(SPLIT_BAR)}`,
    });
  });
});
