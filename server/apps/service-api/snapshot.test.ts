/**
 * `buildSnapshot` (dashboard snapshot seam) acceptance: asserts on the
 * JSON-serializable projection given a fake `DashboardQueryStore`, not on
 * real store/server behavior (dashboard-spec.md "Testing Decisions").
 *
 * Also asserts the read-only contract is structural: the fake store exposes
 * no setters, and the snapshot function calls only get-* methods.
 */
import type { AnalystContribution } from '../../pipeline/debate-engine/index.js';
import type { Mark } from '../../providers/market-data-service/index.js';
import type { DebateLog, OpenPosition } from '../../shared/index.js';
import type { MetricsSuite } from '../../tools/backtest/index.js';
import { PIPELINE_LOOKBACK_MS, PIPELINE_MAX_LANES } from './pipeline-query.js';
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
  per_period_sharpe: 0.0945,
  annualization_factor: 15.87,
  observations: 252,
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

const EMPTY_SPEND_WINDOW = {
  cost_usd: 0,
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  calls: 0,
  unpriced_calls: 0,
  // Added by #326 (per-decision cost/latency percentiles). The fixture never
  // followed the type, so every assertion in this file was checking a spend
  // window shape the dashboard had stopped producing.
  per_debate: {
    debates: 0,
    unattributed_calls: 0,
    cost_usd_p50: 0,
    cost_usd_p95: 0,
    llm_latency_ms_p50: 0,
    llm_latency_ms_p95: 0,
  },
};

function fakeStore(overrides: Partial<DashboardQueryStore> = {}): DashboardQueryStore {
  const store: Omit<DashboardQueryStore, 'getMarks'> = {
    getRecentDebates: () => [],
    getTickStatus: () => null,
    getOpenPositions: () => [],
    getVerdictHistory: () => [],
    getAnalystWeights: () => ({}),
    getAttribution: () => ({}),
    getDailyMetrics: () => ({ ...METRICS }),
    getMark: () => makeMark(0),
    getLlmSpend: () => ({
      last_24h: { ...EMPTY_SPEND_WINDOW },
      last_7d: { ...EMPTY_SPEND_WINDOW },
      all_time: { ...EMPTY_SPEND_WINDOW },
    }),
    getPipelineActivity: () => ({ universe: [], events: [], live: [] }),
    ...overrides,
  };

  return {
    ...store,
    // Defaults to delegating to whatever `getMark` the test supplied, so the
    // many tests that control the mark that way keep controlling it now that
    // `buildSnapshot` reads marks in a batch.
    getMarks:
      overrides.getMarks ??
      ((instruments, asOf) =>
        new Map(instruments.map((instrument) => [instrument, store.getMark(instrument, asOf)]))),
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

    const snap = buildSnapshot(store, AS_OF, 'paper');

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

    const snap = buildSnapshot(store, AS_OF, 'paper');

    expect(snap.positions[0]?.unrealized_pnl).toBe(50);
  });

  it('serializes every Date field to an ISO string at the wire boundary', () => {
    const store = fakeStore({
      getOpenPositions: () => [makePosition()],
      getRecentDebates: () => [makeDebate()],
    });

    const snap = buildSnapshot(store, AS_OF, 'paper');

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

    const snap = buildSnapshot(store, AS_OF, 'paper');

    const tech = snap.analysts.find((a) => a.analyst_id === 'technical-analyst');
    const sent = snap.analysts.find((a) => a.analyst_id === 'sentiment-analyst');
    expect(tech).toMatchObject({ weight: 0.4, rolling_r: 2.3, window_days: 30 });
    expect(sent).toMatchObject({ weight: 0.6, rolling_r: 0, window_days: 0 });
  });

  it('projects each analyst per-round stance onto the wire, in order (#427/#599)', () => {
    // The stances differ from each other AND end somewhere the final position
    // alone cannot reconstruct, so this fails both ways the strip can be
    // wrong: a dropped projection, and a fabricated flat line derived from
    // `final_position`. `stance_during_debate` is OPTIONAL on `DebateRow`, so
    // dropping the projection still compiles — this assertion is the only
    // guard against that.
    const contributions: AnalystContribution[] = [
      {
        analyst_id: 'technical-analyst',
        analyst_type: 'technical',
        stance_during_debate: ['bearish', 'neutral', 'bullish'],
        final_position: 'bullish',
        rationale: 'talked around',
        influence_score: 0.67,
      },
      {
        analyst_id: 'sentiment-analyst',
        analyst_type: 'sentiment',
        stance_during_debate: ['bullish', 'bullish', 'bullish'],
        final_position: 'bullish',
        rationale: 'never moved',
        influence_score: 0,
      },
    ];
    const store = fakeStore({
      getRecentDebates: () => [makeDebate({ contributions, rounds: 3 })],
    });

    const snap = buildSnapshot(store, AS_OF, 'paper');

    expect(snap.debates[0]?.contributions[0]?.stance_during_debate).toEqual([
      'bearish',
      'neutral',
      'bullish',
    ]);
    // The analyst that never moved is the control: identical `final_position`,
    // a different history, and the wire must keep them distinguishable.
    expect(snap.debates[0]?.contributions[1]?.stance_during_debate).toEqual([
      'bullish',
      'bullish',
      'bullish',
    ]);
  });

  it('leaves stance_during_debate absent for a debate_log row that recorded none', () => {
    // `contributions` is `JSON.parse` output: a row written without the field
    // yields `undefined` here, and the strip's empty state ("no per-round
    // stance recorded") is the honest rendering of that — never a flat line.
    const legacy = [
      {
        analyst_id: 'technical-analyst',
        analyst_type: 'technical',
        final_position: 'bullish',
        rationale: 'pre-#427 row',
        influence_score: 0,
      } as AnalystContribution,
    ];
    const store = fakeStore({ getRecentDebates: () => [makeDebate({ contributions: legacy })] });

    const snap = buildSnapshot(store, AS_OF, 'paper');

    expect(snap.debates[0]?.contributions[0]?.stance_during_debate).toBeUndefined();
  });

  it('omits the whole stance list when any element is not a Direction', () => {
    // A corrupted `contributions_json` row. Dropping only the bad element
    // would render this three-round debate as a confident two-round history;
    // the whole field goes, so the strip states it has nothing to show.
    const corrupt = [
      {
        analyst_id: 'technical-analyst',
        analyst_type: 'technical',
        stance_during_debate: ['bullish', 42, null],
        final_position: 'bullish',
        rationale: 'corrupt row',
        influence_score: 0,
      } as unknown as AnalystContribution,
    ];
    const store = fakeStore({
      getRecentDebates: () => [makeDebate({ contributions: corrupt, rounds: 3 })],
    });

    const snap = buildSnapshot(store, AS_OF, 'paper');

    expect(snap.debates[0]?.contributions[0]?.stance_during_debate).toBeUndefined();
  });

  it('projects the tick-in-progress status line verbatim', () => {
    const tick: TickStatus = {
      instrument: 'SPY',
      asset_class: 'stocks',
      stage: 'debate',
      trace_id: 'trace-7',
    };
    const store = fakeStore({ getTickStatus: () => tick });

    expect(buildSnapshot(store, AS_OF, 'paper').tick_status).toEqual(tick);
  });

  it('projects the injected run mode verbatim, never a default (#539)', () => {
    // Both directions, because the failure that matters is asymmetric: a
    // page that says "paper" during a live run is how an operator watches
    // real money believing it is simulated.
    expect(buildSnapshot(fakeStore(), AS_OF, 'live').mode).toBe('live');
    expect(buildSnapshot(fakeStore(), AS_OF, 'paper').mode).toBe('paper');
    expect(buildSnapshot(fakeStore(), AS_OF, 'backtest').mode).toBe('backtest');
  });

  it('renders an empty state (zero rows, not a throw) when the store has no data', () => {
    const snap = buildSnapshot(fakeStore(), AS_OF, 'paper');

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

    const snap = buildSnapshot(store, AS_OF, 'paper');

    expect(snap.verdicts).toHaveLength(2);
    expect(snap.verdicts[0]).toMatchObject({
      instrument: 'TSLA',
      status: 'no_go',
      reason: 'risk_max_positions',
      hitl_override: false,
    });
    expect(snap.verdicts[1]?.hitl_override).toBe(true);
  });

  it('projects the pipeline lanes onto the same snapshot and the same asOf', () => {
    const store = fakeStore({
      getPipelineActivity: () => ({
        universe: [{ instrument: 'AAPL', asset_class: 'stocks' }],
        events: [
          {
            trace_id: 'trace-1',
            instrument: 'AAPL',
            asset_class: 'stocks',
            stage: 'analysts',
            decision: 'quorum_skip',
            timestamp: AS_OF,
          },
        ],
        live: [],
      }),
    });

    const snap = buildSnapshot(store, AS_OF, 'paper');

    expect(snap.pipeline.lanes).toHaveLength(1);
    expect(snap.pipeline.lanes[0]).toMatchObject({
      instrument: 'AAPL',
      outcome: 'quorum_skip',
      started_at: AS_OF.toISOString(),
    });
    // The lanes cross the wire with the tables, not on a second poll — a
    // `Date` surviving here would break the same JSON boundary the rest of
    // the snapshot maintains.
    expect(() => JSON.stringify(snap)).not.toThrow();
  });

  it('asks for a bounded pipeline read rather than the whole audit history', () => {
    let asked: { maxLanes: number; lookbackMs: number; asOf: Date } | null = null;
    const store = fakeStore({
      getPipelineActivity: (maxLanes, lookbackMs, asOf) => {
        asked = { maxLanes, lookbackMs, asOf };
        return { universe: [], events: [], live: [] };
      },
    });

    buildSnapshot(store, AS_OF, 'paper');

    // This read rides a 3-second poll; an unbounded one would degrade the
    // whole dashboard as the audit log grows through a 14-day soak.
    expect(asked).toEqual({
      maxLanes: PIPELINE_MAX_LANES,
      lookbackMs: PIPELINE_LOOKBACK_MS,
      asOf: AS_OF,
    });
  });

  it('renders every lane idle, not an empty view, when nothing has ticked', () => {
    const store = fakeStore({
      getPipelineActivity: () => ({
        universe: [
          { instrument: 'BTC-USD', asset_class: 'crypto' },
          { instrument: 'SPY', asset_class: 'stocks' },
        ],
        events: [],
        live: [],
      }),
    });

    const snap = buildSnapshot(store, AS_OF, 'paper');

    // #413's idle frame, end to end: a closed market is the common case, and
    // the lanes must still be there to say so.
    expect(snap.pipeline.lanes.map((l) => l.outcome)).toEqual(['idle', 'idle']);
    expect(snap.pipeline.live_trace_id).toBeNull();
  });
});
