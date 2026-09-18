import { CONTROL_TRACE_SUFFIX } from '../../apps/orchestrator/control-arm.js';
import { SqliteAlertDeliveryLog } from '../../apps/orchestrator/index.js';
import { CONTROL_DEBATE_ID_PREFIX } from '../../pipeline/control-arm/index.js';
import type { AnalystContribution } from '../../pipeline/debate-engine/index.js';
import { SqliteDebateLogStore } from '../../pipeline/debate-engine/index.js';
import { SqliteExecutionStore } from '../../pipeline/execution/index.js';
import type { EvaluatedCondition, RiskCriticVerdict } from '../../pipeline/risk-manager/index.js';
import { SqliteRiskCriticStore } from '../../pipeline/risk-manager/index.js';
import { TelegramBotApiClient } from '../../pipeline/verdict/index.js';
import type { ClosedTrade, DebateLog, Fill, OpenPosition } from '../../shared/index.js';
import { toBrokerFillId } from '../../shared/index.js';
import {
  openSharedStore,
  SqliteLlmSpendCapStore,
  SqliteRiskLogStore,
  SqliteTraderLogStore,
  type StoreHandle,
} from '../../shared/store/index.js';
import { percentile, SqliteQueryStore } from './sqlite-query-store.js';

const NOW = new Date('2026-07-27T12:00:00Z');

function makeDb(): StoreHandle {
  return openSharedStore(':memory:');
}

function makePosition(overrides: Partial<OpenPosition> = {}): OpenPosition {
  return {
    idempotency_key: 'key-1',
    debate_id: 'debate-1',
    instrument: 'AAPL',
    asset_class: 'stocks',
    side: 'buy',
    intent_type: 'entry',
    requested_size: 10,
    filled_size: 10,
    avg_entry_price: 100,
    stop: 95,
    target: 110,
    order_state: 'filled',
    broker_order_ids: ['alpaca-1'],
    opened_at: new Date('2026-07-27T10:00:00Z'),
    decision_timestamp: new Date('2026-07-27T09:55:00Z'),
    conviction: 0.7,
    converged: true,
    ...overrides,
  };
}

function makeDebateLog(overrides: Partial<DebateLog> = {}): DebateLog {
  const contribution: AnalystContribution = {
    analyst_id: 'technical-analyst',
    analyst_type: 'technical',
    stance_during_debate: ['bullish'],
    final_position: 'bullish',
    rationale: 'trend intact',
    influence_score: 0.5,
  };
  return {
    debate_id: 'debate-1',
    instrument: 'AAPL',
    bar_timestamp: new Date('2026-07-27T09:00:00Z'),
    contributions: [contribution],
    direction: 'bullish',
    rounds: 2,
    created_at: new Date('2026-07-27T09:00:00Z'),
    ...overrides,
  };
}

function makeClosedTrade(overrides: Partial<ClosedTrade> = {}): ClosedTrade {
  return {
    idempotency_key: 'key-closed-1',
    debate_id: 'debate-1',
    instrument: 'AAPL',
    asset_class: 'stocks',
    side: 'buy',
    entry: 100,
    stop: 95,
    filled_size: 10,
    realized_pnl_net: 50,
    fees_total: 1,
    opened_at: new Date('2026-07-27T09:00:00Z'),
    closed_at: new Date('2026-07-27T11:00:00Z'),
    close_reason: 'target',
    modelled_cost_charged: true,
    ...overrides,
  };
}

function seedClosedTrade(execStore: SqliteExecutionStore, trade: ClosedTrade): Promise<void> {
  return execStore.applyLotAdvance({
    idempotency_key: trade.idempotency_key,
    fills: [],
    closed_trade: trade,
  });
}

function makeFill(overrides: Partial<Fill> = {}): Fill {
  return {
    idempotency_key: 'key-closed-1',
    broker_fill_id: toBrokerFillId('fill-1'),
    leg: 'entry',
    price: 100,
    qty: 10,
    fee: 1,
    timestamp: new Date('2026-07-27T09:00:00Z'),
    ...overrides,
  };
}

function seedClosedTradeWithFills(
  execStore: SqliteExecutionStore,
  trade: ClosedTrade,
  fills: readonly Fill[],
): Promise<void> {
  return execStore.applyLotAdvance({
    idempotency_key: trade.idempotency_key,
    fills,
    closed_trade: trade,
  });
}

describe('SqliteQueryStore', () => {
  it('reads open positions, excluding terminal states, filtered by asOf', async () => {
    const db = makeDb();
    const execStore = new SqliteExecutionStore(db);
    await execStore.writeAheadPosition(makePosition());
    await execStore.writeAheadPosition(
      makePosition({ idempotency_key: 'key-2', order_state: 'closed' }),
    );
    await execStore.writeAheadPosition(
      makePosition({
        idempotency_key: 'key-3',
        opened_at: new Date('2026-07-28T00:00:00Z'),
      }),
    );

    const store = new SqliteQueryStore(db);
    const positions = store.getOpenPositions(NOW, 'live');

    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({ idempotency_key: 'key-1', instrument: 'AAPL' });
  });

  it('scopes getOpenPositions to the named arm, excluding the other arm entirely', async () => {
    const db = makeDb();
    const liveStore = new SqliteExecutionStore(db, 'live');
    const controlStore = new SqliteExecutionStore(db, 'control');
    await liveStore.writeAheadPosition(makePosition({ idempotency_key: 'key-live' }));
    await controlStore.writeAheadPosition(makePosition({ idempotency_key: 'key-control' }));

    const store = new SqliteQueryStore(db);

    const live = store.getOpenPositions(NOW, 'live');
    expect(live).toHaveLength(1);
    expect(live[0]?.idempotency_key).toBe('key-live');

    const control = store.getOpenPositions(NOW, 'control');
    expect(control).toHaveLength(1);
    expect(control[0]?.idempotency_key).toBe('key-control');
  });

  it('reads recent debates newest-first, respecting the limit', () => {
    const db = makeDb();
    const debateStore = new SqliteDebateLogStore(db);
    debateStore.writeLog(makeDebateLog());
    debateStore.writeLog(
      makeDebateLog({ debate_id: 'debate-2', created_at: new Date('2026-07-27T10:00:00Z') }),
    );

    const store = new SqliteQueryStore(db);
    const debates = store.getRecentDebates(1, NOW);

    expect(debates).toHaveLength(1);
    expect(debates[0]?.debate_id).toBe('debate-2');
  });

  it('projects termination and termination_cause onto recent debates (#1396)', () => {
    const db = makeDb();
    const debateStore = new SqliteDebateLogStore(db);
    debateStore.writeLog(
      makeDebateLog({
        debate_id: 'debate-failed',
        termination: 'latency_truncated',
        termination_cause: 'llm_failure',
      }),
    );
    debateStore.writeLog(
      makeDebateLog({
        debate_id: 'debate-converged',
        created_at: new Date('2026-07-27T08:00:00Z'),
        termination: 'converged',
      }),
    );

    const store = new SqliteQueryStore(db);
    const debates = store.getRecentDebates(10, NOW);

    const failed = debates.find((d) => d.debate_id === 'debate-failed');
    const converged = debates.find((d) => d.debate_id === 'debate-converged');
    expect(failed).toMatchObject({
      termination: 'latency_truncated',
      termination_cause: 'llm_failure',
    });
    expect(converged?.termination).toBe('converged');
    expect(converged?.termination_cause).toBeUndefined();
  });

  it('projects termination/termination_cause as undefined for a pre-migration row', () => {
    const db = makeDb();
    const debateStore = new SqliteDebateLogStore(db);
    debateStore.writeLog(makeDebateLog({ debate_id: 'debate-pre-migration' }));

    const store = new SqliteQueryStore(db);
    const [debate] = store.getRecentDebates(10, NOW);

    expect(debate?.termination).toBeUndefined();
    expect(debate?.termination_cause).toBeUndefined();
  });

  it('reads tick status, mapping the most recently updated row', () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO current_tick (instrument, asset_class, stage, trace_id, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('AAPL', 'stocks', 'debate', 'trace-1', '2026-07-27T11:59:00Z');

    const store = new SqliteQueryStore(db);
    expect(store.getTickStatus(NOW)).toEqual({
      instrument: 'AAPL',
      asset_class: 'stocks',
      stage: 'debate',
      trace_id: 'trace-1',
    });
  });

  it('returns null tick status when the table is empty', () => {
    const store = new SqliteQueryStore(makeDb());
    expect(store.getTickStatus(NOW)).toBeNull();
  });

  it('reads verdict history, mapping no_go_reason null to "approved"', () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO verdict_log (trace_id, idempotency_key, instrument, status, no_go_reason, hitl_override, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('trace-1', 'key-1', 'AAPL', 'go', null, 0, '2026-07-27T10:00:00Z');
    db.prepare(
      `INSERT INTO verdict_log (trace_id, idempotency_key, instrument, status, no_go_reason, hitl_override, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('trace-2', 'key-2', 'TSLA', 'no_go', 'risk_max_positions', 1, '2026-07-27T09:00:00Z');

    const store = new SqliteQueryStore(db);
    const verdicts = store.getVerdictHistory(10, NOW, 'live');

    expect(verdicts).toHaveLength(2);
    expect(verdicts[0]).toMatchObject({
      trace_id: 'trace-1',
      reason: 'approved',
      hitl_override: false,
    });
    expect(verdicts[1]).toMatchObject({
      trace_id: 'trace-2',
      reason: 'risk_max_positions',
      hitl_override: true,
    });
  });

  it('excludes control-arm verdicts, applying the limit after the arm filter', () => {
    const db = makeDb();
    const insertVerdict = (trace_id: string, timestamp: string) =>
      db
        .prepare(
          `INSERT INTO verdict_log (trace_id, idempotency_key, instrument, status, no_go_reason, hitl_override, timestamp)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(trace_id, `key-${trace_id}`, 'AAPL', 'go', null, 0, timestamp);

    insertVerdict('trace-live-1', '2026-07-27T09:00:00Z');
    insertVerdict('trace-live-2', '2026-07-27T08:00:00Z');
    insertVerdict(`trace-control-1${CONTROL_TRACE_SUFFIX}`, '2026-07-27T10:00:00Z');
    insertVerdict(`trace-control-2${CONTROL_TRACE_SUFFIX}`, '2026-07-27T11:00:00Z');

    const store = new SqliteQueryStore(db);

    expect(store.getVerdictHistory(10, NOW, 'live').map((v) => v.trace_id)).toEqual([
      'trace-live-1',
      'trace-live-2',
    ]);

    expect(store.getVerdictHistory(2, NOW, 'live').map((v) => v.trace_id)).toEqual([
      'trace-live-1',
      'trace-live-2',
    ]);

    expect(store.getVerdictHistory(10, NOW, 'control').map((v) => v.trace_id)).toEqual([
      `trace-control-2${CONTROL_TRACE_SUFFIX}`,
      `trace-control-1${CONTROL_TRACE_SUFFIX}`,
    ]);
    expect(store.getVerdictHistory(2, NOW, 'control').map((v) => v.trace_id)).toEqual([
      `trace-control-2${CONTROL_TRACE_SUFFIX}`,
      `trace-control-1${CONTROL_TRACE_SUFFIX}`,
    ]);
  });

  it('reads analyst weights', () => {
    const db = makeDb();
    db.prepare(`INSERT INTO analyst_weights (analyst_id, weight, updated_at) VALUES (?, ?, ?)`).run(
      'technical-analyst',
      0.4,
      '2026-07-27T08:00:00Z',
    );

    const store = new SqliteQueryStore(db);
    expect(store.getAnalystWeights(NOW)).toEqual({ 'technical-analyst': 0.4 });
  });

  it('reads the current mark for an instrument, throwing when absent', () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO latest_mark (instrument, price, observed_at, asset_class, source) VALUES (?, ?, ?, ?, ?)`,
    ).run('AAPL', 228.41, '2026-07-27T11:59:00Z', 'stocks', 'alpaca');

    const store = new SqliteQueryStore(db);
    expect(store.getMark('AAPL', NOW)).toMatchObject({ price: 228.41, source: 'alpaca' });
    expect(() => store.getMark('TSLA', NOW)).toThrow(/no mark/);
  });

  it("batches marks in one query and keeps getMark's throw-on-missing per instrument", () => {
    const db = makeDb();
    const insert = db.prepare(
      `INSERT INTO latest_mark (instrument, price, observed_at, asset_class, source) VALUES (?, ?, ?, ?, ?)`,
    );
    insert.run('AAPL', 228.41, '2026-07-27T11:59:00Z', 'stocks', 'alpaca');
    insert.run('BTC-USD', 61_200, '2026-07-27T11:59:30Z', 'crypto', 'alpaca');

    const store = new SqliteQueryStore(db);

    const marks = store.getMarks(['AAPL', 'BTC-USD'], NOW);
    expect(marks.size).toBe(2);
    expect(marks.get('AAPL')).toMatchObject({ price: 228.41, asset_class: 'stocks' });
    expect(marks.get('BTC-USD')).toMatchObject({ price: 61_200, asset_class: 'crypto' });

    expect(() => store.getMarks(['AAPL', 'TSLA'], NOW)).toThrow(/no mark for instrument "TSLA"/);

    expect(store.getMarks([], NOW).size).toBe(0);

    const duplicated = store.getMarks(['AAPL', 'AAPL'], NOW);
    expect(duplicated.size).toBe(1);
    expect(duplicated.get('AAPL')).toMatchObject({ price: 228.41 });
  });

  it('computes profit_factor and expectancy from closed trades in the trailing day, leaving unsourced fields at 0', async () => {
    const db = makeDb();
    const execStore = new SqliteExecutionStore(db);
    await seedClosedTrade(execStore, makeClosedTrade({ realized_pnl_net: 50 }));
    await seedClosedTrade(
      execStore,
      makeClosedTrade({ idempotency_key: 'key-closed-2', realized_pnl_net: -20 }),
    );
    await seedClosedTrade(
      execStore,
      makeClosedTrade({
        idempotency_key: 'key-closed-3',
        realized_pnl_net: 1000,
        closed_at: new Date('2026-07-20T11:00:00Z'),
      }),
    );

    const store = new SqliteQueryStore(db);
    const metrics = store.getDailyMetrics(NOW, 'live');

    expect(metrics.profit_factor).toBeCloseTo(50 / 20);
    expect(metrics.expectancy).toBeCloseTo(0.5 * 50 - 0.5 * 20);
    expect(metrics.sharpe).toBe(0);
    expect(metrics.max_drawdown).toBe(0);
  });

  it('returns +Infinity for profit_factor on a window with wins and no losses', async () => {
    const db = makeDb();
    const execStore = new SqliteExecutionStore(db);
    await seedClosedTrade(execStore, makeClosedTrade({ realized_pnl_net: 50 }));
    await seedClosedTrade(
      execStore,
      makeClosedTrade({ idempotency_key: 'key-closed-2', realized_pnl_net: 30 }),
    );

    const store = new SqliteQueryStore(db);
    const metrics = store.getDailyMetrics(NOW, 'live');

    expect(metrics.profit_factor).toBe(Number.POSITIVE_INFINITY);
  });

  it('returns a finite 0 for profit_factor on a window with no closed trades at all', () => {
    const db = makeDb();
    const store = new SqliteQueryStore(db);
    const metrics = store.getDailyMetrics(NOW, 'live');

    expect(metrics.profit_factor).toBe(0);
  });

  it('scopes profit_factor/expectancy to the named arm, each excluding the other', async () => {
    const db = makeDb();
    await seedClosedTrade(
      new SqliteExecutionStore(db, 'live'),
      makeClosedTrade({ idempotency_key: 'key-live', realized_pnl_net: 50 }),
    );
    await seedClosedTrade(
      new SqliteExecutionStore(db, 'control'),
      makeClosedTrade({ idempotency_key: 'key-control', realized_pnl_net: 999 }),
    );

    const store = new SqliteQueryStore(db);
    expect(store.getDailyMetrics(NOW, 'live').expectancy).toBeCloseTo(50);
    expect(store.getDailyMetrics(NOW, 'control').expectancy).toBeCloseTo(999);
  });

  it('accumulates attribution credit per analyst from closed trades joined to their debate log', async () => {
    const db = makeDb();
    const execStore = new SqliteExecutionStore(db);
    const debateStore = new SqliteDebateLogStore(db);

    debateStore.writeLog(makeDebateLog());
    await seedClosedTrade(execStore, makeClosedTrade({ realized_pnl_net: 50 }));

    const store = new SqliteQueryStore(db, 30);
    const attribution = store.getAttribution(NOW, 'live');

    expect(attribution['technical-analyst']).toMatchObject({
      analyst_id: 'technical-analyst',
      window_days: 30,
    });
    expect(attribution['technical-analyst']?.rolling_r).toBeCloseTo(1);
  });

  it('excludes attribution for trades whose debate log row is missing', async () => {
    const db = makeDb();
    const execStore = new SqliteExecutionStore(db);
    await seedClosedTrade(execStore, makeClosedTrade());

    const store = new SqliteQueryStore(db);
    expect(store.getAttribution(NOW, 'live')).toEqual({});
  });

  it('excludes attribution for trades whose debate was latency-truncated', async () => {
    const db = makeDb();
    const execStore = new SqliteExecutionStore(db);
    const debateStore = new SqliteDebateLogStore(db);

    debateStore.writeLog(makeDebateLog({ termination: 'latency_truncated' }));
    await seedClosedTrade(execStore, makeClosedTrade({ realized_pnl_net: 50 }));

    const store = new SqliteQueryStore(db);
    expect(store.getAttribution(NOW, 'live')).toEqual({});
  });

  it('keeps attribution for a pre-#1081 row with no termination recorded (indeterminate, not excluded)', async () => {
    const db = makeDb();
    const execStore = new SqliteExecutionStore(db);
    const debateStore = new SqliteDebateLogStore(db);

    debateStore.writeLog(makeDebateLog());
    await seedClosedTrade(execStore, makeClosedTrade({ realized_pnl_net: 50 }));

    const store = new SqliteQueryStore(db);
    expect(store.getAttribution(NOW, 'live')['technical-analyst']?.rolling_r).toBeCloseTo(1);
  });

  it('scopes attribution to the named arm even when both arms would join the same debate_log row', async () => {
    const db = makeDb();
    const debateStore = new SqliteDebateLogStore(db);
    debateStore.writeLog(makeDebateLog({ debate_id: 'debate-shared' }));

    await seedClosedTrade(
      new SqliteExecutionStore(db, 'live'),
      makeClosedTrade({
        idempotency_key: 'key-live',
        debate_id: 'debate-shared',
        realized_pnl_net: 50,
      }),
    );
    await seedClosedTrade(
      new SqliteExecutionStore(db, 'control'),
      makeClosedTrade({
        idempotency_key: 'key-control',
        debate_id: 'debate-shared',
        realized_pnl_net: 999,
      }),
    );

    const store = new SqliteQueryStore(db, 30);
    expect(store.getAttribution(NOW, 'live')['technical-analyst']?.rolling_r).toBeCloseTo(1);
    expect(store.getAttribution(NOW, 'control')['technical-analyst']?.rolling_r).toBeCloseTo(19.98);
  });

  it('returns no attribution for the control arm when no debate_log row exists at all (the real case)', async () => {
    const db = makeDb();
    await seedClosedTrade(
      new SqliteExecutionStore(db, 'control'),
      makeClosedTrade({ debate_id: 'control:deadbeef', realized_pnl_net: 999 }),
    );

    const store = new SqliteQueryStore(db);
    expect(store.getAttribution(NOW, 'control')).toEqual({});
  });

  describe('getRecentClosedTrades / getFillsForTrades (#940)', () => {
    it('reads recent closed trades newest-first, respecting the limit', async () => {
      const db = makeDb();
      const execStore = new SqliteExecutionStore(db);
      await seedClosedTrade(execStore, makeClosedTrade());
      await seedClosedTrade(
        execStore,
        makeClosedTrade({
          idempotency_key: 'key-closed-2',
          closed_at: new Date('2026-07-27T11:30:00Z'),
        }),
      );

      const store = new SqliteQueryStore(db);
      const trades = store.getRecentClosedTrades(1, NOW, 'live');

      expect(trades).toHaveLength(1);
      expect(trades[0]?.idempotency_key).toBe('key-closed-2');
    });

    it('excludes a closed trade that closed after asOf, matching every other read on this store', async () => {
      const db = makeDb();
      const execStore = new SqliteExecutionStore(db);
      await seedClosedTrade(
        execStore,
        makeClosedTrade({ closed_at: new Date('2026-07-28T00:00:00Z') }),
      );

      const store = new SqliteQueryStore(db);
      expect(store.getRecentClosedTrades(10, NOW, 'live')).toEqual([]);
    });

    it('scopes getRecentClosedTrades to the named arm, excluding the other arm entirely', async () => {
      const db = makeDb();
      const liveStore = new SqliteExecutionStore(db, 'live');
      const controlStore = new SqliteExecutionStore(db, 'control');
      await seedClosedTrade(liveStore, makeClosedTrade({ idempotency_key: 'key-closed-live' }));
      await seedClosedTrade(
        controlStore,
        makeClosedTrade({ idempotency_key: 'key-closed-control' }),
      );

      const store = new SqliteQueryStore(db);

      const live = store.getRecentClosedTrades(10, NOW, 'live');
      expect(live).toHaveLength(1);
      expect(live[0]?.idempotency_key).toBe('key-closed-live');

      const control = store.getRecentClosedTrades(10, NOW, 'control');
      expect(control).toHaveLength(1);
      expect(control[0]?.idempotency_key).toBe('key-closed-control');
    });

    it('reads every fill for the named lots, ignoring lots not named', async () => {
      const db = makeDb();
      const execStore = new SqliteExecutionStore(db);
      await seedClosedTradeWithFills(execStore, makeClosedTrade({ idempotency_key: 'key-A' }), [
        makeFill({
          idempotency_key: 'key-A',
          broker_fill_id: toBrokerFillId('fill-A-entry'),
          leg: 'entry',
        }),
        makeFill({
          idempotency_key: 'key-A',
          broker_fill_id: toBrokerFillId('fill-A-target'),
          leg: 'target',
          price: 110,
        }),
      ]);
      await seedClosedTradeWithFills(
        execStore,
        makeClosedTrade({ idempotency_key: 'key-B', debate_id: 'debate-1' }),
        [
          makeFill({
            idempotency_key: 'key-B',
            broker_fill_id: toBrokerFillId('fill-B-entry'),
            leg: 'entry',
          }),
        ],
      );

      const store = new SqliteQueryStore(db);
      const fills = store.getFillsForTrades(['key-A'], NOW);

      expect(fills).toHaveLength(2);
      expect(fills.map((f) => f.broker_fill_id).sort()).toEqual(['fill-A-entry', 'fill-A-target']);
    });

    it('returns no fills, without querying, for an empty key list', async () => {
      const db = makeDb();
      const execStore = new SqliteExecutionStore(db);
      await seedClosedTradeWithFills(execStore, makeClosedTrade(), [makeFill()]);

      const store = new SqliteQueryStore(db);
      expect(store.getFillsForTrades([], NOW)).toEqual([]);
    });
  });

  describe('getAllClosedTrades', () => {
    it('reads every closed trade for the named arm, with no LIMIT truncation', async () => {
      const db = makeDb();
      const execStore = new SqliteExecutionStore(db);
      for (let i = 0; i < 11; i++) {
        await seedClosedTrade(
          execStore,
          makeClosedTrade({
            idempotency_key: `key-closed-${i}`,
            closed_at: new Date(NOW.getTime() - i * 60_000),
          }),
        );
      }

      const store = new SqliteQueryStore(db);
      expect(store.getAllClosedTrades(NOW, 'live')).toHaveLength(11);
    });

    it('scopes to the named arm, excluding the other arm entirely', async () => {
      const db = makeDb();
      const liveStore = new SqliteExecutionStore(db, 'live');
      const controlStore = new SqliteExecutionStore(db, 'control');
      await seedClosedTrade(liveStore, makeClosedTrade({ idempotency_key: 'key-closed-live' }));
      await seedClosedTrade(
        controlStore,
        makeClosedTrade({ idempotency_key: 'key-closed-control' }),
      );

      const store = new SqliteQueryStore(db);

      const live = store.getAllClosedTrades(NOW, 'live');
      expect(live).toHaveLength(1);
      expect(live[0]?.idempotency_key).toBe('key-closed-live');

      const control = store.getAllClosedTrades(NOW, 'control');
      expect(control).toHaveLength(1);
      expect(control[0]?.idempotency_key).toBe('key-closed-control');
    });

    it('excludes a closed trade that closed after asOf', async () => {
      const db = makeDb();
      const execStore = new SqliteExecutionStore(db);
      await seedClosedTrade(
        execStore,
        makeClosedTrade({ closed_at: new Date('2026-07-28T00:00:00Z') }),
      );

      const store = new SqliteQueryStore(db);
      expect(store.getAllClosedTrades(NOW, 'live')).toEqual([]);
    });
  });
});

describe('SqliteQueryStore.getLlmSpend', () => {
  function seedSpend(db: StoreHandle, cost: number | null, at: Date): void {
    db.prepare(
      `INSERT INTO llm_spend (
         trace_id, stage, model, input_tokens, output_tokens,
         cache_creation_input_tokens, cache_read_input_tokens, cost_usd, timestamp
       ) VALUES ('t', 'debate', 'openai/gpt-5.6-luna', 100, 20, 5, 50, ?, ?)`,
    ).run(cost, at.toISOString());
  }

  function hoursBefore(hours: number): Date {
    return new Date(NOW.getTime() - hours * 60 * 60 * 1000);
  }

  it('reports the cap the orchestrator armed, whatever it was set to', () => {
    const db = makeDb();
    new SqliteLlmSpendCapStore(db).arm(275, NOW);
    expect(new SqliteQueryStore(db).getLlmSpend(NOW).cap_usd).toBe(275);
  });

  it('reports a null cap for an uncapped run, and never a default, but still records that it armed', () => {
    const db = makeDb();
    new SqliteLlmSpendCapStore(db).arm(null, NOW);
    const spend = new SqliteQueryStore(db).getLlmSpend(NOW);
    expect(spend.cap_usd).toBeNull();
    expect(spend.cap_armed_at).not.toBeNull();
  });

  it('reports a null cap and a null cap_armed_at when nothing has armed one', () => {
    const spend = new SqliteQueryStore(makeDb()).getLlmSpend(NOW);
    expect(spend.cap_usd).toBeNull();
    expect(spend.cap_armed_at).toBeNull();
  });

  it('reports an armed $0 cap as 0, distinct from uncapped or never-armed', () => {
    const db = makeDb();
    new SqliteLlmSpendCapStore(db).arm(0, NOW);
    const spend = new SqliteQueryStore(db).getLlmSpend(NOW);
    expect(spend.cap_usd).toBe(0);
    expect(spend.cap_armed_at).not.toBeNull();
  });

  it('reports cap_armed_at as the exact instant the orchestrator armed', () => {
    const db = makeDb();
    new SqliteLlmSpendCapStore(db).arm(275, NOW);
    expect(new SqliteQueryStore(db).getLlmSpend(NOW).cap_armed_at).toBe(NOW.toISOString());
  });

  it('returns zeroed windows on an empty table rather than throwing or returning null', () => {
    const store = new SqliteQueryStore(makeDb());
    const spend = store.getLlmSpend(NOW);

    expect(spend.last_24h).toEqual({
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
    });
  });

  it('scopes each rolling window to its own cutoff', () => {
    const db = makeDb();
    seedSpend(db, 1, hoursBefore(1));
    seedSpend(db, 2, hoursBefore(48));
    seedSpend(db, 4, hoursBefore(24 * 30));

    const spend = new SqliteQueryStore(db).getLlmSpend(NOW);
    expect(spend.last_24h.calls).toBe(1);
    expect(spend.last_24h.cost_usd).toBeCloseTo(1, 10);
    expect(spend.last_7d.calls).toBe(2);
    expect(spend.last_7d.cost_usd).toBeCloseTo(3, 10);
    expect(spend.all_time.calls).toBe(3);
    expect(spend.all_time.cost_usd).toBeCloseTo(7, 10);
  });

  it('excludes rows written after asOf, matching every other read on this store', () => {
    const db = makeDb();
    seedSpend(db, 1, new Date(NOW.getTime() + 60_000));

    expect(new SqliteQueryStore(db).getLlmSpend(NOW).all_time.calls).toBe(0);
  });

  it('counts unpriced calls separately and leaves them out of the dollar total', () => {
    const db = makeDb();
    seedSpend(db, 1.5, hoursBefore(1));
    seedSpend(db, null, hoursBefore(2));

    const window = new SqliteQueryStore(db).getLlmSpend(NOW).last_24h;
    expect(window.calls).toBe(2);
    expect(window.unpriced_calls).toBe(1);
    expect(window.cost_usd).toBeCloseTo(1.5, 10);
    expect(window.input_tokens).toBe(200);
  });

  it('sums the cache token columns so the tile can show the real token mix', () => {
    const db = makeDb();
    seedSpend(db, 1, hoursBefore(1));
    seedSpend(db, 1, hoursBefore(2));

    const window = new SqliteQueryStore(db).getLlmSpend(NOW).last_24h;
    expect(window.cache_read_input_tokens).toBe(100);
    expect(window.cache_creation_input_tokens).toBe(10);
    expect(window.output_tokens).toBe(40);
  });
});

describe('SqliteQueryStore.getLlmSpend per-debate percentiles', () => {
  function seedCall(
    db: StoreHandle,
    call: { debate_id: string | null; cost: number | null; latency: number | null; at: Date },
  ): void {
    db.prepare(
      `INSERT INTO llm_spend (
         trace_id, stage, debate_id, model, input_tokens, output_tokens,
         cache_creation_input_tokens, cache_read_input_tokens, cost_usd, latency_ms, timestamp
       ) VALUES ('t', 'debate', ?, 'openai/gpt-5.6-luna', 100, 20, 5, 50, ?, ?, ?)`,
    ).run(call.debate_id, call.cost, call.latency, call.at.toISOString());
  }

  const AT = new Date(NOW.getTime() - 60 * 60 * 1000);

  function seedDebates(
    db: StoreHandle,
    debates: Array<{ id: string; cost: number; latency: number; calls?: number }>,
  ): void {
    for (const debate of debates) {
      for (let i = 0; i < (debate.calls ?? 1); i++) {
        seedCall(db, { debate_id: debate.id, cost: debate.cost, latency: debate.latency, at: AT });
      }
    }
  }

  it('sums each debate before taking percentiles, so the unit is a decision not a call', () => {
    const db = makeDb();
    seedDebates(db, [{ id: 'debate-1', cost: 0.01, latency: 1_000, calls: 4 }]);

    const stats = new SqliteQueryStore(db).getLlmSpend(NOW).last_24h.per_debate;
    expect(stats.debates).toBe(1);
    expect(stats.llm_latency_ms_p50).toBe(4_000);
    expect(stats.cost_usd_p50).toBeCloseTo(0.04, 10);
  });

  it('reports a p95 that is above p50 on a long tail rather than collapsing to the median', () => {
    const db = makeDb();
    const debates = Array.from({ length: 9 }, (_, i) => ({
      id: `fast-${i}`,
      cost: 0.01,
      latency: 1_000,
    }));
    debates.push({ id: 'slow', cost: 0.5, latency: 60_000 });
    seedDebates(db, debates);

    const stats = new SqliteQueryStore(db).getLlmSpend(NOW).last_24h.per_debate;
    expect(stats.debates).toBe(10);
    expect(stats.llm_latency_ms_p50).toBe(1_000);
    expect(stats.llm_latency_ms_p95).toBe(60_000);
    expect(stats.cost_usd_p50).toBeCloseTo(0.01, 10);
    expect(stats.cost_usd_p95).toBeCloseTo(0.5, 10);
  });

  it('excludes unattributed calls from the percentiles and counts them instead', () => {
    const db = makeDb();
    seedDebates(db, [{ id: 'debate-1', cost: 0.02, latency: 2_000 }]);
    seedCall(db, { debate_id: null, cost: 9.99, latency: 900_000, at: AT });
    seedCall(db, { debate_id: null, cost: 9.99, latency: 900_000, at: AT });

    const window = new SqliteQueryStore(db).getLlmSpend(NOW).last_24h;
    expect(window.per_debate.debates).toBe(1);
    expect(window.per_debate.unattributed_calls).toBe(2);
    expect(window.per_debate.llm_latency_ms_p95).toBe(2_000);
    expect(window.calls).toBe(3);
    expect(window.cost_usd).toBeCloseTo(20, 10);
  });

  it('leaves an entirely unmeasured debate out of the latency sample, not in it as 0ms', () => {
    const db = makeDb();
    seedCall(db, { debate_id: 'old-1', cost: 0.01, latency: null, at: AT });
    seedCall(db, { debate_id: 'old-2', cost: 0.01, latency: null, at: AT });
    seedDebates(db, [
      { id: 'new-1', cost: 0.01, latency: 5_000 },
      { id: 'new-2', cost: 0.01, latency: 9_000 },
    ]);

    const stats = new SqliteQueryStore(db).getLlmSpend(NOW).last_24h.per_debate;
    expect(stats.debates).toBe(4);
    expect(stats.cost_usd_p50).toBeCloseTo(0.01, 10);
    expect(stats.llm_latency_ms_p50).toBe(5_000);
    expect(stats.llm_latency_ms_p95).toBe(9_000);
  });

  it('still totals the measured calls of a debate that is only PARTLY unmeasured', () => {
    const db = makeDb();
    seedCall(db, { debate_id: 'straddle', cost: 0.01, latency: null, at: AT });
    seedCall(db, { debate_id: 'straddle', cost: 0.01, latency: 3_000, at: AT });
    seedCall(db, { debate_id: 'straddle', cost: 0.01, latency: 4_000, at: AT });

    const stats = new SqliteQueryStore(db).getLlmSpend(NOW).last_24h.per_debate;
    expect(stats.debates).toBe(1);
    expect(stats.llm_latency_ms_p50).toBe(7_000);
  });

  it('scopes per-debate percentiles to the same window as the totals beside them', () => {
    const db = makeDb();
    seedCall(db, { debate_id: 'recent', cost: 0.01, latency: 1_000, at: hoursBefore24(1) });
    seedCall(db, { debate_id: 'older', cost: 0.02, latency: 90_000, at: hoursBefore24(48) });

    const spend = new SqliteQueryStore(db).getLlmSpend(NOW);
    expect(spend.last_24h.per_debate.debates).toBe(1);
    expect(spend.last_24h.per_debate.llm_latency_ms_p95).toBe(1_000);
    expect(spend.last_7d.per_debate.debates).toBe(2);
    expect(spend.last_7d.per_debate.llm_latency_ms_p95).toBe(90_000);
  });

  function hoursBefore24(hours: number): Date {
    return new Date(NOW.getTime() - hours * 60 * 60 * 1000);
  }
});

describe('SqliteQueryStore.getAlertDeliveryFailureCount (#1108)', () => {
  const ALERT_CHAT_ID = 'chat-1';
  const HEARTBEAT_CHAT_ID = 'chat-heartbeat';

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function seedFailure(db: StoreHandle, at: Date, chatId: string = ALERT_CHAT_ID): void {
    db.prepare(
      `INSERT INTO alert_delivery_failures (chat_id, method, body, error, timestamp)
       VALUES (?, 'sendMessage', 'body', 'fetch failed', ?)`,
    ).run(chatId, at.toISOString());
  }

  it('returns 0 on an empty table rather than throwing or returning null', () => {
    const store = new SqliteQueryStore(makeDb(), 30, ALERT_CHAT_ID);
    expect(store.getAlertDeliveryFailureCount(NOW)).toBe(0);
  });

  it('counts recorded ALERT-chat failures within the trailing window, up to and including asOf', () => {
    const db = makeDb();
    seedFailure(db, new Date(NOW.getTime() - 1_000));
    seedFailure(db, NOW);
    seedFailure(db, new Date(NOW.getTime() + 1_000));

    expect(new SqliteQueryStore(db, 30, ALERT_CHAT_ID).getAlertDeliveryFailureCount(NOW)).toBe(2);
  });

  it('excludes an ALERT-chat failure older than the trailing 24h window', () => {
    const db = makeDb();
    seedFailure(db, new Date(NOW.getTime() - 25 * 60 * 60 * 1000));

    expect(new SqliteQueryStore(db, 30, ALERT_CHAT_ID).getAlertDeliveryFailureCount(NOW)).toBe(0);
  });

  it('excludes a non-alert (heartbeat) chat_id row from the dashboard count', () => {
    const db = makeDb();
    seedFailure(db, NOW, HEARTBEAT_CHAT_ID);

    expect(new SqliteQueryStore(db, 30, ALERT_CHAT_ID).getAlertDeliveryFailureCount(NOW)).toBe(0);
  });

  it('counts an alert-chat row while a heartbeat-chat row in the same table is excluded', () => {
    const db = makeDb();
    seedFailure(db, NOW, ALERT_CHAT_ID);
    seedFailure(db, NOW, HEARTBEAT_CHAT_ID);
    seedFailure(db, NOW, HEARTBEAT_CHAT_ID);

    expect(new SqliteQueryStore(db, 30, ALERT_CHAT_ID).getAlertDeliveryFailureCount(NOW)).toBe(1);
  });

  it('returns 0 when no alert chat id is configured, even with matching rows present', () => {
    const db = makeDb();
    seedFailure(db, NOW, ALERT_CHAT_ID);

    expect(new SqliteQueryStore(db).getAlertDeliveryFailureCount(NOW)).toBe(0);
  });

  it('reads every permanently-failed send through the durable log even when the channel is totally dead, escalation attempts included', async () => {
    const db = makeDb();
    const alertDeliveryLog = new SqliteAlertDeliveryLog(db);
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:9') });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new TelegramBotApiClient({
      botToken: '1234567:test-fake-bot-token',
      alertChatId: ALERT_CHAT_ID,
      alertDeliveryLog,
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
      logger: { log: () => {} },
    });

    for (let i = 0; i < 5; i++) {
      await expect(client.sendMessage(ALERT_CHAT_ID, `alert ${i}`)).rejects.toThrow();
    }
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(6));

    const readAsOf = new Date(Date.now() + 60_000);
    expect(new SqliteQueryStore(db, 30, ALERT_CHAT_ID).getAlertDeliveryFailureCount(readAsOf)).toBe(
      5,
    );
  });
});

describe('percentile', () => {
  it('returns 0 for an empty sample rather than NaN or undefined', () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([], 0.95)).toBe(0);
  });

  it('takes the nearest rank, never an interpolated value that nothing observed', () => {
    const sample = [10, 20, 30, 40];
    expect(percentile(sample, 0.5)).toBe(20);
    expect(percentile(sample, 0.95)).toBe(40);
    expect(percentile(sample, 0.25)).toBe(10);
  });

  it('clamps to the ends instead of reading past the array', () => {
    expect(percentile([7], 0.5)).toBe(7);
    expect(percentile([7], 0.95)).toBe(7);
    expect(percentile([7, 9], 0)).toBe(7);
    expect(percentile([7, 9], 1)).toBe(9);
  });
});

describe('SqliteQueryStore.getPipelineActivity', () => {
  const LOOKBACK_MS = 15 * 60 * 1_000;

  function minutesBefore(minutes: number): string {
    return new Date(NOW.getTime() - minutes * 60 * 1_000).toISOString();
  }

  function seedMark(db: StoreHandle, instrument: string, asset_class: string): void {
    db.prepare(
      `INSERT INTO latest_mark (instrument, price, observed_at, asset_class, source)
       VALUES (?, 100, ?, ?, 'alpaca')`,
    ).run(instrument, minutesBefore(1), asset_class);
  }

  function seedTick(
    db: StoreHandle,
    tick: { instrument: string; asset_class: string; stage: string; trace_id: string; at: string },
  ): void {
    db.prepare(
      `INSERT INTO current_tick (instrument, asset_class, stage, trace_id, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(tick.instrument, tick.asset_class, tick.stage, tick.trace_id, tick.at);
  }

  function seedVerdict(
    db: StoreHandle,
    verdict: { trace_id: string; instrument: string; status: string; at: string },
  ): void {
    db.prepare(
      `INSERT INTO verdict_log (trace_id, idempotency_key, instrument, status, no_go_reason, hitl_override, timestamp)
       VALUES (?, ?, ?, ?, NULL, 0, ?)`,
    ).run(
      verdict.trace_id,
      `key-${verdict.trace_id}`,
      verdict.instrument,
      verdict.status,
      verdict.at,
    );
  }

  function seedAudit(
    db: StoreHandle,
    row: {
      trace_id: string;
      stage: string;
      decision: string;
      at: string;
      instrument?: string | null;
      asset_class?: string | null;
    },
  ): void {
    db.prepare(
      `INSERT INTO audit_log
         (trace_id, stage, decision, input_digest, output_digest, timestamp, instrument, asset_class)
       VALUES (?, ?, ?, 'in', 'out', ?, ?, ?)`,
    ).run(
      row.trace_id,
      row.stage,
      row.decision,
      row.at,
      row.instrument === undefined ? 'AAPL' : row.instrument,
      row.asset_class === undefined ? 'stocks' : row.asset_class,
    );
  }

  it('unions marked instruments and in-flight ticks into the universe, in lane order', () => {
    const db = makeDb();
    seedMark(db, 'TSLA', 'stocks');
    seedMark(db, 'BTC-USD', 'crypto');
    seedTick(db, {
      instrument: 'ETH-USD',
      asset_class: 'crypto',
      stage: 'debate',
      trace_id: 'trace-live',
      at: minutesBefore(1),
    });

    const activity = new SqliteQueryStore(db).getPipelineActivity(10, LOOKBACK_MS, NOW, 'live');

    expect(activity.universe).toEqual([
      { instrument: 'BTC-USD', asset_class: 'crypto' },
      { instrument: 'ETH-USD', asset_class: 'crypto' },
      { instrument: 'TSLA', asset_class: 'stocks' },
    ]);
  });

  it('bounds the universe by maxLanes so a 3-second poll cannot grow with latest_mark', () => {
    const db = makeDb();
    for (const instrument of ['AAPL', 'MSFT', 'QQQ', 'SPY', 'TSLA']) {
      seedMark(db, instrument, 'stocks');
    }

    const activity = new SqliteQueryStore(db).getPipelineActivity(2, LOOKBACK_MS, NOW, 'live');

    expect(activity.universe.map((u) => u.instrument)).toEqual(['AAPL', 'MSFT']);
  });

  it('gives a lane to an instrument with audit activity and no latest_mark row (#619)', () => {
    const db = makeDb();
    seedMark(db, 'SPY', 'stocks');
    seedAudit(db, {
      trace_id: 'trace-btc',
      stage: 'analysts',
      decision: 'quorum_met',
      at: minutesBefore(2),
      instrument: 'BTC-USD',
      asset_class: 'crypto',
    });
    seedAudit(db, {
      trace_id: 'trace-btc',
      stage: 'trader',
      decision: 'no_trade',
      at: minutesBefore(2),
      instrument: 'BTC-USD',
      asset_class: 'crypto',
    });

    const activity = new SqliteQueryStore(db).getPipelineActivity(10, LOOKBACK_MS, NOW, 'live');

    expect(activity.universe).toEqual([
      { instrument: 'BTC-USD', asset_class: 'crypto' },
      { instrument: 'SPY', asset_class: 'stocks' },
    ]);
    expect(activity.events.map((e) => e.stage)).toEqual(['analysts', 'trader']);
  });

  it('keeps a priced instrument with no recent activity as an idle lane', () => {
    const db = makeDb();
    seedMark(db, 'TSLA', 'stocks');
    seedAudit(db, {
      trace_id: 'trace-old',
      stage: 'verdict',
      decision: 'go',
      at: minutesBefore(90),
      instrument: 'TSLA',
      asset_class: 'stocks',
    });

    const activity = new SqliteQueryStore(db).getPipelineActivity(10, LOOKBACK_MS, NOW, 'live');

    expect(activity.universe).toEqual([{ instrument: 'TSLA', asset_class: 'stocks' }]);
    expect(activity.events).toEqual([]);
  });

  it('lets an active instrument outrank a merely priced one at the maxLanes cap', () => {
    const db = makeDb();
    seedMark(db, 'AAPL', 'stocks');
    seedMark(db, 'MSFT', 'stocks');
    seedAudit(db, {
      trace_id: 'trace-zeta',
      stage: 'analysts',
      decision: 'quorum_met',
      at: minutesBefore(1),
      instrument: 'ZETA',
      asset_class: 'stocks',
    });

    const activity = new SqliteQueryStore(db).getPipelineActivity(1, LOOKBACK_MS, NOW, 'live');

    expect(activity.universe).toEqual([{ instrument: 'ZETA', asset_class: 'stocks' }]);
  });

  it('does not let a control-only instrument displace a live one at the maxLanes cap', () => {
    const db = makeDb();
    seedAudit(db, {
      trace_id: `trace-control${CONTROL_TRACE_SUFFIX}`,
      stage: 'analysts',
      decision: 'quorum_met',
      at: minutesBefore(1),
      instrument: 'AAPL',
      asset_class: 'stocks',
    });
    seedAudit(db, {
      trace_id: 'trace-zeta',
      stage: 'analysts',
      decision: 'quorum_met',
      at: minutesBefore(1),
      instrument: 'ZETA',
      asset_class: 'stocks',
    });

    const activity = new SqliteQueryStore(db).getPipelineActivity(1, LOOKBACK_MS, NOW, 'live');

    expect(activity.universe).toEqual([{ instrument: 'ZETA', asset_class: 'stocks' }]);
  });

  it('gives no lane to an instrument only the control arm touched', () => {
    const db = makeDb();
    seedAudit(db, {
      trace_id: `trace-control${CONTROL_TRACE_SUFFIX}`,
      stage: 'analysts',
      decision: 'quorum_met',
      at: minutesBefore(1),
      instrument: 'BTC-USD',
      asset_class: 'crypto',
    });

    const activity = new SqliteQueryStore(db).getPipelineActivity(10, LOOKBACK_MS, NOW, 'live');

    expect(activity.universe).toEqual([]);
  });

  it('keeps an instrument both arms touched, from its live row alone', () => {
    const db = makeDb();
    seedAudit(db, {
      trace_id: 'trace-live',
      stage: 'analysts',
      decision: 'quorum_met',
      at: minutesBefore(1),
      instrument: 'AAPL',
      asset_class: 'stocks',
    });
    seedAudit(db, {
      trace_id: `trace-live${CONTROL_TRACE_SUFFIX}`,
      stage: 'analysts',
      decision: 'quorum_met',
      at: minutesBefore(1),
      instrument: 'AAPL',
      asset_class: 'stocks',
    });

    const activity = new SqliteQueryStore(db).getPipelineActivity(10, LOOKBACK_MS, NOW, 'live');

    expect(activity.universe).toEqual([{ instrument: 'AAPL', asset_class: 'stocks' }]);
  });

  describe('the mirror image for arm: "control" (#1594)', () => {
    it('does not let a live-only instrument displace a control one at the maxLanes cap', () => {
      const db = makeDb();
      seedAudit(db, {
        trace_id: 'trace-live',
        stage: 'analysts',
        decision: 'quorum_met',
        at: minutesBefore(1),
        instrument: 'AAPL',
        asset_class: 'stocks',
      });
      seedAudit(db, {
        trace_id: `trace-zeta${CONTROL_TRACE_SUFFIX}`,
        stage: 'analysts',
        decision: 'quorum_met',
        at: minutesBefore(1),
        instrument: 'ZETA',
        asset_class: 'stocks',
      });

      const activity = new SqliteQueryStore(db).getPipelineActivity(1, LOOKBACK_MS, NOW, 'control');

      expect(activity.universe).toEqual([{ instrument: 'ZETA', asset_class: 'stocks' }]);
    });

    it('gives no lane to an instrument only the live arm touched', () => {
      const db = makeDb();
      seedAudit(db, {
        trace_id: 'trace-live',
        stage: 'analysts',
        decision: 'quorum_met',
        at: minutesBefore(1),
        instrument: 'BTC-USD',
        asset_class: 'crypto',
      });

      const activity = new SqliteQueryStore(db).getPipelineActivity(
        10,
        LOOKBACK_MS,
        NOW,
        'control',
      );

      expect(activity.universe).toEqual([]);
    });

    it('keeps an instrument both arms touched, from its control row alone', () => {
      const db = makeDb();
      seedAudit(db, {
        trace_id: 'trace-live',
        stage: 'analysts',
        decision: 'quorum_met',
        at: minutesBefore(1),
        instrument: 'AAPL',
        asset_class: 'stocks',
      });
      seedAudit(db, {
        trace_id: `trace-live${CONTROL_TRACE_SUFFIX}`,
        stage: 'analysts',
        decision: 'quorum_met',
        at: minutesBefore(1),
        instrument: 'AAPL',
        asset_class: 'stocks',
      });

      const activity = new SqliteQueryStore(db).getPipelineActivity(
        10,
        LOOKBACK_MS,
        NOW,
        'control',
      );

      expect(activity.universe).toEqual([{ instrument: 'AAPL', asset_class: 'stocks' }]);
    });

    it('excludes current_tick entirely from a control-arm read, universe and live alike', () => {
      const db = makeDb();
      seedTick(db, {
        instrument: 'ETH-USD',
        asset_class: 'crypto',
        stage: 'debate',
        trace_id: 'trace-live',
        at: minutesBefore(1),
      });
      seedAudit(db, {
        trace_id: `trace-zeta${CONTROL_TRACE_SUFFIX}`,
        stage: 'analysts',
        decision: 'quorum_met',
        at: minutesBefore(1),
        instrument: 'ZETA',
        asset_class: 'stocks',
      });

      const activity = new SqliteQueryStore(db).getPipelineActivity(1, LOOKBACK_MS, NOW, 'control');

      expect(activity.universe).toEqual([{ instrument: 'ZETA', asset_class: 'stocks' }]);
      expect(activity.live).toEqual([]);
    });

    it('keeps a live current_tick out of a control read even when the tick instrument has a control lane', () => {
      const db = makeDb();
      seedTick(db, {
        instrument: 'AAPL',
        asset_class: 'stocks',
        stage: 'debate',
        trace_id: 'trace-live',
        at: minutesBefore(1),
      });
      seedAudit(db, {
        trace_id: `trace-aapl${CONTROL_TRACE_SUFFIX}`,
        stage: 'analysts',
        decision: 'quorum_met',
        at: minutesBefore(1),
        instrument: 'AAPL',
        asset_class: 'stocks',
      });

      const activity = new SqliteQueryStore(db).getPipelineActivity(
        10,
        LOOKBACK_MS,
        NOW,
        'control',
      );

      expect(activity.universe).toEqual([{ instrument: 'AAPL', asset_class: 'stocks' }]);
      expect(activity.live).toEqual([]);
    });

    it('still includes current_tick for arm: "live"', () => {
      const db = makeDb();
      seedTick(db, {
        instrument: 'ETH-USD',
        asset_class: 'crypto',
        stage: 'debate',
        trace_id: 'trace-live',
        at: minutesBefore(1),
      });

      const activity = new SqliteQueryStore(db).getPipelineActivity(10, LOOKBACK_MS, NOW, 'live');

      expect(activity.universe).toEqual([{ instrument: 'ETH-USD', asset_class: 'crypto' }]);
      expect(activity.live).toEqual([
        expect.objectContaining({ instrument: 'ETH-USD', trace_id: 'trace-live' }),
      ]);
    });
  });

  it('resolves an instrument whose sources disagree on asset class to one stable lane', () => {
    const db = makeDb();
    seedMark(db, 'AAPL', 'stocks');
    seedTick(db, {
      instrument: 'AAPL',
      asset_class: 'stocks',
      stage: 'debate',
      trace_id: 'trace-live',
      at: minutesBefore(1),
    });
    seedAudit(db, {
      trace_id: 'trace-live',
      stage: 'analysts',
      decision: 'quorum_met',
      at: minutesBefore(2),
      instrument: 'AAPL',
      asset_class: 'crypto',
    });

    const store = new SqliteQueryStore(db);

    expect(store.getPipelineActivity(10, LOOKBACK_MS, NOW, 'live').universe).toEqual([
      { instrument: 'AAPL', asset_class: 'crypto' },
    ]);
    expect(store.getPipelineActivity(10, LOOKBACK_MS, NOW, 'live').universe).toEqual([
      { instrument: 'AAPL', asset_class: 'crypto' },
    ]);
  });

  it('attributes a settled trace to its instrument through verdict_log', () => {
    const db = makeDb();
    seedMark(db, 'AAPL', 'stocks');
    seedVerdict(db, {
      trace_id: 'trace-1',
      instrument: 'AAPL',
      status: 'no_go',
      at: minutesBefore(2),
    });
    seedAudit(db, {
      trace_id: 'trace-1',
      stage: 'analysts',
      decision: 'quorum_met',
      at: minutesBefore(3),
    });
    seedAudit(db, {
      trace_id: 'trace-1',
      stage: 'verdict',
      decision: 'no_go',
      at: minutesBefore(2),
    });

    const activity = new SqliteQueryStore(db).getPipelineActivity(10, LOOKBACK_MS, NOW, 'live');

    expect(activity.events).toHaveLength(2);
    expect(activity.events[0]).toMatchObject({
      trace_id: 'trace-1',
      instrument: 'AAPL',
      asset_class: 'stocks',
      stage: 'analysts',
      decision: 'quorum_met',
    });
    expect(activity.events[1]?.stage).toBe('verdict');
  });

  it('attributes an in-flight trace through current_tick and reports when it entered the stage', () => {
    const db = makeDb();
    seedMark(db, 'BTC-USD', 'crypto');
    seedTick(db, {
      instrument: 'BTC-USD',
      asset_class: 'crypto',
      stage: 'trader',
      trace_id: 'trace-live',
      at: minutesBefore(1),
    });
    seedAudit(db, {
      trace_id: 'trace-live',
      stage: 'analysts',
      decision: 'quorum_met',
      at: minutesBefore(2),
      instrument: 'BTC-USD',
      asset_class: 'crypto',
    });

    const activity = new SqliteQueryStore(db).getPipelineActivity(10, LOOKBACK_MS, NOW, 'live');

    expect(activity.live).toEqual([
      {
        instrument: 'BTC-USD',
        asset_class: 'crypto',
        stage: 'trader',
        trace_id: 'trace-live',
        entered_at: new Date(minutesBefore(1)),
      },
    ]);
    expect(activity.events.map((e) => e.stage)).toEqual(['analysts']);
  });

  it('keeps only the most recent settled trace per instrument', () => {
    const db = makeDb();
    seedMark(db, 'AAPL', 'stocks');
    seedVerdict(db, { trace_id: 'old', instrument: 'AAPL', status: 'go', at: minutesBefore(9) });
    seedVerdict(db, { trace_id: 'new', instrument: 'AAPL', status: 'go', at: minutesBefore(2) });
    seedAudit(db, { trace_id: 'old', stage: 'verdict', decision: 'go', at: minutesBefore(9) });
    seedAudit(db, { trace_id: 'new', stage: 'verdict', decision: 'go', at: minutesBefore(2) });

    const activity = new SqliteQueryStore(db).getPipelineActivity(10, LOOKBACK_MS, NOW, 'live');

    expect(activity.events.map((e) => e.trace_id)).toEqual(['new']);
  });

  it('drops traces and ticks older than the lookback window', () => {
    const db = makeDb();
    seedMark(db, 'AAPL', 'stocks');
    seedMark(db, 'TSLA', 'stocks');
    seedVerdict(db, { trace_id: 'stale', instrument: 'AAPL', status: 'go', at: minutesBefore(60) });
    seedAudit(db, { trace_id: 'stale', stage: 'verdict', decision: 'go', at: minutesBefore(60) });
    seedTick(db, {
      instrument: 'TSLA',
      asset_class: 'stocks',
      stage: 'debate',
      trace_id: 'crashed',
      at: minutesBefore(90),
    });

    const activity = new SqliteQueryStore(db).getPipelineActivity(10, LOOKBACK_MS, NOW, 'live');

    expect(activity.events).toEqual([]);
    expect(activity.live).toEqual([]);
    expect(activity.universe).toHaveLength(2);
  });

  it('excludes rows after asOf, following the store-wide <= convention', () => {
    const db = makeDb();
    seedMark(db, 'AAPL', 'stocks');
    seedVerdict(db, {
      trace_id: 'trace-1',
      instrument: 'AAPL',
      status: 'go',
      at: minutesBefore(2),
    });
    seedAudit(db, {
      trace_id: 'trace-1',
      stage: 'analysts',
      decision: 'quorum_met',
      at: minutesBefore(3),
    });
    seedAudit(db, {
      trace_id: 'trace-1',
      stage: 'verdict',
      decision: 'go',
      at: new Date(NOW.getTime() + 60_000).toISOString(),
    });

    const activity = new SqliteQueryStore(db).getPipelineActivity(10, LOOKBACK_MS, NOW, 'live');

    expect(activity.events.map((e) => e.stage)).toEqual(['analysts']);
  });

  it('ignores audit rows whose stage is not a pipeline stage', () => {
    const db = makeDb();
    seedMark(db, 'AAPL', 'stocks');
    seedVerdict(db, {
      trace_id: 'trace-1',
      instrument: 'AAPL',
      status: 'go',
      at: minutesBefore(2),
    });
    seedAudit(db, { trace_id: 'trace-1', stage: 'verdict', decision: 'go', at: minutesBefore(2) });
    seedAudit(db, {
      trace_id: 'trace-1',
      stage: 'verdict.hitl.telegram_callback',
      decision: 'allowlist_rejected',
      at: minutesBefore(2),
    });

    const activity = new SqliteQueryStore(db).getPipelineActivity(10, LOOKBACK_MS, NOW, 'live');

    expect(activity.events.map((e) => e.stage)).toEqual(['verdict']);
  });

  it('orders a trace by timestamp then rowid, as getByTraceId does', () => {
    const db = makeDb();
    seedMark(db, 'AAPL', 'stocks');
    seedVerdict(db, {
      trace_id: 'trace-1',
      instrument: 'AAPL',
      status: 'go',
      at: minutesBefore(2),
    });
    const sameMs = minutesBefore(2);
    for (const stage of ['analysts', 'debate', 'trader', 'risk', 'verdict']) {
      seedAudit(db, { trace_id: 'trace-1', stage, decision: 'ok', at: sameMs });
    }

    const activity = new SqliteQueryStore(db).getPipelineActivity(10, LOOKBACK_MS, NOW, 'live');

    expect(activity.events.map((e) => e.stage)).toEqual([
      'analysts',
      'debate',
      'trader',
      'risk',
      'verdict',
    ]);
  });

  it('sees a trace that short-circuited before Verdict, via audit_log.instrument', () => {
    const db = makeDb();
    seedMark(db, 'AAPL', 'stocks');
    seedAudit(db, {
      trace_id: 'trace-1',
      stage: 'analysts',
      decision: 'quorum_met',
      at: minutesBefore(3),
    });
    seedAudit(db, {
      trace_id: 'trace-1',
      stage: 'trader',
      decision: 'no_trade',
      at: minutesBefore(3),
    });

    const activity = new SqliteQueryStore(db).getPipelineActivity(10, LOOKBACK_MS, NOW, 'live');

    expect(activity.events.map((e) => e.stage)).toEqual(['analysts', 'trader']);
    expect(activity.events[1]).toMatchObject({ instrument: 'AAPL', decision: 'no_trade' });
  });

  it('ignores audit rows with no instrument — unattributable is not a lane', () => {
    const db = makeDb();
    seedMark(db, 'AAPL', 'stocks');
    seedAudit(db, {
      trace_id: 'legacy',
      stage: 'verdict',
      decision: 'go',
      at: minutesBefore(2),
      instrument: null,
      asset_class: null,
    });

    const activity = new SqliteQueryStore(db).getPipelineActivity(10, LOOKBACK_MS, NOW, 'live');

    expect(activity.events).toEqual([]);
    expect(activity.universe).toEqual([{ instrument: 'AAPL', asset_class: 'stocks' }]);
  });

  it('ignores an audit row naming an instrument with no asset_class', () => {
    const db = makeDb();
    seedMark(db, 'AAPL', 'stocks');
    seedAudit(db, {
      trace_id: 'half',
      stage: 'verdict',
      decision: 'go',
      at: minutesBefore(2),
      instrument: 'GHOST',
      asset_class: null,
    });

    const activity = new SqliteQueryStore(db).getPipelineActivity(10, LOOKBACK_MS, NOW, 'live');

    expect(activity.universe).toEqual([{ instrument: 'AAPL', asset_class: 'stocks' }]);
    expect(activity.events).toEqual([]);
  });

  it("never lets a half-attributed row displace a lane's real trace", () => {
    const db = makeDb();
    seedMark(db, 'AAPL', 'stocks');
    seedAudit(db, {
      trace_id: 'real',
      stage: 'analysts',
      decision: 'quorum_met',
      at: minutesBefore(5),
    });
    seedAudit(db, {
      trace_id: 'real',
      stage: 'trader',
      decision: 'no_trade',
      at: minutesBefore(5),
    });
    seedAudit(db, {
      trace_id: 'half',
      stage: 'verdict',
      decision: 'go',
      at: minutesBefore(1),
      instrument: 'AAPL',
      asset_class: null,
    });

    const activity = new SqliteQueryStore(db).getPipelineActivity(10, LOOKBACK_MS, NOW, 'live');

    expect(activity.events.map((e) => e.trace_id)).toEqual(['real', 'real']);
    expect(activity.events.map((e) => e.stage)).toEqual(['analysts', 'trader']);
  });

  it('does not let a newer control-arm row win the newest-trace pick for an instrument the live arm also touched', () => {
    const db = makeDb();
    seedMark(db, 'AAPL', 'stocks');
    seedAudit(db, {
      trace_id: 'trace-live',
      stage: 'analysts',
      decision: 'quorum_skip_analyst_split',
      at: minutesBefore(5),
    });
    seedAudit(db, {
      trace_id: `trace-live${CONTROL_TRACE_SUFFIX}`,
      stage: 'analysts',
      decision: 'quorum_skip_analyst_split',
      at: minutesBefore(1),
    });

    const activity = new SqliteQueryStore(db).getPipelineActivity(10, LOOKBACK_MS, NOW, 'live');

    expect(activity.events.map((e) => e.trace_id)).toEqual(['trace-live']);
    expect(activity.events.map((e) => e.stage)).toEqual(['analysts']);
  });

  it("keeps an instrument's live stage sequence when the control arm touched it too", () => {
    const db = makeDb();
    seedMark(db, 'AAPL', 'stocks');
    seedAudit(db, {
      trace_id: 'trace-live',
      stage: 'analysts',
      decision: 'quorum_met',
      at: minutesBefore(5),
    });
    seedAudit(db, {
      trace_id: 'trace-live',
      stage: 'trader',
      decision: 'no_trade',
      at: minutesBefore(4),
    });
    seedAudit(db, {
      trace_id: `trace-live${CONTROL_TRACE_SUFFIX}`,
      stage: 'analysts',
      decision: 'quorum_met',
      at: minutesBefore(5),
    });
    seedAudit(db, {
      trace_id: `trace-live${CONTROL_TRACE_SUFFIX}`,
      stage: 'verdict',
      decision: 'go',
      at: minutesBefore(3),
    });

    const activity = new SqliteQueryStore(db).getPipelineActivity(10, LOOKBACK_MS, NOW, 'live');

    expect(activity.events.map((e) => e.trace_id)).toEqual(['trace-live', 'trace-live']);
    expect(activity.events.map((e) => e.stage)).toEqual(['analysts', 'trader']);
  });

  it('does not let a newer live-arm row win the newest-trace pick for a control-arm request', () => {
    const db = makeDb();
    seedMark(db, 'AAPL', 'stocks');
    seedAudit(db, {
      trace_id: `trace-live${CONTROL_TRACE_SUFFIX}`,
      stage: 'analysts',
      decision: 'quorum_skip_analyst_split',
      at: minutesBefore(5),
    });
    seedAudit(db, {
      trace_id: 'trace-live',
      stage: 'analysts',
      decision: 'quorum_skip_analyst_split',
      at: minutesBefore(1),
    });

    const activity = new SqliteQueryStore(db).getPipelineActivity(10, LOOKBACK_MS, NOW, 'control');

    expect(activity.events.map((e) => e.trace_id)).toEqual([`trace-live${CONTROL_TRACE_SUFFIX}`]);
    expect(activity.events.map((e) => e.stage)).toEqual(['analysts']);
  });

  it("keeps an instrument's control stage sequence when the live arm touched it too", () => {
    const db = makeDb();
    seedMark(db, 'AAPL', 'stocks');
    seedAudit(db, {
      trace_id: `trace-live${CONTROL_TRACE_SUFFIX}`,
      stage: 'analysts',
      decision: 'quorum_met',
      at: minutesBefore(5),
    });
    seedAudit(db, {
      trace_id: `trace-live${CONTROL_TRACE_SUFFIX}`,
      stage: 'trader',
      decision: 'no_trade',
      at: minutesBefore(4),
    });
    seedAudit(db, {
      trace_id: 'trace-live',
      stage: 'analysts',
      decision: 'quorum_met',
      at: minutesBefore(5),
    });
    seedAudit(db, {
      trace_id: 'trace-live',
      stage: 'verdict',
      decision: 'go',
      at: minutesBefore(3),
    });

    const activity = new SqliteQueryStore(db).getPipelineActivity(10, LOOKBACK_MS, NOW, 'control');

    expect(activity.events.map((e) => e.trace_id)).toEqual([
      `trace-live${CONTROL_TRACE_SUFFIX}`,
      `trace-live${CONTROL_TRACE_SUFFIX}`,
    ]);
    expect(activity.events.map((e) => e.stage)).toEqual(['analysts', 'trader']);
  });
});

describe('SqliteQueryStore.getRiskCritics', () => {
  function seedRisk(
    db: StoreHandle,
    spec: { trace_id: string; instrument: string; binding_constraint: string | null; at: Date },
  ): void {
    new SqliteRiskLogStore(db).write({
      trace_id: spec.trace_id,
      instrument: spec.instrument,
      status: spec.binding_constraint === null ? 'approved' : 'rejected',
      binding_constraint: spec.binding_constraint,
      reasons: ['seeded'],
      original_size: 10,
      final_size: 10,
      stop_tightened: false,
      breakers: {
        portfolio_tripped: false,
        crypto_tripped: false,
        stocks_tripped: false,
        armed_breakers: [],
      },
      portfolio: {
        equity: 1000,
        drawdown_pct: 0,
        gross_exposure: 0,
        consecutive_losses: 0,
        daily_pnl_portfolio_pct: 0,
        daily_pnl_crypto_pct: null,
        daily_pnl_stocks_pct: 0,
        daily_pnl_unknown_reason: null,
      },
      created_at: spec.at,
    });
  }

  function seedTrader(
    db: StoreHandle,
    spec: { trace_id: string; instrument: string; debate_id: string; at: Date },
  ): void {
    new SqliteTraderLogStore(db).write({
      trace_id: spec.trace_id,
      instrument: spec.instrument,
      debate_id: spec.debate_id,
      intent_type: 'entry',
      exit_reason: null,
      skip_reason: null,
      decision_class: null,
      reason_detail: null,
      sizing: null,
      cosine_precedent: null,
      atr: null,
      entry: null,
      stop: null,
      size: null,
      created_at: spec.at,
    });
  }

  function seedCritic(db: StoreHandle, debate_id: string, verdict: RiskCriticVerdict): void {
    new SqliteRiskCriticStore(db).writeVerdict({ debate_id, verdict, created_at: NOW });
  }

  const BREACHED_CONDITION: EvaluatedCondition = {
    condition: {
      id: 'mark-breaks-entry',
      observable: { kind: 'mark' },
      comparator: '<',
      threshold: 100,
      rationale: 'a break back under entry falsifies the breakout',
    },
    state: 'breached',
    observed: 98.5,
  };

  it('joins a decision to the critic verdict of the debate its trader row names', () => {
    const db = makeDb();
    seedRisk(db, {
      trace_id: 'trace-1',
      instrument: 'AAPL',
      binding_constraint: 'risk_critic:invalidated',
      at: NOW,
    });
    seedTrader(db, { trace_id: 'trace-1', instrument: 'AAPL', debate_id: 'debate-1', at: NOW });
    seedCritic(db, 'debate-1', {
      verdict: 'pass',
      max_notional: null,
      reasoning: 'prose says pass',
      conditions: [BREACHED_CONDITION],
      dropped_conditions: [{ id: null, raw: 'nonsense', reason: 'unparseable' }],
    });

    const records = new SqliteQueryStore(db).getRiskCritics(10, NOW, 'live');

    expect(records).toHaveLength(1);
    expect(records[0]?.trace_id).toBe('trace-1');
    expect(records[0]?.debate_id).toBe('debate-1');
    expect(records[0]?.binding_constraint).toBe('risk_critic:invalidated');
    expect(records[0]?.critic?.verdict).toBe('pass');
    expect(records[0]?.critic?.conditions).toEqual([BREACHED_CONDITION]);
    expect(records[0]?.critic?.dropped_conditions).toEqual([
      { id: null, raw: 'nonsense', reason: 'unparseable' },
    ]);
  });

  it('returns one row per decision when two traces share a debate', () => {
    const db = makeDb();
    for (const trace_id of ['trace-first', 'trace-retry']) {
      seedRisk(db, { trace_id, instrument: 'AAPL', binding_constraint: null, at: NOW });
      seedTrader(db, { trace_id, instrument: 'AAPL', debate_id: 'debate-shared', at: NOW });
    }
    seedCritic(db, 'debate-shared', {
      verdict: 'trim',
      max_notional: 250,
      reasoning: 'too big',
      conditions: [BREACHED_CONDITION],
    });

    const records = new SqliteQueryStore(db).getRiskCritics(10, NOW, 'live');

    expect(records).toHaveLength(2);
    expect(new Set(records.map((r) => r.trace_id))).toEqual(
      new Set(['trace-first', 'trace-retry']),
    );
    expect(records.every((r) => r.critic?.verdict === 'trim')).toBe(true);
  });

  it('reads a pre-fold critic row as a verdict carrying no conditions', () => {
    const db = makeDb();
    seedRisk(db, { trace_id: 'trace-old', instrument: 'AAPL', binding_constraint: null, at: NOW });
    seedTrader(db, { trace_id: 'trace-old', instrument: 'AAPL', debate_id: 'debate-old', at: NOW });
    db.prepare(
      `INSERT INTO risk_critic_log (debate_id, verdict, max_notional, reasoning, created_at)
       VALUES ('debate-old', 'pass', NULL, 'written before the fold', '2026-07-27T12:00:00.000Z')`,
    ).run();

    const records = new SqliteQueryStore(db).getRiskCritics(10, NOW, 'live');

    expect(records[0]?.critic?.verdict).toBe('pass');
    expect(records[0]?.critic?.conditions).toBeUndefined();
    expect(records[0]?.critic?.dropped_conditions).toBeUndefined();
  });

  it('reports a decision with no trader row, and one with no critic row, as having no verdict', () => {
    const db = makeDb();
    seedRisk(db, {
      trace_id: 'trace-no-trader',
      instrument: 'AAPL',
      binding_constraint: 'per_asset_class_cap',
      at: NOW,
    });
    seedRisk(db, {
      trace_id: 'trace-no-critic',
      instrument: 'TSLA',
      binding_constraint: null,
      at: NOW,
    });
    seedTrader(db, {
      trace_id: 'trace-no-critic',
      instrument: 'TSLA',
      debate_id: 'debate-uncriticised',
      at: NOW,
    });

    const byTrace = new Map(
      new SqliteQueryStore(db)
        .getRiskCritics(10, NOW, 'live')
        .map((record) => [record.trace_id, record]),
    );

    expect(byTrace.get('trace-no-trader')?.debate_id).toBeNull();
    expect(byTrace.get('trace-no-trader')?.critic).toBeUndefined();
    expect(byTrace.get('trace-no-critic')?.debate_id).toBe('debate-uncriticised');
    expect(byTrace.get('trace-no-critic')?.critic).toBeUndefined();
  });

  it('excludes control-arm decisions', () => {
    const db = makeDb();
    seedRisk(db, {
      trace_id: `trace-1${CONTROL_TRACE_SUFFIX}`,
      instrument: 'AAPL',
      binding_constraint: null,
      at: NOW,
    });
    seedTrader(db, {
      trace_id: `trace-1${CONTROL_TRACE_SUFFIX}`,
      instrument: 'AAPL',
      debate_id: `${CONTROL_DEBATE_ID_PREFIX}abc`,
      at: NOW,
    });
    seedRisk(db, {
      trace_id: `trace-2${CONTROL_TRACE_SUFFIX}`,
      instrument: 'AAPL',
      binding_constraint: null,
      at: NOW,
    });
    seedRisk(db, { trace_id: 'trace-1', instrument: 'AAPL', binding_constraint: null, at: NOW });
    seedTrader(db, { trace_id: 'trace-1', instrument: 'AAPL', debate_id: 'debate-live', at: NOW });

    const records = new SqliteQueryStore(db).getRiskCritics(10, NOW, 'live');

    expect(records.map((record) => record.trace_id)).toEqual(['trace-1']);
  });

  it('returns control-arm decisions for arm: "control", each with no critic verdict', () => {
    const db = makeDb();
    seedRisk(db, {
      trace_id: `trace-1${CONTROL_TRACE_SUFFIX}`,
      instrument: 'AAPL',
      binding_constraint: null,
      at: NOW,
    });
    seedTrader(db, {
      trace_id: `trace-1${CONTROL_TRACE_SUFFIX}`,
      instrument: 'AAPL',
      debate_id: `${CONTROL_DEBATE_ID_PREFIX}abc`,
      at: NOW,
    });
    seedRisk(db, {
      trace_id: `trace-2${CONTROL_TRACE_SUFFIX}`,
      instrument: 'AAPL',
      binding_constraint: null,
      at: NOW,
    });
    seedRisk(db, { trace_id: 'trace-1', instrument: 'AAPL', binding_constraint: null, at: NOW });
    seedTrader(db, { trace_id: 'trace-1', instrument: 'AAPL', debate_id: 'debate-live', at: NOW });

    const records = new SqliteQueryStore(db).getRiskCritics(10, NOW, 'control');

    expect(new Set(records.map((record) => record.trace_id))).toEqual(
      new Set([`trace-1${CONTROL_TRACE_SUFFIX}`, `trace-2${CONTROL_TRACE_SUFFIX}`]),
    );
    expect(records.every((record) => record.critic === undefined)).toBe(true);
  });

  it('returns the most recent decisions first, bounded by the limit and by asOf', () => {
    const db = makeDb();
    const at = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
    seedRisk(db, { trace_id: 'oldest', instrument: 'AAPL', binding_constraint: null, at: at(30) });
    seedRisk(db, { trace_id: 'middle', instrument: 'AAPL', binding_constraint: null, at: at(20) });
    seedRisk(db, { trace_id: 'newest', instrument: 'AAPL', binding_constraint: null, at: at(10) });
    seedRisk(db, {
      trace_id: 'after-asof',
      instrument: 'AAPL',
      binding_constraint: null,
      at: new Date(NOW.getTime() + 60_000),
    });

    const store = new SqliteQueryStore(db);

    expect(store.getRiskCritics(10, NOW, 'live').map((record) => record.trace_id)).toEqual([
      'newest',
      'middle',
      'oldest',
    ]);
    expect(store.getRiskCritics(2, NOW, 'live').map((record) => record.trace_id)).toEqual([
      'newest',
      'middle',
    ]);
  });
});
