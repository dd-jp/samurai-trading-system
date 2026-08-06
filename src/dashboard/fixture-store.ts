/**
 * `InMemoryQueryStore` — a concrete implementation of the `DashboardQueryStore`
 * port (dashboard-spec.md "Module: Query Store"), seeded with realistic
 * fixture data so the dashboard runs out of the box. Mirrors the project's
 * existing in-memory store pattern (src/feedback-loop/fixture-stores.ts,
 * src/trader/fixture-setup-store.ts, src/debate-engine/debate-log-store.ts):
 * the real SQLite-backed shared store is deferred (no shared store exists
 * anywhere in the codebase yet — every stage's store is an in-memory
 * implementation of its port pending that build-out).
 *
 * Read-only by construction: only the `DashboardQueryStore` get-* methods are
 * implemented; no setters, no write path (dashboard-spec.md "Any write path
 * ... strictly read-only"). The fixture data is static; a future ticket swaps
 * this for the real SQLite-backed `DashboardQueryStore` without touching the
 * server or snapshot seam.
 */

import type { MetricsSuite } from '../cost-model-backtest/index.js';
import type { AnalystContribution } from '../debate-engine/index.js';
import type { Mark } from '../market-data-service/index.js';
import type { DebateLog, OpenPosition } from '../shared/index.js';
import type { PipelineStage } from './pipeline-types.js';
import type {
  AttributionSummary,
  DashboardQueryStore,
  LlmSpendSummary,
  PipelineActivity,
  PipelineLiveTick,
  PipelineStageEvent,
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

const RECENT_DEBATES: DebateLog[] = [
  {
    debate_id: 'debate-btc-001',
    instrument: 'BTC-USD',
    bar_timestamp: hoursAgo(1.5),
    direction: 'bullish',
    rounds: 3,
    created_at: hoursAgo(1.5),
    contributions: [
      contribution('technical', 'bullish', 0.62),
      contribution('fundamental', 'bullish', 0.24),
      contribution('sentiment', 'neutral', 0.14),
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
      contribution('technical', 'bearish', 0.58),
      contribution('fundamental', 'neutral', 0.21),
      contribution('sentiment', 'bearish', 0.21),
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
      contribution('technical', 'bullish', 0.41),
      contribution('fundamental', 'bullish', 0.39),
      contribution('sentiment', 'neutral', 0.2),
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
      contribution('technical', 'neutral', 0.4),
      contribution('fundamental', 'bearish', 0.33),
      contribution('sentiment', 'bullish', 0.27),
    ],
  },
];

function contribution(
  type: string,
  final: AnalystContribution['final_position'],
  influence: number,
): AnalystContribution {
  return {
    analyst_id: `${type}-analyst`,
    analyst_type: type,
    stance_during_debate: [final],
    final_position: final,
    rationale: `Stance synthesized from the latest ${type} read on the instrument.`,
    influence_score: influence,
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
  // The DSR inputs (#406). Consistent with `sharpe` above rather than
  // arbitrary: 0.1146 x 15.87 = 1.82, and 252 observations is a year of daily
  // bars — a fixture that contradicted its own Sharpe would be a confusing
  // thing to develop the dashboard against.
  per_period_sharpe: 0.1146,
  annualization_factor: 15.87,
  observations: 252,
};

/**
 * Spend fixtures. `last_24h` carries a non-zero `unpriced_calls` on purpose:
 * it is the case a fixture set is most likely to omit and the one the UI most
 * needs to prove it renders, since a silently-dropped unpriced call is how a
 * spend total understates itself. `per_debate.unattributed_calls` is non-zero
 * for the same reason (#326) — it is the caveat that travels with the
 * percentiles, and a fixture that never exercises it lets the UI ship without
 * a place to show it.
 *
 * p95 sits well above p50 in every window, deliberately: LLM latency is
 * long-tailed and a fixture set with p50 == p95 would let a percentile bug
 * that collapses the two render as plausible.
 */
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

/**
 * Pipeline-view fixtures (#411). One lane per instrument in `MARKS`, chosen so
 * every cell state and every outcome the render layer has to draw appears at
 * least once without the developer having to run a tick:
 *
 *  - BTC-USD — a clean walk to Execution (`go`).
 *  - ETH-USD — a debate retried once, then rejected at Verdict (`no_go`),
 *    which is what puts a two-attempt cell and a completed-but-negative
 *    traversal on screen together.
 *  - AAPL    — stopped at Trader on `no_trade`.
 *  - TSLA    — stopped at Analysts on `quorum_skip`.
 *  - SPY     — in flight at Debate, on the same trace as `TICK_STATUS` so the
 *              two views of the live tick agree.
 *  - QQQ     — no trace at all: the idle lane (#413).
 *
 * AAPL and TSLA are the deliberate ones. Both are traces the SQLite store
 * cannot attribute today — `audit_log` has no instrument column, and a tick
 * that ends before Verdict leaves nothing to join on (see
 * `pipeline-query.ts`'s header). They are in the fixtures precisely because
 * the UI must be built against the short-circuits the operator will eventually
 * see, rather than against the subset the current schema can serve.
 */
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

  // The live trace's completed stages. Its current stage has no row yet — the
  // audit row is written after the stage returns — which is exactly the state
  // a `live` cell has to render from.
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

  getOpenPositions(_asOf: Date): OpenPosition[] {
    return OPEN_POSITIONS;
  }

  getVerdictHistory(limit: number, _asOf: Date): VerdictAuditEntry[] {
    return VERDICT_HISTORY.slice(0, limit);
  }

  getAnalystWeights(_asOf: Date): Record<string, number> {
    return { ...ANALYST_WEIGHTS };
  }

  getAttribution(_asOf: Date): Record<string, AttributionSummary> {
    return { ...ATTRIBUTION };
  }

  getDailyMetrics(_asOf: Date): MetricsSuite {
    return { ...DAILY_METRICS };
  }

  getMark(instrument: string, _asOf: Date): Mark {
    const mark = MARKS[instrument];
    if (mark === undefined) {
      throw new Error(`no mark fixture for instrument "${instrument}"`);
    }
    return { ...mark };
  }

  /** Same throw-on-missing contract as `getMark`, per instrument in request order. */
  getMarks(instruments: readonly string[], asOf: Date): Map<string, Mark> {
    return new Map(instruments.map((instrument) => [instrument, this.getMark(instrument, asOf)]));
  }

  getLlmSpend(_asOf: Date): LlmSpendSummary {
    return {
      last_24h: { ...LLM_SPEND_24H },
      last_7d: { ...LLM_SPEND_7D },
      all_time: { ...LLM_SPEND_ALL },
    };
  }

  /**
   * `maxLanes` is honoured (the fixtures are the universe, and a store that
   * ignored its own bound would let the dashboard ship never having exercised
   * one); `lookbackMs` and `asOf` are not, for the same reason every method
   * above ignores `asOf` — the fixture data is static, so every trace is
   * always "recent".
   */
  getPipelineActivity(maxLanes: number, _lookbackMs: number, _asOf: Date): PipelineActivity {
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
}

/** Exposed so tests can pin the clock against the same fixtures. */
export const FIXTURE_NOW = NOW;
