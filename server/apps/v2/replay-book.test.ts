import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { createBrokerAccess } from './execution/index.js';
import { composeV2Root } from './index.js';
import { formatReplay } from './replay.js';
import { journalledDay, journalledSessions, rebuildBooks, rewoundCopy } from './replay-book.js';
import { type ReplayCliOptions, replayFromFiles } from './replay-cli.js';
import { CapitalConfigStore, PaperBooks } from './risk/index.js';
import type { ModelPin } from './signal/index.js';
import { DEBATE_SLEEVE_SPEC, ScriptedTransport } from './signal/index.js';

vi.mock('./execution/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./execution/index.js')>();
  return { ...actual, createBrokerAccess: vi.fn(actual.createBrokerAccess) };
});

const ORIGIN = Date.UTC(2026, 0, 1);
const dateAt = (day: number) => new Date(ORIGIN + day * 86_400_000).toISOString().slice(0, 10);
const ENTRY_DAY = dateAt(260);
const FILL_DAY = dateAt(261);
const EXIT_DAY = dateAt(262);
const OPEN_EVERY_DAY: VenueSessionGate = {
  entrySitOut: () => undefined,
  timeStopPausedVenues: () => [],
};

function rising(base: number, spikeOn?: string): DailyBar[] {
  const bars: DailyBar[] = [];
  for (let i = 0; i <= 262; i += 1) {
    const close = base * (1 + 0.001 * i);
    const date = dateAt(i);
    bars.push({
      date,
      open: close,
      high: close * (date === spikeOn ? 1.15 : 1.01),
      low: close * 0.99,
      close,
      volume: 1_000_000,
      rawClose: close,
    });
  }
  return bars;
}

function answer(request: AnthropicMessageRequest): string {
  const prompt = request.messages[0]?.content ?? '';
  if (prompt.includes('Mediator persona')) {
    return '{"stance":"bullish","rationale":"trend agrees","converged":true}';
  }
  return prompt.includes('Bull persona')
    ? '{"stance":"bullish","rationale":"above the 200-day"}'
    : '{"stance":"bearish","rationale":"stretched"}';
}

let directory: string;
let options: ReplayCliOptions;

async function writeBars(root: string, hold: DailyBar[]): Promise<void> {
  const store = await ParquetBarStore.open(root);
  await store.write('alpaca', [
    { symbol: 'UP', bars: rising(2, FILL_DAY) },
    { symbol: 'HOLD', bars: hold },
    { symbol: 'SPY', bars: rising(20) },
  ]);
  store.close();
}

async function runDay(tradingDate: string): Promise<void> {
  const root = composeV2Root({
    tradingDate,
    dryRun: true,
    storePath: options.storePath,
    barStoreRoot: options.barStoreRoot,
    constituentsPath: options.constituentsPath,
    fxPath: options.fxPath,
    spreadsPath: options.spreadsPath,
    saxoSpreadsPath: options.saxoSpreadsPath,
    cfdCataloguePath: options.cfdCataloguePath,
    clock: new SimulatedClock(new Date(`${tradingDate}T07:30:00.000Z`)),
    logger: { log: () => {} },
    venueSessions: OPEN_EVERY_DAY,
    transportFor: (pin: ModelPin) => new ScriptedTransport(pin, answer),
    newsSource: { headlines: () => Promise.resolve([]) },
  });
  try {
    await root.run();
  } finally {
    root.close();
  }
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'v2-replay-book-'));
  const barStoreRoot = join(directory, 'parquet');
  await writeBars(barStoreRoot, rising(20));
  const constituentsPath = join(directory, 'constituents.csv');
  writeFileSync(constituentsPath, `date,tickers\n2016-01-04,"UP,HOLD"\n${EXIT_DAY},"UP"\n`);
  const fxPath = join(directory, 'fx.csv');
  writeFileSync(fxPath, 'DATE,XUDLUSS\n31 Dec 2025,1.25\n02 Jan 2026,1.26\n');
  const spreadsPath = join(directory, 'spreads.csv');
  writeFileSync(spreadsPath, 'symbol,sessions,median_half_spread_bps\nUP,10,2\nHOLD,10,3\n');
  const storePath = join(directory, 'paper.sqlite');
  const seed = openSharedStore(storePath);
  new CapitalConfigStore(seed, new SimulatedClock(new Date('2026-01-01T00:00:00.000Z'))).setYear(
    2026,
    100_000,
    1_500,
  );
  seed.close();
  options = {
    tradingDate: EXIT_DAY,
    storePath,
    barStoreRoot,
    constituentsPath,
    fxPath,
    spreadsPath,
    saxoSpreadsPath: join(directory, 'absent-saxo-spreads.csv'),
    cfdCataloguePath: join(directory, 'absent-catalogue.json'),
    venueSessions: OPEN_EVERY_DAY,
  };
  for (const day of [ENTRY_DAY, FILL_DAY, EXIT_DAY]) await runDay(day);
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

function digestOf(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function journalRows(sql: string): unknown[] {
  const db = new BetterSqlite3(options.storePath, { readonly: true });
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

function tamperedCopy(name: string, sql: string): ReplayCliOptions {
  const storePath = join(directory, `${name}.sqlite`);
  copyFileSync(options.storePath, storePath);
  const db = new BetterSqlite3(storePath);
  db.exec(sql);
  db.close();
  return { ...options, storePath };
}

describe('replay of sizing, orders, fills and marks', () => {
  it('journals an entry on the first day, its fill on the second and a bracket exit on the third', () => {
    expect(
      journalRows(
        `SELECT trading_date, leg, json_extract(payload, '$.detail') AS detail FROM v2_orders
          WHERE book_id = 'debate/primary' AND instrument = 'UP' ORDER BY rowid`,
      ),
    ).toEqual([
      { trading_date: ENTRY_DAY, leg: 'entry', detail: expect.stringContaining('dry run refused') },
      { trading_date: EXIT_DAY, leg: 'exit', detail: 'bracket_leg_on_daily_bar' },
      { trading_date: EXIT_DAY, leg: 'entry', detail: expect.stringContaining('dry run refused') },
    ]);
    expect(
      journalRows(
        `SELECT trading_date, leg FROM v2_fills
          WHERE book_id = 'debate/primary' AND instrument = 'UP' ORDER BY rowid`,
      ),
    ).toEqual([
      { trading_date: FILL_DAY, leg: 'entry' },
      { trading_date: EXIT_DAY, leg: 'exit' },
    ]);
  });

  it.each([ENTRY_DAY, FILL_DAY, EXIT_DAY])(
    'replays %s to identical orders, fills and marks without writing or building a venue adapter',
    async (tradingDate) => {
      const before = digestOf(options.storePath);
      vi.mocked(createBrokerAccess).mockClear();
      const result = await replayFromFiles({ ...options, tradingDate });
      expect(result.divergences).toEqual([]);
      expect(result.orders + result.fills).toBeGreaterThan(0);
      expect(createBrokerAccess).not.toHaveBeenCalled();
      expect(digestOf(options.storePath)).toBe(before);
    },
  );

  it('replays the exit day with its bracket exit, its fills and its re-entry', async () => {
    const result = await replayFromFiles(options);
    expect(result).toMatchObject({ orders: 6, fills: 3, divergences: [] });
    expect(formatReplay(result, (text) => text)).toMatch(/identical$/);
  });

  it('names a changed bar of a held name as an input change, then at the sizing step', async () => {
    const barStoreRoot = join(directory, 'revised-parquet');
    const hold = rising(20).map((bar) =>
      bar.date === FILL_DAY ? { ...bar, rawClose: bar.rawClose * 1.03 } : bar,
    );
    await writeBars(barStoreRoot, hold);
    const result = await replayFromFiles({ ...options, barStoreRoot });
    expect(result.divergences[0]).toMatchObject({
      kind: 'input_changed_since',
      journalled: { input: 'bars', name: 'HOLD' },
    });
    expect(result.divergences[1]).toMatchObject({
      kind: 'row_field',
      stage: 'sizing',
      key: 'debate/primary|UP',
      field: 'size_shares',
    });
    expect(formatReplay(result, (text) => text)).toContain(`HOLD: bars changed since ${EXIT_DAY}`);
  });

  it('detects a changed loss-budget state at the gate, before the sizing it changes', async () => {
    const result = await replayFromFiles(
      tamperedCopy(
        'budget',
        `UPDATE v2_book_days SET size_multiplier = 0.5
          WHERE book_id = 'debate/primary' AND trading_date = '${FILL_DAY}'`,
      ),
    );
    expect(result.divergences[0]).toEqual({
      kind: 'book_state',
      stage: 'gate',
      bookId: 'debate/primary',
      asOf: FILL_DAY,
      field: 'size_multiplier',
      journalled: 0.5,
      replayed: 1,
    });
    expect(result.divergences).toContainEqual(
      expect.objectContaining({ stage: 'sizing', key: 'debate/primary|UP' }),
    );
    expect(formatReplay(result, (text) => text)).toContain(
      `gate: debate/primary loss budget at the ${FILL_DAY} mark: size_multiplier differs`,
    );
  });

  it('detects a changed earlier fill in the rebuilt book state', async () => {
    const result = await replayFromFiles(
      tamperedCopy(
        'fill',
        `DROP TRIGGER v2_fills_no_update;
         UPDATE v2_fills SET price_gbp = price_gbp + 0.01
          WHERE book_id = 'debate/primary' AND instrument = 'HOLD'`,
      ),
    );
    expect(result.divergences[0]).toMatchObject({
      kind: 'book_state',
      stage: 'book',
      bookId: 'debate/primary',
      asOf: FILL_DAY,
      field: 'cash_gbp',
    });
  });

  it('rewinds into a copy that holds none of the LLM call log or spend the replay reads from the journal', () => {
    const db = new BetterSqlite3(options.storePath, { readonly: true });
    const count = (handle: BetterSqlite3.Database, table: string) =>
      (handle.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    try {
      expect(count(db, 'llm_call_log')).toBeGreaterThan(0);
      const copy = rewoundCopy(db, EXIT_DAY, `${EXIT_DAY}T07:30:00.000Z`);
      expect([count(copy, 'llm_call_log'), count(copy, 'llm_spend')]).toEqual([0, 0]);
      expect(count(copy, 'v2_books')).toBe(count(db, 'v2_books'));
      copy.close();
    } finally {
      db.close();
    }
  });

  it('names an exit the journal holds but the replay did not make', async () => {
    const result = await replayFromFiles(
      tamperedCopy(
        'extra',
        `INSERT INTO v2_orders (client_order_id, decision_id, book_id, trading_date, instrument,
           venue, leg, side, dry_run, outcome, payload, recorded_at)
         VALUES ('v2-debate-primary-${EXIT_DAY}-HOLD-exit', NULL, 'debate/primary', '${EXIT_DAY}',
           'HOLD', 'alpaca', 'exit', 'sell', 1, 'simulated', '{}', '${EXIT_DAY}T07:30:00.000Z')`,
      ),
    );
    expect(result.divergences).toEqual([
      { kind: 'row_missing', stage: 'orders', key: `v2-debate-primary-${EXIT_DAY}-HOLD-exit` },
    ]);
  });
});

describe('rebuildBooks', () => {
  const clock = new SimulatedClock(new Date('2026-03-04T07:30:00.000Z'));
  const market = {
    lastBarBefore: () => undefined,
    barsBefore: () => [],
    gbpUsdAtYearStart: () => 1.25,
  };
  const sleeves = [{ id: 'debate', spec: DEBATE_SLEEVE_SPEC }];

  function journal(): BetterSqlite3.Database {
    const db = openSharedStore(':memory:');
    new CapitalConfigStore(db, clock).setYear(2026, 2_000, 1_500);
    db.prepare(
      `INSERT INTO v2_books (book_id, sleeve_id, variant, start_capital_gbp, cash_gbp, created_at)
       VALUES ('debate/primary', 'debate', 'primary', 600, 1, 'now')`,
    ).run();
    const order = db.prepare(
      `INSERT INTO v2_orders (client_order_id, decision_id, book_id, trading_date, instrument, venue,
         leg, side, dry_run, outcome, payload, recorded_at)
       VALUES (?, NULL, 'debate/primary', ?, 'UP', 'alpaca', ?, ?, 1, ?, ?, 'now')`,
    );
    order.run('entry', '2026-03-01', 'entry', 'buy', 'refused_dry_run', '{"stop":8,"target":15}');
    order.run('v2-x-2026-03-01-UP-exit', '2026-03-01', 'exit', 'sell', 'simulated', '{}');
    order.run('v2-x-2026-03-02-UP-exit', '2026-03-02', 'exit', 'sell', 'simulated', '{}');
    order.run('v2-x-2026-03-03-UP-exit', '2026-03-03', 'exit', 'sell', 'simulated', '{}');
    order.run(
      'v2-x-2026-03-03-UP-rearm',
      '2026-03-03',
      'exit',
      'sell',
      'submitted',
      '{"exit_client_order_id":"v2-x-2026-03-03-UP-exit"}',
    );
    order.run('late', '2026-03-03', 'entry', 'buy', 'cancelled', '{"cancelled":"2026-03-04"}');
    db.prepare(
      `INSERT INTO v2_fills (fill_id, client_order_id, book_id, trading_date, instrument, venue, leg,
         side, qty, price_gbp, fee_gbp, recorded_at)
       VALUES ('alpaca:sim-entry', 'entry', 'debate/primary', '2026-03-02', 'UP', 'alpaca', 'entry',
         'buy', 4, 10, 0.5, 'now')`,
    ).run();
    const mark = db.prepare(
      `INSERT INTO v2_book_days (book_id, trading_date, equity_gbp, cash_gbp, invested_gbp,
         ytd_loss_gbp, size_multiplier, entries_blocked, custody_accrual_gbp,
         cfd_financing_accrual_gbp, cfd_borrow_accrual_gbp, recorded_at)
       VALUES ('debate/primary', ?, 600, 0, 0, 0, 1, 0, ?, 0.25, 0.125, ?)`,
    );
    mark.run('2026-03-02', 1, '2026-03-02T07:31:00.000Z');
    mark.run('2026-03-03', 2, '2026-03-03T07:31:00.000Z');
    return db;
  }

  function rebuiltAt(tradingDate: string, venueSessions: VenueSessionGate) {
    const db = journal();
    const copy = rewoundCopy(db, tradingDate, `${tradingDate}T07:30:00.000Z`);
    db.close();
    const capital = new CapitalConfigStore(copy, clock);
    const books = new PaperBooks(copy, clock, capital, tradingDate, sleeves);
    rebuildBooks({ copy, books, market, venueSessions });
    return { copy, books };
  }

  it('replays fills and mark accruals into cash and counts marks held, a rearmed flatten no longer pending', () => {
    const { copy, books } = rebuiltAt('2026-03-04', OPEN_EVERY_DAY);
    expect(books.cash('debate/primary')).toBe(600 - 40.5 - 1.375 - 2.375);
    expect(books.positions('debate/primary')).toEqual([
      expect.objectContaining({
        instrument: 'UP',
        qty: 4,
        stopGbp: 8 / 1.25,
        targetGbp: 15 / 1.25,
        marksHeld: 2,
        exitClientOrderId: undefined,
      }),
    ]);
    expect(
      copy.prepare("SELECT outcome, payload FROM v2_orders WHERE client_order_id = 'late'").get(),
    ).toEqual({ outcome: 'refused_dry_run', payload: '{}' });
    copy.close();
  });

  it('cuts the journal at the day, restores the flatten pending then and pauses a closed venue time stop', () => {
    const { copy, books } = rebuiltAt('2026-03-03', {
      ...OPEN_EVERY_DAY,
      timeStopPausedVenues: () => ['alpaca'],
    });
    expect(books.positions('debate/primary')).toEqual([
      expect.objectContaining({ marksHeld: 0, exitClientOrderId: 'v2-x-2026-03-02-UP-exit' }),
    ]);
    expect(copy.prepare('SELECT COUNT(*) AS n FROM v2_book_days').get()).toEqual({ n: 1 });
    copy.close();
  });
});

describe('journalledDay', () => {
  it('takes the mode from the day orders, and from the rest of the store on a day with none', () => {
    const db = openSharedStore(':memory:');
    db.prepare(
      `INSERT INTO v2_books (book_id, sleeve_id, variant, start_capital_gbp, cash_gbp, created_at)
       VALUES ('debate/primary', 'debate', 'primary', 600, 600, 'now')`,
    ).run();
    const order = db.prepare(
      `INSERT INTO v2_orders (client_order_id, decision_id, book_id, trading_date, instrument, venue,
         leg, side, dry_run, outcome, payload, recorded_at)
       VALUES (?, NULL, 'debate/primary', ?, 'UP', 'alpaca', 'entry', 'buy', ?, 'submitted', '{}',
         'now')`,
    );
    expect(journalledDay(db, '2026-09-29').dryRun).toBe(false);
    order.run('stray', '2026-09-28', 1);
    order.run('paper', '2026-09-29', 0);
    expect(journalledDay(db, '2026-09-29').dryRun).toBe(false);
    expect(journalledDay(db, '2026-09-28').dryRun).toBe(true);
    expect(journalledDay(db, '2026-09-30').dryRun).toBe(true);
    db.close();
  });
});

describe('journalledSessions', () => {
  it('reads a late wake back from its sit-out refusal and asks the calendar otherwise', () => {
    const db = openSharedStore(':memory:');
    db.prepare(
      `INSERT INTO v2_refusals (trading_date, scope, parameter, ticket, message, recorded_at)
       VALUES ('2026-09-30', 'entry', 'late_wake_entry_cutoff', '#1933',
         'debate/primary VOD.L: saxo entry sits out (late_wake_entry_cutoff)', 'now')`,
    ).run();
    const starts: Date[] = [];
    const gate = journalledSessions(db, '2026-09-30', {
      entrySitOut: (_venue, _date, start) => {
        starts.push(start);
        return undefined;
      },
      timeStopPausedVenues: () => ['saxo'],
    });
    expect(gate.entrySitOut('saxo', '2026-09-30', new Date())).toBe('late_wake_entry_cutoff');
    expect(gate.entrySitOut('alpaca', '2026-09-30', new Date())).toBeUndefined();
    expect(starts).toEqual([new Date(0)]);
    expect(gate.timeStopPausedVenues('2026-09-29', '2026-09-30')).toEqual(['saxo']);
    db.close();
  });
});
