/**
 * `buildSnapshot` (dashboard snapshot seam) acceptance: asserts on the
 * JSON-serializable projection given a fake `DashboardQueryStore`, not on
 * real store/server behavior (dashboard-spec.md "Testing Decisions").
 *
 * Also asserts the read-only contract is structural: the fake store exposes
 * no setters, and the snapshot function calls only get-* methods.
 */

import type { ExitClassWire } from '../../../contracts/index.js';
import { CONTRACT_VERSION, EXIT_CLASSES_WIRE } from '../../../contracts/index.js';
import type { ExitClass } from '../../pipeline/control-arm/index.js';
import { EXIT_CLASSES } from '../../pipeline/control-arm/index.js';
import type { AnalystContribution } from '../../pipeline/debate-engine/index.js';
import type { Mark } from '../../providers/market-data-service/index.js';
import type { ClosedTrade, DebateLog, Fill, OpenPosition } from '../../shared/index.js';
import { toBrokerFillId } from '../../shared/index.js';
import type { MetricsSuite } from '../../tools/backtest/index.js';
import { PIPELINE_LOOKBACK_MS, PIPELINE_MAX_LANES } from './pipeline-query.js';
import { buildSnapshot } from './snapshot.js';
import type {
  AttributionSummary,
  DashboardQueryStore,
  RiskCriticRecord,
  TickStatus,
  VerdictAuditEntry,
} from './types.js';

/**
 * #1546: `contracts/` may import from neither runtime (CLAUDE.md), so
 * `ExitClassWire` duplicates the server's `ExitClass` the way `TradingArmWire`
 * duplicates `TradingArm`. These two assignments make the duplication a
 * COMPILE error to break rather than a comment to remember — one direction
 * each, so adding a class on either side alone fails here, and `buildSnapshot`
 * carries whole `ArmPerformance` values across on a spread that would
 * otherwise let a server-only class through untyped.
 */
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
    getRecentClosedTrades: () => [],
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

    const snap = buildSnapshot(store, AS_OF, 'paper', 'live');

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

    const snap = buildSnapshot(store, AS_OF, 'paper', 'live');

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

    const snap = buildSnapshot(store, AS_OF, 'paper', 'live');

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
    // Both directions, because the failure that matters is asymmetric: a
    // page that says "paper" during a live run is how an operator watches
    // real money believing it is simulated.
    expect(buildSnapshot(fakeStore(), AS_OF, 'live', 'live').mode).toBe('live');
    expect(buildSnapshot(fakeStore(), AS_OF, 'paper', 'live').mode).toBe('paper');
    expect(buildSnapshot(fakeStore(), AS_OF, 'backtest', 'live').mode).toBe('backtest');
  });

  // #1592: the snapshot's own arm scoping — which arm's positions/closed
  // trades it carries, and that it names that arm on the wire.
  describe('arm scoping (#1592)', () => {
    // "no ?arm= given defaults to live" is a fact about the HTTP layer
    // (server.ts's parseArmParam, covered by server.test.ts) — buildSnapshot
    // itself takes arm as a required parameter with no default, so this only
    // checks that the 'live' case stamps correctly, same as 'control' below.
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

  // #1594: the remaining reads' own arm scoping. Mirrors the #1592 block
  // above — a store that records which arm each method was called with,
  // proving `buildSnapshot` forwards its own `arm` parameter rather than
  // hardcoding 'live' at any of these five call sites.
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
    // Every field but `profit_factor` crosses `buildSnapshot` unchanged
    // (#1270); `profit_factor` is wrapped into `ProfitFactorWire`.
    expect(snap.metrics).toEqual({
      ...METRICS,
      profit_factor: { kind: 'ratio', value: METRICS.profit_factor },
    });
  });

  /**
   * The bug this ticket fixes, proven at the serialization boundary — a test
   * that only inspected `snap.metrics.profit_factor` as an in-process object
   * would not catch it, because `Number.POSITIVE_INFINITY` survives in
   * memory and only dies in `JSON.stringify` (AC4).
   */
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

    buildSnapshot(store, AS_OF, 'paper', 'live');

    // This read rides a 3-second poll; an unbounded one would degrade the
    // whole dashboard as the audit log grows through a 14-day soak.
    expect(asked).toEqual({
      maxLanes: PIPELINE_MAX_LANES,
      lookbackMs: PIPELINE_LOOKBACK_MS,
      asOf: AS_OF,
    });
  });

  // #1108: the count of permanently-undeliverable alert sends rides this same
  // payload, so an operator reading the dashboard can tell the alert channel
  // is down instead of reading silence as calm. `asOf` is the upper bound of
  // the store's trailing window (#1131), not the only bound — the window's
  // lower edge lives inside `getAlertDeliveryFailureCount` itself and is
  // covered by sqlite-query-store.test.ts and alert-delivery-log.test.ts, not
  // here, since this fake's return value is a plain injected number.
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

  // #1316: the running server's own stamp of its wire shape, so a client
  // polling it (`useSnapshot.ts`) can tell a served-bundle-vs-server skew
  // apart from a healthy read. Always this process's OWN compiled-in
  // constant — never read off the store — because the whole mechanism this
  // field exists for is detecting a REBUILD, and `server.ts` serves
  // `dist/client/` per request without a restart, so only a value baked into
  // the running process (not the store, which does not change on rebuild)
  // can move when that happens.
  it("stamps the snapshot with the server's own CONTRACT_VERSION, regardless of the store", () => {
    const snap = buildSnapshot(fakeStore(), AS_OF, 'paper', 'live');

    expect(snap.contract_version).toBe(CONTRACT_VERSION);
  });

  // #1140: the enforced cap rides the same payload as the spend it bounds, so
  // the rail's denominator is the enforcer's rather than a client constant.
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

  // #1196: `cap_armed_at` is the only thing that tells "armed uncapped" apart
  // from "never armed" once `cap_usd` is null, so it has to ride the wire
  // untouched too, not just `cap_usd`.
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

  // #940: closed trades and their fills appear on the wire — the surface the
  // dashboard never had before, for a trade that entered, filled and flattened.
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
        // Two exit-leg fills at different prices — a real partial exit — so a
        // naive "first fill" read would get this wrong; only the qty-weighted
        // average is correct.
        getFillsForTrades: () => [
          makeFill({ idempotency_key: 'K1', leg: 'entry', price: 100, qty: 10 }),
          makeFill({ idempotency_key: 'K1', leg: 'stop', price: 104, qty: 4 }),
          makeFill({ idempotency_key: 'K1', leg: 'exit', price: 106, qty: 6 }),
        ],
      });

      const snap = buildSnapshot(store, AS_OF, 'paper', 'live');

      // (104*4 + 106*6) / 10 = 105.2
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
        getFillsForTrades: () => [], // no fills captured for this lot
      });

      const snap = buildSnapshot(store, AS_OF, 'paper', 'live');

      // grossPnl = -69.3 + 1.8 = -67.5; delta = -67.5/15 = -4.5;
      // sell => exit = entry - delta = 495.6 - (-4.5) = 500.1
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
      // #940 review: a separately-bounded "recent fills" query can starve an
      // older closed trade of its fills once open-position churn fills the
      // window with entry-leg noise. `buildSnapshot` must instead ask for
      // fills BY the closed-trade keys it already has.
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

  /**
   * #971 — the Feedback Loop's matched-control comparison reaches the wire.
   *
   * The projection is read-and-convert, never a second computation: FL owns the
   * derivation (#636), and a `buildSnapshot` that recomputed it would put a
   * number on the panel that FL never saw and never alerted on.
   */
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
      // A non-default floor (7, not `MIN_TRADES_PER_ARM_FOR_DIVERGENCE`'s 5)
      // deliberately — #982's projection must carry whatever value the sample
      // actually recorded, not echo the module default at some hop.
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

    /** Empty is a required field holding an empty array, never an absent one. */
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

    /**
     * #1483: a sample computed before migration 0057 reads back
     * `refused_pass_count: null` on both arms — the projection must carry that
     * `null` onto the wire rather than coercing it to `0`, which would assert
     * "no refusals" for a quantity this row never measured.
     */
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
      // The binding constraint is carried verbatim: `risk_critic:invalidated`
      // (a measured breach) and `risk_critic:reject` (the critic's prose) are
      // distinct facts (#997 Q2b), and the wire must not blur them.
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
          // Null, never 0: `unevaluable` means the read failed, and a zero
          // there would be a measurement that never happened.
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

    /**
     * A row written before #994's fold has no conditions column at all
     * (migration 0040 backfilled nothing) and never will. It must serialize as
     * `null` — not as an absent field, which `JSON.stringify` would produce
     * from `undefined` — and it must not throw.
     */
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

    /** Empty is a required field holding an empty array, never an absent one. */
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

    // #413's idle frame, end to end: a closed market is the common case, and
    // the lanes must still be there to say so.
    expect(snap.pipeline.lanes.map((l) => l.outcome)).toEqual(['idle', 'idle']);
    expect(snap.pipeline.live_trace_id).toBeNull();
  });
});
