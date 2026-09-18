import {
  type AnalystPerformanceRow,
  type ArmComparisonRow,
  type ClosedTradeRow,
  CONTRACT_VERSION,
  type DebateRow,
  type EvaluatedConditionWire,
  type FillRow,
  type LlmSpendSummary,
  type LlmSpendWindow,
  type MetricsSuiteWire,
  type OutsideBenchmarkRow,
  type PipelineView,
  type PnlHeadlineWire,
  type PositionRow,
  type RiskCriticRow,
  type VerdictRow,
} from '@contracts';
import type { WireSnapshot } from './hooks/useSnapshot.ts';

const AS_OF = '2026-08-07T12:00:00.000Z';

function spendWindow(overrides: Partial<LlmSpendWindow> = {}): LlmSpendWindow {
  return {
    cost_usd: 1.84,
    input_tokens: 512_000,
    output_tokens: 38_000,
    cache_read_input_tokens: 1_900_000,
    cache_creation_input_tokens: 12_000,
    calls: 61,
    unpriced_calls: 0,
    per_debate: {
      debates: 12,
      unattributed_calls: 0,
      cost_usd_p50: 0.028,
      cost_usd_p95: 0.061,
      llm_latency_ms_p50: 8_400,
      llm_latency_ms_p95: 21_900,
    },
    ...overrides,
  };
}

export function makeSpend(overrides: Partial<LlmSpendSummary> = {}): LlmSpendSummary {
  return {
    last_24h: spendWindow(),
    last_7d: spendWindow({ cost_usd: 11.2, calls: 402 }),
    all_time: spendWindow({ cost_usd: 23.71, calls: 866 }),
    cap_usd: 50,
    cap_armed_at: '2026-08-05T14:00:00.000Z',
    ...overrides,
  };
}

export function makeMetrics(overrides: Partial<MetricsSuiteWire> = {}): MetricsSuiteWire {
  return {
    sharpe: 0.84,
    sortino: 1.12,
    calmar: 0.61,
    max_drawdown: 0.018,
    profit_factor: { kind: 'ratio', value: 1.24 },
    expectancy: 0.31,
    skew: -0.4,
    kurtosis: 2.1,
    per_period_sharpe: 0.05,
    annualization_factor: 15.8,
    observations: 260,
    turnover: 3.4,
    exposure: 0.42,
    ...overrides,
  };
}

export function makePosition(overrides: Partial<PositionRow> = {}): PositionRow {
  return {
    idempotency_key: 'key-eth-1',
    instrument: 'ETH-USD',
    asset_class: 'crypto',
    side: 'buy',
    filled_size: 2.4,
    avg_entry_price: 3_412.5,
    stop: 3_310,
    target: 3_640,
    order_state: 'filled',
    mark_price: 3_468.2,
    unrealized_pnl: 133.68,
    opened_at: '2026-08-07T11:44:00.000Z',
    ...overrides,
  };
}

export function makeClosedTrade(overrides: Partial<ClosedTradeRow> = {}): ClosedTradeRow {
  return {
    idempotency_key: 'key-spy-closed-1',
    debate_id: 'debate-spy-1',
    instrument: 'SPY',
    asset_class: 'stocks',
    side: 'buy',
    entry_price: 552.1,
    exit_price: 559.8,
    filled_size: 20,
    realized_pnl_net: 151.6,
    fees_total: 2.4,
    opened_at: '2026-08-07T06:30:00.000Z',
    closed_at: '2026-08-07T08:00:00.000Z',
    close_reason: 'target',
    ...overrides,
  };
}

export function makeFill(overrides: Partial<FillRow> = {}): FillRow {
  return {
    idempotency_key: 'key-spy-closed-1',
    broker_fill_id: 'alpaca-fill-spy-target',
    leg: 'target',
    price: 559.8,
    qty: 20,
    fee: 1.2,
    timestamp: '2026-08-07T08:00:00.000Z',
    ...overrides,
  };
}

export function makeDebate(overrides: Partial<DebateRow> = {}): DebateRow {
  return {
    debate_id: 'debate-1',
    instrument: 'ETH-USD',
    direction: 'bullish',
    rounds: 3,
    created_at: '2026-08-07T11:44:00.000Z',
    contributions: [
      {
        analyst_id: 'momentum',
        analyst_type: 'technical',
        final_position: 'bullish',
        influence_score: 0.5,
        stance_during_debate: ['neutral', 'bullish', 'bullish'],
      },
      {
        analyst_id: 'meanrev',
        analyst_type: 'technical',
        final_position: 'bearish',
        influence_score: 0,
      },
    ],
    ...overrides,
  };
}

export function makeVerdict(overrides: Partial<VerdictRow> = {}): VerdictRow {
  return {
    trace_id: 'trace-eth',
    instrument: 'ETH-USD',
    status: 'go',
    reason: 'approved',
    hitl_override: false,
    timestamp: '2026-08-07T11:59:00.000Z',
    ...overrides,
  };
}

export function makeCondition(
  overrides: Partial<EvaluatedConditionWire> = {},
): EvaluatedConditionWire {
  return {
    id: 'thesis-fails-below-entry',
    observable: 'mark',
    comparator: '<',
    threshold: 3200,
    state: 'breached',
    observed: 3180.5,
    rationale: 'a break back under the entry level falsifies the breakout',
    ...overrides,
  };
}

export function makeRiskCritic(overrides: Partial<RiskCriticRow> = {}): RiskCriticRow {
  return {
    trace_id: 'trace-eth',
    instrument: 'ETH-USD',
    debate_id: 'debate-eth-1',
    binding_constraint: 'risk_critic:invalidated',
    critic_verdict: 'pass',
    reasoning: 'the breakout has volume behind it',
    conditions: [makeCondition()],
    dropped_conditions: [],
    created_at: '2026-08-07T11:58:00.000Z',
    ...overrides,
  };
}

export function makeAnalyst(overrides: Partial<AnalystPerformanceRow> = {}): AnalystPerformanceRow {
  return {
    analyst_id: 'momentum',
    weight: 0.42,
    rolling_r: 1.84,
    window_days: 30,
    ...overrides,
  };
}

const EMPTY_PIPELINE: PipelineView = {
  lanes: [],
  live_trace_id: null,
  live_entered_at: null,
};

export function makeArmComparison(overrides: Partial<ArmComparisonRow> = {}): ArmComparisonRow {
  return {
    computed_at: AS_OF,
    window_from: '2026-07-08T12:00:00.000Z',
    window_to: AS_OF,
    basis: 1_000,
    live: {
      arm: 'live',
      trade_count: 24,
      realized_pnl_net: 18.4,
      return_pct: 0.0184,
      max_drawdown_pct: 0.021,
      refused_pass_count: 0,
      cost_basis_drops: {
        protective: { kept: 16, dropped: 2 },
        flatten: { kept: 8, dropped: 6 },
      },
    },
    control: {
      arm: 'control',
      trade_count: 19,
      realized_pnl_net: 6.2,
      return_pct: 0.0062,
      max_drawdown_pct: 0.028,
      refused_pass_count: 0,
      cost_basis_drops: {
        protective: { kept: 12, dropped: 0 },
        flatten: { kept: 7, dropped: 0 },
      },
    },
    diverged: false,
    divergence_reason: null,
    min_trades_per_arm: 5,
    ...overrides,
  };
}

export function makeOutsideBenchmark(
  overrides: Partial<OutsideBenchmarkRow> = {},
): OutsideBenchmarkRow {
  return {
    computed_at: AS_OF,
    benchmark: 'spy',
    window_from: '2026-07-08T12:00:00.000Z',
    window_to: AS_OF,
    buy_and_hold_return_pct: 0.0241,
    max_drawdown_pct: 0.0473,
    observation_count: 21,
    ...overrides,
  };
}

export function makePnlHeadline(overrides: Partial<PnlHeadlineWire> = {}): PnlHeadlineWire {
  return {
    overall: {
      net_gbp: 42.5,
      net_pct_of_book: 0.0425,
      max_drawdown_pct: 0.018,
      trade_count: 43,
    },
    today: {
      net_gbp: 3.3,
      net_pct_of_book: 0.0033,
      realized_gbp: 1.8,
      unrealized_gbp: 1.5,
      costs_gbp: 0.2,
      trade_count: 2,
    },
    rate_usd_per_gbp: 1.27,
    rate_source: 'static_sizing_rate',
    book_gbp: 1_000,
    ...overrides,
  };
}

export function makeSnapshot(overrides: Partial<WireSnapshot> = {}): WireSnapshot {
  return {
    generated_at: AS_OF,
    as_of: AS_OF,
    mode: 'paper',
    arm: 'live',
    tick_status: null,
    positions: [makePosition()],
    closed_trades: [makeClosedTrade()],
    fills: [makeFill()],
    debates: [makeDebate()],
    verdicts: [makeVerdict()],
    risk_critics: [makeRiskCritic()],
    analysts: [makeAnalyst()],
    metrics: makeMetrics(),
    arm_comparison: [makeArmComparison()],
    pnl: makePnlHeadline(),
    outside_benchmarks: [
      makeOutsideBenchmark(),
      makeOutsideBenchmark({
        benchmark: 'sixty_forty',
        buy_and_hold_return_pct: 0.0158,
        max_drawdown_pct: 0.0289,
      }),
    ],
    alert_delivery_failures_24h: 0,
    providers: {
      alpaca: {
        provider: 'alpaca',
        state: 'ok',
        detail: 'account reachable',
        observed_at: AS_OF,
        balance: { cash: 99_213.4, equity: 100_112.98, buying_power: 198_426.8 },
      },
      polygon: {
        provider: 'polygon',
        state: 'ok',
        detail: 'aggregates reachable',
        observed_at: AS_OF,
      },
    },
    llm_spend: makeSpend(),
    pipeline: EMPTY_PIPELINE,
    contract_version: CONTRACT_VERSION,
    ...overrides,
  };
}

export const HANGS = Symbol('a request that never settles');

export function fakeFetch(payloads: readonly unknown[]): typeof fetch {
  let index = 0;
  const impl = async (): Promise<Response> => {
    const payload = payloads[Math.min(index, payloads.length - 1)];
    index += 1;
    if (payload === HANGS) return new Promise<Response>(() => {});
    if (payload === null || payload === undefined) throw new Error('network unreachable');
    return {
      ok: true,
      status: 200,
      json: async () => payload,
    } as Response;
  };
  return impl as unknown as typeof fetch;
}
