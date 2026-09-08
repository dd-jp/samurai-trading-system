/**
 * `SqliteQueryStore` against a real (`:memory:`) SQLite instance (#161),
 * seeded with rows matching the other components' own fixture patterns
 * (dashboard-spec.md "Testing Decisions") — reuses `SqliteExecutionStore` /
 * `SqliteDebateLogStore` where a writer already exists, and raw inserts for
 * tables with no cut-over writer yet (`verdict_log`, `analyst_weights`,
 * `latest_mark`, `current_tick`).
 */
import { CONTROL_TRACE_SUFFIX } from '../../apps/orchestrator/control-arm.js';
import { SqliteAlertDeliveryLog } from '../../apps/orchestrator/index.js';
import { CONTROL_DEBATE_ID_PREFIX } from '../../pipeline/control-arm/index.js';
import type { AnalystContribution } from '../../pipeline/debate-engine/index.js';
import { SqliteDebateLogStore } from '../../pipeline/debate-engine/index.js';
import { SqliteExecutionStore } from '../../pipeline/execution/index.js';
import type { EvaluatedCondition, RiskCriticVerdict } from '../../pipeline/risk-manager/index.js';
import { SqliteRiskCriticStore } from '../../pipeline/risk-manager/index.js';
import type { CallbackAuditLog } from '../../pipeline/verdict/index.js';
import { TelegramBotApiClient } from '../../pipeline/verdict/index.js';
import type { ClosedTrade, DebateLog, Fill, OpenPosition } from '../../shared/index.js';
import {
  openSharedStore,
  type SharedStore,
  SqliteLlmSpendCapStore,
  SqliteRiskLogStore,
  SqliteTraderLogStore,
} from '../../shared/store/index.js';
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
    modelled_cost_charged: true,
    ...overrides,
  };
}

/** Seed a closed trade through the store's one write path (`applyLotAdvance`). */
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
    broker_fill_id: 'fill-1',
    leg: 'entry',
    price: 100,
    qty: 10,
    fee: 1,
    timestamp: new Date('2026-07-27T09:00:00Z'),
    ...overrides,
  };
}

/** Seed a closed trade AND its fills in one `applyLotAdvance` call (#940). */
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

    // A missing mark must NOT degrade into an omitted key — the dashboard would
    // render a position with no price. It throws, naming the instrument.
    expect(() => store.getMarks(['AAPL', 'TSLA'], NOW)).toThrow(/no mark for instrument "TSLA"/);

    expect(store.getMarks([], NOW).size).toBe(0);

    // Two open lots on one instrument (a scale-in) means buildSnapshot passes
    // the same instrument twice. Both rows must still resolve to a price.
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
    // Outside the trailing-24h window — must be excluded.
    await seedClosedTrade(
      execStore,
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

  /**
   * Pins the exact value `buildSnapshot`'s `toProfitFactorWire` (#1270)
   * depends on: a window with wins and no losses must go on producing
   * `Number.POSITIVE_INFINITY`, not `0`, `-1`, or anything else that
   * happens to also read as "not a normal ratio". Nothing upstream of
   * `toProfitFactorWire` checks this value's identity — a future edit to
   * `profitFactor()` that changed its sentinel would silently stop
   * `no_losses` from ever being reached, and only this test would notice.
   */
  it('returns +Infinity for profit_factor on a window with wins and no losses', async () => {
    const db = makeDb();
    const execStore = new SqliteExecutionStore(db);
    await seedClosedTrade(execStore, makeClosedTrade({ realized_pnl_net: 50 }));
    await seedClosedTrade(
      execStore,
      makeClosedTrade({ idempotency_key: 'key-closed-2', realized_pnl_net: 30 }),
    );

    const store = new SqliteQueryStore(db);
    const metrics = store.getDailyMetrics(NOW);

    expect(metrics.profit_factor).toBe(Number.POSITIVE_INFINITY);
  });

  /**
   * `wins === 0 && losses === 0` (no closed trades in the trailing window at
   * all) is a DIFFERENT fact from wins-and-no-losses above, and
   * `profitFactor()` must keep answering it with a real, finite `0` — the
   * value `toProfitFactorWire` wraps as `{ kind: 'ratio', value: 0 }`, not
   * `{ kind: 'no_losses' }`.
   */
  it('returns a finite 0 for profit_factor on a window with no closed trades at all', () => {
    const db = makeDb();
    const store = new SqliteQueryStore(db);
    const metrics = store.getDailyMetrics(NOW);

    expect(metrics.profit_factor).toBe(0);
  });

  it('accumulates attribution credit per analyst from closed trades joined to their debate log', async () => {
    const db = makeDb();
    const execStore = new SqliteExecutionStore(db);
    const debateStore = new SqliteDebateLogStore(db);

    debateStore.writeLog(makeDebateLog());
    await seedClosedTrade(execStore, makeClosedTrade({ realized_pnl_net: 50 })); // R = 50 / (5*10) = 1

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
    await seedClosedTrade(execStore, makeClosedTrade());

    const store = new SqliteQueryStore(db);
    expect(store.getAttribution(NOW)).toEqual({});
  });

  /**
   * #1081: `getAttribution` reads `debate_log` through its own SQL join,
   * independent of `getContributionsForAttribution` (the Feedback Loop's
   * read path in `debate-attribution-lookup.ts`) — this pins that the
   * exclusion was applied here too, not just there. Without it this
   * dashboard panel would credit a latency-truncated debate's analysts
   * while the Feedback Loop itself skipped that exact trade.
   */
  it('excludes attribution for trades whose debate was latency-truncated', async () => {
    const db = makeDb();
    const execStore = new SqliteExecutionStore(db);
    const debateStore = new SqliteDebateLogStore(db);

    debateStore.writeLog(makeDebateLog({ termination: 'latency_truncated' }));
    await seedClosedTrade(execStore, makeClosedTrade({ realized_pnl_net: 50 }));

    const store = new SqliteQueryStore(db);
    expect(store.getAttribution(NOW)).toEqual({});
  });

  it('keeps attribution for a pre-#1081 row with no termination recorded (indeterminate, not excluded)', async () => {
    const db = makeDb();
    const execStore = new SqliteExecutionStore(db);
    const debateStore = new SqliteDebateLogStore(db);

    // No `termination` supplied — mirrors a row written before migration 0041.
    debateStore.writeLog(makeDebateLog());
    await seedClosedTrade(execStore, makeClosedTrade({ realized_pnl_net: 50 }));

    const store = new SqliteQueryStore(db);
    expect(store.getAttribution(NOW)['technical-analyst']?.rolling_r).toBeCloseTo(1);
  });

  // #940: closed trades and their fills, surfaced for the dashboard.
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
      const trades = store.getRecentClosedTrades(1, NOW);

      expect(trades).toHaveLength(1);
      expect(trades[0]?.idempotency_key).toBe('key-closed-2');
    });

    it('excludes a closed trade that closed after asOf, matching every other read on this store', async () => {
      const db = makeDb();
      const execStore = new SqliteExecutionStore(db);
      await seedClosedTrade(
        execStore,
        makeClosedTrade({ closed_at: new Date('2026-07-28T00:00:00Z') }), // after NOW
      );

      const store = new SqliteQueryStore(db);
      expect(store.getRecentClosedTrades(10, NOW)).toEqual([]);
    });

    it('reads every fill for the named lots, ignoring lots not named', async () => {
      const db = makeDb();
      const execStore = new SqliteExecutionStore(db);
      await seedClosedTradeWithFills(execStore, makeClosedTrade({ idempotency_key: 'key-A' }), [
        makeFill({ idempotency_key: 'key-A', broker_fill_id: 'fill-A-entry', leg: 'entry' }),
        makeFill({
          idempotency_key: 'key-A',
          broker_fill_id: 'fill-A-target',
          leg: 'target',
          price: 110,
        }),
      ]);
      await seedClosedTradeWithFills(
        execStore,
        makeClosedTrade({ idempotency_key: 'key-B', debate_id: 'debate-1' }),
        [makeFill({ idempotency_key: 'key-B', broker_fill_id: 'fill-B-entry', leg: 'entry' })],
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
});

describe('SqliteQueryStore.getLlmSpend', () => {
  /** Writes straight to `llm_spend`; `SqliteLlmSpendStore` has its own suite. */
  function seedSpend(db: SharedStore, cost: number | null, at: Date): void {
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

  // #1140: the denominator the dashboard draws against is the one the
  // orchestrator armed, so a raised budget moves the meter instead of leaving
  // it measuring against a stale figure.
  it('reports the cap the orchestrator armed, whatever it was set to', () => {
    const db = makeDb();
    new SqliteLlmSpendCapStore(db).arm(275, NOW);
    expect(new SqliteQueryStore(db).getLlmSpend(NOW).cap_usd).toBe(275);
  });

  // #1196: an armed-uncapped run still carries a non-null `cap_armed_at` —
  // that is the field that keeps it from reading the same as never-armed.
  it('reports a null cap for an uncapped run, and never a default, but still records that it armed', () => {
    const db = makeDb();
    new SqliteLlmSpendCapStore(db).arm(null, NOW);
    const spend = new SqliteQueryStore(db).getLlmSpend(NOW);
    expect(spend.cap_usd).toBeNull();
    expect(spend.cap_armed_at).not.toBeNull();
  });

  // A store no orchestrator has ever booted against bounds nothing either —
  // the one thing it must not do is invent a denominator, and it must say
  // it was never armed rather than claiming uncapped (#1196).
  it('reports a null cap and a null cap_armed_at when nothing has armed one', () => {
    const spend = new SqliteQueryStore(makeDb()).getLlmSpend(NOW);
    expect(spend.cap_usd).toBeNull();
    expect(spend.cap_armed_at).toBeNull();
  });

  // The additional defect this ticket closes: a $0 cap is the MOST
  // restrictive state possible and must not collapse into "uncapped".
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
       ) VALUES ('t', 'debate', ?, 'openai/gpt-5.6-luna', 100, 20, 5, 50, ?, ?, ?)`,
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

describe('SqliteQueryStore.getAlertDeliveryFailureCount (#1108)', () => {
  const ALERT_CHAT_ID = 'chat-1';
  const HEARTBEAT_CHAT_ID = 'chat-heartbeat';

  // In an `afterEach`, not at the end of the one test body that stubs
  // `fetch`: a failing `expect` aborts the body, and an always-rejecting
  // global `fetch` would then leak into every later test in this file. The
  // hook runs whether the test passed, failed or threw. Deliberately local
  // rather than `unstubGlobals: true` in vitest.config.ts, which would
  // change teardown for every file in the suite.
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function seedFailure(db: SharedStore, at: Date, chatId: string = ALERT_CHAT_ID): void {
    db.prepare(
      `INSERT INTO alert_delivery_failures (chat_id, method, body, error, timestamp)
       VALUES (?, 'sendMessage', 'body', 'fetch failed', ?)`,
    ).run(chatId, at.toISOString());
  }

  it('returns 0 on an empty table rather than throwing or returning null', () => {
    const store = new SqliteQueryStore(makeDb(), 30, ALERT_CHAT_ID);
    expect(store.getAlertDeliveryFailureCount(NOW)).toBe(0);
  });

  // "up to and including asOf" — not "every", since #1131 added a trailing
  // lower bound alongside the pre-existing upper one; the window tests below
  // pin that lower bound specifically.
  it('counts recorded ALERT-chat failures within the trailing window, up to and including asOf', () => {
    const db = makeDb();
    seedFailure(db, new Date(NOW.getTime() - 1_000));
    seedFailure(db, NOW);
    seedFailure(db, new Date(NOW.getTime() + 1_000));

    expect(new SqliteQueryStore(db, 30, ALERT_CHAT_ID).getAlertDeliveryFailureCount(NOW)).toBe(2);
  });

  // #1131: the count used to have no lower bound, so a failure from months
  // before `asOf` still counted toward "is the alert channel down" forever.
  // Pinned at this layer too (the query-store, not just
  // alert-delivery-log.test.ts's direct unit coverage) because this is the
  // layer the dashboard wire actually reads through.
  it('excludes an ALERT-chat failure older than the trailing 24h window', () => {
    const db = makeDb();
    seedFailure(db, new Date(NOW.getTime() - 25 * 60 * 60 * 1000));

    expect(new SqliteQueryStore(db, 30, ALERT_CHAT_ID).getAlertDeliveryFailureCount(NOW)).toBe(0);
  });

  // #1108 third review pass: the CI-bot finding this closes. COUNT(*) with no
  // chat_id predicate previously counted every row in the table, heartbeat
  // sends included — but the tile is labeled "Alert channel" and answers "is
  // the alert channel down", so a heartbeat-chat outage must not degrade it
  // (#342's isolation already keeps a heartbeat failure from advancing or
  // triggering the escalation alert itself; this is the read-side twin).
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

  // The escalation chat id is unknown only under `SAMURAI_ALERTS=log-only`
  // (service-api/index.ts), the same configuration under which the
  // orchestrator never constructs a real Telegram client either — so this is
  // the "no known channel to answer the question about" case, not a bug
  // being papered over by returning 0.
  it('returns 0 when no alert chat id is configured, even with matching rows present', () => {
    const db = makeDb();
    seedFailure(db, NOW, ALERT_CHAT_ID);

    expect(new SqliteQueryStore(db).getAlertDeliveryFailureCount(NOW)).toBe(0);
  });

  // #1130: the tile's whole reason to exist is answering "is the alert
  // channel down" for the one case the in-band Telegram notice (#1108)
  // cannot — a dead transport. This drives a REAL `TelegramBotApiClient`
  // against a `fetch` that never succeeds, including the client's own
  // fire-and-forget "channel degraded" escalation attempt at the 3rd
  // failure, and reads the count back through this store — the same two
  // hops (client -> SqliteAlertDeliveryLog -> SqliteQueryStore) a live
  // dashboard poll makes. If the escalation attempt's own failure were ever
  // mistakenly recorded as a second delivery failure (the thing
  // telegram-bot-api-client.test.ts's "swallowed, not recorded as a second
  // failure" pins from the writer side), this count would overshoot 5.
  it('reads every permanently-failed send through the durable log even when the channel is totally dead, escalation attempts included', async () => {
    const db = makeDb();
    const alertDeliveryLog = new SqliteAlertDeliveryLog(db);
    const auditLog: CallbackAuditLog = { record: () => {} };
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:9') });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new TelegramBotApiClient({
      botToken: '1234567:test-fake-bot-token',
      allowedUserIds: '4242',
      auditLog,
      alertChatId: ALERT_CHAT_ID,
      alertDeliveryLog,
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
      logger: { log: () => {} },
    });

    for (let i = 0; i < 5; i++) {
      await expect(client.sendMessage(ALERT_CHAT_ID, `alert ${i}`)).rejects.toThrow();
    }
    // Waits on the thing the test is about rather than on the clock: six
    // fetches is five awaited sends (`maxAttempts: 1`) plus the one
    // fire-and-forget escalation the 3rd failure fires
    // (`DELIVERY_FAILURE_ALERT_EVERY` is 3, and 5 % 3 !== 0, so exactly one).
    // A bare `setTimeout(5)` here was load-flaky and proved nothing; this
    // asserts the escalation was actually attempted, which is the whole
    // point of expecting 5 rows and not 6 below.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(6));

    // `recordFailure` stamps the REAL wall clock (`new Date()`), not the
    // fixture `NOW` above — read forward of it, not at it, or every row
    // this test just wrote would be filtered out as "in the future".
    const readAsOf = new Date(Date.now() + 60_000);
    expect(new SqliteQueryStore(db, 30, ALERT_CHAT_ID).getAlertDeliveryFailureCount(readAsOf)).toBe(
      5,
    );
  });
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
 * much as the data: since migration 0013 a stage row names its own instrument,
 * so both which lanes exist and which rows land in them are read off
 * `audit_log.instrument` (#619). The NULL cases at the end are the standing
 * record of what stays unattributable — pre-0013 rows and the HITL callback
 * path — and of the rule that unattributable is never a lane.
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

  it('unions marked instruments and in-flight ticks into the universe, in lane order', () => {
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

  /**
   * #619's defect, in the shape the running soak produced it: `latest_mark` is
   * written only by `MarketDataServiceImpl.getMark`, on demand rather than per
   * tick, so the instruments doing all the work had no row in it at all. A
   * universe read off `latest_mark` alone showed four idle stocks and hid both
   * crypto instruments, while their traces sat in the same database.
   */
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

    const activity = new SqliteQueryStore(db).getPipelineActivity(10, LOOKBACK_MS, NOW);

    expect(activity.universe).toEqual([
      { instrument: 'BTC-USD', asset_class: 'crypto' },
      { instrument: 'SPY', asset_class: 'stocks' },
    ]);
    // The lane is not merely present — it carries the trace, which is what
    // makes the union worth having rather than a wider list of empty chips.
    expect(activity.events.map((e) => e.stage)).toEqual(['analysts', 'trader']);
  });

  it('keeps a priced instrument with no recent activity as an idle lane', () => {
    const db = makeDb();
    // Marked before the previous close and silent since — the stale-stock case.
    // Dropping it would read as "removed from the universe"; the Lobby exists
    // to say "priced, nothing running".
    seedMark(db, 'TSLA', 'stocks');
    seedAudit(db, {
      trace_id: 'trace-old',
      stage: 'verdict',
      decision: 'go',
      at: minutesBefore(90),
      instrument: 'TSLA',
      asset_class: 'stocks',
    });

    const activity = new SqliteQueryStore(db).getPipelineActivity(10, LOOKBACK_MS, NOW);

    expect(activity.universe).toEqual([{ instrument: 'TSLA', asset_class: 'stocks' }]);
    expect(activity.events).toEqual([]);
  });

  it('lets an active instrument outrank a merely priced one at the maxLanes cap', () => {
    const db = makeDb();
    // Alphabetically ahead of ZETA on both keys, so only the activity ranking
    // can save ZETA from the cap — and evicting the one instrument that is
    // running is exactly this ticket's failure mode arriving by another door.
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

    const activity = new SqliteQueryStore(db).getPipelineActivity(1, LOOKBACK_MS, NOW);

    expect(activity.universe).toEqual([{ instrument: 'ZETA', asset_class: 'stocks' }]);
  });

  it('resolves an instrument whose sources disagree on asset class to one stable lane', () => {
    const db = makeDb();
    // An instrument has exactly one asset class, so this is corrupt data by
    // construction. What it must NOT do is produce two lanes for one
    // instrument, or a class that changes between polls — a lane that flips
    // asset class reshuffles the hero under the operator's pointer, and
    // `MIN(asset_class)` is what pins the answer regardless of which row the
    // query plan reaches first.
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

    expect(store.getPipelineActivity(10, LOOKBACK_MS, NOW).universe).toEqual([
      { instrument: 'AAPL', asset_class: 'crypto' },
    ]);
    // Repeated because the failure this guards is a value that VARIES, which a
    // single assertion cannot distinguish from a value that is merely lucky.
    expect(store.getPipelineActivity(10, LOOKBACK_MS, NOW).universe).toEqual([
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

    const activity = new SqliteQueryStore(db).getPipelineActivity(10, LOOKBACK_MS, NOW);

    expect(activity.events).toHaveLength(2);
    expect(activity.events[0]).toMatchObject({
      trace_id: 'trace-1',
      instrument: 'AAPL',
      asset_class: 'stocks',
      stage: 'analysts',
      decision: 'quorum_met',
    });
    // `asset_class` is not on `verdict_log` — every event carries the one its
    // own `audit_log` row names.
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
    // it landing in a lane as a seventh, unrenderable stage.
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

  it('ignores an audit row naming an instrument with no asset_class', () => {
    const db = makeDb();
    seedMark(db, 'AAPL', 'stocks');
    // Half-attributed: `audit_log`'s two 0013 columns are independently
    // nullable, and a lane needs both — its asset class is what orders it and
    // what the view renders it as. Guessing one would put a lane on the wire
    // claiming an asset class no writer ever recorded.
    seedAudit(db, {
      trace_id: 'half',
      stage: 'verdict',
      decision: 'go',
      at: minutesBefore(2),
      instrument: 'GHOST',
      asset_class: null,
    });

    const activity = new SqliteQueryStore(db).getPipelineActivity(10, LOOKBACK_MS, NOW);

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
    // Newer, names AAPL, but carries no asset class — so it is not a trace this
    // view can render. "Attributed" must mean the same thing to the trace
    // choice as it does to the universe, or the newest unrenderable row wins
    // the lane and blanks a real trace sitting in the same window.
    seedAudit(db, {
      trace_id: 'half',
      stage: 'verdict',
      decision: 'go',
      at: minutesBefore(1),
      instrument: 'AAPL',
      asset_class: null,
    });

    const activity = new SqliteQueryStore(db).getPipelineActivity(10, LOOKBACK_MS, NOW);

    expect(activity.events.map((e) => e.trace_id)).toEqual(['real', 'real']);
    expect(activity.events.map((e) => e.stage)).toEqual(['analysts', 'trader']);
  });
});

/**
 * `getRiskCritics` (#1066) — the drawer's invalidation section, joined
 * server-side from `risk_log` through `trader_log` to `risk_critic_log`.
 */
describe('SqliteQueryStore.getRiskCritics', () => {
  function seedRisk(
    db: SharedStore,
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
    db: SharedStore,
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

  function seedCritic(db: SharedStore, debate_id: string, verdict: RiskCriticVerdict): void {
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

    const records = new SqliteQueryStore(db).getRiskCritics(10, NOW);

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

  /**
   * The reason this query is driven by `risk_log` rather than by
   * `risk_critic_log`: a retried tick mints a fresh `trace_id` but keeps the
   * content-hashed `debate_id` (migrations 0012/0015), so ONE critic row
   * belongs to two decisions. Each decision must come back once, carrying that
   * same verdict — never one decision twice, and never a fanned-out row.
   */
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

    const records = new SqliteQueryStore(db).getRiskCritics(10, NOW);

    expect(records).toHaveLength(2);
    expect(new Set(records.map((r) => r.trace_id))).toEqual(
      new Set(['trace-first', 'trace-retry']),
    );
    expect(records.every((r) => r.critic?.verdict === 'trim')).toBe(true);
  });

  /**
   * A row written before #994's fold has no `conditions_json` at all
   * (migration 0040 backfilled nothing). It must read back as a verdict with
   * no conditions — not as an empty list, which would claim the critic emitted
   * some and the validator refused them all — and must not throw.
   */
  it('reads a pre-fold critic row as a verdict carrying no conditions', () => {
    const db = makeDb();
    seedRisk(db, { trace_id: 'trace-old', instrument: 'AAPL', binding_constraint: null, at: NOW });
    seedTrader(db, { trace_id: 'trace-old', instrument: 'AAPL', debate_id: 'debate-old', at: NOW });
    db.prepare(
      `INSERT INTO risk_critic_log (debate_id, verdict, max_notional, reasoning, created_at)
       VALUES ('debate-old', 'pass', NULL, 'written before the fold', '2026-07-27T12:00:00.000Z')`,
    ).run();

    const records = new SqliteQueryStore(db).getRiskCritics(10, NOW);

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
      new SqliteQueryStore(db).getRiskCritics(10, NOW).map((record) => [record.trace_id, record]),
    );

    expect(byTrace.get('trace-no-trader')?.debate_id).toBeNull();
    expect(byTrace.get('trace-no-trader')?.critic).toBeUndefined();
    expect(byTrace.get('trace-no-critic')?.debate_id).toBe('debate-uncriticised');
    expect(byTrace.get('trace-no-critic')?.critic).toBeUndefined();
  });

  /**
   * Falsifier arm 2's decisions are excluded, like every other read on this
   * store (#753): the control arm calls no model, so its rows carry no critic
   * verdict, and letting them fill this bounded window would starve the live
   * arm's decisions of it.
   */
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
    // A control decision with NO trader row: the `debate_id` test cannot see
    // this one at all (the join yields NULL), so only the `trace_id` suffix on
    // the driving table keeps it out.
    seedRisk(db, {
      trace_id: `trace-2${CONTROL_TRACE_SUFFIX}`,
      instrument: 'AAPL',
      binding_constraint: null,
      at: NOW,
    });
    seedRisk(db, { trace_id: 'trace-1', instrument: 'AAPL', binding_constraint: null, at: NOW });
    seedTrader(db, { trace_id: 'trace-1', instrument: 'AAPL', debate_id: 'debate-live', at: NOW });

    const records = new SqliteQueryStore(db).getRiskCritics(10, NOW);

    expect(records.map((record) => record.trace_id)).toEqual(['trace-1']);
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

    expect(store.getRiskCritics(10, NOW).map((record) => record.trace_id)).toEqual([
      'newest',
      'middle',
      'oldest',
    ]);
    expect(store.getRiskCritics(2, NOW).map((record) => record.trace_id)).toEqual([
      'newest',
      'middle',
    ]);
  });
});
