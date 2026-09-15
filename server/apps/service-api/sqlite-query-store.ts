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
 * comparable because every writer goes through `toStoredTimestamp`. `asOf`
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

import { PIPELINE_STAGES, type PipelineStage } from '../../../contracts/index.js';
import {
  CONTROL_DEBATE_ID_PREFIX,
  CONTROL_TRACE_SUFFIX,
} from '../../pipeline/control-arm/index.js';
import type { AnalystContribution, Direction } from '../../pipeline/debate-engine/index.js';
import type { PersistedArmComparisonSample } from '../../pipeline/feedback-loop/index.js';
import {
  creditForContribution,
  realizedR,
  SqliteArmComparisonSampleStore,
  SqliteOutsideBenchmarkSampleStore,
} from '../../pipeline/feedback-loop/index.js';
import type { OutsideBenchmarkSample } from '../../pipeline/outside-benchmark/index.js';
import { SqliteRiskCriticStore } from '../../pipeline/risk-manager/index.js';
import type { Mark } from '../../providers/market-data-service/index.js';
import type {
  ClosedTrade,
  DebateLog,
  DebateTermination,
  DebateTerminationCause,
  Fill,
  OpenPosition,
  TradingArm,
} from '../../shared/index.js';
import {
  type ClosedTradeRow,
  type FillRow,
  fromClosedTradeRow,
  fromFillRow,
  fromOpenPositionRow,
  fromStoredTimestamp,
  type OpenPositionRow,
  SqliteLlmSpendCapStore,
  type StoreHandle,
  TERMINAL_ORDER_STATES,
  toStoredTimestamp,
} from '../../shared/store/index.js';
import type { MetricsSuite } from '../../tools/backtest/index.js';
import { type AssetClass, SqliteAlertDeliveryLog, type TickStage } from '../orchestrator/index.js';
import type {
  AttributionSummary,
  DashboardQueryStore,
  LlmPerDebateStats,
  LlmSpendSummary,
  LlmSpendWindow,
  PipelineActivity,
  PipelineLiveTick,
  PipelineStageEvent,
  RiskCriticRecord,
  TickStatus,
  VerdictAuditEntry,
} from './types.js';

interface DebateLogRow {
  debate_id: string;
  instrument: string;
  bar_timestamp: string;
  contributions_json: string;
  direction: Direction;
  rounds: number;
  created_at: string;
  /** #1396: `SELECT *` already returned these (migrations 0041/0051); this cast just named them. */
  termination: DebateTermination | null;
  termination_cause: DebateTerminationCause | null;
}

interface VerdictLogRow {
  trace_id: string;
  instrument: string;
  status: 'go' | 'no_go';
  no_go_reason: string | null;
  hitl_override: number;
  timestamp: string;
}

/**
 * One `risk_log` row with the `debate_id` its `trader_log` twin recorded
 * (#1066). `debate_id` is NULL when the trace has no `trader_log` row — a
 * decision reached on a path that wrote none, or a row predating that table.
 */
interface RiskDecisionJoinRow {
  trace_id: string;
  instrument: string;
  binding_constraint: string | null;
  created_at: string;
  debate_id: string | null;
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

interface UniverseRow {
  instrument: string;
  asset_class: AssetClass;
}

interface PipelineTickRow extends UniverseRow {
  stage: TickStage;
  trace_id: string;
  updated_at: string;
}

interface AuditStageRow {
  trace_id: string;
  stage: PipelineStage;
  decision: string;
  timestamp: string;
  /** NULL for rows written before migration 0013, and for non-tick audit rows. */
  instrument: string | null;
  asset_class: AssetClass | null;
}

/** `closed_trades` joined with its `debate_log` row, for `getAttribution`'s single-query read. */
interface AttributionRow extends ClosedTradeRow {
  debate_contributions_json: string;
}

function fromDebateLogRow(row: DebateLogRow): DebateLog {
  return {
    debate_id: row.debate_id,
    instrument: row.instrument,
    bar_timestamp: fromStoredTimestamp(row.bar_timestamp),
    contributions: JSON.parse(row.contributions_json) as AnalystContribution[],
    direction: row.direction,
    rounds: row.rounds,
    created_at: fromStoredTimestamp(row.created_at),
    // #1396: NULL on a pre-migration row (indeterminate, not "converged") or
    // a non-truncated row (there is no cause to report) — omitted rather than
    // `undefined` on the domain object (`exactOptionalPropertyTypes`), same
    // convention as `DebateLog`'s own doc and `buildDebateLog`'s writer side.
    ...(row.termination === null ? {} : { termination: row.termination }),
    ...(row.termination_cause === null ? {} : { termination_cause: row.termination_cause }),
  };
}

function fromVerdictLogRow(row: VerdictLogRow): VerdictAuditEntry {
  return {
    trace_id: row.trace_id,
    instrument: row.instrument,
    status: row.status,
    reason: row.no_go_reason ?? 'approved',
    hitl_override: row.hitl_override !== 0,
    timestamp: fromStoredTimestamp(row.timestamp),
  };
}

/**
 * The SQL operator that keeps a `trace_id`/`debate_id` row for the named arm
 * (#1594): live wants rows NOT carrying the control markers
 * (`CONTROL_TRACE_SUFFIX`/`CONTROL_DEBATE_ID_PREFIX`), control wants rows that
 * DO. Returned as a validated union rather than built inline per call site, so
 * a typo can't silently produce a syntactically-valid SQL fragment that
 * filters the wrong arm — the mistake #1318/#1319/#1326 exist to prevent.
 */
type ArmLikeOperator = 'NOT LIKE' | 'LIKE';
function armLikeOperator(arm: TradingArm): ArmLikeOperator {
  return arm === 'live' ? 'NOT LIKE' : 'LIKE';
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
  per_period_sharpe: 0,
  annualization_factor: 0,
  observations: 0,
};

export class SqliteQueryStore implements DashboardQueryStore {
  /** How far back `getAttribution` looks for closed trades. No home in the schema
   * (`attribution_window_ms` is a `FeedbackConfig` field, not a persisted value) —
   * taken as a constructor option, defaulting to the fixture's 30 days. */
  /** #971: the Feedback Loop's own sample store, read (never written) here. */
  private readonly armComparisons: SqliteArmComparisonSampleStore;
  private readonly outsideBenchmarks: SqliteOutsideBenchmarkSampleStore;
  /** #1066: the Risk Manager's own critic log, read (never written) here. */
  private readonly critics: SqliteRiskCriticStore;
  /** #1108: the orchestrator's own alert-delivery-failure log, read (never written) here. */
  private readonly alertDeliveryLog: SqliteAlertDeliveryLog;
  /**
   * #1140: the cap the orchestrator armed, read (never written) here — the
   * same store class its composition root writes through, so the denominator
   * on the wire cannot be a second copy of the number this process invented.
   */
  private readonly spendCap: SqliteLlmSpendCapStore;

  constructor(
    private readonly db: StoreHandle,
    private readonly attributionWindowDays = 30,
    /**
     * The escalation chat `alert_delivery_failures.chat_id` is scoped
     * against (#1108 third review pass) — the same chat `alert-transport.ts`
     * reads `TELEGRAM_CHAT_ID` into, normalized the same way (trimmed,
     * empty-as-unset) so the entry point's read agrees with the
     * orchestrator's. `undefined` when unconfigured (the only configuration
     * under which the orchestrator itself never writes real Telegram rows
     * either: `SAMURAI_ALERTS=log-only`) — `getAlertDeliveryFailureCount`
     * reads 0 rather than guessing a chat, and the entry point names that
     * state at boot instead of it being reached silently.
     */
    private readonly alertChatId?: string,
  ) {
    this.armComparisons = new SqliteArmComparisonSampleStore(db);
    this.outsideBenchmarks = new SqliteOutsideBenchmarkSampleStore(db);
    this.critics = new SqliteRiskCriticStore(db);
    this.alertDeliveryLog = new SqliteAlertDeliveryLog(db);
    this.spendCap = new SqliteLlmSpendCapStore(db);
  }

  /**
   * **Exactly one arm's rows (#753, parameterized by #1592)**, like every
   * other read on this store. The dashboard shows the book the named arm is
   * actually trading; the other arm's lots are a measurement, not this
   * arm's exposure, and mixing them in would misstate what is at risk. The
   * two arms are compared deliberately, through the arm comparison report,
   * not incidentally here — and never both at once through this method.
   */
  getOpenPositions(asOf: Date, arm: TradingArm): OpenPosition[] {
    const placeholders = TERMINAL_ORDER_STATES.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT * FROM open_positions
          WHERE arm = ? AND order_state NOT IN (${placeholders}) AND opened_at <= ?
          ORDER BY opened_at`,
      )
      .all(arm, ...TERMINAL_ORDER_STATES, toStoredTimestamp(asOf)) as OpenPositionRow[];
    return rows.map(fromOpenPositionRow);
  }

  /**
   * #940: `closed_trades`' mirror of `getRecentDebates`/`getVerdictHistory`
   * below. Exactly one arm's rows (#753, parameterized by #1592) — see
   * `getOpenPositions`'s doc for why.
   */
  getRecentClosedTrades(limit: number, asOf: Date, arm: TradingArm): ClosedTrade[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM closed_trades
          WHERE arm = ? AND closed_at <= ?
          ORDER BY closed_at DESC LIMIT ?`,
      )
      .all(arm, toStoredTimestamp(asOf), limit) as ClosedTradeRow[];
    return rows.map(fromClosedTradeRow);
  }

  /**
   * #1595: every closed trade for one arm, unbounded — no `LIMIT`, unlike
   * `getRecentClosedTrades` above. The P&L headline's all-time drawdown needs
   * the whole realized series; truncating it to a recent-history window would
   * silently understate (or entirely miss) the true peak-to-trough fall.
   */
  getAllClosedTrades(asOf: Date, arm: TradingArm): ClosedTrade[] {
    const rows = this.db
      .prepare(`SELECT * FROM closed_trades WHERE arm = ? AND closed_at <= ? ORDER BY closed_at`)
      .all(arm, toStoredTimestamp(asOf)) as ClosedTradeRow[];
    return rows.map(fromClosedTradeRow);
  }

  /**
   * #940: every fill for the named lots. Scoped by `idempotency_key IN (...)`
   * rather than a bounded time window — `buildSnapshot` always calls this with
   * the closed trades it just read, so the placeholder list (built from
   * `idempotencyKeys.length`, never the strings themselves, same as
   * `getMarks`) is exactly the set of lots being rendered.
   */
  getFillsForTrades(idempotencyKeys: readonly string[], _asOf: Date): Fill[] {
    if (idempotencyKeys.length === 0) return [];
    const placeholders = idempotencyKeys.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT * FROM fills
          WHERE idempotency_key IN (${placeholders})
          ORDER BY idempotency_key, rowid`,
      )
      .all(...idempotencyKeys) as FillRow[];
    return rows.map(fromFillRow);
  }

  getRecentDebates(limit: number, asOf: Date): DebateLog[] {
    const rows = this.db
      .prepare(`SELECT * FROM debate_log WHERE created_at <= ? ORDER BY created_at DESC LIMIT ?`)
      .all(toStoredTimestamp(asOf), limit) as DebateLogRow[];
    return rows.map(fromDebateLogRow);
  }

  getTickStatus(asOf: Date): TickStatus | null {
    const row = this.db
      .prepare(
        `SELECT instrument, asset_class, stage, trace_id FROM current_tick
          WHERE updated_at <= ? ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(toStoredTimestamp(asOf)) as CurrentTickRow | undefined;
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

  /**
   * Scoped by `arm`, like `getOpenPositions` and `getRecentClosedTrades`
   * above — a read names exactly one arm, and no read returns both.
   * `verdict_log` carries no `arm`
   * column, so unlike those two this discriminates on `trace_id`: falsifier
   * arm 2 writes its own `verdict_log` rows under a `trace_id` carrying
   * `CONTROL_TRACE_SUFFIX` (#753), and `verdict_log` has no `debate_id`
   * column, so unlike `getRiskCritics` there is only the one discriminator to
   * apply. The filter is in the `WHERE` clause, ahead of `ORDER BY ... LIMIT`:
   * a `LIMIT` applied before the arm is decided would let the other arm's rows
   * displace this arm's out of the page instead of merely appearing beside
   * them, which is the bug #1318 fixed and parameterizing must not reopen.
   */
  getVerdictHistory(limit: number, asOf: Date, arm: TradingArm): VerdictAuditEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM verdict_log
          WHERE timestamp <= ? AND trace_id ${armLikeOperator(arm)} ?
          ORDER BY timestamp DESC LIMIT ?`,
      )
      .all(toStoredTimestamp(asOf), `%${CONTROL_TRACE_SUFFIX}`, limit) as VerdictLogRow[];
    return rows.map(fromVerdictLogRow);
  }

  /**
   * The drawer's invalidation section (#1066): recent Risk decisions, each
   * with the critic verdict it was reached with.
   *
   * ## Why `risk_log` drives the query
   *
   * The drawer holds a `(trace_id, instrument)` pair, which is exactly
   * `risk_log`'s primary key. Driving from `risk_critic_log` instead would key
   * the result by `debate_id` — and a retried tick mints a fresh `trace_id`
   * while keeping its content-hashed `debate_id` (migrations 0012/0015), so
   * one critic row can belong to two traces and the join would fan out. Both
   * joins below are onto primary keys (`trader_log` on the same pair,
   * `risk_critic_log` on `debate_id`), so exactly one row comes back per
   * decision.
   *
   * ## Scoped by `arm`
   *
   * Like `getVerdictHistory` above, `arm` picks which of the two decision
   * streams this window shows — a read names exactly one arm, and no read
   * returns both.
   *
   * Falsifier arm 2 writes its own `risk_log`/`trader_log` rows under the
   * `control:` `debate_id` namespace (`CONTROL_DEBATE_ID_PREFIX`) and under a
   * `trace_id` carrying `CONTROL_TRACE_SUFFIX`, which is what makes them
   * separable without a schema change. Both discriminators flip together on
   * `arm` (`armLikeOperator`), and the `trace_id` one is the load-bearing
   * half: it sits on the driving table's own non-nullable key, so a decision
   * whose Trader row is missing is still correctly scoped, where the
   * `debate_id` test alone would let it through on the NULL branch regardless
   * of arm. The NULL branch stays permissive in BOTH directions
   * (`debate_id IS NULL OR debate_id ${op} 'control:%'`) so neither arm drops
   * a row whose `trader_log` twin is missing.
   *
   * A control-arm read returns the control's own `risk_log` rows, each with
   * `critic: undefined` below — the control calls no model and so consults no
   * critic, but it still makes Risk decisions, and this is not "excluded",
   * it is "not applicable" (ADR-0021's 2026-09-15 amendment).
   *
   * ## The per-row critic read
   *
   * `SqliteRiskCriticStore.getByDebateId` rather than a fourth JOIN and a
   * second copy of the JSON reading: that store owns the tightened shape check
   * and the pre-fold/corrupt-column fallbacks (#1068), and a hand-written
   * `JSON.parse` here would be a second, laxer reader of the same two columns.
   * At most `limit` reads, once per dashboard HTTP request rather than per
   * tick. It is constructed with NO logger deliberately — the store WARNs once
   * per malformed row, and this query runs on a 3-second poll, so the
   * orchestrator's own read is where that belongs, not the dashboard's.
   */
  getRiskCritics(limit: number, asOf: Date, arm: TradingArm): RiskCriticRecord[] {
    const op = armLikeOperator(arm);
    const rows = this.db
      .prepare(
        `SELECT risk_log.trace_id AS trace_id,
                risk_log.instrument AS instrument,
                risk_log.binding_constraint AS binding_constraint,
                risk_log.created_at AS created_at,
                trader_log.debate_id AS debate_id
           FROM risk_log
           LEFT JOIN trader_log
             ON trader_log.trace_id = risk_log.trace_id
            AND trader_log.instrument = risk_log.instrument
          WHERE risk_log.created_at <= ?
            AND risk_log.trace_id ${op} ?
            AND (trader_log.debate_id IS NULL OR trader_log.debate_id ${op} ?)
          ORDER BY risk_log.created_at DESC
          LIMIT ?`,
      )
      .all(
        toStoredTimestamp(asOf),
        `%${CONTROL_TRACE_SUFFIX}`,
        `${CONTROL_DEBATE_ID_PREFIX}%`,
        limit,
      ) as RiskDecisionJoinRow[];

    return rows.map((row) => ({
      trace_id: row.trace_id,
      instrument: row.instrument,
      debate_id: row.debate_id,
      binding_constraint: row.binding_constraint,
      critic:
        row.debate_id === null ? undefined : this.critics.getByDebateId(row.debate_id)?.verdict,
      created_at: fromStoredTimestamp(row.created_at),
    }));
  }

  getAnalystWeights(asOf: Date): Record<string, number> {
    const rows = this.db
      .prepare(`SELECT analyst_id, weight FROM analyst_weights WHERE updated_at <= ?`)
      .all(toStoredTimestamp(asOf)) as AnalystWeightRow[];
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
   *
   * #1081: this is a second, independent read of the same credit join the
   * Feedback Loop computes (`getContributionsForAttribution` in
   * `debate-attribution-lookup.ts`) — it does not go through that function,
   * so its own exclusion has to be applied here too, or this dashboard panel
   * and the Feedback Loop's weight updates would credit analysts on
   * disjoint row sets over the same window. `termination IS NOT
   * 'latency_truncated'` is SQLite's NULL-safe comparison: a pre-migration
   * row (`termination IS NULL`, indeterminate) is kept, exactly as
   * `getContributionsForAttribution` keeps it — only a row this build
   * itself classified as latency-truncated is dropped.
   *
   * Scoped by `arm`, like `getOpenPositions` (#1592) — bound rather than a
   * literal, so a typo here cannot silently pin every caller to one arm.
   * `getAttribution(asOf,
   * 'control')` returns `{}`: the `JOIN` is onto `debate_log`, and the control
   * arm never writes that table (`axis-vote-decision.ts` — its `DebateResult`
   * is synthesized in-memory, with no debate to log), so no `closed_trades`
   * row of either arm can match a control `debate_id`. That is the correct
   * answer, not an accident of an empty join: there is no debate to
   * attribute a control trade's outcome to.
   */
  getAttribution(asOf: Date, arm: TradingArm): Record<string, AttributionSummary> {
    const from = new Date(asOf.getTime() - this.attributionWindowDays * 24 * 60 * 60 * 1000);
    const rows = this.db
      .prepare(
        `SELECT closed_trades.*, debate_log.contributions_json AS debate_contributions_json
           FROM closed_trades
           JOIN debate_log ON debate_log.debate_id = closed_trades.debate_id
          WHERE closed_trades.arm = ?
            AND closed_trades.closed_at > ? AND closed_trades.closed_at <= ?
            AND debate_log.termination IS NOT 'latency_truncated'`,
      )
      .all(arm, toStoredTimestamp(from), toStoredTimestamp(asOf)) as AttributionRow[];

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
        // Same correctness figure the Feedback Loop attributes on (#370 left
        // `creditForContribution` with no tuning knobs to diverge over).
        const credit = creditForContribution(contribution, r, direction);
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

  /** Scoped by `arm`, like `getAttribution` above. */
  getDailyMetrics(asOf: Date, arm: TradingArm): MetricsSuite {
    const from = new Date(asOf.getTime() - 24 * 60 * 60 * 1000);
    const rows = this.db
      .prepare(`SELECT * FROM closed_trades WHERE arm = ? AND closed_at > ? AND closed_at <= ?`)
      .all(arm, toStoredTimestamp(from), toStoredTimestamp(asOf)) as ClosedTradeRow[];
    const trades = rows.map(fromClosedTradeRow);

    return {
      ...ZERO_METRICS,
      profit_factor: profitFactor(trades),
      expectancy: expectancy(trades),
    };
  }

  getMark(instrument: string, asOf: Date): Mark {
    // Delegates so there is exactly one place that decides what a mark is and
    // what a missing one does.
    return this.getMarks([instrument], asOf).get(instrument) as Mark;
  }

  getMarks(instruments: readonly string[], _asOf: Date): Map<string, Mark> {
    const marks = new Map<string, Mark>();
    if (instruments.length === 0) return marks;

    // `latest_mark` upserts one row per instrument (no history) — the only
    // truth available is the latest known mark, regardless of `asOf`.
    //
    // The placeholder list is built from `instruments.length`, never from the
    // instrument strings themselves, so the values stay bound parameters.
    const placeholders = instruments.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT instrument, price, observed_at, source, asset_class
           FROM latest_mark
          WHERE instrument IN (${placeholders})`,
      )
      .all(...instruments) as LatestMarkRow[];

    for (const row of rows) {
      marks.set(row.instrument, {
        price: row.price,
        observed_at: fromStoredTimestamp(row.observed_at),
        source: row.source,
        asset_class: row.asset_class,
      });
    }

    // Per-instrument, in request order, so a missing mark fails exactly as the
    // old per-position loop did rather than silently rendering a priceless row.
    for (const instrument of instruments) {
      if (!marks.has(instrument)) {
        throw new Error(`SqliteQueryStore.getMark: no mark for instrument "${instrument}"`);
      }
    }

    return marks;
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
  /**
   * Delegated to the Feedback Loop's own store (#971) rather than re-issuing
   * its SELECT here: the orchestrator process writes `arm_comparison_samples`
   * through `SqliteArmComparisonSampleStore` and this process reads it, and two
   * hand-written copies of the same row mapping is exactly how a column gets
   * dropped on one side. Built once per query store, not per request.
   */
  getArmComparisons(limit: number, asOf: Date): PersistedArmComparisonSample[] {
    return this.armComparisons.getRecent(limit, asOf);
  }

  /**
   * Delegated to the Feedback Loop's own store (#981) for the reason
   * `getArmComparisons` is: the orchestrator writes
   * `outside_benchmark_samples` through `SqliteOutsideBenchmarkSampleStore` and
   * this process reads it, and two hand-written copies of one row mapping is
   * how a column gets dropped on one side.
   */
  getOutsideBenchmarks(limit: number, asOf: Date): OutsideBenchmarkSample[] {
    return this.outsideBenchmarks.getRecent(limit, asOf);
  }

  getLlmSpend(asOf: Date): LlmSpendSummary {
    const until = toStoredTimestamp(asOf);
    const dayAgo = toStoredTimestamp(new Date(asOf.getTime() - 24 * 60 * 60 * 1000));
    const weekAgo = toStoredTimestamp(new Date(asOf.getTime() - 7 * 24 * 60 * 60 * 1000));
    // Never defaulted here: a fallback in this layer is the client's deleted
    // `LLM_SPEND_CAP_USD` moved one process left (#1140). `armedAt` is what
    // lets the wire tell "armed uncapped" apart from "never armed" (#1196) —
    // see `SqliteLlmSpendCapStore.read`.
    const cap = this.spendCap.read();
    return {
      last_24h: this.spendBetween(dayAgo, until),
      last_7d: this.spendBetween(weekAgo, until),
      // Open-ended lower bound rather than a sentinel date: an ISO TEXT
      // comparison against '' is true for every well-formed timestamp, but
      // relying on that is a trick the next reader has to decode.
      all_time: this.spendBetween(null, until),
      cap_usd: cap.budgetUsd,
      cap_armed_at: cap.armedAt,
    };
  }

  /**
   * The Pipeline view's read (#411) — lane universe, attributed stage rows,
   * and in-flight ticks, in three bounded queries.
   *
   * ## Where the instrument comes from
   *
   * `audit_log.instrument` / `.asset_class`, since migration 0013. Both are
   * written by tick-runner.ts's single `record` closure, so EVERY stage row of
   * every tick carries them; tick-loop.ts's `crashed` row carries them too.
   * The remaining NULLs are rows predating 0013 and rows the retired HITL
   * Telegram callback wrote under an existing `trace_id` with no `Signal` in
   * scope — both mean "not attributable", never "no instrument", and neither
   * may be guessed into a lane.
   *
   * `llm_spend.debate_id -> debate_log.instrument` is deliberately NOT used as
   * a second source: it misses `quorum_skip` (the tick never reaches an LLM
   * call), and `SqliteLlmSpendStore.record` swallows its write failures by
   * design, so a metering hiccup would silently delete a lane. An identity
   * index has to be a system of record; that table is not one.
   *
   * Payload is bounded three ways for the 3-second poll: `maxLanes` caps the
   * universe, `lookbackMs` caps how far back a lane reaches (#413), and at
   * most one settled candidate plus one live trace per lane reach the audit
   * query. Both timestamp ranges ride `idx_audit_log_timestamp` (migration
   * 0025) rather than scanning the table.
   */
  getPipelineActivity(
    maxLanes: number,
    lookbackMs: number,
    asOf: Date,
    arm: TradingArm,
  ): PipelineActivity {
    const until = toStoredTimestamp(asOf);
    const from = toStoredTimestamp(new Date(asOf.getTime() - lookbackMs));
    const op = armLikeOperator(arm);

    // Three sources, and the invariant is that ACTIVITY defines the universe
    // while PRICING only extends it (#619):
    //
    //  - `audit_log` in the window — every instrument the named arm actually
    //    ran and attributed (#1319, parameterized #1594: the other arm's own
    //    attributed rows are excluded below — like `getOpenPositions` and
    //    `getRecentClosedTrades`, which filter on a bound `arm = ?` parameter
    //    (#1592), and like `getVerdictHistory` and `getRiskCritics` (#1318),
    //    which filter on `trace_id`, since `audit_log` has no `arm` column of
    //    its own). This is the source the lanes are built from, so a lane can
    //    no longer be missing for an instrument whose trace is right there.
    //  - `current_tick` in the window, LIVE ARM ONLY — see below.
    //  - `latest_mark` — one upserted row per instrument the Market Data
    //    Service has PRICED, on demand rather than per tick. It is not the
    //    tick universe and never was; it is here so a priced instrument with
    //    no recent activity reads as an IDLE lane rather than vanishing (a
    //    closed market is the common, correct reason to be quiet). Arm-
    //    agnostic pricing, present for both arms.
    //
    // No stage filter on the audit arm: any attributed audit row for the
    // named arm means the bot touched that instrument, so it belongs in the
    // universe. Whether it gets a TRACE is `pipelineEvents`' stage filter's
    // job.
    //
    // `active` decides who survives `maxLanes`, not who renders first: a
    // stale priced instrument must never evict an active one at the cap,
    // which is #1319's own failure mode arriving by a different door. The
    // outer ORDER BY restores lane order; wire order is `buildPipelineView`'s
    // call.
    //
    // An instrument has exactly one asset class. `GROUP BY instrument` plus
    // `MIN(asset_class)` is what makes a violation of that render the same way
    // on every poll instead of flapping between the sources that disagree — an
    // aggregate rather than a bare column, so nothing here rests on which row
    // SQLite happens to pick. `MIN` because it also sorts the conflicted lane
    // earliest below, so bad data cannot additionally cost it its lane at the
    // cap.
    //
    // Arm filter on the `audit_log` leg (#1319, parameterized #1594):
    // `audit_log` carries no `debate_id` column (0001_init.sql, plus 0013's
    // two attribution columns), so unlike `getRiskCritics` there is only the
    // one discriminator to apply, the same as `getVerdictHistory` (#1318).
    // Excluded in the `WHERE` clause, ahead of the `GROUP BY`/`ORDER BY ...
    // LIMIT` cut: the other arm's tick-runner pass writes its own attributed
    // rows under a `trace_id` carrying `CONTROL_TRACE_SUFFIX` (`control-
    // arm.ts`), and without this filter those rows counted toward `active`
    // exactly like a named-arm row, so a wrong-arm-only instrument could win
    // the tie-break and evict a genuinely named-arm one at the cap instead of
    // merely appearing beside it. This ticket owns only the `audit_log` leg;
    // the sibling `audit_log` query in `pipelineEvents` below carries the same
    // predicate for its own newest-trace pick (#1326).
    //
    // `current_tick` LEG IS LIVE-ONLY, STRUCTURALLY, NOT BY FILTER (#1594):
    // the control arm is wired with its own `InMemoryCurrentTickStore`
    // (`control-arm-wiring.ts`) — in-memory, per-process, never persisted —
    // so `current_tick` can never hold a control row, and there is no
    // `trace_id`/`debate_id` on this table to filter one out of even if there
    // were. Reading it unconditionally was safe while every read here was
    // implicitly live-only; now that `arm` is a caller-chosen parameter,
    // leaving the leg unconditional for `arm === 'control'` would read the
    // LIVE arm's in-flight ticks into a control-scoped universe at `active =
    // 1`, reopening #1319's exact failure mode through the one leg that isn't
    // a `trace_id` filter away from the other arm's rows, because it
    // structurally has none of its own. The leg (and its params) are omitted
    // entirely for `arm === 'control'`, and `PipelineActivity.live` below is
    // `[]` for the same reason — a table this arm cannot write is not
    // queried on its behalf, matching ADR-0021's 2026-09-15 amendment
    // ("Control arm: tick status is not persisted").
    const auditLegSql = `SELECT DISTINCT instrument, asset_class, 1 AS active FROM audit_log
               WHERE timestamp > ? AND timestamp <= ?
                 AND instrument IS NOT NULL AND asset_class IS NOT NULL
                 AND trace_id ${op} ?`;
    const currentTickLegSql =
      arm === 'live'
        ? `UNION ALL
             SELECT instrument, asset_class, 1 FROM current_tick
               WHERE updated_at > ? AND updated_at <= ?`
        : '';
    const universeParams =
      arm === 'live'
        ? [from, until, `%${CONTROL_TRACE_SUFFIX}`, from, until, maxLanes]
        : [from, until, `%${CONTROL_TRACE_SUFFIX}`, maxLanes];

    const universe = this.db
      .prepare(
        `SELECT instrument, asset_class FROM (
           SELECT instrument, MIN(asset_class) AS asset_class, MAX(active) AS active FROM (
             ${auditLegSql}
             ${currentTickLegSql}
             UNION ALL
             SELECT instrument, asset_class, 0 FROM latest_mark
           )
           GROUP BY instrument
           ORDER BY active DESC, asset_class, instrument
           LIMIT ?
         )
         ORDER BY asset_class, instrument`,
      )
      .all(...universeParams) as UniverseRow[];
    const laneInstruments = new Set(universe.map((row) => row.instrument));

    // The window applies to `current_tick` too, unlike `getTickStatus`, which
    // takes the latest row unconditionally. A crash mid-tick deliberately
    // leaves the row behind (tick-runner.ts: a stale row must be visible, not
    // tidied away), and a lane that showed it forever would report a dead tick
    // as running until that instrument next completed a tick.
    const live: PipelineLiveTick[] =
      arm === 'control'
        ? []
        : (
            this.db
              .prepare(
                `SELECT instrument, asset_class, stage, trace_id, updated_at FROM current_tick
                  WHERE updated_at > ? AND updated_at <= ?
                  ORDER BY updated_at DESC`,
              )
              .all(from, until) as PipelineTickRow[]
          )
            .filter((row) => laneInstruments.has(row.instrument))
            // #743: a tick-path pass upserts `stage: 'position_check'`, which is
            // not a decision-chain stage and has no lane column — the lane view
            // renders the decision chain, and after the split ~29 of 30 passes
            // are tick-path. Excluded here rather than widened into
            // `PIPELINE_STAGES`, so the lanes keep meaning "where is the
            // decision", while `getTickStatus` (the telemetry strip's in-flight
            // indicator) still reports the pass.
            .filter((row): row is PipelineTickRow & { stage: PipelineStage } => {
              return row.stage !== 'position_check';
            })
            .map<PipelineLiveTick>((row) => ({
              instrument: row.instrument,
              asset_class: row.asset_class,
              stage: row.stage,
              trace_id: row.trace_id,
              entered_at: fromStoredTimestamp(row.updated_at),
            }));

    return {
      universe,
      events: this.pipelineEvents(laneInstruments, from, until, arm),
      live,
    };
  }

  /**
   * Stage rows for the newest trace of each lane instrument.
   *
   * Attribution comes straight off `audit_log.instrument` (migration 0013).
   * Before that column existed the only trace_id → instrument links in the
   * schema were `current_tick` (in-flight only, and deleted at tick end) and
   * `verdict_log` (only traces that reached Verdict) — which between them
   * cannot see a SHORT-CIRCUITED tick at all. A `quorum_skip` at Analysts or a
   * breaker trip at Risk belonged to no instrument, so the lane that most
   * needed explaining was the one that stayed blank. Reading the column is
   * what makes `stopped` cells reachable in production and not only in
   * fixtures.
   *
   * BOTH 0013 columns are required, matching `getPipelineActivity`'s universe
   * arm's own NULL check. The two must agree on what "attributed" means: a row
   * naming an instrument with no asset class is not renderable, and letting it
   * win `chosenTrace` would blank a lane whose real trace sits in the same
   * window — the identical symptom, one path over.
   *
   * Scoped by `arm`, same discriminator as the universe leg above and as
   * `getVerdictHistory`/`getRiskCritics` (#1318): `0001_init.sql` declares
   * `audit_log.trace_id TEXT NOT NULL` and no migration ever adds a `debate_id` column to this
   * table (unlike `trader_log`/`debate_log`/`risk_critic_log`, which do), so
   * `trace_id`'s operator (`armLikeOperator`) is both sufficient — there is
   * no second discriminator to also filter on — and safe against a NULL
   * `trace_id` silently dropping a row the old query kept, since no such row
   * can exist.
   *
   * This query's cut is not a `LIMIT` but the newest-wins `chosenTrace` fold
   * below, so the filter has to sit in `WHERE`, ahead of that fold, for the
   * same reason #1318/#1319 put theirs ahead of `LIMIT`: the control arm often
   * runs its own full decision-pass chain (`control-arm.ts`'s
   * `buildControlArmStep`, awaited before the live pass writes anything
   * further) under a `trace_id` carrying `CONTROL_TRACE_SUFFIX`, into this
   * SAME table.
   *
   * The shapes a careful reading of `tick-runner.ts` finds for a live pass
   * that leaves no further PIPELINE_STAGES row after the control arm
   * completes: (a) a quorum-skipped decision pass whose OWN exit check
   * produces no intent (the common case), where the live pass falls through
   * to `runExitCheckPass` and writes only the filtered `position_check`
   * stage while the control's own nested pass still records its own
   * `analysts` row, chronologically later — a quorum-skipped pass whose exit
   * check DOES fire an intent instead writes its own
   * `risk`/`verdict`/`execution` rows after the control's, and the live arm
   * wins the fold correctly, so this trigger is conditioned on the no-intent
   * branch, not on the quorum-skip alone; (b) a live pass that crashes
   * mid-await after the control arm has already completed, where
   * `tick-loop.ts`'s catch writes `stage: 'tick-loop'` or, since #1380,
   * `stage: 'tick-loop:<TickStage>'` — either way `stage IN (${stagePlaceholders})`
   * below still excludes it, since neither shape is a bare `PIPELINE_STAGES`
   * value;
   * or (c) the ordinary TICK path itself — `#runInstrument` awaits
   * `this.steps.controlArm` before `runExitCheckPass`, and the control's own
   * nested `runInstrument` takes that same tick path into its own
   * `runExitCheckPass`, which on a non-null exit intent falls into
   * `runIntentTail` and records `risk`, `verdict`, and `execution` under the
   * control's suffixed trace. The two arms hold separate books
   * (`control-arm-wiring.ts` overrides `store`, `broker`, `getOpenPositions`,
   * and `accountState`), so a tick where the control arm has an exit-due lot
   * and the live arm does not is the ORDINARY case, not an edge one — and per
   * the #743 comment above, roughly 29 of 30 passes are tick passes, so (c)
   * is plausibly the DOMINANT trigger here, not an excluded one.
   *
   * That reading covers every `markStage`/`record` pair in `tick-runner.ts`
   * — both the head chain from `markStage('analysts')` through the dispatch
   * into `runIntentTail`, and `runIntentTail` itself (`risk` through
   * `execution`) — and finds none with a branch between marking a stage and
   * recording it. But the filter does not depend on (a)/(b)/(c) above being
   * a complete list: `chosenTrace` folds over every row in the WINDOW, not
   * per pass, so a control row need not be the newest thing THIS pass wrote
   * to win — an earlier pass's control row stays newest until some later row,
   * live or control, displaces it. Unfiltered, any control row newer than
   * live's own newest displaces `chosenTrace`; in the crash or tick-path case
   * the control arm may have already recorded a `verdict`/`execution` "go" of
   * its own, which would then render as the live pass's. Do not read (c) as
   * saying the leak fires on every tick: it fires only when the two arms'
   * exit-due state has diverged for that instrument somewhere in the window.
   *
   * The filter removes the OTHER arm's ROWS, not the other-arm-touched
   * INSTRUMENTS: an instrument the named arm also attributed still renders
   * its own stage sequence, from its own rows, once the other arm's are gone
   * from the result set the fold sees.
   *
   * ## Why parameterizing (#1594) needs no mirror of (a)/(b)/(c) for `arm: 'control'`
   *
   * (a)/(b)/(c) above are all shapes of ONE nesting direction: the control
   * arm's `runInstrument` runs NESTED inside the live pass
   * (`this.steps.controlArm`, awaited before `runExitCheckPass`) — never the
   * other way around, per `tick-runner.ts` and `control-arm-wiring.ts`. A
   * `arm: 'control'` request applies the SAME discriminator with the operator
   * flipped (`trace_id LIKE '%:control'`), which removes every live row from
   * the result set the fold sees before `chosenTrace` runs at all — there is
   * no scenario where a live row, newer or not, reaches the fold to displace
   * a control one, because live rows never pass the `WHERE` clause for that
   * request. The asymmetric nesting direction is exactly why no mirrored
   * (a')/(b')/(c') list is needed: the bug those cases describe is what
   * happens when the OTHER arm's rows are visible to the fold at all, and
   * filtering by `WHERE` prevents that symmetrically in both directions,
   * regardless of which arm nests inside which.
   *
   * The `stage IN (…)` filter is not defensive tidiness: `audit_log.stage` is
   * unconstrained TEXT and the retired HITL Telegram callback wrote
   * `verdict.hitl.telegram_callback` rows under the pipeline's own `trace_id`
   * — rows that persist in older stores. Without the filter those land in a
   * lane as a seventh, unrenderable stage.
   *
   * `ORDER BY … timestamp, rowid` is `SqliteAuditLog.getByTraceId`'s ordering,
   * for its reason: `audit_log` has no primary key, SQLite's tie-break for
   * equal timestamps is unspecified, and a fixed clock puts several stages on
   * the same ISO millisecond.
   */
  private pipelineEvents(
    laneInstruments: ReadonlySet<string>,
    fromIso: string,
    untilIso: string,
    arm: TradingArm,
  ): PipelineStageEvent[] {
    if (laneInstruments.size === 0) {
      return [];
    }
    const stagePlaceholders = PIPELINE_STAGES.map(() => '?').join(', ');

    const rows = this.db
      .prepare(
        `SELECT trace_id, instrument, asset_class, stage, decision, timestamp FROM audit_log
          WHERE timestamp > ? AND timestamp <= ?
            AND instrument IS NOT NULL
            AND asset_class IS NOT NULL
            AND trace_id ${armLikeOperator(arm)} ?
            AND stage IN (${stagePlaceholders})
          ORDER BY timestamp, rowid`,
      )
      .all(fromIso, untilIso, `%${CONTROL_TRACE_SUFFIX}`, ...PIPELINE_STAGES) as AuditStageRow[];

    // One trace per instrument — a lane renders exactly one — and the newest
    // wins. Rows arrive oldest-first, because that ordering is load-bearing
    // for the stage sequence within a trace, so a later row simply overwrites
    // the claim and the last trace seen is the one that survives.
    const chosenTrace = new Map<string, string>();
    for (const row of rows) {
      if (row.instrument !== null && laneInstruments.has(row.instrument)) {
        chosenTrace.set(row.instrument, row.trace_id);
      }
    }

    const events: PipelineStageEvent[] = [];
    for (const row of rows) {
      if (row.instrument === null || row.asset_class === null) {
        continue;
      }
      if (chosenTrace.get(row.instrument) !== row.trace_id) {
        continue;
      }
      events.push({
        trace_id: row.trace_id,
        instrument: row.instrument,
        asset_class: row.asset_class,
        stage: row.stage,
        decision: row.decision,
        timestamp: fromStoredTimestamp(row.timestamp),
      });
    }
    return events;
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
           COALESCE(SUM(cost_usd IS NULL), 0)            AS unpriced_calls,
           COALESCE(SUM(debate_id IS NULL), 0)           AS unattributed_calls
         FROM llm_spend ${where}`,
      )
      .get(...params) as Omit<LlmSpendWindow, 'per_debate'> & { unattributed_calls: number };

    const { unattributed_calls, ...window } = row;
    return { ...window, per_debate: this.perDebateBetween(where, params, unattributed_calls) };
  }

  /**
   * Per-DECISION cost and LLM latency (#326).
   *
   * One `GROUP BY debate_id` inside the window, then percentiles in JS. The
   * grouping is bounded by the number of DEBATES in the window rather than the
   * number of calls (~10 calls per debate), and SQLite still drives it off
   * `idx_llm_spend_timestamp` — the same range scan `spendBetween` already
   * pays for. Percentiles are computed here rather than in SQL because SQLite
   * ships no percentile function and the alternatives (a self-join on rank, or
   * a window function over the whole scan) are both slower and far harder to
   * read than sorting an array of debate totals.
   *
   * Rows with `debate_id IS NULL` are excluded from the grouping — folding
   * them into one pseudo-debate would invent a single enormous outlier that
   * drags p95 up by construction. They are reported as `unattributed_calls`
   * instead.
   *
   * A debate with NO measured latency at all (every row predating migration
   * 0012) is counted in `debates` and priced normally, but is left OUT of the
   * latency sample entirely — `SUM(latency_ms)` is deliberately NOT wrapped in
   * `COALESCE`, so such a debate arrives as NULL rather than as 0. Coalescing
   * it would seat an unmeasured debate in the sample as an instantaneous one
   * and pull both percentiles down, which is the precise failure mode the
   * nullable column exists to prevent. (`SUM` skips NULLs within a debate, so
   * a debate with SOME measured calls still totals the calls it did measure.)
   */
  private perDebateBetween(
    where: string,
    params: string[],
    unattributed_calls: number,
  ): LlmPerDebateStats {
    const rows = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(cost_usd), 0) AS cost_usd,
           SUM(latency_ms)            AS llm_latency_ms
         FROM llm_spend ${where} AND debate_id IS NOT NULL
         GROUP BY debate_id`,
      )
      .all(...params) as Array<{ cost_usd: number; llm_latency_ms: number | null }>;

    const costs = rows.map((row) => row.cost_usd).sort(ascending);
    const latencies = rows
      .map((row) => row.llm_latency_ms)
      .filter((latency): latency is number => latency !== null)
      .sort(ascending);

    return {
      debates: rows.length,
      unattributed_calls,
      cost_usd_p50: percentile(costs, 0.5),
      cost_usd_p95: percentile(costs, 0.95),
      llm_latency_ms_p50: percentile(latencies, 0.5),
      llm_latency_ms_p95: percentile(latencies, 0.95),
    };
  }

  getAlertDeliveryFailureCount(asOf: Date): number {
    if (this.alertChatId === undefined) return 0;
    return this.alertDeliveryLog.countFailures(asOf, this.alertChatId);
  }
}

/**
 * `Array.prototype.sort` compares STRINGIFIED elements by default, which
 * orders [9, 10, 100] as [10, 100, 9] and would silently corrupt every
 * percentile below. Named rather than inlined so the reason it exists is not
 * mistaken for noise.
 */
function ascending(a: number, b: number): number {
  return a - b;
}

/**
 * Nearest-rank percentile over an ASCENDING-sorted array: the smallest value
 * at or above `fraction` of the way through. No interpolation — an
 * interpolated p95 reports a duration no debate actually took, and on an
 * operator surface a real observation beats a smoother one. p95 of a handful
 * of debates is therefore the slowest of them, which is the honest answer
 * when the sample is that small.
 *
 * Empty input returns 0: a window with no debates has no percentile, and the
 * tile renders 0 beside `debates: 0` rather than the caller having to unwrap
 * a null.
 *
 * Exported for its own unit tests — the arithmetic is small, load-bearing,
 * and exactly the kind that looks right while being off by one.
 */
export function percentile(sortedAscending: readonly number[], fraction: number): number {
  if (sortedAscending.length === 0) {
    return 0;
  }
  const rank = Math.ceil(fraction * sortedAscending.length);
  const index = Math.min(Math.max(rank, 1), sortedAscending.length) - 1;
  return sortedAscending[index] as number;
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
