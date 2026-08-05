/**
 * `SqliteQueryStore` — the real SQLite-backed `DashboardQueryStore` (#161),
 * replacing `InMemoryQueryStore` (fixture-store.ts) as the port's production
 * implementation. See docs/specs/dashboard-spec.md ("Module: Query Store")
 * and docs/specs/shared-sqlite-store-spec.md ("Consolidated Schema", #193).
 *
 * Read-only by construction — every method is a plain `SELECT` against
 * tables owned and written by other components (Execution, Debate Engine,
 * Verdict, Feedback Loop, Market Data Service, Orchestrator). This store
 * never writes.
 *
 * Timestamp convention carried from `SqliteExecutionStore` /
 * `SqliteDebateLogStore`: ISO-8601 UTC TEXT columns, lexicographically
 * comparable because every writer uses `Date.toISOString()`. `asOf`
 * filtering below (`WHERE ... <= ?`) relies on that.
 *
 * Two `MetricsSuite` fields (`profit_factor`, `expectancy`) are honestly
 * derivable from `closed_trades` alone. The other eight (`sharpe`, `sortino`,
 * `calmar`, `max_drawdown`, `skew`, `kurtosis`, `turnover`, `exposure`) are
 * defined over a periodic-returns / capital series (see
 * `cost-model-backtest/metrics.ts`) that no table in the current schema
 * carries — there is no equity-curve or account-capital history anywhere in
 * shared-sqlite-store-spec.md's sixteen tables. Synthesizing one from
 * per-trade PnL would produce numbers that look plausible and are not
 * meaningful (uneven spacing, no capital base) — on a live-money operator
 * surface that is worse than a visible gap. Those fields are returned as `0`
 * with this comment as the paper trail; a follow-on ticket adding an
 * equity-curve table is the honest fix, not attempted here.
 */

import type { MetricsSuite } from '../cost-model-backtest/index.js';
import type { AnalystContribution, Direction } from '../debate-engine/index.js';
import { creditForContribution, realizedR } from '../feedback-loop/index.js';
import type { Mark } from '../market-data-service/index.js';
import type { AssetClass, TickStage } from '../orchestrator/index.js';
import type { ClosedTrade, DebateLog, OpenPosition, OrderState } from '../shared/index.js';
import type { SharedStore } from '../shared/store/index.js';
import type {
  AttributionSummary,
  DashboardQueryStore,
  LlmSpendSummary,
  LlmSpendWindow,
  TickStatus,
  VerdictAuditEntry,
} from './types.js';

/** Mirrors execution-spec.md / SqliteExecutionStore's terminal-state exclusion. */
const TERMINAL_STATES: readonly OrderState[] = ['closed', 'cancelled', 'rejected', 'expired'];

/** No shadow-credit bonus for the dashboard's display figure — that boost is FL's
 * tuning-specific policy (feedback-loop-spec.md), not a general "how right was this
 * analyst" number. Reusing `creditForContribution` with it zeroed gives the same
 * influence-weighted correctness term FL uses, without importing FL's tuning knobs. */
const DISPLAY_CREDIT_CONFIG = { shadow_credit: 0, shadow_influence_ceiling: 0 };

interface OpenPositionRow {
  idempotency_key: string;
  debate_id: string;
  instrument: string;
  asset_class: AssetClass;
  side: 'buy' | 'sell';
  intent_type: 'entry' | 'scale_in';
  requested_size: number;
  filled_size: number;
  avg_entry_price: number;
  stop: number;
  target: number;
  order_state: OrderState;
  broker_order_ids: string;
  opened_at: string;
  decision_timestamp: string;
  conviction: number;
  converged: 0 | 1;
}

interface DebateLogRow {
  debate_id: string;
  instrument: string;
  bar_timestamp: string;
  contributions_json: string;
  direction: Direction;
  rounds: number;
  created_at: string;
}

interface VerdictLogRow {
  trace_id: string;
  instrument: string;
  status: 'go' | 'no_go';
  no_go_reason: string | null;
  hitl_override: number;
  timestamp: string;
}

interface AnalystWeightRow {
  analyst_id: string;
  weight: number;
}

interface LatestMarkRow {
  instrument: string;
  price: number;
  observed_at: string;
  asset_class: AssetClass;
  source: string;
}

interface CurrentTickRow {
  instrument: string;
  asset_class: AssetClass;
  stage: TickStage;
  trace_id: string;
}

interface ClosedTradeRow {
  idempotency_key: string;
  debate_id: string;
  instrument: string;
  asset_class: AssetClass;
  side: 'buy' | 'sell';
  entry: number;
  stop: number;
  filled_size: number;
  realized_pnl_net: number;
  fees_total: number;
  opened_at: string;
  closed_at: string;
  close_reason: 'stop' | 'target' | 'exit';
}

/** `closed_trades` joined with its `debate_log` row, for `getAttribution`'s single-query read. */
interface AttributionRow extends ClosedTradeRow {
  debate_contributions_json: string;
}

function fromOpenPositionRow(row: OpenPositionRow): OpenPosition {
  return {
    idempotency_key: row.idempotency_key,
    debate_id: row.debate_id,
    instrument: row.instrument,
    asset_class: row.asset_class,
    side: row.side,
    intent_type: row.intent_type,
    requested_size: row.requested_size,
    filled_size: row.filled_size,
    avg_entry_price: row.avg_entry_price,
    stop: row.stop,
    target: row.target,
    order_state: row.order_state,
    broker_order_ids: JSON.parse(row.broker_order_ids) as string[],
    opened_at: new Date(row.opened_at),
    decision_timestamp: new Date(row.decision_timestamp),
    conviction: row.conviction,
    converged: row.converged === 1,
  };
}

function fromDebateLogRow(row: DebateLogRow): DebateLog {
  return {
    debate_id: row.debate_id,
    instrument: row.instrument,
    bar_timestamp: new Date(row.bar_timestamp),
    contributions: JSON.parse(row.contributions_json) as AnalystContribution[],
    direction: row.direction,
    rounds: row.rounds,
    created_at: new Date(row.created_at),
  };
}

function fromVerdictLogRow(row: VerdictLogRow): VerdictAuditEntry {
  return {
    trace_id: row.trace_id,
    instrument: row.instrument,
    status: row.status,
    reason: row.no_go_reason ?? 'approved',
    hitl_override: row.hitl_override !== 0,
    timestamp: new Date(row.timestamp),
  };
}

function fromClosedTradeRow(row: ClosedTradeRow): ClosedTrade {
  return {
    idempotency_key: row.idempotency_key,
    debate_id: row.debate_id,
    instrument: row.instrument,
    asset_class: row.asset_class,
    side: row.side,
    entry: row.entry,
    stop: row.stop,
    filled_size: row.filled_size,
    realized_pnl_net: row.realized_pnl_net,
    fees_total: row.fees_total,
    opened_at: new Date(row.opened_at),
    closed_at: new Date(row.closed_at),
    close_reason: row.close_reason,
  };
}

const ZERO_METRICS: Omit<MetricsSuite, 'profit_factor' | 'expectancy'> = {
  sharpe: 0,
  sortino: 0,
  calmar: 0,
  max_drawdown: 0,
  skew: 0,
  kurtosis: 0,
  turnover: 0,
  exposure: 0,
};

export class SqliteQueryStore implements DashboardQueryStore {
  /** How far back `getAttribution` looks for closed trades. No home in the schema
   * (`attribution_window_ms` is a `FeedbackConfig` field, not a persisted value) —
   * taken as a constructor option, defaulting to the fixture's 30 days. */
  constructor(
    private readonly db: SharedStore,
    private readonly attributionWindowDays = 30,
  ) {}

  getOpenPositions(asOf: Date): OpenPosition[] {
    const placeholders = TERMINAL_STATES.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT * FROM open_positions
          WHERE order_state NOT IN (${placeholders}) AND opened_at <= ?
          ORDER BY opened_at`,
      )
      .all(...TERMINAL_STATES, asOf.toISOString()) as OpenPositionRow[];
    return rows.map(fromOpenPositionRow);
  }

  getRecentDebates(limit: number, asOf: Date): DebateLog[] {
    const rows = this.db
      .prepare(`SELECT * FROM debate_log WHERE created_at <= ? ORDER BY created_at DESC LIMIT ?`)
      .all(asOf.toISOString(), limit) as DebateLogRow[];
    return rows.map(fromDebateLogRow);
  }

  getTickStatus(asOf: Date): TickStatus | null {
    const row = this.db
      .prepare(
        `SELECT instrument, asset_class, stage, trace_id FROM current_tick
          WHERE updated_at <= ? ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(asOf.toISOString()) as CurrentTickRow | undefined;
    if (row === undefined) {
      return null;
    }
    return {
      instrument: row.instrument,
      asset_class: row.asset_class,
      stage: row.stage,
      trace_id: row.trace_id,
    };
  }

  getVerdictHistory(limit: number, asOf: Date): VerdictAuditEntry[] {
    const rows = this.db
      .prepare(`SELECT * FROM verdict_log WHERE timestamp <= ? ORDER BY timestamp DESC LIMIT ?`)
      .all(asOf.toISOString(), limit) as VerdictLogRow[];
    return rows.map(fromVerdictLogRow);
  }

  getAnalystWeights(asOf: Date): Record<string, number> {
    const rows = this.db
      .prepare(`SELECT analyst_id, weight FROM analyst_weights WHERE updated_at <= ?`)
      .all(asOf.toISOString()) as AnalystWeightRow[];
    const weights: Record<string, number> = {};
    for (const row of rows) {
      weights[row.analyst_id] = row.weight;
    }
    return weights;
  }

  /**
   * One joined query rather than a per-trade `debate_log` lookup: a trade
   * with no matching debate row is excluded by the `JOIN` itself (same
   * "skip, don't zero-attribute" behaviour as a missing row would give),
   * so no post-filter is needed.
   */
  getAttribution(asOf: Date): Record<string, AttributionSummary> {
    const from = new Date(asOf.getTime() - this.attributionWindowDays * 24 * 60 * 60 * 1000);
    const rows = this.db
      .prepare(
        `SELECT closed_trades.*, debate_log.contributions_json AS debate_contributions_json
           FROM closed_trades
           JOIN debate_log ON debate_log.debate_id = closed_trades.debate_id
          WHERE closed_trades.closed_at > ? AND closed_trades.closed_at <= ?`,
      )
      .all(from.toISOString(), asOf.toISOString()) as AttributionRow[];

    const rollingR = new Map<string, number>();
    for (const row of rows) {
      const trade = fromClosedTradeRow(row);
      const r = realizedR(trade);
      if (r === null) {
        continue;
      }
      const direction = trade.side === 'buy' ? 'bullish' : 'bearish';
      const contributions = JSON.parse(row.debate_contributions_json) as AnalystContribution[];
      for (const contribution of contributions) {
        const credit = creditForContribution(contribution, r, direction, DISPLAY_CREDIT_CONFIG);
        rollingR.set(
          contribution.analyst_id,
          (rollingR.get(contribution.analyst_id) ?? 0) + credit,
        );
      }
    }

    const summary: Record<string, AttributionSummary> = {};
    for (const [analyst_id, rolling_r] of rollingR) {
      summary[analyst_id] = { analyst_id, rolling_r, window_days: this.attributionWindowDays };
    }
    return summary;
  }

  getDailyMetrics(asOf: Date): MetricsSuite {
    const from = new Date(asOf.getTime() - 24 * 60 * 60 * 1000);
    const rows = this.db
      .prepare(`SELECT * FROM closed_trades WHERE closed_at > ? AND closed_at <= ?`)
      .all(from.toISOString(), asOf.toISOString()) as ClosedTradeRow[];
    const trades = rows.map(fromClosedTradeRow);

    return {
      ...ZERO_METRICS,
      profit_factor: profitFactor(trades),
      expectancy: expectancy(trades),
    };
  }

  getMark(instrument: string, _asOf: Date): Mark {
    // `latest_mark` upserts one row per instrument (no history) — the only
    // truth available is the latest known mark, regardless of `asOf`.
    const row = this.db.prepare(`SELECT * FROM latest_mark WHERE instrument = ?`).get(instrument) as
      | LatestMarkRow
      | undefined;
    if (row === undefined) {
      throw new Error(`SqliteQueryStore.getMark: no mark for instrument "${instrument}"`);
    }
    return {
      price: row.price,
      observed_at: new Date(row.observed_at),
      source: row.source,
      asset_class: row.asset_class,
    };
  }

  /**
   * Three windows in three aggregate queries rather than one scan summed in
   * JS: `llm_spend` grows one row per LLM call and is never pruned, so a
   * 14-day soak's all-time window is the one read here that could get large.
   * SQLite aggregates it against `idx_llm_spend_timestamp` without
   * materialising the rows.
   *
   * `SUM(cost_usd)` skips NULLs by definition, which is exactly the intended
   * semantics — unpriced calls contribute tokens but no dollars — and
   * `unpriced_calls` is counted alongside so the omission is visible rather
   * than silently understating the total.
   */
  getLlmSpend(asOf: Date): LlmSpendSummary {
    const until = asOf.toISOString();
    const dayAgo = new Date(asOf.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const weekAgo = new Date(asOf.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    return {
      last_24h: this.spendBetween(dayAgo, until),
      last_7d: this.spendBetween(weekAgo, until),
      // Open-ended lower bound rather than a sentinel date: an ISO TEXT
      // comparison against '' is true for every well-formed timestamp, but
      // relying on that is a trick the next reader has to decode.
      all_time: this.spendBetween(null, until),
    };
  }

  private spendBetween(fromIso: string | null, untilIso: string): LlmSpendWindow {
    const where =
      fromIso === null ? 'WHERE timestamp <= ?' : 'WHERE timestamp > ? AND timestamp <= ?';
    const params = fromIso === null ? [untilIso] : [fromIso, untilIso];
    const row = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(cost_usd), 0)                    AS cost_usd,
           COALESCE(SUM(input_tokens), 0)                AS input_tokens,
           COALESCE(SUM(output_tokens), 0)               AS output_tokens,
           COALESCE(SUM(cache_read_input_tokens), 0)     AS cache_read_input_tokens,
           COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
           COUNT(*)                                      AS calls,
           COALESCE(SUM(cost_usd IS NULL), 0)            AS unpriced_calls
         FROM llm_spend ${where}`,
      )
      .get(...params) as LlmSpendWindow;
    return row;
  }
}

function profitFactor(trades: readonly ClosedTrade[]): number {
  let wins = 0;
  let losses = 0;
  for (const trade of trades) {
    if (trade.realized_pnl_net >= 0) {
      wins += trade.realized_pnl_net;
    } else {
      losses += -trade.realized_pnl_net;
    }
  }
  if (losses === 0) {
    return wins === 0 ? 0 : Number.POSITIVE_INFINITY;
  }
  return wins / losses;
}

function expectancy(trades: readonly ClosedTrade[]): number {
  if (trades.length === 0) {
    return 0;
  }
  const wins = trades.filter((t) => t.realized_pnl_net >= 0);
  const losses = trades.filter((t) => t.realized_pnl_net < 0);
  const pWin = wins.length / trades.length;
  const pLoss = losses.length / trades.length;
  const avgWin = wins.length === 0 ? 0 : average(wins.map((t) => t.realized_pnl_net));
  const avgLoss = losses.length === 0 ? 0 : average(losses.map((t) => -t.realized_pnl_net));
  return pWin * avgWin - pLoss * avgLoss;
}

function average(values: readonly number[]): number {
  let sum = 0;
  for (const value of values) {
    sum += value;
  }
  return sum / values.length;
}
