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
  partial?: number | undefined;
  failSweeps?: number | undefined;
}

interface Venue {
  readonly staleStop: boolean;
  readonly ocos: AlpacaOrder[];
  readonly cancelled: Set<string>;
}

function legStatus(venue: Venue, leg: Leg): string {
  return venue.cancelled.has(leg.id) ? 'canceled' : 'new';
}

function listedStop(order: AlpacaOrder, broker: Broker, venue: Venue): Record<string, unknown> {
  const oco = venue.ocos.find(
    (placed) => placed.client_order_id === `${order.client_order_id}:rearm`,
  );
  if (oco !== undefined) return { qty: oco.qty, stop_price: oco.legs?.[0]?.stop_price ?? null };
  const stop = Number(order.legs?.[1]?.stop_price);
  return venue.staleStop
    ? { qty: order.qty, stop_price: String(stop) }
    : {
        qty: String(Number(order.qty) * broker.positionScale),
        stop_price: String(stop / broker.positionScale),
      };
}

function splitAlpaca(broker: Broker, venue: Venue): AlpacaBrokerClient {
  const orders: AlpacaOrder[] = [];
  const view = (order: AlpacaOrder): AlpacaOrder =>
    broker.partial !== undefined
      ? {
          ...order,
          status: 'partially_filled',
          filled_qty: String(broker.partial),
          filled_avg_price: order.limit_price ?? null,
          filled_at: BROKER_FILLED_AT,
          legs: (order.legs ?? []).map((leg) => ({
            ...leg,
            status: venue.cancelled.has(leg.id) ? 'canceled' : 'held',
          })),
        }
      : broker.filled
        ? {
            ...order,
            status: 'filled',
            filled_qty: order.qty,
            filled_avg_price: order.limit_price ?? null,
            filled_at: BROKER_FILLED_AT,
            legs: (order.legs ?? []).map((leg) => ({ ...leg, status: legStatus(venue, leg) })),
          }
        : order;
  const held = () => (broker.filled || broker.partial !== undefined ? orders : []);
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
      if ((broker.failSweeps ?? 0) > 0 && orders.some((order) => order.id === id)) {
        broker.failSweeps = (broker.failSweeps ?? 0) - 1;
        return Promise.reject(new Error('alpaca order read timed out'));
      }
      const order = orders.find((candidate) => candidate.id === id);
      if (venue.cancelled.has(id)) {
        const cancelled = order === undefined ? orders[0] : view(order);
        return Promise.resolve({ ...cancelled, id, status: 'canceled' });
      }
      return order === undefined
        ? Promise.reject(new Error(`no order ${id}`))
        : Promise.resolve(view(order));
    }),
    getOrderByClientOrderId: vi.fn((clientOrderId: string) => {
      const order = [...orders, ...venue.ocos].find(
        (candidate) => candidate.client_order_id === clientOrderId,
      );
      if (order === undefined) return Promise.resolve(null);
      return Promise.resolve(venue.ocos.includes(order) ? order : view(order));
    }),
    submitMarketOrder: vi.fn().mockRejectedValue(new Error('unused')),
    submitOcoOrder: vi.fn((request) => {
      const oco: AlpacaOrder = {
        id: `oco-${venue.ocos.length + 1}`,
        client_order_id: request.client_order_id,
        symbol: request.symbol,
        side: request.side,
        qty: request.qty,
        order_class: 'oco',
        status: 'new',
        filled_qty: '0',
        filled_avg_price: null,
        filled_at: null,
        limit_price: request.take_profit.limit_price,
        legs: [
          {
            id: `oco-${venue.ocos.length + 1}-sl`,
            type: 'stop',
            status: 'new',
            filled_qty: '0',
            filled_avg_price: null,
            filled_at: null,
            stop_price: request.stop_loss.stop_price,
          },
        ],
      };
      venue.ocos.push(oco);
      return Promise.resolve(oco);
    }),
    cancelOrder: vi.fn((id: string) => {
      venue.cancelled.add(id);
      return Promise.resolve();
    }),
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
          filled_qty: '0',
          ...listedStop(order, broker, venue),
        })),
      ),
    ),
    getPositions: vi.fn(() =>
      Promise.resolve(
        held().map((order) => ({
          symbol: order.symbol,
          qty: String((broker.partial ?? Number(order.qty)) * broker.positionScale),
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

function tamperedCopy(name: string, sql: string, source = options.storePath): string {
  const storePath = join(directory, `${name}.sqlite`);
  copyFileSync(source, storePath);
  const db = new BetterSqlite3(storePath);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
  return storePath;
}

let staleOptions: ReplayCliOptions;

let partOptions: ReplayCliOptions;

async function journalDays(
  name: string,
  base: ReplayCliOptions,
  staleStop: boolean,
  splitDay: Broker = { filled: true, positionScale: 2 },
) {
  const storePath = join(directory, `${name}.sqlite`);
  const seed = openSharedStore(storePath);
  new CapitalConfigStore(seed, new SimulatedClock(new Date('2026-01-01T00:00:00.000Z'))).setYear(
    2026,
    100_000,
    1_500,
  );
  seed.close();
  const clock = new SimulatedClock(new Date(`${ENTRY_DAY}T07:30:00.000Z`));
  const broker: Broker = { filled: false, positionScale: 1 };
  const alpacaClient = splitAlpaca(broker, { staleStop, ocos: [], cancelled: new Set() });
  const days: [string, Broker][] = [
    [ENTRY_DAY, { filled: false, positionScale: 1 }],
    [SPLIT_DAY, splitDay],
    [DAY_AFTER, { ...splitDay, failSweeps: 0 }],
  ];
  for (const [tradingDate, state] of days) {
    clock.advanceTo(new Date(`${tradingDate}T07:30:00.000Z`));
    Object.assign(broker, state);
    const root = composeV2Root({
      ...base,
      tradingDate,
      dryRun: false,
      storePath,
      clock,
      logger: { log: () => {} },
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
  return { ...base, storePath };
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
  const base: ReplayCliOptions = {
    tradingDate: SPLIT_DAY,
    storePath: join(directory, 'unused.sqlite'),
    barStoreRoot,
    constituentsPath,
    fxPath,
    spreadsPath,
    saxoSpreadsPath: join(directory, 'absent-saxo-spreads.csv'),
    cfdCataloguePath: join(directory, 'absent-catalogue.json'),
    venueSessions: OPEN_EVERY_DAY,
  };
  options = await journalDays('paper', base, false);
  staleOptions = await journalDays('stale-stop', base, true);
  partOptions = await journalDays('part-fill', base, false, {
    filled: false,
    positionScale: 2,
    partial: 3,
    failSweeps: 1,
  });
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

describe('replay of a split the broker left the stop unchanged on (#1990)', () => {
  it('journals the mismatch, the stop replace on the split day, and a clean reconcile the day after', () => {
    const rows = (sql: string) => journalRows(sql, staleOptions.storePath);
    expect(
      rows(
        `SELECT trading_date, status FROM v2_reconciles WHERE source = 'broker' ORDER BY reconcile_id`,
      ),
    ).toEqual([
      { trading_date: ENTRY_DAY, status: 'clean' },
      { trading_date: SPLIT_DAY, status: 'mismatch' },
      { trading_date: DAY_AFTER, status: 'clean' },
    ]);
    expect(
      rows(
        `SELECT trading_date, outcome, json_extract(payload, '$.reason') AS reason FROM v2_orders
          WHERE substr(client_order_id, -7) = '-restop'`,
      ),
    ).toEqual([{ trading_date: SPLIT_DAY, outcome: 'submitted', reason: 'split_stop_replace' }]);
  });

  it.each([ENTRY_DAY, SPLIT_DAY, DAY_AFTER])('replays %s identical', async (tradingDate) => {
    const result = await replayFromFiles({ ...staleOptions, tradingDate });
    expect(result.divergences).toEqual([]);
  });
});

describe('replay of an entry part filled at the venue before the journal booked it (#1990)', () => {
  const rows = (sql: string) => journalRows(sql, partOptions.storePath);

  it('reads the part fill, cancels the remainder, books the fill at a mid-run sweep and re-arms it', () => {
    expect(
      rows(
        `SELECT trading_date, filled_qty, error FROM v2_fill_reads WHERE filled_qty IS NOT NULL
          ORDER BY read_id`,
      ),
    ).toEqual([{ trading_date: SPLIT_DAY, filled_qty: 3, error: null }]);
    expect(
      rows(
        `SELECT trading_date, outcome FROM v2_orders WHERE book_id = 'debate/primary'
            AND (leg = 'entry' OR substr(client_order_id, -7) = '-restop')
            AND trading_date <= '${SPLIT_DAY}' ORDER BY rowid`,
      ),
    ).toEqual([
      { trading_date: ENTRY_DAY, outcome: 'cancelled' },
      { trading_date: SPLIT_DAY, outcome: 'submitted' },
    ]);
    const [opening, protecting] = rows(
      `SELECT last_fill_rowid AS cut FROM v2_fill_sweeps WHERE trading_date = '${SPLIT_DAY}'
        ORDER BY sweep_id`,
    ) as { cut: number }[];
    expect(
      rows(
        `SELECT rowid AS id FROM v2_fills WHERE book_id = 'debate/primary' AND trading_date = '${SPLIT_DAY}'`,
      ),
    ).toEqual([{ id: protecting?.cut }]);
    expect(opening?.cut).toBeLessThan(protecting?.cut ?? 0);
  });

  it('replays the part-fill day identical, the read and the mid-run sweep served as journalled', async () => {
    const result = await replayFromFiles({ ...partOptions, tradingDate: SPLIT_DAY });
    expect(result.divergences).toEqual([]);
  });

  // Earlier-run rows go in ahead of the marking run's by sweep_id, as a real earlier run's would,
  // with timestamps after every other row so that nothing can lean on the clock
  const earlierSweeps = (sweeps: number, source = partOptions.storePath) => {
    const rows = Array.from(
      { length: sweeps },
      (_, k) =>
        `INSERT INTO v2_fill_sweeps (sweep_id, run_id, trading_date, first_fill_rowid,
           last_fill_rowid, order_rowid, book_day_rowid, recorded_at)
         SELECT MIN(sweep_id) - 1000 + ${k}, 'earlier', trading_date, first_fill_rowid,
                first_fill_rowid, order_rowid, book_day_rowid, '${SPLIT_DAY}T23:5${k}:00.000Z'
           FROM v2_fill_sweeps WHERE trading_date = '${SPLIT_DAY}';`,
    );
    return {
      source,
      sql: `DROP TRIGGER v2_fill_sweeps_no_update;
        UPDATE v2_fill_sweeps SET sweep_id = sweep_id + 1000
         WHERE sweep_id >= (SELECT MIN(sweep_id) FROM v2_fill_sweeps
                             WHERE trading_date = '${SPLIT_DAY}');
        ${rows.join('\n')}`,
    };
  };

  const withEarlierRun = (name: string, extra: string, sweeps = 1, source?: string) => {
    const earlier = earlierSweeps(sweeps, source);
    return tamperedCopy(name, `${earlier.sql}\n${extra}`, earlier.source);
  };

  it('replays identical a date whose earlier run stopped after its opening sweep (#1990)', async () => {
    const storePath = withEarlierRun('stopped-at-opening', '');
    expect(
      journalRows(
        `SELECT COUNT(DISTINCT run_id) AS runs FROM v2_fill_sweeps WHERE trading_date = '${SPLIT_DAY}'`,
        storePath,
      ),
    ).toEqual([{ runs: 2 }]);
    const result = await replayFromFiles({ ...partOptions, storePath, tradingDate: SPLIT_DAY });
    expect(result.divergences).toEqual([]);
  });

  it('replays identical an idle earlier run when the marking run books a fill at its own opening sweep, whatever the clock says (ninth review probe)', async () => {
    const storePath = withEarlierRun(
      'idle-then-opening-fill',
      `DROP TRIGGER IF EXISTS v2_fills_no_update;
       UPDATE v2_fills SET recorded_at = '${SPLIT_DAY}T07:30:00.001Z'
        WHERE trading_date = '${SPLIT_DAY}';`,
      1,
      options.storePath,
    );
    expect(
      journalRows(
        `SELECT s.first_fill_rowid < f.rowid AND f.rowid <= s.last_fill_rowid AS opening
           FROM v2_fills f, v2_fill_sweeps s
          WHERE f.trading_date = '${SPLIT_DAY}' AND f.book_id = 'debate/primary'
            AND s.sweep_id = (SELECT MIN(sweep_id) FROM v2_fill_sweeps
                               WHERE trading_date = '${SPLIT_DAY}' AND run_id <> 'earlier')`,
        storePath,
      ),
    ).toEqual([{ opening: 1 }]);
    const result = await replayFromFiles({ ...options, storePath, tradingDate: SPLIT_DAY });
    expect(result.divergences).toEqual([]);
  });

  it('replays identical a date with a flatten pass that did nothing, before the cycle or after its marks', async () => {
    const storePath = withEarlierRun(
      'idle-flatten',
      `INSERT INTO v2_fill_sweeps (run_id, trading_date, first_fill_rowid, last_fill_rowid,
           order_rowid, book_day_rowid, recorded_at)
         SELECT 'later-flatten', '${SPLIT_DAY}', MAX(rowid), MAX(rowid), 0,
                (SELECT MAX(rowid) FROM v2_book_days), '${SPLIT_DAY}T00:00:00.000Z'
           FROM v2_fills;
       INSERT INTO v2_fill_reads (run_id, trading_date, client_order_id, filled_qty, error,
           recorded_at)
         VALUES ('later-flatten', '${SPLIT_DAY}', 'v2-debate-primary-${ENTRY_DAY}-UP', 0, NULL,
                 '${SPLIT_DAY}T00:00:00.000Z');`,
    );
    const result = await replayFromFiles({ ...partOptions, storePath, tradingDate: SPLIT_DAY });
    expect(result.divergences).toEqual([]);
  });

  it.each([
    [
      'read an entry',
      `INSERT INTO v2_fill_reads (run_id, trading_date, client_order_id, filled_qty, error, recorded_at)
         VALUES ('earlier', '${SPLIT_DAY}', 'v2-debate-primary-${ENTRY_DAY}-UP', NULL, 'order read timed out', '${SPLIT_DAY}T00:00:00.000Z');`,
      1,
    ],
    ['swept again', '', 2],
  ] as const)(
    'flags multiple_runs, not a mismatch, when an earlier run %s (David 2026-10-02, #1990)',
    async (what, extra, sweeps) => {
      const storePath = withEarlierRun(`earlier-${what.replace(' ', '-')}`, extra, sweeps);
      const result = await replayFromFiles({ ...partOptions, storePath, tradingDate: SPLIT_DAY });
      expect(result.divergences).toEqual([
        { kind: 'multiple_runs', tradingDate: SPLIT_DAY, earlierRuns: ['earlier'] },
      ]);
    },
  );

  it('diverges when the journalled fill read is missing, never defaulting it', async () => {
    const storePath = tamperedCopy(
      'no-fill-reads',
      `DROP TRIGGER v2_fill_reads_no_delete; DELETE FROM v2_fill_reads;`,
      partOptions.storePath,
    );
    const result = await replayFromFiles({ ...partOptions, storePath, tradingDate: SPLIT_DAY });
    expect(result.divergences).toContainEqual({
      kind: 'row_missing',
      stage: 'orders',
      key: `v2-debate-primary-${SPLIT_DAY}-UP-restop`,
    });
  });

  it('books the fill at the sweep the journal says booked it: a later cut there loses the re-arm', async () => {
    const storePath = tamperedCopy(
      'late-sweep',
      `DROP TRIGGER v2_fill_sweeps_no_update;
       UPDATE v2_fill_sweeps SET last_fill_rowid = 0
        WHERE sweep_id = (SELECT MIN(sweep_id) + 1 FROM v2_fill_sweeps
                           WHERE trading_date = '${SPLIT_DAY}');`,
      partOptions.storePath,
    );
    const result = await replayFromFiles({ ...partOptions, storePath, tradingDate: SPLIT_DAY });
    expect(result.divergences).toContainEqual({
      kind: 'row_missing',
      stage: 'orders',
      key: `v2-debate-primary-${SPLIT_DAY}-UP-restop`,
    });
  });
});

async function journalRetried(name: string, base: ReplayCliOptions, mode: 'restop' | 'read') {
  const storePath = join(directory, `${name}.sqlite`);
  const seed = openSharedStore(storePath);
  new CapitalConfigStore(seed, new SimulatedClock(new Date('2026-01-01T00:00:00.000Z'))).setYear(
    2026,
    100_000,
    1_500,
  );
  seed.close();
  const clock = new SimulatedClock(new Date(`${ENTRY_DAY}T07:30:00.000Z`));
  const broker: Broker = { filled: false, positionScale: 1 };
  const venue: Venue = { staleStop: false, ocos: [], cancelled: new Set() };
  const inner = splitAlpaca(broker, venue);
  const gate = { hang: false };
  const alpacaClient: AlpacaBrokerClient = {
    ...inner,
    cancelOrder: (id: string) =>
      gate.hang && mode === 'read' ? new Promise(() => {}) : inner.cancelOrder(id),
    getOrder: (id: string) =>
      gate.hang && venue.ocos.length > 0 ? new Promise(() => {}) : inner.getOrder(id),
  };
  const runOnce = async (tradingDate: string, at: string, waitMs?: number) => {
    clock.advanceTo(new Date(at));
    const root = composeV2Root({
      ...base,
      tradingDate,
      dryRun: false,
      storePath,
      clock,
      logger: { log: () => {} },
      transportFor: (pin: ModelPin) => new ScriptedTransport(pin, answer(clock)),
      newsSource: { headlines: () => Promise.resolve([]) },
      alpacaClient,
    });
    try {
      if (waitMs === undefined) await root.run();
      else await Promise.race([root.run(), new Promise((resolve) => setTimeout(resolve, waitMs))]);
    } finally {
      root.close();
    }
  };
  await runOnce(ENTRY_DAY, `${ENTRY_DAY}T07:30:00.000Z`);
  Object.assign(broker, { filled: false, positionScale: 2, partial: 3, failSweeps: 1 });
  if (mode === 'read') Object.assign(broker, { partial: undefined, failSweeps: 0 });
  gate.hang = true;
  await runOnce(SPLIT_DAY, `${SPLIT_DAY}T07:30:00.000Z`, 1_500);
  gate.hang = false;
  if (mode === 'read') Object.assign(broker, { partial: 3, failSweeps: 0 });
  const lease = new BetterSqlite3(storePath);
  lease.prepare('DELETE FROM v2_run_lease').run();
  lease.close();
  await runOnce(SPLIT_DAY, `${SPLIT_DAY}T09:30:00.000Z`);
  return { ...base, storePath };
}

describe('replay of a date a crashed run acted on before the retry that marked it (#1990)', () => {
  it.each([
    ['sent a re-arm and hung before the marks', 'restop'],
    ['read a different fill and hung cancelling', 'read'],
  ] as const)(
    'reports one multiple_runs and no per-order mismatch when the first run %s',
    async (_what, mode) => {
      const retried = await journalRetried(`retried-${mode}`, options, mode);
      const runs = journalRows(
        `SELECT COUNT(DISTINCT run_id) AS runs FROM v2_fill_sweeps WHERE trading_date = '${SPLIT_DAY}'`,
        retried.storePath,
      );
      expect(runs).toEqual([{ runs: 2 }]);
      const result = await replayFromFiles({ ...retried, tradingDate: SPLIT_DAY });
      expect(result.divergences).toEqual([
        { kind: 'multiple_runs', tradingDate: SPLIT_DAY, earlierRuns: [expect.any(String)] },
      ]);
    },
    60_000,
  );
});
