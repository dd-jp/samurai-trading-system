import type { Clock } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { addDays, type EodhdExchange } from './data/index.js';
import type { SplitVerdict, SplitWindow } from './split-crosscheck.js';

export interface SplitRequest {
  readonly instrument: string;
  readonly exchange: EodhdExchange;
  readonly after: string;
}

export interface SplitCheck {
  readonly tradingDate: string;
  readonly instrument: string;
  readonly exchange: EodhdExchange;
  readonly window: SplitWindow;
  readonly verdict: 'agree' | 'block';
  readonly reason: string;
  readonly ratio: number;
}

export interface SplitBlock {
  readonly after: string;
  readonly reason: string;
  readonly since: string;
}

export interface SplitCheckLedger {
  record(check: SplitCheck): void;
  block(instrument: string, exchange: EodhdExchange, tradingDate: string): SplitBlock | undefined;
  carried(tradingDate: string): readonly SplitRequest[];
}

export function checkOf(
  base: Omit<SplitCheck, 'verdict' | 'reason' | 'ratio'>,
  verdict: SplitVerdict,
): SplitCheck {
  return verdict.kind === 'block'
    ? { ...base, verdict: 'block', reason: verdict.reason, ratio: 1 }
    : { ...base, verdict: 'agree', reason: 'agree', ratio: verdict.reading.ratio };
}

interface CheckRow {
  trading_date: string;
  after_date: string;
  verdict: 'agree' | 'block';
  reason: string;
  recorded_at: string;
}

interface Episode {
  readonly start: CheckRow;
  readonly last: CheckRow;
}

function byDate(rows: readonly CheckRow[]): Map<string, CheckRow[]> {
  const days = new Map<string, CheckRow[]>();
  for (const row of rows) days.set(row.trading_date, [...(days.get(row.trading_date) ?? []), row]);
  return days;
}

// A day with any blocking check blocks; the first day on which every check agrees ends the episode
export function openEpisode(rows: readonly CheckRow[]): Episode | undefined {
  let episode: Episode | undefined;
  for (const day of byDate(rows).values()) {
    const blocks = day.filter((row) => row.verdict === 'block');
    const [first] = blocks;
    episode =
      first === undefined
        ? undefined
        : { start: episode?.start ?? first, last: blocks.at(-1) as CheckRow };
  }
  return episode;
}

export class SqliteSplitChecks implements SplitCheckLedger {
  constructor(
    private readonly db: StoreHandle,
    private readonly clock: Clock,
  ) {}

  record(check: SplitCheck): void {
    this.db
      .prepare(
        `INSERT INTO v2_split_checks (trading_date, instrument, exchange, after_date, through_date,
           verdict, reason, ratio, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        check.tradingDate,
        check.instrument,
        check.exchange,
        check.window.after,
        check.window.through,
        check.verdict,
        check.reason,
        check.ratio,
        this.clock.now().toISOString(),
      );
  }

  clear(instrument: string, exchange: EodhdExchange, reason: string): void {
    this.db
      .prepare(
        'INSERT INTO v2_split_clears (instrument, exchange, reason, cleared_at) VALUES (?, ?, ?, ?)',
      )
      .run(instrument, exchange, reason, this.clock.now().toISOString());
  }

  #episode(instrument: string, exchange: EodhdExchange, through: string): Episode | undefined {
    const rows = this.db
      .prepare(
        `SELECT trading_date, after_date, verdict, reason, recorded_at FROM v2_split_checks
         WHERE instrument = ? AND exchange = ? AND trading_date <= ?
         ORDER BY trading_date, check_id`,
      )
      .all(instrument, exchange, through) as CheckRow[];
    return openEpisode(rows);
  }

  #cleared(instrument: string, exchange: EodhdExchange, since: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM v2_split_clears
           WHERE instrument = ? AND exchange = ? AND cleared_at >= ? LIMIT 1`,
        )
        .get(instrument, exchange, since) !== undefined
    );
  }

  block(instrument: string, exchange: EodhdExchange, tradingDate: string): SplitBlock | undefined {
    const episode = this.#episode(instrument, exchange, tradingDate);
    if (episode === undefined) return undefined;
    if (this.#cleared(instrument, exchange, episode.start.recorded_at)) return undefined;
    return {
      after: episode.last.after_date,
      reason: episode.last.reason,
      since: episode.start.trading_date,
    };
  }

  carried(tradingDate: string): readonly SplitRequest[] {
    const blocked = this.db
      .prepare(
        `SELECT DISTINCT instrument, exchange FROM v2_split_checks
         WHERE verdict = 'block' AND trading_date < ? ORDER BY instrument, exchange`,
      )
      .all(tradingDate) as { instrument: string; exchange: EodhdExchange }[];
    const requests: SplitRequest[] = [];
    for (const { instrument, exchange } of blocked) {
      const episode = this.#episode(instrument, exchange, addDays(tradingDate, -1));
      if (episode !== undefined) {
        requests.push({ instrument, exchange, after: episode.last.after_date });
      }
    }
    return requests;
  }
}
