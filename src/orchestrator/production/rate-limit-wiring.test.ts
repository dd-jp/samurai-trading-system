/**
 * The wiring proof for #388 — `RateLimiter` is IN the production LLM path, not
 * beside it, and the protection no longer depends on `maxConcurrentInstruments`.
 *
 * A separate file from `debate-adapter.test.ts` on purpose. That file tests
 * what a debate does; this one tests what the composition root does with a
 * limiter, which is the thing that was missing for the entire life of the
 * component: `RateLimiter` was implemented, unit-tested and exported, and
 * constructed nowhere in production, while every unit test passed.
 */
import type { AnalystView, LlmClient, LlmRequest } from '../../debate-engine/index.js';
import {
  InMemoryDebateLogStore,
  MAX_ROUNDS,
  RateLimiter,
  type RateLimiterConfig,
  UNCAPPED_SPEND,
} from '../../debate-engine/index.js';
import type { AssetClass, Clock, LogEntry, Logger } from '../../shared/index.js';
import { DEFAULT_VENUE_PACING, SimulatedClock } from '../../shared/index.js';
import { openSharedStore, type SharedStore } from '../../shared/store/index.js';
import { paperStartingProfile } from '../paper-profile.js';
import { buildProductionComponents, type ProductionConfig } from '../production.js';
import { DEFAULT_UNIVERSE } from '../scheduler.js';
import { runTickPlan } from '../tick-loop.js';
import { SequentialTickRunner } from '../tick-runner.js';
import type { AuditLog, CurrentTickStore, TickPlan, TickSteps } from '../types.js';
import {
  buildDebateStep,
  LLM_CALLS_PER_ROUND,
  WORST_CASE_LLM_CALLS_PER_DEBATE,
} from './debate-adapter.js';

const NOW = new Date('2026-08-05T14:00:00Z');
const CLOCK: Clock = { now: () => NOW };

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

/** Counts every call that actually reached an LLM. `converged: false` runs the full round cap. */
function countingLlmClient(options: { converged?: boolean } = {}): LlmClient & { calls: number } {
  const { converged = true } = options;
  const client = {
    calls: 0,
    async complete<T>(request: LlmRequest<T>) {
      client.calls += 1;
      let raw: string;
      if (request.prompt.includes('Bull persona')) {
        raw = JSON.stringify({ stance: 'bullish', rationale: 'strong momentum' });
      } else if (request.prompt.includes('Bear persona')) {
        raw = JSON.stringify({ stance: 'bearish', rationale: 'overbought risk' });
      } else if (request.prompt.includes('Mediator persona')) {
        raw = JSON.stringify({ stance: 'bullish', rationale: 'bull case wins', converged });
      } else {
        raw = JSON.stringify({ summary: 'no material disagreement', conflicts: [] });
      }
      const parsed = request.parseResponse(raw);
      if (!parsed.valid) throw new Error(`fixture rejected: ${parsed.reason}`);
      return { data: parsed.data, raw_text: raw, latency_ms: 1 };
    },
  };
  return client;
}

function budget(overrides: Partial<RateLimiterConfig['default']> = {}): RateLimiterConfig {
  return {
    default: { windowMs: 300_000, maxLlmCalls: 10_000, maxDebates: 10_000, ...overrides },
  };
}

function recordingLogger(): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { logger: { log: (entry) => entries.push(entry) }, entries };
}

describe('the LLM rate limiter is in the production path (#388)', () => {
  let db: SharedStore;

  beforeEach(() => {
    db = openSharedStore(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  /**
   * THE MUTATION THIS KILLS: drop the `RateLimitedLlmClient` wrapper in
   * `buildDebateStep` and hand the raw client to `buildDebatePersonas`. The
   * debate still runs, every other test still passes, and the limiter silently
   * meters nothing — which is precisely the state #388 found the repo in.
   */
  it('meters every LLM call a debate makes, through the instance the root exposes', async () => {
    const llmClient = countingLlmClient();
    const components = buildProductionComponents(stubConfig(db, { llmClient }));

    await components.steps.debate({
      trace_id: 'trace-1',
      instrument: 'BTC-USD',
      asset_class: 'crypto',
      views: [makeView()],
      clock: CLOCK,
    });

    // The limiter reachable from `ProductionComponents` is the one the debate
    // step closed over — not a second instance counting nothing.
    expect(components.llmRateLimiter.snapshot().crypto).toEqual({
      debatesUsed: 1,
      llmCallsUsed: llmClient.calls,
    });
    expect(llmClient.calls).toBeGreaterThan(0);
  });

  it('bills the asset class the tick actually ran, not a fixed one', async () => {
    const components = buildProductionComponents(
      stubConfig(db, { llmClient: countingLlmClient() }),
    );

    await components.steps.debate({
      trace_id: 'trace-1',
      instrument: 'AAPL',
      asset_class: 'stocks',
      views: [makeView()],
      clock: CLOCK,
    });

    const snapshot = components.llmRateLimiter.snapshot();
    expect(snapshot.stocks?.debatesUsed).toBe(1);
    expect(snapshot.crypto).toBeUndefined();
  });

  /**
   * The precondition is ENFORCED at the composition root, not just documented
   * (PR #390 review). `buildDebateStep` calls `reserve` outside its try/catch
   * because `reserve` is total over `AssetClass` — but that only held while the
   * config shape was well formed, and the shape was guaranteed by TypeScript
   * alone. A `rateLimiterConfig` injected with no `default` (reachable by any
   * caller who casts) used to survive construction and throw on the first
   * debate; now the root refuses to build.
   */
  it('refuses to build with a rateLimiterConfig that has no `default`', () => {
    expect(() =>
      buildProductionComponents(
        stubConfig(db, {
          llmClient: countingLlmClient(),
          rateLimiterConfig: {} as unknown as NonNullable<ProductionConfig['rateLimiterConfig']>,
        }),
      ),
    ).toThrow(/config\.default is required/);
  });

  it('refuses before opening any store or wire client, not part-way through wiring', () => {
    // Placement matters as much as the check: a throw from the middle of
    // `buildProductionComponents` would leave a half-built root behind. The
    // limiter is constructed first, so nothing downstream has run yet — proven
    // by the broker wire client never being touched.
    const config = stubConfig(db, {
      llmClient: countingLlmClient(),
      rateLimiterConfig: {} as unknown as NonNullable<ProductionConfig['rateLimiterConfig']>,
    });

    expect(() => buildProductionComponents(config)).toThrow();
    // `submitOrder`, not `listOrders`: the latter is not on `AlpacaClient` at
    // all, so the old assertion read an `undefined` off the stub and asserted
    // that it had not been called — vacuously true whatever the wiring did.
    expect(config.alpacaBrokerClient.submitOrder).not.toHaveBeenCalled();
  });

  it('still constructs a finite budget when no rateLimiterConfig is supplied', async () => {
    // The fallback is a ceiling, not an absence: a programmatic caller that
    // forgets the config must not get today's `undefined` back.
    const components = buildProductionComponents(
      stubConfig(db, { llmClient: countingLlmClient() }),
    );

    await components.steps.debate({
      trace_id: 'trace-1',
      instrument: 'BTC-USD',
      asset_class: 'crypto',
      views: [makeView()],
      clock: CLOCK,
    });

    expect(components.llmRateLimiter.snapshot().crypto?.llmCallsUsed).toBeGreaterThan(0);
  });
});

describe('raising maxConcurrentInstruments no longer removes the only throttle (#388)', () => {
  /**
   * THE REGRESSION THIS PINS. Before #388 the entire rate-limit posture was
   * `maxConcurrentInstruments: 1` — an incidental property of a concurrency
   * default. Setting it to 6, the obvious move when tick cadence becomes the
   * bottleneck across the six-instrument universe, left NOTHING throttling LLM
   * spend. The limiter must hold the line at the same cap regardless of what
   * this dial is set to.
   */
  it.each([1, 6])('caps debates at the budget with max_concurrent_instruments=%i', async (cap) => {
    const llmClient = countingLlmClient();
    const rateLimiter = new RateLimiter(CLOCK, budget({ maxDebates: 2 }));
    const { runner } = tickRunnerOver(llmClient, rateLimiter);

    const outcomes = await runTickPlan(sixInstrumentPlan(), runner, CLOCK, {
      max_concurrent_instruments: cap,
      logger: recordingLogger().logger,
      auditLog: noopAuditLog(),
      currentTickStore: noopCurrentTickStore(),
    });

    // Exactly two of the six debates were admitted, whichever order the
    // workers claimed them in. `reserve` books the debate synchronously, so
    // six concurrent workers cannot all pass the same check.
    expect(rateLimiter.snapshot().crypto?.debatesUsed).toBe(2);
    expect(outcomes).toHaveLength(6);
    // And the four refusals cost NOTHING at the provider.
    expect(llmClient.calls).toBe(2 * (LLM_CALLS_PER_ROUND + 1));
  });

  /**
   * THE MUTATION THIS KILLS, and it also survived the first round: hard-code
   * `asset_class: 'crypto'` in `tick-runner.ts` instead of threading
   * `signal.asset_class`. Every stage still ran and every test still passed,
   * while every stock debate was billed against the CRYPTO budget — so the two
   * per-class ceilings would have been one ceiling wearing two names, and
   * `LATENCY_BUDGET_MS` (crypto 15s vs stocks 60s) would inherit the same bug
   * the moment #374 wires it.
   *
   * The per-class assertion above exercises `steps.debate` directly, which
   * cannot see this: the runner is the layer that chooses what to pass.
   */
  it('bills each instrument against ITS OWN class through the real runner', async () => {
    const rateLimiter = new RateLimiter(CLOCK, budget());
    const { runner } = tickRunnerOver(countingLlmClient(), rateLimiter);

    await runTickPlan(
      {
        tick_time: NOW,
        instruments: [
          { asset: 'BTC-USD', asset_class: 'crypto' },
          { asset: 'AAPL', asset_class: 'stocks' },
        ],
      },
      runner,
      CLOCK,
      {
        max_concurrent_instruments: 1,
        logger: recordingLogger().logger,
        auditLog: noopAuditLog(),
        currentTickStore: noopCurrentTickStore(),
      },
    );

    const snapshot = rateLimiter.snapshot();
    expect(snapshot.crypto?.debatesUsed).toBe(1);
    expect(snapshot.stocks?.debatesUsed).toBe(1);
  });

  it('degrades the refused instruments instead of failing the whole tick', async () => {
    // A throw would propagate through `runTickPlan`'s `Promise.all` to
    // `startTickLoop`'s catch, discarding every OTHER instrument's pass too —
    // one instrument's exhausted budget must not be a tick-wide outage.
    const rateLimiter = new RateLimiter(CLOCK, budget({ maxDebates: 2 }));
    const { runner, results } = tickRunnerOver(countingLlmClient(), rateLimiter);

    await expect(
      runTickPlan(sixInstrumentPlan(), runner, CLOCK, {
        max_concurrent_instruments: 6,
        logger: recordingLogger().logger,
        auditLog: noopAuditLog(),
        currentTickStore: noopCurrentTickStore(),
      }),
    ).resolves.toHaveLength(6);

    const refused = results.filter((result) => result.rate_limited !== undefined);
    expect(refused).toHaveLength(4);
    for (const result of refused) {
      // Below any sane `conviction_floor` (0.55 in DEFAULT_TRADER_CONFIG), so
      // Trader short-circuits to no_trade — the fail-safe direction.
      expect(result.confidence).toBe(0);
      expect(result.direction).toBe('neutral');
      expect(result.rounds_completed).toBe(0);
    }
  });
});

describe('what a refused debate does', () => {
  it('makes no LLM call, writes no debate_log row, and says why', async () => {
    const llmClient = countingLlmClient();
    const store = new InMemoryDebateLogStore();
    const { logger, entries } = recordingLogger();
    const rateLimiter = new RateLimiter(CLOCK, budget({ maxDebates: 0 }));
    const step = buildDebateStep(llmClient, store, rateLimiter, UNCAPPED_SPEND, logger);

    const result = await step({
      trace_id: 'trace-1',
      instrument: 'BTC-USD',
      asset_class: 'crypto',
      views: [makeView()],
      clock: CLOCK,
    });

    expect(llmClient.calls).toBe(0);
    expect(result.rate_limited?.reason).toMatch(/debate budget exhausted/);
    // No row: `debate_id` is a content hash and the PK, so a stub would
    // permanently block the real row a later re-run would write.
    expect(store.getByDebateId(result.debate_id)).toBeUndefined();

    const warned = entries.find((entry) => entry.stage === 'debate' && entry.level === 'warn');
    expect(warned?.message).toContain('not started');
  });

  it('refuses on the CALL budget too, before a debate can be cut off mid-round', async () => {
    // The point of reserving the worst case up front: a debate admitted with
    // only half its calls affordable would burn those calls and still produce
    // nothing.
    const llmClient = countingLlmClient();
    const rateLimiter = new RateLimiter(
      CLOCK,
      budget({ maxDebates: 10, maxLlmCalls: WORST_CASE_LLM_CALLS_PER_DEBATE - 1 }),
    );
    const step = buildDebateStep(
      llmClient,
      new InMemoryDebateLogStore(),
      rateLimiter,
      UNCAPPED_SPEND,
    );

    const result = await step({
      trace_id: 'trace-1',
      instrument: 'BTC-USD',
      asset_class: 'crypto',
      views: [makeView()],
      clock: CLOCK,
    });

    expect(llmClient.calls).toBe(0);
    expect(result.rate_limited?.reason).toMatch(/LLM call budget insufficient/);
  });
});

describe('the reserved worst case matches what a debate can actually spend', () => {
  it('is derived from MAX_ROUNDS rather than hard-coded', () => {
    expect(WORST_CASE_LLM_CALLS_PER_DEBATE).toBe(MAX_ROUNDS * LLM_CALLS_PER_ROUND + 1);
  });

  it('is not exceeded by a debate that runs to the hard round cap', async () => {
    // The assertion that makes the constant more than arithmetic: run the real
    // personas to the cap and count. Under-reserving would let a debate blow
    // the budget it was admitted under.
    const llmClient = countingLlmClient({ converged: false });
    const rateLimiter = new RateLimiter(CLOCK, budget());
    const step = buildDebateStep(
      llmClient,
      new InMemoryDebateLogStore(),
      rateLimiter,
      UNCAPPED_SPEND,
    );

    const result = await step({
      trace_id: 'trace-1',
      instrument: 'BTC-USD',
      asset_class: 'crypto',
      views: [makeView(), makeView({ analyst_id: 'sentiment-1', direction: 'bearish' })],
      clock: CLOCK,
    });

    expect(result.rounds_completed).toBe(MAX_ROUNDS);
    expect(llmClient.calls).toBeLessThanOrEqual(WORST_CASE_LLM_CALLS_PER_DEBATE);
    expect(rateLimiter.snapshot().crypto?.llmCallsUsed).toBe(llmClient.calls);
  });
});

describe('the composition root paces the broker from ops config (#299)', () => {
  let db: SharedStore;

  beforeEach(() => {
    db = openSharedStore(':memory:');
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  /**
   * THE MUTATION THIS KILLS, and it survived the first round of this suite:
   * put a `new TokenBucket({capacity: 10, refillPerSecond: 1.5})` literal back
   * in `production.ts` and ignore the resolved config. Every test still
   * passed, so `SAMURAI_PACING_ALPACA_*` would have been a knob the operator
   * could set and the process would silently ignore — #299's own defect class
   * (a rate limit that is a property of the code rather than of the account),
   * reintroduced by the fix meant to close it.
   *
   * Observed through the bucket's BEHAVIOUR rather than by reading a field,
   * because the field is private and asserting on a copy of the config would
   * survive exactly this mutation.
   */
  it('honours an injected venue pacing rather than a compiled-in default', async () => {
    const components = buildProductionComponents(
      stubConfig(db, {
        llmClient: countingLlmClient(),
        // Capacity 1, and a refill so slow the second call cannot be minted
        // inside the window this test advances. The default capacity is 10, so
        // a root ignoring this config would let both calls straight through.
        venuePacing: {
          alpaca: { capacity: 1, refillPerSecond: 0.001 },
          ccxt: { capacity: 1, refillPerSecond: 1 },
          ibkr: { capacity: 5, refillPerSecond: 5 },
        },
      }),
    );

    const first = components.broker.submitBracket(bracketRequest('key-1'));
    const second = components.broker.submitBracket(bracketRequest('key-2'));
    let secondSettled = false;
    void second.then(() => {
      secondSettled = true;
    });

    await first;
    await vi.advanceTimersByTimeAsync(200);

    // The single token went to the first call; the second is parked behind a
    // refill this deployment's config made ~1000s long.
    expect(secondSettled).toBe(false);

    // Drained so the pending promise does not outlive the test.
    await vi.advanceTimersByTimeAsync(1_000_000);
    await second;
  });
});

/**
 * #299's burst value has no published Alpaca figure behind it (see
 * `DEFAULT_VENUE_PACING.alpaca`), so it is derived from OUR workload instead —
 * and a derivation stated only in a comment is the drift shape this repo keeps
 * hitting. This makes it structural: widen the universe again and this fails
 * rather than silently under-sizing the burst.
 */
describe("Alpaca's burst covers one fill-poll sweep of the configured universe (#299)", () => {
  it('has capacity for a getOrder per open bracket plus a concurrent submit', () => {
    // `AlpacaBrokerAdapter.fetchNewFills` issues exactly one `getOrder` per
    // open bracket, each through the token bucket; worst case is one bracket
    // per instrument, with a `submitBracket` from the tick path alongside.
    const worstCaseSweep = DEFAULT_UNIVERSE.length + 1;

    expect(DEFAULT_VENUE_PACING.alpaca.capacity).toBeGreaterThanOrEqual(worstCaseSweep);
  });

  it('keeps the sustained rate under the documented account ceiling', () => {
    // The axis that actually carries ban risk, and the one with a verified
    // figure behind it (200/min = 3.33/s).
    expect(DEFAULT_VENUE_PACING.alpaca.refillPerSecond).toBeLessThanOrEqual(200 / 60);
  });

  /**
   * #391 put the market-data client inside the same bucket, so the burst is no
   * longer sized by the fill sweep alone — the worst moment is a COLD START,
   * where `TokenBucket` begins full, the bar cache is empty and every
   * instrument fetches at once while `reconcile()` sweeps.
   */
  it('has capacity for a cold-start bar sweep alongside the order path', () => {
    const coldStart =
      DEFAULT_UNIVERSE.length + // one bars fetch per instrument, cache empty
      DEFAULT_UNIVERSE.length + // reconcile: one getOrder per open bracket
      1; // a submitBracket from the first tick

    expect(DEFAULT_VENUE_PACING.alpaca.capacity).toBeGreaterThanOrEqual(coldStart);
  });

  it('reserves enough for the order path to complete a full sweep under a data burst', () => {
    // The reserve is what market data may NOT spend, so it has to cover one
    // fill-poll sweep of the universe — otherwise a bar burst can still park a
    // getOrder behind the refill, which is the starvation #391 forbids.
    const reserve = DEFAULT_VENUE_PACING.alpaca.reserveForPriority ?? 0;

    expect(reserve).toBeGreaterThanOrEqual(DEFAULT_UNIVERSE.length);
    // And it must leave something for market data, or bar fetches park forever.
    expect(reserve).toBeLessThan(DEFAULT_VENUE_PACING.alpaca.capacity);
  });
});

describe('paperStartingProfile supplies the budget (#388)', () => {
  it('carries a per-asset-class budget with the call budget tied to the worst case', () => {
    const { rateLimiterConfig } = paperStartingProfile('paper');

    for (const assetClass of ['crypto', 'stocks'] as const) {
      const entry = rateLimiterConfig.perAssetClass?.[assetClass];
      expect(entry).toBeDefined();
      expect(entry?.maxDebates).toBeGreaterThan(0);
      // Any lower and the CALL budget binds first, refusing debates while
      // `ReserveResult.reason` names the wrong one.
      expect(entry?.maxLlmCalls).toBe((entry?.maxDebates ?? 0) * WORST_CASE_LLM_CALLS_PER_DEBATE);
    }
  });

  /**
   * The headroom that makes #388's fix survive the change that motivated it:
   * raising `maxConcurrentInstruments` to 6 collapses a stock pass from ~270s
   * to ~60s, roughly doubling the stock debate rate to ~1.6/min. The budget
   * must still clear that, or the fix trades an unthrottled system for one
   * that refuses legitimate debates.
   */
  it('leaves headroom over the measured cadence rather than sitting on it', () => {
    const { rateLimiterConfig } = paperStartingProfile('paper');
    const perMinute = (entry: { windowMs: number; maxDebates: number } | undefined) =>
      ((entry?.maxDebates ?? 0) / (entry?.windowMs ?? 1)) * 60_000;

    // #385 measured ~1.33 crypto debates/min at peak and ~0.73 stock/min.
    expect(perMinute(rateLimiterConfig.perAssetClass?.crypto)).toBeGreaterThan(1.33 * 2);
    expect(perMinute(rateLimiterConfig.perAssetClass?.stocks)).toBeGreaterThan(1.6 * 1.5);
  });

  /**
   * `default` governs any `AssetClass` with no `perAssetClass` entry, and the
   * rule is that an unrecognised class is the MOST constrained thing in the
   * system. Derived with `Math.min` in the profile, pinned here — a
   * hand-written `default` would silently invert this the first time someone
   * tuned one class's budget upward (PR #390 review).
   */
  it('keeps `default` at or below every per-class budget', () => {
    const { rateLimiterConfig } = paperStartingProfile('paper');
    const perClass = Object.values(rateLimiterConfig.perAssetClass ?? {});

    expect(perClass.length).toBeGreaterThan(0);
    for (const entry of perClass) {
      expect(rateLimiterConfig.default.maxDebates).toBeLessThanOrEqual(entry.maxDebates);
      expect(rateLimiterConfig.default.maxLlmCalls).toBeLessThanOrEqual(entry.maxLlmCalls);
    }
  });

  it('still refuses to be a live profile', () => {
    expect(() => paperStartingProfile('live')).toThrow(/SAMURAI_MODE=live/);
  });
});

/**
 * The wiring proof for the LLM spend cap (ADR-0008), written in the same shape
 * and the same file as #388's, because it is the same failure class: a control
 * that is implemented, unit-tested and constructed nowhere real.
 *
 * The mutation each of these kills is stated at the test.
 */
describe('the LLM spend cap is in the production path (ADR-0008)', () => {
  let db: SharedStore;

  beforeEach(() => {
    db = openSharedStore(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  /** One priced call in the table the cap reads and the sink writes. */
  function spend(costUsd: number, id: string): void {
    db.prepare(
      `INSERT INTO llm_spend (
         trace_id, stage, debate_id, model,
         input_tokens, output_tokens,
         cache_creation_input_tokens, cache_read_input_tokens,
         cost_usd, latency_ms, timestamp
       ) VALUES (?, 'debate', ?, 'claude-haiku-4-5-20251001', 100, 100, 0, 0, ?, 10, ?)`,
    ).run(`trace-${id}`, `debate-${id}`, costUsd, NOW.toISOString());
  }

  /**
   * THE MUTATION THIS KILLS: drop `spendCap` from `buildProductionComponents`
   * and pass `UNCAPPED_SPEND` at the `buildDebateStep` call. Every unit test in
   * `spend-cap.test.ts` still passes — the cap is correct, and it is not
   * connected to anything. That is exactly how #327, #364, #366, #371, #374,
   * #379 and #388 all shipped.
   */
  it('refuses a debate through the composition root once the budget is spent', async () => {
    spend(60, 'over-budget');
    const llmClient = countingLlmClient();
    const components = buildProductionComponents(stubConfig(db, { llmClient, llmBudgetUsd: 50 }));

    const result = await components.steps.debate({
      trace_id: 'trace-1',
      instrument: 'BTC-USD',
      asset_class: 'crypto',
      views: [makeView()],
      clock: CLOCK,
    });

    // Not merely "returned a refusal" — NO MONEY WAS SPENT. A cap that
    // refuses after billing the debate is not a cap.
    expect(llmClient.calls).toBe(0);
    expect(result.rate_limited?.reason).toContain('LLM spend cap reached');
    expect(result.rounds_completed).toBe(0);
  });

  it('does not book rate-limit budget for a debate the cap refuses', async () => {
    // Ordering, not decoration: `reserve` MUTATES the limiter's counters, so
    // checking the budget after booking would burn window allowance on a
    // debate that was never going to run.
    spend(60, 'over-budget');
    const components = buildProductionComponents(
      stubConfig(db, { llmClient: countingLlmClient(), llmBudgetUsd: 50 }),
    );

    await components.steps.debate({
      trace_id: 'trace-1',
      instrument: 'BTC-USD',
      asset_class: 'crypto',
      views: [makeView()],
      clock: CLOCK,
    });

    expect(components.llmRateLimiter.snapshot().crypto).toBeUndefined();
  });

  it('admits normally while under budget, so the cap is not a blanket refusal', async () => {
    spend(1, 'under-budget');
    const llmClient = countingLlmClient();
    const components = buildProductionComponents(stubConfig(db, { llmClient, llmBudgetUsd: 50 }));

    const result = await components.steps.debate({
      trace_id: 'trace-1',
      instrument: 'BTC-USD',
      asset_class: 'crypto',
      views: [makeView()],
      clock: CLOCK,
    });

    expect(llmClient.calls).toBeGreaterThan(0);
    expect(result.rate_limited).toBeUndefined();
  });

  it('warns loudly, at startup, when no budget is configured', () => {
    // `llmBudgetUsd` is optional so the many programmatic callers need not
    // care — but silence would make an uncapped unattended run
    // indistinguishable from a capped one in the log. Same posture as
    // SAMURAI_ALERTS: no safe default, say what was chosen.
    const { logger, entries } = recordingLogger();

    buildProductionComponents(stubConfig(db, { llmClient: countingLlmClient(), logger }));

    const warning = entries.find((entry) => entry.message.includes('llmBudgetUsd is not set'));
    expect(warning?.level).toBe('warn');
    expect(warning?.message).toContain('UNCAPPED');
  });

  it('is what the checked-in paper profile actually carries', () => {
    // The value the soak runs on, pinned where the arithmetic behind it lives.
    // $50 over 14 days is David's figure (2026-08-06); 15 min is what that
    // budget reduces to on a single base tick interval.
    const profile = paperStartingProfile('paper');

    expect(profile.llmBudgetUsd).toBe(50);
    expect(profile.tickIntervalMs).toBe(15 * 60_000);
  });
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function bracketRequest(client_order_id: string) {
  return {
    client_order_id,
    instrument: 'BTC-USD',
    asset_class: 'crypto' as const,
    side: 'buy' as const,
    size: 1,
    entry: 100,
    stop: 95,
    target: 110,
    time_in_force: 'gtc',
  };
}

function sixInstrumentPlan(): TickPlan {
  return {
    tick_time: NOW,
    instruments: ['BTC-USD', 'ETH-USD', 'SOL-USD', 'ADA-USD', 'DOT-USD', 'XRP-USD'].map(
      (asset): { asset: string; asset_class: AssetClass } => ({ asset, asset_class: 'crypto' }),
    ),
  };
}

/**
 * A tick runner whose debate stage is the REAL `buildDebateStep` and whose
 * other five stages stop the pass immediately after it — the debate is the
 * only stage under test, and Trader returning `null` is the shape a refused
 * debate produces in production anyway.
 */
function tickRunnerOver(llmClient: LlmClient, rateLimiter: RateLimiter) {
  const results: Awaited<ReturnType<TickSteps['debate']>>[] = [];
  const debate = buildDebateStep(
    llmClient,
    new InMemoryDebateLogStore(),
    rateLimiter,
    UNCAPPED_SPEND,
  );
  const steps: TickSteps = {
    // TWO views, so the converging round also issues its `detectDisagreements`
    // call — one view takes the directional fallback and never reaches the LLM,
    // which would understate what a real debate costs.
    analysts: async () => [
      makeView(),
      makeView({ analyst_id: 'sentiment-1', direction: 'bearish' }),
    ],
    debate: async (input) => {
      const result = await debate(input);
      results.push(result);
      return result;
    },
    trader: async () => null,
    risk: async () => {
      throw new Error('unreachable: trader always returns null in this harness');
    },
    verdict: async () => {
      throw new Error('unreachable');
    },
    execution: async () => {
      throw new Error('unreachable');
    },
  };
  return { runner: new SequentialTickRunner(steps), results };
}

function noopAuditLog(): AuditLog {
  return { record: vi.fn() };
}

function noopCurrentTickStore(): CurrentTickStore {
  return {
    upsert: vi.fn(),
    delete: vi.fn(),
    get: vi.fn(),
    list: vi.fn(() => []),
  } as unknown as CurrentTickStore;
}

/**
 * The narrowest `ProductionConfig` that reaches a bound `steps.debate`. Every
 * transport is a stub; nothing here opens a socket or spends a token.
 */
/** As `production.test.ts`: the seams this stub always supplies, narrowed so
 *  assertions can read them without a non-null assertion at every call site. */
type StubConfig = ProductionConfig & Required<Pick<ProductionConfig, 'alpacaBrokerClient'>>;

function stubConfig(db: SharedStore, overrides: Partial<ProductionConfig>): StubConfig {
  return {
    db,
    clock: new SimulatedClock(NOW),
    mode: 'paper',
    logger: recordingLogger().logger,
    alpacaBrokerClient: {
      submitOrder: vi.fn(async () => ({
        id: 'alpaca-order-1',
        client_order_id: 'k',
        status: 'accepted',
        legs: [],
      })),
      cancelOrder: vi.fn(async () => undefined),
      getOrder: vi.fn(async () => ({
        id: 'alpaca-order-1',
        client_order_id: 'k',
        status: 'accepted',
        legs: [],
      })),
      listOrders: vi.fn(async () => []),
      listFills: vi.fn(async () => []),
    } as unknown as ProductionConfig['alpacaBrokerClient'],
    alpacaDataClient: {
      getBars: vi.fn(async () => []),
      getLatestQuote: vi.fn(async () => ({ t: NOW.toISOString(), ap: 100, bp: 99 })),
    } as unknown as ProductionConfig['alpacaDataClient'],
    accountState: {
      getAccountState: vi.fn(async () => ({
        cash: 100_000,
        peak_equity: 100_000,
        daily_basis: {
          crypto: { known: true, open_equity: 100_000, realized_pnl: 0 },
          stocks: { known: true, open_equity: 100_000, realized_pnl: 0 },
          portfolio: { known: true, open_equity: 100_000, realized_pnl: 0 },
        },
        consecutive_losses: 0,
      })),
    } as unknown as ProductionConfig['accountState'],
    traderConfig: {} as ProductionConfig['traderConfig'],
    riskConfig: {} as ProductionConfig['riskConfig'],
    // Carries the automation dial, which `buildProductionComponents` reads to
    // refuse a HITL-engaging config (#434). `auto` is ADR-0007's setting.
    verdictConfig: {
      automation_level: { crypto: 'auto', stocks: 'auto' },
    } as ProductionConfig['verdictConfig'],
    executionConfig: {} as ProductionConfig['executionConfig'],
    correlationConfig: {} as ProductionConfig['correlationConfig'],
    breakerConfig: {} as ProductionConfig['breakerConfig'],
    costConfig: {} as ProductionConfig['costConfig'],
    ciiConsumerConfig: {} as ProductionConfig['ciiConsumerConfig'],
    ...overrides,
  } as StubConfig;
}
