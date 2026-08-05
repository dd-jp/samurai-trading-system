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
import { percentile, SqliteQueryStore } from './sqlite-query-store.js';

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
    // agreement × R. `influence_score` is no longer a factor (#370) — the
    // fixture's 0.5 influence used to halve this figure.
    expect(attribution['technical-analyst']?.rolling_r).toBeCloseTo(1);
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
      // No debates means no percentile to report; 0 rather than null so the
      // tile has something to render without unwrapping (#326).
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

/**
 * Per-DECISION cost and LLM latency (#326) — "what does one decision cost me,
 * and is round 3 earning its latency?".
 */
describe('SqliteQueryStore.getLlmSpend per-debate percentiles', () => {
  function seedCall(
    db: SharedStore,
    call: { debate_id: string | null; cost: number | null; latency: number | null; at: Date },
  ): void {
    db.prepare(
      `INSERT INTO llm_spend (
         trace_id, stage, debate_id, model, input_tokens, output_tokens,
         cache_creation_input_tokens, cache_read_input_tokens, cost_usd, latency_ms, timestamp
       ) VALUES ('t', 'debate', ?, 'claude-haiku-4-5', 100, 20, 5, 50, ?, ?, ?)`,
    ).run(call.debate_id, call.cost, call.latency, call.at.toISOString());
  }

  const AT = new Date(NOW.getTime() - 60 * 60 * 1000);

  /** n debates, each of `calls` identical calls — so a per-debate total is calls x each. */
  function seedDebates(
    db: SharedStore,
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
    // One debate of four calls at 1000ms / $0.01 each = 4000ms / $0.04.
    seedDebates(db, [{ id: 'debate-1', cost: 0.01, latency: 1_000, calls: 4 }]);

    const stats = new SqliteQueryStore(db).getLlmSpend(NOW).last_24h.per_debate;
    expect(stats.debates).toBe(1);
    // Per-CALL percentiles would report 1000 / $0.01 here. The distinction is
    // the entire point of grouping on debate_id.
    expect(stats.llm_latency_ms_p50).toBe(4_000);
    expect(stats.cost_usd_p50).toBeCloseTo(0.04, 10);
  });

  it('reports a p95 that is above p50 on a long tail rather than collapsing to the median', () => {
    const db = makeDb();
    // Nine fast debates and one slow one: p50 is fast, p95 is the outlier.
    // This is the shape a retried call produces, and the reason the tile shows
    // both. Ten samples, deliberately: nearest rank puts p95 at ceil(0.95 x 10)
    // = 10, the slowest — with twenty it would be the 19th and a single
    // outlier would (correctly) not move it.
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
    // A NULL debate_id folded into the grouping would appear as a second
    // "debate" — here a huge one — and drag p95 up by construction.
    seedCall(db, { debate_id: null, cost: 9.99, latency: 900_000, at: AT });
    seedCall(db, { debate_id: null, cost: 9.99, latency: 900_000, at: AT });

    const window = new SqliteQueryStore(db).getLlmSpend(NOW).last_24h;
    expect(window.per_debate.debates).toBe(1);
    expect(window.per_debate.unattributed_calls).toBe(2);
    expect(window.per_debate.llm_latency_ms_p95).toBe(2_000);
    // The window TOTAL still includes them — they were really spent.
    expect(window.calls).toBe(3);
    expect(window.cost_usd).toBeCloseTo(20, 10);
  });

  it('leaves an entirely unmeasured debate out of the latency sample, not in it as 0ms', () => {
    const db = makeDb();
    // Rows written before migration 0012 have no latency. Scored as 0 they
    // would seat a fake instantaneous debate in the sample and drag both
    // percentiles down — the exact failure the nullable column exists to
    // prevent. Two unmeasured debates against two measured ones, so a
    // COALESCE-to-0 implementation would put p50 at 0 and be unmistakable.
    seedCall(db, { debate_id: 'old-1', cost: 0.01, latency: null, at: AT });
    seedCall(db, { debate_id: 'old-2', cost: 0.01, latency: null, at: AT });
    seedDebates(db, [
      { id: 'new-1', cost: 0.01, latency: 5_000 },
      { id: 'new-2', cost: 0.01, latency: 9_000 },
    ]);

    const stats = new SqliteQueryStore(db).getLlmSpend(NOW).last_24h.per_debate;
    // The pre-0012 debates are still debates and still have a cost...
    expect(stats.debates).toBe(4);
    expect(stats.cost_usd_p50).toBeCloseTo(0.01, 10);
    // ...but the latency percentiles are taken over [5000, 9000] alone.
    expect(stats.llm_latency_ms_p50).toBe(5_000);
    expect(stats.llm_latency_ms_p95).toBe(9_000);
  });

  it('still totals the measured calls of a debate that is only PARTLY unmeasured', () => {
    const db = makeDb();
    // A debate straddling the migration: some calls timed, some not. Its
    // latency is a floor, not an unknown, so it stays in the sample with the
    // calls it did measure rather than being dropped wholesale.
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
    // A window filter applied to the totals but not to the percentiles is the
    // kind of drift that makes two numbers on one tile describe different days.
    expect(spend.last_24h.per_debate.debates).toBe(1);
    expect(spend.last_24h.per_debate.llm_latency_ms_p95).toBe(1_000);
    expect(spend.last_7d.per_debate.debates).toBe(2);
    expect(spend.last_7d.per_debate.llm_latency_ms_p95).toBe(90_000);
  });

  function hoursBefore24(hours: number): Date {
    return new Date(NOW.getTime() - hours * 60 * 60 * 1000);
  }
});

describe('percentile', () => {
  it('returns 0 for an empty sample rather than NaN or undefined', () => {
    // A fresh database has no debates; the tile must render, not crash.
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([], 0.95)).toBe(0);
  });

  it('takes the nearest rank, never an interpolated value that nothing observed', () => {
    const sample = [10, 20, 30, 40];
    expect(percentile(sample, 0.5)).toBe(20);
    expect(percentile(sample, 0.95)).toBe(40);
    // 0.25 x 4 = 1 exactly — the boundary an off-by-one gets wrong.
    expect(percentile(sample, 0.25)).toBe(10);
  });

  it('clamps to the ends instead of reading past the array', () => {
    expect(percentile([7], 0.5)).toBe(7);
    expect(percentile([7], 0.95)).toBe(7);
    // fraction 0 would give rank 0; the smallest observation is the answer.
    expect(percentile([7, 9], 0)).toBe(7);
    expect(percentile([7, 9], 1)).toBe(9);
  });
});

/**
 * The Pipeline view's read (#411). These tests pin the ATTRIBUTION rules as
 * much as the data: `audit_log` has no instrument column, so which stage rows
 * a lane can see is a property of the joins this method performs, and the last
 * test here is the standing record of what those joins still cannot reach.
 */
describe('SqliteQueryStore.getPipelineActivity', () => {
  const LOOKBACK_MS = 15 * 60 * 1_000;

  function minutesBefore(minutes: number): string {
    return new Date(NOW.getTime() - minutes * 60 * 1_000).toISOString();
  }

  function seedMark(db: SharedStore, instrument: string, asset_class: string): void {
    db.prepare(
      `INSERT INTO latest_mark (instrument, price, observed_at, asset_class, source)
       VALUES (?, 100, ?, ?, 'alpaca')`,
    ).run(instrument, minutesBefore(1), asset_class);
  }

  function seedTick(
    db: SharedStore,
    tick: { instrument: string; asset_class: string; stage: string; trace_id: string; at: string },
  ): void {
    db.prepare(
      `INSERT INTO current_tick (instrument, asset_class, stage, trace_id, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(tick.instrument, tick.asset_class, tick.stage, tick.trace_id, tick.at);
  }

  function seedVerdict(
    db: SharedStore,
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

  /**
   * `instrument`/`asset_class` default to AAPL/stocks — most cases here run a
   * single instrument and only care about the stage walk. Attribution is not
   * optional in production: since migration 0013 `tick-runner.ts` always
   * writes both, and a row without them is one of the two documented
   * unattributable cases (pre-migration rows, and the HITL callback path).
   */
  function seedAudit(
    db: SharedStore,
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

  it('builds the lane universe from marked instruments and in-flight ticks, in lane order', () => {
    const db = makeDb();
    seedMark(db, 'TSLA', 'stocks');
    seedMark(db, 'BTC-USD', 'crypto');
    // An instrument mid-tick that has no mark yet must still get a lane —
    // otherwise the one instrument actually doing something is the one missing.
    seedTick(db, {
      instrument: 'ETH-USD',
      asset_class: 'crypto',
      stage: 'debate',
      trace_id: 'trace-live',
      at: minutesBefore(1),
    });

    const activity = new SqliteQueryStore(db).getPipelineActivity(10, LOOKBACK_MS, NOW);

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

    const activity = new SqliteQueryStore(db).getPipelineActivity(2, LOOKBACK_MS, NOW);

    expect(activity.universe.map((u) => u.instrument)).toEqual(['AAPL', 'MSFT']);
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

    const activity = new SqliteQueryStore(db).getPipelineActivity(10, LOOKBACK_MS, NOW);

    expect(activity.events).toHaveLength(2);
    expect(activity.events[0]).toMatchObject({
      trace_id: 'trace-1',
      instrument: 'AAPL',
      asset_class: 'stocks',
      stage: 'analysts',
      decision: 'quorum_met',
    });
    // `asset_class` is not on `verdict_log` — it comes from the universe row,
    // which is why an instrument with neither a mark nor a tick has no lane.
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

    const activity = new SqliteQueryStore(db).getPipelineActivity(10, LOOKBACK_MS, NOW);

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

    const activity = new SqliteQueryStore(db).getPipelineActivity(10, LOOKBACK_MS, NOW);

    // One lane holds one trace, so fetching every trace in the window would be
    // payload the view cannot use — on a 3-second poll that is the difference
    // between a bounded read and one that grows with the soak.
    expect(activity.events.map((e) => e.trace_id)).toEqual(['new']);
  });

  it('drops traces and ticks older than the lookback window', () => {
    const db = makeDb();
    seedMark(db, 'AAPL', 'stocks');
    seedMark(db, 'TSLA', 'stocks');
    seedVerdict(db, { trace_id: 'stale', instrument: 'AAPL', status: 'go', at: minutesBefore(60) });
    seedAudit(db, { trace_id: 'stale', stage: 'verdict', decision: 'go', at: minutesBefore(60) });
    // A crash mid-tick deliberately leaves `current_tick` behind
    // (tick-runner.ts). Outside the window it must not read as in-flight, or
    // the view reports a dead tick as running for as long as the row survives.
    seedTick(db, {
      instrument: 'TSLA',
      asset_class: 'stocks',
      stage: 'debate',
      trace_id: 'crashed',
      at: minutesBefore(90),
    });

    const activity = new SqliteQueryStore(db).getPipelineActivity(10, LOOKBACK_MS, NOW);

    expect(activity.events).toEqual([]);
    expect(activity.live).toEqual([]);
    // The lanes themselves survive — an instrument with nothing recent is idle,
    // not absent.
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

    const activity = new SqliteQueryStore(db).getPipelineActivity(10, LOOKBACK_MS, NOW);

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
    // The HITL Telegram callback writes to `audit_log` under the SAME
    // `trace_id` with its own stage name (telegram-bot-api-client.ts:112).
    // `audit_log.stage` is unconstrained TEXT, so nothing but this filter stops
    // it landing in a lane as an eighth, unrenderable stage.
    seedAudit(db, {
      trace_id: 'trace-1',
      stage: 'verdict.hitl.telegram_callback',
      decision: 'allowlist_rejected',
      at: minutesBefore(2),
    });

    const activity = new SqliteQueryStore(db).getPipelineActivity(10, LOOKBACK_MS, NOW);

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
    // Same ISO millisecond for every stage — what a fixed clock produces, and
    // where an unspecified tie-break would scramble the walk.
    const sameMs = minutesBefore(2);
    for (const stage of ['analysts', 'debate', 'trader', 'risk', 'verdict']) {
      seedAudit(db, { trace_id: 'trace-1', stage, decision: 'ok', at: sameMs });
    }

    const activity = new SqliteQueryStore(db).getPipelineActivity(10, LOOKBACK_MS, NOW);

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
    // A complete, real tick that stopped at Trader on `no_trade`. Its
    // `current_tick` row was deleted at tick end and it never reached Verdict,
    // so before migration 0013 nothing in the schema tied it to AAPL and this
    // lane rendered blank — indistinguishable from a closed market. The
    // instrument on the audit rows is the whole difference.
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

    const activity = new SqliteQueryStore(db).getPipelineActivity(10, LOOKBACK_MS, NOW);

    expect(activity.events.map((e) => e.stage)).toEqual(['analysts', 'trader']);
    expect(activity.events[1]).toMatchObject({ instrument: 'AAPL', decision: 'no_trade' });
  });

  it('ignores audit rows with no instrument — unattributable is not a lane', () => {
    const db = makeDb();
    seedMark(db, 'AAPL', 'stocks');
    // Both documented sources of NULL: rows written before migration 0013, and
    // the HITL callback path, which records under an existing trace_id with no
    // `Signal` in scope. Neither may be guessed into a lane.
    seedAudit(db, {
      trace_id: 'legacy',
      stage: 'verdict',
      decision: 'go',
      at: minutesBefore(2),
      instrument: null,
      asset_class: null,
    });

    const activity = new SqliteQueryStore(db).getPipelineActivity(10, LOOKBACK_MS, NOW);

    expect(activity.events).toEqual([]);
    expect(activity.universe).toEqual([{ instrument: 'AAPL', asset_class: 'stocks' }]);
  });
});
