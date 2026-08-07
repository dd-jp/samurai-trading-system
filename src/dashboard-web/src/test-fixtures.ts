/**
 * Wire fixtures for the component tests (issue #538). Test-only — nothing the
 * app renders imports this, and no test here talks to a network, a database or
 * a real clock.
 *
 * Same convention as `lib/test-support.ts`: type-only imports from the wire
 * contract, so the fixtures cannot drift into a second definition of a shape
 * the server owns. Every builder takes a partial override, so a test states
 * only the field it is about.
 */

import type { PipelineView } from '../../dashboard/pipeline-types.ts';
import type {
  AnalystPerformanceRow,
  DebateRow,
  LlmSpendSummary,
  LlmSpendWindow,
  MetricsSuiteWire,
  PositionRow,
  VerdictRow,
} from '../../dashboard/types.ts';
import type { WireSnapshot } from './hooks/useSnapshot.ts';

export const AS_OF = '2026-08-07T12:00:00.000Z';

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
    ...overrides,
  };
}

export function makeMetrics(overrides: Partial<MetricsSuiteWire> = {}): MetricsSuiteWire {
  return {
    sharpe: 0.84,
    sortino: 1.12,
    calmar: 0.61,
    max_drawdown: 0.018,
    profit_factor: 1.24,
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
        influence_score: 0.51,
        stance_during_debate: ['neutral', 'bullish', 'bullish'],
      },
      {
        analyst_id: 'meanrev',
        analyst_type: 'technical',
        final_position: 'bearish',
        influence_score: 0.18,
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

export function makeSnapshot(overrides: Partial<WireSnapshot> = {}): WireSnapshot {
  return {
    generated_at: AS_OF,
    as_of: AS_OF,
    mode: 'paper',
    tick_status: null,
    positions: [makePosition()],
    debates: [makeDebate()],
    verdicts: [makeVerdict()],
    analysts: [makeAnalyst()],
    metrics: makeMetrics(),
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
    ...overrides,
  };
}

/**
 * A `fetch` stand-in that answers every call from a queue of payloads, holding
 * the last one once the queue drains. A payload of `null` is a failed poll —
 * the request rejects, which is what the staleness watchdog must survive.
 */
export function fakeFetch(payloads: readonly (WireSnapshot | null)[]): typeof fetch {
  let index = 0;
  const impl = async (): Promise<Response> => {
    const payload = payloads[Math.min(index, payloads.length - 1)];
    index += 1;
    if (payload === null || payload === undefined) throw new Error('network unreachable');
    return {
      ok: true,
      status: 200,
      json: async () => payload,
    } as Response;
  };
  return impl as unknown as typeof fetch;
}
