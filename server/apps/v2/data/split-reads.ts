import type { StoreHandle } from '../../../shared/store/index.js';
import type { EodhdSplit, SplitsRead, SplitsWindow } from './eodhd-client.js';

export type SplitSourceName = 'eodhd' | 'alpaca';

export interface FailedSplitsRead extends SplitsWindow {
  readonly symbol: string;
  readonly reason: string;
}

interface SplitReadRow {
  symbol: string;
  from_date: string;
  to_date: string;
  as_of: string;
  splits: string;
}

function readOf(row: SplitReadRow): SplitsRead {
  return {
    symbol: row.symbol,
    from: row.from_date,
    to: row.to_date,
    asOf: row.as_of,
    splits: JSON.parse(row.splits) as EodhdSplit[],
  };
}

export class SqliteSplitReads {
  constructor(private readonly db: StoreHandle) {}

  recordRead(tradingDate: string, source: SplitSourceName, read: SplitsRead, at: Date): void {
    this.#insert(tradingDate, source, read, {
      asOf: read.asOf,
      status: 'ok',
      reason: '',
      splits: JSON.stringify(read.splits),
      at,
    });
  }

  recordFailure(
    tradingDate: string,
    source: SplitSourceName,
    failed: FailedSplitsRead,
    at: Date,
  ): void {
    this.#insert(tradingDate, source, failed, {
      asOf: null,
      status: 'error',
      reason: failed.reason,
      splits: '[]',
      at,
    });
  }

  #insert(
    tradingDate: string,
    source: SplitSourceName,
    window: SplitsWindow & { readonly symbol: string },
    row: {
      readonly asOf: string | null;
      readonly status: 'ok' | 'error';
      readonly reason: string;
      readonly splits: string;
      readonly at: Date;
    },
  ): void {
    this.db
      .prepare(
        `INSERT INTO v2_split_reads (trading_date, source, symbol, from_date, to_date, as_of,
           status, reason, splits, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        tradingDate,
        source,
        window.symbol,
        window.from,
        window.to,
        row.asOf,
        row.status,
        row.reason,
        row.splits,
        row.at.toISOString(),
      );
  }

  reads(source: SplitSourceName, symbol: string, tradingDate: string): SplitsRead[] {
    const rows = this.db
      .prepare(
        `SELECT symbol, from_date, to_date, as_of, splits FROM v2_split_reads
         WHERE trading_date = ? AND source = ? AND symbol = ? AND status = 'ok'
         ORDER BY read_id`,
      )
      .all(tradingDate, source, symbol) as SplitReadRow[];
    return rows.map(readOf);
  }

  covered(source: SplitSourceName, symbol: string, tradingDate: string, from: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM v2_split_reads
           WHERE trading_date = ? AND source = ? AND symbol = ? AND status = 'ok' AND from_date <= ?
           LIMIT 1`,
        )
        .get(tradingDate, source, symbol, from) !== undefined
    );
  }

  anyOn(tradingDate: string): boolean {
    return (
      this.db
        .prepare('SELECT 1 FROM v2_split_reads WHERE trading_date = ? LIMIT 1')
        .get(tradingDate) !== undefined
    );
  }
}
