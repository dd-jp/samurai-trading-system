/**
 * `buildSnapshot` — the dashboard's pure presentation seam (docs/specs/
 * dashboard-spec.md "Module: Snapshot"): a pure function of
 * `(DashboardQueryStore, asOf)` that projects the store's reads into a
 * JSON-serializable `DashboardSnapshot`. No I/O beyond the injected store
 * (dashboard-spec.md "Testing Decisions": assert on output given a fake
 * store, never on real database state).
 *
 * Unrealized PnL follows the cross-spec-contracts.md §4 rule exactly: always
 * `filled_size`, never `requested_size` — a partially filled lot is marked at
 * what actually filled. Recent-history window is fixed
 * (`RECENT_DEBATES_LIMIT` / `RECENT_VERDICTS_LIMIT`), no config surface yet.
 */
import { CONTRACT_VERSION, toProfitFactorWire } from '../../../contracts/index.js';
import type { AnalystContribution, Direction } from '../../pipeline/debate-engine/index.js';
import { OUTSIDE_BENCHMARKS } from '../../pipeline/outside-benchmark/index.js';
import {
  type EvaluatedCondition,
  type InvalidationObservable,
  unrealizedFor,
} from '../../pipeline/risk-manager/index.js';
import type { Mark } from '../../providers/market-data-service/index.js';
import type { ClosedTrade, Fill, TradingArm } from '../../shared/index.js';
import { isExitFill, totalQty, weightedAvgPrice } from '../../shared/index.js';
import type { StoreMode } from '../../shared/store/index.js';
import {
  LIVE_BOOK_GBP,
  SIZING_USD_PER_GBP,
  USD_PER_GBP_PROVENANCE,
} from '../orchestrator/index.js';
import { buildPipelineView, PIPELINE_LOOKBACK_MS, PIPELINE_MAX_LANES } from './pipeline-query.js';
import { buildPnlHeadline } from './pnl-headline.js';
import { NULL_PROVIDER_STATUS, type ProviderStatusReader } from './provider-status.js';
import type {
  ArmComparisonRow,
  ClosedTradeRow,
  DashboardQueryStore,
  DashboardSnapshot,
  EvaluatedConditionWire,
  FillRow,
  MetricsSuiteWire,
  OutsideBenchmarkRow,
  PositionRow,
  RiskCriticRecord,
  RiskCriticRow,
} from './types.js';

/**
 * `production.ts`'s `usd_per_gbp_provenance` is the same exported constant,
 * not a hand-kept second copy — an operator reading either surface sees the
 * same provenance sentence rather than two names for one rate.
 */
const USD_PER_GBP_SOURCE = USD_PER_GBP_PROVENANCE;

/** Matches the CLI views' default recent-history window; no config surface yet. */
const RECENT_DEBATES_LIMIT = 10;
const RECENT_VERDICTS_LIMIT = 10;
/** #940: same window size as the other recent-history lists above. */
const RECENT_CLOSED_TRADES_LIMIT = 10;
/**
 * #1066: the same fixed window again, for the same reason — this rides the
 * 3-second poll and must never grow with the decision history. The drawer
 * shows ONE decision at a time and says so when the trace it is showing is
 * older than this window, rather than substituting a newer one.
 *
 * Sized to the client's verdict ledger (`LEDGER_CAP`, 30) rather than to the
 * ten-row lists above: the ledger accumulates chips across polls, so a
 * flat-by-close burst can leave a still-selectable chip whose decision fell out
 * of a narrower window — the drawer would then report "no Risk decision" for a
 * trace visibly on screen. The cost of the wider window is bounded: each row
 * costs one primary-key read of `risk_critic_log`. The two constants cannot be
 * shared (neither runtime imports the other), so this one is deliberately a
 * duplicate of that cap, not a coincidence.
 */
const RECENT_RISK_CRITICS_LIMIT = 30;
/**
 * #971: how many Feedback Loop cycles the comparison panel plots. Same
 * fixed-window posture as the lists above; at FL's daily cadence this is a
 * fortnight of measurements, which is the soak length (#238) the panel has to
 * make legible.
 */
const RECENT_ARM_COMPARISONS_LIMIT = 14;
/**
 * Rows, not cycles (#981): one row per benchmark per cycle, so this is the same
 * fourteen cycles' worth the arm trend above shows. Kept in lockstep
 * deliberately — the two panels sit side by side and a benchmark trend reaching
 * further back than the matched control's would invite exactly the comparison
 * across mismatched periods #636 rules out. Derived from `OUTSIDE_BENCHMARKS`
 * rather than a literal `* 2`, so adding a third benchmark widens this instead
 * of silently truncating the trend to two-thirds of the cycles it claims.
 */
const RECENT_OUTSIDE_BENCHMARKS_LIMIT = RECENT_ARM_COMPARISONS_LIMIT * OUTSIDE_BENCHMARKS.length;

/**
 * The directions the wire may carry, as a value rather than a type.
 * `Record<Union, true>` so the `Direction` union is the authority — a new
 * member stops this compiling instead of silently passing an unrenderable
 * stance through.
 */
const WIRE_DIRECTIONS: Record<Direction, true> = { bullish: true, bearish: true, neutral: true };

function isDirection(value: unknown): value is Direction {
  return typeof value === 'string' && Object.hasOwn(WIRE_DIRECTIONS, value);
}

/**
 * Per-round stances, projected only when EVERY element is a `Direction` —
 * `contributions` is `JSON.parse` output of `debate_log.contributions_json`,
 * so its declared type is a claim about the row, not a guarantee. Missing or
 * corrupt omits the field, which the strip renders as its stated empty state;
 * filtering bad elements out would show a 3-round debate as a 2-round history.
 */
function stanceDuringDebate(
  contribution: AnalystContribution,
): { stance_during_debate: Direction[] } | Record<string, never> {
  const stances = contribution.stance_during_debate;
  if (!Array.isArray(stances) || !stances.every(isDirection)) return {};
  return { stance_during_debate: stances };
}

/**
 * What a condition measured, as one label (#1066).
 *
 * The same `kind:name` vocabulary `invalidationReasons` writes onto
 * `RiskDecision.reasons`, so a drawer row and an audit line name the same
 * observable — with the timeframe appended, which the reason line leaves to
 * the id and the drawer has room for. Projected HERE rather than on the wire
 * because `InvalidationObservable` nests `IndicatorSpec` and `BarWindow`, and
 * duplicating two server types into `contracts/` to rebuild one string in the
 * browser would put this vocabulary in two places and let them drift.
 */
function observableLabel(observable: InvalidationObservable): string {
  switch (observable.kind) {
    case 'mark':
      return 'mark';
    case 'indicator':
      return `indicator:${observable.spec.indicator}@${observable.spec.timeframe}`;
    case 'bars':
      return `bars:${observable.measure}@${observable.window.timeframe}`;
  }
}

/**
 * One measured condition, flattened. `observed` is carried across untouched —
 * `null` is "the read failed", and substituting a 0 would report a
 * measurement that never happened.
 */
function conditionRow(evaluated: EvaluatedCondition): EvaluatedConditionWire {
  return {
    id: evaluated.condition.id,
    observable: observableLabel(evaluated.condition.observable),
    comparator: evaluated.condition.comparator,
    threshold: evaluated.condition.threshold,
    state: evaluated.state,
    observed: evaluated.observed,
    rationale: evaluated.condition.rationale,
  };
}

/**
 * The critic's optional lists, projected as `null` when absent.
 *
 * `undefined` would be dropped by `JSON.stringify`, so "the row carries no
 * conditions" and "the field was never projected" would reach the browser as
 * the same bytes. A pre-fold row (migration 0040 backfilled nothing) takes
 * this path, and so does a post-fold verdict whose conditions half was absent
 * — which is correct: both are the one `no_conditions` state (#997 Q3).
 */
function nullableList<T, U>(list: readonly T[] | undefined, project: (item: T) => U): U[] | null {
  return list === undefined ? null : list.map(project);
}

function riskCriticRow(record: RiskCriticRecord): RiskCriticRow {
  const critic = record.critic;
  return {
    trace_id: record.trace_id,
    instrument: record.instrument,
    debate_id: record.debate_id,
    binding_constraint: record.binding_constraint,
    critic_verdict: critic?.verdict ?? null,
    reasoning: critic?.reasoning ?? null,
    conditions: critic === undefined ? null : nullableList(critic.conditions, conditionRow),
    dropped_conditions:
      critic === undefined
        ? null
        : nullableList(critic.dropped_conditions, (dropped) => ({ ...dropped })),
    created_at: record.created_at.toISOString(),
  };
}

/**
 * A closed trade's realized exit price, preferring reality over arithmetic.
 *
 * `closed_trades` has no `exit_price` column (0001_init.sql), so this is
 * always derived — but there are two ways to derive it, and they are not
 * equally trustworthy:
 *
 * 1. **The trade's own exit fills** (`leg !== 'entry'`): the venue's actual
 *    fill prices, qty-weighted. This is what really happened.
 * 2. **Algebra against `realized_pnl_net`**: `entry + (realized_pnl_net +
 *    fees_total) / filled_size` (sign-flipped for a sell). Exact when 1 is
 *    unavailable, but only as good as `entry` — which comes from real data
 *    here: `ClosedTrade.entry` is the avg entry fill price and `.stop` the
 *    original bracket's stop, both set in `ingest-fills.ts` from
 *    `avgEntryPrice`/`position.stop`. That is a different path from #826's
 *    zeroing, which applies to the flatten `OrderIntent`'s own
 *    entry/stop/target fields on a no-reference-price close, not to this
 *    trade's recorded `entry`/`stop`.
 *
 * `weightedExitFillPrice` is tried first — the same `weightedAvgPrice` the
 * execution stage used to write `ClosedTrade` — and the algebraic fallback
 * only runs when a trade has no exit fill on record.
 */
function weightedExitFillPrice(fills: readonly Fill[]): number | null {
  const exitFills = fills.filter(isExitFill);
  return totalQty(exitFills) === 0 ? null : weightedAvgPrice(exitFills);
}

function derivedExitPrice(trade: ClosedTrade): number {
  const grossPnl = trade.realized_pnl_net + trade.fees_total;
  const delta = grossPnl / trade.filled_size;
  return trade.side === 'buy' ? trade.entry + delta : trade.entry - delta;
}

function exitPriceFor(trade: ClosedTrade, fillsByTrade: ReadonlyMap<string, Fill[]>): number {
  const fills = fillsByTrade.get(trade.idempotency_key) ?? [];
  return weightedExitFillPrice(fills) ?? derivedExitPrice(trade);
}

/**
 * `providers` defaults to `NULL_PROVIDER_STATUS` (every tile
 * `not_configured`) rather than being required, so a dashboard started
 * without third-party credentials keeps working. The reader is injected
 * rather than called directly because it is the one input here that is live,
 * timer-refreshed state; taking it as a parameter is what preserves this
 * function's purity.
 *
 * `mode` and `arm` are both required, with NO default, deliberately (#539,
 * #1592). Each is a fact the caller must have already resolved — the run the
 * operator is looking at, and which arm's `positions`/`closed_trades` this
 * snapshot carries — and the one wrong answer that matters for both is a
 * silent, defaulted guess (`mode` reporting "paper" during a live run; `arm`
 * reporting 'live' rows for a request that asked for 'control'). Both sit
 * before `providers` for the same reason: a defaulted trailing parameter is
 * exactly the shape that lets a new call site forget it.
 */
export function buildSnapshot(
  store: DashboardQueryStore,
  asOf: Date,
  mode: StoreMode,
  arm: TradingArm,
  providers: ProviderStatusReader = NULL_PROVIDER_STATUS,
): DashboardSnapshot {
  const openPositions = store.getOpenPositions(asOf, arm);
  // One query for every position's mark rather than one per position — this
  // runs per dashboard HTTP request, not per tick. `getMarks` still throws for
  // an instrument with no mark, so a priceless row can never be rendered.
  const marks = store.getMarks(
    openPositions.map((position) => position.instrument),
    asOf,
  );

  const positions = openPositions.map<PositionRow>((position) => {
    const mark = marks.get(position.instrument) as Mark;
    return {
      idempotency_key: position.idempotency_key,
      instrument: position.instrument,
      asset_class: position.asset_class,
      side: position.side,
      filled_size: position.filled_size,
      avg_entry_price: position.avg_entry_price,
      stop: position.stop,
      target: position.target,
      order_state: position.order_state,
      mark_price: mark.price,
      unrealized_pnl: unrealizedFor(position, mark.price),
      opened_at: position.opened_at.toISOString(),
    };
  });

  // #1595: the Glance P&L headline. Reuses `positions` above for open
  // unrealized P&L rather than re-fetching marks, and a fresh unbounded read
  // (`getAllClosedTrades`, unlike the 10-row `getRecentClosedTrades` below)
  // for the all-time closed-trade population the headline needs.
  const pnl_headline = buildPnlHeadline({
    asOf,
    allClosedTrades: store.getAllClosedTrades(asOf, arm),
    openUnrealizedUsd: positions.reduce((sum, position) => sum + position.unrealized_pnl, 0),
    usdPerGbp: SIZING_USD_PER_GBP,
    bookGbp: LIVE_BOOK_GBP,
    conversionSource: USD_PER_GBP_SOURCE,
  });

  const debates = store.getRecentDebates(RECENT_DEBATES_LIMIT, asOf).map((debate) => ({
    debate_id: debate.debate_id,
    instrument: debate.instrument,
    direction: debate.direction,
    rounds: debate.rounds,
    created_at: debate.created_at.toISOString(),
    // #1396: omitted (not present as `undefined`) on a pre-migration row —
    // `exactOptionalPropertyTypes` forces the same conditional-spread form
    // `stanceDuringDebate` below already uses.
    ...(debate.termination === undefined ? {} : { termination: debate.termination }),
    ...(debate.termination_cause === undefined
      ? {}
      : { termination_cause: debate.termination_cause }),
    contributions: debate.contributions.map((c) => ({
      analyst_id: c.analyst_id,
      analyst_type: c.analyst_type,
      final_position: c.final_position,
      influence_score: c.influence_score,
      // #427/#599: how an analyst got there, not only where it ended up.
      ...stanceDuringDebate(c),
    })),
  }));

  const verdicts = store.getVerdictHistory(RECENT_VERDICTS_LIMIT, asOf).map((v) => ({
    trace_id: v.trace_id,
    instrument: v.instrument,
    status: v.status,
    reason: v.reason,
    hitl_override: v.hitl_override,
    timestamp: v.timestamp.toISOString(),
  }));

  // #1066: the Risk decisions the drawer's invalidation section reads, with
  // their critic verdicts and measured conditions already joined by the store.
  const risk_critics = store
    .getRiskCritics(RECENT_RISK_CRITICS_LIMIT, asOf)
    .map<RiskCriticRow>(riskCriticRow);

  const weights = store.getAnalystWeights(asOf);
  const attribution = store.getAttribution(asOf);
  const analysts = Object.keys(weights).map((analyst_id) => ({
    analyst_id,
    weight: weights[analyst_id] ?? 0,
    rolling_r: attribution[analyst_id]?.rolling_r ?? 0,
    window_days: attribution[analyst_id]?.window_days ?? 0,
  }));

  // #971: the Feedback Loop's matched-control comparisons, newest first. Read,
  // never recomputed here — FL owns the computation (#636), and this seam's job
  // is the `Date` → ISO conversion the wire needs. Whole `ArmPerformance`
  // values are carried across rather than picked apart, so no branch here can
  // produce a return without its drawdown (doc 12 D4).
  const arm_comparison = store
    .getArmComparisons(RECENT_ARM_COMPARISONS_LIMIT, asOf)
    .map<ArmComparisonRow>((sample) => ({
      computed_at: sample.computed_at.toISOString(),
      window_from: sample.comparison.from.toISOString(),
      window_to: sample.comparison.to.toISOString(),
      basis: sample.comparison.basis,
      live: { ...sample.comparison.live },
      control: { ...sample.comparison.control },
      diverged: sample.divergence.diverged,
      divergence_reason: sample.divergence.reason,
      // #982: the per-arm closed-trade floor THIS verdict was tested against,
      // carried across rather than read live off the current constant — see
      // `ArmComparisonRow.min_trades_per_arm`'s doc for why.
      min_trades_per_arm: sample.divergence.min_trades_per_arm,
    }));

  // #981: the Feedback Loop's outside benchmarks, newest first — SPY and 60/40
  // over the SAME window the arm comparisons above were measured over. Read,
  // never recomputed here, for the reason the arm rows are: FL owns the
  // computation (#636) and the page must show what FL actually measured.
  //
  // A benchmark FL could not measure this cycle is simply ABSENT — FL persists
  // nothing it could not measure — so this seam never invents a zero row to
  // fill a gap. The panel renders the absence as "not measured".
  const outside_benchmarks = store
    .getOutsideBenchmarks(RECENT_OUTSIDE_BENCHMARKS_LIMIT, asOf)
    .map<OutsideBenchmarkRow>((sample) => ({
      computed_at: sample.computed_at.toISOString(),
      benchmark: sample.performance.benchmark,
      window_from: sample.from.toISOString(),
      window_to: sample.to.toISOString(),
      buy_and_hold_return_pct: sample.performance.buy_and_hold_return_pct,
      max_drawdown_pct: sample.performance.max_drawdown_pct,
      observation_count: sample.performance.observation_count,
    }));

  // `toProfitFactorWire` doc (contracts/metrics.ts) has the full rationale (#1270).
  const dailyMetrics = store.getDailyMetrics(asOf);
  const metrics: MetricsSuiteWire = {
    ...dailyMetrics,
    profit_factor: toProfitFactorWire(dailyMetrics.profit_factor),
  };
  const tickStatus = store.getTickStatus(asOf);

  // #940: closed trades and their fills. Fills are fetched FOR the trades
  // just read (`getFillsForTrades`, keyed by idempotency_key) rather than as
  // an independent "recent fills" window — a separately-limited recent-fills
  // query would silently starve older closed trades of their fills the
  // moment open-position churn fills the window with entry-leg noise.
  const closedTradesDomain = store.getRecentClosedTrades(RECENT_CLOSED_TRADES_LIMIT, asOf, arm);
  const tradeFills = store.getFillsForTrades(
    closedTradesDomain.map((trade) => trade.idempotency_key),
    asOf,
  );
  const fillsByTrade = new Map<string, Fill[]>();
  for (const fill of tradeFills) {
    const forTrade = fillsByTrade.get(fill.idempotency_key);
    if (forTrade === undefined) {
      fillsByTrade.set(fill.idempotency_key, [fill]);
    } else {
      forTrade.push(fill);
    }
  }

  const closed_trades = closedTradesDomain.map<ClosedTradeRow>((trade) => ({
    idempotency_key: trade.idempotency_key,
    debate_id: trade.debate_id,
    instrument: trade.instrument,
    asset_class: trade.asset_class,
    side: trade.side,
    entry_price: trade.entry,
    exit_price: exitPriceFor(trade, fillsByTrade),
    filled_size: trade.filled_size,
    realized_pnl_net: trade.realized_pnl_net,
    fees_total: trade.fees_total,
    opened_at: trade.opened_at.toISOString(),
    closed_at: trade.closed_at.toISOString(),
    close_reason: trade.close_reason,
  }));

  const fills = tradeFills.map<FillRow>((fill) => ({
    idempotency_key: fill.idempotency_key,
    broker_fill_id: fill.broker_fill_id,
    leg: fill.leg,
    price: fill.price,
    qty: fill.qty,
    fee: fill.fee,
    timestamp: fill.timestamp.toISOString(),
  }));

  return {
    generated_at: new Date().toISOString(),
    as_of: asOf.toISOString(),
    mode,
    arm,
    pnl_headline,
    tick_status: tickStatus,
    positions,
    closed_trades,
    fills,
    debates,
    verdicts,
    risk_critics,
    analysts,
    metrics,
    arm_comparison,
    outside_benchmarks,
    alert_delivery_failures_24h: store.getAlertDeliveryFailureCount(asOf),
    providers: providers.readProviderStatus(),
    llm_spend: store.getLlmSpend(asOf),
    // Same `asOf` as every other field above, which is the reason the Pipeline
    // view rides this payload instead of its own endpoint: two polls would let
    // the lanes and the tables describe different instants and leave the
    // operator to reconcile them.
    pipeline: buildPipelineView(
      store.getPipelineActivity(PIPELINE_MAX_LANES, PIPELINE_LOOKBACK_MS, asOf),
    ),
    // The running server's stamp of its own wire shape (#1316) — always this
    // process's own compiled-in constant, never read from the store, so a
    // rebuild-without-restart (`server.ts` serves `dist/client/` per request)
    // is exactly what changes it.
    contract_version: CONTRACT_VERSION,
  };
}
