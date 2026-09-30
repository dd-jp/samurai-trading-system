import type { Clock, Logger } from '../../shared/index.js';
import { describeThrownSafely } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import type { CycleReport } from './cycle.js';
import type { FaultLedger } from './journal/index.js';
import { CapitalConfigStore, sleeveCapitalYear } from './risk/index.js';
import { SLEEVE_SPECS_BY_ID, SqliteMonthlySpendCap } from './signal/index.js';

const TOP_REFUSAL_CODES = 3;
const FIRST_CYCLE = '';
const SIGNAL_SCOPE = 'signal';

export interface CodeCount {
  readonly code: string;
  readonly count: number;
}

export interface RefusalTally {
  readonly count: number;
  readonly top: readonly CodeCount[];
}

export interface BookSummary {
  readonly book_id: string;
  readonly equity_gbp: number;
  readonly day_pnl_gbp: number;
  readonly ytd_loss_gbp: number;
  readonly loss_cap_gbp: number | null;
  readonly size_multiplier: number;
  readonly entries_blocked: boolean;
  readonly open_positions: number;
  readonly decisions: number;
  readonly entries_placed: number;
  readonly entries_filled: number;
  readonly entries_rejected: number;
  readonly exits_filled: number;
  readonly refusals: RefusalTally;
}

export type SummaryFaults = Pick<FaultLedger, 'faultFreeWeeks' | 'kindsRecordedAfter'>;

export interface DailySummary {
  readonly trading_date: string;
  readonly since: string | null;
  readonly books: readonly BookSummary[];
  readonly signal_refusals: RefusalTally;
  readonly other_refusals: RefusalTally;
  readonly faults: {
    readonly recorded: readonly CodeCount[];
    readonly free_weeks: number;
    readonly counted_days: number;
    readonly last_fault: string | undefined;
  };
  readonly llm: {
    readonly spent_usd: number | null;
    readonly budget_usd: number;
    readonly stopped: boolean;
  };
}

interface BookDayRow {
  book_id: string;
  sleeve_id: string;
  equity_gbp: number;
  previous_equity_gbp: number;
  ytd_loss_gbp: number;
  size_multiplier: number;
  entries_blocked: number;
  open_positions: number;
}

interface RefusalRow {
  book_id: string | null;
  scope: string;
  parameter: string;
  n: number;
}

const BOOK_DAYS = `
  SELECT d.book_id, b.sleeve_id, d.equity_gbp, d.ytd_loss_gbp, d.size_multiplier, d.entries_blocked,
         COALESCE(
           (SELECT p.equity_gbp FROM v2_book_days p
             WHERE p.book_id = d.book_id AND p.trading_date < d.trading_date
             ORDER BY p.trading_date DESC LIMIT 1),
           b.start_capital_gbp) AS previous_equity_gbp,
         (SELECT COUNT(*) FROM v2_positions h WHERE h.book_id = d.book_id) AS open_positions
    FROM v2_book_days d JOIN v2_books b USING (book_id)
   WHERE d.trading_date = ?
   ORDER BY b.sleeve_id <> 'debate', b.sleeve_id, b.variant <> 'primary', d.book_id`;

const PER_BOOK_COUNTS = {
  decisions:
    'SELECT book_id, COUNT(*) AS n FROM v2_decisions WHERE recorded_at > ? GROUP BY book_id',
  placed: `SELECT book_id, COUNT(*) AS n FROM v2_orders
            WHERE leg = 'entry' AND outcome <> 'rejected' AND recorded_at > ? GROUP BY book_id`,
  rejected: `SELECT book_id, COUNT(*) AS n FROM v2_orders
              WHERE leg = 'entry' AND outcome = 'rejected' AND recorded_at > ? GROUP BY book_id`,
  filled: `SELECT book_id, COUNT(DISTINCT client_order_id) AS n FROM v2_fills
            WHERE leg = 'entry' AND recorded_at > ? GROUP BY book_id`,
  exits: `SELECT book_id, COUNT(DISTINCT client_order_id) AS n FROM v2_fills
           WHERE leg <> 'entry' AND recorded_at > ? GROUP BY book_id`,
} as const;

type CountName = keyof typeof PER_BOOK_COUNTS;

const REFUSALS = `
  SELECT book_id, scope, parameter, COUNT(*) AS n FROM v2_refusals WHERE recorded_at > ?
   GROUP BY book_id, scope, parameter ORDER BY n DESC, parameter`;

const STAGES: Readonly<Record<number, string>> = {
  1: 'full size',
  0.5: 'half size',
  0.25: 'quarter size',
  0: 'halted',
};

function previousCycleAt(db: StoreHandle, tradingDate: string): string | null {
  const row = db
    .prepare('SELECT MAX(recorded_at) AS at FROM v2_book_days WHERE trading_date < ?')
    .get(tradingDate) as { at: string | null };
  return row.at;
}

function countsByBook(db: StoreHandle, since: string): Record<CountName, Map<string, number>> {
  const read = (sql: string) =>
    new Map(
      (db.prepare(sql).all(since) as { book_id: string; n: number }[]).map((row) => [
        row.book_id,
        row.n,
      ]),
    );
  return {
    decisions: read(PER_BOOK_COUNTS.decisions),
    placed: read(PER_BOOK_COUNTS.placed),
    rejected: read(PER_BOOK_COUNTS.rejected),
    filled: read(PER_BOOK_COUNTS.filled),
    exits: read(PER_BOOK_COUNTS.exits),
  };
}

export function tally(rows: readonly RefusalRow[]): RefusalTally {
  const byCode = new Map<string, number>();
  for (const row of rows) byCode.set(row.parameter, (byCode.get(row.parameter) ?? 0) + row.n);
  const top = [...byCode]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code))
    .slice(0, TOP_REFUSAL_CODES);
  return { count: rows.reduce((sum, row) => sum + row.n, 0), top };
}

function lossCapFor(
  sleeveId: string,
  capital: CapitalConfigStore,
  tradingDate: string,
): number | null {
  const spec = SLEEVE_SPECS_BY_ID[sleeveId];
  const year = capital.lastKnown(tradingDate);
  if (spec === undefined || year === undefined) return null;
  return sleeveCapitalYear(spec, year).lossCapGbp;
}

function bookSummary(
  row: BookDayRow,
  counts: Record<CountName, Map<string, number>>,
  refusals: readonly RefusalRow[],
  lossCapGbp: number | null,
): BookSummary {
  const count = (name: CountName) => counts[name].get(row.book_id) ?? 0;
  return {
    book_id: row.book_id,
    equity_gbp: row.equity_gbp,
    day_pnl_gbp: row.equity_gbp - row.previous_equity_gbp,
    ytd_loss_gbp: row.ytd_loss_gbp,
    loss_cap_gbp: lossCapGbp,
    size_multiplier: row.size_multiplier,
    entries_blocked: row.entries_blocked === 1,
    open_positions: row.open_positions,
    decisions: count('decisions'),
    entries_placed: count('placed'),
    entries_filled: count('filled'),
    entries_rejected: count('rejected'),
    exits_filled: count('exits'),
    refusals: tally(refusals.filter((refusal) => refusal.book_id === row.book_id)),
  };
}

function faultsFor(faults: SummaryFaults, since: string, tradingDate: string) {
  const free = faults.faultFreeWeeks(tradingDate);
  return {
    recorded: faults.kindsRecordedAfter(since).map(({ kind, count }) => ({ code: kind, count })),
    free_weeks: free.weeks,
    counted_days: free.counted_days,
    last_fault: free.last_fault,
  };
}

export function readDailySummary(
  db: StoreHandle,
  clock: Clock,
  tradingDate: string,
  faults: SummaryFaults,
): DailySummary {
  const since = previousCycleAt(db, tradingDate);
  const counts = countsByBook(db, since ?? FIRST_CYCLE);
  const refusals = db.prepare(REFUSALS).all(since ?? FIRST_CYCLE) as RefusalRow[];
  const capital = new CapitalConfigStore(db, clock);
  const books = (db.prepare(BOOK_DAYS).all(tradingDate) as BookDayRow[]).map((row) =>
    bookSummary(row, counts, refusals, lossCapFor(row.sleeve_id, capital, tradingDate)),
  );
  const unbooked = refusals.filter((refusal) => refusal.book_id === null);
  const verdict = new SqliteMonthlySpendCap(db, clock).check();
  return {
    trading_date: tradingDate,
    since,
    books,
    signal_refusals: tally(unbooked.filter((refusal) => refusal.scope === SIGNAL_SCOPE)),
    other_refusals: tally(unbooked.filter((refusal) => refusal.scope !== SIGNAL_SCOPE)),
    faults: faultsFor(faults, since ?? FIRST_CYCLE, tradingDate),
    llm: {
      spent_usd: Number.isFinite(verdict.spent_usd) ? verdict.spent_usd : null,
      budget_usd: verdict.budget_usd,
      stopped: !verdict.admitted,
    },
  };
}

function gbp(amount: number): string {
  const digits = Math.abs(amount).toLocaleString('en-GB', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${amount < 0 ? '-' : ''}£${digits}`;
}

function signedGbp(amount: number): string {
  return amount > 0 ? `+${gbp(amount)}` : gbp(amount);
}

function codes(refusals: RefusalTally): string {
  if (refusals.count === 0) return '0';
  return `${refusals.count} (${refusals.top.map((top) => `${top.code} ${top.count}`).join(', ')})`;
}

function budgetText(book: BookSummary): string {
  const stage = STAGES[book.size_multiplier] ?? `size x${book.size_multiplier}`;
  const blocked = book.entries_blocked ? ', entries blocked today' : '';
  const year = `year ${signedGbp(-book.ytd_loss_gbp)}`;
  if (book.loss_cap_gbp === null) return `${stage}${blocked}; ${year}`;
  const left = book.loss_cap_gbp - book.ytd_loss_gbp;
  return `${stage}${blocked}; ${year}, ${gbp(left)} left of ${gbp(book.loss_cap_gbp)} loss cap`;
}

function bookLines(book: BookSummary): string[] {
  return [
    `${book.book_id}: equity ${gbp(book.equity_gbp)}, day ${signedGbp(book.day_pnl_gbp)}; ${budgetText(book)}`,
    `  decisions ${book.decisions}; entries ${book.entries_placed} placed, ${book.entries_filled} filled, ` +
      `${book.entries_rejected} rejected; exits ${book.exits_filled}; open ${book.open_positions}`,
    `  refusals ${codes(book.refusals)}`,
  ];
}

function windowLine(since: string | null): string {
  if (since === null) return 'Window: everything journalled so far (first cycle)';
  return `Window: since the last cycle, ${since.slice(0, 16).replace('T', ' ')} UTC`;
}

function faultLine(faults: DailySummary['faults']): string {
  const count = faults.recorded.reduce((sum, kind) => sum + kind.count, 0);
  const kinds =
    count === 0 ? '' : ` (${faults.recorded.map((k) => `${k.code} ${k.count}`).join(', ')})`;
  const last = faults.last_fault === undefined ? 'no fault yet' : `last fault ${faults.last_fault}`;
  return `Faults since the last cycle: ${count}${kinds}; fault-free weeks ${faults.free_weeks} (${faults.counted_days} counted days, ${last})`;
}

function llmLine(llm: DailySummary['llm']): string {
  const spent = llm.spent_usd === null ? 'n/a' : `$${llm.spent_usd.toFixed(2)}`;
  const stopped = llm.stopped ? ' (calls stopped)' : '';
  return `LLM spend this month: ${spent} of $${llm.budget_usd.toFixed(2)}${stopped}`;
}

export function formatDailySummary(summary: DailySummary, mode: 'paper' | 'dry-run'): string {
  return [
    `Samurai v2 daily summary ${summary.trading_date} (${mode})`,
    windowLine(summary.since),
    ...summary.books.flatMap(bookLines),
    `Signals refused before a book: ${codes(summary.signal_refusals)}`,
    `Other refusals: ${codes(summary.other_refusals)}`,
    faultLine(summary.faults),
    llmLine(summary.llm),
  ].join('\n');
}

export interface SummaryPush {
  readonly db: StoreHandle;
  readonly clock: Clock;
  readonly faults: SummaryFaults;
  readonly mode: 'paper' | 'dry-run';
  readonly logger: Logger;
  readonly notify: (text: string) => Promise<void>;
}

export async function pushDailySummary(push: SummaryPush, report: CycleReport): Promise<void> {
  if (report.skipped) return;
  try {
    const text = formatDailySummary(
      readDailySummary(push.db, push.clock, report.trading_date, push.faults),
      push.mode,
    );
    push.logger.log({
      trace_id: `v2-${report.trading_date}`,
      stage: 'v2',
      level: 'info',
      event: 'v2_daily_summary',
      message: text,
    });
    await push.notify(text);
  } catch (error) {
    push.logger.log({
      trace_id: `v2-${report.trading_date}`,
      stage: 'v2',
      level: 'warn',
      event: 'v2_daily_summary_failed',
      message: describeThrownSafely(error),
    });
  }
}
