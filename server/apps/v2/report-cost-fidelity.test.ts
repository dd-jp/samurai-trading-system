import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MarketData } from '../../../contracts/index.js';
import { ParquetBarStore } from '../../providers/bar-store/index.js';
import {
  migratedMemoryStore,
  openReadOnlyStore,
  type StoreHandle,
} from '../../shared/store/index.js';
import {
  BarsMarketData,
  type BarsSource,
  FX_SNAPSHOT_PATH,
  parseBoeGbpUsdCsv,
} from './data/index.js';
import { fillQuoter, main, readBrokerOrders, reportCostFidelity } from './report-cost-fidelity.js';

const NO_BARS: BarsSource = { load: () => undefined };
const YEAR_START_GBPUSD = new BarsMarketData(
  NO_BARS,
  parseBoeGbpUsdCsv(readFileSync(FX_SNAPSHOT_PATH, 'utf8')),
).gbpUsdAtYearStart(2026);

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cost-fidelity-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ORDER_DEFAULTS = {
  book: 'debate/primary',
  date: '2026-09-01',
  instrument: 'AAA',
  venue: 'alpaca',
  leg: 'entry',
  side: 'buy',
  dryRun: 0,
  outcome: 'submitted',
  payload: { price: 100, size: 10 } as Record<string, unknown>,
};

const FILL_DEFAULTS = { leg: 'entry', side: 'buy', date: '2026-09-02', qty: 10, price: 80, fee: 0 };

type OrderSeed = { readonly id: string } & Partial<typeof ORDER_DEFAULTS>;
type FillSeed = { readonly id: string; readonly order: string } & Partial<typeof FILL_DEFAULTS>;

function journal(orders: readonly OrderSeed[], fills: readonly FillSeed[]) {
  const db = migratedMemoryStore();
  const book = db.prepare(
    `INSERT INTO v2_books (book_id, sleeve_id, variant, start_capital_gbp, cash_gbp, created_at)
     VALUES (?, 'debate', ?, 600, 600, '2026-09-01T00:00:00Z')`,
  );
  book.run('debate/primary', 'primary');
  book.run('debate/no-macro-gate', 'no-macro-gate');
  const order = db.prepare(
    `INSERT INTO v2_orders (client_order_id, decision_id, book_id, trading_date, instrument, venue,
       leg, side, dry_run, outcome, payload, recorded_at)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-09-01T00:00:00Z')`,
  );
  for (const seed of orders) {
    const row = { ...ORDER_DEFAULTS, ...seed };
    order.run(
      row.id,
      row.book,
      row.date,
      row.instrument,
      row.venue,
      row.leg,
      row.side,
      row.dryRun,
      row.outcome,
      JSON.stringify(row.payload),
    );
  }
  const fill = db.prepare(
    `INSERT INTO v2_fills (fill_id, client_order_id, book_id, trading_date, instrument, venue, leg,
       side, qty, price_gbp, fee_gbp, recorded_at, broker_mode)
     VALUES (?, ?, 'debate/primary', ?, 'AAA', 'alpaca', ?, ?, ?, ?, ?, '2026-09-02T00:00:00Z', 'paper')`,
  );
  for (const seed of fills) {
    const row = { ...FILL_DEFAULTS, ...seed };
    fill.run(row.id, row.order, row.date, row.leg, row.side, row.qty, row.price, row.fee);
  }
  return db;
}

function journalFile(path: string, orders: readonly OrderSeed[], fills: readonly FillSeed[]) {
  const db = journal(orders, fills);
  writeFileSync(path, db.serialize());
  db.close();
}

describe('readBrokerOrders', () => {
  it('reads only orders that reached the broker, with their fills and entry offsets', () => {
    const db = journal(
      [
        {
          id: 'entry',
          payload: {
            price: 100,
            limit: 100.5,
            entry_offset_bps: 50,
            modelled_slippage_bps: 12.5,
            trigger: 101,
            stop: 95,
            target: 110,
          },
        },
        { id: 'flatten', leg: 'exit', side: 'sell', date: '2026-09-05', payload: { size: 10 } },
        { id: 'orphan-exit', leg: 'exit', instrument: 'BBB', payload: { size: 1 } },
        {
          id: 'cancelled',
          date: '2026-09-03',
          outcome: 'cancelled',
          payload: { price: 90, cancelled: '2026-09-04' },
        },
        { id: 'shadow', book: 'debate/no-macro-gate', outcome: 'simulated' },
        { id: 'dry', dryRun: 1, outcome: 'refused_dry_run' },
        { id: 'saxo', venue: 'saxo' },
        { id: 'rejected', outcome: 'rejected' },
        { id: 'late', date: '2026-10-02' },
      ],
      [
        { id: 'alpaca:f1', order: 'entry', qty: 4, price: 80 },
        { id: 'alpaca:f1#2', order: 'entry', qty: 6, price: 81 },
        {
          id: 'alpaca:cash-in-lieu:debate/primary:AAA:2026-09-03',
          order: 'entry',
          leg: 'cash_in_lieu',
          side: 'sell',
          qty: 0.5,
        },
        {
          id: 'alpaca:f2',
          order: 'flatten',
          leg: 'exit',
          side: 'sell',
          date: '2026-09-06',
          fee: 0.02,
        },
      ],
    );
    const orders = readBrokerOrders(db, { from: '2026-09-01', to: '2026-09-30' });
    expect(orders.map((one) => [one.clientOrderId, one.offsetBps])).toEqual([
      ['entry', 50],
      ['orphan-exit', undefined],
      ['cancelled', 0],
      ['flatten', 50],
    ]);
    expect(orders[0]).toMatchObject({
      tradingDate: '2026-09-01',
      instrument: 'AAA',
      venue: 'alpaca',
      leg: 'entry',
      side: 'buy',
      limit: 100.5,
      trigger: 101,
      stop: 95,
      target: 110,
      cancelledOn: undefined,
      modelledSlippageBps: 12.5,
      fills: [
        { leg: 'entry', side: 'buy', tradingDate: '2026-09-02', qty: 4, priceGbp: 80, feeGbp: 0 },
        { leg: 'entry', side: 'buy', tradingDate: '2026-09-02', qty: 6, priceGbp: 81, feeGbp: 0 },
      ],
    });
    expect(orders[1]?.modelledSlippageBps).toBeUndefined();
    expect(orders[2]).toMatchObject({ limit: 90, cancelledOn: '2026-09-04', fills: [] });
    expect(orders[3]?.fills).toEqual([
      { leg: 'exit', side: 'sell', tradingDate: '2026-09-06', qty: 10, priceGbp: 80, feeGbp: 0.02 },
    ]);
    expect(readBrokerOrders(db).map((one) => one.clientOrderId)).toContain('late');
    db.close();
  });
});

describe('fillQuoter', () => {
  it('prices an Alpaca fill with the paper cycle cost model on the fill date', () => {
    const bars = Array.from({ length: 21 }, (_, day) => ({
      date: `2026-08-${String(day + 1).padStart(2, '0')}`,
      open: 100,
      high: 100,
      low: 100,
      close: day % 2 === 0 ? 100 : 101,
      rawClose: 100,
      volume: 1_000_000,
    }));
    const dates: string[] = [];
    const market: MarketData = {
      lastBarBefore: () => undefined,
      barsBefore: (_instrument, date) => {
        dates.push(date);
        return bars;
      },
      gbpUsdAtYearStart: () => 1.25,
    };
    const quote = fillQuoter(market, () => 2)('2026-09-02', 'alpaca', {
      instrument: 'AAA',
      side: 'sell',
      qty: 10,
      price: 100,
      crossesSpread: true,
    });
    expect(dates).toEqual(['2026-09-02']);
    expect(quote.price).toBeLessThan(100 * (1 - 2 / 10_000));
    expect(quote.fee).toBeGreaterThan(0);
  });
});

describe('reportCostFidelity', () => {
  it('scores the journal against the bar store and the cost model, seeding an absent FX file from its snapshot', async () => {
    const dir = scratch();
    const storePath = join(dir, 'v2.sqlite');
    journalFile(
      storePath,
      [{ id: 'entry', payload: { price: 100, stop: 90, target: 120 } }],
      [{ id: 'alpaca:f1', order: 'entry', price: 99 / YEAR_START_GBPUSD }],
    );
    const store = await ParquetBarStore.open(join(dir, 'bars'));
    await store.write('alpaca', [
      {
        symbol: 'AAA',
        bars: [
          {
            date: '2026-09-01',
            open: 99,
            high: 101,
            low: 98,
            close: 100,
            volume: 1,
            rawClose: 100,
          },
        ],
      },
    ]);
    store.close();
    const fxPath = join(dir, 'fx.csv');
    copyFileSync(FX_SNAPSHOT_PATH, join(dir, 'fx.snapshot.csv'));
    const text = await reportCostFidelity({
      storePath,
      barRoot: join(dir, 'bars'),
      from: '2026-09-01',
      to: '2026-09-30',
      mode: 'paper',
      fxPath,
    });
    expect(existsSync(fxPath)).toBe(true);
    expect(text.split('\n')).toEqual([
      expect.stringMatching(
        /^0 bps offset: 1 legs scored, realised £0\.00, modelled £[\d.]+, ratio 0\.000, FAIL \(±25%, slippage only\)$/,
      ),
      '  fidelity: bar mismatch 0, broker only 0, simulator only 0, both unfilled 0, pending 0',
      'per order leg:',
      expect.stringMatching(/^entry entry match realised £0\.00 \+ fee £0\.00, modelled/),
    ]);
  });

  it('closes the store even when the bar store fails to load', async () => {
    const storePath = join(scratch(), 'v2.sqlite');
    journalFile(storePath, [], []);
    let closed = false;
    const open = (path: string) => {
      const db = openReadOnlyStore(path);
      return Object.assign(Object.create(db) as StoreHandle, {
        close: () => {
          closed = true;
          db.close();
        },
      });
    };
    await expect(
      reportCostFidelity(
        {
          storePath,
          barRoot: join(scratch(), 'none', '\0'),
          from: '0',
          to: '9',
          mode: 'paper',
        },
        open,
      ),
    ).rejects.toThrow();
    expect(closed).toBe(true);
  });
});

describe('main', () => {
  it('defaults to the paper store, the bar store, the whole journal and paper costs', async () => {
    const lines: string[] = [];
    const calls: unknown[] = [];
    const code = await main(
      [],
      (line) => lines.push(line),
      async (inputs) => {
        calls.push(inputs);
        return 'report';
      },
    );
    expect([code, lines, calls]).toEqual([
      0,
      ['report'],
      [
        {
          storePath: 'data/samurai-v2-paper.sqlite',
          barRoot: 'data/bars/parquet',
          from: '0000-01-01',
          to: '9999-12-31',
          mode: 'paper',
        },
      ],
    ]);
  });

  it('passes an explicit window through and prints a failure with exit 1', async () => {
    const lines: string[] = [];
    const code = await main(
      ['store.sqlite', 'bars', '2026-09-01', '2026-09-30'],
      (line) => lines.push(line),
      (inputs) => Promise.reject(new Error(`no ${inputs.storePath} ${inputs.from}..${inputs.to}`)),
    );
    expect([code, lines]).toEqual([1, ['no store.sqlite 2026-09-01..2026-09-30']]);
  });

  it('passes live through and refuses any other broker mode', async () => {
    const modes: string[] = [];
    const lines: string[] = [];
    const record = async (inputs: { readonly mode: string }) => {
      modes.push(inputs.mode);
      return 'report';
    };
    const live = await main(['s', 'b', 'f', 't', 'live'], (line) => lines.push(line), record);
    const bad = await main(['s', 'b', 'f', 't', 'sim'], (line) => lines.push(line), record);
    expect([live, bad, modes, lines]).toEqual([
      0,
      1,
      ['live'],
      ['report', 'broker mode must be paper or live, got sim'],
    ]);
  });

  it('prints a non-Error rejection as text', async () => {
    const lines: string[] = [];
    await main(
      [],
      (line) => lines.push(line),
      () => Promise.reject('plain'),
    );
    expect(lines).toEqual(['plain']);
  });
});
