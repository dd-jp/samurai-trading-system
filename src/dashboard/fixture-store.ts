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
import type {
  AttributionSummary,
  DashboardQueryStore,
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
};

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
}

/** Exposed so tests can pin the clock against the same fixtures. */
export const FIXTURE_NOW = NOW;
