import type { ExitClassWire, PnlOverallWire } from '../../../contracts/index.js';
import { CONTRACT_VERSION, EXIT_CLASSES_WIRE } from '../../../contracts/index.js';
import type { ExitClass } from '../../pipeline/control-arm/index.js';
import { cumulativePnl, EXIT_CLASSES } from '../../pipeline/control-arm/index.js';
import type { AnalystContribution } from '../../pipeline/debate-engine/index.js';
import type { Mark } from '../../providers/market-data-service/index.js';
import type { ClosedTrade, DebateLog, Fill, OpenPosition } from '../../shared/index.js';
import { toBrokerFillId } from '../../shared/index.js';
import type { MetricsSuite } from '../../tools/backtest/index.js';
import { LIVE_BOOK_GBP, LIVE_BOOK_SIZING_USD, SIZING_USD_PER_GBP } from '../orchestrator/index.js';
import { PIPELINE_LOOKBACK_MS, PIPELINE_MAX_LANES } from './pipeline-query.js';
import { buildSnapshot } from './snapshot.js';
import type {
  AttributionSummary,
  DashboardQueryStore,
  RiskCriticRecord,
  TickStatus,
  VerdictAuditEntry,
} from './types.js';

const _serverExitClassesReachTheWire: readonly ExitClassWire[] = EXIT_CLASSES;
const _wireExitClassesExistOnTheServer: readonly ExitClass[] = EXIT_CLASSES_WIRE;

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

function makeClosedTrade(overrides: Partial<ClosedTrade> = {}): ClosedTrade {
  return {
    idempotency_key: 'AAPL-2026-07-19T09:30:00Z',
    debate_id: 'debate-abc123',
    instrument: 'AAPL',
    asset_class: 'stocks',
    side: 'buy',
    entry: 100,
    stop: 95,
    filled_size: 10,
    realized_pnl_net: 48,
    fees_total: 2,
    opened_at: AS_OF,
    closed_at: AS_OF,
    close_reason: 'target',
    modelled_cost_charged: true,
    ...overrides,
  };
}

function makeFill(overrides: Partial<Fill> = {}): Fill {
  return {
    idempotency_key: 'AAPL-2026-07-19T09:30:00Z',
    broker_fill_id: toBrokerFillId('fill-1'),
    leg: 'entry',
    price: 100,
    qty: 10,
    fee: 1,
    timestamp: AS_OF,
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
    getRecentClosedTrades: () => [],
    getAllClosedTrades: () => [],
    getFillsForTrades: () => [],
    getVerdictHistory: () => [],
    getRiskCritics: () => [],
    getAnalystWeights: () => ({}),
    getAttribution: () => ({}),
    getDailyMetrics: () => ({ ...METRICS }),
    getArmComparisons: () => [],
    getOutsideBenchmarks: () => [],
    getMark: () => makeMark(0),
    getLlmSpend: () => ({
      last_24h: { ...EMPTY_SPEND_WINDOW },
      last_7d: { ...EMPTY_SPEND_WINDOW },
      all_time: { ...EMPTY_SPEND_WINDOW },
      cap_usd: 50,
      cap_armed_at: '2026-08-05T14:00:00.000Z',
    }),
    getPipelineActivity: () => ({ universe: [], events: [], live: [] }),
    getAlertDeliveryFailureCount: () => 0,
    ...overrides,
  };

  return {
    ...store,
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

    const snap = buildSnapshot(store, AS_OF, 'paper', 'live');

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

    const snap = buildSnapshot(store, AS_OF, 'paper', 'live');

    expect(snap.positions[0]?.unrealized_pnl).toBe(50);
  });

  it('serializes every Date field to an ISO string at the wire boundary', () => {
    const store = fakeStore({
      getOpenPositions: () => [makePosition()],
      getRecentDebates: () => [makeDebate()],
    });

    const snap = buildSnapshot(store, AS_OF, 'paper', 'live');

    expect(snap.as_of).toBe(AS_OF.toISOString());
    expect(typeof snap.generated_at).toBe('string');
    expect(snap.positions[0]?.opened_at).toBe(AS_OF.toISOString());
    expect(snap.debates[0]?.created_at).toBe(AS_OF.toISOString());
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

    const snap = buildSnapshot(store, AS_OF, 'paper', 'live');

    const tech = snap.analysts.find((a) => a.analyst_id === 'technical-analyst');
    const sent = snap.analysts.find((a) => a.analyst_id === 'sentiment-analyst');
    expect(tech).toMatchObject({ weight: 0.4, rolling_r: 2.3, window_days: 30 });
    expect(sent).toMatchObject({ weight: 0.6, rolling_r: 0, window_days: 0 });
  });

  it('projects each analyst per-round stance onto the wire, in order (#427/#599)', () => {
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

    const snap = buildSnapshot(store, AS_OF, 'paper', 'live');

    expect(snap.debates[0]?.contributions[0]?.stance_during_debate).toEqual([
      'bearish',
      'neutral',
      'bullish',
    ]);
    expect(snap.debates[0]?.contributions[1]?.stance_during_debate).toEqual([
      'bullish',
      'bullish',
      'bullish',
    ]);
  });

  it('leaves stance_during_debate absent for a debate_log row that recorded none', () => {
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

    const snap = buildSnapshot(store, AS_OF, 'paper', 'live');

    expect(snap.debates[0]?.contributions[0]?.stance_during_debate).toBeUndefined();
  });

  it('omits the whole stance list when any element is not a Direction', () => {
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

    const snap = buildSnapshot(store, AS_OF, 'paper', 'live');

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

    expect(buildSnapshot(store, AS_OF, 'paper', 'live').tick_status).toEqual(tick);
  });

  it('projects the injected run mode verbatim, never a default (#539)', () => {
    expect(buildSnapshot(fakeStore(), AS_OF, 'live', 'live').mode).toBe('live');
    expect(buildSnapshot(fakeStore(), AS_OF, 'paper', 'live').mode).toBe('paper');
    expect(buildSnapshot(fakeStore(), AS_OF, 'backtest', 'live').mode).toBe('backtest');
  });

  describe('arm scoping (#1592)', () => {
    it('stamps the requested arm on the snapshot when it is live', () => {
      const snap = buildSnapshot(fakeStore(), AS_OF, 'paper', 'live');
      expect(snap.arm).toBe('live');
    });

    it('passes the requested arm to getOpenPositions and getRecentClosedTrades, and stamps it on the wire', () => {
      const seenArms: { positions?: string; closedTrades?: string } = {};
      const store = fakeStore({
        getOpenPositions: (_asOf, arm) => {
          seenArms.positions = arm;
          return [];
        },
        getRecentClosedTrades: (_limit, _asOf, arm) => {
          seenArms.closedTrades = arm;
          return [];
        },
      });

      const snap = buildSnapshot(store, AS_OF, 'paper', 'control');

      expect(seenArms).toEqual({ positions: 'control', closedTrades: 'control' });
      expect(snap.arm).toBe('control');
    });

    it('a store holding both arms yields only that arm’s rows on each request', () => {
      const livePosition = makePosition({ idempotency_key: 'live-key' });
      const controlPosition = makePosition({ idempotency_key: 'control-key' });
      const liveTrade = makeClosedTrade({ idempotency_key: 'live-trade' });
      const controlTrade = makeClosedTrade({ idempotency_key: 'control-trade' });
      const store = fakeStore({
        getOpenPositions: (_asOf, arm) => (arm === 'live' ? [livePosition] : [controlPosition]),
        getRecentClosedTrades: (_limit, _asOf, arm) =>
          arm === 'live' ? [liveTrade] : [controlTrade],
      });

      const liveSnap = buildSnapshot(store, AS_OF, 'paper', 'live');
      expect(liveSnap.positions.map((p) => p.idempotency_key)).toEqual(['live-key']);
      expect(liveSnap.closed_trades.map((t) => t.idempotency_key)).toEqual(['live-trade']);

      const controlSnap = buildSnapshot(store, AS_OF, 'paper', 'control');
      expect(controlSnap.positions.map((p) => p.idempotency_key)).toEqual(['control-key']);
      expect(controlSnap.closed_trades.map((t) => t.idempotency_key)).toEqual(['control-trade']);
    });
  });

  describe('arm scoping for the remaining reads (#1594)', () => {
    it('passes the requested arm to getVerdictHistory, getRiskCritics, getAttribution, getDailyMetrics and getPipelineActivity', () => {
      const seenArms: Record<string, string> = {};
      const store = fakeStore({
        getVerdictHistory: (_limit, _asOf, arm) => {
          seenArms.verdictHistory = arm;
          return [];
        },
        getRiskCritics: (_limit, _asOf, arm) => {
          seenArms.riskCritics = arm;
          return [];
        },
        getAttribution: (_asOf, arm) => {
          seenArms.attribution = arm;
          return {};
        },
        getDailyMetrics: (_asOf, arm) => {
          seenArms.dailyMetrics = arm;
          return { ...METRICS };
        },
        getPipelineActivity: (_maxLanes, _lookbackMs, _asOf, arm) => {
          seenArms.pipelineActivity = arm;
          return { universe: [], events: [], live: [] };
        },
      });

      buildSnapshot(store, AS_OF, 'paper', 'control');

      expect(seenArms).toEqual({
        verdictHistory: 'control',
        riskCritics: 'control',
        attribution: 'control',
        dailyMetrics: 'control',
        pipelineActivity: 'control',
      });
    });
  });

  it('renders an empty state (zero rows, not a throw) when the store has no data', () => {
    const snap = buildSnapshot(fakeStore(), AS_OF, 'paper', 'live');

    expect(snap.positions).toEqual([]);
    expect(snap.closed_trades).toEqual([]);
    expect(snap.fills).toEqual([]);
    expect(snap.debates).toEqual([]);
    expect(snap.verdicts).toEqual([]);
    expect(snap.analysts).toEqual([]);
    expect(snap.tick_status).toBeNull();
    expect(snap.metrics).toEqual({
      ...METRICS,
      profit_factor: { kind: 'ratio', value: METRICS.profit_factor },
    });
  });

  it('carries a window with wins and no losses through JSON.stringify as no_losses, never as null (#1270)', () => {
    const snap = buildSnapshot(
      fakeStore({
        getDailyMetrics: () => ({ ...METRICS, profit_factor: Number.POSITIVE_INFINITY }),
      }),
      AS_OF,
      'paper',
      'live',
    );

    expect(snap.metrics.profit_factor).toEqual({ kind: 'no_losses' });

    const roundTripped = JSON.parse(JSON.stringify(snap)) as {
      metrics: { profit_factor: unknown };
    };
    expect(roundTripped.metrics.profit_factor).toEqual({ kind: 'no_losses' });
    expect(roundTripped.metrics.profit_factor).not.toBeNull();
  });

  it('carries a window with no closed trades at all through JSON.stringify as a real, finite 0, distinguishable from no_losses (#1270)', () => {
    const snap = buildSnapshot(
      fakeStore({ getDailyMetrics: () => ({ ...METRICS, profit_factor: 0 }) }),
      AS_OF,
      'paper',
      'live',
    );

    const roundTripped = JSON.parse(JSON.stringify(snap)) as {
      metrics: { profit_factor: unknown };
    };
    expect(roundTripped.metrics.profit_factor).toEqual({ kind: 'ratio', value: 0 });
    expect(roundTripped.metrics.profit_factor).not.toEqual({ kind: 'no_losses' });
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

    const snap = buildSnapshot(store, AS_OF, 'paper', 'live');

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

    const snap = buildSnapshot(store, AS_OF, 'paper', 'live');

    expect(snap.pipeline.lanes).toHaveLength(1);
    expect(snap.pipeline.lanes[0]).toMatchObject({
      instrument: 'AAPL',
      outcome: 'quorum_skip',
      started_at: AS_OF.toISOString(),
    });
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

    buildSnapshot(store, AS_OF, 'paper', 'live');

    expect(asked).toEqual({
      maxLanes: PIPELINE_MAX_LANES,
      lookbackMs: PIPELINE_LOOKBACK_MS,
      asOf: AS_OF,
    });
  });

  it('projects the alert delivery failure count, bounded above by the same asOf', () => {
    let asked: Date | null = null;
    const store = fakeStore({
      getAlertDeliveryFailureCount: (asOf) => {
        asked = asOf;
        return 4;
      },
    });

    const snap = buildSnapshot(store, AS_OF, 'paper', 'live');

    expect(snap.alert_delivery_failures_24h).toBe(4);
    expect(asked).toEqual(AS_OF);
  });

  it("stamps the snapshot with the server's own CONTRACT_VERSION, regardless of the store", () => {
    const snap = buildSnapshot(fakeStore(), AS_OF, 'paper', 'live');

    expect(snap.contract_version).toBe(CONTRACT_VERSION);
  });

  it("carries the store's LLM cap onto the wire, uncapped included", () => {
    const spend = fakeStore().getLlmSpend(AS_OF);

    expect(buildSnapshot(fakeStore(), AS_OF, 'paper', 'live').llm_spend.cap_usd).toBe(
      spend.cap_usd,
    );
    expect(
      buildSnapshot(
        fakeStore({ getLlmSpend: () => ({ ...spend, cap_usd: null }) }),
        AS_OF,
        'paper',
        'live',
      ).llm_spend.cap_usd,
    ).toBeNull();
  });

  it("carries the store's cap_armed_at onto the wire, null included", () => {
    const spend = fakeStore().getLlmSpend(AS_OF);

    expect(buildSnapshot(fakeStore(), AS_OF, 'paper', 'live').llm_spend.cap_armed_at).toBe(
      spend.cap_armed_at,
    );
    expect(
      buildSnapshot(
        fakeStore({ getLlmSpend: () => ({ ...spend, cap_usd: null, cap_armed_at: null }) }),
        AS_OF,
        'paper',
        'live',
      ).llm_spend.cap_armed_at,
    ).toBeNull();
  });

  describe('closed trades and fills (#940)', () => {
    it('projects a closed trade onto the wire with entry/exit price, PnL, fees and close_reason', () => {
      const trade = makeClosedTrade({
        idempotency_key: 'SPY-1',
        instrument: 'SPY',
        side: 'buy',
        entry: 552.1,
        filled_size: 20,
        realized_pnl_net: 151.6,
        fees_total: 2.4,
        close_reason: 'target',
      });
      const store = fakeStore({
        getRecentClosedTrades: () => [trade],
        getFillsForTrades: () => [
          makeFill({ idempotency_key: 'SPY-1', leg: 'entry', price: 552.1, qty: 20 }),
          makeFill({ idempotency_key: 'SPY-1', leg: 'target', price: 559.8, qty: 20 }),
        ],
      });

      const snap = buildSnapshot(store, AS_OF, 'paper', 'live');

      expect(snap.closed_trades).toHaveLength(1);
      expect(snap.closed_trades[0]).toMatchObject({
        idempotency_key: 'SPY-1',
        instrument: 'SPY',
        side: 'buy',
        entry_price: 552.1,
        exit_price: 559.8,
        filled_size: 20,
        realized_pnl_net: 151.6,
        fees_total: 2.4,
        close_reason: 'target',
      });
      expect(snap.closed_trades[0]?.opened_at).toBe(trade.opened_at.toISOString());
      expect(snap.closed_trades[0]?.closed_at).toBe(trade.closed_at.toISOString());
    });

    it('derives exit_price from the weighted price of the trade’s own exit fills', () => {
      const trade = makeClosedTrade({ idempotency_key: 'K1', side: 'buy', filled_size: 10 });
      const store = fakeStore({
        getRecentClosedTrades: () => [trade],
        getFillsForTrades: () => [
          makeFill({ idempotency_key: 'K1', leg: 'entry', price: 100, qty: 10 }),
          makeFill({ idempotency_key: 'K1', leg: 'stop', price: 104, qty: 4 }),
          makeFill({ idempotency_key: 'K1', leg: 'exit', price: 106, qty: 6 }),
        ],
      });

      const snap = buildSnapshot(store, AS_OF, 'paper', 'live');

      expect(snap.closed_trades[0]?.exit_price).toBeCloseTo(105.2);
    });

    it('falls back to deriving exit_price from realized PnL when no exit fill is on record', () => {
      const trade = makeClosedTrade({
        idempotency_key: 'K2',
        side: 'sell',
        entry: 495.6,
        filled_size: 15,
        realized_pnl_net: -69.3,
        fees_total: 1.8,
        close_reason: 'stop',
      });
      const store = fakeStore({
        getRecentClosedTrades: () => [trade],
        getFillsForTrades: () => [],
      });

      const snap = buildSnapshot(store, AS_OF, 'paper', 'live');

      expect(snap.closed_trades[0]?.exit_price).toBeCloseTo(500.1);
    });

    it('projects fills belonging to the closed trades onto the wire', () => {
      const trade = makeClosedTrade({ idempotency_key: 'K3' });
      const fill = makeFill({
        idempotency_key: 'K3',
        broker_fill_id: toBrokerFillId('alpaca-fill-9'),
        leg: 'target',
        price: 110,
        qty: 10,
        fee: 1.5,
      });
      const store = fakeStore({
        getRecentClosedTrades: () => [trade],
        getFillsForTrades: () => [fill],
      });

      const snap = buildSnapshot(store, AS_OF, 'paper', 'live');

      expect(snap.fills).toHaveLength(1);
      expect(snap.fills[0]).toMatchObject({
        idempotency_key: 'K3',
        broker_fill_id: 'alpaca-fill-9',
        leg: 'target',
        price: 110,
        qty: 10,
        fee: 1.5,
      });
      expect(snap.fills[0]?.timestamp).toBe(fill.timestamp.toISOString());
    });

    it('asks for fills scoped to exactly the closed trades just read, not an independent window', () => {
      const trades = [
        makeClosedTrade({ idempotency_key: 'K-old' }),
        makeClosedTrade({ idempotency_key: 'K-new' }),
      ];
      let askedKeys: readonly string[] | null = null;
      const store = fakeStore({
        getRecentClosedTrades: () => trades,
        getFillsForTrades: (idempotencyKeys) => {
          askedKeys = idempotencyKeys;
          return [];
        },
      });

      buildSnapshot(store, AS_OF, 'paper', 'live');

      expect(askedKeys).toEqual(['K-old', 'K-new']);
    });
  });

  describe('arm comparison (#971)', () => {
    const COMPUTED_AT = new Date('2026-07-19T11:00:00.000Z');

    const SAMPLE = {
      computed_at: COMPUTED_AT,
      comparison: {
        from: new Date('2026-06-19T11:00:00.000Z'),
        to: COMPUTED_AT,
        basis: 1_000,
        live: {
          arm: 'live' as const,
          trade_count: 24,
          realized_pnl_net: 18.4,
          return_pct: 0.0184,
          max_drawdown_pct: 0.021,
          refused_pass_count: 0,
          cost_basis_drops: null,
        },
        control: {
          arm: 'control' as const,
          trade_count: 19,
          realized_pnl_net: 6.2,
          return_pct: 0.0062,
          max_drawdown_pct: 0.028,
          refused_pass_count: 4,
          cost_basis_drops: null,
        },
      },
      divergence: { diverged: false, reason: null, min_trades_per_arm: 7 },
    };

    it('projects both arms with every column, dates as ISO strings', () => {
      const snap = buildSnapshot(
        fakeStore({ getArmComparisons: () => [SAMPLE] }),
        AS_OF,
        'paper',
        'live',
      );

      expect(snap.arm_comparison).toEqual([
        {
          computed_at: '2026-07-19T11:00:00.000Z',
          window_from: '2026-06-19T11:00:00.000Z',
          window_to: '2026-07-19T11:00:00.000Z',
          basis: 1_000,
          live: SAMPLE.comparison.live,
          control: SAMPLE.comparison.control,
          diverged: false,
          divergence_reason: null,
          min_trades_per_arm: 7,
        },
      ]);
    });

    it('carries the divergence verdict and its reason', () => {
      const snap = buildSnapshot(
        fakeStore({
          getArmComparisons: () => [
            {
              ...SAMPLE,
              divergence: {
                diverged: true,
                reason: 'control ahead on both columns',
                min_trades_per_arm: 7,
              },
            },
          ],
        }),
        AS_OF,
        'paper',
        'live',
      );

      expect(snap.arm_comparison[0]?.diverged).toBe(true);
      expect(snap.arm_comparison[0]?.divergence_reason).toBe('control ahead on both columns');
    });

    it('emits an empty array when FL has computed no comparison', () => {
      const snap = buildSnapshot(
        fakeStore({ getArmComparisons: () => [] }),
        AS_OF,
        'paper',
        'live',
      );

      expect(snap.arm_comparison).toEqual([]);
      expect('arm_comparison' in snap).toBe(true);
    });

    it('projects a pre-migration refused_pass_count as null, not 0', () => {
      const snap = buildSnapshot(
        fakeStore({
          getArmComparisons: () => [
            {
              ...SAMPLE,
              comparison: {
                ...SAMPLE.comparison,
                live: { ...SAMPLE.comparison.live, refused_pass_count: null },
                control: { ...SAMPLE.comparison.control, refused_pass_count: null },
              },
            },
          ],
        }),
        AS_OF,
        'paper',
        'live',
      );

      expect(snap.arm_comparison[0]?.live.refused_pass_count).toBeNull();
      expect(snap.arm_comparison[0]?.control.refused_pass_count).toBeNull();
    });
  });

  describe('P&L headline (#1595)', () => {
    it('cannot construct a PnlOverallWire missing max_drawdown_pct — the compile-time half of "never return-only"', () => {
      // @ts-expect-error — max_drawdown_pct is required, not optional.
      const returnOnly: PnlOverallWire = {
        net_gbp: 10,
        net_pct_of_book: 0.01,
        trade_count: 1,
      };
      expect(returnOnly).toBeDefined();
    });

    it('emits a present (zero, not absent) drawdown alongside a zero P&L when nothing has traded', () => {
      const snap = buildSnapshot(fakeStore(), AS_OF, 'paper', 'live');

      expect(snap.pnl.overall).toEqual({
        net_gbp: 0,
        net_pct_of_book: 0,
        max_drawdown_pct: 0,
        trade_count: 0,
      });
      expect(snap.pnl.today).toEqual({
        net_gbp: 0,
        net_pct_of_book: 0,
        realized_gbp: 0,
        unrealized_gbp: 0,
        costs_gbp: 0,
        trade_count: 0,
      });
    });

    it('computes all-time net (realized + open unrealized), % of book, drawdown and trade count in GBP at the static rate', () => {
      const trades = [
        makeClosedTrade({
          idempotency_key: 't1',
          closed_at: new Date('2026-06-01T10:00:00Z'),
          realized_pnl_net: 40,
        }),
        makeClosedTrade({
          idempotency_key: 't2',
          closed_at: new Date('2026-06-02T10:00:00Z'),
          realized_pnl_net: -10,
        }),
      ];
      const store = fakeStore({
        getAllClosedTrades: () => trades,
        getOpenPositions: () => [makePosition({ idempotency_key: 'open-1' })],
        getMark: () => makeMark(105),
      });

      const snap = buildSnapshot(store, AS_OF, 'paper', 'live');

      const unrealizedUsd = 500;
      const expectedNetUsd = 40 - 10 + unrealizedUsd;
      const expectedCumulative = cumulativePnl(trades, LIVE_BOOK_SIZING_USD);

      expect(snap.pnl.overall.net_gbp).toBeCloseTo(expectedNetUsd / SIZING_USD_PER_GBP);
      expect(snap.pnl.overall.net_pct_of_book).toBeCloseTo(
        expectedNetUsd / SIZING_USD_PER_GBP / LIVE_BOOK_GBP,
      );
      expect(snap.pnl.overall.max_drawdown_pct).toBeCloseTo(expectedCumulative.max_drawdown_pct);
      expect(snap.pnl.overall.trade_count).toBe(2);
      expect(snap.pnl.rate_usd_per_gbp).toBe(SIZING_USD_PER_GBP);
      expect(snap.pnl.rate_source).toBe('static_sizing_rate');
      expect(snap.pnl.book_gbp).toBe(LIVE_BOOK_GBP);
    });

    it('counts a row the arm-comparison panel would drop for modelled_cost_charged: false', () => {
      const trades = [
        makeClosedTrade({ idempotency_key: 'charged', realized_pnl_net: 40 }),
        makeClosedTrade({
          idempotency_key: 'uncharged',
          realized_pnl_net: 10,
          modelled_cost_charged: false,
        }),
      ];
      const store = fakeStore({ getAllClosedTrades: () => trades });

      const snap = buildSnapshot(store, AS_OF, 'paper', 'live');

      expect(snap.pnl.overall.trade_count).toBe(2);
      expect(snap.pnl.overall.net_gbp).toBeCloseTo(50 / SIZING_USD_PER_GBP);
    });

    it('has no sizing_capital_ceiling field on ClosedTrade for oneSizingRegime to filter on', () => {
      // @ts-expect-error ClosedTrade carries no sizing_capital_ceiling — see PnlOverallWire's header (#1616)
      makeClosedTrade({ sizing_capital_ceiling: 100 });
    });

    it('counts a 00:30 BST close on the London day it happened on, not the UTC day', () => {
      const asOf = new Date('2026-07-16T10:00:00Z');
      const trades = [
        makeClosedTrade({
          idempotency_key: 'bst-boundary',
          closed_at: new Date('2026-07-15T23:30:00Z'),
          realized_pnl_net: 25,
          fees_total: 1,
        }),
      ];
      const store = fakeStore({ getAllClosedTrades: () => trades });

      const snap = buildSnapshot(store, asOf, 'paper', 'live');

      expect(snap.pnl.today.trade_count).toBe(1);
      expect(snap.pnl.today.realized_gbp).toBeCloseTo(25 / SIZING_USD_PER_GBP);
      expect(snap.pnl.today.costs_gbp).toBeCloseTo(1 / SIZING_USD_PER_GBP);
    });

    it('counts a winter close on its UTC-equal London day, and excludes the prior day', () => {
      const asOf = new Date('2026-01-16T18:00:00Z');
      const trades = [
        makeClosedTrade({
          idempotency_key: 'today-gmt',
          closed_at: new Date('2026-01-16T08:00:00Z'),
          realized_pnl_net: 12,
        }),
        makeClosedTrade({
          idempotency_key: 'yesterday-gmt',
          closed_at: new Date('2026-01-15T23:00:00Z'),
          realized_pnl_net: 99,
        }),
      ];
      const store = fakeStore({ getAllClosedTrades: () => trades });

      const snap = buildSnapshot(store, asOf, 'paper', 'live');

      expect(snap.pnl.today.trade_count).toBe(1);
      expect(snap.pnl.today.realized_gbp).toBeCloseTo(12 / SIZING_USD_PER_GBP);
      expect(snap.pnl.overall.trade_count).toBe(2);
    });

    it('scopes to the requested arm — control rows never reach the live headline and vice versa', () => {
      const liveTrade = makeClosedTrade({ idempotency_key: 'live-t', realized_pnl_net: 40 });
      const controlTrade = makeClosedTrade({ idempotency_key: 'control-t', realized_pnl_net: 999 });
      const store = fakeStore({
        getAllClosedTrades: (_asOf, arm) => (arm === 'live' ? [liveTrade] : [controlTrade]),
      });

      const liveSnap = buildSnapshot(store, AS_OF, 'paper', 'live');
      expect(liveSnap.pnl.overall.trade_count).toBe(1);
      expect(liveSnap.pnl.overall.net_gbp).toBeCloseTo(40 / SIZING_USD_PER_GBP);

      const controlSnap = buildSnapshot(store, AS_OF, 'paper', 'control');
      expect(controlSnap.pnl.overall.trade_count).toBe(1);
      expect(controlSnap.pnl.overall.net_gbp).toBeCloseTo(999 / SIZING_USD_PER_GBP);
    });
  });

  describe('risk critic and invalidation conditions (#1066)', () => {
    function makeRiskCriticRecord(overrides: Partial<RiskCriticRecord> = {}): RiskCriticRecord {
      return {
        trace_id: 'trace-1',
        instrument: 'AAPL',
        debate_id: 'debate-abc123',
        binding_constraint: null,
        critic: {
          verdict: 'pass',
          max_notional: null,
          reasoning: 'the setup survives the attack',
        },
        created_at: AS_OF,
        ...overrides,
      };
    }

    it('flattens each evaluated condition, labelling the observable it measured', () => {
      const store = fakeStore({
        getRiskCritics: () => [
          makeRiskCriticRecord({
            binding_constraint: 'risk_critic:invalidated',
            critic: {
              verdict: 'pass',
              max_notional: null,
              reasoning: 'prose says pass',
              conditions: [
                {
                  condition: {
                    id: 'mark-breaks-entry',
                    observable: { kind: 'mark' },
                    comparator: '<',
                    threshold: 190,
                    rationale: 'a break back under entry falsifies the breakout',
                  },
                  state: 'breached',
                  observed: 188.5,
                },
                {
                  condition: {
                    id: 'rsi-rolls-over',
                    observable: {
                      kind: 'indicator',
                      spec: { indicator: 'rsi', params: {}, lookback: 14, timeframe: '5m' },
                    },
                    comparator: '<',
                    threshold: 45,
                    rationale: 'momentum gone',
                  },
                  state: 'unevaluable',
                  observed: null,
                },
                {
                  condition: {
                    id: 'volume-thins',
                    observable: {
                      kind: 'bars',
                      window: { timeframe: '5m', lookback: 20 },
                      measure: 'volume_ratio',
                    },
                    comparator: '<',
                    threshold: 0.8,
                    rationale: 'participation gone',
                  },
                  state: 'not_breached',
                  observed: 1.4,
                },
              ],
            },
          }),
        ],
      });

      const snap = buildSnapshot(store, AS_OF, 'paper', 'live');

      expect(snap.risk_critics).toHaveLength(1);
      const row = snap.risk_critics[0];
      expect(row?.binding_constraint).toBe('risk_critic:invalidated');
      expect(row?.critic_verdict).toBe('pass');
      expect(row?.conditions).toEqual([
        {
          id: 'mark-breaks-entry',
          observable: 'mark',
          comparator: '<',
          threshold: 190,
          state: 'breached',
          observed: 188.5,
          rationale: 'a break back under entry falsifies the breakout',
        },
        {
          id: 'rsi-rolls-over',
          observable: 'indicator:rsi@5m',
          comparator: '<',
          threshold: 45,
          state: 'unevaluable',
          observed: null,
          rationale: 'momentum gone',
        },
        {
          id: 'volume-thins',
          observable: 'bars:volume_ratio@5m',
          comparator: '<',
          threshold: 0.8,
          state: 'not_breached',
          observed: 1.4,
          rationale: 'participation gone',
        },
      ]);
      expect(row?.created_at).toBe(AS_OF.toISOString());
    });

    it('carries every drop reason across, even when nothing survived to be evaluated', () => {
      const store = fakeStore({
        getRiskCritics: () => [
          makeRiskCriticRecord({
            critic: {
              verdict: 'trim',
              max_notional: 250,
              reasoning: 'too big for the tape',
              conditions: [],
              dropped_conditions: [
                {
                  id: 'rsi-over-9000',
                  raw: '{"threshold":9000}',
                  reason: 'threshold_out_of_range',
                },
                { id: null, raw: 'not an object', reason: 'unparseable' },
              ],
            },
          }),
        ],
      });

      const snap = buildSnapshot(store, AS_OF, 'paper', 'live');

      expect(snap.risk_critics[0]?.conditions).toEqual([]);
      expect(snap.risk_critics[0]?.dropped_conditions).toEqual([
        { id: 'rsi-over-9000', raw: '{"threshold":9000}', reason: 'threshold_out_of_range' },
        { id: null, raw: 'not an object', reason: 'unparseable' },
      ]);
    });

    it('serializes a pre-fold verdict as null conditions rather than an absent field', () => {
      const store = fakeStore({
        getRiskCritics: () => [
          makeRiskCriticRecord({
            critic: { verdict: 'pass', max_notional: null, reasoning: 'pre-fold row' },
          }),
        ],
      });

      const snap = buildSnapshot(store, AS_OF, 'paper', 'live');

      expect(snap.risk_critics[0]?.conditions).toBeNull();
      expect(snap.risk_critics[0]?.dropped_conditions).toBeNull();
      const roundTripped = JSON.parse(JSON.stringify(snap)) as { risk_critics: unknown[] };
      expect(roundTripped.risk_critics[0]).toMatchObject({
        conditions: null,
        dropped_conditions: null,
      });
    });

    it('reports a decision the critic never saw as a null verdict, not a pass', () => {
      const store = fakeStore({
        getRiskCritics: () => [
          makeRiskCriticRecord({
            debate_id: null,
            binding_constraint: 'per_asset_class_cap',
            critic: undefined,
          }),
        ],
      });

      const snap = buildSnapshot(store, AS_OF, 'paper', 'live');

      expect(snap.risk_critics[0]?.critic_verdict).toBeNull();
      expect(snap.risk_critics[0]?.reasoning).toBeNull();
      expect(snap.risk_critics[0]?.conditions).toBeNull();
      expect(snap.risk_critics[0]?.debate_id).toBeNull();
    });

    it('emits an empty array when no Risk decision is on record', () => {
      const snap = buildSnapshot(fakeStore({ getRiskCritics: () => [] }), AS_OF, 'paper', 'live');

      expect(snap.risk_critics).toEqual([]);
      expect('risk_critics' in snap).toBe(true);
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

    const snap = buildSnapshot(store, AS_OF, 'paper', 'live');

    expect(snap.pipeline.lanes.map((l) => l.outcome)).toEqual(['idle', 'idle']);
    expect(snap.pipeline.live_trace_id).toBeNull();
  });
});
