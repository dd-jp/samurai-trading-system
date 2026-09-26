import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JournalWire, SleeveAction, SleeveDecision } from '../../../../contracts/index.js';
import { openSharedStore, type StoreHandle } from '../../../shared/store/index.js';
import { Journal } from '../journal/journal.js';
import { type JournalQuery, JournalReader, parseJournalQuery, vetoOf } from './journal-reader.js';

const clock = { now: () => new Date('2026-10-06T21:40:00.000Z') };

let db: StoreHandle;
let journal: Journal;

afterEach(() => db?.close());

function open(): void {
  db = openSharedStore(':memory:');
  journal = new Journal(db, clock);
  for (const [bookId, variant] of [
    ['debate/primary', 'primary'],
    ['debate/no-veto', 'no-veto'],
  ]) {
    db.prepare(
      `INSERT INTO v2_books (book_id, sleeve_id, variant, start_capital_gbp, cash_gbp, created_at)
       VALUES (?, 'debate', ?, 1000, 1000, 'x')`,
    ).run(bookId, variant);
  }
}

function decide(
  date: string,
  instrument: string,
  action: SleeveAction = 'enter_long',
  reason = 'conviction 0.7',
  bookId = 'debate/primary',
): string {
  const decision: SleeveDecision = {
    sleeve_id: 'debate',
    instrument,
    venue: 'alpaca',
    direction: 'bullish',
    confidence: 0.7,
    action,
    reason,
    price: 100,
    atr: 2,
    stop_price: 96,
    inputs_hash: `hash-${instrument}`,
    debate_id: `debate-${instrument}-${date}`,
    payload: { symbol: instrument },
  };
  return journal.recordDecision(bookId, date, decision, 3);
}

function order(
  id: string,
  date: string,
  decisionId: string | null,
  instrument = 'AAPL',
  bookId = 'debate/primary',
): void {
  journal.recordOrder({
    client_order_id: id,
    decision_id: decisionId,
    book_id: bookId,
    trading_date: date,
    instrument,
    venue: 'alpaca',
    leg: decisionId === null ? 'exit' : 'entry',
    side: decisionId === null ? 'sell' : 'buy',
    dry_run: false,
    outcome: 'submitted',
    payload: { size: 3 },
  });
}

function fill(id: string, orderId: string, date: string): void {
  journal.recordFill({
    fill_id: id,
    client_order_id: orderId,
    book_id: 'debate/primary',
    trading_date: date,
    instrument: 'AAPL',
    venue: 'alpaca',
    leg: 'entry',
    side: 'buy',
    qty: 3,
    price_gbp: 80,
    fee_gbp: 0.2,
  });
}

function refuse(date: string, parameter: string): void {
  journal.recordRefusal({
    trading_date: date,
    scope: 'control',
    parameter,
    ticket: '#1745',
    message: `${parameter} refused`,
  });
}

function query(params: Record<string, string> = {}): JournalQuery {
  const parsed = parseJournalQuery(new URLSearchParams(params));
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.query;
}

function read(params: Record<string, string> = {}): JournalWire {
  return new JournalReader(db).read(query(params));
}

function datesOf(page: JournalWire): string[] {
  return page.days.map((day) => day.trading_date);
}

function walk(limit: number, afterFirstPage: () => void): JournalWire['days'][number][] {
  const walked: JournalWire['days'][number][] = [];
  let before: string | null = null;
  for (let page = 0; page < 10; page += 1) {
    const served = read({ limit: String(limit), ...(before === null ? {} : { before }) });
    walked.push(...served.days);
    if (page === 0) afterFirstPage();
    before = served.next_before;
    if (before === null) break;
  }
  return walked;
}

describe('parseJournalQuery', () => {
  it('defaults to seven days and takes every filter', () => {
    expect(parseJournalQuery(new URLSearchParams())).toEqual({ ok: true, query: { limit: 7 } });
    expect(
      parseJournalQuery(
        new URLSearchParams({
          from: '2026-10-01',
          to: '2026-10-01',
          before: '2026-10-09',
          book: 'debate/primary',
          instrument: 'x'.repeat(64),
          action: 'vetoed',
          veto: 'earnings',
          limit: '31',
        }),
      ),
    ).toEqual({
      ok: true,
      query: {
        from: '2026-10-01',
        to: '2026-10-01',
        before: '2026-10-09',
        book: 'debate/primary',
        instrument: 'x'.repeat(64),
        action: 'vetoed',
        veto: 'earnings',
        limit: 31,
      },
    });
    expect(parseJournalQuery(new URLSearchParams({ limit: '1', action: 'none' }))).toEqual({
      ok: true,
      query: { limit: 1, action: 'none' },
    });
  });

  it.each([
    ['from=2026-02-30', 'from is invalid'],
    ['to=2026-2-3', 'to is invalid'],
    ['before=2026-10-01T00:00', 'before is invalid'],
    ['from=2026-10-02&to=2026-10-01', 'from is after to'],
    ['limit=0', 'limit is invalid'],
    ['limit=32', 'limit is invalid'],
    ['limit=1.5', 'limit is invalid'],
    ['from=x2026-10-01', 'from is invalid'],
    ['limit=100', 'limit is invalid'],
    ['book=', 'book is invalid'],
    [`instrument=${'x'.repeat(65)}`, 'instrument is invalid'],
    ['action=exit', 'action is invalid'],
    ['book=a&book=b', 'book is given more than once'],
    [
      'toString=1',
      'unknown parameter; allowed: from, to, before, book, instrument, action, veto, limit',
    ],
    [
      'sort=date',
      'unknown parameter; allowed: from, to, before, book, instrument, action, veto, limit',
    ],
  ])('refuses %s', (raw, reason) => {
    expect(parseJournalQuery(new URLSearchParams(raw))).toEqual({ ok: false, reason });
  });
});

describe('vetoOf', () => {
  it('is the category after the veto prefix, only on a skip', () => {
    expect(vetoOf('skip', 'vetoed: earnings')).toBe('earnings');
    expect(vetoOf('skip', 'below floor')).toBeNull();
    expect(vetoOf('enter_long', 'vetoed: earnings')).toBeNull();
  });
});

describe('JournalReader (P9)', () => {
  it('is an empty page before the first cycle', () => {
    open();
    expect(read()).toMatchObject({ days: [], next_before: null });
  });

  it('expands a decision to its reason, inputs hash, debate id, payload, orders and fills', () => {
    open();
    const id = decide('2026-10-05', 'AAPL');
    order('entry-1', '2026-10-05', id);
    fill('fill-1', 'entry-1', '2026-10-06');
    expect(read().days).toEqual([
      {
        trading_date: '2026-10-05',
        decisions: [
          {
            decision_id: id,
            book_id: 'debate/primary',
            variant: 'primary',
            instrument: 'AAPL',
            venue: 'alpaca',
            direction: 'bullish',
            action: 'enter_long',
            vetoed: false,
            veto: null,
            reason: 'conviction 0.7',
            confidence: 0.7,
            size_shares: 3,
            stop_price: 96,
            inputs_hash: 'hash-AAPL',
            debate_id: 'debate-AAPL-2026-10-05',
            payload: { symbol: 'AAPL', debate_id: 'debate-AAPL-2026-10-05' },
            recorded_at: '2026-10-06T21:40:00.000Z',
            orders: [
              {
                client_order_id: 'entry-1',
                book_id: 'debate/primary',
                instrument: 'AAPL',
                venue: 'alpaca',
                leg: 'entry',
                side: 'buy',
                dry_run: false,
                outcome: 'submitted',
                payload: { size: 3 },
                recorded_at: '2026-10-06T21:40:00.000Z',
                fills: [
                  {
                    fill_id: 'fill-1',
                    qty: 3,
                    price_gbp: 80,
                    fee_gbp: 0.2,
                    recorded_at: '2026-10-06T21:40:00.000Z',
                  },
                ],
              },
            ],
          },
        ],
        unlinked_orders: [],
        refusals: [],
      },
    ]);
  });

  it('serves a null debate id when the payload carries none', () => {
    open();
    db.prepare(
      `INSERT INTO v2_decisions (decision_id, book_id, trading_date, instrument, venue, inputs_hash,
         direction, confidence, action, reason, size_shares, stop_price, payload, recorded_at)
       VALUES ('d1', 'debate/primary', '2026-10-05', 'AAPL', 'alpaca', 'h', 'neutral', 0, 'none',
         'no signal', 0, NULL, '{"debate_id":7}', 'x')`,
    ).run();
    expect(read().days[0]?.decisions[0]).toMatchObject({ debate_id: null, stop_price: null });
  });

  it('shows a day with no decisions, like a paused one, by its exits and refusals', () => {
    open();
    order('exit-1', '2026-10-05', null);
    fill('fill-x', 'exit-1', '2026-10-05');
    refuse('2026-10-05', 'MANUAL_PAUSE');
    refuse('2026-10-05', 'SECOND');
    expect(read().days).toEqual([
      {
        trading_date: '2026-10-05',
        decisions: [],
        unlinked_orders: [
          expect.objectContaining({ client_order_id: 'exit-1', fills: [expect.anything()] }),
        ],
        refusals: [
          {
            refusal_id: 1,
            scope: 'control',
            parameter: 'MANUAL_PAUSE',
            ticket: '#1745',
            message: 'MANUAL_PAUSE refused',
            recorded_at: '2026-10-06T21:40:00.000Z',
          },
          expect.objectContaining({ refusal_id: 2, parameter: 'SECOND' }),
        ],
      },
    ]);
  });

  it('files every row under its own cycle day, newest day first, primary books first', () => {
    open();
    decide('2026-10-02', 'MSFT');
    decide('2026-10-05', 'MSFT', 'enter_long', 'x', 'debate/no-veto');
    decide('2026-10-05', 'MSFT');
    decide('2026-10-05', 'AAPL');
    order('exit-old', '2026-10-02', null, 'MSFT');
    order('exit-b', '2026-10-05', null, 'MSFT');
    order('exit-a', '2026-10-05', null, 'AAPL');
    refuse('2026-10-02', 'OLD');
    const days = read().days;
    expect(datesOf({ days } as JournalWire)).toEqual(['2026-10-05', '2026-10-02']);
    expect(days[0]?.decisions.map((row) => `${row.book_id} ${row.instrument}`)).toEqual([
      'debate/primary AAPL',
      'debate/primary MSFT',
      'debate/no-veto MSFT',
    ]);
    expect(days[0]?.unlinked_orders.map((row) => row.client_order_id)).toEqual([
      'exit-a',
      'exit-b',
    ]);
    expect(days[0]?.refusals).toEqual([]);
    expect(days[1]?.unlinked_orders.map((row) => row.client_order_id)).toEqual(['exit-old']);
    expect(days[1]?.refusals.map((row) => row.parameter)).toEqual(['OLD']);
  });

  it('separates a vetoed skip from a plain skip, with the veto category', () => {
    open();
    decide('2026-10-05', 'AAPL', 'skip', 'vetoed: earnings in 2 days');
    decide('2026-10-05', 'MSFT', 'skip', 'below floor');
    decide('2026-10-05', 'NVDA', 'enter_short', 'x');
    const instruments = (action: string) =>
      read({ action }).days.flatMap((day) => day.decisions.map((row) => row.instrument));
    expect(read({ action: 'vetoed' }).days[0]?.decisions).toEqual([
      expect.objectContaining({ vetoed: true, veto: 'earnings in 2 days' }),
    ]);
    expect(instruments('vetoed')).toEqual(['AAPL']);
    expect(instruments('skip')).toEqual(['MSFT']);
    expect(instruments('enter_short')).toEqual(['NVDA']);
    expect(instruments('enter_long')).toEqual([]);
  });

  it('drops exits under an action filter, and lets only decisions pick the days', () => {
    open();
    decide('2026-10-05', 'AAPL');
    order('exit-1', '2026-10-05', null);
    refuse('2026-10-05', 'P');
    order('exit-2', '2026-10-04', null);
    refuse('2026-10-03', 'Q');
    const page = read({ action: 'enter_long' });
    expect(datesOf(page)).toEqual(['2026-10-05']);
    expect(page.days[0]).toMatchObject({ unlinked_orders: [], refusals: [{ parameter: 'P' }] });
  });

  it('narrows decisions and exits to a book or instrument, keeping the served days refusals', () => {
    open();
    decide('2026-10-05', 'AAPL');
    decide('2026-10-05', 'AAPL', 'enter_long', 'x', 'debate/no-veto');
    decide('2026-10-05', 'MSFT');
    order('exit-aapl', '2026-10-04', null, 'AAPL');
    order('exit-msft', '2026-10-04', null, 'MSFT');
    order('exit-shadow', '2026-10-04', null, 'AAPL', 'debate/no-veto');
    refuse('2026-10-03', 'P');
    refuse('2026-10-05', 'debate/primary AAPL: below the volume cap');
    const byInstrument = read({ instrument: 'aapl' });
    expect(datesOf(byInstrument)).toEqual(['2026-10-05', '2026-10-04']);
    expect(byInstrument.days[0]?.decisions.map((row) => row.book_id)).toEqual([
      'debate/primary',
      'debate/no-veto',
    ]);
    expect(byInstrument.days[1]?.unlinked_orders.map((row) => row.client_order_id)).toEqual([
      'exit-aapl',
      'exit-shadow',
    ]);
    expect(byInstrument.days[0]?.refusals.map((row) => row.parameter)).toEqual([
      'debate/primary AAPL: below the volume cap',
    ]);
    expect(read({ book: "' OR 1=1 --" }).days).toEqual([]);
    const byBook = read({ book: 'debate/no-veto' });
    expect(datesOf(byBook)).toEqual(['2026-10-05', '2026-10-04']);
    expect(byBook.days[0]?.decisions.map((row) => row.instrument)).toEqual(['AAPL']);
    expect(byBook.days[1]?.unlinked_orders.map((row) => row.client_order_id)).toEqual([
      'exit-shadow',
    ]);
  });

  it('finds vetoes by category, and only vetoes', () => {
    open();
    decide('2026-10-05', 'AAPL', 'skip', 'vetoed: earnings');
    decide('2026-10-05', 'MSFT', 'skip', 'vetoed: liquidity');
    decide('2026-10-04', 'AAPL', 'skip', 'earnings');
    order('exit-1', '2026-10-03', null);
    const page = read({ veto: 'earnings' });
    expect(datesOf(page)).toEqual(['2026-10-05']);
    expect(page.days[0]?.decisions.map((row) => row.veto)).toEqual(['earnings']);
  });

  it('serves a dry-run order and one not yet filled', () => {
    open();
    journal.recordOrder({
      client_order_id: 'dry-1',
      decision_id: null,
      book_id: 'debate/primary',
      trading_date: '2026-10-05',
      instrument: 'AAPL',
      venue: 'alpaca',
      leg: 'exit',
      side: 'sell',
      dry_run: true,
      outcome: 'simulated',
      payload: {},
    });
    expect(read().days[0]?.unlinked_orders).toEqual([
      expect.objectContaining({ dry_run: true, fills: [] }),
    ]);
  });

  it('keeps every source inside the from and to window', () => {
    open();
    for (const date of ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']) {
      decide(date, 'AAPL');
      order(`exit-${date}`, date, null);
      refuse(date, `P-${date}`);
    }
    decide('2026-10-06', 'MSFT');
    order('exit-late', '2026-10-07', null);
    refuse('2026-10-08', 'LATE');
    const page = read({ from: '2026-10-02', to: '2026-10-03' });
    expect(datesOf(page)).toEqual(['2026-10-03', '2026-10-02']);
    expect(page.days.map((day) => day.refusals.length)).toEqual([1, 1]);
    expect(page.days.map((day) => day.unlinked_orders.length)).toEqual([1, 1]);
  });

  it('walks every day exactly once across pages, even when a newer day lands mid-walk', () => {
    open();
    const dates = ['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07'];
    for (const date of dates) {
      decide(date, 'AAPL');
      decide(date, 'MSFT');
    }
    order('exit-only', '2026-10-03', null);
    refuse('2026-10-04', 'ONLY');
    const whole = read({ limit: '31' });
    const walked = walk(2, () => decide('2026-10-08', 'AAPL'));
    expect(walked).toEqual(whole.days);
    expect(datesOf(whole)).toEqual([
      '2026-10-07',
      '2026-10-06',
      '2026-10-05',
      '2026-10-04',
      '2026-10-03',
      '2026-10-02',
      '2026-10-01',
    ]);
    expect(read({ limit: '7' }).next_before).toBe('2026-10-02');
    expect(read({ limit: '8' }).next_before).toBeNull();
  });

  it('reads the whole page in one transaction, so a decision never comes without its orders', () => {
    open();
    const transaction = vi.spyOn(db, 'transaction');
    read();
    expect(transaction).toHaveBeenCalledOnce();
  });
});
