import type {
  BookDay,
  BookFill,
  BookLedger,
  BookSpec,
  CapitalYear,
  LossBudgetState,
  MarkPriceGbp,
  Position,
  Valuation,
} from '../../../../contracts/index.js';
import { saxoCustodyAccrual } from '../../../pipeline/momentum/index.js';
import type { Clock } from '../../../shared/index.js';
import type { StoreHandle } from '../../../shared/store/index.js';
import { toStoredTimestamp } from '../../../shared/store/index.js';
import type { CapitalConfigStore } from './capital-config.js';
import { LossBudget } from './loss-budget.js';

export const BOOK_SPECS: readonly BookSpec[] = [
  { id: 'debate/primary', sleeve: 'debate', variant: 'primary', instantiated: true },
  { id: 'debate/no-macro-gate', sleeve: 'debate', variant: 'no-macro-gate', instantiated: true },
  { id: 'debate/no-sentiment', sleeve: 'debate', variant: 'no-sentiment', instantiated: false },
  { id: 'debate/no-social', sleeve: 'debate', variant: 'no-social', instantiated: false },
  { id: 'debate/large-cap-only', sleeve: 'debate', variant: 'large-cap-only', instantiated: false },
  { id: 'momentum/no-veto', sleeve: 'momentum', variant: 'no-veto', instantiated: false },
];

const FLAT_EPSILON = 1e-9;

interface BookDayRow {
  trading_date: string;
  equity_gbp: number;
  cash_gbp: number;
  invested_gbp: number;
  ytd_loss_gbp: number;
  size_multiplier: number;
  entries_blocked: number;
  custody_accrual_gbp: number;
  recorded_at: string;
}

interface PositionRow {
  instrument: string;
  venue: Position['venue'];
  qty: number;
  avg_price_gbp: number;
  stop_gbp: number | null;
  target_gbp: number | null;
  client_order_id: string;
  exit_client_order_id: string | null;
  opened_date: string;
  marks_held: number;
}

function positionFromRow(row: PositionRow): Position {
  return {
    instrument: row.instrument,
    venue: row.venue,
    qty: row.qty,
    avgPriceGbp: row.avg_price_gbp,
    stopGbp: row.stop_gbp ?? undefined,
    targetGbp: row.target_gbp ?? undefined,
    clientOrderId: row.client_order_id,
    exitClientOrderId: row.exit_client_order_id ?? undefined,
    openedDate: row.opened_date,
    marksHeld: row.marks_held,
  };
}

function averagePriceGbp(held: Position, fill: BookFill, qty: number): number {
  const sameDirection =
    Math.sign(held.qty) === Math.sign(qty) && Math.abs(qty) > Math.abs(held.qty);
  return sameDirection
    ? (held.avgPriceGbp * Math.abs(held.qty) + fill.priceGbp * fill.qty) / Math.abs(qty)
    : held.avgPriceGbp;
}

function rollYear(
  budget: LossBudget,
  previous: { trading_date: string; equity_gbp: number } | undefined,
  tradingDate: string,
): void {
  if (previous === undefined || previous.trading_date.slice(0, 4) === tradingDate.slice(0, 4)) {
    return;
  }
  budget.resetYear(previous.equity_gbp);
}

export class PaperBooks implements BookLedger {
  readonly #budgets = new Map<string, LossBudget>();
  readonly #specs: readonly BookSpec[];

  constructor(
    private readonly db: StoreHandle,
    private readonly clock: Clock,
    private readonly capital: Pick<CapitalConfigStore, 'inForce' | 'lastKnown'>,
    openingDate: string,
    specs: readonly BookSpec[] = BOOK_SPECS,
  ) {
    const seedCapitalGbp = capital.inForce(openingDate)?.startCapitalGbp;
    const insert = db.prepare(
      `INSERT OR IGNORE INTO v2_books (book_id, sleeve_id, variant, start_capital_gbp, cash_gbp, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const opened: BookSpec[] = [];
    for (const spec of specs.filter((candidate) => candidate.instantiated)) {
      if (seedCapitalGbp !== undefined) {
        insert.run(spec.id, spec.sleeve, spec.variant, seedCapitalGbp, seedCapitalGbp, this.#now());
      }
      const bookStartCapitalGbp = this.#startCapital(spec.id);
      if (bookStartCapitalGbp === undefined) continue;
      const budget = new LossBudget(bookStartCapitalGbp);
      this.#budgets.set(spec.id, budget);
      this.#replay(spec.id, budget);
      opened.push(spec);
    }
    this.#specs = opened;
  }

  #startCapital(bookId: string): number | undefined {
    const row = this.db
      .prepare('SELECT start_capital_gbp FROM v2_books WHERE book_id = ?')
      .get(bookId) as { start_capital_gbp: number } | undefined;
    return row?.start_capital_gbp;
  }

  #replay(bookId: string, budget: LossBudget): void {
    const rows = this.db
      .prepare(
        'SELECT trading_date, equity_gbp FROM v2_book_days WHERE book_id = ? ORDER BY trading_date',
      )
      .all(bookId) as { trading_date: string; equity_gbp: number }[];
    let previous: { trading_date: string; equity_gbp: number } | undefined;
    for (const row of rows) {
      rollYear(budget, previous, row.trading_date);
      budget.markClose(
        row.equity_gbp,
        previous?.equity_gbp ?? row.equity_gbp,
        this.#capitalOn(row.trading_date),
      );
      previous = row;
    }
  }

  #capitalOn(tradingDate: string): CapitalYear {
    const capital = this.capital.lastKnown(tradingDate);
    if (capital === undefined) {
      throw new Error(`PaperBooks: no capital config on or before ${tradingDate}`);
    }
    return capital;
  }

  isMarked(tradingDate: string): boolean {
    return this.#specs.some((spec) => {
      const previous = this.lastDay(spec.id);
      return previous !== undefined && previous.tradingDate >= tradingDate;
    });
  }

  ids(): readonly string[] {
    return this.#specs.map((spec) => spec.id);
  }

  forSleeve(sleeveId: string): readonly BookSpec[] {
    return this.#specs.filter((spec) => spec.sleeve === sleeveId);
  }

  cash(bookId: string): number {
    const row = this.db.prepare('SELECT cash_gbp FROM v2_books WHERE book_id = ?').get(bookId) as
      | { cash_gbp: number }
      | undefined;
    if (row === undefined) throw new Error(`PaperBooks: unknown book ${bookId}`);
    return row.cash_gbp;
  }

  positions(bookId: string): readonly Position[] {
    const rows = this.db
      .prepare(
        `SELECT instrument, venue, qty, avg_price_gbp, stop_gbp, target_gbp, client_order_id,
           exit_client_order_id, opened_date, marks_held
         FROM v2_positions WHERE book_id = ? ORDER BY instrument`,
      )
      .all(bookId) as PositionRow[];
    return rows.map(positionFromRow);
  }

  position(bookId: string, instrument: string): Position | undefined {
    return this.positions(bookId).find((held) => held.instrument === instrument);
  }

  applyFill(bookId: string, fill: BookFill): Position | undefined {
    const signedQty = fill.side === 'buy' ? fill.qty : -fill.qty;
    const apply = this.db.transaction(() => {
      this.#adjustCash(bookId, -(signedQty * fill.priceGbp) - fill.feeGbp);
      const held = this.position(bookId, fill.instrument);
      const qty = (held?.qty ?? 0) + signedQty;
      if (Math.abs(qty) < FLAT_EPSILON) {
        this.#closePosition(bookId, fill.instrument);
        return undefined;
      }
      if (held === undefined) this.#openPosition(bookId, fill, qty);
      else this.#resizePosition(bookId, held, fill, qty);
      return this.position(bookId, fill.instrument);
    });
    return apply();
  }

  #closePosition(bookId: string, instrument: string): void {
    this.db
      .prepare('DELETE FROM v2_positions WHERE book_id = ? AND instrument = ?')
      .run(bookId, instrument);
  }

  #openPosition(bookId: string, fill: BookFill, qty: number): void {
    this.db
      .prepare(
        `INSERT INTO v2_positions (book_id, instrument, venue, qty, avg_price_gbp, stop_gbp, target_gbp,
           client_order_id, exit_client_order_id, opened_date, marks_held, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, ?)`,
      )
      .run(
        bookId,
        fill.instrument,
        fill.venue,
        qty,
        fill.priceGbp,
        fill.stopGbp ?? null,
        fill.targetGbp ?? null,
        fill.clientOrderId,
        fill.tradingDate,
        this.#now(),
      );
  }

  #resizePosition(bookId: string, held: Position, fill: BookFill, qty: number): void {
    this.db
      .prepare(
        `UPDATE v2_positions SET qty = ?, avg_price_gbp = ?, updated_at = ?
         WHERE book_id = ? AND instrument = ?`,
      )
      .run(qty, averagePriceGbp(held, fill, qty), this.#now(), bookId, fill.instrument);
  }

  setExitPending(bookId: string, instrument: string, exitClientOrderId: string): void {
    this.db
      .prepare(
        `UPDATE v2_positions SET exit_client_order_id = ?, updated_at = ?
         WHERE book_id = ? AND instrument = ?`,
      )
      .run(exitClientOrderId, this.#now(), bookId, instrument);
  }

  valuation(bookId: string, markGbp: MarkPriceGbp): Valuation {
    let investedGbp = 0;
    let investedSaxoGbp = 0;
    let positionsGbp = 0;
    for (const held of this.positions(bookId)) {
      const mark = markGbp(held.instrument, held.venue) ?? held.avgPriceGbp;
      positionsGbp += held.qty * mark;
      investedGbp += Math.abs(held.qty * mark);
      if (held.venue === 'saxo') investedSaxoGbp += Math.abs(held.qty * mark);
    }
    return { equityGbp: this.cash(bookId) + positionsGbp, investedGbp, investedSaxoGbp };
  }

  lastDay(bookId: string): BookDay | undefined {
    const row = this.db
      .prepare(
        `SELECT trading_date, equity_gbp, cash_gbp, invested_gbp, ytd_loss_gbp, size_multiplier,
           entries_blocked, custody_accrual_gbp, recorded_at
         FROM v2_book_days WHERE book_id = ? ORDER BY trading_date DESC LIMIT 1`,
      )
      .get(bookId) as BookDayRow | undefined;
    if (row === undefined) return undefined;
    return {
      bookId,
      tradingDate: row.trading_date,
      equityGbp: row.equity_gbp,
      cashGbp: row.cash_gbp,
      investedGbp: row.invested_gbp,
      custodyAccrualGbp: row.custody_accrual_gbp,
      recordedAt: row.recorded_at,
      state: {
        referenceEquityGbp: this.#budget(bookId).referenceEquityGbp,
        ytdLossGbp: row.ytd_loss_gbp,
        sizeMultiplier: row.size_multiplier as LossBudgetState['sizeMultiplier'],
        halted: row.size_multiplier === 0,
        entriesBlockedAtNextFill: row.entries_blocked === 1,
      },
    };
  }

  markDay(
    bookId: string,
    tradingDate: string,
    markGbp: MarkPriceGbp,
    calendarDaysSinceLastMark: number,
  ): BookDay {
    const budget = this.#budget(bookId);
    const previous = this.lastDay(bookId);
    if (previous !== undefined && previous.tradingDate >= tradingDate) {
      throw new Error(
        `PaperBooks: ${bookId} already marked ${previous.tradingDate}, refusing ${tradingDate}`,
      );
    }
    const capital = this.#capitalOn(tradingDate);
    rollYear(
      budget,
      previous === undefined
        ? undefined
        : { trading_date: previous.tradingDate, equity_gbp: previous.equityGbp },
      tradingDate,
    );
    const mark = this.db.transaction((): BookDay => {
      const before = this.valuation(bookId, markGbp);
      const custodyAccrualGbp = saxoCustodyAccrual(
        before.investedSaxoGbp,
        calendarDaysSinceLastMark,
      );
      this.#adjustCash(bookId, -custodyAccrualGbp);
      const equityGbp = before.equityGbp - custodyAccrualGbp;
      const cashGbp = this.cash(bookId);
      const state = budget.markClose(equityGbp, previous?.equityGbp ?? equityGbp, capital);
      const recordedAt = this.#now();
      this.db
        .prepare(
          `INSERT INTO v2_book_days (book_id, trading_date, equity_gbp, cash_gbp, invested_gbp,
             ytd_loss_gbp, size_multiplier, entries_blocked, custody_accrual_gbp, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          bookId,
          tradingDate,
          equityGbp,
          cashGbp,
          before.investedGbp,
          state.ytdLossGbp,
          state.sizeMultiplier,
          state.entriesBlockedAtNextFill ? 1 : 0,
          custodyAccrualGbp,
          recordedAt,
        );
      this.db
        .prepare('UPDATE v2_positions SET marks_held = marks_held + 1 WHERE book_id = ?')
        .run(bookId);
      return {
        bookId,
        tradingDate,
        equityGbp,
        cashGbp,
        investedGbp: before.investedGbp,
        state,
        custodyAccrualGbp,
        recordedAt,
      };
    });
    return mark();
  }

  #adjustCash(bookId: string, deltaGbp: number): void {
    const result = this.db
      .prepare('UPDATE v2_books SET cash_gbp = cash_gbp + ? WHERE book_id = ?')
      .run(deltaGbp, bookId);
    if (result.changes !== 1) throw new Error(`PaperBooks: unknown book ${bookId}`);
  }

  #budget(bookId: string): LossBudget {
    const budget = this.#budgets.get(bookId);
    if (budget === undefined) throw new Error(`PaperBooks: unknown book ${bookId}`);
    return budget;
  }

  #now(): string {
    return toStoredTimestamp(this.clock.now());
  }
}
