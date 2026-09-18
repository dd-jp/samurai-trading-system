import type { PipelineStage } from '../../../contracts/index.js';
import type { AnalystContribution } from '../../pipeline/debate-engine/index.js';
import { computeInfluenceScore } from '../../pipeline/debate-engine/index.js';
import {
  MIN_TRADES_PER_ARM_FOR_DIVERGENCE,
  type PersistedArmComparisonSample,
} from '../../pipeline/feedback-loop/index.js';
import type { OutsideBenchmarkSample } from '../../pipeline/outside-benchmark/index.js';
import type { Mark } from '../../providers/market-data-service/index.js';
import type { ClosedTrade, DebateLog, Fill, OpenPosition, TradingArm } from '../../shared/index.js';
import { toBrokerFillId } from '../../shared/index.js';
import type { MetricsSuite } from '../../tools/backtest/index.js';
import type {
  AttributionSummary,
  DashboardQueryStore,
  LlmSpendSummary,
  PipelineActivity,
  PipelineLiveTick,
  PipelineStageEvent,
  RiskCriticRecord,
  TickStatus,
  VerdictAuditEntry,
} from './types.js';

const NOW = new Date('2026-07-19T14:30:00Z');

function minutesAgo(min: number): Date {
  return new Date(NOW.getTime() - min * 60_000);
}
function hoursAgo(h: number): Date {
  return new Date(NOW.getTime() - h * 3_600_000);
}

const MARKS: Record<string, Mark> = {
  'BTC-USD': {
    price: 67_250.5,
    observed_at: minutesAgo(1),
    source: 'kraken',
    asset_class: 'crypto',
  },
  'ETH-USD': {
    price: 3_512.8,
    observed_at: minutesAgo(1),
    source: 'kraken',
    asset_class: 'crypto',
  },
  AAPL: { price: 228.41, observed_at: minutesAgo(1), source: 'alpaca', asset_class: 'stocks' },
  TSLA: { price: 246.18, observed_at: minutesAgo(1), source: 'alpaca', asset_class: 'stocks' },
  SPY: { price: 557.92, observed_at: minutesAgo(1), source: 'alpaca', asset_class: 'stocks' },
  QQQ: { price: 489.13, observed_at: minutesAgo(1), source: 'alpaca', asset_class: 'stocks' },
};

const OPEN_POSITIONS: OpenPosition[] = [
  {
    idempotency_key: 'BTC-USD-2026-07-19T13:00:00Z',
    debate_id: 'debate-btc-001',
    instrument: 'BTC-USD',
    asset_class: 'crypto',
    side: 'buy',
    intent_type: 'entry',
    requested_size: 0.3,
    filled_size: 0.3,
    avg_entry_price: 66_100,
    stop: 64_200,
    target: 70_500,
    order_state: 'filled',
    broker_order_ids: ['kraken-1'],
    opened_at: hoursAgo(1.5),
    decision_timestamp: hoursAgo(1.5),
    conviction: 0.72,
    converged: true,
  },
  {
    idempotency_key: 'ETH-USD-2026-07-19T11:30:00Z',
    debate_id: 'debate-eth-002',
    instrument: 'ETH-USD',
    asset_class: 'crypto',
    side: 'sell',
    intent_type: 'entry',
    requested_size: 4,
    filled_size: 4,
    avg_entry_price: 3_580,
    stop: 3_720,
    target: 3_290,
    order_state: 'filled',
    broker_order_ids: ['kraken-2'],
    opened_at: hoursAgo(3),
    decision_timestamp: hoursAgo(3),
    conviction: 0.68,
    converged: true,
  },
  {
    idempotency_key: 'AAPL-2026-07-19T09:35:00Z',
    debate_id: 'debate-aapl-003',
    instrument: 'AAPL',
    asset_class: 'stocks',
    side: 'buy',
    intent_type: 'entry',
    requested_size: 100,
    filled_size: 100,
    avg_entry_price: 224.1,
    stop: 218.5,
    target: 236,
    order_state: 'filled',
    broker_order_ids: ['alpaca-1'],
    opened_at: hoursAgo(5),
    decision_timestamp: hoursAgo(5),
    conviction: 0.61,
    converged: false,
  },
];

const CLOSED_TRADES: ClosedTrade[] = [
  {
    idempotency_key: 'SPY-2026-07-19T06:30:00Z',
    debate_id: 'debate-spy-101',
    instrument: 'SPY',
    asset_class: 'stocks',
    side: 'buy',
    entry: 552.1,
    stop: 545.0,
    filled_size: 20,
    realized_pnl_net: 151.6,
    fees_total: 2.4,
    opened_at: hoursAgo(8),
    closed_at: hoursAgo(6.5),
    close_reason: 'target',
    modelled_cost_charged: true,
  },
  {
    idempotency_key: 'QQQ-2026-07-19T04:30:00Z',
    debate_id: 'debate-qqq-102',
    instrument: 'QQQ',
    asset_class: 'stocks',
    side: 'sell',
    entry: 495.6,
    stop: 500.5,
    filled_size: 15,
    realized_pnl_net: -69.3,
    fees_total: 1.8,
    opened_at: hoursAgo(10),
    closed_at: hoursAgo(9),
    close_reason: 'stop',
    modelled_cost_charged: true,
  },
];

const FILLS: Fill[] = [
  {
    idempotency_key: 'SPY-2026-07-19T06:30:00Z',
    broker_fill_id: toBrokerFillId('alpaca-fill-spy-entry'),
    leg: 'entry',
    price: 552.1,
    qty: 20,
    fee: 1.2,
    timestamp: hoursAgo(8),
  },
  {
    idempotency_key: 'SPY-2026-07-19T06:30:00Z',
    broker_fill_id: toBrokerFillId('alpaca-fill-spy-target'),
    leg: 'target',
    price: 559.8,
    qty: 20,
    fee: 1.2,
    timestamp: hoursAgo(6.5),
  },
  {
    idempotency_key: 'QQQ-2026-07-19T04:30:00Z',
    broker_fill_id: toBrokerFillId('alpaca-fill-qqq-entry'),
    leg: 'entry',
    price: 495.6,
    qty: 15,
    fee: 0.9,
    timestamp: hoursAgo(10),
  },
  {
    idempotency_key: 'QQQ-2026-07-19T04:30:00Z',
    broker_fill_id: toBrokerFillId('alpaca-fill-qqq-stop'),
    leg: 'stop',
    price: 500.1,
    qty: 15,
    fee: 0.9,
    timestamp: hoursAgo(9),
  },
];

const RECENT_DEBATES: DebateLog[] = [
  {
    debate_id: 'debate-btc-001',
    instrument: 'BTC-USD',
    bar_timestamp: hoursAgo(1.5),
    direction: 'bullish',
    rounds: 3,
    created_at: hoursAgo(1.5),
    contributions: [
      contribution('technical', ['bearish', 'neutral', 'bullish']),
      contribution('fundamental', ['neutral', 'neutral', 'bullish']),
      contribution('sentiment', ['neutral', 'neutral', 'neutral']),
    ],
  },
  {
    debate_id: 'debate-eth-002',
    instrument: 'ETH-USD',
    bar_timestamp: hoursAgo(3),
    direction: 'bearish',
    rounds: 2,
    created_at: hoursAgo(3),
    contributions: [
      contribution('technical', ['neutral', 'bearish']),
      contribution('fundamental', ['neutral', 'neutral']),
      unrecordedContribution('sentiment', 'bearish'),
    ],
  },
  {
    debate_id: 'debate-aapl-003',
    instrument: 'AAPL',
    bar_timestamp: hoursAgo(5),
    direction: 'bullish',
    rounds: 3,
    created_at: hoursAgo(5),
    contributions: [
      contribution('technical', ['neutral', 'bullish', 'bullish']),
      contribution('fundamental', ['bearish', 'bearish', 'bullish']),
      contribution('sentiment', ['neutral', 'neutral', 'neutral']),
    ],
  },
  {
    debate_id: 'debate-tsla-004',
    instrument: 'TSLA',
    bar_timestamp: hoursAgo(6),
    direction: 'neutral',
    rounds: 3,
    created_at: hoursAgo(6),
    contributions: [
      contribution('technical', ['bearish', 'bullish', 'neutral']),
      contribution('fundamental', ['neutral', 'bearish', 'bearish']),
      contribution('sentiment', ['neutral', 'neutral', 'bullish']),
    ],
  },
];

function assertStanceLengthsMatchRounds(debates: readonly DebateLog[]): void {
  for (const debate of debates) {
    for (const entry of debate.contributions) {
      const recorded = entry.stance_during_debate.length;
      if (recorded !== 0 && recorded !== debate.rounds) {
        throw new Error(
          `fixture ${debate.debate_id}: ${entry.analyst_id} records ${recorded} round stance(s) for a ${debate.rounds}-round debate — expected ${debate.rounds} or 0 (none recorded)`,
        );
      }
    }
  }
}

assertStanceLengthsMatchRounds(RECENT_DEBATES);

type Stance = AnalystContribution['stance_during_debate'][number];
type FinalPosition = AnalystContribution['final_position'];

type RecordedStances = readonly [Stance, ...Stance[]];

function contribution(type: string, stances: RecordedStances): AnalystContribution {
  const [opening, ...laterRounds] = stances;
  return {
    analyst_id: `${type}-analyst`,
    analyst_type: type,
    stance_during_debate: [...stances],
    final_position: laterRounds.at(-1) ?? opening,
    rationale: `Round-by-round ${type} read on the instrument.`,
    influence_score: computeInfluenceScore([...stances]),
  };
}

function unrecordedContribution(type: string, final: FinalPosition): AnalystContribution {
  return {
    analyst_id: `${type}-analyst`,
    analyst_type: type,
    stance_during_debate: [],
    final_position: final,
    rationale: `Opening ${type} read on the instrument; no round stances recorded.`,
    influence_score: computeInfluenceScore([]),
  };
}

const VERDICT_HISTORY: VerdictAuditEntry[] = [
  {
    trace_id: 'trace-001',
    instrument: 'BTC-USD',
    status: 'go',
    reason: 'approved',
    hitl_override: false,
    timestamp: hoursAgo(1.5),
  },
  {
    trace_id: 'trace-002',
    instrument: 'ETH-USD',
    status: 'go',
    reason: 'approved',
    hitl_override: false,
    timestamp: hoursAgo(3),
  },
  {
    trace_id: 'trace-003',
    instrument: 'AAPL',
    status: 'go',
    reason: 'approved',
    hitl_override: false,
    timestamp: hoursAgo(5),
  },
  {
    trace_id: 'trace-004',
    instrument: 'TSLA',
    status: 'no_go',
    reason: 'risk_max_positions',
    hitl_override: false,
    timestamp: hoursAgo(6),
  },
  {
    trace_id: 'trace-005',
    instrument: 'SPY',
    status: 'no_go',
    reason: 'verdict_low_conviction',
    hitl_override: false,
    timestamp: hoursAgo(7),
  },
  {
    trace_id: 'trace-006',
    instrument: 'QQQ',
    status: 'no_go',
    reason: 'risk_correlation',
    hitl_override: true,
    timestamp: hoursAgo(8),
  },
];

const RISK_CRITICS: RiskCriticRecord[] = [
  {
    trace_id: 'trace-001',
    instrument: 'BTC-USD',
    debate_id: 'debate-btc-001',
    binding_constraint: 'risk_critic:invalidated',
    critic: {
      verdict: 'pass',
      max_notional: null,
      reasoning: 'the breakout has volume behind it and the stop sits under structure',
      conditions: [
        {
          condition: {
            id: 'mark-breaks-back-under-entry',
            observable: { kind: 'mark' },
            comparator: '<',
            threshold: 61_200,
            rationale: 'a break back under the entry level falsifies the breakout',
          },
          state: 'breached',
          observed: 60_940.5,
        },
        {
          condition: {
            id: 'participation-thins',
            observable: {
              kind: 'bars',
              window: { timeframe: '5m', lookback: 20 },
              measure: 'volume_ratio',
            },
            comparator: '<',
            threshold: 0.8,
            rationale: 'a breakout on thinning volume is not a breakout',
          },
          state: 'not_breached',
          observed: 1.42,
        },
        {
          condition: {
            id: 'momentum-rolls-over',
            observable: {
              kind: 'indicator',
              spec: { indicator: 'rsi', params: {}, lookback: 14, timeframe: '5m' },
            },
            comparator: '<',
            threshold: 45,
            rationale: 'momentum leaving falsifies the continuation thesis',
          },
          state: 'unevaluable',
          observed: null,
        },
      ],
      dropped_conditions: [],
    },
    created_at: hoursAgo(1.5),
  },
  {
    trace_id: 'trace-002',
    instrument: 'ETH-USD',
    debate_id: 'debate-eth-002',
    binding_constraint: null,
    critic: {
      verdict: 'trim',
      max_notional: 250,
      reasoning: 'the size is too large for the depth on this tape',
      conditions: [],
      dropped_conditions: [
        { id: 'rsi-over-9000', raw: '{"threshold":9000}', reason: 'threshold_out_of_range' },
        { id: null, raw: 'sentiment turns negative', reason: 'unknown_observable' },
      ],
    },
    created_at: hoursAgo(3),
  },
  {
    trace_id: 'trace-003',
    instrument: 'AAPL',
    debate_id: 'debate-aapl-003',
    binding_constraint: 'risk_critic:reject',
    critic: {
      verdict: 'reject',
      max_notional: null,
      reasoning: 'the thesis rests on an earnings move that has already happened',
    },
    created_at: hoursAgo(5),
  },
];

const ANALYST_WEIGHTS: Record<string, number> = {
  'technical-analyst': 0.4,
  'fundamental-analyst': 0.35,
  'sentiment-analyst': 0.25,
};

const ATTRIBUTION: Record<string, AttributionSummary> = {
  'technical-analyst': { analyst_id: 'technical-analyst', rolling_r: 2.31, window_days: 30 },
  'fundamental-analyst': { analyst_id: 'fundamental-analyst', rolling_r: 1.04, window_days: 30 },
  'sentiment-analyst': { analyst_id: 'sentiment-analyst', rolling_r: -0.47, window_days: 30 },
};

const ALERT_DELIVERY_FAILURE_COUNT = 0;

const TICK_STATUS: TickStatus = {
  instrument: 'SPY',
  asset_class: 'stocks',
  stage: 'debate',
  trace_id: 'trace-007',
};

const DAILY_METRICS: MetricsSuite = {
  sharpe: 1.82,
  sortino: 2.41,
  calmar: 1.17,
  max_drawdown: 0.118,
  profit_factor: 1.94,
  expectancy: 184.5,
  skew: 0.31,
  kurtosis: 2.8,
  turnover: 3.6,
  exposure: 0.42,
  per_period_sharpe: 0.1146,
  annualization_factor: 15.87,
  observations: 252,
};

const LLM_SPEND_24H = {
  cost_usd: 0.4183,
  input_tokens: 214_500,
  output_tokens: 38_200,
  cache_read_input_tokens: 96_000,
  cache_creation_input_tokens: 12_800,
  calls: 142,
  unpriced_calls: 3,
  per_debate: {
    debates: 14,
    unattributed_calls: 2,
    cost_usd_p50: 0.0281,
    cost_usd_p95: 0.0472,
    llm_latency_ms_p50: 8_400,
    llm_latency_ms_p95: 19_700,
  },
};

const LLM_SPEND_7D = {
  cost_usd: 2.9106,
  input_tokens: 1_502_300,
  output_tokens: 271_400,
  cache_read_input_tokens: 688_100,
  cache_creation_input_tokens: 84_600,
  calls: 991,
  unpriced_calls: 3,
  per_debate: {
    debates: 98,
    unattributed_calls: 2,
    cost_usd_p50: 0.0274,
    cost_usd_p95: 0.0511,
    llm_latency_ms_p50: 8_150,
    llm_latency_ms_p95: 21_300,
  },
};

const OUTSIDE_BENCHMARKS: OutsideBenchmarkSample[] = [
  {
    computed_at: NOW,
    from: new Date(NOW.getTime() - 30 * 24 * 3_600_000),
    to: NOW,
    performance: {
      benchmark: 'spy',
      buy_and_hold_return_pct: 0.0241,
      max_drawdown_pct: 0.0473,
      observation_count: 21,
    },
  },
  {
    computed_at: NOW,
    from: new Date(NOW.getTime() - 30 * 24 * 3_600_000),
    to: NOW,
    performance: {
      benchmark: 'sixty_forty',
      buy_and_hold_return_pct: 0.0158,
      max_drawdown_pct: 0.0289,
      observation_count: 21,
    },
  },
];

const ARM_COMPARISONS: PersistedArmComparisonSample[] = [
  {
    computed_at: NOW,
    comparison: {
      from: new Date(NOW.getTime() - 30 * 24 * 3_600_000),
      to: NOW,
      basis: 1_000,
      live: {
        arm: 'live',
        trade_count: 24,
        realized_pnl_net: 18.4,
        return_pct: 0.0184,
        max_drawdown_pct: 0.021,
        refused_pass_count: 0,
        cost_basis_drops: {
          protective: { kept: 15, dropped: 0 },
          flatten: { kept: 9, dropped: 3 },
        },
      },
      control: {
        arm: 'control',
        trade_count: 19,
        realized_pnl_net: 6.2,
        return_pct: 0.0062,
        max_drawdown_pct: 0.028,
        refused_pass_count: 2,
        cost_basis_drops: {
          protective: { kept: 11, dropped: 0 },
          flatten: { kept: 8, dropped: 0 },
        },
      },
    },
    divergence: {
      diverged: false,
      reason: null,
      min_trades_per_arm: MIN_TRADES_PER_ARM_FOR_DIVERGENCE,
    },
  },
  {
    computed_at: new Date(NOW.getTime() - 24 * 3_600_000),
    comparison: {
      from: new Date(NOW.getTime() - 31 * 24 * 3_600_000),
      to: new Date(NOW.getTime() - 24 * 3_600_000),
      basis: 1_000,
      live: {
        arm: 'live',
        trade_count: 22,
        realized_pnl_net: 15.1,
        return_pct: 0.0151,
        max_drawdown_pct: 0.021,
        refused_pass_count: null,
        cost_basis_drops: null,
      },
      control: {
        arm: 'control',
        trade_count: 18,
        realized_pnl_net: 7.9,
        return_pct: 0.0079,
        max_drawdown_pct: 0.026,
        refused_pass_count: null,
        cost_basis_drops: null,
      },
    },
    divergence: {
      diverged: false,
      reason: null,
      min_trades_per_arm: MIN_TRADES_PER_ARM_FOR_DIVERGENCE,
    },
  },
];

const FIXTURE_LLM_CAP_USD = 50;

const FIXTURE_LLM_CAP_ARMED_AT = '2026-08-01T00:00:00.000Z';

const LLM_SPEND_ALL = {
  cost_usd: 6.7742,
  input_tokens: 3_488_900,
  output_tokens: 630_050,
  cache_read_input_tokens: 1_602_400,
  cache_creation_input_tokens: 196_700,
  calls: 2_310,
  unpriced_calls: 3,
  per_debate: {
    debates: 229,
    unattributed_calls: 2,
    cost_usd_p50: 0.0269,
    cost_usd_p95: 0.0538,
    llm_latency_ms_p50: 8_050,
    llm_latency_ms_p95: 22_900,
  },
};

const PIPELINE_NOW = NOW;

function pipelineEvent(
  trace_id: string,
  instrument: string,
  asset_class: PipelineStageEvent['asset_class'],
  stage: PipelineStage,
  decision: string,
  secondsAgo: number,
): PipelineStageEvent {
  return {
    trace_id,
    instrument,
    asset_class,
    stage,
    decision,
    timestamp: new Date(PIPELINE_NOW.getTime() - secondsAgo * 1_000),
  };
}

const PIPELINE_EVENTS: PipelineStageEvent[] = [
  pipelineEvent('trace-p-btc', 'BTC-USD', 'crypto', 'analysts', 'quorum_met', 190),
  pipelineEvent('trace-p-btc', 'BTC-USD', 'crypto', 'debate', 'bullish', 186),
  pipelineEvent('trace-p-btc', 'BTC-USD', 'crypto', 'trader', 'entry', 175),
  pipelineEvent('trace-p-btc', 'BTC-USD', 'crypto', 'risk', 'approved', 173),
  pipelineEvent('trace-p-btc', 'BTC-USD', 'crypto', 'verdict', 'go', 172),
  pipelineEvent('trace-p-btc', 'BTC-USD', 'crypto', 'execution', 'filled', 170),

  pipelineEvent('trace-p-eth', 'ETH-USD', 'crypto', 'analysts', 'quorum_met', 130),
  pipelineEvent('trace-p-eth', 'ETH-USD', 'crypto', 'debate', 'retry', 127),
  pipelineEvent('trace-p-eth', 'ETH-USD', 'crypto', 'debate', 'bearish', 118),
  pipelineEvent('trace-p-eth', 'ETH-USD', 'crypto', 'trader', 'entry', 114),
  pipelineEvent('trace-p-eth', 'ETH-USD', 'crypto', 'risk', 'approved', 113),
  pipelineEvent('trace-p-eth', 'ETH-USD', 'crypto', 'verdict', 'no_go', 112),

  pipelineEvent('trace-p-aapl', 'AAPL', 'stocks', 'analysts', 'quorum_met', 95),
  pipelineEvent('trace-p-aapl', 'AAPL', 'stocks', 'debate', 'neutral', 91),
  pipelineEvent('trace-p-aapl', 'AAPL', 'stocks', 'trader', 'no_trade', 84),

  pipelineEvent('trace-p-tsla', 'TSLA', 'stocks', 'analysts', 'quorum_skip', 47),

  pipelineEvent('trace-007', 'SPY', 'stocks', 'analysts', 'quorum_met', 6),
];

const PIPELINE_LIVE: PipelineLiveTick[] = [
  {
    instrument: 'SPY',
    asset_class: 'stocks',
    stage: 'debate',
    trace_id: TICK_STATUS.trace_id,
    entered_at: new Date(PIPELINE_NOW.getTime() - 4_000),
  },
];

export class InMemoryQueryStore implements DashboardQueryStore {
  getRecentDebates(limit: number, _asOf: Date): DebateLog[] {
    return RECENT_DEBATES.slice(0, limit);
  }

  getTickStatus(_asOf: Date): TickStatus | null {
    return TICK_STATUS;
  }

  getOpenPositions(_asOf: Date, _arm: TradingArm): OpenPosition[] {
    return OPEN_POSITIONS;
  }

  getRecentClosedTrades(limit: number, _asOf: Date, _arm: TradingArm): ClosedTrade[] {
    return CLOSED_TRADES.slice(0, limit);
  }

  getAllClosedTrades(_asOf: Date, _arm: TradingArm): ClosedTrade[] {
    return CLOSED_TRADES;
  }

  getFillsForTrades(idempotencyKeys: readonly string[], _asOf: Date): Fill[] {
    const keys = new Set(idempotencyKeys);
    return FILLS.filter((fill) => keys.has(fill.idempotency_key));
  }

  getVerdictHistory(limit: number, _asOf: Date, _arm: TradingArm): VerdictAuditEntry[] {
    return VERDICT_HISTORY.slice(0, limit);
  }

  getRiskCritics(limit: number, _asOf: Date, _arm: TradingArm): RiskCriticRecord[] {
    return RISK_CRITICS.slice(0, limit).map((record) => ({ ...record }));
  }

  getAnalystWeights(_asOf: Date): Record<string, number> {
    return { ...ANALYST_WEIGHTS };
  }

  getAttribution(_asOf: Date, _arm: TradingArm): Record<string, AttributionSummary> {
    return { ...ATTRIBUTION };
  }

  getDailyMetrics(_asOf: Date, _arm: TradingArm): MetricsSuite {
    return { ...DAILY_METRICS };
  }

  getMark(instrument: string, _asOf: Date): Mark {
    const mark = MARKS[instrument];
    if (mark === undefined) {
      throw new Error(`no mark fixture for instrument "${instrument}"`);
    }
    return { ...mark };
  }

  getMarks(instruments: readonly string[], asOf: Date): Map<string, Mark> {
    return new Map(instruments.map((instrument) => [instrument, this.getMark(instrument, asOf)]));
  }

  getArmComparisons(limit: number, _asOf: Date): PersistedArmComparisonSample[] {
    return ARM_COMPARISONS.slice(0, limit).map((sample) => ({ ...sample }));
  }

  getOutsideBenchmarks(limit: number, _asOf: Date): OutsideBenchmarkSample[] {
    return OUTSIDE_BENCHMARKS.slice(0, limit).map((sample) => ({ ...sample }));
  }

  getLlmSpend(_asOf: Date): LlmSpendSummary {
    return {
      last_24h: { ...LLM_SPEND_24H },
      last_7d: { ...LLM_SPEND_7D },
      all_time: { ...LLM_SPEND_ALL },
      cap_usd: FIXTURE_LLM_CAP_USD,
      cap_armed_at: FIXTURE_LLM_CAP_ARMED_AT,
    };
  }

  getPipelineActivity(
    maxLanes: number,
    _lookbackMs: number,
    _asOf: Date,
    _arm: TradingArm,
  ): PipelineActivity {
    const universe = Object.entries(MARKS)
      .map(([instrument, mark]) => ({ instrument, asset_class: mark.asset_class }))
      .slice(0, maxLanes);
    const laneInstruments = new Set(universe.map((entry) => entry.instrument));
    return {
      universe,
      events: PIPELINE_EVENTS.filter((event) => laneInstruments.has(event.instrument)),
      live: PIPELINE_LIVE.filter((tick) => laneInstruments.has(tick.instrument)),
    };
  }

  getAlertDeliveryFailureCount(_asOf: Date): number {
    return ALERT_DELIVERY_FAILURE_COUNT;
  }
}

export const FIXTURE_NOW = NOW;
