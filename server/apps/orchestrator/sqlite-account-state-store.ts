
import type { StoreHandle } from '../../shared/store/index.js';
import { toStoredTimestamp } from '../../shared/store/index.js';

const SINGLETON_KEY = 'default';

export const CONTROL_BOOK_ANCHOR_KEY = 'control_book_anchor';

interface AccountStateRow {
  peak_equity: number;
}

export class SqliteAccountStateStore {
  constructor(
    private readonly db: StoreHandle,
    private readonly key: string = SINGLETON_KEY,
  ) {}

  anchorEquity(equity: number, asOf: Date): number {
    if (!Number.isFinite(equity)) {
      throw new Error(
        `SqliteAccountStateStore.anchorEquity: equity must be finite, got ${equity}. ` +
          'Refusing to anchor a book the control arm would then size a fraction of.',
      );
    }

    this.db
      .prepare(
        `INSERT INTO account_state (key, peak_equity, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO NOTHING`,
      )
      .run(this.key, equity, toStoredTimestamp(asOf));

    return this.peakEquity() ?? equity;
  }

  recordEquity(equity: number, asOf: Date): number {
    if (!Number.isFinite(equity)) {
      throw new Error(
        `SqliteAccountStateStore.recordEquity: equity must be finite, got ${equity}. ` +
          'Refusing to write a non-numeric high-water mark the drawdown breaker divides by.',
      );
    }

    this.db
      .prepare(
        `INSERT INTO account_state (key, peak_equity, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           peak_equity = MAX(account_state.peak_equity, excluded.peak_equity),
           updated_at = excluded.updated_at`,
      )
      .run(this.key, equity, toStoredTimestamp(asOf));

    return this.peakEquity() ?? equity;
  }

  peakEquity(): number | null {
    const row = this.db
      .prepare('SELECT peak_equity FROM account_state WHERE key = ?')
      .get(this.key) as AccountStateRow | undefined;

    return row === undefined ? null : row.peak_equity;
  }
}
