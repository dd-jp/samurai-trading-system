import type { StoreHandle } from '../../../shared/store/index.js';
import type { DividendsRead, EodhdDividend, SplitsWindow } from './eodhd-client.js';

export type DividendReadPurpose = 'cycle' | 'history';

export interface FailedDividendsRead extends SplitsWindow {
  readonly symbol: string;
  readonly reason: string;
}

interface DividendReadRow {
  symbol: string;
  from_date: string;
  to_date: string;
  as_of: string;
  dividends: string;
}

function readOf(row: DividendReadRow): DividendsRead {
  return {
    symbol: row.symbol,
    from: row.from_date,
    to: row.to_date,
    asOf: row.as_of,
    dividends: JSON.parse(row.dividends) as EodhdDividend[],
  };
}

const OK_READS = `SELECT symbol, from_date, to_date, as_of, dividends FROM v2_dividend_reads
  WHERE purpose = @purpose AND symbol = @symbol AND status = 'ok'`;

export class SqliteDividendReads {
  constructor(private readonly db: StoreHandle) {}

  recordRead(
    purpose: DividendReadPurpose,
    tradingDate: string,
    read: DividendsRead,
    at: Date,
  ): void {
    this.#insert(purpose, tradingDate, read, {
      asOf: read.asOf,
      status: 'ok',
      reason: '',
      dividends: JSON.stringify(read.dividends),
      at,
    });
  }

  recordFailure(
    purpose: DividendReadPurpose,
    tradingDate: string,
    failed: FailedDividendsRead,
    at: Date,
  ): void {
    this.#insert(purpose, tradingDate, failed, {
      asOf: null,
      status: 'error',
      reason: failed.reason,
      dividends: '[]',
      at,
    });
  }

  #insert(
    purpose: DividendReadPurpose,
    tradingDate: string,
    window: SplitsWindow & { readonly symbol: string },
    row: {
      readonly asOf: string | null;
      readonly status: 'ok' | 'error';
      readonly reason: string;
      readonly dividends: string;
      readonly at: Date;
    },
  ): void {
    this.db
      .prepare(
        `INSERT INTO v2_dividend_reads (purpose, trading_date, symbol, from_date, to_date, as_of,
           status, reason, dividends, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        purpose,
        tradingDate,
        window.symbol,
        window.from,
        window.to,
        row.asOf,
        row.status,
        row.reason,
        row.dividends,
        row.at.toISOString(),
      );
  }

  cycleReads(symbol: string, tradingDate: string): DividendsRead[] {
    const rows = this.db
      .prepare(`${OK_READS} AND trading_date = @tradingDate ORDER BY read_id`)
      .all({ purpose: 'cycle', symbol, tradingDate }) as DividendReadRow[];
    return rows.map(readOf);
  }

  historyReads(symbol: string): DividendsRead[] {
    const rows = this.db
      .prepare(`${OK_READS} ORDER BY read_id`)
      .all({ purpose: 'history', symbol }) as DividendReadRow[];
    return rows.map(readOf);
  }

  anyCycleReadOn(tradingDate: string): boolean {
    return (
      this.db
        .prepare(
          "SELECT 1 FROM v2_dividend_reads WHERE purpose = 'cycle' AND trading_date = ? LIMIT 1",
        )
        .get(tradingDate) !== undefined
    );
  }
}
