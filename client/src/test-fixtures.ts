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

import type {
  AnalystPerformanceRow,
  ArmComparisonRow,
  ClosedTradeRow,
  DebateRow,
  FillRow,
  LlmSpendSummary,
  LlmSpendWindow,
  MetricsSuiteWire,
  PipelineView,
  PositionRow,
  VerdictRow,
} from '@contracts';
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
        // influence_score matches what computeInfluenceScore
        // (server/pipeline/debate-engine/analyst-contribution.ts) actually
        // emits for this stance array — 1 of 2 round-to-round transitions
        // changed (neutral→bullish, bullish→bullish) — rather than a
        // hand-picked value (#624). The client cannot import the server
        // function across the client/server boundary (CLAUDE.md: neither
        // runtime imports the other), so this is derived by hand using the
        // same "fraction of transitions that changed" rule instead of called.
        analyst_id: 'momentum',
        analyst_type: 'technical',
        final_position: 'bullish',
        influence_score: 0.5,
        stance_during_debate: ['neutral', 'bullish', 'bullish'],
      },
      {
        // No stance_during_debate recorded, so computeInfluenceScore's own
        // rule (fewer than two recorded rounds -> no transition observable)
        // gives 0, not a hand-picked non-zero reading (#624).
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

/**
 * One Feedback Loop comparison of the two arms (#971), non-diverged by default
 * — both columns always present, because `ArmPerformanceWire` has no shape
 * without them (doc 12 D4).
 */
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
    },
    control: {
      arm: 'control',
      trade_count: 19,
      realized_pnl_net: 6.2,
      return_pct: 0.0062,
      max_drawdown_pct: 0.028,
    },
    diverged: false,
    divergence_reason: null,
    // #982. Mirrors `MIN_TRADES_PER_ARM_FOR_DIVERGENCE` (arm-comparison-cycle.ts)
    // — a plain literal here, not an import, because `contracts`/client fixtures
    // may not reach into `server/`.
    min_trades_per_arm: 5,
    ...overrides,
  };
}

export function makeSnapshot(overrides: Partial<WireSnapshot> = {}): WireSnapshot {
  return {
    generated_at: AS_OF,
    as_of: AS_OF,
    mode: 'paper',
    tick_status: null,
    positions: [makePosition()],
    closed_trades: [makeClosedTrade()],
    fills: [makeFill()],
    debates: [makeDebate()],
    verdicts: [makeVerdict()],
    analysts: [makeAnalyst()],
    metrics: makeMetrics(),
    arm_comparison: [makeArmComparison()],
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
 * A poll that never answers: the server accepted the connection and went
 * quiet. Distinct from `null` (a rejection) because the two fail in opposite
 * ways — a rejection releases the in-flight slot, a hang does not (#606 item
 * 3). Deliberately ignores the abort signal, like a socket that is simply
 * never written to: aborting a controller does not settle a promise nobody is
 * settling, which is the whole reason the timeout must release the slot itself
 * rather than trusting `finally`.
 */
export const HANGS = Symbol('a request that never settles');

/**
 * A `fetch` stand-in that answers every call from a queue of payloads, holding
 * the last one once the queue drains. A payload of `null` is a failed poll —
 * the request rejects, which is what the staleness watchdog must survive — and
 * `HANGS` is a request that never settles at all.
 */
export function fakeFetch(payloads: readonly (WireSnapshot | null | typeof HANGS)[]): typeof fetch {
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
