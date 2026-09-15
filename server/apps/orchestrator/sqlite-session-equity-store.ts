/**
 * Durable per-asset-class session-open equity snapshots (#332, migration
 * `0009`) — the denominator of risk-manager-spec.md's session-scoped
 * `daily_pnl_pct`, plus the realized-PnL numerator read that shares its
 * boundary.
 *
 * Exists because Alpaca's `GET /v2/account` carries one blended `last_equity`
 * for a portfolio with two session boundaries, on a reset boundary never
 * verified against a live account (GAP-8, cross-verify 2026-07-31). The
 * boundary is now this system's own (`TradingCalendar.sessionStart`, #331) and
 * the snapshot is local.
 */

import type { StoreHandle } from '../../shared/store/index.js';
import { fromStoredTimestamp, toStoredTimestamp } from '../../shared/store/index.js';

/** The three snapshot keys: two asset classes plus the portfolio-level figure */
export type SessionEquityKey = 'crypto' | 'stocks' | 'portfolio';

export interface SessionEquitySnapshot {
  open_equity: number;
  /** The session start instant this snapshot is anchored to — never the write time */
  open_at: Date;
  /**
   * Was the writing process running when this session opened?
   *
   * `false` means the equity was sampled somewhere inside the session rather
   * than at its start, so it is a mid-session base and not a true open. The
   * flag is durable because a restart cannot otherwise tell the two apart —
   * see the migration comment.
   */
  observed_at_boundary: boolean;
}

interface SessionEquityRow {
  open_equity: number;
  open_at: string;
  observed_at_boundary: number;
}

interface RealizedRow {
  realized: number | null;
}

export class SqliteSessionEquityStore {
  constructor(private readonly db: StoreHandle) {}

  /** The stored snapshot for `key`, or null before one has ever been written */
  get(key: SessionEquityKey): SessionEquitySnapshot | null {
    const row = this.db
      .prepare(
        'SELECT open_equity, open_at, observed_at_boundary FROM session_equity WHERE asset_class = ?',
      )
      .get(key) as SessionEquityRow | undefined;

    if (row === undefined) return null;

    return {
      open_equity: row.open_equity,
      open_at: fromStoredTimestamp(row.open_at),
      observed_at_boundary: row.observed_at_boundary === 1,
    };
  }

  /**
   * Writes `equity` as the snapshot for `key`, anchored at `sessionStart`.
   *
   * `open_at` is the session start instant, NOT the moment of the write. The
   * write happens at the first tick *after* the boundary — historical `cash` is
   * stored nowhere, so the equity at the exact boundary cannot be
   * reconstructed. Recording the boundary keeps that drift legible in the data
   * instead of baking an arbitrary observation time in as if it were the open.
   */
  put(
    key: SessionEquityKey,
    equity: number,
    sessionStart: Date,
    observedAtBoundary: boolean,
  ): void {
    if (!Number.isFinite(equity)) {
      throw new Error(
        `SqliteSessionEquityStore.put: open_equity must be finite, got ${equity} for '${key}'. ` +
          'Refusing to write a non-numeric denominator for the daily-loss breaker.',
      );
    }

    this.db
      .prepare(
        `INSERT INTO session_equity (asset_class, open_equity, open_at, observed_at_boundary)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(asset_class) DO UPDATE SET
           open_equity = excluded.open_equity,
           open_at = excluded.open_at,
           observed_at_boundary = excluded.observed_at_boundary`,
      )
      .run(key, equity, toStoredTimestamp(sessionStart), observedAtBoundary ? 1 : 0);
  }

  /**
   * Realized PnL net of fees for one asset class, strictly after `openAt`.
   *
   * `closed_at > ?` is a TEXT comparison, correct only because both sides are
   * ISO-8601 UTC via `toStoredTimestamp` — fixed-width, zero-padded, `Z`-suffixed,
   * so lexical order is chronological order. `closed_trades.closed_at` is
   * written that way by `SqliteExecutionStore.writeClosedTrade`, and `open_at`
   * by `put` above. Strict `>` matches the half-open session convention: a
   * trade closing exactly at the boundary belongs to the new session's open,
   * not to the session just ended.
   *
   * `COALESCE` because `SUM` over zero rows is SQL NULL — a fresh session with
   * no closes yet has realized PnL of exactly 0, not "unknown".
   *
   * `arm = 'live'` is load-bearing (#753). This sum is the `daily_basis`
   * numerator, and `daily_basis` is what the drawdown circuit breaker trips on
   * for the arm that trades real capital. Falsifier arm 2's lots land in the
   * same `closed_trades` table; unfiltered, a control-arm loss would tighten the
   * live breaker and a control-arm gain would loosen it — the measurement
   * changing the thing it measures, which is the exact failure the control arm's
   * separate `CircuitBreakers` instance exists to prevent. Separating the
   * breaker instance is not enough if both instances read one equity basis.
   */
  realizedSince(assetClass: 'crypto' | 'stocks', openAt: Date): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(realized_pnl_net), 0) AS realized
           FROM closed_trades
          WHERE arm = 'live' AND asset_class = ? AND closed_at > ?`,
      )
      .get(assetClass, toStoredTimestamp(openAt)) as RealizedRow | undefined;

    return row?.realized ?? 0;
  }

  /**
   * As `realizedSince`, across every asset class — the portfolio-level numerator.
   * Scoped to `arm = 'live'` for the reason given above (#753).
   */
  realizedSinceAllClasses(openAt: Date): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(realized_pnl_net), 0) AS realized
           FROM closed_trades
          WHERE arm = 'live' AND closed_at > ?`,
      )
      .get(toStoredTimestamp(openAt)) as RealizedRow | undefined;

    return row?.realized ?? 0;
  }
}
