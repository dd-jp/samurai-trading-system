import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LogEntry } from '../../shared/index.js';
import { SimulatedClock } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import type { CycleReport } from './cycle.js';
import {
  type BookSummary,
  type DailySummary,
  formatDailySummary,
  pushDailySummary,
  readDailySummary,
  tally,
} from './daily-summary.js';
import { FaultLedger } from './journal/index.js';
import { CapitalConfigStore } from './risk/index.js';

const DAY = '2026-09-30';
const PREVIOUS = '2026-09-29';
const PREVIOUS_MARK = '2026-09-29T07:31:00.000Z';
const IN_WINDOW = '2026-09-29T15:00:00.000Z';
const BEFORE_WINDOW = '2026-09-29T07:00:00.000Z';
const CLOCK = new SimulatedClock(new Date('2026-09-30T07:40:00.000Z'));

function book(overrides: Partial<BookSummary> = {}): BookSummary {
  return {
    book_id: 'debate/primary',
    equity_gbp: 598.5,
    day_pnl_gbp: -1.5,
    ytd_loss_gbp: 1.5,
    loss_cap_gbp: 450,
    size_multiplier: 1,
    entries_blocked: false,
    open_positions: 2,
    decisions: 4,
    entries_placed: 2,
    entries_filled: 1,
    entries_rejected: 1,
    exits_filled: 1,
    refusals: {
      count: 3,
      top: [
        { code: 'LOSS_BUDGET', count: 2 },
        { code: 'gross_cap', count: 1 },
      ],
    },
    ...overrides,
  };
}

const NO_REFUSALS = { count: 0, top: [] };

function summary(overrides: Partial<DailySummary> = {}): DailySummary {
  return {
    trading_date: DAY,
    since: PREVIOUS_MARK,
    books: [book()],
    signal_refusals: { count: 1, top: [{ code: 'stale_last_close', count: 1 }] },
    other_refusals: NO_REFUSALS,
    faults: { recorded: [], free_weeks: 3, counted_days: 23, last_fault: undefined },
    llm: { spent_usd: 4.2, budget_usd: 30, stopped: false },
    ...overrides,
  };
}

describe('formatDailySummary', () => {
  it('writes one short block per book, then the sleeve-level refusals and LLM spend', () => {
    expect(formatDailySummary(summary(), 'paper')).toBe(
      [
        'Samurai v2 daily summary 2026-09-30 (paper)',
        'Window: since the last cycle, 2026-09-29 07:31 UTC',
        'debate/primary: equity £598.50, day -£1.50; full size; year -£1.50, £448.50 left of £450.00 loss cap',
        '  decisions 4; entries 2 placed, 1 filled, 1 rejected; exits 1; open 2',
        '  refusals 3 (LOSS_BUDGET 2, gross_cap 1)',
        'Signals refused before a book: 1 (stale_last_close 1)',
        'Other refusals: 0',
        'Faults since the last cycle: 0; fault-free weeks 3 (23 counted days, no fault yet)',
        'LLM spend this month: $4.20 of $30.00',
      ].join('\n'),
    );
  });

  it('names each loss-budget stage, a daily-cap block, a gain, a first cycle and a stopped LLM', () => {
    const text = formatDailySummary(
      summary({
        since: null,
        books: [
          book({ size_multiplier: 0.5, day_pnl_gbp: 12, entries_blocked: true }),
          book({ size_multiplier: 0.25, day_pnl_gbp: 0, loss_cap_gbp: null }),
          book({ size_multiplier: 0, ytd_loss_gbp: -3 }),
          book({ size_multiplier: 0.7 }),
        ],
        faults: {
          recorded: [
            { code: 'failed_broker_call', count: 2 },
            { code: 'missed_run', count: 1 },
          ],
          free_weeks: 0,
          counted_days: 0,
          last_fault: '2026-09-30',
        },
        llm: { spent_usd: null, budget_usd: 30, stopped: true },
      }),
      'dry-run',
    );
    expect(text).toContain(
      'Faults since the last cycle: 3 (failed_broker_call 2, missed_run 1); fault-free weeks 0 (0 counted days, last fault 2026-09-30)',
    );
    expect(text).toContain('(dry-run)');
    expect(text).toContain('Window: everything journalled so far (first cycle)');
    expect(text).toContain(
      'day +£12.00; half size, entries blocked today; year -£1.50, £448.50 left',
    );
    expect(text).toContain('day £0.00; quarter size; year -£1.50\n');
    expect(text).toContain('; halted; year +£3.00, £453.00 left');
    expect(text).toContain('; size x0.7; year');
    expect(text).toContain('LLM spend this month: n/a of $30.00 (calls stopped)');
  });
});

describe('tally', () => {
  it('sums every code but lists only the three most frequent, ties by name', () => {
    const row = (parameter: string, n: number) => ({ book_id: null, scope: 'data', parameter, n });
    expect(tally([row('d', 1), row('c', 2), row('a', 2), row('b', 5), row('a', 1)])).toEqual({
      count: 11,
      top: [
        { code: 'b', count: 5 },
        { code: 'a', count: 3 },
        { code: 'c', count: 2 },
      ],
    });
  });
});

describe('readDailySummary', () => {
  let db: StoreHandle;

  beforeEach(() => {
    db = openSharedStore(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  function seedBook(bookId: string, sleeveId: string, variant: string): void {
    db.prepare(
      `INSERT INTO v2_books (book_id, sleeve_id, variant, start_capital_gbp, cash_gbp, created_at)
       VALUES (?, ?, ?, 600, 600, ?)`,
    ).run(bookId, sleeveId, variant, BEFORE_WINDOW);
  }

  function seedDay(
    bookId: string,
    date: string,
    equity: number,
    extra: Partial<Record<string, number>> = {},
  ) {
    db.prepare(
      `INSERT INTO v2_book_days (book_id, trading_date, equity_gbp, cash_gbp, invested_gbp, ytd_loss_gbp,
         size_multiplier, entries_blocked, custody_accrual_gbp, recorded_at)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?, 0, ?)`,
    ).run(
      bookId,
      date,
      equity,
      equity,
      extra.ytd ?? 0,
      extra.multiplier ?? 1,
      extra.blocked ?? 0,
      date === DAY ? '2026-09-30T07:35:00.000Z' : PREVIOUS_MARK,
    );
  }

  function seedOrder(id: string, bookId: string, leg: string, outcome: string, at: string): void {
    db.prepare(
      `INSERT INTO v2_orders (client_order_id, decision_id, book_id, trading_date, instrument, venue, leg,
         side, dry_run, outcome, payload, recorded_at)
       VALUES (?, NULL, ?, ?, 'UP', 'alpaca', ?, 'buy', 0, ?, '{}', ?)`,
    ).run(id, bookId, PREVIOUS, leg, outcome, at);
  }

  function seedFill(
    fillId: string,
    orderId: string,
    bookId: string,
    leg: string,
    at: string,
  ): void {
    db.prepare(
      `INSERT INTO v2_fills (fill_id, client_order_id, book_id, trading_date, instrument, venue, leg, side,
         qty, price_gbp, fee_gbp, recorded_at)
       VALUES (?, ?, ?, ?, 'UP', 'alpaca', ?, 'buy', 1, 10, 0, ?)`,
    ).run(fillId, orderId, bookId, DAY, leg, at);
  }

  function seedDecision(id: string, bookId: string, at: string): void {
    db.prepare(
      `INSERT INTO v2_decisions (decision_id, book_id, trading_date, instrument, venue, inputs_hash,
         direction, confidence, action, reason, size_shares, stop_price, payload, recorded_at)
       VALUES (?, ?, ?, 'UP', 'alpaca', 'h', 'long', 0.6, 'enter_long', 'r', 1, NULL, '{}', ?)`,
    ).run(id, bookId, DAY, at);
  }

  function seedRefusal(scope: string, parameter: string, bookId: string | null, at: string): void {
    db.prepare(
      `INSERT INTO v2_refusals (trading_date, scope, parameter, ticket, message, book_id, recorded_at)
       VALUES (?, ?, ?, '#1', 'account 12345 detail', ?, ?)`,
    ).run(DAY, scope, parameter, bookId, at);
  }

  function seedPosition(bookId: string, instrument: string): void {
    db.prepare(
      `INSERT INTO v2_positions (book_id, instrument, venue, qty, avg_price_gbp, client_order_id,
         opened_date, marks_held, updated_at)
       VALUES (?, ?, 'alpaca', 1, 10, 'o', ?, 0, ?)`,
    ).run(bookId, instrument, PREVIOUS, IN_WINDOW);
  }

  it('counts only what was journalled after the previous cycle, per book, with no refusal messages', () => {
    new CapitalConfigStore(db, CLOCK).setYear(2026, 2_000, 1_500);
    seedBook('debate/primary', 'debate', 'primary');
    seedBook('signals/primary', 'signals', 'primary');
    seedBook('mystery/primary', 'mystery', 'primary');
    seedDay('debate/primary', PREVIOUS, 600);
    seedDay('debate/primary', DAY, 598.5, { ytd: 1.5 });
    seedDay('signals/primary', DAY, 1_410, { multiplier: 0.5, blocked: 1, ytd: 400 });
    seedDay('mystery/primary', DAY, 600);
    seedDecision('d-old', 'debate/primary', PREVIOUS_MARK);
    seedDecision('d-new', 'debate/primary', IN_WINDOW);
    seedOrder('e-edge', 'debate/primary', 'entry', 'submitted', PREVIOUS_MARK);
    seedOrder('e-placed', 'signals/primary', 'entry', 'submitted', IN_WINDOW);
    seedOrder('e-cancelled', 'signals/primary', 'entry', 'cancelled', IN_WINDOW);
    seedOrder('e-rejected', 'signals/primary', 'entry', 'rejected', IN_WINDOW);
    seedOrder('x-stop', 'debate/primary', 'stop', 'submitted', BEFORE_WINDOW);
    seedFill('f1', 'e-placed', 'signals/primary', 'entry', IN_WINDOW);
    seedFill('f1#1', 'e-placed', 'signals/primary', 'entry', IN_WINDOW);
    seedFill('f-cil', 'e-placed', 'signals/primary', 'cash_in_lieu', IN_WINDOW);
    seedFill('f-edge', 'e-edge', 'debate/primary', 'entry', PREVIOUS_MARK);
    seedFill('x1', 'x-stop', 'debate/primary', 'stop', IN_WINDOW);
    seedPosition('signals/primary', 'UP');
    seedPosition('signals/primary', 'DOWN');
    seedRefusal('entry', 'LOSS_BUDGET', 'signals/primary', IN_WINDOW);
    seedRefusal('entry', 'LOSS_BUDGET', 'signals/primary', IN_WINDOW);
    seedRefusal('signal', 'stale_last_close', null, IN_WINDOW);
    seedRefusal('data', 'SAXO_SESSION', null, IN_WINDOW);
    seedRefusal('data', 'SAXO_SESSION', null, PREVIOUS_MARK);
    db.prepare(
      `INSERT INTO llm_spend (trace_id, stage, model, input_tokens, output_tokens, cost_usd, latency_ms, timestamp)
       VALUES ('t', 'debate', 'm', 1, 1, 2.5, 1, '2026-09-10T00:00:00.000Z')`,
    ).run();

    const faultClock = new SimulatedClock(new Date(PREVIOUS_MARK));
    const faults = new FaultLedger(db, faultClock);
    faults.record({ kind: 'stale_bar', trading_date: PREVIOUS, code: 'OLD', detail: 'old' });
    faultClock.advanceTo(new Date(IN_WINDOW));
    faults.record({
      kind: 'failed_broker_call',
      trading_date: PREVIOUS,
      code: 'entry_rejected',
      detail: 'account 12345 broker text',
    });

    const read = readDailySummary(db, CLOCK, DAY, faults);

    expect(read.since).toBe(PREVIOUS_MARK);
    expect(read.faults).toEqual({
      recorded: [{ code: 'failed_broker_call', count: 1 }],
      free_weeks: 0,
      counted_days: 1,
      last_fault: PREVIOUS,
    });
    expect(read.books.map((entry) => entry.book_id)).toEqual([
      'debate/primary',
      'mystery/primary',
      'signals/primary',
    ]);
    const [debate, mystery, signals] = read.books;
    expect(debate).toMatchObject({
      equity_gbp: 598.5,
      day_pnl_gbp: -1.5,
      loss_cap_gbp: 450,
      decisions: 1,
      entries_placed: 0,
      entries_filled: 0,
      exits_filled: 1,
      open_positions: 0,
      refusals: { count: 0, top: [] },
    });
    expect(mystery).toMatchObject({ day_pnl_gbp: 0, loss_cap_gbp: null });
    expect(signals).toMatchObject({
      day_pnl_gbp: 810,
      ytd_loss_gbp: 400,
      loss_cap_gbp: 1_050,
      size_multiplier: 0.5,
      entries_blocked: true,
      entries_placed: 2,
      entries_filled: 1,
      entries_rejected: 1,
      exits_filled: 0,
      open_positions: 2,
      refusals: { count: 2, top: [{ code: 'LOSS_BUDGET', count: 2 }] },
    });
    expect(read.signal_refusals).toEqual({
      count: 1,
      top: [{ code: 'stale_last_close', count: 1 }],
    });
    expect(read.other_refusals).toEqual({ count: 1, top: [{ code: 'SAXO_SESSION', count: 1 }] });
    expect(read.llm).toEqual({ spent_usd: 2.5, budget_usd: 30, stopped: false });
    expect(formatDailySummary(read, 'paper')).not.toContain('12345');
  });

  it("counts what was journalled after this cycle's mark in the next summary, not in both", () => {
    const AFTER_MARK = '2026-09-30T07:36:00.000Z';
    seedBook('debate/primary', 'debate', 'primary');
    seedDay('debate/primary', PREVIOUS, 600);
    seedDay('debate/primary', DAY, 600);
    seedRefusal('entry', 'LOSS_BUDGET', 'debate/primary', AFTER_MARK);
    const faultClock = new SimulatedClock(new Date(AFTER_MARK));
    const faults = new FaultLedger(db, faultClock);
    faults.record({ kind: 'stuck_order', trading_date: DAY, code: 'C', detail: 'd' });
    const today = readDailySummary(db, CLOCK, DAY, faults);
    expect(today.books[0]?.refusals.count).toBe(0);
    expect(today.faults.recorded).toEqual([]);
    db.prepare(
      `INSERT INTO v2_book_days (book_id, trading_date, equity_gbp, cash_gbp, invested_gbp, ytd_loss_gbp,
         size_multiplier, entries_blocked, custody_accrual_gbp, recorded_at)
       VALUES ('debate/primary', '2026-10-01', 600, 600, 0, 0, 1, 0, 0, '2026-10-01T07:35:00.000Z')`,
    ).run();
    const next = readDailySummary(db, CLOCK, '2026-10-01', faults);
    expect(next.books[0]?.refusals).toEqual({ count: 1, top: [{ code: 'LOSS_BUDGET', count: 1 }] });
    expect(next.faults.recorded).toEqual([{ code: 'stuck_order', count: 1 }]);
  });

  it('reads everything as the first cycle when no earlier cycle marked a book', () => {
    seedBook('debate/primary', 'debate', 'primary');
    seedDay('debate/primary', DAY, 600);
    seedDecision('d-old', 'debate/primary', BEFORE_WINDOW);
    const read = readDailySummary(db, CLOCK, DAY, new FaultLedger(db, CLOCK));
    expect(read.since).toBeNull();
    expect(read.books[0]).toMatchObject({ decisions: 1, loss_cap_gbp: null });
    expect(read.faults).toMatchObject({ recorded: [], counted_days: 1, last_fault: undefined });
  });
});

describe('pushDailySummary', () => {
  const report = (skipped: boolean) => ({ trading_date: DAY, skipped }) as CycleReport;
  let db: StoreHandle;
  let logs: LogEntry[];
  let sent: string[];

  beforeEach(() => {
    db = openSharedStore(':memory:');
    logs = [];
    sent = [];
  });

  afterEach(() => {
    db.close();
  });

  const push = (notify: (text: string) => Promise<void>) => ({
    db,
    clock: CLOCK,
    faults: new FaultLedger(db, CLOCK),
    mode: 'paper' as const,
    logger: { log: (entry: LogEntry) => logs.push(entry) },
    notify,
  });

  const record = (text: string) => {
    sent.push(text);
    return Promise.resolve();
  };

  it('logs the summary and sends it once', async () => {
    await pushDailySummary(push(record), report(false));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^Samurai v2 daily summary 2026-09-30 \(paper\)\n/);
    expect(logs).toEqual([
      expect.objectContaining({ level: 'info', event: 'v2_daily_summary', message: sent[0] }),
    ]);
  });

  it('sends nothing for a skipped cycle', async () => {
    await pushDailySummary(push(record), report(true));
    expect(sent).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('logs a send failure and resolves', async () => {
    await expect(
      pushDailySummary(
        push(() => Promise.reject(new Error('telegram down'))),
        report(false),
      ),
    ).resolves.toBeUndefined();
    expect(logs.at(-1)).toMatchObject({ level: 'warn', event: 'v2_daily_summary_failed' });
    expect(logs.at(-1)?.message).toContain('telegram down');
  });

  it('logs an unreadable store and resolves without sending', async () => {
    db.close();
    await expect(pushDailySummary(push(record), report(false))).resolves.toBeUndefined();
    expect(sent).toEqual([]);
    expect(logs).toEqual([
      expect.objectContaining({ level: 'warn', event: 'v2_daily_summary_failed' }),
    ]);
    db = openSharedStore(':memory:');
  });
});
