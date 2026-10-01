import type {
  BookFill,
  BookLedger,
  FillLeg,
  MarketData,
  OrderSide,
  Sleeve,
  Venue,
} from '../../../contracts/index.js';
import type { Clock } from '../../shared/index.js';
import { inMemoryCopyOf, type StoreHandle } from '../../shared/store/index.js';
import { quotePerGbp, type VenueSessionGate } from './data/index.js';
import { CapitalConfigStore, PaperBooks } from './risk/index.js';

export type ReplayStage = 'book' | 'gate' | 'sizing' | 'orders' | 'fills' | 'marks';

export type BookDivergence =
  | {
      readonly kind: 'book_state';
      readonly stage: 'book' | 'gate';
      readonly bookId: string;
      readonly asOf: string;
      readonly field: string;
      readonly journalled: unknown;
      readonly replayed: unknown;
    }
  | {
      readonly kind: 'row_field';
      readonly stage: Exclude<ReplayStage, 'book' | 'gate'>;
      readonly key: string;
      readonly field: string;
      readonly journalled: unknown;
      readonly replayed: unknown;
    }
  | {
      readonly kind: 'row_missing';
      readonly stage: Exclude<ReplayStage, 'book' | 'gate'>;
      readonly key: string;
    }
  | {
      readonly kind: 'row_extra';
      readonly stage: Exclude<ReplayStage, 'book' | 'gate'>;
      readonly key: string;
    };

const LATEST = '9999-12-31T23:59:59.999Z';

const DATED_TABLES = [
  'v2_fills',
  'v2_orders',
  'v2_decisions',
  'v2_book_days',
  'v2_refusals',
  'v2_reconciles',
  'v2_faults',
] as const;

const APPEND_ONLY_TRIGGERS = [
  'v2_fills_no_delete',
  'v2_decisions_no_delete',
  'v2_reconciles_no_delete',
  'v2_faults_no_delete',
  'v2_controls_no_delete',
] as const;

// An order cancelled after the cut still rested at it; the outcome it rested under follows from
// the route, as V2OrderExecutor.simulates and failedSubmission decide it
function reopenedSql(after: string): { condition: string; outcome: string } {
  return {
    condition: `o.outcome = 'cancelled' AND json_extract(o.payload, '$.cancelled') ${after} @date`,
    outcome: `CASE
      WHEN o.dry_run = 0 AND b.variant = 'primary' AND o.venue = 'alpaca' THEN 'submitted'
      WHEN b.variant = 'primary' AND (o.dry_run = 1 OR o.venue = 'alpaca') THEN 'refused_dry_run'
      ELSE 'simulated' END`,
  };
}

const UNION_RECORDED = DATED_TABLES.filter((table) => table !== 'v2_faults')
  .map((table) => `SELECT recorded_at FROM ${table} WHERE trading_date = @date`)
  .join(' UNION ALL ');

export interface JournalledDay {
  readonly startedAt: string | undefined;
  readonly markedAt: string | undefined;
  readonly dryRun: boolean;
}

export function journalledDay(db: StoreHandle, tradingDate: string): JournalledDay {
  const started = db
    .prepare(`SELECT MIN(recorded_at) AS at FROM (${UNION_RECORDED})`)
    .get({ date: tradingDate }) as { at: string | null };
  const marked = db
    .prepare('SELECT MAX(recorded_at) AS at FROM v2_book_days WHERE trading_date = ?')
    .get(tradingDate) as { at: string | null };
  const dryRun = db.prepare('SELECT 1 FROM v2_orders WHERE dry_run = 1 LIMIT 1').get();
  return {
    startedAt: started.at ?? undefined,
    markedAt: marked.at ?? undefined,
    dryRun: dryRun !== undefined,
  };
}

export function rewoundCopy(db: StoreHandle, tradingDate: string, startedAt: string): StoreHandle {
  const copy = inMemoryCopyOf(db);
  for (const trigger of APPEND_ONLY_TRIGGERS) copy.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  const reopened = reopenedSql('>=');
  copy.transaction(() => {
    for (const table of DATED_TABLES) {
      copy.prepare(`DELETE FROM ${table} WHERE trading_date >= ?`).run(tradingDate);
    }
    copy.prepare('DELETE FROM v2_controls WHERE set_at > ?').run(startedAt);
    copy
      .prepare(
        `UPDATE v2_orders AS o SET outcome = ${reopened.outcome},
           payload = json_remove(o.payload, '$.cancelled')
         FROM v2_books b WHERE b.book_id = o.book_id AND ${reopened.condition}`,
      )
      .run({ date: tradingDate });
    copy.exec('DELETE FROM v2_positions');
    copy.exec('UPDATE v2_books SET cash_gbp = start_capital_gbp');
  })();
  return copy;
}

interface JournalFill {
  readonly book_id: string;
  readonly trading_date: string;
  readonly instrument: string;
  readonly venue: Venue;
  readonly leg: FillLeg;
  readonly side: OrderSide;
  readonly qty: number;
  readonly price_gbp: number;
  readonly fee_gbp: number;
  readonly client_order_id: string;
  readonly stop: number | null;
  readonly target: number | null;
}

interface JournalMark {
  readonly book_id: string;
  readonly trading_date: string;
  readonly equity_gbp: number;
  readonly cash_gbp: number;
  readonly invested_gbp: number;
  readonly ytd_loss_gbp: number;
  readonly size_multiplier: number;
  readonly entries_blocked: number;
  readonly accrued_gbp: number;
}

export interface BookRebuild {
  readonly copy: StoreHandle;
  readonly books: BookLedger;
  readonly market: MarketData;
  readonly venueSessions: VenueSessionGate;
}

function marksBefore(copy: StoreHandle): JournalMark[] {
  return copy
    .prepare(
      `SELECT book_id, trading_date, equity_gbp, cash_gbp, invested_gbp, ytd_loss_gbp,
         size_multiplier, entries_blocked,
         custody_accrual_gbp + cfd_financing_accrual_gbp + cfd_borrow_accrual_gbp AS accrued_gbp
       FROM v2_book_days ORDER BY trading_date, rowid`,
    )
    .all() as JournalMark[];
}

function fillsBefore(copy: StoreHandle): JournalFill[] {
  return copy
    .prepare(
      `SELECT f.book_id, f.trading_date, f.instrument, f.venue, f.leg, f.side, f.qty, f.price_gbp,
         f.fee_gbp, f.client_order_id, json_extract(o.payload, '$.stop') AS stop,
         json_extract(o.payload, '$.target') AS target
       FROM v2_fills f JOIN v2_orders o ON o.client_order_id = f.client_order_id
       ORDER BY f.trading_date, f.rowid`,
    )
    .all() as JournalFill[];
}

function bookFillOf(fill: JournalFill, market: MarketData): BookFill {
  const fx = quotePerGbp(market, fill.venue, fill.trading_date);
  const levels = fill.leg === 'entry';
  return {
    instrument: fill.instrument,
    venue: fill.venue,
    side: fill.side,
    leg: fill.leg,
    qty: fill.qty,
    priceGbp: fill.price_gbp,
    feeGbp: fill.fee_gbp,
    clientOrderId: fill.client_order_id,
    tradingDate: fill.trading_date,
    stopGbp: levels && fill.stop !== null ? fill.stop / fx : undefined,
    targetGbp: levels && fill.target !== null ? fill.target / fx : undefined,
  };
}

function applyMark(rebuild: BookRebuild, mark: JournalMark, previous: string | undefined): void {
  const { copy, venueSessions } = rebuild;
  copy
    .prepare('UPDATE v2_books SET cash_gbp = cash_gbp + ? WHERE book_id = ?')
    .run(-mark.accrued_gbp, mark.book_id);
  copy
    .prepare(
      `UPDATE v2_positions SET marks_held = marks_held + 1
       WHERE book_id = ? AND venue NOT IN (SELECT value FROM json_each(?))`,
    )
    .run(
      mark.book_id,
      JSON.stringify(venueSessions.timeStopPausedVenues(previous, mark.trading_date)),
    );
}

// Only the latest exit since the position opened can be pending: the cycle sends no second
// flatten while one is pending, and a fill or a rearm after it ends it
const PENDING_EXIT_SQL = `
  SELECT o.client_order_id FROM (
    SELECT client_order_id FROM v2_orders
     WHERE book_id = @book AND instrument = @instrument AND leg = 'exit'
       AND substr(client_order_id, -5) = '-exit' AND outcome <> 'rejected'
       AND trading_date >= @opened
     ORDER BY trading_date DESC LIMIT 1) o
   WHERE NOT EXISTS (SELECT 1 FROM v2_fills f WHERE f.client_order_id = o.client_order_id)
     AND NOT EXISTS (SELECT 1 FROM v2_orders r
                      WHERE json_extract(r.payload, '$.exit_client_order_id') = o.client_order_id)`;

function restorePendingExits(rebuild: BookRebuild): void {
  const rows = rebuild.copy
    .prepare('SELECT book_id, instrument, opened_date FROM v2_positions')
    .all() as { book_id: string; instrument: string; opened_date: string }[];
  for (const row of rows) {
    const pending = rebuild.copy
      .prepare(PENDING_EXIT_SQL)
      .get({ book: row.book_id, instrument: row.instrument, opened: row.opened_date }) as
      | { client_order_id: string }
      | undefined;
    if (pending !== undefined) {
      rebuild.books.setExitPending(row.book_id, row.instrument, pending.client_order_id);
    }
  }
}

interface LedgerEvent {
  readonly date: string;
  readonly rank: number;
  readonly apply: () => void;
}

function byDateThenRank(a: LedgerEvent, b: LedgerEvent): number {
  return a.date === b.date ? a.rank - b.rank : a.date < b.date ? -1 : 1;
}

// A day's fills land before its mark, each in journal order, so cash is rebuilt by the same
// floating-point operations that produced the journalled cash
export function rebuildBooks(rebuild: BookRebuild): void {
  const known = new Set(rebuild.books.ids());
  const previous = new Map<string, string>();
  const fills = fillsBefore(rebuild.copy)
    .filter((fill) => known.has(fill.book_id))
    .map((fill) => ({
      date: fill.trading_date,
      rank: 0,
      apply: () => rebuild.books.applyFill(fill.book_id, bookFillOf(fill, rebuild.market)),
    }));
  const marks = marksBefore(rebuild.copy)
    .filter((mark) => known.has(mark.book_id))
    .map((mark) => ({
      date: mark.trading_date,
      rank: 1,
      apply: () => {
        applyMark(rebuild, mark, previous.get(mark.book_id));
        previous.set(mark.book_id, mark.trading_date);
      },
    }));
  for (const event of [...fills, ...marks].sort(byDateThenRank)) event.apply();
  restorePendingExits(rebuild);
}

function lastMarks(copy: StoreHandle): JournalMark[] {
  return marksBefore(copy).filter(
    (mark, index, all) => !all.slice(index + 1).some((later) => later.book_id === mark.book_id),
  );
}

function stateDivergence(
  stage: 'book' | 'gate',
  mark: JournalMark,
  field: keyof JournalMark,
  replayed: number,
): BookDivergence | undefined {
  if (mark[field] === replayed) return undefined;
  return {
    kind: 'book_state',
    stage,
    bookId: mark.book_id,
    asOf: mark.trading_date,
    field,
    journalled: mark[field],
    replayed,
  };
}

function present(entries: readonly (BookDivergence | undefined)[]): BookDivergence[] {
  return entries.filter((entry): entry is BookDivergence => entry !== undefined);
}

export function bookStateDivergences(rebuild: BookRebuild): BookDivergence[] {
  const { books, market } = rebuild;
  return lastMarks(rebuild.copy).flatMap((mark) => {
    const markGbp = (instrument: string, venue: Venue) => {
      const bar = market.lastBarBefore(instrument, mark.trading_date);
      return bar === undefined
        ? undefined
        : bar.rawClose / quotePerGbp(market, venue, mark.trading_date);
    };
    return present([
      stateDivergence('book', mark, 'cash_gbp', books.cash(mark.book_id)),
      stateDivergence(
        'book',
        mark,
        'invested_gbp',
        books.valuation(mark.book_id, markGbp).investedGbp,
      ),
    ]);
  });
}

export interface LossBudgetCheck {
  readonly copy: StoreHandle;
  readonly clock: Clock;
  readonly tradingDate: string;
  readonly sleeves: readonly Pick<Sleeve, 'id' | 'spec'>[];
}

// Each book's last mark is re-marked from its journalled equity alone (no positions, cash set to
// that equity, so no accrual), which runs the loss budget exactly as the cycle that wrote it did
export function lossBudgetDivergences(check: LossBudgetCheck): BookDivergence[] {
  const scratch = inMemoryCopyOf(check.copy);
  try {
    const last = lastMarks(scratch);
    scratch.exec('DELETE FROM v2_positions');
    for (const mark of last) {
      scratch
        .prepare('DELETE FROM v2_book_days WHERE book_id = ? AND trading_date = ?')
        .run(mark.book_id, mark.trading_date);
      scratch
        .prepare('UPDATE v2_books SET cash_gbp = ? WHERE book_id = ?')
        .run(mark.equity_gbp, mark.book_id);
    }
    const capital = new CapitalConfigStore(scratch, check.clock);
    const books = new PaperBooks(scratch, check.clock, capital, check.tradingDate, check.sleeves);
    const open = new Set(books.ids());
    return last
      .filter((mark) => open.has(mark.book_id))
      .flatMap((mark) => {
        const { state } = books.markDay(mark.book_id, mark.trading_date, () => undefined, 0);
        return present([
          stateDivergence('gate', mark, 'ytd_loss_gbp', state.ytdLossGbp),
          stateDivergence('gate', mark, 'size_multiplier', state.sizeMultiplier),
          stateDivergence('gate', mark, 'entries_blocked', state.entriesBlockedAtNextFill ? 1 : 0),
        ]);
      });
  } finally {
    scratch.close();
  }
}

type Row = Record<string, unknown> & { readonly key: string };

interface TableSpec {
  readonly stage: Exclude<ReplayStage, 'book' | 'gate'>;
  readonly sql: (cancelledAfter: string) => string;
  readonly presence: boolean;
}

const ORDER_SQL = (after: string): string => {
  const reopened = reopenedSql(after);
  return `SELECT o.client_order_id AS key,
      (SELECT d.book_id || '|' || d.instrument FROM v2_decisions d
        WHERE d.decision_id = o.decision_id) AS decision,
      o.book_id, o.trading_date, o.instrument, o.venue, o.leg, o.side, o.dry_run,
      CASE WHEN ${reopened.condition} THEN ${reopened.outcome} ELSE o.outcome END AS outcome,
      CASE WHEN ${reopened.condition} THEN json_remove(o.payload, '$.cancelled')
           ELSE o.payload END AS payload
    FROM v2_orders o JOIN v2_books b ON b.book_id = o.book_id
   WHERE o.trading_date = @date AND o.recorded_at <= @end ORDER BY o.rowid`;
};

const TABLES: readonly TableSpec[] = [
  {
    stage: 'sizing',
    presence: false,
    sql: () => `SELECT book_id || '|' || instrument AS key, size_shares FROM v2_decisions
                 WHERE trading_date = @date AND recorded_at <= @end ORDER BY rowid`,
  },
  { stage: 'orders', presence: true, sql: ORDER_SQL },
  {
    stage: 'fills',
    presence: true,
    sql: () => `SELECT fill_id AS key, client_order_id, book_id, trading_date, instrument, venue,
                  leg, side, qty, price_gbp, fee_gbp FROM v2_fills
                 WHERE trading_date = @date AND recorded_at <= @end ORDER BY rowid`,
  },
  {
    stage: 'marks',
    presence: true,
    sql: () => `SELECT book_id AS key, equity_gbp, cash_gbp, invested_gbp, ytd_loss_gbp,
                  size_multiplier, entries_blocked, custody_accrual_gbp,
                  cfd_financing_accrual_gbp, cfd_borrow_accrual_gbp FROM v2_book_days
                 WHERE trading_date = @date AND recorded_at <= @end ORDER BY rowid`,
  },
];

function rowsOf(db: StoreHandle, sql: string, tradingDate: string, end: string): Row[] {
  return db.prepare(sql).all({ date: tradingDate, end }) as Row[];
}

function rowDivergence(spec: TableSpec, journalled: Row, replayed: Row | undefined) {
  if (replayed === undefined) {
    return spec.presence
      ? ({ kind: 'row_missing', stage: spec.stage, key: journalled.key } as const)
      : undefined;
  }
  const field = Object.keys(journalled).find((name) => journalled[name] !== replayed[name]);
  if (field === undefined) return undefined;
  return {
    kind: 'row_field',
    stage: spec.stage,
    key: journalled.key,
    field,
    journalled: journalled[field],
    replayed: replayed[field],
  } as const;
}

function tableDivergences(spec: TableSpec, journalled: Row[], replayed: Row[]): BookDivergence[] {
  const byKey = new Map(replayed.map((row) => [row.key, row]));
  const known = new Set(journalled.map((row) => row.key));
  const extra = spec.presence
    ? replayed
        .filter((row) => !known.has(row.key))
        .map((row): BookDivergence => ({ kind: 'row_extra', stage: spec.stage, key: row.key }))
    : [];
  return [
    ...present(journalled.map((row) => rowDivergence(spec, row, byKey.get(row.key)))),
    ...extra,
  ];
}

export interface TradingComparison {
  readonly journal: StoreHandle;
  readonly replayed: StoreHandle;
  readonly tradingDate: string;
  readonly markedAt: string | undefined;
}

export interface TradingCounts {
  readonly orders: number;
  readonly fills: number;
}

export function tradingDivergences(comparison: TradingComparison): {
  divergences: BookDivergence[];
  counts: TradingCounts;
} {
  const { journal, replayed, tradingDate } = comparison;
  const end = comparison.markedAt ?? LATEST;
  const counts = { orders: 0, fills: 0 };
  const divergences = TABLES.flatMap((spec) => {
    const journalled = rowsOf(journal, spec.sql('>'), tradingDate, end);
    if (spec.stage === 'orders' || spec.stage === 'fills') counts[spec.stage] = journalled.length;
    return tableDivergences(spec, journalled, rowsOf(replayed, spec.sql('>'), tradingDate, LATEST));
  });
  return { divergences, counts };
}

const LATE_WAKE = /: (\S+) entry sits out \(late_wake_entry_cutoff\)$/;
const NEVER_LATE = new Date(0);

// The run's start instant is not journalled; whether it woke past an exchange's entry cutoff is,
// as the sit-out refusal, so the replay reads that back instead of a clock
export function journalledSessions(
  db: StoreHandle,
  tradingDate: string,
  base: VenueSessionGate,
): VenueSessionGate {
  const rows = db
    .prepare(
      `SELECT message FROM v2_refusals
        WHERE trading_date = ? AND scope = 'entry' AND parameter = 'late_wake_entry_cutoff'`,
    )
    .all(tradingDate) as { message: string }[];
  const late = new Set(rows.flatMap((row) => LATE_WAKE.exec(row.message)?.[1] ?? []));
  return {
    entrySitOut: (venue, date) =>
      late.has(venue) ? 'late_wake_entry_cutoff' : base.entrySitOut(venue, date, NEVER_LATE),
    timeStopPausedVenues: (previous, date) => base.timeStopPausedVenues(previous, date),
  };
}
