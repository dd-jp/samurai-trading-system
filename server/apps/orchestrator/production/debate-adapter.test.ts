import { fundamentalAnalyst } from '../../../pipeline/analysts/index.js';
import { NOOP_ANALYST_TELEMETRY } from '../../../pipeline/analysts/types.js';
import type {
  AnalystView,
  AnthropicMessageRequest,
  AnthropicMessagesClient,
  DebateResult,
  LlmClient,
  LlmRequest,
  SpendCap,
  SpendCapVerdict,
} from '../../../pipeline/debate-engine/index.js';
import {
  AnthropicLlmClient,
  BUDGET_REMEDY,
  CORRUPT_LEDGER_REMEDY,
  computeDebateId,
  InMemoryDebateLogStore,
  LATENCY_BUDGET_MS,
  LlmAdmissionRefusedError,
  MAX_ROUNDS_BY_ASSET_CLASS,
  RateLimiter,
  READ_FAULT_REMEDY,
  SqliteDebateLogStore,
  SqliteLlmSpendStore,
  UNCAPPED_SPEND,
} from '../../../pipeline/debate-engine/index.js';
import { accumulateCredit } from '../../../pipeline/feedback-loop/index.js';
import { AlwaysOpenCalendar } from '../../../providers/market-data-service/index.js';
import { MarketIntelligenceStore } from '../../../providers/market-intelligence/index.js';
import type {
  AssetClass,
  Clock,
  ClosedTrade,
  DebateLog,
  DebateLogStore,
  LogEntry,
  Logger,
} from '../../../shared/index.js';
import { openSharedStore, type StoreHandle } from '../../../shared/store/index.js';
import {
  buildDebateStep,
  type GateRefusalRateGuardDeps,
  type LlmFailureRateGuardDeps,
  persistDebateLog,
} from './debate-adapter.js';
import {
  type GateRefusalRateAlert,
  type GateRefusalRateAlertChannel,
  GateRefusalRateMonitor,
  type GateRefusalWindowCounts,
  type GateRefusalWindowSource,
  type LlmGateRefusalSink,
} from './gate-refusal-rate-guard.js';
import {
  type LlmFailureRateAlert,
  type LlmFailureRateAlertChannel,
  LlmFailureRateMonitor,
  type LlmFailureRateWindowSource,
} from './llm-failure-rate-guard.js';

const NOW = new Date('2026-07-28T14:00:00Z');
const CLOCK: Clock = { now: () => NOW };

/**
 * A budget large enough never to bite, for the tests in this file that are
 * about the debate itself rather than about admission. The refusal path has
 * its own tests in `rate-limit-wiring.test.ts`.
 */
function unlimited(): RateLimiter {
  return new RateLimiter(CLOCK, {
    default: { windowMs: 60_000, maxLlmCalls: 10_000, maxDebates: 10_000 },
  });
}

/** A clock that can be advanced mid-test, for the same-bar cases (#782) */
class MutableClock implements Clock {
  constructor(private at: Date) {}
  now(): Date {
    return this.at;
  }
  advanceTo(at: Date): void {
    this.at = at;
  }
}

/** The asset class every fixture instrument in this file is treated as */
const ASSET_CLASS: AssetClass = 'stocks';

/** Retries are orthogonal to attribution; one attempt keeps the spend row count exact */
const NO_RETRY = { maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 10 };

function makeView(overrides: Partial<AnalystView> = {}): AnalystView {
  return {
    trace_id: 'trace-1',
    analyst_id: 'technical-1',
    analyst_type: 'technical',
    direction: 'bullish',
    confidence: 0.8,
    key_points: ['price above the 50d'],
    timestamp: NOW,
    ...overrides,
  };
}

interface FakeLlmOptions {
  /** false → the mediator never converges, so the debate runs to the 3-round hard cap */
  converged?: boolean;
  /** Throws from the mediator call, standing in for a debate that fails partway */
  failOnMediator?: boolean;
  /** When set alongside `failOnMediator`, thrown instead of the default Error — #1351's hostile-value case */
  mediatorFailureValue?: unknown;
}

/** Routes by prompt content — mirrors what personas.ts's four prompt shapes actually say */
function fakeLlmClient(options: FakeLlmOptions = {}): LlmClient {
  const { converged = true, failOnMediator = false, mediatorFailureValue } = options;
  return {
    async complete<T>(request: LlmRequest<T>) {
      let raw: string;
      if (request.prompt.includes('Bull persona')) {
        raw = JSON.stringify({ stance: 'bullish', rationale: 'strong momentum' });
      } else if (request.prompt.includes('Bear persona')) {
        raw = JSON.stringify({ stance: 'bearish', rationale: 'overbought risk' });
      } else if (request.prompt.includes('Mediator persona')) {
        if (failOnMediator) {
          throw mediatorFailureValue ?? new Error('llm transport blew up mid-debate');
        }
        raw = JSON.stringify({ stance: 'bullish', rationale: 'bull case wins', converged });
      } else {
        raw = JSON.stringify({ summary: 'no material disagreement', conflicts: [] });
      }
      const parsed = request.parseResponse(raw);
      if (!parsed.valid) {
        throw new Error(`fakeLlmClient: parseResponse rejected fixture: ${parsed.reason}`);
      }
      return { data: parsed.data, raw_text: raw, latency_ms: 1 };
    },
  };
}

function recordingLogger(): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { logger: { log: (entry) => entries.push(entry) }, entries };
}

describe('buildDebateStep', () => {
  it('presents the one-argument TickSteps.debate shape and returns a converged DebateResult', async () => {
    const step = buildDebateStep(
      fakeLlmClient(),
      new InMemoryDebateLogStore(),
      unlimited(),
      UNCAPPED_SPEND,
    );
    const views = [makeView()];

    const result = await step({
      trace_id: 'trace-1',
      instrument: 'AAPL',
      views,
      asset_class: ASSET_CLASS,
      clock: CLOCK,
      bar: NOW,
    });

    expect(result.converged).toBe(true);
    expect(result.direction).toBe('bullish');
    expect(result.rounds_completed).toBe(1);
    expect(result.contributions).toHaveLength(1);
    // position is the one field this adapter derives rather than sources
    // from an existing computation (see debate-adapter.ts doc comment) —
    // assert it's populated, not a specific fabricated value
    expect(result.position.length).toBeGreaterThan(0);
  });

  it('keys the debate to the PASSED bar, not a clock re-floor, even across a bar boundary (#743, was #393)', async () => {
    // Since #743 the adapter no longer floors `clock.now()` — the decision
    // gate claims the bar and passes it down, and this test is the one that
    // fails if anyone reintroduces a clock re-floor. The clock is deliberately
    // in the NEXT bar (the gate claimed at 14:5x, the pass straddled 15:00):
    // a re-floor computes 15:00:00 and diverges from the passed 14:00:00 in
    // both `debate_id` and `bar_timestamp`. (#393's original concern — the
    // row holding the raw tick time — is covered a fortiori: the clock reads
    // 15:05:09 and the row must still say 14:00:00.)
    const straddled = new Date('2026-07-28T15:05:09Z');
    const bar = new Date('2026-07-28T14:00:00Z');

    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);
    const step = buildDebateStep(fakeLlmClient(), store, unlimited(), UNCAPPED_SPEND);
    const views = [makeView()];

    const result = await step({
      trace_id: 'trace-mid-bar',
      instrument: 'AAPL',
      views,
      asset_class: ASSET_CLASS,
      clock: { now: () => straddled },
      bar,
    });

    // The id is hashed over the gate's bar, not the tick time. This is the
    // half that makes replay-from-log (ADR-0003 §2) reachable: a replay
    // stepping bar closes computes 14:00:00 and must land on the row a live
    // pass that finished at 15:05:09 wrote
    expect(result.debate_id).toBe(computeDebateId('AAPL', bar, views));

    const row = store.getByDebateId(result.debate_id);
    expect(row?.bar_timestamp.toISOString()).toBe(bar.toISOString());
    // ...and `created_at` still records the wall-clock write instant, which is
    // the distinction #393 was about: the two columns mean different things
    expect(row?.created_at.toISOString()).toBe(straddled.toISOString());
    expect(row?.trace_id).toBe('trace-mid-bar');
    // #687: and the SAME bar is carried forward to the Trader on the result,
    // so the intent's idempotency key lands on the coordinate `debate_id` was
    // hashed over even though the Trader runs after 15:00
    expect(result.bar_timestamp.toISOString()).toBe(bar.toISOString());
  });

  /**
   * #687 on the replay path, which is the case a re-derivation gets wrong most
   * quietly: the row was written in bar N, and this tick — a later tick in bar
   * N, or the first tick after a process restart within it — must be keyed to
   * the row's bar, not to whenever the replay ran
   */
  it('replays a persisted row with the ROWs bar_timestamp, not a fresh clock read (#687)', async () => {
    const store = new InMemoryDebateLogStore();
    const step = buildDebateStep(fakeLlmClient(), store, unlimited(), UNCAPPED_SPEND);
    const views = [makeView()];
    const bar = new Date('2026-07-28T14:00:00Z');

    const first = await step({
      trace_id: 'trace-first',
      instrument: 'AAPL',
      views,
      asset_class: ASSET_CLASS,
      clock: { now: () => new Date('2026-07-28T14:02:00Z') },
      bar,
    });

    const replayed = await step({
      trace_id: 'trace-replay',
      instrument: 'AAPL',
      views,
      asset_class: ASSET_CLASS,
      clock: { now: () => new Date('2026-07-28T14:57:31Z') },
      bar,
    });

    expect(replayed.debate_id).toBe(first.debate_id);
    expect(replayed.bar_timestamp.toISOString()).toBe(bar.toISOString());
    expect(replayed.bar_timestamp).toEqual(store.getByDebateId(first.debate_id)?.bar_timestamp);
  });

  it('applies analyst weights to the resolved debate, and logs the WEIGHTED result (#435)', async () => {
    // The DoD on #435 is explicit that reading the store is not enough: move a
    // weight, then assert the debate actually CHANGES
    //
    // A two-analyst panel is required for this to mean anything. With one
    // analyst, agreeing and total are the same set, the weighted and
    // unweighted agreement ratios are equal by construction, and the factor is
    // 1 whatever the weight — a test built on one view would pass while the
    // mechanism did nothing
    const views = [
      makeView({ analyst_id: 'bull-1', direction: 'bullish' }),
      makeView({ analyst_id: 'bear-1', direction: 'bearish' }),
    ];
    const run = (weights: Record<string, number>, store: InMemoryDebateLogStore) =>
      buildDebateStep(fakeLlmClient(), store, unlimited(), UNCAPPED_SPEND, undefined, {
        getAnalystWeights: () => weights,
      })({
        trace_id: 'trace-1',
        instrument: 'AAPL',
        views,
        asset_class: ASSET_CLASS,
        clock: CLOCK,
        bar: NOW,
      });

    const seededStore = new InMemoryDebateLogStore();
    const seeded = await run({ 'bull-1': 1, 'bear-1': 1 }, seededStore);

    const movedStore = new InMemoryDebateLogStore();
    // The mediator resolves bullish in this fixture, so `bull-1` is the
    // analyst that AGREES. Weighting it above the panel average must raise
    // conviction
    const moved = await run({ 'bull-1': 2, 'bear-1': 0.5 }, movedStore);

    expect(moved.confidence).toBeGreaterThan(seeded.confidence);

    // Same inputs and same bar, so the SAME debate_id — the point of weighting
    // the output rather than the inputs. The frozen cross-spec contract still
    // identifies the debate's inputs, undisturbed
    expect(moved.debate_id).toBe(seeded.debate_id);

    // And the LOGGED row carries the weighted conviction, so replay-from-log
    // restores what the Trader actually sized on rather than the pre-weight
    // figure
    expect(movedStore.getByDebateId(moved.debate_id)).toBeDefined();
  });

  it('writes exactly one debate_log row for a completed debate (#364)', async () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);
    const step = buildDebateStep(fakeLlmClient(), store, unlimited(), UNCAPPED_SPEND);

    const result = await step({
      trace_id: 'trace-1',
      instrument: 'AAPL',
      views: [makeView()],
      asset_class: ASSET_CLASS,
      clock: CLOCK,
      bar: NOW,
    });

    const count = db
      .prepare('SELECT COUNT(*) AS n FROM debate_log WHERE debate_id = ?')
      .get(result.debate_id) as { n: number };
    expect(count.n).toBe(1);

    // #1517 — the per-round verdicts persistDebateLog now writes alongside
    // the debate_log row, one per round the fake mediator actually ran
    const roundRows = db
      .prepare('SELECT round, direction FROM debate_round_log WHERE debate_id = ? ORDER BY round')
      .all(result.debate_id) as { round: number; direction: string }[];
    expect(roundRows.length).toBe(result.rounds_completed);
    expect(roundRows[roundRows.length - 1]?.direction).toBe(result.direction);

    const row = store.getByDebateId(result.debate_id);
    expect(row).toBeDefined();
    expect(row?.instrument).toBe('AAPL');
    // The row's bar_timestamp must be the SAME bar that went into
    // debate_id's hash — otherwise the row claims a coordinate the id
    // does not encode
    expect(row?.bar_timestamp.toISOString()).toBe(NOW.toISOString());
    expect(row?.direction).toBe('bullish');
    expect(row?.rounds).toBe(result.rounds_completed);
    expect(row?.contributions).toEqual(result.contributions);
  });

  it('writes a row for a debate that resolves WITHOUT converging (hard-cap termination)', async () => {
    const store = new InMemoryDebateLogStore();
    const step = buildDebateStep(
      fakeLlmClient({ converged: false }),
      store,
      unlimited(),
      UNCAPPED_SPEND,
    );

    const result = await step({
      trace_id: 'trace-1',
      instrument: 'BTC-USD',
      views: [makeView()],
      asset_class: ASSET_CLASS,
      clock: CLOCK,
      bar: NOW,
    });

    expect(result.converged).toBe(false);
    expect(result.rounds_completed).toBe(MAX_ROUNDS_BY_ASSET_CLASS[ASSET_CLASS]);
    // A halted debate is at least as interesting as a converged one: the row
    // is written on the same path, no convergence branch
    expect(store.getByDebateId(result.debate_id)?.rounds).toBe(
      MAX_ROUNDS_BY_ASSET_CLASS[ASSET_CLASS],
    );
  });

  it('writes NO row when the debate throws partway, and logs the miss', async () => {
    const store = new InMemoryDebateLogStore();
    const { logger, entries } = recordingLogger();
    const step = buildDebateStep(
      fakeLlmClient({ failOnMediator: true }),
      store,
      unlimited(),
      UNCAPPED_SPEND,
      logger,
    );
    const views = [makeView()];

    await expect(
      step({
        trace_id: 'trace-1',
        instrument: 'AAPL',
        views,
        asset_class: ASSET_CLASS,
        clock: CLOCK,
        bar: NOW,
      }),
    ).rejects.toThrow('llm transport blew up mid-debate');

    // debate_id is recomputable from (instrument, bar, views) even though the
    // debate produced no result — assert nothing was written under it, so the
    // eventual successful re-run can still claim the write-once key
    expect(store.getByDebateId(computeDebateId('AAPL', NOW, views))).toBeUndefined();

    const missed = entries.find((entry) => entry.stage === 'debate' && entry.level === 'error');
    expect(missed).toBeDefined();
    expect(missed?.message).toContain('no debate_log row');
  });

  // #1351: `logDebateFailure` has no internal try/catch — an unguarded render
  // of `cause` throws BEFORE `logger.log(...)` runs at all, so the
  // `debate_unresolved` diagnostic line (the one thing this function exists
  // to produce, per its own doc comment) never lands, and the render failure
  // — not the original `cause` — becomes what the caller's `throw cause;`
  // actually throws
  it('an unrenderable debate failure still logs debate_unresolved and still throws the ORIGINAL cause', async () => {
    const store = new InMemoryDebateLogStore();
    const { logger, entries } = recordingLogger();
    // Circular (defeats `JSON.stringify`) with a throwing `Symbol.toPrimitive`
    // (defeats the `String()` fallback too) — same shape as the #1262
    // tick-loop hostile value
    const hostile: Record<string, unknown> = {
      [Symbol.toPrimitive]: () => {
        throw new Error('render boom');
      },
    };
    hostile.self = hostile;
    const step = buildDebateStep(
      fakeLlmClient({ failOnMediator: true, mediatorFailureValue: hostile }),
      store,
      unlimited(),
      UNCAPPED_SPEND,
      logger,
    );
    const views = [makeView()];

    let thrown: unknown;
    try {
      await step({
        trace_id: 'trace-1',
        instrument: 'AAPL',
        views,
        asset_class: ASSET_CLASS,
        clock: CLOCK,
        bar: NOW,
      });
    } catch (error) {
      thrown = error;
    }

    // The durable artifact: the ORIGINAL cause's identity survives, not a
    // substitute render-failure error
    expect(thrown).toBe(hostile);

    const missed = entries.find(
      (entry) => entry.stage === 'debate' && entry.event === 'debate_unresolved',
    );
    expect(missed).toBeDefined();
    expect(missed?.message).toContain('[unrenderable error]');
  });

  it('replays the persisted debate when the same bar ticks again, spending nothing (#617)', async () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);
    const { logger, entries } = recordingLogger();

    let llmCalls = 0;
    const counting = fakeLlmClient();
    const countingClient: LlmClient = {
      async complete(request) {
        llmCalls++;
        return counting.complete(request);
      },
    };

    const step = buildDebateStep(countingClient, store, unlimited(), UNCAPPED_SPEND, logger);
    const input = {
      trace_id: 'trace-1',
      instrument: 'AAPL',
      views: [makeView()],
      asset_class: ASSET_CLASS,
      clock: CLOCK,
      bar: NOW,
    };

    const first = await step(input);
    const callsAfterFirst = llmCalls;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // Same clock, same views, same instrument → the same content-hash
    // debate_id. At a 15-minute cadence on a 1h bar this is not a retry, it is
    // three of every four scheduled ticks
    const second = await step({ ...input, trace_id: 'trace-1-retry' });

    expect(second.debate_id).toBe(first.debate_id);

    // The point of #617: the duplicate debate is not run at all. Before this,
    // the LLM calls were made and the result discarded at the write
    expect(llmCalls).toBe(callsAfterFirst);

    // And the Trader gets the SAME conviction the row holds — the defect was
    // that debate_log kept tick 1 while the Trader sized on tick N's fresh
    // sample, so the Feedback Loop attributed trades to a different sampling
    // of the same debate
    expect(second.confidence).toBe(first.confidence);
    expect(second.direction).toBe(first.direction);
    expect(second.confidence).toBe(store.getByDebateId(first.debate_id)?.confidence);

    const count = db.prepare('SELECT COUNT(*) AS n FROM debate_log').get() as { n: number };
    expect(count.n).toBe(1);

    // Replay is expected traffic on a shared bar, so it is info — not the
    // `warn` the old duplicate-write path emitted after already paying
    const replayed = entries.find((entry) => entry.message.includes('replayed from debate_log'));
    expect(replayed).toBeDefined();
    expect(replayed?.level).toBe('info');
    expect(entries.some((entry) => entry.message.includes('already has a debate_log'))).toBe(false);
  });

  it('replays the bar even when re-entered with DRIFTED views — the bar axis #617 misses (#781)', async () => {
    // The #617 short-circuit above is CONTENT-addressed: it only holds while
    // re-computed views are byte-identical within a bar, a premise #742 broke
    // by moving the technical read to 5m bars. This is the test the old
    // identical-views guard could not be: the second entry into the SAME bar
    // carries different views — a different content hash — and must STILL not
    // run a second debate. Its two callers are a forced-open decision gate
    // (mutation) and a rescinded claim retried after a crash whose first
    // attempt had already persisted its row
    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);
    const { logger, entries } = recordingLogger();

    let llmCalls = 0;
    const counting = fakeLlmClient();
    const countingClient: LlmClient = {
      complete(request) {
        llmCalls++;
        return counting.complete(request);
      },
    };

    const step = buildDebateStep(countingClient, store, unlimited(), UNCAPPED_SPEND, logger);

    const first = await step({
      trace_id: 'trace-1',
      instrument: 'AAPL',
      views: [makeView({ key_points: ['RSI 61.2 on the 5m read'] })],
      asset_class: ASSET_CLASS,
      clock: CLOCK,
      bar: NOW,
    });
    const callsAfterFirst = llmCalls;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // Same instrument, same bar — but the 5m technical read moved on, so the
    // views (and their content hash) differ. Pre-#743 this ran a full second
    // debate and handed the Trader a second confidence sample for the bar
    const second = await step({
      trace_id: 'trace-1-reentry',
      instrument: 'AAPL',
      views: [makeView({ key_points: ['RSI 63.8 on the 5m read'] })],
      asset_class: ASSET_CLASS,
      clock: CLOCK,
      bar: NOW,
    });

    expect(llmCalls).toBe(callsAfterFirst);
    // The bar resolved to the FIRST debate's identity and content — the memo
    // dedupes on the debate_id key through the same getByDebateId replay path
    // as #617, never on a second bar-keyed store lookup
    expect(second.debate_id).toBe(first.debate_id);
    expect(second.confidence).toBe(first.confidence);
    const count = db.prepare('SELECT COUNT(*) AS n FROM debate_log').get() as { n: number };
    expect(count.n).toBe(1);
    expect(entries.some((entry) => entry.message.includes('already resolved to a debate'))).toBe(
      true,
    );

    // A NEW bar is a genuinely new decision: the memo must not leak across
    const nextBar = new Date(NOW.getTime() + 3_600_000);
    const third = await step({
      trace_id: 'trace-2',
      instrument: 'AAPL',
      views: [makeView({ key_points: ['RSI 55.0 on the 5m read'] })],
      asset_class: ASSET_CLASS,
      clock: { now: () => nextBar },
      bar: nextBar,
    });
    expect(llmCalls).toBeGreaterThan(callsAfterFirst);
    expect(third.debate_id).not.toBe(first.debate_id);
  });

  /**
   * #782. The two guards above both live INSIDE one `buildDebateStep`
   * closure: the per-bar memo is in-memory and restart-clean, so after a
   * restart mid-bar the CONTENT hash is the only thing standing between the
   * bar and a second paid debate — and a second confidence sample for the
   * Trader, which `scale_in_conviction_delta` can turn into an extra lot.
   *
   * That content hash used to move on wall-clock time, not on the bar:
   * `fundamental`/`sentiment`/`technical` all read
   * `MarketIntelligenceStore.getContext`, whose window was rolling, so an item
   * ageing out between two ticks of one bar changed the item count in
   * `key_points` (and the analyst's own `confidence`) and missed the gate.
   *
   * Two step instances, ONE store: the second is the process that came back up
   * inside the same 14:00 bar, with the MI item now 24h10m old on a 24h window.
   */
  it('pays for one debate when an MI item ages out mid-bar across a restart (#782)', async () => {
    const bar = new Date('2026-07-28T14:00:00Z');
    const clock = new MutableClock(new Date('2026-07-28T14:01:00Z'));
    const intelligence = new MarketIntelligenceStore(clock);
    intelligence.ingest({
      agent_id: 'deepresearch',
      timestamp: new Date('2026-07-27T14:30:00Z'),
      asset_class: 'stocks',
      items: [
        {
          id: 'news-1',
          source: 'benzinga',
          type: 'news',
          timestamp: new Date('2026-07-27T14:30:00Z'),
          entity: 'AAPL',
          headline: 'Apple beats on revenue',
          sentiment: 1,
          confidence: 0.9,
        },
      ],
    });

    /** The one MarketDataService member `fundamental-analyst.ts` reaches for */
    const marketData = {
      getMark: async () => ({
        price: 100,
        observed_at: bar,
        asset_class: 'stocks' as const,
        source: 'fixture',
      }),
    } as unknown as Parameters<typeof fundamentalAnalyst.run>[0]['market_data'];

    /** The views as the analysts would recompute them at the current clock */
    const viewsNow = async (trace_id: string): Promise<AnalystView[]> => [
      await fundamentalAnalyst.run({
        trace_id,
        signal: { asset: 'AAPL', asset_class: 'stocks' },
        clock,
        bar,
        market_intelligence: intelligence,
        market_data: marketData,
        calendar: new AlwaysOpenCalendar(),
        telemetry: NOOP_ANALYST_TELEMETRY,
      }),
    ];

    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);
    let llmCalls = 0;
    const counting = fakeLlmClient();
    const countingClient: LlmClient = {
      complete(request) {
        llmCalls++;
        return counting.complete(request);
      },
    };

    const beforeRestart = buildDebateStep(countingClient, store, unlimited(), UNCAPPED_SPEND);
    const first = await beforeRestart({
      trace_id: 'trace-1',
      instrument: 'AAPL',
      views: await viewsNow('trace-1'),
      asset_class: ASSET_CLASS,
      clock,
      bar,
    });
    const callsAfterFirst = llmCalls;
    expect(callsAfterFirst).toBeGreaterThan(0);

    clock.advanceTo(new Date('2026-07-28T14:40:00Z'));

    // Fresh closure = fresh (empty) per-bar memo, exactly what a restart
    // inside the bar leaves behind. Same `bar`, because the decision gate
    // floors the tick time and 14:40 is still the 14:00 bar
    const afterRestart = buildDebateStep(countingClient, store, unlimited(), UNCAPPED_SPEND);
    const second = await afterRestart({
      trace_id: 'trace-2',
      instrument: 'AAPL',
      views: await viewsNow('trace-2'),
      asset_class: ASSET_CLASS,
      clock,
      bar,
    });

    expect(llmCalls).toBe(callsAfterFirst);
    expect(second.debate_id).toBe(first.debate_id);
    expect(second.confidence).toBe(first.confidence);
    const count = db.prepare('SELECT COUNT(*) AS n FROM debate_log').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('re-runs the debate when the persisted row predates the replay fields', async () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);
    const step = buildDebateStep(fakeLlmClient(), store, unlimited(), UNCAPPED_SPEND);
    const views = [makeView()];
    const debate_id = computeDebateId('AAPL', NOW, views);

    // A row as migration 0025 would have left it: no confidence, so nothing to
    // size a position on. Degrading to a re-run is the safe direction; replaying
    // it would trade on a reconstructed blank
    db.prepare(
      `INSERT INTO debate_log (debate_id, instrument, bar_timestamp, contributions_json,
         direction, rounds, created_at)
       VALUES (?, 'AAPL', ?, '[]', 'bullish', 1, ?)`,
    ).run(debate_id, NOW.toISOString(), NOW.toISOString());

    const result = await step({
      trace_id: 'trace-1',
      instrument: 'AAPL',
      views,
      asset_class: ASSET_CLASS,
      clock: CLOCK,
      bar: NOW,
    });

    expect(result.debate_id).toBe(debate_id);
    // The live debate ran and produced a real conviction, rather than the 0 a
    // blank reconstruction would have handed the Trader
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('re-runs the debate when the persisted row carries only SOME replay fields', async () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);
    const step = buildDebateStep(fakeLlmClient(), store, unlimited(), UNCAPPED_SPEND);
    const views = [makeView()];
    const debate_id = computeDebateId('AAPL', NOW, views);

    // Confidence present, the other five replay fields absent. The six are
    // independently optional and `writeLog` persists whatever subset it is
    // given, so "has a confidence" does not imply "is replayable". Checking
    // confidence alone replayed this as synthesis '', position '',
    // converged false — a fabricated debate handed to the Trader as a real one
    db.prepare(
      `INSERT INTO debate_log (debate_id, instrument, bar_timestamp, contributions_json,
         direction, rounds, created_at, confidence)
       VALUES (?, 'AAPL', ?, '[]', 'bullish', 1, ?, 0.9)`,
    ).run(debate_id, NOW.toISOString(), NOW.toISOString());

    const result = await step({
      trace_id: 'trace-1',
      instrument: 'AAPL',
      views,
      asset_class: ASSET_CLASS,
      clock: CLOCK,
      bar: NOW,
    });

    expect(result.debate_id).toBe(debate_id);
    expect(result.confidence).not.toBe(0.9);
    expect(result.synthesis).not.toBe('');
  });

  it('returns the winner’s row when it loses the duplicate-write race', async () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);
    const { logger, entries } = recordingLogger();
    const views = [makeView()];
    const debate_id = computeDebateId('AAPL', NOW, views);

    // The winner's row, as written by "another process". Its values are ones
    // the fake LLM never produces, so passing here cannot be an artefact of
    // both sides running the same deterministic fake
    const winner: DebateLog = {
      debate_id,
      instrument: 'AAPL',
      bar_timestamp: NOW,
      contributions: [],
      direction: 'bullish',
      rounds: 1,
      created_at: NOW,
      confidence: 0.4242,
      synthesis: 'the winner synthesis',
      position: 'the winner position',
      disagreement_summary: 'none',
      open_items: [],
      converged: true,
    };
    store.writeLog(winner);

    // Visible only AFTER the pre-debate replay check has run — the concurrent
    // writer the backstop exists for. Read 1 (replay check) reports nothing, so
    // the debate runs; read 2 (the write guard) finds the winner already there
    let reads = 0;
    const racing: DebateLogStore = {
      writeLog: (log) => {
        store.writeLog(log);
      },
      writeLogWithRounds: (log, entries) => {
        store.writeLogWithRounds(log, entries);
      },
      getByDebateId: (id) => {
        reads += 1;
        if (reads === 1) {
          return undefined;
        }
        return store.getByDebateId(id);
      },
    };

    const loser = await buildDebateStep(
      fakeLlmClient(),
      racing,
      unlimited(),
      UNCAPPED_SPEND,
      logger,
    )({
      trace_id: 'loser',
      instrument: 'AAPL',
      views,
      asset_class: ASSET_CLASS,
      clock: CLOCK,
      bar: NOW,
    });

    expect(loser.debate_id).toBe(debate_id);
    // The Trader must size on the bytes the Feedback Loop will attribute the
    // trade to. Skipping the duplicate write but returning the loser's own
    // discarded sample reproduces #617's mismatch inside the backstop
    expect(loser.confidence).toBe(0.4242);
    expect(loser.synthesis).toBe('the winner synthesis');
    expect(entries.some((entry) => entry.message.includes('already has a debate_log'))).toBe(true);

    const count = db.prepare('SELECT COUNT(*) AS n FROM debate_log').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("produces rows the Feedback Loop's attribution reader can consume end to end", async () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);
    const step = buildDebateStep(fakeLlmClient(), store, unlimited(), UNCAPPED_SPEND);

    const result = await step({
      trace_id: 'trace-1',
      instrument: 'AAPL',
      views: [makeView()],
      asset_class: ASSET_CLASS,
      clock: CLOCK,
      bar: NOW,
    });

    const trade: ClosedTrade = {
      idempotency_key: 'AAPL-2026-07-28T14',
      debate_id: result.debate_id,
      instrument: 'AAPL',
      asset_class: 'stocks',
      side: 'buy',
      entry: 100,
      stop: 95,
      filled_size: 10,
      realized_pnl_net: 100,
      fees_total: 1,
      opened_at: NOW,
      closed_at: new Date('2026-07-29T14:00:00Z'),
      close_reason: 'target',
      modelled_cost_charged: true,
    };

    // Two arguments, not three: #370 removed the shadow-credit config
    // parameter along with the dials themselves. The call kept passing one.
    const credits = accumulateCredit([trade], store);

    // Before #364 this map was empty for every trade in the soak: no row, so
    // `getContributionsForAttribution` returned undefined and the trade was
    // skipped outright
    const credit = credits.get('technical-1');
    expect(credit).toBeDefined();
    expect(credit?.trade_count).toBe(1);
    expect(credit?.total_credit).toBeGreaterThan(0);
  });
});

/**
 * The latency budget at the composition point (#374). `enforceLatencyBudget`
 * had no production caller, so a debate that never came back held the tick for
 * as long as the provider took — unbounded, on a 14-day unattended soak.
 *
 * These tests drive the STEP, not the budget module (which has its own unit
 * tests): the thing #374 was about is that the two were never connected, and
 * only a test through `buildDebateStep` can fail if they come apart again.
 */
describe('buildDebateStep latency budget (#374)', () => {
  /**
   * Answers normally for the first `stallAfterCalls` calls, then hangs until
   * the debate's `AbortSignal` fires — a provider that accepted the request
   * and stopped answering, which is the shape the budget exists for
   */
  function stallingLlmClient(options: { stallAfterCalls: number; converged?: boolean }): {
    client: LlmClient;
    callCount: () => number;
  } {
    const { stallAfterCalls, converged = false } = options;
    const inner = fakeLlmClient({ converged });
    let calls = 0;

    return {
      callCount: () => calls,
      client: {
        async complete<T>(request: LlmRequest<T>) {
          calls++;
          if (calls > stallAfterCalls) {
            return await new Promise<never>((_resolve, reject) => {
              request.signal?.addEventListener('abort', () =>
                reject(request.signal?.reason ?? new Error('aborted')),
              );
            });
          }
          return await inner.complete(request);
        },
      },
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns on budget instead of waiting for a debate that never answers', async () => {
    const { client } = stallingLlmClient({ stallAfterCalls: 0 });
    const step = buildDebateStep(client, new InMemoryDebateLogStore(), unlimited(), UNCAPPED_SPEND);

    const pending = step({
      trace_id: 'trace-1',
      instrument: 'AAPL',
      views: [makeView()],
      asset_class: 'stocks',
      clock: CLOCK,
      bar: NOW,
    });

    // Nothing completed a round, so this is the low-confidence fallback —
    // deliberately unactionable: confidence 0 is under any conviction floor,
    // so the tick short-circuits at Trader with no_trade
    await vi.advanceTimersByTimeAsync(LATENCY_BUDGET_MS.stocks);
    const result = await pending;

    expect(result.timed_out).toEqual({
      budget_ms: LATENCY_BUDGET_MS.stocks,
      elapsed_ms: LATENCY_BUDGET_MS.stocks,
      cause: 'budget',
    });
    expect(result.converged).toBe(false);
    expect(result.rounds_completed).toBe(0);
    expect(result.confidence).toBe(0);
    expect(result.contributions).toEqual([]);
  });

  /**
   * At a one-round cap the round that completes IS the debate, so there is no
   * round 2 for a stall to land in and the salvage path `getCurrentState`
   * exists for is unreachable. What this pins is the other half of the
   * contract: bull and bear answer, the mediator stalls, and the debate
   * degrades to the fallback with a row written rather than hanging.
   *
   * The salvage mechanism itself stays covered at its own seam —
   * `latency-budget.test.ts`, "uses the mediator synthesis in progress on
   * timeout, when available" — which is where it belongs: it is a property of
   * `enforceLatencyBudget`, not of the round cap this adapter happens to pass.
   */
  it('degrades to the fallback when the single round stalls before it closes', async () => {
    const { client, callCount } = stallingLlmClient({ stallAfterCalls: 2 });
    const store = new InMemoryDebateLogStore();
    const step = buildDebateStep(client, store, unlimited(), UNCAPPED_SPEND);
    const views = [makeView()];

    const pending = step({
      trace_id: 'trace-1',
      instrument: 'AAPL',
      views,
      asset_class: 'stocks',
      clock: CLOCK,
      bar: NOW,
    });

    await vi.advanceTimersByTimeAsync(LATENCY_BUDGET_MS.stocks);
    const result = await pending;

    expect(result.timed_out).toEqual({
      budget_ms: LATENCY_BUDGET_MS.stocks,
      elapsed_ms: LATENCY_BUDGET_MS.stocks,
      cause: 'budget',
    });
    expect(result.converged).toBe(false);
    expect(result.rounds_completed).toBe(0);
    expect(result.confidence).toBe(0);

    // The timed-out debate is still a resolved debate, so it gets its row
    expect(store.getByDebateId(result.debate_id)).toBeDefined();

    // Cancellation, not just abandonment (#347): no further persona call is
    // issued after the budget fires
    const atTimeout = callCount();
    await vi.advanceTimersByTimeAsync(LATENCY_BUDGET_MS.stocks);
    expect(callCount()).toBe(atTimeout);
  });

  it('uses the crypto budget for a crypto instrument', async () => {
    const { client } = stallingLlmClient({ stallAfterCalls: 0 });
    const step = buildDebateStep(client, new InMemoryDebateLogStore(), unlimited(), UNCAPPED_SPEND);

    const pending = step({
      trace_id: 'trace-1',
      instrument: 'BTC-USD',
      views: [makeView()],
      asset_class: 'crypto',
      clock: CLOCK,
      bar: NOW,
    });

    // 30s, not 60s — the per-asset-class lookup #374 called out as the
    // reason this could not be a one-line wire
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await pending;

    expect(result.timed_out).toEqual({ budget_ms: 30_000, elapsed_ms: 30_000, cause: 'budget' });
  });

  it('logs the timeout on the debate stage so an operator can see the budget fire', async () => {
    const { client } = stallingLlmClient({ stallAfterCalls: 0 });
    const { logger, entries } = recordingLogger();
    const step = buildDebateStep(
      client,
      new InMemoryDebateLogStore(),
      unlimited(),
      UNCAPPED_SPEND,
      logger,
    );

    const pending = step({
      trace_id: 'trace-1',
      instrument: 'AAPL',
      views: [makeView()],
      asset_class: 'stocks',
      clock: CLOCK,
      bar: NOW,
    });

    await vi.advanceTimersByTimeAsync(LATENCY_BUDGET_MS.stocks);
    await pending;

    const timeout = entries.find((entry) => entry.message === 'debate.timeout');
    expect(timeout).toBeDefined();
    expect(timeout?.stage).toBe('debate');
    expect(timeout?.trace_id).toBe('trace-1');
  });
});

/**
 * `persistDebateLog` with a PARTIAL/timed-out `DebateResult` — `round_verdicts`
 * non-empty, `rounds_completed >= 1`, `timed_out` set. `buildDebateStep`
 * cannot produce this shape today (see `persistDebateLog`'s own doc comment:
 * `maxRounds` is hardwired to `MAX_ROUNDS_BY_ASSET_CLASS[asset_class]`, 1 for
 * both classes since #1080, so a debate either completes its one round
 * cleanly or times out with ZERO rounds completed — the "degrades to the
 * fallback when the single round stalls before it closes" test above already
 * covers that zero-round case). Calling `persistDebateLog` directly is the
 * only way to drive the round rows for a truncated-but-partial debate through
 * the real write call rather than reasserting `round_verdicts` on the
 * `DebateResult` in isolation (already covered, `latency-budget.test.ts`).
 */
describe('persistDebateLog with a partial/timed-out result (#1558 review)', () => {
  function makePartialResult(overrides: Partial<DebateResult> = {}): DebateResult {
    return {
      synthesis: 'Round 1 leaned bullish before the budget fired.',
      position: 'Hold — insufficient debate to act.',
      confidence: 0.4,
      contributions: [],
      disagreement_summary: 'Bear had not yet rebutted round 1 when the budget fired.',
      open_items: ['debate did not complete within latency budget'],
      converged: false,
      rounds_completed: 1,
      latency_ms: LATENCY_BUDGET_MS.stocks,
      direction: 'bullish',
      round_verdicts: [{ round: 1, direction: 'bullish', confidence: 0.4 }],
      debate_id: 'debate-partial-1',
      bar_timestamp: NOW,
      read: true,
      timed_out: {
        budget_ms: LATENCY_BUDGET_MS.stocks,
        elapsed_ms: LATENCY_BUDGET_MS.stocks,
        cause: 'budget',
      },
      ...overrides,
    };
  }

  it('writes the round 1 verdict alongside the degraded debate_log row', () => {
    const store = new SqliteDebateLogStore(openSharedStore(':memory:'));

    persistDebateLog({
      store,
      result: makePartialResult(),
      instrument: 'AAPL',
      clock: CLOCK,
      trace_id: 'trace-1',
      logger: undefined,
    });

    const log = store.getByDebateId('debate-partial-1');
    expect(log).toBeDefined();
    expect(log?.rounds).toBe(1);

    const rounds = store.listRoundVerdicts(
      new Date('2026-07-28T00:00:00Z'),
      new Date('2026-07-29T00:00:00Z'),
    );
    expect(rounds).toEqual([
      {
        debate_id: 'debate-partial-1',
        round: 1,
        direction: 'bullish',
        confidence: 0.4,
        created_at: NOW,
      },
    ]);
  });
});

/**
 * The instrumentation half of #326, exercised end to end rather than at the
 * seam: a REAL `AnthropicLlmClient` over a fake wire client, writing through a
 * REAL `SqliteLlmSpendStore` into a real (`:memory:`) database, driven by
 * `buildDebateStep`.
 *
 * Testing this at the adapter is the point. Every unit below it passes with
 * attribution threaded through only SOME of the four calls a debate makes —
 * three personas plus the once-per-debate disagreement call — and the failure
 * that produces (a per-decision cost quietly missing a fixed slice) looks
 * exactly like a cheap debate. Only a whole debate can show that all of its
 * spend lands on one `debate_id`.
 */
describe('buildDebateStep LLM spend attribution (#326)', () => {
  interface SpendRow {
    trace_id: string;
    stage: string;
    debate_id: string | null;
    latency_ms: number | null;
    cost_usd: number | null;
  }

  /** Wire-level double: same prompt routing as `fakeLlmClient`, plus a usage block */
  function fakeWire(latencyMs: number): AnthropicMessagesClient {
    return {
      async createMessage(request: AnthropicMessageRequest) {
        const content = request.messages[0]?.content ?? '';
        let raw: string;
        if (content.includes('Bull persona')) {
          raw = JSON.stringify({ stance: 'bullish', rationale: 'strong momentum' });
        } else if (content.includes('Bear persona')) {
          raw = JSON.stringify({ stance: 'bearish', rationale: 'overbought risk' });
        } else if (content.includes('Mediator persona')) {
          raw = JSON.stringify({ stance: 'bullish', rationale: 'bull wins', converged: true });
        } else {
          raw = JSON.stringify({ summary: 'no material disagreement', conflicts: [] });
        }
        // Fake timers make the measured latency exact instead of flaky
        vi.advanceTimersByTime(latencyMs);
        return {
          content: [{ type: 'text', text: raw }],
          usage: { input_tokens: 100, output_tokens: 20 },
        };
      },
    };
  }

  function meteredStep(db: StoreHandle, latencyMs = 1_500) {
    const llm = new AnthropicLlmClient(
      fakeWire(latencyMs),
      { model: 'claude-haiku-4-5', max_tokens: 100, timeoutMs: 60_000, retry: NO_RETRY },
      new SqliteLlmSpendStore(db),
    );
    return buildDebateStep(llm, new SqliteDebateLogStore(db), unlimited(), UNCAPPED_SPEND);
  }

  function spendRows(db: StoreHandle): SpendRow[] {
    return db
      .prepare('SELECT trace_id, stage, debate_id, latency_ms, cost_usd FROM llm_spend ORDER BY id')
      .all() as SpendRow[];
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('bills every call a debate makes to that debate, including the disagreement call', async () => {
    const db = openSharedStore(':memory:');
    // Two views, so `detectDisagreements` actually issues its LLM call — below
    // two it short-circuits to the directional fallback and this test would
    // silently stop covering the call most likely to be left unattributed
    const views = [makeView(), makeView({ analyst_id: 'sentiment-1', direction: 'bearish' })];

    const result = await meteredStep(db)({
      trace_id: 'trace-1',
      instrument: 'AAPL',
      views,
      asset_class: ASSET_CLASS,
      clock: CLOCK,
      bar: NOW,
    });

    const rows = spendRows(db);
    // bull + bear + mediator + disagreement
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.debate_id === result.debate_id)).toBe(true);
    expect(rows.every((row) => row.latency_ms === 1_500)).toBe(true);
    expect(rows.every((row) => row.trace_id === 'trace-1')).toBe(true);
  });

  it('stamps spend with the same debate_id the debate_log row is keyed on, so the join resolves', async () => {
    const db = openSharedStore(':memory:');
    const views = [makeView(), makeView({ analyst_id: 'sentiment-1', direction: 'bearish' })];

    await meteredStep(db)({
      trace_id: 'trace-1',
      instrument: 'AAPL',
      views,
      asset_class: ASSET_CLASS,
      clock: CLOCK,
      bar: NOW,
    });

    // The acceptance criterion, expressed as the SQL an operator would write:
    // per-decision cost and LLM time, joined to the decision itself
    const joined = db
      .prepare(
        `SELECT debate_log.instrument      AS instrument,
                COUNT(*)                   AS calls,
                SUM(llm_spend.latency_ms)  AS llm_latency_ms
           FROM debate_log
           JOIN llm_spend USING (debate_id)
          GROUP BY debate_log.debate_id`,
      )
      .all() as Array<{ instrument: string; calls: number; llm_latency_ms: number }>;

    expect(joined).toHaveLength(1);
    expect(joined[0]?.instrument).toBe('AAPL');
    expect(joined[0]?.calls).toBe(4);
    expect(joined[0]?.llm_latency_ms).toBe(6_000);
  });

  it('completes the debate and writes its log row even when EVERY metering write fails', async () => {
    // The ticket's hard constraint: instrumentation must never fail a debate
    // Dropping the table stands in for a locked database or schema drift — the
    // sink's own catch is what has to hold, and this proves the debate that
    // resolved correctly is still recorded and still returned
    const db = openSharedStore(':memory:');
    const step = meteredStep(db);
    db.prepare('DROP TABLE llm_spend').run();
    const views = [makeView(), makeView({ analyst_id: 'sentiment-1', direction: 'bearish' })];

    const result = await step({
      trace_id: 'trace-1',
      instrument: 'AAPL',
      views,
      asset_class: ASSET_CLASS,
      clock: CLOCK,
      bar: NOW,
    });

    expect(result.direction).toBe('bullish');
    expect(result.converged).toBe(true);
    expect(new SqliteDebateLogStore(db).getByDebateId(result.debate_id)).toBeDefined();
  });

  it('does not fail a debate when the sink itself throws, not just the SQL underneath it', async () => {
    // `LlmSpendSink` is a public interface; a caller's own implementation may
    // throw where `SqliteLlmSpendStore` would not. The guarantee has to hold at
    // the client boundary, not rest on one implementation's good manners
    const db = openSharedStore(':memory:');
    const llm = new AnthropicLlmClient(
      fakeWire(10),
      { model: 'claude-haiku-4-5', max_tokens: 100, timeoutMs: 60_000, retry: NO_RETRY },
      {
        record: () => {
          throw new Error('metrics backend exploded');
        },
      },
    );
    const step = buildDebateStep(llm, new SqliteDebateLogStore(db), unlimited(), UNCAPPED_SPEND);

    const result = await step({
      trace_id: 'trace-1',
      instrument: 'AAPL',
      views: [makeView(), makeView({ analyst_id: 'sentiment-1', direction: 'bearish' })],
      asset_class: ASSET_CLASS,
      clock: CLOCK,
      bar: NOW,
    });

    expect(result.converged).toBe(true);
    expect(new SqliteDebateLogStore(db).getByDebateId(result.debate_id)).toBeDefined();
  });

  it('meters a debate that FAILS partway, attributed to the id its re-run will reuse', async () => {
    // No `debate_log` row is written for a failed debate (see
    // `persistDebateLog`) — but the calls it made were still billed. Keyed on
    // the deterministic `debate_id`, that spend stays attributable, and the
    // eventual successful re-run's spend lands on the same key rather than
    // looking like a second, cheaper debate
    const db = openSharedStore(':memory:');
    const failing: AnthropicMessagesClient = {
      async createMessage(request: AnthropicMessageRequest) {
        const content = request.messages[0]?.content ?? '';
        if (content.includes('Mediator persona')) {
          throw new Error('llm transport blew up mid-debate');
        }
        const raw = content.includes('Bull persona')
          ? JSON.stringify({ stance: 'bullish', rationale: 'strong momentum' })
          : JSON.stringify({ stance: 'bearish', rationale: 'overbought risk' });
        return {
          content: [{ type: 'text', text: raw }],
          usage: { input_tokens: 100, output_tokens: 20 },
        };
      },
    };
    const llm = new AnthropicLlmClient(
      failing,
      { model: 'claude-haiku-4-5', max_tokens: 100, timeoutMs: 60_000, retry: NO_RETRY },
      new SqliteLlmSpendStore(db),
    );
    const views = [makeView()];
    const step = buildDebateStep(llm, new SqliteDebateLogStore(db), unlimited(), UNCAPPED_SPEND);

    await expect(
      step({
        trace_id: 'trace-1',
        instrument: 'AAPL',
        views,
        asset_class: ASSET_CLASS,
        clock: CLOCK,
        bar: NOW,
      }),
    ).rejects.toThrow('llm transport blew up mid-debate');

    const rows = spendRows(db);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.debate_id === computeDebateId('AAPL', NOW, views))).toBe(true);
  });
});

/**
 * #1372: `debate_refused_spend_cap` used to assert "the budget does not
 * refill" unconditionally, which is false on the two fault refusal kinds — a
 * transient `llm_spend` read failure clears on its own. The message now reads
 * its remedy text from `spendCapRefusalRemedy(spend.kind)`. Assertions below
 * compare against the exported remedy constants, not literal substrings, so
 * a swap of which constant a kind maps to still reddens here (the constants
 * themselves don't move) while a wording-only edit does not touch this file.
 */
describe('buildDebateStep spend-cap refusal wording (#1372)', () => {
  function refusingSpendCap(verdict: Extract<SpendCapVerdict, { admitted: false }>): SpendCap {
    return { check: () => verdict };
  }

  it('states the budget remedy on a budget refusal, and its kind in the payload', async () => {
    const { logger, entries } = recordingLogger();
    const spendCap = refusingSpendCap({
      admitted: false,
      spent_usd: 50,
      budget_usd: 50,
      reason: 'LLM spend cap reached: $50.00 of $50.00 spent',
      kind: 'budget',
    });
    const step = buildDebateStep(
      fakeLlmClient(),
      new InMemoryDebateLogStore(),
      unlimited(),
      spendCap,
      logger,
    );

    const result = await step({
      trace_id: 'trace-1',
      instrument: 'AAPL',
      views: [makeView()],
      asset_class: ASSET_CLASS,
      clock: CLOCK,
      bar: NOW,
    });

    expect(result.confidence).toBe(0);
    const refusal = entries.find((entry) => entry.event === 'debate_refused_spend_cap');
    expect(refusal).toBeDefined();
    expect(refusal?.message).toContain(BUDGET_REMEDY);
    expect(refusal?.message).not.toContain(READ_FAULT_REMEDY);
    expect(refusal?.message).not.toContain(CORRUPT_LEDGER_REMEDY);
    expect(refusal?.payload).toMatchObject({ kind: 'budget' });
  });

  it('states the read-fault remedy on a read-fault refusal, and its kind in the payload', async () => {
    const { logger, entries } = recordingLogger();
    const spendCap = refusingSpendCap({
      admitted: false,
      spent_usd: Number.NaN,
      budget_usd: 50,
      reason: 'spend cap unreadable (fail-closed)',
      kind: 'read_fault',
    });
    const step = buildDebateStep(
      fakeLlmClient(),
      new InMemoryDebateLogStore(),
      unlimited(),
      spendCap,
      logger,
    );

    await step({
      trace_id: 'trace-1',
      instrument: 'AAPL',
      views: [makeView()],
      asset_class: ASSET_CLASS,
      clock: CLOCK,
      bar: NOW,
    });

    const refusal = entries.find((entry) => entry.event === 'debate_refused_spend_cap');
    expect(refusal).toBeDefined();
    expect(refusal?.message).toContain(READ_FAULT_REMEDY);
    expect(refusal?.message).not.toContain(BUDGET_REMEDY);
    expect(refusal?.message).not.toContain(CORRUPT_LEDGER_REMEDY);
    expect(refusal?.payload).toMatchObject({ kind: 'read_fault' });
  });

  it('states the corrupt-ledger remedy on a corrupt-ledger refusal, and its kind in the payload', async () => {
    const { logger, entries } = recordingLogger();
    const spendCap = refusingSpendCap({
      admitted: false,
      spent_usd: Number.NaN,
      budget_usd: 50,
      reason: 'llm_spend total is not a finite number (fail-closed)',
      kind: 'corrupt_ledger',
    });
    const step = buildDebateStep(
      fakeLlmClient(),
      new InMemoryDebateLogStore(),
      unlimited(),
      spendCap,
      logger,
    );

    await step({
      trace_id: 'trace-1',
      instrument: 'AAPL',
      views: [makeView()],
      asset_class: ASSET_CLASS,
      clock: CLOCK,
      bar: NOW,
    });

    const refusal = entries.find((entry) => entry.event === 'debate_refused_spend_cap');
    expect(refusal).toBeDefined();
    expect(refusal?.message).toContain(CORRUPT_LEDGER_REMEDY);
    expect(refusal?.message).not.toContain(BUDGET_REMEDY);
    expect(refusal?.message).not.toContain(READ_FAULT_REMEDY);
    expect(refusal?.payload).toMatchObject({ kind: 'corrupt_ledger' });
  });
});

describe('buildDebateStep gate refusal feeds its OWN refusal-rate guard (#1533)', () => {
  /** Stands in for the in-flight gate refusing every call this debate would make */
  function gateRefusingLlmClient(): LlmClient {
    return {
      async complete() {
        throw new LlmAdmissionRefusedError({
          message: 'admission refused: 1 in flight, budget 5000ms',
          reason: 'admission',
          queue_depth: 3,
          in_flight: 1,
          budget_ms: 5000,
          waited_ms: 0,
        });
      },
    };
  }

  function capturingRefusalChannel(): {
    channel: GateRefusalRateAlertChannel;
    posted: GateRefusalRateAlert[];
  } {
    const posted: GateRefusalRateAlert[] = [];
    return {
      channel: {
        postGateRefusalRateAlert: (alert) => {
          posted.push(alert);
        },
      },
      posted,
    };
  }

  function spySink(options: { throws?: boolean } = {}): {
    sink: LlmGateRefusalSink;
    recorded: Date[];
  } {
    const recorded: Date[] = [];
    return {
      sink: {
        recordGateRefusal: (occurred_at) => {
          if (options.throws === true) throw new Error('sink write failed');
          recorded.push(occurred_at);
        },
      },
      recorded,
    };
  }

  function refusalGuard(
    counts: GateRefusalWindowCounts,
    channel: GateRefusalRateAlertChannel | undefined,
    sink: LlmGateRefusalSink,
  ): GateRefusalRateGuardDeps {
    const windowSource: GateRefusalWindowSource = {
      getGateRefusalWindowCounts: () => counts,
    };
    return {
      windowSource,
      monitor: new GateRefusalRateMonitor(),
      alertChannel: channel,
      gateRefusalSink: sink,
    };
  }

  const REFUSED_STEP_INPUT = {
    trace_id: 'trace-1',
    instrument: 'AAPL',
    views: [makeView()],
    asset_class: ASSET_CLASS,
    clock: CLOCK,
    bar: NOW,
  };

  it('records the refusal on the sink and still returns a no-position, no-debate_log-row result', async () => {
    const { logger, entries } = recordingLogger();
    const store = new InMemoryDebateLogStore();
    const { sink, recorded } = spySink();
    const step = buildDebateStep(
      gateRefusingLlmClient(),
      store,
      unlimited(),
      UNCAPPED_SPEND,
      logger,
      undefined,
      undefined,
      refusalGuard({ gate_refused: 0, debates_logged: 0 }, undefined, sink),
    );

    const result = await step(REFUSED_STEP_INPUT);

    expect(result.position).toContain('No position');
    expect(store.getByDebateId(result.debate_id)).toBeUndefined();
    expect(recorded).toEqual([NOW]);

    const refusal = entries.find((entry) => entry.event === 'debate_refused_gate');
    expect(refusal).toBeDefined();
    expect(refusal?.level).toBe('warn');
  });

  it('alerts on a window that is entirely gate refusals, where debate_log reports nothing at all', async () => {
    const { logger } = recordingLogger();
    const { sink } = spySink();
    const { channel, posted } = capturingRefusalChannel();
    const step = buildDebateStep(
      gateRefusingLlmClient(),
      new InMemoryDebateLogStore(),
      unlimited(),
      UNCAPPED_SPEND,
      logger,
      undefined,
      undefined,
      refusalGuard({ gate_refused: 40, debates_logged: 0 }, channel, sink),
    );

    await step(REFUSED_STEP_INPUT);

    expect(posted).toHaveLength(1);
    expect(posted[0]?.rate).toBe(1);
    expect(posted[0]).toMatchObject({ gate_refused_count: 40, decision_count: 40 });
  });

  // The false-positive half, and the whole reason this is a separate signal:
  // four of every six concurrent debates refused is the SHIPPED DESIGN
  // (production/defaults.ts), not a fault. A day of it must post nothing.
  it('stays silent at the designed four-of-six refusal ratio, however large the volume', async () => {
    const { logger } = recordingLogger();
    const { sink } = spySink();
    const { channel, posted } = capturingRefusalChannel();
    const step = buildDebateStep(
      gateRefusingLlmClient(),
      new InMemoryDebateLogStore(),
      unlimited(),
      UNCAPPED_SPEND,
      logger,
      undefined,
      undefined,
      // ~384 refusals against ~192 debates over 24h at a 15-min cadence: the
      // steady state defaults.ts describes, ratio 0.667
      refusalGuard({ gate_refused: 384, debates_logged: 192 }, channel, sink),
    );

    await step(REFUSED_STEP_INPUT);

    expect(posted).toHaveLength(0);
  });

  // Review round 1 F1, at the call site: a refusal must not reach the
  // truncation-rate guard in any way — not its window read, not its alert
  it('never touches the llm-failure-rate guard on the refusal path', async () => {
    const { logger } = recordingLogger();
    const { sink } = spySink();
    const truncationWindowReads: Array<{ from: Date; to: Date }> = [];
    const truncationSource: LlmFailureRateWindowSource = {
      getTerminationCauseWindowCounts: (from, to) => {
        truncationWindowReads.push({ from, to });
        // Would cross LLM_FAILURE_RATE_THRESHOLD outright if it were ever read
        return { llm_failure: 9, total: 10 };
      },
    };
    const truncationPosted: LlmFailureRateAlert[] = [];
    const truncationChannel: LlmFailureRateAlertChannel = {
      postLlmFailureRateAlert: (alert) => {
        truncationPosted.push(alert);
      },
    };
    const failureRateGuard: LlmFailureRateGuardDeps = {
      windowSource: truncationSource,
      monitor: new LlmFailureRateMonitor(),
      alertChannel: truncationChannel,
    };
    const step = buildDebateStep(
      gateRefusingLlmClient(),
      new InMemoryDebateLogStore(),
      unlimited(),
      UNCAPPED_SPEND,
      logger,
      undefined,
      failureRateGuard,
      refusalGuard({ gate_refused: 40, debates_logged: 0 }, undefined, sink),
    );

    await step(REFUSED_STEP_INPUT);

    expect(truncationWindowReads).toEqual([]);
    expect(truncationPosted).toEqual([]);
  });

  it('does not crash the tick when the sink itself throws, and logs llm_gate_refusal_record_failed instead', async () => {
    const { logger, entries } = recordingLogger();
    const { sink } = spySink({ throws: true });
    const step = buildDebateStep(
      gateRefusingLlmClient(),
      new InMemoryDebateLogStore(),
      unlimited(),
      UNCAPPED_SPEND,
      logger,
      undefined,
      undefined,
      refusalGuard({ gate_refused: 0, debates_logged: 0 }, undefined, sink),
    );

    const result = await step(REFUSED_STEP_INPUT);

    expect(result.position).toContain('No position');
    const failure = entries.find((entry) => entry.event === 'llm_gate_refusal_record_failed');
    expect(failure).toBeDefined();
    expect(failure?.level).toBe('error');
  });

  it('degrades cleanly with no guard supplied at all, touching no sink', async () => {
    const { logger, entries } = recordingLogger();
    const step = buildDebateStep(
      gateRefusingLlmClient(),
      new InMemoryDebateLogStore(),
      unlimited(),
      UNCAPPED_SPEND,
      logger,
    );

    const result = await step(REFUSED_STEP_INPUT);

    expect(result.position).toContain('No position');
    expect(entries.some((entry) => entry.event === 'llm_gate_refusal_record_failed')).toBe(false);
  });
});
