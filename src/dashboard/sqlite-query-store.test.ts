/**
 * `SqliteQueryStore` against a real (`:memory:`) SQLite instance (#161),
 * seeded with rows matching the other components' own fixture patterns
 * (dashboard-spec.md "Testing Decisions") — reuses `SqliteExecutionStore` /
 * `SqliteDebateLogStore` where a writer already exists, and raw inserts for
 * tables with no cut-over writer yet (`verdict_log`, `analyst_weights`,
 * `latest_mark`, `current_tick`).
 */
import type { AnalystContribution } from '../debate-engine/index.js';
import { SqliteDebateLogStore } from '../debate-engine/index.js';
import { SqliteExecutionStore } from '../execution/index.js';
import type { ClosedTrade, DebateLog, OpenPosition } from '../shared/index.js';
import { openSharedStore, type SharedStore } from '../shared/store/index.js';
import { SqliteQueryStore } from './sqlite-query-store.js';

const NOW = new Date('2026-07-27T12:00:00Z');

function makeDb(): SharedStore {
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
    ...overrides,
  };
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
        opened_at: new Date('2026-07-28T00:00:00Z'), // after NOW
      }),
    );

    const store = new SqliteQueryStore(db);
    const positions = store.getOpenPositions(NOW);

    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({ idempotency_key: 'key-1', instrument: 'AAPL' });
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
    const verdicts = store.getVerdictHistory(10, NOW);

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

  it('computes profit_factor and expectancy from closed trades in the trailing day, leaving unsourced fields at 0', async () => {
    const db = makeDb();
    const execStore = new SqliteExecutionStore(db);
    await execStore.writeClosedTrade(makeClosedTrade({ realized_pnl_net: 50 }));
    await execStore.writeClosedTrade(
      makeClosedTrade({ idempotency_key: 'key-closed-2', realized_pnl_net: -20 }),
    );
    // Outside the trailing-24h window — must be excluded.
    await execStore.writeClosedTrade(
      makeClosedTrade({
        idempotency_key: 'key-closed-3',
        realized_pnl_net: 1000,
        closed_at: new Date('2026-07-20T11:00:00Z'),
      }),
    );

    const store = new SqliteQueryStore(db);
    const metrics = store.getDailyMetrics(NOW);

    expect(metrics.profit_factor).toBeCloseTo(50 / 20);
    expect(metrics.expectancy).toBeCloseTo(0.5 * 50 - 0.5 * 20);
    expect(metrics.sharpe).toBe(0);
    expect(metrics.max_drawdown).toBe(0);
  });

  it('accumulates attribution credit per analyst from closed trades joined to their debate log', async () => {
    const db = makeDb();
    const execStore = new SqliteExecutionStore(db);
    const debateStore = new SqliteDebateLogStore(db);

    debateStore.writeLog(makeDebateLog());
    await execStore.writeClosedTrade(makeClosedTrade({ realized_pnl_net: 50 })); // R = 50 / (5*10) = 1

    const store = new SqliteQueryStore(db, 30);
    const attribution = store.getAttribution(NOW);

    expect(attribution['technical-analyst']).toMatchObject({
      analyst_id: 'technical-analyst',
      window_days: 30,
    });
    expect(attribution['technical-analyst']?.rolling_r).toBeCloseTo(0.5 * 1); // influence_score x agreement x R
  });

  it('excludes attribution for trades whose debate log row is missing', async () => {
    const db = makeDb();
    const execStore = new SqliteExecutionStore(db);
    await execStore.writeClosedTrade(makeClosedTrade());

    const store = new SqliteQueryStore(db);
    expect(store.getAttribution(NOW)).toEqual({});
  });
});

describe('SqliteQueryStore.getLlmSpend', () => {
  /** Writes straight to `llm_spend`; `SqliteLlmSpendStore` has its own suite. */
  function seedSpend(db: SharedStore, cost: number | null, at: Date): void {
    db.prepare(
      `INSERT INTO llm_spend (
         trace_id, stage, model, input_tokens, output_tokens,
         cache_creation_input_tokens, cache_read_input_tokens, cost_usd, timestamp
       ) VALUES ('t', 'debate', 'claude-haiku-4-5', 100, 20, 5, 50, ?, ?)`,
    ).run(cost, at.toISOString());
  }

  function hoursBefore(hours: number): Date {
    return new Date(NOW.getTime() - hours * 60 * 60 * 1000);
  }

  it('returns zeroed windows on an empty table rather than throwing or returning null', () => {
    const store = new SqliteQueryStore(makeDb());
    const spend = store.getLlmSpend(NOW);

    // A fresh DB is the normal first-run state; the tile must render $0.00,
    // not blow up the whole snapshot.
    expect(spend.last_24h).toEqual({
      cost_usd: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      calls: 0,
      unpriced_calls: 0,
    });
  });

  it('scopes each rolling window to its own cutoff', () => {
    const db = makeDb();
    seedSpend(db, 1, hoursBefore(1)); // inside 24h, 7d and all-time
    seedSpend(db, 2, hoursBefore(48)); // inside 7d and all-time only
    seedSpend(db, 4, hoursBefore(24 * 30)); // all-time only

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
    // Both calls are counted and both contribute tokens; only the priced one
    // contributes dollars. `unpriced_calls` is what stops the figure being
    // read as a complete total.
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
