import type {
  BookFill,
  BookLedger,
  BrokerMode,
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

export type ReplayStage =
  | 'book'
  | 'gate'
  | 'sizing'
  | 'orders'
  | 'rescales'
  | 'fills'
  | 'reconciles'
  | 'anchors'
  | 'carry'
  | 'marks'
  | 'signal_events'
  | 'signal_vetoes'
  | 'signal_decisions'
  | 'signal_refusals'
  | 'signal_orders'
  | 'signal_faults';

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
  'v2_cfd_carry',
  'v2_refusals',
  'v2_reconciles',
  'v2_faults',
  'v2_rescales',
] as const;

const APPEND_ONLY_TRIGGERS = [
  'v2_fills_no_delete',
  'v2_decisions_no_delete',
  'v2_reconciles_no_delete',
  'v2_faults_no_delete',
  'v2_controls_no_delete',
  'v2_rescales_no_delete',
  'v2_cash_anchors_no_delete',
  'v2_signal_events_no_delete',
  'v2_signal_vetoes_no_delete',
  'v2_signal_veto_claims_no_delete',
  'v2_signal_veto_retry_verdicts_no_delete',
] as const;

const SIGNAL_REWIND_SQL = [
  'DELETE FROM v2_signal_veto_retry_verdicts WHERE recorded_at >= @startedAt',
  'DELETE FROM v2_signal_veto_claims WHERE claimed_at >= @startedAt',
  'DELETE FROM v2_signal_vetoes WHERE recorded_at >= @startedAt',
  "DELETE FROM v2_signal_events WHERE status <> 'queued' AND recorded_at >= @startedAt",
] as const;

// An order cancelled after the cut still rested at it; the outcome it rested under follows from
// the route, as V2OrderExecutor.simulates and failedSubmission decide it
export function reopenedSql(after: string): { condition: string; outcome: string } {
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
  readonly brokerMode: BrokerMode;
}

function journalledDryRun(db: StoreHandle, tradingDate: string): boolean {
  const row = db
    .prepare(
      `SELECT COALESCE(
         (SELECT MAX(dry_run) FROM v2_orders WHERE trading_date = ?),
         (SELECT MAX(dry_run) FROM v2_orders)) AS dry_run`,
    )
    .get(tradingDate) as { dry_run: number | null };
  return row.dry_run === 1;
}

// A reconcile or fill journalled before migration 0092 records no mode, and every run before it
// was paper
function journalledBrokerMode(db: StoreHandle, tradingDate: string): BrokerMode {
  const row = db
    .prepare(
      `SELECT COALESCE(
         (SELECT broker_mode FROM v2_reconciles WHERE trading_date = @date AND broker_mode IS NOT NULL
           ORDER BY reconcile_id LIMIT 1),
         (SELECT broker_mode FROM v2_fills WHERE trading_date = @date ORDER BY fill_seq LIMIT 1),
         'paper') AS mode`,
    )
    .get({ date: tradingDate }) as { mode: BrokerMode };
  return row.mode;
}

export function journalledDay(db: StoreHandle, tradingDate: string): JournalledDay {
  const started = db
    .prepare(`SELECT MIN(recorded_at) AS at FROM (${UNION_RECORDED})`)
    .get({ date: tradingDate }) as { at: string | null };
  const marked = db
    .prepare('SELECT MAX(recorded_at) AS at FROM v2_book_days WHERE trading_date = ?')
    .get(tradingDate) as { at: string | null };
  return {
    startedAt: started.at ?? undefined,
    markedAt: marked.at ?? undefined,
    dryRun: journalledDryRun(db, tradingDate),
    brokerMode: journalledBrokerMode(db, tradingDate),
  };
}

export interface MarkingRun {
  readonly runId: string;
  readonly firstSweepId: number;
}

// The run that marked the day is the last to sweep before the day's last mark row, told by journal
// rowids rather than clocks: a flatten pass after the marks swept with that mark already written
export function markingRun(db: StoreHandle, tradingDate: string): MarkingRun | undefined {
  const row = db
    .prepare(
      `WITH mark AS (SELECT MAX(rowid) AS id FROM v2_book_days WHERE trading_date = @date),
            marking AS (
              SELECT run_id FROM v2_fill_sweeps, mark
               WHERE trading_date = @date AND (mark.id IS NULL OR book_day_rowid < mark.id)
               ORDER BY sweep_id DESC LIMIT 1)
       SELECT marking.run_id AS runId, MIN(s.sweep_id) AS firstSweepId
         FROM marking JOIN v2_fill_sweeps s
           ON s.run_id = marking.run_id AND s.trading_date = @date`,
    )
    .get({ date: tradingDate }) as { runId: string | null; firstSweepId: number | null };
  return row.runId === null ? undefined : { runId: row.runId, firstSweepId: row.firstSweepId ?? 0 };
}

// David 2026-10-02 (#1990): a date another run acted on before the run that marked it is flagged,
// not replayed. A run acted if it swept twice, read a fill, or journalled an order or fill between
// the end of its opening sweep and the start of the next sweep; what its opening sweep booked the
// marking run's own opening sweep would re-read. Rows are placed by rowid, never by clock
export function earlierRunsThatActed(db: StoreHandle, tradingDate: string): string[] {
  const marking = markingRun(db, tradingDate);
  if (marking === undefined) return [];
  const rows = db
    .prepare(
      `WITH runs AS (
         SELECT run_id, COUNT(*) AS sweeps, MIN(sweep_id) AS opening FROM v2_fill_sweeps
          WHERE trading_date = @date AND sweep_id < @first GROUP BY run_id),
       bounds AS (
         SELECT r.run_id, r.sweeps, r.opening, o.last_fill_seq AS fills_after,
                o.order_rowid AS orders_after, n.first_fill_seq AS fills_to,
                n.order_rowid AS orders_to
           FROM runs r JOIN v2_fill_sweeps o ON o.sweep_id = r.opening
           JOIN v2_fill_sweeps n ON n.sweep_id = (
             SELECT MIN(sweep_id) FROM v2_fill_sweeps
              WHERE trading_date = @date AND sweep_id > r.opening))
       SELECT run_id FROM bounds
        WHERE sweeps > 1
           OR EXISTS (SELECT 1 FROM v2_fill_reads x WHERE x.run_id = bounds.run_id)
           OR EXISTS (SELECT 1 FROM v2_fills f WHERE f.trading_date = @date
                        AND f.fill_seq > fills_after AND f.fill_seq <= fills_to)
           OR EXISTS (SELECT 1 FROM v2_orders o WHERE o.trading_date = @date
                        AND o.rowid > orders_after AND o.rowid <= orders_to)
        ORDER BY opening`,
    )
    .all({ date: tradingDate, first: marking.firstSweepId }) as { run_id: string }[];
  return rows.map((row) => row.run_id);
}

const UNREAD_BY_THE_CYCLE = ['llm_call_log', 'llm_spend'] as const;

export function rewoundCopy(db: StoreHandle, tradingDate: string, startedAt: string): StoreHandle {
  const copy = inMemoryCopyOf(db);
  for (const table of UNREAD_BY_THE_CYCLE) copy.exec(`DELETE FROM ${table}`);
  copy.exec('VACUUM');
  for (const trigger of APPEND_ONLY_TRIGGERS) copy.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  const reopened = reopenedSql('>=');
  copy.transaction(() => {
    copy
      .prepare(
        `DELETE FROM v2_cash_anchors AS a WHERE CASE kind WHEN 'anchor' THEN trading_date >= @date
           ELSE recorded_at > COALESCE(
             (SELECT r.recorded_at FROM v2_reconciles r WHERE r.trading_date = @date
                AND r.source = 'broker' AND r.venue = a.venue ORDER BY r.reconcile_id LIMIT 1),
             @startedAt) END`,
      )
      .run({ date: tradingDate, startedAt });
    for (const table of DATED_TABLES) {
      copy.prepare(`DELETE FROM ${table} WHERE trading_date >= ?`).run(tradingDate);
    }
    copy.prepare('DELETE FROM v2_controls WHERE set_at > ?').run(startedAt);
    for (const sql of SIGNAL_REWIND_SQL) copy.prepare(sql).run({ startedAt });
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
  readonly ordinal: number;
}

interface JournalRescale {
  readonly book_id: string;
  readonly trading_date: string;
  readonly instrument: string;
  readonly ratio: number;
  readonly anchor_date: string;
  readonly fills_before: number;
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
         json_extract(o.payload, '$.target') AS target, f.ordinal
       FROM (SELECT *,
                    ROW_NUMBER() OVER (PARTITION BY trading_date ORDER BY fill_seq) - 1 AS ordinal
               FROM v2_fills) f
       JOIN v2_orders o ON o.client_order_id = f.client_order_id
       ORDER BY f.trading_date, f.fill_seq`,
    )
    .all() as JournalFill[];
}

function rescalesBefore(copy: StoreHandle): JournalRescale[] {
  return copy
    .prepare(
      `SELECT book_id, trading_date, instrument, ratio, anchor_date, fills_before
       FROM v2_rescales ORDER BY trading_date, rescale_id`,
    )
    .all() as JournalRescale[];
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
  readonly seq: number;
  readonly apply: () => void;
}

function byDateThenRank(a: LedgerEvent, b: LedgerEvent): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  return a.rank === b.rank ? a.seq - b.seq : a.rank - b.rank;
}

// A day's fills and split rescales land before its mark, in journal order, so cash and
// positions are rebuilt by the same floating-point operations that produced the journalled ones;
// a rescale written after n of its day's fills sorts between the day's fill n - 1 (seq 2n - 1)
// and fill n (seq 2n + 1)
export function rebuildBooks(rebuild: BookRebuild): void {
  const known = new Set(rebuild.books.ids());
  const previous = new Map<string, string>();
  const fills = fillsBefore(rebuild.copy)
    .filter((fill) => known.has(fill.book_id))
    .map((fill) => ({
      date: fill.trading_date,
      rank: 0,
      seq: 2 * fill.ordinal + 1,
      apply: () => rebuild.books.applyFill(fill.book_id, bookFillOf(fill, rebuild.market)),
    }));
  const rescales = rescalesBefore(rebuild.copy)
    .filter((rescale) => known.has(rescale.book_id))
    .map((rescale) => ({
      date: rescale.trading_date,
      rank: 0,
      seq: 2 * rescale.fills_before,
      apply: () =>
        rebuild.books.applySplit(
          rescale.book_id,
          rescale.instrument,
          rescale.ratio,
          rescale.anchor_date,
        ),
    }));
  const marks = marksBefore(rebuild.copy)
    .filter((mark) => known.has(mark.book_id))
    .map((mark) => ({
      date: mark.trading_date,
      rank: 1,
      seq: 0,
      apply: () => {
        applyMark(rebuild, mark, previous.get(mark.book_id));
        previous.set(mark.book_id, mark.trading_date);
      },
    }));
  for (const event of [...fills, ...rescales, ...marks].sort(byDateThenRank)) event.apply();
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

export type Row = Record<string, unknown> & { readonly key: string };

export interface RowStage {
  readonly stage: Exclude<ReplayStage, 'book' | 'gate'>;
  readonly presence: boolean;
}

interface TableSpec extends RowStage {
  readonly sql: (cancelledAfter: string, journalled: boolean) => string;
}

export const MIRRORED_DIFF_KINDS: ReadonlySet<string> = new Set([
  'protective_qty',
  'protective_price',
  'position_unprotected',
  'cash',
  'cash_unverified',
]);

// The replay broker serves each venue's first journalled broker reconcile of the day (replay-broker.ts),
// so only that one is held to the replay, and only when the broker could mirror it: not a failed
// read, not one with any other difference, and not one from before migration 0092, which
// journalled no broker cash
const RECONCILE_SQL = (_after: string, journalled: boolean): string => `
  SELECT key, status, diffs, detail, broker_mode FROM (
    SELECT venue AS key, status, diffs, detail, broker_mode, reconcile_id,
           ROW_NUMBER() OVER (PARTITION BY venue ORDER BY reconcile_id) AS nth FROM v2_reconciles
     WHERE trading_date = @date AND source = 'broker' AND recorded_at <= @end)
   WHERE nth = 1 AND ${
     journalled
       ? `broker_mode IS NOT NULL
            AND (status = 'clean' OR (status <> 'read_failed' AND json_array_length(diffs) > 0))
            AND NOT EXISTS (
            SELECT 1 FROM json_each(diffs) d WHERE json_extract(d.value, '$.kind') NOT IN (${[...MIRRORED_DIFF_KINDS].map((kind) => `'${kind}'`).join(', ')}))`
       : '1'
}
   ORDER BY reconcile_id`;

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
    stage: 'rescales',
    presence: true,
    sql: () => `SELECT book_id || '|' || instrument || '|' || source || '|' || anchor_date || '|' ||
                    ROW_NUMBER() OVER (PARTITION BY book_id, instrument, source, anchor_date
                                       ORDER BY rescale_id) AS key,
                  ratio, qty_before, qty_after, entry_before, entry_after, stop_before, stop_after,
                  target_before, target_after FROM v2_rescales
                 WHERE trading_date = @date AND recorded_at <= @end ORDER BY rescale_id`,
  },
  {
    stage: 'fills',
    presence: true,
    sql: () => `SELECT fill_id AS key, client_order_id, book_id, trading_date, instrument, venue,
                  leg, side, qty, price_gbp, fee_gbp, broker_mode FROM v2_fills
                 WHERE trading_date = @date AND recorded_at <= @end ORDER BY fill_seq`,
  },
  { stage: 'reconciles', presence: false, sql: RECONCILE_SQL },
  {
    stage: 'anchors',
    presence: true,
    sql: () => `SELECT a.venue AS key, a.currency, a.amount_quote, a.broker_mode, a.reference,
                  (SELECT COUNT(*) FROM v2_fills f
                    WHERE f.trading_date = a.trading_date AND f.fill_seq <= a.fill_seq) AS day_fills_held
                  FROM v2_cash_anchors a
                 WHERE a.trading_date = @date AND a.kind = 'anchor' AND a.recorded_at <= @end
                 ORDER BY a.anchor_row_id`,
  },
  {
    stage: 'carry',
    presence: true,
    sql: () => `SELECT book_id || '|' || instrument AS key, venue, client_order_id, financing_gbp,
                  borrow_gbp FROM v2_cfd_carry
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

const MODELLED_SLIPPAGE_KEY = 'modelled_slippage_bps';

// An order journalled before #1884 carries no modelled slippage, so the replayed one cannot be
// held to it: every such day would diverge on the payload whatever the tables say
function comparableTo(journalled: Row, replayed: Row): Row {
  const [before, after] = [journalled.payload, replayed.payload];
  if (typeof before !== 'string' || typeof after !== 'string') return replayed;
  if (MODELLED_SLIPPAGE_KEY in (JSON.parse(before) as Record<string, unknown>)) return replayed;
  const kept = Object.entries(JSON.parse(after) as Record<string, unknown>).filter(
    ([name]) => name !== MODELLED_SLIPPAGE_KEY,
  );
  return { ...replayed, payload: JSON.stringify(Object.fromEntries(kept)) };
}

function rowDivergence(spec: RowStage, journalled: Row, replayedRow: Row | undefined) {
  if (replayedRow === undefined) {
    return spec.presence
      ? ({ kind: 'row_missing', stage: spec.stage, key: journalled.key } as const)
      : undefined;
  }
  const replayed = comparableTo(journalled, replayedRow);
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

export function tableDivergences(
  spec: RowStage,
  journalled: readonly Row[],
  replayed: readonly Row[],
): BookDivergence[] {
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
  readonly startedAt: string | undefined;
}

export interface TradingCounts {
  readonly orders: number;
  readonly fills: number;
}

export interface SkippedStage {
  readonly stage: ReplayStage;
  readonly migration: number;
}

const CUTOVERS: readonly SkippedStage[] = [
  { stage: 'rescales', migration: 87 },
  { stage: 'carry', migration: 94 },
];

// A day run before a table's migration journals none of its rows, so every row its replay writes
// would read as an extra one: before #1983 no rescale, before #2071 no per-position CFD carry. The
// cutover is the migration's apply instant, not the table's first row: a day after the deploy
// with no such row is still held, and a later re-run of an old date holds no earlier day. A run
// cannot straddle it, as migrations apply before the process cycles
function skippedStages(comparison: TradingComparison): SkippedStage[] {
  const ranAt = comparison.markedAt ?? comparison.startedAt ?? LATEST;
  const applied = comparison.journal.prepare(
    'SELECT applied_at FROM schema_migrations WHERE version = ?',
  );
  return CUTOVERS.filter((cutover) => {
    const row = applied.get(cutover.migration) as { applied_at: string } | undefined;
    return row === undefined || row.applied_at > ranAt;
  });
}

export function tradingDivergences(comparison: TradingComparison): {
  divergences: BookDivergence[];
  counts: TradingCounts;
  skipped: SkippedStage[];
} {
  const { journal, replayed, tradingDate } = comparison;
  const end = comparison.markedAt ?? LATEST;
  const counts = { orders: 0, fills: 0 };
  const skipped = skippedStages(comparison);
  const held = TABLES.filter((spec) => !skipped.some((skip) => skip.stage === spec.stage));
  const divergences = held.flatMap((spec) => {
    const journalled = rowsOf(journal, spec.sql('>', true), tradingDate, end);
    if (spec.stage === 'orders' || spec.stage === 'fills') counts[spec.stage] = journalled.length;
    return tableDivergences(
      spec,
      journalled,
      rowsOf(replayed, spec.sql('>', false), tradingDate, LATEST),
    );
  });
  return { divergences, counts, skipped };
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
