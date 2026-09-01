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

import { PIPELINE_STAGES, type PipelineStage } from '../../../contracts/pipeline.js';
import type { AnalystContribution, Direction } from '../../pipeline/debate-engine/index.js';
import { creditForContribution, realizedR } from '../../pipeline/feedback-loop/index.js';
import type { Mark } from '../../providers/market-data-service/index.js';
import type { ClosedTrade, DebateLog, Fill, OpenPosition, OrderState } from '../../shared/index.js';
import {
  type ClosedTradeRow,
  fromClosedTradeRow,
  type SharedStore,
} from '../../shared/store/index.js';
import { fromStoredTimestamp, toStoredTimestamp } from '../../shared/store/sqlite-utils.js';
import type { MetricsSuite } from '../../tools/backtest/index.js';
import type { AssetClass, TickStage } from '../orchestrator/index.js';
import type {
  AttributionSummary,
  DashboardQueryStore,
  LlmPerDebateStats,
  LlmSpendSummary,
  LlmSpendWindow,
  PipelineActivity,
  PipelineLiveTick,
  PipelineStageEvent,
  TickStatus,
  VerdictAuditEntry,
} from './types.js';

/** Mirrors execution-spec.md / SqliteExecutionStore's terminal-state exclusion. */
const TERMINAL_STATES: readonly OrderState[] = ['closed', 'cancelled', 'rejected', 'expired'];

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

/**
 * One `fills` row, the columns `getFillsForTrades` reads — deliberately
 * excludes `cost_breakdown_json`, which is a Simulated-adapter-only backtest
 * artifact (0001_init.sql) with no wire shape and no operator use here.
 */
interface FillRowSql {
  idempotency_key: string;
  broker_fill_id: string;
  leg: 'entry' | 'stop' | 'target' | 'exit';
  price: number;
  qty: number;
  fee: number;
  timestamp: string;
}

function fromFillRowSql(row: FillRowSql): Fill {
  return {
    idempotency_key: row.idempotency_key,
    broker_fill_id: row.broker_fill_id,
    leg: row.leg,
    price: row.price,
    qty: row.qty,
    fee: row.fee,
    timestamp: fromStoredTimestamp(row.timestamp),
  };
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
    opened_at: fromStoredTimestamp(row.opened_at),
    decision_timestamp: fromStoredTimestamp(row.decision_timestamp),
    conviction: row.conviction,
    converged: row.converged === 1,
  };
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
  constructor(
    private readonly db: SharedStore,
    private readonly attributionWindowDays = 30,
  ) {}

  /**
   * **LIVE arm only (#753)**, like every other read on this store. The dashboard
   * shows the book the system is actually trading; falsifier arm 2's shadow lots
   * are a measurement, not exposure, and mixing them into the operator's view of
   * open positions would misstate what is at risk. The two arms are compared
   * deliberately, through the arm comparison report, not incidentally here.
   */
  getOpenPositions(asOf: Date): OpenPosition[] {
    const placeholders = TERMINAL_STATES.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT * FROM open_positions
          WHERE arm = 'live' AND order_state NOT IN (${placeholders}) AND opened_at <= ?
          ORDER BY opened_at`,
      )
      .all(...TERMINAL_STATES, toStoredTimestamp(asOf)) as OpenPositionRow[];
    return rows.map(fromOpenPositionRow);
  }

  /** #940: `closed_trades`' mirror of `getRecentDebates`/`getVerdictHistory` below. */
  getRecentClosedTrades(limit: number, asOf: Date): ClosedTrade[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM closed_trades
          WHERE arm = 'live' AND closed_at <= ?
          ORDER BY closed_at DESC LIMIT ?`,
      )
      .all(toStoredTimestamp(asOf), limit) as ClosedTradeRow[];
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
        `SELECT idempotency_key, broker_fill_id, leg, price, qty, fee, timestamp
           FROM fills
          WHERE idempotency_key IN (${placeholders})
          ORDER BY idempotency_key, rowid`,
      )
      .all(...idempotencyKeys) as FillRowSql[];
    return rows.map(fromFillRowSql);
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

  getVerdictHistory(limit: number, asOf: Date): VerdictAuditEntry[] {
    const rows = this.db
      .prepare(`SELECT * FROM verdict_log WHERE timestamp <= ? ORDER BY timestamp DESC LIMIT ?`)
      .all(toStoredTimestamp(asOf), limit) as VerdictLogRow[];
    return rows.map(fromVerdictLogRow);
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
   */
  getAttribution(asOf: Date): Record<string, AttributionSummary> {
    const from = new Date(asOf.getTime() - this.attributionWindowDays * 24 * 60 * 60 * 1000);
    const rows = this.db
      .prepare(
        `SELECT closed_trades.*, debate_log.contributions_json AS debate_contributions_json
           FROM closed_trades
           JOIN debate_log ON debate_log.debate_id = closed_trades.debate_id
          WHERE closed_trades.arm = 'live'
            AND closed_trades.closed_at > ? AND closed_trades.closed_at <= ?`,
      )
      .all(toStoredTimestamp(from), toStoredTimestamp(asOf)) as AttributionRow[];

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

  getDailyMetrics(asOf: Date): MetricsSuite {
    const from = new Date(asOf.getTime() - 24 * 60 * 60 * 1000);
    const rows = this.db
      .prepare(
        `SELECT * FROM closed_trades WHERE arm = 'live' AND closed_at > ? AND closed_at <= ?`,
      )
      .all(toStoredTimestamp(from), toStoredTimestamp(asOf)) as ClosedTradeRow[];
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
  getLlmSpend(asOf: Date): LlmSpendSummary {
    const until = toStoredTimestamp(asOf);
    const dayAgo = toStoredTimestamp(new Date(asOf.getTime() - 24 * 60 * 60 * 1000));
    const weekAgo = toStoredTimestamp(new Date(asOf.getTime() - 7 * 24 * 60 * 60 * 1000));
    return {
      last_24h: this.spendBetween(dayAgo, until),
      last_7d: this.spendBetween(weekAgo, until),
      // Open-ended lower bound rather than a sentinel date: an ISO TEXT
      // comparison against '' is true for every well-formed timestamp, but
      // relying on that is a trick the next reader has to decode.
      all_time: this.spendBetween(null, until),
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
   * The remaining NULLs are rows predating 0013 and the HITL Telegram callback
   * path, which records under an existing `trace_id` with no `Signal` in scope
   * — both mean "not attributable", never "no instrument", and neither may be
   * guessed into a lane.
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
  getPipelineActivity(maxLanes: number, lookbackMs: number, asOf: Date): PipelineActivity {
    const until = toStoredTimestamp(asOf);
    const from = toStoredTimestamp(new Date(asOf.getTime() - lookbackMs));

    // Three sources, and the invariant is that ACTIVITY defines the universe
    // while PRICING only extends it (#619):
    //
    //  - `audit_log` in the window — every instrument the pipeline actually
    //    ran. This is the source the lanes are built from, so a lane can no
    //    longer be missing for an instrument whose trace is right there.
    //  - `current_tick` in the window — a tick that has entered a stage but
    //    not yet recorded one, so it has no audit row for a few seconds.
    //  - `latest_mark` — one upserted row per instrument the Market Data
    //    Service has PRICED, on demand rather than per tick. It is not the
    //    tick universe and never was; it is here so a priced instrument with
    //    no recent activity reads as an IDLE lane rather than vanishing (a
    //    closed market is the common, correct reason to be quiet).
    //
    // No stage filter on the audit arm: any attributed audit row means the bot
    // touched that instrument, so it belongs in the universe. Whether it gets
    // a TRACE is `pipelineEvents`' stage filter's job.
    //
    // `active` decides who survives `maxLanes`, not who renders first: a
    // stale priced instrument must never evict a live one at the cap, which is
    // this ticket's own failure mode arriving by a different door. The outer
    // ORDER BY restores lane order; wire order is `buildPipelineView`'s call.
    //
    // An instrument has exactly one asset class. `GROUP BY instrument` plus
    // `MIN(asset_class)` is what makes a violation of that render the same way
    // on every poll instead of flapping between the sources that disagree — an
    // aggregate rather than a bare column, so nothing here rests on which row
    // SQLite happens to pick. `MIN` because it also sorts the conflicted lane
    // earliest below, so bad data cannot additionally cost it its lane at the
    // cap.
    const universe = this.db
      .prepare(
        `SELECT instrument, asset_class FROM (
           SELECT instrument, MIN(asset_class) AS asset_class, MAX(active) AS active FROM (
             SELECT DISTINCT instrument, asset_class, 1 AS active FROM audit_log
               WHERE timestamp > ? AND timestamp <= ?
                 AND instrument IS NOT NULL AND asset_class IS NOT NULL
             UNION ALL
             SELECT instrument, asset_class, 1 FROM current_tick
               WHERE updated_at > ? AND updated_at <= ?
             UNION ALL
             SELECT instrument, asset_class, 0 FROM latest_mark
           )
           GROUP BY instrument
           ORDER BY active DESC, asset_class, instrument
           LIMIT ?
         )
         ORDER BY asset_class, instrument`,
      )
      .all(from, until, from, until, maxLanes) as UniverseRow[];
    const laneInstruments = new Set(universe.map((row) => row.instrument));

    // The window applies to `current_tick` too, unlike `getTickStatus`, which
    // takes the latest row unconditionally. A crash mid-tick deliberately
    // leaves the row behind (tick-runner.ts: a stale row must be visible, not
    // tidied away), and a lane that showed it forever would report a dead tick
    // as running until that instrument next completed a tick.
    const live = (
      this.db
        .prepare(
          `SELECT instrument, asset_class, stage, trace_id, updated_at FROM current_tick
            WHERE updated_at > ? AND updated_at <= ?
            ORDER BY updated_at DESC`,
        )
        .all(from, until) as PipelineTickRow[]
    )
      .filter((row) => laneInstruments.has(row.instrument))
      // #743: a tick-path pass upserts `stage: 'position_check'`, which is not
      // a decision-chain stage and has no lane column — the lane view renders
      // the decision chain, and after the split ~29 of 30 passes are tick-path.
      // Excluded here rather than widened into `PIPELINE_STAGES`, so the lanes
      // keep meaning "where is the decision", while `getTickStatus` (the
      // telemetry strip's in-flight indicator) still reports the pass.
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
      events: this.pipelineEvents(laneInstruments, from, until),
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
   * arm word for word. The two must agree on what "attributed" means: a row
   * naming an instrument with no asset class is not renderable, and letting it
   * win `chosenTrace` would blank a lane whose real trace sits in the same
   * window — the identical symptom, one path over.
   *
   * The `stage IN (…)` filter is not defensive tidiness: `audit_log.stage` is
   * unconstrained TEXT and the HITL Telegram callback writes
   * `verdict.hitl.telegram_callback` rows under the pipeline's own `trace_id`
   * (telegram-bot-api-client.ts:112). Without the filter those land in a lane
   * as an eighth, unrenderable stage.
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
            AND stage IN (${stagePlaceholders})
          ORDER BY timestamp, rowid`,
      )
      .all(fromIso, untilIso, ...PIPELINE_STAGES) as AuditStageRow[];

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
