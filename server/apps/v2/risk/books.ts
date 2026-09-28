import type {
  BookDay,
  BookFill,
  BookLedger,
  BookSpec,
  CapitalYear,
  FillLeg,
  LossBudgetState,
  MarkPriceGbp,
  Position,
  SizeMultiplier,
  Sleeve,
  SleeveSpec,
  Valuation,
} from '../../../../contracts/index.js';
import { saxoCustodyAccrual } from '../../../pipeline/momentum/index.js';
import type { Clock } from '../../../shared/index.js';
import type { StoreHandle } from '../../../shared/store/index.js';
import { toStoredTimestamp } from '../../../shared/store/index.js';
import { bookSpecsFor, sleeveAllocationGbp, sleeveCapitalYear } from './allocation.js';
import type { CapitalConfigStore } from './capital-config.js';
import { LossBudget } from './loss-budget.js';

const FLAT_EPSILON = 1e-9;

// A sign change, or a flat->nonzero open by a non-entry leg, is a crossing fill (#1778)
function crossedUnexpectedly(leg: FillLeg, beforeQty: number, afterQty: number): boolean {
  const beforeSign = Math.sign(beforeQty);
  const afterSign = Math.sign(afterQty);
  if (beforeSign !== 0 && afterSign !== 0) return beforeSign !== afterSign;
  return beforeSign === 0 && afterSign !== 0 && leg !== 'entry';
}

function sumValues(values: ReadonlyMap<string, number>): number {
  let total = 0;
  for (const value of values.values()) total += value;
  return total;
}

interface AccountMarkRow {
  readonly book_id: string;
  readonly trading_date: string;
  readonly equity_gbp: number;
}

function marksByTradingDate(
  rows: readonly AccountMarkRow[],
): ReadonlyMap<string, readonly AccountMarkRow[]> {
  const byDate = new Map<string, AccountMarkRow[]>();
  for (const row of rows) {
    const marks = byDate.get(row.trading_date);
    if (marks === undefined) byDate.set(row.trading_date, [row]);
    else marks.push(row);
  }
  return byDate;
}

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
  stray: number;
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
    stray: row.stray === 1,
  };
}

function averagePriceGbp(held: Position, fill: BookFill, qty: number): number {
  if (Math.abs(qty) <= Math.abs(held.qty)) return held.avgPriceGbp;
  return (held.avgPriceGbp * Math.abs(held.qty) + fill.priceGbp * fill.qty) / Math.abs(qty);
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
  readonly #budgets = new Map<string, { budget: LossBudget; sleeve: SleeveSpec }>();
  readonly #specs: readonly BookSpec[];
  // Q6/G6: one budget, account-wide, pooling every PRIMARY book's net loss against the full
  // (unshared) yearly cap — the #1825 sleeve-share split still governs each book's own,
  // tighter de-risking ratchet; this is the backstop once more than one primary book trades
  readonly #accountBudget: LossBudget | undefined;
  #accountPreviousDay: { trading_date: string; equity_gbp: number } | undefined;

  constructor(
    private readonly db: StoreHandle,
    private readonly clock: Clock,
    private readonly capital: Pick<CapitalConfigStore, 'inForce' | 'lastKnown'>,
    openingDate: string,
    sleeves: readonly Pick<Sleeve, 'id' | 'spec'>[],
  ) {
    const capitalYear = capital.inForce(openingDate);
    const opened: BookSpec[] = [];
    for (const sleeve of sleeves) {
      const specs = bookSpecsFor([sleeve]).filter((candidate) => candidate.instantiated);
      this.#seed(
        specs,
        capitalYear === undefined ? 0 : sleeveAllocationGbp(sleeve.spec, capitalYear),
      );
      opened.push(...specs.filter((spec) => this.#open(spec.id, sleeve.spec)));
    }
    this.#specs = opened;
    this.#accountBudget = this.#openAccountBudget();
  }

  #primaryIds(): readonly string[] {
    return this.#specs.filter((spec) => spec.variant === 'primary').map((spec) => spec.id);
  }

  #openAccountBudget(): LossBudget | undefined {
    const primaryIds = this.#primaryIds();
    const startCapitalGbp = primaryIds.reduce(
      (total, id) => total + (this.#startCapital(id) ?? 0),
      0,
    );
    if (startCapitalGbp <= 0) return undefined;
    const budget = new LossBudget(startCapitalGbp);
    this.#replayAccount(budget, primaryIds);
    return budget;
  }

  #replayAccount(budget: LossBudget, primaryIds: readonly string[]): void {
    const lastKnown = new Map<string, number>(
      primaryIds.map((id) => [id, this.#startCapital(id) ?? 0]),
    );
    for (const [tradingDate, marks] of marksByTradingDate(this.#accountMarkRows(primaryIds))) {
      for (const mark of marks) lastKnown.set(mark.book_id, mark.equity_gbp);
      this.#advanceAccountBudget(budget, sumValues(lastKnown), tradingDate);
    }
  }

  #accountMarkRows(primaryIds: readonly string[]): readonly AccountMarkRow[] {
    const placeholders = primaryIds.map(() => '?').join(', ');
    return this.db
      .prepare(
        `SELECT book_id, trading_date, equity_gbp FROM v2_book_days
          WHERE book_id IN (${placeholders}) ORDER BY trading_date`,
      )
      .all(...primaryIds) as AccountMarkRow[];
  }

  #accountCapitalOn(tradingDate: string): CapitalYear {
    const capital = this.capital.lastKnown(tradingDate);
    if (capital === undefined) {
      throw new Error(
        `PaperBooks: no capital config on or before ${tradingDate}; set one with npm run v2:capital (doc 66 D8)`,
      );
    }
    return capital;
  }

  #advanceAccountBudget(
    budget: LossBudget,
    equityGbp: number,
    tradingDate: string,
  ): LossBudgetState {
    rollYear(budget, this.#accountPreviousDay, tradingDate);
    const state = budget.markClose(
      equityGbp,
      this.#accountPreviousDay?.equity_gbp ?? equityGbp,
      this.#accountCapitalOn(tradingDate),
    );
    this.#accountPreviousDay = { trading_date: tradingDate, equity_gbp: equityGbp };
    return state;
  }

  settlePrimaryBudgets(tradingDate: string): void {
    const budget = this.#accountBudget;
    if (budget === undefined) return;
    // #accountBudget is only ever set when #primaryIds() was non-empty at construction
    // (#openAccountBudget), and #specs never changes after that, so it still is here
    const days = this.#primaryIds().map((id) => this.#markedDay(id, tradingDate));
    const equityGbp = days.reduce((total, day) => total + day.equityGbp, 0);
    const state = this.#advanceAccountBudget(budget, equityGbp, tradingDate);
    for (const day of days) {
      const effective = Math.min(day.state.sizeMultiplier, state.sizeMultiplier) as SizeMultiplier;
      if (effective !== day.state.sizeMultiplier) {
        this.#setSizeMultiplier(day, tradingDate, effective);
      }
    }
  }

  #markedDay(bookId: string, tradingDate: string): BookDay {
    const day = this.lastDay(bookId);
    if (day === undefined || day.tradingDate !== tradingDate) {
      throw new Error(
        `PaperBooks: settlePrimaryBudgets(${tradingDate}) called before ${bookId} was marked`,
      );
    }
    return day;
  }

  #setSizeMultiplier(day: BookDay, tradingDate: string, sizeMultiplier: SizeMultiplier): void {
    this.db
      .prepare('UPDATE v2_book_days SET size_multiplier = ? WHERE book_id = ? AND trading_date = ?')
      .run(sizeMultiplier, day.bookId, tradingDate);
  }

  #seed(specs: readonly BookSpec[], seedCapitalGbp: number): void {
    if (seedCapitalGbp <= 0) return;
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO v2_books (book_id, sleeve_id, variant, start_capital_gbp, cash_gbp, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const spec of specs) {
      insert.run(spec.id, spec.sleeve, spec.variant, seedCapitalGbp, seedCapitalGbp, this.#now());
    }
  }

  #open(bookId: string, sleeve: SleeveSpec): boolean {
    const startCapitalGbp = this.#startCapital(bookId);
    if (startCapitalGbp === undefined) return false;
    const budget = new LossBudget(startCapitalGbp);
    this.#budgets.set(bookId, { budget, sleeve });
    this.#replay(bookId, budget, sleeve);
    return true;
  }

  #startCapital(bookId: string): number | undefined {
    const row = this.db
      .prepare('SELECT start_capital_gbp FROM v2_books WHERE book_id = ?')
      .get(bookId) as { start_capital_gbp: number } | undefined;
    return row?.start_capital_gbp;
  }

  #replay(bookId: string, budget: LossBudget, sleeve: SleeveSpec): void {
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
        this.#capitalOn(sleeve, row.trading_date),
      );
      previous = row;
    }
  }

  #capitalOn(sleeve: SleeveSpec, tradingDate: string): CapitalYear {
    return sleeveCapitalYear(sleeve, this.#accountCapitalOn(tradingDate));
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
           exit_client_order_id, opened_date, marks_held, stray
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
      } else {
        this.#setPositionQty(bookId, held, fill, qty);
      }
      return this.position(bookId, fill.instrument);
    });
    return apply();
  }

  #setPositionQty(bookId: string, held: Position | undefined, fill: BookFill, qty: number): void {
    if (held !== undefined && Math.sign(held.qty) === Math.sign(qty)) {
      this.#resizePosition(bookId, held, fill, qty);
      return;
    }
    const stray = crossedUnexpectedly(fill.leg, held?.qty ?? 0, qty);
    this.#closePosition(bookId, fill.instrument);
    this.#openPosition(bookId, fill, qty, stray);
  }

  #closePosition(bookId: string, instrument: string): void {
    this.db
      .prepare('DELETE FROM v2_positions WHERE book_id = ? AND instrument = ?')
      .run(bookId, instrument);
  }

  #openPosition(bookId: string, fill: BookFill, qty: number, stray: boolean): void {
    this.db
      .prepare(
        `INSERT INTO v2_positions (book_id, instrument, venue, qty, avg_price_gbp, stop_gbp, target_gbp,
           client_order_id, exit_client_order_id, opened_date, marks_held, stray, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, ?, ?)`,
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
        stray ? 1 : 0,
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

  clearExitPending(bookId: string, instrument: string): void {
    this.db
      .prepare(
        `UPDATE v2_positions SET exit_client_order_id = NULL, updated_at = ?
         WHERE book_id = ? AND instrument = ?`,
      )
      .run(this.#now(), bookId, instrument);
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
        referenceEquityGbp: this.#book(bookId).budget.referenceEquityGbp,
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
    const { budget, sleeve } = this.#book(bookId);
    const previous = this.lastDay(bookId);
    if (previous !== undefined && previous.tradingDate >= tradingDate) {
      throw new Error(
        `PaperBooks: ${bookId} already marked ${previous.tradingDate}, refusing ${tradingDate}`,
      );
    }
    const capital = this.#capitalOn(sleeve, tradingDate);
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

  #book(bookId: string): { budget: LossBudget; sleeve: SleeveSpec } {
    const book = this.#budgets.get(bookId);
    if (book === undefined) throw new Error(`PaperBooks: unknown book ${bookId}`);
    return book;
  }

  #now(): string {
    return toStoredTimestamp(this.clock.now());
  }
}
