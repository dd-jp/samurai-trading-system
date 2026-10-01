import { afterEach, describe, expect, it } from 'vitest';
import { V2_CONTRACT_VERSION } from '../../../../contracts/index.js';
import { openSharedStore, type StoreHandle } from '../../../shared/store/index.js';
import { BarsMarketData, type MarkSource } from '../data/index.js';
import { OverviewReader } from './overview.js';
import { PositionsPanel } from './positions.js';

const NOW = new Date('2026-10-06T21:40:00.000Z');
const clock = { now: () => NOW };

let db: StoreHandle;

afterEach(() => db?.close());

function seedCapital(startCapitalGbp = 2_000, lossCapGbp = 1_500, year = 2026): void {
  db.prepare(
    `INSERT INTO v2_capital_config (year, effective_from, start_capital_gbp, loss_cap_gbp, recorded_at)
     VALUES (?, ?, ?, ?, '2026-01-01T00:00:00.000Z')`,
  ).run(year, `${year}-01-01`, startCapitalGbp, lossCapGbp);
}

function seedBook(
  bookId: string,
  variant: string,
  startCapitalGbp = 1_000,
  sleeveId = 'debate',
): void {
  db.prepare(
    `INSERT INTO v2_books (book_id, sleeve_id, variant, start_capital_gbp, cash_gbp, created_at)
     VALUES (?, ?, ?, ?, ?, '2026-09-01T00:00:00.000Z')`,
  ).run(bookId, sleeveId, variant, startCapitalGbp, startCapitalGbp);
}

interface Day {
  equity: number;
  ytdLoss: number;
  multiplier?: number;
  blocked?: boolean;
  recordedAt?: string;
}

function seedDay(bookId: string, date: string, day: Day): void {
  db.prepare(
    `INSERT INTO v2_book_days (book_id, trading_date, equity_gbp, cash_gbp, invested_gbp, ytd_loss_gbp,
       size_multiplier, entries_blocked, custody_accrual_gbp, recorded_at)
     VALUES (?, ?, ?, 0, 0, ?, ?, ?, 0, ?)`,
  ).run(
    bookId,
    date,
    day.equity,
    day.ytdLoss,
    day.multiplier ?? 1,
    day.blocked === true ? 1 : 0,
    day.recordedAt ?? `${date}T21:40:00.000Z`,
  );
}

function seedDecision(
  bookId: string,
  date: string,
  instrument: string,
  action: string,
  reason: string,
): void {
  db.prepare(
    `INSERT INTO v2_decisions (decision_id, book_id, trading_date, instrument, venue, inputs_hash, direction,
       confidence, action, reason, size_shares, stop_price, payload, recorded_at)
     VALUES (?, ?, ?, ?, 'alpaca', 'h', 'long', 0.7, ?, ?, 0, NULL, '{}', ?)`,
  ).run(
    `${bookId}-${date}-${instrument}`,
    bookId,
    date,
    instrument,
    action,
    reason,
    `${date}T21:40:00.000Z`,
  );
}

function seedSpend(model: string, costUsd: number, timestamp: string): void {
  db.prepare(
    `INSERT INTO llm_spend (trace_id, stage, model, cost_usd, timestamp) VALUES ('t', 'debate', ?, ?, ?)`,
  ).run(model, costUsd, timestamp);
}

function seedControl(action: string, reason: string, setAt: string): void {
  db.prepare(
    `INSERT INTO v2_controls (action, reason, source, idempotency_key, set_at)
     VALUES (?, ?, 'dashboard 127.0.0.1', ?, ?)`,
  ).run(action, reason, `key-${setAt}`, setAt);
}

const NO_MARKS: MarkSource = { lastBarsBefore: () => Promise.resolve(new Map()) };

function positionsPanel(): PositionsPanel {
  return new PositionsPanel(
    NO_MARKS,
    new BarsMarketData({ load: () => undefined }, [{ date: '2025-12-31', gbpUsd: 1.25 }]),
  );
}

function reader(): OverviewReader {
  return new OverviewReader(db, clock, 'paper', positionsPanel());
}

describe('OverviewReader on an empty store', () => {
  it('serves every panel, empty or owned, never a missing field', async () => {
    db = openSharedStore(':memory:');
    expect(await reader().read()).toEqual({
      contract_version: V2_CONTRACT_VERSION,
      generated_at: NOW.toISOString(),
      mode: 'paper',
      loss_budget: { status: 'empty' },
      control: { state: 'running', in_force: null, loss_budget_halted_books: [], history: [] },
      positions: { status: 'empty' },
      decisions: { status: 'empty' },
      llm_spend: {
        status: 'fed',
        month_start: '2026-10-01T00:00:00.000Z',
        spent_usd: 0,
        budget_usd: 30,
        calls_stopped: false,
        by_model: [],
        by_day: [],
      },
      heartbeat: {
        last_cycle: { status: 'empty' },
        next_due: { status: 'empty' },
        last_ping: { status: 'empty' },
      },
    });
  });
});

describe('OverviewReader positions (P3)', () => {
  it('still serves the loss budget and control when every mark read fails', async () => {
    db = openSharedStore(':memory:');
    seedCapital();
    seedBook('debate/primary', 'primary');
    seedDay('debate/primary', '2026-10-05', { equity: 1_000, ytdLoss: 0 });
    db.prepare(
      `INSERT INTO v2_positions (book_id, instrument, venue, qty, avg_price_gbp, stop_gbp, target_gbp,
         client_order_id, exit_client_order_id, opened_date, marks_held, updated_at)
       VALUES ('debate/primary', 'AAPL', 'alpaca', 1, 80, NULL, NULL, 'c', NULL, '2026-10-01', 1, 'x')`,
    ).run();
    seedControl('halt', 'news', '2026-10-05T09:00:00.000Z');
    const failing = new PositionsPanel(
      { lastBarsBefore: () => Promise.reject(new Error('parquet gone')) },
      new BarsMarketData({ load: () => undefined }, [{ date: '2025-12-31', gbpUsd: 1.25 }]),
    );
    const overview = await new OverviewReader(db, clock, 'paper', failing).read();
    expect(overview.loss_budget).toMatchObject({ status: 'fed' });
    expect(overview.control.state).toBe('halted-manual');
    expect(overview.positions).toMatchObject({
      status: 'fed',
      positions: [{ instrument: 'AAPL', mark: { status: 'unavailable' } }],
    });
  });
});

describe('OverviewReader loss budget (P1)', () => {
  function seedTwoDays(): void {
    seedCapital();
    seedBook('debate/primary', 'primary');
    seedBook('debate/no-macro-gate', 'no-macro-gate');
    seedDay('debate/primary', '2026-10-02', { equity: 900, ytdLoss: 100 });
    seedDay('debate/no-macro-gate', '2026-10-02', { equity: 800, ytdLoss: 200 });
    seedDay('debate/primary', '2026-10-05', {
      equity: 870,
      ytdLoss: 530,
      multiplier: 0.5,
      blocked: true,
    });
    seedDay('debate/no-macro-gate', '2026-10-05', { equity: 400, ytdLoss: 600, multiplier: 0.5 });
  }

  it('headlines the primary books only, against marks computed from the configured cap', async () => {
    db = openSharedStore(':memory:');
    seedTwoDays();
    expect((await reader().read()).loss_budget).toEqual({
      status: 'fed',
      year: 2026,
      capital_stale: false,
      trading_date: '2026-10-05',
      start_capital_gbp: 2_000,
      loss_cap_gbp: 1_500,
      step_marks_gbp: [500, 1_000, 1_500],
      daily_cap_gbp: 20,
      ytd_loss_gbp: 530,
      day_loss_gbp: 30,
      books: [
        {
          book_id: 'debate/primary',
          sleeve_id: 'debate',
          variant: 'primary',
          trading_date: '2026-10-05',
          ytd_loss_gbp: 530,
          day_loss_gbp: 30,
          size_multiplier: 0.5,
          entries_blocked: true,
          loss_cap_gbp: 450,
          step_marks_gbp: [150, 300, 450],
          daily_cap_gbp: 6,
        },
        {
          book_id: 'debate/no-macro-gate',
          sleeve_id: 'debate',
          variant: 'no-macro-gate',
          trading_date: '2026-10-05',
          ytd_loss_gbp: 600,
          day_loss_gbp: 400,
          size_multiplier: 0.5,
          entries_blocked: false,
          loss_cap_gbp: 450,
          step_marks_gbp: [150, 300, 450],
          daily_cap_gbp: 6,
        },
      ],
    });
  });

  it("scales a registered sleeve's cap, steps and daily cap by its capital share; an unregistered sleeve gets none", async () => {
    db = openSharedStore(':memory:');
    seedCapital(2_000, 1_500);
    seedBook('debate/primary', 'primary', 1_000, 'debate');
    seedBook('trend/primary', 'primary', 1_000, 'trend');
    seedDay('debate/primary', '2026-10-05', { equity: 900, ytdLoss: 100 });
    seedDay('trend/primary', '2026-10-05', { equity: 950, ytdLoss: 50 });
    const budget = (await reader().read()).loss_budget;
    expect(budget).toMatchObject({
      books: [
        {
          book_id: 'debate/primary',
          loss_cap_gbp: 450,
          step_marks_gbp: [150, 300, 450],
          daily_cap_gbp: 6,
        },
        { book_id: 'trend/primary', loss_cap_gbp: null, step_marks_gbp: null, daily_cap_gbp: null },
      ],
    });
  });

  it('rescales a registered sleeve against a non-default cap (D8)', async () => {
    db = openSharedStore(':memory:');
    seedCapital(3_000, 900);
    seedBook('debate/primary', 'primary', 1_000);
    seedDay('debate/primary', '2026-10-05', { equity: 990, ytdLoss: 10 });
    const budget = (await reader().read()).loss_budget;
    expect(budget).toMatchObject({
      books: [{ loss_cap_gbp: 270, step_marks_gbp: [90, 180, 270], daily_cap_gbp: 9 }],
    });
  });

  it('sums every primary book, and a first day loses nothing, as the cycle marks it', async () => {
    db = openSharedStore(':memory:');
    seedCapital(3_000, 900);
    seedBook('debate/primary', 'primary', 1_000);
    seedBook('trend/primary', 'primary', 500);
    seedDay('debate/primary', '2026-10-05', { equity: 990, ytdLoss: 10 });
    seedDay('trend/primary', '2026-10-05', { equity: 520, ytdLoss: -20 });
    const budget = (await reader().read()).loss_budget;
    expect(budget).toMatchObject({
      status: 'fed',
      ytd_loss_gbp: -10,
      day_loss_gbp: 0,
      step_marks_gbp: [300, 600, 900],
      daily_cap_gbp: 30,
    });
  });

  it('headlines the latest date whichever book sorts last', async () => {
    db = openSharedStore(':memory:');
    seedCapital();
    seedBook('debate/primary', 'primary');
    seedBook('trend/primary', 'primary');
    seedDay('debate/primary', '2026-10-05', { equity: 1_000, ytdLoss: 0 });
    seedDay('trend/primary', '2026-10-02', { equity: 1_000, ytdLoss: 0 });
    seedDecision('debate/primary', '2026-10-05', 'AAPL', 'none', 'hold');
    seedDecision('trend/primary', '2026-10-02', 'SPY', 'none', 'hold');
    const overview = await reader().read();
    expect(overview.loss_budget).toMatchObject({ trading_date: '2026-10-05' });
    expect(overview.decisions).toMatchObject({ trading_date: '2026-10-05' });
  });

  it('shows each book at its own latest day, so a lagging book keeps its date', async () => {
    db = openSharedStore(':memory:');
    seedCapital();
    seedBook('debate/primary', 'primary');
    seedBook('trend/primary', 'primary');
    seedDay('debate/primary', '2026-10-01', { equity: 1_000, ytdLoss: 0 });
    seedDay('debate/primary', '2026-10-02', { equity: 950, ytdLoss: 50 });
    seedDay('trend/primary', '2026-10-01', { equity: 1_000, ytdLoss: 0 });
    seedDay('trend/primary', '2026-10-05', { equity: 990, ytdLoss: 10 });
    const budget = (await reader().read()).loss_budget;
    expect(budget).toMatchObject({
      trading_date: '2026-10-05',
      ytd_loss_gbp: 60,
      day_loss_gbp: 60,
      books: [
        { book_id: 'debate/primary', trading_date: '2026-10-02', day_loss_gbp: 50 },
        { book_id: 'trend/primary', trading_date: '2026-10-05', day_loss_gbp: 10 },
      ],
    });
  });

  it("carries last year's capital into a new year, flagged stale until the new year is set", async () => {
    db = openSharedStore(':memory:');
    seedCapital(2_000, 1_500, 2026);
    seedBook('debate/primary', 'primary');
    seedDay('debate/primary', '2027-01-04', { equity: 1_000, ytdLoss: 0 });
    expect((await reader().read()).loss_budget).toMatchObject({
      year: 2026,
      capital_stale: true,
      trading_date: '2027-01-04',
      loss_cap_gbp: 1_500,
    });
    seedCapital(2_500, 1_200, 2027);
    expect((await reader().read()).loss_budget).toMatchObject({
      year: 2027,
      capital_stale: false,
      loss_cap_gbp: 1_200,
    });
  });

  it('says who owns the capital when the year has none configured', async () => {
    db = openSharedStore(':memory:');
    seedBook('debate/primary', 'primary');
    seedDay('debate/primary', '2026-10-05', { equity: 1_000, ytdLoss: 0 });
    expect((await reader().read()).loss_budget).toEqual({
      status: 'not-yet-fed',
      owner: 'npm run v2:capital (D8)',
      ticket: '#1745',
    });
  });
});

describe('OverviewReader control (P2)', () => {
  it('shows the manual control in force with its history, newest first', async () => {
    db = openSharedStore(':memory:');
    seedControl('pause', 'check fills', '2026-10-05T09:00:00.000Z');
    seedControl('halt', 'news shock', '2026-10-05T10:00:00.000Z');
    const control = (await reader().read()).control;
    expect(control.state).toBe('halted-manual');
    expect(control.in_force).toEqual({
      control_id: 2,
      action: 'halt',
      reason: 'news shock',
      source: 'dashboard 127.0.0.1',
      set_at: '2026-10-05T10:00:00.000Z',
    });
    expect(control.history.map((row) => row.action)).toEqual(['halt', 'pause']);
  });

  it('shows paused, and nothing in force after a resume', async () => {
    db = openSharedStore(':memory:');
    seedControl('pause', 'p', '2026-10-05T09:00:00.000Z');
    expect((await reader().read()).control).toMatchObject({
      state: 'paused',
      in_force: { action: 'pause' },
    });
    seedControl('resume', 'r', '2026-10-05T10:00:00.000Z');
    expect((await reader().read()).control).toMatchObject({ state: 'running', in_force: null });
  });

  it('keeps twenty rows of history', async () => {
    db = openSharedStore(':memory:');
    for (let minute = 10; minute < 35; minute += 1) {
      seedControl('pause', `p${minute}`, `2026-10-05T09:${minute}:00.000Z`);
    }
    const history = (await reader().read()).control.history;
    expect(history).toHaveLength(20);
    expect(history[0]?.reason).toBe('p34');
  });

  it('shows the loss-budget halt over any manual state once every primary book is halted', async () => {
    db = openSharedStore(':memory:');
    seedCapital();
    seedBook('debate/primary', 'primary');
    seedBook('debate/no-macro-gate', 'no-macro-gate');
    seedDay('debate/primary', '2026-10-05', { equity: 0, ytdLoss: 1_500, multiplier: 0 });
    seedDay('debate/no-macro-gate', '2026-10-05', { equity: 1_000, ytdLoss: 0 });
    seedControl('resume', 'r', '2026-10-05T10:00:00.000Z');
    expect((await reader().read()).control).toMatchObject({
      state: 'halted-loss-budget',
      loss_budget_halted_books: ['debate/primary'],
    });
    seedControl('pause', 'p', '2026-10-05T11:00:00.000Z');
    expect((await reader().read()).control.state).toBe('halted-loss-budget');
  });

  it('lists a halted primary book without calling the account halted while another trades', async () => {
    db = openSharedStore(':memory:');
    seedCapital();
    seedBook('debate/primary', 'primary');
    seedBook('trend/primary', 'primary');
    seedDay('debate/primary', '2026-10-05', { equity: 0, ytdLoss: 1_500, multiplier: 0 });
    seedDay('trend/primary', '2026-10-05', { equity: 1_000, ytdLoss: 0 });
    expect((await reader().read()).control).toMatchObject({
      state: 'running',
      loss_budget_halted_books: ['debate/primary'],
    });
  });

  it('never calls a halted shadow book a loss-budget halt', async () => {
    db = openSharedStore(':memory:');
    seedCapital();
    seedBook('debate/primary', 'primary');
    seedBook('debate/no-veto', 'no-veto');
    seedDay('debate/primary', '2026-10-05', { equity: 1_000, ytdLoss: 0 });
    seedDay('debate/no-veto', '2026-10-05', { equity: 0, ytdLoss: 1_500, multiplier: 0 });
    expect((await reader().read()).control).toMatchObject({
      state: 'running',
      loss_budget_halted_books: [],
    });
  });
});

describe('OverviewReader decisions (P4)', () => {
  it("shows the last cycle's primary decisions and marks vetoes", async () => {
    db = openSharedStore(':memory:');
    seedBook('debate/primary', 'primary');
    seedBook('debate/no-veto', 'no-veto');
    seedDecision('debate/primary', '2026-10-02', 'AAPL', 'enter_long', 'old');
    seedDecision('debate/primary', '2026-10-05', 'MSFT', 'skip', 'vetoed: earnings');
    seedDecision('debate/primary', '2026-10-05', 'AAPL', 'enter_long', 'strong');
    seedDecision('debate/primary', '2026-10-05', 'NVDA', 'skip', 'below floor');
    seedDecision('debate/no-veto', '2026-10-06', 'MSFT', 'enter_long', 'shadow');
    expect((await reader().read()).decisions).toEqual({
      status: 'fed',
      trading_date: '2026-10-05',
      decisions: [
        {
          book_id: 'debate/primary',
          trading_date: '2026-10-05',
          instrument: 'AAPL',
          venue: 'alpaca',
          direction: 'long',
          action: 'enter_long',
          vetoed: false,
          reason: 'strong',
          confidence: 0.7,
        },
        expect.objectContaining({ instrument: 'MSFT', action: 'skip', vetoed: true }),
        expect.objectContaining({ instrument: 'NVDA', action: 'skip', vetoed: false }),
      ],
    });
  });

  it("shows each primary book's own latest decisions, so a lagging book is not hidden", async () => {
    db = openSharedStore(':memory:');
    seedBook('debate/primary', 'primary');
    seedBook('trend/primary', 'primary');
    seedDecision('debate/primary', '2026-10-01', 'AAPL', 'enter_long', 'old');
    seedDecision('debate/primary', '2026-10-02', 'MSFT', 'none', 'hold');
    seedDecision('trend/primary', '2026-10-05', 'SPY', 'enter_long', 'trend');
    expect((await reader().read()).decisions).toMatchObject({
      trading_date: '2026-10-05',
      decisions: [
        { book_id: 'debate/primary', trading_date: '2026-10-02', instrument: 'MSFT' },
        { book_id: 'trend/primary', trading_date: '2026-10-05', instrument: 'SPY' },
      ],
    });
  });

  it('never calls a non-skip with a vetoed-looking reason a veto', async () => {
    db = openSharedStore(':memory:');
    seedBook('debate/primary', 'primary');
    seedDecision('debate/primary', '2026-10-05', 'AAPL', 'none', 'vetoed: stale');
    expect((await reader().read()).decisions).toMatchObject({ decisions: [{ vetoed: false }] });
  });
});

describe('OverviewReader LLM spend (P11)', () => {
  it('totals this month per model and per day, and says when the cap has stopped calls', async () => {
    db = openSharedStore(':memory:');
    seedSpend('opus', 5, '2026-09-30T23:59:59.000Z');
    seedSpend('sonnet', 2, '2026-10-01T08:00:00.000Z');
    seedSpend('opus', 20, '2026-10-01T09:00:00.000Z');
    seedSpend('sonnet', 3, '2026-10-05T09:00:00.000Z');
    expect((await reader().read()).llm_spend).toEqual({
      status: 'fed',
      month_start: '2026-10-01T00:00:00.000Z',
      spent_usd: 25,
      budget_usd: 30,
      calls_stopped: false,
      by_model: [
        { model: 'opus', cost_usd: 20 },
        { model: 'sonnet', cost_usd: 5 },
      ],
      by_day: [
        { day: '2026-10-01', cost_usd: 22 },
        { day: '2026-10-05', cost_usd: 3 },
      ],
    });
    seedSpend('opus', 5, '2026-10-06T09:00:00.000Z');
    expect((await reader().read()).llm_spend).toMatchObject({ spent_usd: 30, calls_stopped: true });
  });

  it('serves a non-finite month total as null, with calls stopped', async () => {
    db = openSharedStore(':memory:');
    seedSpend('opus', 1e308, '2026-10-01T08:00:00.000Z');
    seedSpend('opus', 1e308, '2026-10-02T08:00:00.000Z');
    expect((await reader().read()).llm_spend).toMatchObject({
      spent_usd: null,
      calls_stopped: true,
    });
  });

  it('orders models of equal spend by name', async () => {
    db = openSharedStore(':memory:');
    seedSpend('b', 1, '2026-10-01T08:00:00.000Z');
    seedSpend('a', 1, '2026-10-01T08:00:00.000Z');
    expect((await reader().read()).llm_spend).toMatchObject({
      by_model: [
        { model: 'a', cost_usd: 1 },
        { model: 'b', cost_usd: 1 },
      ],
    });
  });
});

describe('OverviewReader heartbeat (P14)', () => {
  it('reports the most recently recorded cycle', async () => {
    db = openSharedStore(':memory:');
    seedBook('debate/primary', 'primary');
    seedDay('debate/primary', '2026-10-02', { equity: 1_000, ytdLoss: 0 });
    seedDay('debate/primary', '2026-10-05', {
      equity: 1_000,
      ytdLoss: 0,
      recordedAt: '2026-10-05T21:41:07.000Z',
    });
    expect((await reader().read()).heartbeat.last_cycle).toEqual({
      status: 'fed',
      trading_date: '2026-10-05',
      recorded_at: '2026-10-05T21:41:07.000Z',
    });
  });

  it('serves the next due day after the newest recorded cycle, skipping a weekend', async () => {
    db = openSharedStore(':memory:');
    seedBook('debate/primary', 'primary');
    seedDay('debate/primary', '2026-10-02', { equity: 1_000, ytdLoss: 0 });
    expect((await reader().read()).heartbeat.next_due).toEqual({
      status: 'fed',
      due_date: '2026-10-05',
    });
  });

  it('skips a day both venues are closed', async () => {
    db = openSharedStore(':memory:');
    seedBook('debate/primary', 'primary');
    seedDay('debate/primary', '2026-12-24', { equity: 1_000, ytdLoss: 0 });
    expect((await reader().read()).heartbeat.next_due).toEqual({
      status: 'fed',
      due_date: '2026-12-28',
    });
  });

  it('counts a venues-closed skip as the newest cycle', async () => {
    db = openSharedStore(':memory:');
    seedBook('debate/primary', 'primary');
    seedDay('debate/primary', '2026-10-02', { equity: 1_000, ytdLoss: 0 });
    db.prepare(
      `INSERT INTO v2_refusals (trading_date, scope, parameter, ticket, message, recorded_at)
       VALUES ('2026-10-05', 'cycle', 'venues_closed', '#1933', 'closed', '2026-10-05T07:30:00.000Z')`,
    ).run();
    expect((await reader().read()).heartbeat.next_due).toEqual({
      status: 'fed',
      due_date: '2026-10-06',
    });
  });

  it('reports the newest journalled ping with its outcome', async () => {
    db = openSharedStore(':memory:');
    const ping = db.prepare('INSERT INTO v2_heartbeat_pings (outcome, pinged_at) VALUES (?, ?)');
    ping.run('success', '2026-10-05T21:41:00.000Z');
    ping.run('fail', '2026-10-06T21:41:00.000Z');
    expect((await reader().read()).heartbeat.last_ping).toEqual({
      status: 'fed',
      outcome: 'fail',
      pinged_at: '2026-10-06T21:41:00.000Z',
    });
  });

  it('carries the dry-run mode through', async () => {
    db = openSharedStore(':memory:');
    expect((await new OverviewReader(db, clock, 'dry-run', positionsPanel()).read()).mode).toBe(
      'dry-run',
    );
  });
});
