import { afterEach, describe, expect, it } from 'vitest';
import { UsEquityRegularHoursCalendar } from '../../providers/calendar/index.js';
import { SimulatedClock } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { migratedMemoryStore } from '../../shared/store/migrated-template.js';
import { rewoundCopy } from './replay-book.js';
import {
  journalledQuotes,
  journalledVeto,
  type SettledSignal,
  settledSignals,
  signalDivergences,
  signalsGuard,
} from './replay-signals.js';
import { parseSignalPayload } from './signals/payload.js';
import { SignalStore } from './signals/store.js';
import { INTERRUPTED_VETO } from './signals/veto.js';
import { classifySignalWindow } from './signals/window.js';

const D = '2026-09-30';
const AT = new Date(`${D}T14:00:00.000Z`);
const handles: StoreHandle[] = [];

afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});

function journal(): { db: StoreHandle; clock: SimulatedClock; signals: SignalStore; id: string } {
  const db = migratedMemoryStore();
  handles.push(db);
  const clock = new SimulatedClock(AT);
  const signals = new SignalStore(db, clock);
  const parsed = parseSignalPayload({ symbol: 'UP', entry: 25, targets: [26], stop: 24.5 });
  if (!parsed.ok) throw new Error(parsed.reason);
  const id = signals.record(
    parsed.payload,
    AT,
    classifySignalWindow(AT, new UsEquityRegularHoursCalendar()),
  ).signal.signal_id;
  return { db, clock, signals, id };
}

function event(overrides: Partial<SettledSignal> = {}): SettledSignal {
  return {
    signal_id: 's',
    status: 'processed',
    detail: 'veto pass: ok',
    recorded_at: `${D}T14:00:01.000Z`,
    ...overrides,
  };
}

function decide(db: StoreHandle, signalId: string, recordedAt: string, quote: unknown): void {
  db.prepare(
    `INSERT OR IGNORE INTO v2_books (book_id, sleeve_id, variant, start_capital_gbp, cash_gbp, created_at)
     VALUES ('signals/no-veto', 'signals', 'no-veto', 7000, 7000, ?)`,
  ).run(recordedAt);
  db.prepare(
    `INSERT INTO v2_decisions (decision_id, book_id, trading_date, instrument, venue, inputs_hash,
       direction, confidence, action, reason, size_shares, stop_price, payload, recorded_at)
     VALUES (?, 'signals/no-veto', ?, 'UP', 'alpaca', 'h', 'bullish', 1, 'enter_long', 'r', 1, 24.5, ?, ?)`,
  ).run(
    `${signalId}-${recordedAt}`,
    D,
    JSON.stringify({ signal_id: signalId, entry_quote: quote }),
    recordedAt,
  );
}

describe('settledSignals', () => {
  it('takes the settled events of the US session, in journal order, and leaves queued ones', () => {
    const { db, clock, signals, id } = journal();
    signals.appendEvent(id, 'failed', 'first');
    clock.advanceTo(new Date('2026-10-01T01:00:00.000Z'));
    signals.appendEvent(id, 'processed', 'late evening in New York');
    clock.advanceTo(new Date('2026-10-01T14:00:00.000Z'));
    signals.appendEvent(id, 'refused', 'next session');

    expect(settledSignals(db, D).map((row) => [row.status, row.detail])).toEqual([
      ['failed', 'first'],
      ['processed', 'late evening in New York'],
    ]);
  });
});

describe('signalsGuard', () => {
  const mark = `${D}T06:30:05.000Z`;

  it('lets a day with no signal events, or every event after the mark, through', () => {
    expect(signalsGuard([], D, undefined)).toBeUndefined();
    expect(signalsGuard([event()], D, mark)).toBeUndefined();
  });

  it('flags signal events on an unmarked day', () => {
    expect(signalsGuard([event(), event()], D, undefined)).toEqual({
      kind: 'signals_not_replayed',
      tradingDate: D,
      reason: 'unmarked',
      events: 2,
    });
  });

  it('flags a day with any signal event at or before the mark', () => {
    expect(signalsGuard([event({ recorded_at: mark }), event()], D, mark)).toEqual({
      kind: 'signals_not_replayed',
      tradingDate: D,
      reason: 'before_mark',
      events: 2,
    });
  });
});

describe('journalledVeto', () => {
  const SETTLED = AT.toISOString();

  it('answers each attempt from its own journalled verdict', async () => {
    const { db, signals, id } = journal();
    signals.recordVeto(id, { kind: 'unavailable', reason: 'llm_call_failed: upstream 503' });
    signals.claimVeto(id, 2);
    signals.recordRetryVeto(id, { kind: 'veto', reason: 'stop inside noise' });
    const veto = journalledVeto(db, SETTLED);

    await expect(veto(id, 1, {} as never)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'llm_call_failed: upstream 503',
    });
    await expect(veto(id, 2, {} as never)).resolves.toEqual({
      kind: 'veto',
      reason: 'stop inside noise',
    });
  });

  it('hands back the interrupted verdict itself, which the processor matches by identity', async () => {
    const { db, signals, id } = journal();
    signals.recordVeto(id, INTERRUPTED_VETO);

    await expect(journalledVeto(db, SETTLED)(id, 1, {} as never)).resolves.toBe(INTERRUPTED_VETO);
  });

  it('keeps a verdict that only shares the interrupted reason as the verdict it was', async () => {
    const { db, signals, id } = journal();
    signals.recordVeto(id, { kind: 'veto', reason: INTERRUPTED_VETO.reason });

    await expect(journalledVeto(db, SETTLED)(id, 1, {} as never)).resolves.toEqual({
      kind: 'veto',
      reason: INTERRUPTED_VETO.reason,
    });
  });

  it('refuses an attempt with no journalled verdict rather than calling a model', async () => {
    const { db, id } = journal();

    await expect(journalledVeto(db, SETTLED)(id, 1, {} as never)).rejects.toThrow(
      `replay: no journalled attempt 1 veto verdict for signal ${id} by ${SETTLED}, and the replay makes no LLM call`,
    );
  });

  it('accepts a verdict recorded at the settle instant itself', async () => {
    const { db, clock, signals, id } = journal();
    signals.recordVeto(id, { kind: 'unavailable', reason: 'llm_call_failed: upstream 503' });
    clock.advanceTo(new Date(AT.getTime() + 5_000));
    signals.claimVeto(id, 2);
    signals.recordRetryVeto(id, { kind: 'pass', reason: 'ok' });
    const retrySettled = clock.now().toISOString();

    await expect(journalledVeto(db, SETTLED)(id, 1, {} as never)).resolves.toMatchObject({
      kind: 'unavailable',
    });
    await expect(journalledVeto(db, retrySettled)(id, 2, {} as never)).resolves.toEqual({
      kind: 'pass',
      reason: 'ok',
    });
  });

  it('refuses a verdict recorded after the pass settled, on either attempt', async () => {
    const { db, clock, signals, id } = journal();
    signals.recordVeto(id, { kind: 'unavailable', reason: 'llm_call_failed: upstream 503' });
    clock.advanceTo(new Date(AT.getTime() + 5_000));
    signals.claimVeto(id, 2);
    signals.recordRetryVeto(id, { kind: 'pass', reason: 'ok' });
    const before = new Date(AT.getTime() - 1).toISOString();
    const beforeRetry = new Date(AT.getTime() + 4_999).toISOString();

    await expect(journalledVeto(db, before)(id, 1, {} as never)).rejects.toThrow(
      `replay: no journalled attempt 1 veto verdict for signal ${id} by ${before}`,
    );
    await expect(journalledVeto(db, beforeRetry)(id, 2, {} as never)).rejects.toThrow(
      `replay: no journalled attempt 2 veto verdict for signal ${id} by ${beforeRetry}`,
    );
  });
});

describe('journalledQuotes', () => {
  const quote = { ask: 24.96, bid: 24.94, quoted_at: `${D}T14:00:00.500Z`, fill: 24.96 };

  it('reads the quote the pass journalled on its decisions, between the previous settle and this one', async () => {
    const { db } = journal();
    decide(db, 's', `${D}T13:59:00.000Z`, { ...quote, ask: 1 });
    decide(db, 's', `${D}T14:00:00.900Z`, quote);
    decide(db, 's', `${D}T14:00:02.000Z`, { ...quote, ask: 2 });

    const source = journalledQuotes(db, D, event(), `${D}T13:59:30.000Z`);

    await expect(source.latestQuote('UP')).resolves.toEqual({
      ask: 24.96,
      bid: 24.94,
      quoted_at: quote.quoted_at,
    });
  });

  it('re-raises the journalled error of a pass that failed with no decision', async () => {
    const { db } = journal();
    const failed = event({ status: 'failed', detail: 'no UP quote since x: latest y' });

    await expect(journalledQuotes(db, D, failed, '').latestQuote('UP')).rejects.toThrow(
      'no UP quote since x: latest y',
    );
  });

  it('refuses a settled pass whose quote is not journalled', async () => {
    const { db } = journal();
    decide(db, 'other', `${D}T14:00:00.900Z`, quote);

    await expect(journalledQuotes(db, D, event(), '').latestQuote('UP')).rejects.toThrow(
      `replay: no journalled UP quote for signal s by ${D}T14:00:01.000Z`,
    );
  });
});

function signalDay(db: StoreHandle, signals: SignalStore, clock: SimulatedClock, id: string): void {
  signals.claimVeto(id, 1);
  signals.recordVeto(id, { kind: 'veto', reason: 'stop inside noise' });
  signals.appendEvent(id, 'processed', 'veto veto: stop inside noise');
  const at = clock.now().toISOString();
  decide(db, id, at, { ask: 25, bid: 24.9, quoted_at: at, fill: 25 });
  db.prepare(
    `INSERT INTO v2_refusals (trading_date, scope, parameter, ticket, message, recorded_at, book_id, instrument)
     VALUES (?, 'signal', 'dollar_volume', '#1941', 'thin', ?, 'signals/no-veto', 'UP')`,
  ).run(D, at);
  db.prepare(
    `INSERT INTO v2_orders (client_order_id, decision_id, book_id, trading_date, instrument, venue,
       leg, side, dry_run, outcome, payload, recorded_at)
     VALUES ('o-1', NULL, 'signals/no-veto', ?, 'UP', 'alpaca', 'entry', 'buy', 0, 'submitted', '{}', ?)`,
  ).run(D, at);
}

describe('signalDivergences', () => {
  const mark = `${D}T06:30:05.000Z`;

  it('reports every signals row the replay wrote that the journal lacks, stage by stage', () => {
    const copy = journal();
    signalDay(copy.db, copy.signals, copy.clock, copy.id);
    copy.db
      .prepare(
        `INSERT INTO v2_faults (kind, trading_date, code, detail, recorded_at)
         VALUES ('veto_rate', ?, 'signals_veto_rate', 'high', ?)`,
      )
      .run(D, AT.toISOString());
    const empty = migratedMemoryStore();
    handles.push(empty);

    const divergences = signalDivergences(
      { journal: empty, copy: copy.db, tradingDate: D, markedAt: mark },
      settledSignals(copy.db, D),
    );

    expect(divergences).toEqual([
      { kind: 'row_extra', stage: 'signal_events', key: `${copy.id}#1` },
      { kind: 'row_extra', stage: 'signal_vetoes', key: `${copy.id}|claim 1#1` },
      { kind: 'row_extra', stage: 'signal_vetoes', key: `${copy.id}|verdict 1#1` },
      { kind: 'row_extra', stage: 'signal_decisions', key: `signals/no-veto|UP|${copy.id}#1` },
      {
        kind: 'row_extra',
        stage: 'signal_refusals',
        key: 'signal|dollar_volume|signals/no-veto|UP#1',
      },
      { kind: 'row_extra', stage: 'signal_orders', key: 'o-1#1' },
      { kind: 'row_extra', stage: 'signal_faults', key: 'signals_veto_rate|high#1' },
    ]);
  });

  it('leaves out rows at or before the mark, and veto rows after the last replayed event', () => {
    const copy = journal();
    const atMark = new Date(`${D}T14:00:10.000Z`);
    copy.clock.advanceTo(atMark);
    signalDay(copy.db, copy.signals, copy.clock, copy.id);
    copy.clock.advanceTo(new Date(`${D}T14:00:20.000Z`));
    copy.signals.claimVeto(copy.id, 2);
    const empty = migratedMemoryStore();
    handles.push(empty);
    const last = event({ signal_id: copy.id, recorded_at: `${D}T14:00:15.000Z` });

    const divergences = signalDivergences(
      { journal: empty, copy: copy.db, tradingDate: D, markedAt: atMark.toISOString() },
      [event({ signal_id: copy.id }), event({ signal_id: copy.id }), last],
    );

    expect(divergences).toEqual([
      { kind: 'row_extra', stage: 'signal_vetoes', key: `${copy.id}|claim 1#1` },
      { kind: 'row_extra', stage: 'signal_vetoes', key: `${copy.id}|verdict 1#1` },
    ]);
  });
});

describe('rewoundCopy signal rows', () => {
  it('drops the veto rows and settled events from the run start on, and keeps queued events and earlier rows', () => {
    const { db, clock, signals, id } = journal();
    signals.claimVeto(id, 1);
    signals.recordVeto(id, { kind: 'unavailable', reason: 'llm_call_failed: 503' });
    signals.appendEvent(id, 'failed', 'one retry left');
    const startedAt = `${D}T15:00:00.000Z`;
    clock.advanceTo(new Date(startedAt));
    signals.claimVeto(id, 2);
    signals.recordRetryVeto(id, { kind: 'pass', reason: 'ok' });
    signals.appendEvent(id, 'processed', 'entered');
    const parsed = parseSignalPayload({ symbol: 'DN', entry: 25, targets: [26], stop: 24.5 });
    if (!parsed.ok) throw new Error(parsed.reason);
    const late = signals.record(
      parsed.payload,
      clock.now(),
      classifySignalWindow(clock.now(), new UsEquityRegularHoursCalendar()),
    ).signal.signal_id;
    signals.claimVeto(late, 1);
    signals.recordVeto(late, { kind: 'veto', reason: 'no' });
    signals.appendEvent(late, 'processed', 'vetoed');

    const copy = rewoundCopy(db, D, startedAt);
    handles.push(copy);
    const rows = (handle: StoreHandle, sql: string) => handle.prepare(sql).all();
    const tables = {
      events: 'SELECT signal_id, status FROM v2_signal_events ORDER BY event_id',
      claims: 'SELECT signal_id, attempt FROM v2_signal_veto_claims ORDER BY signal_id, attempt',
      vetoes: 'SELECT signal_id FROM v2_signal_vetoes ORDER BY signal_id',
      retries: 'SELECT signal_id FROM v2_signal_veto_retry_verdicts',
    };

    expect(
      Object.fromEntries(Object.entries(tables).map(([k, sql]) => [k, rows(copy, sql)])),
    ).toEqual({
      events: [
        { signal_id: id, status: 'queued' },
        { signal_id: id, status: 'failed' },
        { signal_id: late, status: 'queued' },
      ],
      claims: [{ signal_id: id, attempt: 1 }],
      vetoes: [{ signal_id: id }],
      retries: [],
    });
    expect(rows(db, tables.events)).toHaveLength(5);
    expect(rows(db, tables.claims)).toHaveLength(3);
  });
});
