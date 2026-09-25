import type { LossBudgetState } from '../../pipeline/momentum/index.js';
import { LossBudget, saxoCustodyAccrual } from '../../pipeline/momentum/index.js';
import type { Clock } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { toStoredTimestamp } from '../../shared/store/index.js';

export type BookVariant =
  | 'primary'
  | 'no-macro-gate'
  | 'no-sentiment'
  | 'no-social'
  | 'large-cap-only'
  | 'no-veto';

export interface BookSpec {
  readonly id: string;
  readonly sleeve: string;
  readonly variant: BookVariant;
  readonly instantiated: boolean;
}

export const BOOK_SPECS: readonly BookSpec[] = [
  { id: 'debate/primary', sleeve: 'debate', variant: 'primary', instantiated: true },
  { id: 'debate/no-macro-gate', sleeve: 'debate', variant: 'no-macro-gate', instantiated: true },
  { id: 'debate/no-sentiment', sleeve: 'debate', variant: 'no-sentiment', instantiated: true },
  { id: 'debate/no-social', sleeve: 'debate', variant: 'no-social', instantiated: true },
  { id: 'debate/large-cap-only', sleeve: 'debate', variant: 'large-cap-only', instantiated: true },
  { id: 'momentum/no-veto', sleeve: 'momentum', variant: 'no-veto', instantiated: false },
];

export const START_CAPITAL_GBP = 1_000;

export interface BookDay {
  readonly bookId: string;
  readonly tradingDate: string;
  readonly equityGbp: number;
  readonly state: LossBudgetState;
  readonly custodyAccrualGbp: number;
}

interface BookDayRow {
  equity_gbp: number;
  ytd_loss_gbp: number;
  size_multiplier: number;
  entries_blocked: number;
  custody_accrual_gbp: number;
}

export class PaperBooks {
  readonly #budgets = new Map<string, LossBudget>();
  readonly #references = new Map<string, number>();
  readonly #specs: readonly BookSpec[];

  constructor(
    private readonly db: StoreHandle,
    private readonly clock: Clock,
    specs: readonly BookSpec[] = BOOK_SPECS,
    private readonly startCapitalGbp: number = START_CAPITAL_GBP,
  ) {
    this.#specs = specs.filter((spec) => spec.instantiated);
    const insert = db.prepare(
      `INSERT OR IGNORE INTO v2_books (book_id, sleeve_id, variant, start_capital_gbp, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const spec of this.#specs) {
      insert.run(spec.id, spec.sleeve, spec.variant, startCapitalGbp, this.#now());
      const budget = new LossBudget(startCapitalGbp);
      this.#budgets.set(spec.id, budget);
      this.#replay(spec.id, budget);
    }
  }

  #replay(bookId: string, budget: LossBudget): void {
    const rows = this.db
      .prepare(
        'SELECT trading_date, equity_gbp FROM v2_book_days WHERE book_id = ? ORDER BY trading_date',
      )
      .all(bookId) as { trading_date: string; equity_gbp: number }[];
    let previous: { trading_date: string; equity_gbp: number } | undefined;
    for (const row of rows) {
      this.#rollYear(bookId, budget, previous, row.trading_date);
      budget.markClose(row.equity_gbp, previous?.equity_gbp ?? row.equity_gbp);
      previous = row;
    }
  }

  #rollYear(
    bookId: string,
    budget: LossBudget,
    previous: { trading_date: string; equity_gbp: number } | undefined,
    tradingDate: string,
  ): void {
    if (previous === undefined || previous.trading_date.slice(0, 4) === tradingDate.slice(0, 4)) {
      return;
    }
    budget.resetYear(previous.equity_gbp);
    this.#references.set(bookId, previous.equity_gbp);
  }

  assertUnmarked(tradingDate: string): void {
    for (const spec of this.#specs) {
      const previous = this.lastDay(spec.id);
      if (previous !== undefined && previous.tradingDate >= tradingDate) {
        throw new Error(
          `PaperBooks: ${spec.id} already marked ${previous.tradingDate}, refusing ${tradingDate}`,
        );
      }
    }
  }

  get startCapital(): number {
    return this.startCapitalGbp;
  }

  ids(): readonly string[] {
    return this.#specs.map((spec) => spec.id);
  }

  forSleeve(sleeveId: string): readonly BookSpec[] {
    return this.#specs.filter((spec) => spec.sleeve === sleeveId);
  }

  lastDay(bookId: string): BookDay | undefined {
    const row = this.db
      .prepare(
        `SELECT trading_date, equity_gbp, ytd_loss_gbp, size_multiplier, entries_blocked, custody_accrual_gbp
         FROM v2_book_days WHERE book_id = ? ORDER BY trading_date DESC LIMIT 1`,
      )
      .get(bookId) as (BookDayRow & { trading_date: string }) | undefined;
    if (row === undefined) return undefined;
    return {
      bookId,
      tradingDate: row.trading_date,
      equityGbp: row.equity_gbp,
      custodyAccrualGbp: row.custody_accrual_gbp,
      state: {
        referenceEquityGbp: this.#references.get(bookId) ?? this.startCapitalGbp,
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
    equityGbp: number,
    investedNotionalGbp: number,
    calendarDaysSinceLastMark: number,
  ): BookDay {
    const budget = this.#budget(bookId);
    const previous = this.lastDay(bookId);
    if (previous !== undefined && previous.tradingDate >= tradingDate) {
      throw new Error(
        `PaperBooks: ${bookId} already marked ${previous.tradingDate}, refusing ${tradingDate}`,
      );
    }
    this.#rollYear(
      bookId,
      budget,
      previous === undefined
        ? undefined
        : { trading_date: previous.tradingDate, equity_gbp: previous.equityGbp },
      tradingDate,
    );
    const custodyAccrualGbp = saxoCustodyAccrual(investedNotionalGbp, calendarDaysSinceLastMark);
    const equityAfterCustody = equityGbp - custodyAccrualGbp;
    const state = budget.markClose(equityAfterCustody, previous?.equityGbp ?? equityAfterCustody);
    this.db
      .prepare(
        `INSERT INTO v2_book_days (book_id, trading_date, equity_gbp, ytd_loss_gbp, size_multiplier,
           entries_blocked, custody_accrual_gbp, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        bookId,
        tradingDate,
        equityAfterCustody,
        state.ytdLossGbp,
        state.sizeMultiplier,
        state.entriesBlockedAtNextFill ? 1 : 0,
        custodyAccrualGbp,
        this.#now(),
      );
    return { bookId, tradingDate, equityGbp: equityAfterCustody, state, custodyAccrualGbp };
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
