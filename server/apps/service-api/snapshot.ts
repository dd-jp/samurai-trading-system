import type { PnlHeadlineWire, PnlRateSource } from '../../../contracts/index.js';
import { CONTRACT_VERSION, toProfitFactorWire } from '../../../contracts/index.js';
import { cumulativePnl } from '../../pipeline/control-arm/index.js';
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
import { LIVE_BOOK_GBP, LIVE_BOOK_SIZING_USD, SIZING_USD_PER_GBP } from '../orchestrator/index.js';
import { buildPipelineView, PIPELINE_LOOKBACK_MS, PIPELINE_MAX_LANES } from './pipeline-query.js';
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

const RECENT_DEBATES_LIMIT = 10;
const RECENT_VERDICTS_LIMIT = 10;
const RECENT_CLOSED_TRADES_LIMIT = 10;
const RECENT_RISK_CRITICS_LIMIT = 30;
const RECENT_ARM_COMPARISONS_LIMIT = 14;
const RECENT_OUTSIDE_BENCHMARKS_LIMIT = RECENT_ARM_COMPARISONS_LIMIT * OUTSIDE_BENCHMARKS.length;

const WIRE_DIRECTIONS: Record<Direction, true> = { bullish: true, bearish: true, neutral: true };

function isDirection(value: unknown): value is Direction {
  return typeof value === 'string' && Object.hasOwn(WIRE_DIRECTIONS, value);
}

function stanceDuringDebate(
  contribution: AnalystContribution,
): { stance_during_debate: Direction[] } | Record<string, never> {
  const stances = contribution.stance_during_debate;
  if (!Array.isArray(stances) || !stances.every(isDirection)) return {};
  return { stance_during_debate: stances };
}

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

const LONDON_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' });

function londonCalendarDay(instant: Date): string {
  return LONDON_DAY.format(instant);
}

const PNL_RATE_SOURCE: PnlRateSource = 'static_sizing_rate';

function buildPnlHeadline(
  allClosedTrades: readonly ClosedTrade[],
  unrealizedUsd: number,
  asOf: Date,
): PnlHeadlineWire {
  const overall = cumulativePnl(allClosedTrades, LIVE_BOOK_SIZING_USD);
  const overallNetUsd = overall.net + unrealizedUsd;

  const today = londonCalendarDay(asOf);
  const closedToday = allClosedTrades.filter(
    (trade) => londonCalendarDay(trade.closed_at) === today,
  );
  const realizedTodayUsd = closedToday.reduce((sum, trade) => sum + trade.realized_pnl_net, 0);
  const costsTodayUsd = closedToday.reduce((sum, trade) => sum + trade.fees_total, 0);
  const netTodayUsd = realizedTodayUsd + unrealizedUsd;

  const toGbp = (usd: number) => usd / SIZING_USD_PER_GBP;

  return {
    overall: {
      net_gbp: toGbp(overallNetUsd),
      net_pct_of_book: toGbp(overallNetUsd) / LIVE_BOOK_GBP,
      max_drawdown_pct: overall.max_drawdown_pct,
      trade_count: allClosedTrades.length,
    },
    today: {
      net_gbp: toGbp(netTodayUsd),
      net_pct_of_book: toGbp(netTodayUsd) / LIVE_BOOK_GBP,
      realized_gbp: toGbp(realizedTodayUsd),
      unrealized_gbp: toGbp(unrealizedUsd),
      costs_gbp: toGbp(costsTodayUsd),
      trade_count: closedToday.length,
    },
    rate_usd_per_gbp: SIZING_USD_PER_GBP,
    rate_source: PNL_RATE_SOURCE,
    book_gbp: LIVE_BOOK_GBP,
  };
}

export function buildSnapshot(
  store: DashboardQueryStore,
  asOf: Date,
  mode: StoreMode,
  arm: TradingArm,
  providers: ProviderStatusReader = NULL_PROVIDER_STATUS,
): DashboardSnapshot {
  const openPositions = store.getOpenPositions(asOf, arm);
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

  const debates = store.getRecentDebates(RECENT_DEBATES_LIMIT, asOf).map((debate) => ({
    debate_id: debate.debate_id,
    instrument: debate.instrument,
    direction: debate.direction,
    rounds: debate.rounds,
    created_at: debate.created_at.toISOString(),
    ...(debate.termination === undefined ? {} : { termination: debate.termination }),
    ...(debate.termination_cause === undefined
      ? {}
      : { termination_cause: debate.termination_cause }),
    contributions: debate.contributions.map((c) => ({
      analyst_id: c.analyst_id,
      analyst_type: c.analyst_type,
      final_position: c.final_position,
      influence_score: c.influence_score,
      ...stanceDuringDebate(c),
    })),
  }));

  const verdicts = store.getVerdictHistory(RECENT_VERDICTS_LIMIT, asOf, arm).map((v) => ({
    trace_id: v.trace_id,
    instrument: v.instrument,
    status: v.status,
    reason: v.reason,
    hitl_override: v.hitl_override,
    timestamp: v.timestamp.toISOString(),
  }));

  const risk_critics = store
    .getRiskCritics(RECENT_RISK_CRITICS_LIMIT, asOf, arm)
    .map<RiskCriticRow>(riskCriticRow);

  const weights = store.getAnalystWeights(asOf);
  const attribution = store.getAttribution(asOf, arm);
  const analysts = Object.keys(weights).map((analyst_id) => ({
    analyst_id,
    weight: weights[analyst_id] ?? 0,
    rolling_r: attribution[analyst_id]?.rolling_r ?? 0,
    window_days: attribution[analyst_id]?.window_days ?? 0,
  }));

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
      min_trades_per_arm: sample.divergence.min_trades_per_arm,
    }));

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

  const dailyMetrics = store.getDailyMetrics(asOf, arm);
  const metrics: MetricsSuiteWire = {
    ...dailyMetrics,
    profit_factor: toProfitFactorWire(dailyMetrics.profit_factor),
  };
  const tickStatus = store.getTickStatus(asOf);

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

  const unrealizedUsd = positions.reduce((sum, position) => sum + position.unrealized_pnl, 0);
  const pnl = buildPnlHeadline(store.getAllClosedTrades(asOf, arm), unrealizedUsd, asOf);

  return {
    generated_at: new Date().toISOString(),
    as_of: asOf.toISOString(),
    mode,
    arm,
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
    pnl,
    alert_delivery_failures_24h: store.getAlertDeliveryFailureCount(asOf),
    providers: providers.readProviderStatus(),
    llm_spend: store.getLlmSpend(asOf),
    pipeline: buildPipelineView(
      store.getPipelineActivity(PIPELINE_MAX_LANES, PIPELINE_LOOKBACK_MS, asOf, arm),
    ),
    contract_version: CONTRACT_VERSION,
  };
}
