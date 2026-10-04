import { describe, expect, it } from 'vitest';
import type { BrokerCashActivity, BrokerMode, Venue } from '../../../contracts/index.js';
import { SimulatedClock } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { migratedMemoryStore } from '../../shared/store/migrated-template.js';
import {
  type AnchorCompare,
  anchorCashCheck,
  type CashAnchorLedger,
  dayRateFor,
  liveCashCheck,
  SqliteCashAnchors,
} from './cash-anchor.js';
import { alpacaNonTradeCashTypes } from './execution/alpaca/alpaca-cash-activities.js';

const DATE = '2026-10-05';
const FX = 1.25;
const clock = new SimulatedClock(new Date('2026-10-05T07:00:00.000Z'));

interface Fill {
  readonly id: string;
  readonly side: 'buy' | 'sell';
  readonly qty: number;
  readonly price: number | null;
  readonly fee?: number;
  readonly venue?: Venue;
  readonly outcome?: string;
  readonly mode?: BrokerMode;
}

function store(): { db: StoreHandle; anchors: SqliteCashAnchors; fill: (fill: Fill) => void } {
  const db = migratedMemoryStore();
  const fill = ({
    id,
    side,
    qty,
    price,
    fee = 0,
    venue = 'alpaca',
    outcome = 'submitted',
    mode = 'live',
  }: Fill) => {
    db.prepare(
      `INSERT INTO v2_orders (client_order_id, decision_id, book_id, trading_date, instrument, venue,
         leg, side, dry_run, outcome, payload, recorded_at)
       VALUES (?, NULL, 'debate/primary', ?, 'AAPL', ?, 'entry', ?, 0, ?, '{}', 't')`,
    ).run(`order-${id}`, DATE, venue, side, outcome);
    db.prepare(
      `INSERT INTO v2_fills (fill_id, client_order_id, book_id, trading_date, instrument, venue, leg,
         side, qty, price_gbp, fee_gbp, currency, price_native, fee_native, broker_mode,
         recorded_at)
       VALUES (?, ?, 'debate/primary', ?, 'AAPL', ?, 'entry', ?, ?, 0, 0, 'USD', ?, ?, ?, 't')`,
    ).run(id, `order-${id}`, DATE, venue, side, qty, price, price === null ? null : fee, mode);
  };
  return { db, anchors: new SqliteCashAnchors(db, clock), fill };
}

const LIVE_AT = (fillSeq: number) => ({ brokerMode: 'live' as const, fillSeq });
const FILL_SEQS = 'SELECT fill_seq, rowid AS row, fill_id FROM v2_fills ORDER BY fill_seq';

const USD_FIX = { gbpUsdOnDay: () => ({ gbpUsd: FX, fixDate: '2026-10-02' }) };

describe('SqliteCashAnchors', () => {
  it('journals the anchor in the venue currency, holding every fill booked before it', () => {
    const { db, anchors, fill } = store();
    fill({ id: 'before', side: 'buy', qty: 1, price: 10 });

    expect(anchors.anchor('alpaca')).toBeUndefined();
    expect(anchors.recordAnchor('alpaca', 'live', 12_000, DATE)).toEqual({
      currency: 'USD',
      cashQuote: 12_000,
      fillSeq: 1,
      brokerMode: 'live',
      tradingDate: DATE,
    });
    expect(db.prepare('SELECT * FROM v2_cash_anchors').all()).toEqual([
      {
        anchor_row_id: 1,
        venue: 'alpaca',
        kind: 'anchor',
        currency: 'USD',
        amount_quote: 12_000,
        fill_seq: 1,
        reference: 'go-live',
        trading_date: DATE,
        recorded_at: '2026-10-05T07:00:00.000Z',
        broker_mode: 'live',
        activity_id: null,
        activity_type: null,
        activity_date: null,
        status: null,
      },
    ]);
    expect(anchors.storeFlowSince(LIVE_AT(1), 'alpaca')).toEqual({ ok: true, quote: 0 });
    expect(() => anchors.recordAnchor('alpaca', 'live', 1, DATE)).toThrow(/append-only/);
  });

  it('anchors at fill seq 0 when nothing has filled yet, and keeps one anchor per venue', () => {
    const { anchors } = store();
    expect(anchors.recordAnchor('saxo', 'live', 500, DATE)).toEqual({
      currency: 'GBP',
      cashQuote: 500,
      fillSeq: 0,
      brokerMode: 'live',
      tradingDate: DATE,
    });
    expect(anchors.anchor('alpaca')).toBeUndefined();
  });

  it("sums the venue's broker-routed fills after the anchor, in its currency, net of fees", () => {
    const { anchors, fill } = store();
    fill({ id: 'pre', side: 'buy', qty: 100, price: 100 });
    anchors.recordAnchor('alpaca', 'live', 12_000, DATE);
    fill({ id: 'buy', side: 'buy', qty: 6, price: 20, fee: 1 });
    fill({ id: 'sell', side: 'sell', qty: 2, price: 25, fee: 0.5 });
    fill({ id: 'shadow', side: 'buy', qty: 9, price: 9, outcome: 'simulated' });
    fill({ id: 'dry', side: 'buy', qty: 9, price: 9, outcome: 'refused_dry_run' });
    fill({ id: 'saxo', side: 'buy', qty: 9, price: 9, venue: 'saxo' });
    fill({ id: 'cancelled', side: 'sell', qty: 1, price: 30, outcome: 'cancelled' });

    expect(anchors.storeFlowSince(LIVE_AT(1), 'alpaca')).toEqual({
      ok: true,
      quote: -121 + 49.5 + 30,
    });
  });

  it('refuses an anchor or broker activity without its broker mode, and a manual move with one', () => {
    const { db } = store();
    const insert = (kind: string, mode: string | null) =>
      db
        .prepare(
          `INSERT INTO v2_cash_anchors (venue, kind, currency, amount_quote, fill_seq, reference,
             trading_date, recorded_at, broker_mode, activity_id, activity_type, activity_date,
             status) VALUES ('alpaca', ?, 'USD', 1, ?, ?, ?, 't', ?, ?, 'DIV', ?, 'executed')`,
        )
        .run(
          kind,
          kind === 'anchor' ? 0 : null,
          `${kind}-${mode}`,
          DATE,
          mode,
          kind === 'activity' ? `id-${mode}` : null,
          DATE,
        );
    const message = /a cash anchor or broker activity records its broker mode/;
    expect(() => insert('anchor', null)).toThrow(message);
    expect(() => insert('activity', null)).toThrow(message);
    expect(() => insert('deposit', 'live')).toThrow(message);
    expect(() => insert('anchor', 'live')).not.toThrow();
    expect(() => insert('activity', 'live')).not.toThrow();
    expect(() => insert('deposit', null)).not.toThrow();
  });

  it("counts only the anchor's own account: paper fills in the same store never move live cash", () => {
    const { anchors, fill } = store();
    anchors.recordAnchor('alpaca', 'live', 12_000, DATE);
    fill({ id: 'live', side: 'buy', qty: 6, price: 20, fee: 1 });
    fill({ id: 'paper', side: 'buy', qty: 50, price: 20, mode: 'paper' });

    expect(anchors.storeFlowSince(LIVE_AT(0), 'alpaca')).toEqual({ ok: true, quote: -121 });
    expect(anchors.storeFlowSince({ brokerMode: 'paper', fillSeq: 0 }, 'alpaca')).toEqual({
      ok: true,
      quote: -1_000,
    });
  });

  it('pins the anchor to fill_seq, the rowid itself, so a VACUUM leaves the anchor and flow alone', () => {
    const { db, anchors, fill } = store();
    fill({ id: 'pre', side: 'buy', qty: 100, price: 100 });
    anchors.recordAnchor('alpaca', 'live', 12_000, DATE);
    fill({ id: 'buy', side: 'buy', qty: 6, price: 20, fee: 1 });
    fill({ id: 'sell', side: 'sell', qty: 2, price: 25, fee: 0.5 });
    const before = { anchor: anchors.anchor('alpaca'), seqs: db.prepare(FILL_SEQS).all() };
    const flow = anchors.storeFlowSince(before.anchor ?? LIVE_AT(0), 'alpaca');

    db.exec('VACUUM');

    expect(
      db.prepare("SELECT pk FROM pragma_table_info('v2_fills') WHERE name = 'fill_seq'").get(),
    ).toEqual({ pk: 1 });
    expect({ anchor: anchors.anchor('alpaca'), seqs: db.prepare(FILL_SEQS).all() }).toEqual(before);
    expect(anchors.storeFlowSince(anchors.anchor('alpaca') ?? LIVE_AT(0), 'alpaca')).toEqual(flow);
    expect(flow).toEqual({ ok: true, quote: -121 + 49.5 });
  });

  it('refuses a flow it cannot price in the venue currency', () => {
    const { anchors, fill } = store();
    fill({ id: 'old', side: 'buy', qty: 1, price: null });
    expect(anchors.storeFlowSince(LIVE_AT(0), 'alpaca')).toEqual({
      ok: false,
      reason: '1 alpaca fill(s) since the anchor carry no native price (migration 0085)',
    });
  });

  it('moves the anchor by each journalled deposit and withdrawal', () => {
    const { db, anchors } = store();
    anchors.recordAnchor('alpaca', 'live', 12_000, DATE);
    const move = { venue: 'alpaca' as const, tradingDate: '2026-10-06' };

    expect(
      anchors.recordMove({ ...move, kind: 'deposit', amountQuote: 1_000, reference: 'wire-1' }),
    ).toMatchObject({ cashQuote: 13_000 });
    expect(
      anchors.recordMove({ ...move, kind: 'withdrawal', amountQuote: 250, reference: 'out-1' }),
    ).toMatchObject({ cashQuote: 12_750 });
    expect(
      db
        .prepare('SELECT kind, amount_quote, fill_seq, reference, broker_mode FROM v2_cash_anchors')
        .all(),
    ).toEqual([
      {
        kind: 'anchor',
        amount_quote: 12_000,
        fill_seq: 0,
        reference: 'go-live',
        broker_mode: 'live',
      },
      {
        kind: 'deposit',
        amount_quote: 1_000,
        fill_seq: null,
        reference: 'wire-1',
        broker_mode: null,
      },
      {
        kind: 'withdrawal',
        amount_quote: -250,
        fill_seq: null,
        reference: 'out-1',
        broker_mode: null,
      },
    ]);
    expect(() =>
      anchors.recordMove({ ...move, kind: 'deposit', amountQuote: 1_000, reference: 'wire-1' }),
    ).toThrow(/append-only/);
  });

  it('refuses a move before the anchor, and a move that is not a positive amount', () => {
    const { anchors } = store();
    const deposit = {
      venue: 'alpaca' as const,
      kind: 'deposit' as const,
      reference: 'r',
      tradingDate: DATE,
    };
    expect(() => anchors.recordMove({ ...deposit, amountQuote: 10 })).toThrow(
      'no cash anchor for alpaca yet: the first clean live reconcile records the broker cash, deposits before it included',
    );
    anchors.recordAnchor('alpaca', 'live', 1, DATE);
    for (const amountQuote of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => anchors.recordMove({ ...deposit, amountQuote })).toThrow(
        `a deposit must be a positive amount, not ${amountQuote}`,
      );
    }
  });
});

describe('SqliteCashAnchors.recordActivity (David 2026-10-03, #2035 item 5)', () => {
  const activity = (
    id: string,
    amount: number,
    status: BrokerCashActivity['status'] = 'executed',
  ): BrokerCashActivity => ({
    activity_id: id,
    activity_type: 'DIV',
    activity_date: '2026-10-06',
    amount,
    status,
  });
  const anchored = () => {
    const ledger = store();
    ledger.anchors.recordAnchor('alpaca', 'live', 12_000, DATE);
    return ledger;
  };
  const record = (anchors: SqliteCashAnchors, row: BrokerCashActivity, mode: BrokerMode = 'live') =>
    anchors.recordActivity('alpaca', mode, row, '2026-10-07');
  const cash = (anchors: SqliteCashAnchors) => anchors.anchor('alpaca')?.cashQuote;

  it('journals the activity as a signed move in the venue currency, keyed by id and status', () => {
    const { db, anchors } = anchored();
    expect(record(anchors, activity('div-1', 4.2))).toBe(true);
    expect(record(anchors, activity('fee-1', -0.03))).toBe(true);
    expect(cash(anchors)).toBeCloseTo(12_004.17, 10);
    expect(
      db
        .prepare("SELECT * FROM v2_cash_anchors WHERE kind = 'activity' ORDER BY anchor_row_id")
        .get(),
    ).toEqual({
      anchor_row_id: 2,
      venue: 'alpaca',
      kind: 'activity',
      currency: 'USD',
      amount_quote: 4.2,
      fill_seq: null,
      reference: 'activity:div-1:executed',
      trading_date: '2026-10-07',
      recorded_at: '2026-10-05T07:00:00.000Z',
      broker_mode: 'live',
      activity_id: 'div-1',
      activity_type: 'DIV',
      activity_date: '2026-10-06',
      status: 'executed',
    });
  });

  it('ignores a re-read in the same status, whatever amount it now carries', () => {
    const { anchors } = anchored();
    record(anchors, activity('div-1', 4.2));
    expect(record(anchors, activity('div-1', 4.2))).toBe(false);
    expect(record(anchors, activity('div-1', 9))).toBe(false);
    expect(cash(anchors)).toBe(12_004.2);
  });

  it('brings a canceled activity to zero and keeps it there', () => {
    const { anchors } = anchored();
    record(anchors, activity('div-1', 4.2));
    expect(record(anchors, activity('div-1', 4.2, 'canceled'))).toBe(true);
    expect(cash(anchors)).toBe(12_000);
    expect(record(anchors, activity('div-1', 4.2, 'correct'))).toBe(true);
    expect(record(anchors, activity('div-1', 4.2, 'canceled'))).toBe(false);
    expect(cash(anchors)).toBe(12_000);
  });

  it('records an activity first read as canceled at zero', () => {
    const { anchors } = anchored();
    expect(record(anchors, activity('div-1', 4.2, 'canceled'))).toBe(true);
    expect(cash(anchors)).toBe(12_000);
  });

  it("takes a correction's amount in place of the one it corrects", () => {
    const { anchors } = anchored();
    record(anchors, activity('div-1', 4.2));
    record(anchors, activity('div-1', 5, 'correct'));
    expect(cash(anchors)).toBe(12_005);
    record(anchors, activity('div-2', 1, 'correct'));
    expect(cash(anchors)).toBe(12_006);
  });

  it("counts a split's cash in lieu once, through its estimate fill, never as an activity", () => {
    const { db, anchors, fill } = anchored();
    fill({ id: 'entry', side: 'buy', qty: 1, price: 10 });
    db.prepare(
      `INSERT INTO v2_fills (fill_id, client_order_id, book_id, trading_date, instrument, venue, leg,
         side, qty, price_gbp, fee_gbp, currency, price_native, fee_native, broker_mode, recorded_at)
       VALUES ('cil', 'order-entry', 'debate/primary', ?, 'AAPL', 'alpaca', 'cash_in_lieu', 'sell',
         0.5, 0, 0, 'USD', 30, 0, 'live', 't')`,
    ).run(DATE);
    expect(anchors.storeFlowSince(LIVE_AT(0), 'alpaca')).toEqual({ ok: true, quote: -10 + 15 });
    expect(alpacaNonTradeCashTypes()).not.toContain('CIL');
  });

  it("sums only the anchor's own account's activities", () => {
    const { anchors } = anchored();
    record(anchors, activity('paper-div', 50), 'paper');
    record(anchors, activity('live-div', 4));
    expect(cash(anchors)).toBe(12_004);
  });
});

describe('dayRateFor', () => {
  it('is 1 on a GBP venue without asking for a rate', () => {
    expect(dayRateFor({}, 'saxo', DATE)).toEqual({ ok: true, quotePerGbp: 1, source: 'gbp' });
  });

  it("reads the day's BoE fix on a USD venue and names it", () => {
    expect(dayRateFor(USD_FIX, 'alpaca', DATE)).toEqual({
      ok: true,
      quotePerGbp: FX,
      source: 'boe-xudluss:2026-10-02',
    });
  });

  it('fails without a rate source or a fix', () => {
    expect(dayRateFor({}, 'alpaca', DATE)).toEqual({
      ok: false,
      reason: 'no day GBP/USD rate source',
    });
    const stale = {
      gbpUsdOnDay: () => {
        throw new Error('no BoE XUDLUSS fix in the 7 days to 2026-10-05');
      },
    };
    expect(dayRateFor(stale, 'alpaca', DATE)).toEqual({
      ok: false,
      reason: 'no BoE XUDLUSS fix in the 7 days to 2026-10-05',
    });
  });
});

describe('anchorCashCheck (David 2026-10-02, #1927 item 5)', () => {
  const compare = (brokerCashQuote: number, flow: number, quotePerGbp = 1): AnchorCompare => ({
    brokerCashQuote,
    anchor: {
      currency: 'GBP',
      cashQuote: 10_000,
      fillSeq: 0,
      brokerMode: 'live',
      tradingDate: DATE,
    },
    storeFlow: { ok: true, quote: flow },
    rate: { ok: true, quotePerGbp, source: 's' },
    toleranceGbp: 5,
  });

  it('passes a gap of 4.99 either way and blocks 5.01 either way', () => {
    expect(anchorCashCheck(compare(9_904.99, -100)).diffs).toEqual([]);
    expect(anchorCashCheck(compare(9_895.01, -100)).diffs).toEqual([]);
    expect(anchorCashCheck(compare(9_905.01, -100)).diffs).toEqual([
      {
        kind: 'cash',
        instrument: null,
        order_id: null,
        store: -100,
        broker: expect.closeTo(-94.99, 9),
      },
    ]);
    expect(anchorCashCheck(compare(9_894.99, -100)).diffs).toEqual([
      {
        kind: 'cash',
        instrument: null,
        order_id: null,
        store: -100,
        broker: expect.closeTo(-105.01, 9),
      },
    ]);
  });

  it('takes the gap in the venue currency and converts only the gap at the day rate', () => {
    expect(anchorCashCheck(compare(10_006.2375, 0, FX))).toEqual({
      diffs: [],
      note: 'cash since anchor GBP: broker 6.24 store 0.00, gap GBP 4.99 at 1.25 (s)',
    });
    expect(anchorCashCheck(compare(10_006.2625, 0, FX)).diffs).toHaveLength(1);
    expect(anchorCashCheck(compare(10_006.3, 0, 1.27)).diffs).toEqual([]);
    expect(anchorCashCheck(compare(10_006.3, 0, FX)).diffs).toHaveLength(1);
  });

  it('is unverified when the store flow or the rate cannot be read', () => {
    expect(
      anchorCashCheck({ ...compare(10_000, 0), storeFlow: { ok: false, reason: 'unpriced' } }),
    ).toEqual({
      diffs: [
        { kind: 'cash_unverified', instrument: null, order_id: null, store: null, broker: 10_000 },
      ],
      note: 'unpriced',
    });
    expect(
      anchorCashCheck({ ...compare(10_000, 0), rate: { ok: false, reason: 'no fix' } }),
    ).toEqual({
      diffs: [
        { kind: 'cash_unverified', instrument: null, order_id: null, store: null, broker: 10_000 },
      ],
      note: 'no fix',
    });
  });
});

describe('liveCashCheck', () => {
  const broker = { venue: 'alpaca' as const, cashQuote: 12_000, booksMatch: true };
  const deps = (cashAnchors: CashAnchorLedger | undefined, tolerance?: number) => ({
    brokerMode: 'live' as const,
    cashAnchors,
    market: USD_FIX,
    reconcileCashToleranceGbp: tolerance,
  });
  const unverified = (note: string) => ({
    diffs: [
      { kind: 'cash_unverified', instrument: null, order_id: null, store: null, broker: 12_000 },
    ],
    note,
  });

  it('is unverified while the tolerance is unset, recording no anchor', () => {
    const { anchors } = store();
    expect(liveCashCheck(deps(anchors), broker, DATE)).toEqual(
      unverified('RECONCILE_CASH_TOLERANCE_GBP is not set'),
    );
    expect(anchors.anchor('alpaca')).toBeUndefined();
  });

  it('is unverified with no anchor ledger wired', () => {
    expect(liveCashCheck(deps(undefined, 5), broker, DATE)).toEqual(
      unverified('no cash anchor ledger'),
    );
  });

  it('with no anchor yet, records the broker cash at the first live run whose books match', () => {
    const { anchors } = store();
    expect(liveCashCheck(deps(anchors, 5), broker, DATE)).toEqual({
      diffs: [],
      note: 'cash anchor recorded: 12000.00 USD (#1927)',
    });
    expect(anchors.anchor('alpaca')).toEqual({
      currency: 'USD',
      cashQuote: 12_000,
      fillSeq: 0,
      brokerMode: 'live',
      tradingDate: DATE,
    });
  });

  it("is unverified against an anchor another account's run recorded, recording none", () => {
    const { db, anchors } = store();
    anchors.recordAnchor('alpaca', 'paper', 12_000, DATE);
    expect(liveCashCheck(deps(anchors, 5), broker, DATE)).toEqual(
      unverified("the alpaca cash anchor is the paper account's, not live's"),
    );
    expect(db.prepare('SELECT COUNT(*) AS n FROM v2_cash_anchors').get()).toEqual({ n: 1 });
  });

  it('with no anchor yet, waits while positions or orders disagree', () => {
    const { anchors } = store();
    expect(liveCashCheck(deps(anchors, 5), { ...broker, booksMatch: false }, DATE)).toEqual(
      unverified(
        'no cash anchor yet: it is recorded at the first live reconcile whose positions and orders match',
      ),
    );
    expect(anchors.anchor('alpaca')).toBeUndefined();
  });

  it('checks fills booked since the anchor against the broker, at 4.99 and 5.01 converted', () => {
    const { anchors, fill } = store();
    liveCashCheck(deps(anchors, 5), broker, DATE);
    fill({ id: 'buy', side: 'buy', qty: 6, price: 20, fee: 1 });

    const at = (gapGbp: number) =>
      liveCashCheck(deps(anchors, 5), { ...broker, cashQuote: 12_000 - 121 + gapGbp * FX }, DATE);
    expect(at(4.99).diffs).toEqual([]);
    expect(at(-4.99).diffs).toEqual([]);
    expect(at(5.01).diffs).toMatchObject([{ kind: 'cash', store: -121 }]);
    expect(at(-5.01).diffs).toMatchObject([{ kind: 'cash', store: -121 }]);
  });

  it('a journalled deposit moves the anchor, so the cash it adds at the broker is no gap', () => {
    const { anchors } = store();
    liveCashCheck(deps(anchors, 5), broker, DATE);
    const deposited = { ...broker, cashQuote: 13_000 };
    expect(liveCashCheck(deps(anchors, 5), deposited, DATE).diffs).toMatchObject([
      { kind: 'cash' },
    ]);

    anchors.recordMove({
      venue: 'alpaca',
      kind: 'deposit',
      amountQuote: 1_000,
      reference: 'wire-1',
      tradingDate: DATE,
    });
    expect(liveCashCheck(deps(anchors, 5), deposited, DATE)).toEqual({
      diffs: [],
      note: 'cash since anchor USD: broker 0.00 store 0.00, gap GBP 0.00 at 1.25 (boe-xudluss:2026-10-02)',
    });
  });

  it('replays: a re-run, or a fresh reader over the same journal, decides the same and anchors once', () => {
    const { db, anchors, fill } = store();
    liveCashCheck(deps(anchors, 5), broker, DATE);
    fill({ id: 'buy', side: 'buy', qty: 6, price: 20, fee: 1 });
    const later = { ...broker, cashQuote: 12_000 - 121 + 10 };

    const first = liveCashCheck(deps(anchors, 5), later, '2026-10-06');
    const rerun = liveCashCheck(deps(anchors, 5), later, '2026-10-06');
    const replayed = liveCashCheck(deps(new SqliteCashAnchors(db, clock), 5), later, '2026-10-06');

    expect(first.diffs).toMatchObject([{ kind: 'cash', store: -121, broker: -111 }]);
    expect(rerun).toEqual(first);
    expect(replayed).toEqual(first);
    expect(db.prepare('SELECT COUNT(*) AS n FROM v2_cash_anchors').get()).toEqual({ n: 1 });
  });
});
