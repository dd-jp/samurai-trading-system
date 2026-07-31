/**
 * `buildSnapshot` (dashboard snapshot seam) acceptance: asserts on the
 * JSON-serializable projection given a fake `DashboardQueryStore`, not on
 * real store/server behavior (dashboard-spec.md "Testing Decisions").
 *
 * Also asserts the read-only contract is structural: the fake store exposes
 * no setters, and the snapshot function calls only get-* methods.
 */
import type { MetricsSuite } from '../cost-model-backtest/index.js';
import type { Mark } from '../market-data-service/index.js';
import type { AnalystContribution, DebateLog, OpenPosition } from '../shared/index.js';
import { buildSnapshot } from './snapshot.js';
import type {
  AttributionSummary,
  DashboardQueryStore,
  TickStatus,
  VerdictAuditEntry,
} from './types.js';

const AS_OF = new Date('2026-07-19T12:00:00Z');

const METRICS: MetricsSuite = {
  sharpe: 1.5,
  sortino: 2.0,
  calmar: 1.1,
  max_drawdown: 0.1,
  profit_factor: 1.8,
  expectancy: 100,
  skew: 0.2,
  kurtosis: 3.0,
  turnover: 2.5,
  exposure: 0.4,
};

function makePosition(overrides: Partial<OpenPosition> = {}): OpenPosition {
  return {
    idempotency_key: 'AAPL-2026-07-19T09:30:00Z',
    debate_id: 'debate-abc123',
    instrument: 'AAPL',
    asset_class: 'stocks',
    side: 'buy',
    intent_type: 'entry',
    requested_size: 100,
    filled_size: 100,
    avg_entry_price: 100,
    stop: 95,
    target: 110,
    order_state: 'filled',
    broker_order_ids: ['order-1'],
    opened_at: AS_OF,
    decision_timestamp: AS_OF,
    conviction: 0.7,
    converged: true,
    ...overrides,
  };
}

function makeMark(price: number): Mark {
  return { price, observed_at: AS_OF, source: 'test', asset_class: 'stocks' };
}

function makeDebate(overrides: Partial<DebateLog> = {}): DebateLog {
  const contributions: AnalystContribution[] = [
    {
      analyst_id: 'technical-analyst',
      analyst_type: 'technical',
      stance_during_debate: ['bullish'],
      final_position: 'bullish',
      rationale: 'uptrend',
      influence_score: 0.6,
    },
  ];
  return {
    debate_id: 'debate-abc123',
    instrument: 'AAPL',
    bar_timestamp: AS_OF,
    direction: 'bullish',
    rounds: 2,
    created_at: AS_OF,
    contributions,
    ...overrides,
  };
}

function fakeStore(overrides: Partial<DashboardQueryStore> = {}): DashboardQueryStore {
  return {
    getRecentDebates: () => [],
    getTickStatus: () => null,
    getOpenPositions: () => [],
    getVerdictHistory: () => [],
    getAnalystWeights: () => ({}),
    getAttribution: () => ({}),
    getDailyMetrics: () => ({ ...METRICS }),
    getMark: () => makeMark(0),
    ...overrides,
  };
}

describe('buildSnapshot', () => {
  it('computes unrealized PnL from the current mark for a long position', () => {
    const store = fakeStore({
      getOpenPositions: () => [
        makePosition({ instrument: 'AAPL', side: 'buy', avg_entry_price: 100, filled_size: 10 }),
      ],
      getMark: () => makeMark(110),
    });

    const snap = buildSnapshot(store, AS_OF);

    expect(snap.positions).toHaveLength(1);
    expect(snap.positions[0]?.unrealized_pnl).toBe(100);
    expect(snap.positions[0]?.mark_price).toBe(110);
  });

  it('computes unrealized PnL for a short position from the current mark', () => {
    const store = fakeStore({
      getOpenPositions: () => [
        makePosition({ instrument: 'ETH-USD', side: 'sell', avg_entry_price: 100, filled_size: 5 }),
      ],
      getMark: () => makeMark(90),
    });

    const snap = buildSnapshot(store, AS_OF);

    expect(snap.positions[0]?.unrealized_pnl).toBe(50);
  });

  it('serializes every Date field to an ISO string at the wire boundary', () => {
    const store = fakeStore({
      getOpenPositions: () => [makePosition()],
      getRecentDebates: () => [makeDebate()],
    });

    const snap = buildSnapshot(store, AS_OF);

    expect(snap.as_of).toBe(AS_OF.toISOString());
    expect(typeof snap.generated_at).toBe('string');
    expect(snap.positions[0]?.opened_at).toBe(AS_OF.toISOString());
    expect(snap.debates[0]?.created_at).toBe(AS_OF.toISOString());
    // JSON-serializable end-to-end: no Date instances survive the boundary.
    expect(() => JSON.stringify(snap)).not.toThrow();
  });

  it('joins analyst weights with their rolling attribution by analyst_id', () => {
    const attribution: Record<string, AttributionSummary> = {
      'technical-analyst': { analyst_id: 'technical-analyst', rolling_r: 2.3, window_days: 30 },
    };
    const store = fakeStore({
      getAnalystWeights: () => ({ 'technical-analyst': 0.4, 'sentiment-analyst': 0.6 }),
      getAttribution: () => attribution,
    });

    const snap = buildSnapshot(store, AS_OF);

    const tech = snap.analysts.find((a) => a.analyst_id === 'technical-analyst');
    const sent = snap.analysts.find((a) => a.analyst_id === 'sentiment-analyst');
    expect(tech).toMatchObject({ weight: 0.4, rolling_r: 2.3, window_days: 30 });
    expect(sent).toMatchObject({ weight: 0.6, rolling_r: 0, window_days: 0 });
  });

  it('projects the tick-in-progress status line verbatim', () => {
    const tick: TickStatus = {
      instrument: 'SPY',
      asset_class: 'stocks',
      stage: 'debate',
      trace_id: 'trace-7',
    };
    const store = fakeStore({ getTickStatus: () => tick });

    expect(buildSnapshot(store, AS_OF).tick_status).toEqual(tick);
  });

  it('renders an empty state (zero rows, not a throw) when the store has no data', () => {
    const snap = buildSnapshot(fakeStore(), AS_OF);

    expect(snap.positions).toEqual([]);
    expect(snap.debates).toEqual([]);
    expect(snap.verdicts).toEqual([]);
    expect(snap.analysts).toEqual([]);
    expect(snap.tick_status).toBeNull();
    expect(snap.metrics).toEqual(METRICS);
  });

  it('projects verdict history with the gate reason and HITL override flag', () => {
    const verdicts: VerdictAuditEntry[] = [
      {
        trace_id: 'trace-1',
        instrument: 'TSLA',
        status: 'no_go',
        reason: 'risk_max_positions',
        hitl_override: false,
        timestamp: AS_OF,
      },
      {
        trace_id: 'trace-2',
        instrument: 'QQQ',
        status: 'go',
        reason: 'approved',
        hitl_override: true,
        timestamp: AS_OF,
      },
    ];
    const store = fakeStore({ getVerdictHistory: () => verdicts });

    const snap = buildSnapshot(store, AS_OF);

    expect(snap.verdicts).toHaveLength(2);
    expect(snap.verdicts[0]).toMatchObject({
      instrument: 'TSLA',
      status: 'no_go',
      reason: 'risk_max_positions',
      hitl_override: false,
    });
    expect(snap.verdicts[1]?.hitl_override).toBe(true);
  });
});
