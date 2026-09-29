import type { StoreHandle } from '../../../shared/store/index.js';

export const NEWS_STATUSES = ['ok', 'no_news', 'error', 'budget_stop', 'no_key'] as const;
export type NewsStatus = (typeof NEWS_STATUSES)[number];

export interface StoredHeadline {
  readonly title: string;
  readonly publishedAt: string;
}

export interface NewsRecord {
  readonly tradingDate: string;
  readonly symbol: string;
  readonly provider: string;
  readonly status: NewsStatus;
  readonly reason: string;
  readonly requested: boolean;
  readonly found: number | undefined;
  readonly headlines: readonly StoredHeadline[];
  readonly fetchedAt: string;
}

export interface NewsUsage {
  readonly requests: number;
  readonly quotaRefused: boolean;
}

export interface NewsLedger {
  cached(tradingDate: string, symbol: string): NewsRecord | undefined;
  usageSince(provider: string, since: string): NewsUsage;
  record(record: NewsRecord): void;
  forDate(tradingDate: string): readonly NewsRecord[];
}

interface NewsRow {
  trading_date: string;
  symbol: string;
  provider: string;
  status: NewsStatus;
  reason: string;
  requested: number;
  found: number | null;
  headlines: string;
  fetched_at: string;
}

const QUOTA_REFUSAL_REASONS = ['http_402'];

function fromRow(row: NewsRow): NewsRecord {
  return {
    tradingDate: row.trading_date,
    symbol: row.symbol,
    provider: row.provider,
    status: row.status,
    reason: row.reason,
    requested: row.requested === 1,
    found: row.found ?? undefined,
    headlines: JSON.parse(row.headlines) as StoredHeadline[],
    fetchedAt: row.fetched_at,
  };
}

export class SqliteNewsLedger implements NewsLedger {
  constructor(private readonly db: StoreHandle) {}

  cached(tradingDate: string, symbol: string): NewsRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM v2_news
         WHERE trading_date = ? AND symbol = ? AND status IN ('ok', 'no_news') AND requested = 1
         ORDER BY news_id DESC LIMIT 1`,
      )
      .get(tradingDate, symbol) as NewsRow | undefined;
    return row === undefined ? undefined : fromRow(row);
  }

  usageSince(provider: string, since: string): NewsUsage {
    const marks = QUOTA_REFUSAL_REASONS.map(() => '?').join(', ');
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS requests,
                COALESCE(SUM(reason IN (${marks})), 0) AS refused
         FROM v2_news WHERE provider = ? AND requested = 1 AND fetched_at >= ?`,
      )
      .get(...QUOTA_REFUSAL_REASONS, provider, since) as { requests: number; refused: number };
    return { requests: row.requests, quotaRefused: row.refused > 0 };
  }

  record(record: NewsRecord): void {
    this.db
      .prepare(
        `INSERT INTO v2_news (trading_date, symbol, provider, status, reason, requested, found,
           headlines, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.tradingDate,
        record.symbol,
        record.provider,
        record.status,
        record.reason,
        record.requested ? 1 : 0,
        record.found ?? null,
        JSON.stringify(record.headlines),
        record.fetchedAt,
      );
  }

  forDate(tradingDate: string): readonly NewsRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM v2_news WHERE trading_date = ? ORDER BY news_id')
      .all(tradingDate) as NewsRow[];
    return rows.map(fromRow);
  }
}
