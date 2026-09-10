/**
 * The append-only daily equity series (#345, migration `0011`) — the persisted
 * observations a live `ReturnSeries` is derived from.
 *
 * Sibling to `SqliteSessionEquityStore`, not a replacement for it. That store
 * answers "what is the session in force, and what did it open at" for the
 * daily-loss breaker, and overwrites itself every boundary. This one answers
 * "what has equity been, day by day", and never overwrites anything. They share
 * the boundary (`TradingCalendar.sessionStart`, #331) and the writer — see
 * `AlpacaAccountStateProvider` — so the series cannot drift onto a different
 * definition of "a day" than the breaker uses.
 */

import type { StoreHandle } from '../../shared/store/index.js';
import { fromStoredTimestamp, toStoredTimestamp } from '../../shared/store/index.js';

/** One day's equity observation, anchored to the portfolio session it opens. */
export interface DailyEquityObservation {
  /** The UTC-day boundary this observation is anchored to — never the sample time. */
  session_start: Date;
  equity: number;
  /** When the sample was actually taken. `> session_start` by up to one tick interval. */
  recorded_at: Date;
  /**
   * Was the writing process running when this session opened? `false` means the
   * equity was sampled inside the session rather than at its start (a fresh
   * store, or a restart after the boundary had passed). Durable rather than
   * in-process for the reason migration 0009 gives: after a restart nothing
   * about the row itself reveals a late sample.
   */
  observed_at_boundary: boolean;
}

interface DailyEquityRow {
  session_start: string;
  equity: number;
  recorded_at: string;
  observed_at_boundary: number;
}

export class SqliteDailyEquityStore {
  constructor(private readonly db: StoreHandle) {}

  /**
   * Records `equity` as the observation for the session opening at
   * `sessionStart`, if that session has no observation yet.
   *
   * **First write wins — `DO NOTHING`, never `DO UPDATE`.** The sample is taken
   * on the first tick after the boundary, so the first observation is the
   * closest one to the true open; every later tick inside the same session must
   * leave it alone or the series would drift forward all day and stop being a
   * daily open at all. It is also what makes a restart harmless: the returning
   * process finds the row and does not clobber a genuine open with a
   * mid-session figure.
   *
   * Non-finite equity is refused rather than stored, the same guard
   * `SqliteSessionEquityStore.put` applies: a `NaN` in the series propagates
   * through the mean and the standard deviation into every ratio in the suite,
   * and `NaN` compares false against every kill threshold — so the kill-lines
   * would silently stop firing rather than fail.
   */
  append(sessionStart: Date, equity: number, recordedAt: Date, observedAtBoundary: boolean): void {
    if (!Number.isFinite(equity)) {
      throw new Error(
        `SqliteDailyEquityStore.append: equity must be finite, got ${equity} for session ` +
          `${sessionStart.toISOString()}. Refusing to write a non-numeric observation into the ` +
          'return series the kill-lines are computed from.',
      );
    }

    this.db
      .prepare(
        `INSERT INTO daily_equity (session_start, equity, recorded_at, observed_at_boundary)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(session_start) DO NOTHING`,
      )
      .run(
        toStoredTimestamp(sessionStart),
        equity,
        toStoredTimestamp(recordedAt),
        observedAtBoundary ? 1 : 0,
      );
  }

  /**
   * Every observation, oldest first.
   *
   * `ORDER BY session_start` is a TEXT sort, chronological only because every
   * value is written through `toStoredTimestamp` — fixed-width, zero-padded,
   * Z-suffixed. Ascending order is not a convenience: the reader detects gaps by
   * differencing adjacent rows, and an unsorted read would manufacture spacing
   * violations out of nothing.
   */
  all(): DailyEquityObservation[] {
    const rows = this.db
      .prepare(
        `SELECT session_start, equity, recorded_at, observed_at_boundary
           FROM daily_equity
          ORDER BY session_start`,
      )
      .all() as DailyEquityRow[];

    return rows.map((row) => ({
      session_start: fromStoredTimestamp(row.session_start),
      equity: row.equity,
      recorded_at: fromStoredTimestamp(row.recorded_at),
      observed_at_boundary: row.observed_at_boundary === 1,
    }));
  }
}
