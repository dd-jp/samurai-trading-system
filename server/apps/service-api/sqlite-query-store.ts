/**
 * `SqliteQueryStore` — the SQLite-backed `DashboardQueryStore`. Read-only:
 * every method selects from tables owned by other components.
 * Timestamps are ISO-8601 UTC TEXT, lexicographically comparable, which `asOf` filtering below relies on.
 * `sharpe`/`sortino`/etc. need an equity-curve/capital-series table the schema doesn't have, so they return 0 rather than a synthesized (misleading) value.
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

/** One `risk_log` row with the `debate_id` its `trader_log` twin recorded; NULL if no such row exists. */
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
  /** NULL for rows written before migration 0013, and for non-tick audit rows */
  instrument: string | null;
  asset_class: AssetClass | null;
}

/** `closed_trades` joined with its `debate_log` row, for `getAttribution`'s single-query read */
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
    // NULL (pre-migration, or nothing to report) is omitted entirely rather
    // than set to `undefined` — required by `exactOptionalPropertyTypes`.
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
 * The SQL operator that keeps a row for the named arm: live excludes rows
 * carrying the control markers, control keeps only rows that do. Returned as
 * a validated union rather than built inline, so a typo can't silently
 * filter the wrong arm.
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
  /** How far back `getAttribution` looks; not in the schema, so a constructor option defaulting to 30 days. */
  /** The Feedback Loop's own sample store, read (never written) here. */
  private readonly armComparisons: SqliteArmComparisonSampleStore;
  private readonly outsideBenchmarks: SqliteOutsideBenchmarkSampleStore;
  /** The Risk Manager's own critic log, read (never written) here. */
  private readonly critics: SqliteRiskCriticStore;
  /** The orchestrator's own alert-delivery-failure log, read (never written) here. */
  private readonly alertDeliveryLog: SqliteAlertDeliveryLog;
  /** The cap the orchestrator armed, read via the same store class it writes through — never a second copy of the number. */
  private readonly spendCap: SqliteLlmSpendCapStore;

  constructor(
    private readonly db: StoreHandle,
    private readonly attributionWindowDays = 30,
    /**
     * The chat `alert_delivery_failures.chat_id` is scoped against, normalized
     * the same way `alert-transport.ts` reads `TELEGRAM_CHAT_ID` so the two
     * agree. `undefined` (unconfigured) reads as 0 rather than guessing a chat.
     */
    private readonly alertChatId?: string,
  ) {
    this.armComparisons = new SqliteArmComparisonSampleStore(db);
    this.outsideBenchmarks = new SqliteOutsideBenchmarkSampleStore(db);
    this.critics = new SqliteRiskCriticStore(db);
    this.alertDeliveryLog = new SqliteAlertDeliveryLog(db);
    this.spendCap = new SqliteLlmSpendCapStore(db);
  }

  /** Exactly one arm's rows, like every other read on this store — the other arm's lots are a measurement, not this arm's exposure. */
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

  /** `closed_trades`' mirror of `getRecentDebates`/`getVerdictHistory`. Exactly one arm's rows, like `getOpenPositions`. */
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
   * Unbounded (no `LIMIT`), unlike `getRecentClosedTrades` — the all-time
   * drawdown headline needs the whole realized series, not a windowed one.
   * Also unfiltered on `oneSizingRegime`/`modelled_cost_charged`, unlike
   * `SqliteArmComparisonSource.getClosedTradeWindowBetween` — deliberately a
   * different population of the same table (see `PnlOverallWire`).
   */
  getAllClosedTrades(asOf: Date, arm: TradingArm): ClosedTrade[] {
    const rows = this.db
      .prepare(`SELECT * FROM closed_trades WHERE arm = ? AND closed_at <= ? ORDER BY closed_at`)
      .all(arm, toStoredTimestamp(asOf)) as ClosedTradeRow[];
    return rows.map(fromClosedTradeRow);
  }

  /** Every fill for the named lots — scoped by `idempotency_key IN (...)` rather than a time window, since the caller always passes exactly the lots being rendered. */
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
   * Scoped by `arm`, like `getOpenPositions`. `verdict_log` has no `arm`
   * column, so this discriminates on `trace_id` (`CONTROL_TRACE_SUFFIX`) instead.
   * Filter is in `WHERE`, ahead of `ORDER BY ... LIMIT` — filtering after
   * would let the other arm's rows displace this arm's out of the page.
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
   * Recent Risk decisions, each with the critic verdict it was reached with.
   * Driven from `risk_log` (its primary key is the `(trace_id, instrument)`
   * pair the caller holds) rather than `risk_critic_log`, since a retried
   * tick keeps the same content-hashed `debate_id` under a fresh `trace_id`
   * and driving off it would fan out.
   * Scoped by `arm` via both `trace_id` and (nullable) `debate_id`; the NULL
   * branch stays permissive in both directions so a decision with a missing
   * `trader_log` row isn't dropped for either arm. A control-arm row's
   * `critic` is `undefined` — the control makes Risk decisions but consults
   * no model, so "not applicable" rather than "excluded".
   * Delegates the per-row critic read to `SqliteRiskCriticStore.getByDebateId`
   * rather than a second JSON parser, and is built with no logger since that
   * store already warns once per malformed row.
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
   * One joined query rather than a per-trade `debate_log` lookup — a trade
   * with no matching debate row is excluded by the `JOIN` itself.
   * This duplicates the Feedback Loop's own exclusion logic
   * (`getContributionsForAttribution`) rather than calling it, so the two
   * must stay in sync: `termination IS NOT 'latency_truncated'` keeps NULL
   * (pre-migration) rows, same as that function.
   * Scoped by `arm`, like `getOpenPositions`; `getAttribution(asOf, 'control')`
   * always returns `{}` since the control arm never writes `debate_log`.
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

  /** Scoped by `arm`, like `getAttribution` above */
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
    // Delegates so there is exactly one place that decides what a mark is
    return this.getMarks([instrument], asOf).get(instrument) as Mark;
  }

  getMarks(instruments: readonly string[], _asOf: Date): Map<string, Mark> {
    const marks = new Map<string, Mark>();
    if (instruments.length === 0) return marks;

    // `latest_mark` upserts one row per instrument (no history) — the only
    // truth available is the latest known mark, regardless of `asOf`
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

    // Per-instrument, so a missing mark fails loudly rather than silently
    // rendering a priceless row
    for (const instrument of instruments) {
      if (!marks.has(instrument)) {
        throw new Error(`SqliteQueryStore.getMark: no mark for instrument "${instrument}"`);
      }
    }

    return marks;
  }

  /** Delegates to the Feedback Loop's own store rather than re-issuing its SELECT — two hand-written copies of the same row mapping is how a column gets dropped on one side. */
  getArmComparisons(limit: number, asOf: Date): PersistedArmComparisonSample[] {
    return this.armComparisons.getRecent(limit, asOf);
  }

  /** Delegates to the Feedback Loop's own store, for the same reason as `getArmComparisons`. */
  getOutsideBenchmarks(limit: number, asOf: Date): OutsideBenchmarkSample[] {
    return this.outsideBenchmarks.getRecent(limit, asOf);
  }

  getLlmSpend(asOf: Date): LlmSpendSummary {
    const until = toStoredTimestamp(asOf);
    const dayAgo = toStoredTimestamp(new Date(asOf.getTime() - 24 * 60 * 60 * 1000));
    const weekAgo = toStoredTimestamp(new Date(asOf.getTime() - 7 * 24 * 60 * 60 * 1000));
    // Not defaulted here — `armedAt` distinguishes "armed uncapped" from
    // "never armed" (see `SqliteLlmSpendCapStore.read`)
    const cap = this.spendCap.read();
    return {
      last_24h: this.spendBetween(dayAgo, until),
      last_7d: this.spendBetween(weekAgo, until),
      all_time: this.spendBetween(null, until),
      cap_usd: cap.budgetUsd,
      cap_armed_at: cap.armedAt,
    };
  }

  /**
   * Lane universe, attributed stage rows, and in-flight ticks, in three
   * bounded queries. Instrument attribution comes from `audit_log.instrument`
   * /`.asset_class` (migration 0013) — not from `llm_spend.debate_id ->
   * debate_log.instrument`, which misses `quorum_skip` ticks and can silently
   * drop a lane on a metering write failure.
   * Bounded for a 3-second poll: `maxLanes` caps the universe, `lookbackMs`
   * caps the window, both ride `idx_audit_log_timestamp`.
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

    // Three sources: `audit_log` in the window (every instrument the named
    // arm actually ran and attributed — filtered by `trace_id` since
    // `audit_log` has no `arm` column) is what lanes are built from;
    // `current_tick` extends it for the LIVE arm only; `latest_mark` extends
    // it without defining it, so a priced-but-idle instrument reads as an
    // IDLE lane rather than vanishing.
    //
    // `current_tick` is live-only STRUCTURALLY, not by filter: the control
    // arm uses its own in-memory `InMemoryCurrentTickStore` (never
    // persisted), so the leg is omitted entirely for `arm === 'control'`
    // rather than filtered (matching ADR-0021's 2026-09-15 amendment).
    //
    // `active` (not row order) decides who survives `maxLanes`, so a stale
    // priced instrument can never evict an active one at the cap.
    //
    // `GROUP BY instrument` + `MIN(asset_class)`: if the sources disagree on
    // an instrument's asset class, this renders the same choice every poll
    // rather than flapping.
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

    // The window applies to `current_tick` too, unlike `getTickStatus` — a
    // crash mid-tick deliberately leaves the row behind, and without a
    // window a dead tick would show as running forever.
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
            // `position_check` is a tick-path stage, not a decision-chain one,
            // and has no lane column — excluded so lanes keep meaning "where
            // is the decision" (`getTickStatus` still reports it).
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
   * Stage rows for the newest trace of each lane instrument. Driven off
   * `audit_log` (since migration 0013) — the only trace_id -> instrument link
   * that survives a short-circuited tick (e.g. a `quorum_skip`).
   * Scoped by `arm` via `trace_id` (`audit_log` has no `debate_id` column),
   * filtered in `WHERE` before the newest-wins fold: the control arm's pass
   * nests inside the live pass and writes to this same table, so an
   * unfiltered fold could let an older control row outrank a newer live one
   * for a given instrument. Filtering removes the other arm's ROWS, not its
   * instruments — a shared instrument still renders its own sequence.
   * `stage IN (...)` excludes non-`PIPELINE_STAGES` rows (e.g. the retired
   * HITL Telegram callback's) that would otherwise render as an extra stage.
   * `ORDER BY timestamp, rowid`: `audit_log` has no primary key and a fixed
   * clock can put several stages on the same millisecond.
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

    // One trace per instrument, newest wins — rows arrive oldest-first, so a
    // later row simply overwrites the claim.
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

  // `SUM(cost_usd)` skips NULLs (unpriced calls contribute tokens but no
  // dollars); `unpriced_calls` is counted alongside so that's visible.
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
   * Per-decision cost and latency: one `GROUP BY debate_id` in SQL, then
   * percentiles in JS (SQLite has no percentile function).
   * `debate_id IS NULL` rows are excluded from grouping and reported as
   * `unattributed_calls` instead, rather than folded into one outlier
   * pseudo-debate.
   * A debate with no measured latency (pre-migration 0012) is left out of the
   * latency sample entirely — `SUM(latency_ms)` is not `COALESCE`d, so it's
   * NULL rather than 0, which would otherwise drag both percentiles down.
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

/** `Array.prototype.sort` compares stringified elements by default ([9,10,100] -> [10,100,9]), which would corrupt every percentile below. */
function ascending(a: number, b: number): number {
  return a - b;
}

/**
 * Nearest-rank percentile, no interpolation — an interpolated p95 reports a
 * duration no debate actually took. Empty input returns 0 rather than a null
 * callers have to unwrap.
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
