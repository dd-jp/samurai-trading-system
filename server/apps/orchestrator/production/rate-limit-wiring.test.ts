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

import { DEFAULT_ANALYST_TIMEOUT_MS } from '../../../pipeline/analysts/index.js';
import type { AnalystView, LlmClient, LlmRequest } from '../../../pipeline/debate-engine/index.js';
import {
  InMemoryDebateLogStore,
  LLM_CALLS_PER_ROUND,
  MAX_ROUNDS,
  MAX_ROUNDS_BY_ASSET_CLASS,
  RateLimiter,
  type RateLimiterConfig,
  UNCAPPED_SPEND,
} from '../../../pipeline/debate-engine/index.js';
import { DEFAULT_TRADER_CONFIG } from '../../../pipeline/trader/index.js';
import type { Bar } from '../../../providers/market-data-service/index.js';
import { FixtureDataSource } from '../../../providers/market-data-service/index.js';
import type { AssetClass, Clock, LogEntry, Logger } from '../../../shared/index.js';
import {
  DEFAULT_VENUE_PACING,
  SimulatedClock,
  TOKEN_BUCKET_WAIT_LOG_THRESHOLD_MS,
} from '../../../shared/index.js';
import {
  openSharedStore,
  SqliteLlmSpendCapStore,
  type StoreHandle,
} from '../../../shared/store/index.js';
import { DebateBarDecisionGate } from '../decision-bar-gate.js';
import { paperStartingProfile } from '../paper-profile.js';
import { buildProductionComponents, type ProductionConfig } from '../production.js';
import { DEFAULT_UNIVERSE } from '../scheduler.js';
import { runTickPlan } from '../tick-loop.js';
import { SequentialTickRunner } from '../tick-runner.js';
import type { AuditLog, CurrentTickStore, TickPlan, TickSteps } from '../types.js';
import {
  buildDebateStep,
  WORST_CASE_LLM_CALLS_PER_DEBATE,
  worstCaseLlmCallsForAssetClass,
} from './debate-adapter.js';
import {
  makeWiringCiiConsumerConfig,
  makeWiringCorrelationConfig,
  makeWiringCostConfig,
  makeWiringExecutionConfig,
  makeWiringRiskConfig,
  makeWiringVerdictConfig,
} from './wiring-config-fixtures.js';

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
  let db: StoreHandle;

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
      bar: NOW,
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
      bar: NOW,
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
   * alone. A malformed `rateLimiterConfig` used to survive construction and
   * throw on the first debate; now the root refuses to build. `windowMs: 0` is
   * the type-legal malformed shape (`assertBudget` requires it positive); the
   * missing-`default` shape is unit-pinned in rate-limiter.test.ts.
   */
  it('refuses to build with a malformed rateLimiterConfig', () => {
    expect(() =>
      buildProductionComponents(
        stubConfig(db, {
          llmClient: countingLlmClient(),
          rateLimiterConfig: budget({ windowMs: 0 }),
        }),
      ),
    ).toThrow(/default\.windowMs must be a finite positive number/);
  });

  it('refuses before opening any store or wire client, not part-way through wiring', () => {
    // Placement matters as much as the check: a throw from the middle of
    // `buildProductionComponents` would leave a half-built root behind. The
    // limiter is constructed first, so nothing downstream has run yet — proven
    // by the broker wire client never being touched.
    const config = stubConfig(db, {
      llmClient: countingLlmClient(),
      rateLimiterConfig: budget({ windowMs: 0 }),
    });

    expect(() => buildProductionComponents(config)).toThrow();
    // `submitOrder`, not `listOrders`: the latter is not on `AlpacaBrokerClient` at
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
      bar: NOW,
    });

    expect(components.llmRateLimiter.snapshot().crypto?.llmCallsUsed).toBeGreaterThan(0);
  });

  /**
   * THE MUTATION THIS KILLS: `config.llmRateLimiter ?? new RateLimiter(clock,
   * DEFAULT_LLM_RATE_LIMIT_CONFIG)` — dropping the `config.rateLimiterConfig
   * ??` half. `DEFAULT_LLM_RATE_LIMIT_CONFIG.default.maxDebates` is 30, so a
   * root that silently discarded an injected `rateLimiterConfig` would still
   * admit both debates here; only a tight, actually-read budget can refuse
   * the second one. The two `default`-omission tests above cover the guard
   * that rejects a malformed config — this covers that a WELL-FORMED one is
   * the value the limiter is actually built from.
   */
  it('builds the limiter from the injected rateLimiterConfig, not the compiled-in default', async () => {
    const components = buildProductionComponents(
      stubConfig(db, {
        llmClient: countingLlmClient(),
        rateLimiterConfig: budget({ maxDebates: 1 }),
      }),
    );

    const debate = (instrument: string) =>
      components.steps.debate({
        trace_id: 'trace-1',
        instrument,
        asset_class: 'crypto',
        views: [makeView()],
        clock: CLOCK,
        bar: NOW,
      });

    const first = await debate('BTC-USD');
    const second = await debate('ETH-USD');

    expect(first.rate_limited).toBeUndefined();
    expect(second.rate_limited?.reason).toMatch(/debate budget exhausted/);
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
      decisionGate: new DebateBarDecisionGate(),
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
        decisionGate: new DebateBarDecisionGate(),
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
        decisionGate: new DebateBarDecisionGate(),
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
      bar: NOW,
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
      // One call short of CRYPTO's worst case (#581): the reservation is
      // per-asset-class now, so the global constant minus one would admit a
      // 1-round crypto debate instead of refusing it.
      budget({ maxDebates: 10, maxLlmCalls: worstCaseLlmCallsForAssetClass('crypto') - 1 }),
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
      bar: NOW,
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
    // the budget it was admitted under. Stocks, which #1080 capped at one round
    // alongside crypto — the crypto counterpart is the test below, and this one
    // now asserts the PER-CLASS cap rather than `MAX_ROUNDS`, which remains the
    // structural ceiling `runDebate` validates against.
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
      instrument: 'SPY',
      asset_class: 'stocks',
      views: [makeView(), makeView({ analyst_id: 'sentiment-1', direction: 'bearish' })],
      clock: CLOCK,
      bar: NOW,
    });

    expect(result.rounds_completed).toBe(MAX_ROUNDS_BY_ASSET_CLASS.stocks);
    expect(llmClient.calls).toBeLessThanOrEqual(worstCaseLlmCallsForAssetClass('stocks'));
    expect(llmClient.calls).toBeLessThanOrEqual(WORST_CASE_LLM_CALLS_PER_DEBATE);
    expect(rateLimiter.snapshot().stocks?.llmCallsUsed).toBe(llmClient.calls);
  });

  it('caps a crypto debate at one round and still runs disagreement detection (#581)', async () => {
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
      bar: NOW,
    });

    // One round (bull, bear, mediator) + the once-per-debate disagreement
    // call: round 1 IS the final round under the crypto cap, so the mediator
    // must gate `detectDisagreements` on the per-class cap, not `MAX_ROUNDS`.
    expect(result.rounds_completed).toBe(1);
    expect(result.converged).toBe(false);
    expect(llmClient.calls).toBe(4);
    expect(llmClient.calls).toBeLessThanOrEqual(worstCaseLlmCallsForAssetClass('crypto'));
    expect(rateLimiter.snapshot().crypto?.llmCallsUsed).toBe(llmClient.calls);
  });

  it('reserves the per-asset-class worst case, not the global one (#581)', () => {
    expect(worstCaseLlmCallsForAssetClass('crypto')).toBe(
      MAX_ROUNDS_BY_ASSET_CLASS.crypto * LLM_CALLS_PER_ROUND + 1,
    );
    expect(worstCaseLlmCallsForAssetClass('stocks')).toBe(
      MAX_ROUNDS_BY_ASSET_CLASS.stocks * LLM_CALLS_PER_ROUND + 1,
    );
    // #1080 capped stocks at one round, so the per-class reservation is now
    // strictly below the `MAX_ROUNDS`-sized ceiling the profile sizes against.
    // That gap is the point of having both: a ceiling for sizing, a per-class
    // figure for admission.
    expect(worstCaseLlmCallsForAssetClass('stocks')).toBeLessThan(WORST_CASE_LLM_CALLS_PER_DEBATE);
  });
});

describe('the composition root paces the broker from ops config (#299)', () => {
  let db: StoreHandle;

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
          saxo: { capacity: 2, refillPerSecond: 1 },
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
 * #1083's wiring proof: the shared `alpacaBucket` `production.ts` builds is
 * constructed WITH telemetry, not just constructed. Exercised through the
 * real composition root and the real broker — the same shape of gap #388's
 * own file-header describes (a mechanism that is implemented, unit-tested and
 * exported, but never actually wired at the root).
 */
describe('the composition root wires wait telemetry onto the shared Alpaca bucket (#1083)', () => {
  let db: StoreHandle;

  beforeEach(() => {
    db = openSharedStore(':memory:');
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  /**
   * THE MUTATION THIS KILLS: drop `{ logger, name: 'alpaca' }` from the
   * `new TokenBucket(...)` call in `production.ts` and go back to
   * `new TokenBucket(venuePacing.alpaca)`. Every test above this one still
   * passes — the bucket still paces identically — so only an assertion on the
   * LOG LINE itself, not on pacing behaviour, can catch it.
   */
  it('logs a wait on the real broker path once the shared bucket parks a caller', async () => {
    const { logger, entries } = recordingLogger();
    const components = buildProductionComponents(
      stubConfig(db, {
        llmClient: countingLlmClient(),
        logger,
        // Same shape as the pacing test above: one token, and a refill slow
        // enough that the second call is still parked well past the
        // threshold when this test checks it.
        venuePacing: {
          alpaca: { capacity: 1, refillPerSecond: 0.001 },
          ccxt: { capacity: 1, refillPerSecond: 1 },
          ibkr: { capacity: 5, refillPerSecond: 5 },
          saxo: { capacity: 2, refillPerSecond: 1 },
        },
      }),
    );

    await components.broker.submitBracket(bracketRequest('key-1'));
    const second = components.broker.submitBracket(bracketRequest('key-2'));

    // This test's job is the `{ logger, name }` argument reaching the shared
    // bucket, not pinning the threshold value itself — that belongs to
    // `token-bucket.test.ts`'s "wait under the threshold" case, which is the
    // one actually discriminating on the constant. So drain in one step
    // rather than stopping at the threshold first; this config's refill
    // takes ~1000s, three orders of magnitude past the threshold, which
    // would pass here even if the constant were 1 or 100.
    await vi.advanceTimersByTimeAsync(1_000_000);
    await second;

    const waits = entries.filter((entry) => entry.event === 'token_bucket_wait');
    expect(waits).toHaveLength(1);
    const [wait] = waits;
    if (wait === undefined) throw new Error('unreachable — length asserted above');
    expect(wait.payload).toMatchObject({ bucket: 'alpaca', lane: 'priority' });
    expect((wait.payload as { wait_ms: number }).wait_ms).toBeGreaterThanOrEqual(
      TOKEN_BUCKET_WAIT_LOG_THRESHOLD_MS,
    );
  });
});

/**
 * #1082's wiring proof: the PRIMARY `marketData` instance `production.ts`
 * builds is constructed WITH telemetry, not just constructed — the same
 * shape of gap #388's file header and #1083's block above both cover. A
 * cold-store bar fetch is a GUARANTEED miss (unlike #1083's wait, which needs
 * a real threshold-crossing delay), so this is a real, non-vacuous
 * assertion rather than a documented exclusion.
 */
describe('the composition root wires market-data fetch telemetry (#1082)', () => {
  let db: StoreHandle;

  beforeEach(() => {
    db = openSharedStore(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  function bar(closeTime: string, close: number): Bar {
    const closeDate = new Date(closeTime);
    return {
      instrument: 'AAPL',
      timeframe: '1h',
      open_time: new Date(closeDate.getTime() - 60 * 60 * 1000),
      close_time: closeDate,
      open: close,
      high: close,
      low: close,
      close,
      volume: 100,
      source: 'fixture',
    };
  }

  /**
   * THE MUTATION THIS KILLS: drop the `5_000, { logger }` arguments from the
   * primary `new MarketDataServiceImpl(...)` call in `production.ts` (back
   * to the pre-#1082 4-arg call). Every OTHER test in this file and in
   * `production.test.ts` still passes — the bars served are identical —
   * because telemetry is observation-only; only an assertion on the LOG LINE
   * itself, not on served data, can catch it.
   */
  it('logs a market_data_fetch line on a cold-store bar fetch reached through the real composition root', async () => {
    const { logger, entries } = recordingLogger();
    const dataSource = new FixtureDataSource(
      [bar('2026-08-05T12:00:00Z', 100), bar('2026-08-05T13:00:00Z', 101)],
      { price: 101, observed_at: NOW, source: 'fixture-live' },
      'stocks',
    );
    const components = buildProductionComponents(
      stubConfig(db, {
        llmClient: countingLlmClient(),
        logger,
        dataSource,
      }),
    );

    await components.marketData.getBars('AAPL', { timeframe: '1h', lookback: 2 }, NOW);

    const events = entries.filter((entry) => entry.event === 'market_data_fetch');
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      instrument: 'AAPL',
      timeframe: '1h',
      lookback: 2,
      cache: 'miss',
      outcome: 'ok',
    });
  });
});

/**
 * VENUE-REACHING `(timeframe, lookback)` bar fetches one instrument's decision
 * pass issues — the ones that take a token. A `getBars` call served from the
 * store takes none and is silent in the log, which is why this is smaller than
 * the eight windows `MarketDataServiceImpl.logFetch` documents a technical
 * analyst asking for: five of those (`5m/936`, `5m/84`, `5m/81` and the
 * indicator specs behind them) are served by the 260-bar warm-up fetch that
 * precedes them.
 *
 * MEASURED (#1080) over 38 fetch bursts in the 2026-09-04, 2026-09-08 and
 * 2026-09-10 soak logs, restarts included: no instrument reached the venue for
 * more than 4 distinct windows in a burst. Five shapes appear across the
 * universe within a single burst — `5m/260` and `1h/57` for the technical
 * analyst's indicators and context, `5m/112` for MACD's warm-up, `1h/20` for
 * the trader's signal bar, and `1d/30` for `correlationConfig.window` — but no
 * single instrument asks for all five. `adv_window` (`1d/20`) is an
 * Execution-stage read (`getADV`), not part of this sweep, and appears in no
 * measured burst.
 *
 * This is a WARM-STORE count, and the soak is the only regime it was taken in.
 * A restart does not cold it — the bar store is on disk — but a first-ever tick
 * against an empty store has no 260-bar warm-up to serve the wider specs from,
 * so per-instrument demand rises toward the eight windows `logFetch` documents.
 * That case is `MarketDataServiceImpl`'s figure, not this one; it is a
 * one-time transient, and `consecutive_misses` is what surfaces it if it is
 * not. The drain below is therefore the steady-state sweep, not the worst
 * sweep the system can ever issue.
 */
const DISTINCT_BAR_WINDOWS_PER_INSTRUMENT = 4;

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

  /**
   * #1080. The cold-start derivation above counts ONE bars fetch per
   * instrument; the soak measured up to four (see
   * `DISTINCT_BAR_WINDOWS_PER_INSTRUMENT`). So a warm sweep issues up to 80
   * requests against 20 tokens of background headroom — `capacity` 41 less the
   * order path's `reserveForPriority` 21 — and the remaining 60 arrive at
   * `refillPerSecond`.
   *
   * That drain is what the analyst's per-attempt deadline actually waits on:
   * `technical` issues no LLM call at all, it fetches bars, and a fetch that
   * cannot get a token has not started. The deadline must therefore be at least
   * the drain, or the LAST instruments of every sweep time out by construction
   * — which is exactly #1080's instance 2 (57% of main-arm runs missing quorum,
   * every one attributing to `technical did not answer within 10000ms`).
   *
   * WARM STORE, and therefore not the worst sweep the system can issue. A
   * first-ever tick against an empty store has no stored history to serve the
   * wider specs from and asks the eight windows `MarketDataServiceImpl`
   * documents, which is `(20 * 8 - 20) / 2.0` = 70s of drain against a
   * 30,000ms deadline: the back of that sweep misses quorum and the tick
   * records a no-trade it never measured. It self-heals from the sweep's own
   * fetches as they land, and this deadline serves 80 of the 160 fetches
   * inside it where the 10,000ms one served 40 — better, not safe.
   *
   * Raising the deadline is not the fix available: two attempts per persona at
   * 70,000ms is 140s of analyst wall clock against a 120,000ms tick. Nothing
   * REFUSES that — `paper-profile.ts`'s pass-duration tripwire is a human one
   * and no gate downstream measures a walk (#1104) — so the overrun would just
   * happen, per instrument group, unannounced. The fix is warming the
   * store OFF the tick path, and no boot-time bar prefetch exists today; it is
   * recorded as declined-for-now on #1080 (analysts-spec.md, "Module: Failure
   * Handling"), because the starvation #1080 measured is steady-state.
   *
   * If it does not self-heal, `consecutive_misses` plus the quorum-skip alert
   * is the surface. Single-flight coalescing moved that counter from per-caller
   * to per-fetch-group — smaller and truer: it counts ticks that missed rather
   * than callers that joined one miss, so a cold store reads as a streak across
   * ticks instead of one fan-out-inflated spike.
   *
   * The literal is the shipped constants' value, pinned so a change to either
   * side has to be re-read here rather than silently absorbed.
   */
  it("affords the analyst deadline the deduped warm sweep's drain at this pacing (#1080)", () => {
    const { capacity, refillPerSecond, reserveForPriority } = DEFAULT_VENUE_PACING.alpaca;
    const backgroundHeadroom = capacity - (reserveForPriority ?? 0);
    const sweepRequests = DEFAULT_UNIVERSE.length * DISTINCT_BAR_WINDOWS_PER_INSTRUMENT;

    const drainMs = ((sweepRequests - backgroundHeadroom) / refillPerSecond) * 1_000;

    expect(drainMs).toBe(30_000);
    expect(DEFAULT_ANALYST_TIMEOUT_MS).toBeGreaterThanOrEqual(drainMs);
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
  let db: StoreHandle;

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
      bar: NOW,
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
      bar: NOW,
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
      bar: NOW,
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

  /**
   * #1140 — THE MUTATION THIS KILLS: drop `publishedSpendCap.arm(...)` from
   * `buildProductionComponents`. The cap still enforces, every test above
   * still passes, and the dashboard silently draws its meter against whatever
   * a previous run left behind (or against nothing at all).
   *
   * Asserted against the config's OWN budget rather than against 50: a wire
   * that publishes some other number is the same broken wire, and a 50 on
   * both sides would pass whether the value flowed or was retyped.
   */
  it('publishes the budget it armed the cap with, whatever the config says', () => {
    buildProductionComponents(
      stubConfig(db, { llmClient: countingLlmClient(), llmBudgetUsd: 275 }),
    );

    expect(new SqliteLlmSpendCapStore(db).read().budgetUsd).toBe(275);
  });

  it('publishes a null cap for the uncapped run it warned about, but still records that it armed', () => {
    buildProductionComponents(stubConfig(db, { llmClient: countingLlmClient() }));

    // #1196: `armed uncapped` must be distinguishable from `never armed` —
    // both carry a null budget, but only the armed one carries `armedAt`.
    const state = new SqliteLlmSpendCapStore(db).read();
    expect(state.budgetUsd).toBeNull();
    expect(state.armedAt).not.toBeNull();
  });

  it('is what the checked-in paper profile actually carries', () => {
    // The value the soak runs on, pinned where the arithmetic behind it lives.
    // $50 over 14 days is David's figure (2026-08-06).
    //
    // The cadence was 15 min, derived when spend scaled with 1/τ. #617 closed
    // (`7d68fa0`): `debate-adapter.ts` short-circuits the same bar ahead of
    // the spend cap and every LLM call, so spend is keyed to the debate bar
    // and the tick no longer prices it. #670 stepped it to 2 min accordingly.
    //
    // The budget assertion is the one that still belongs *here* — this file is
    // about the cap being wired. The cadence's own justification, and the
    // stop-fidelity ceiling that now bounds it, live in `paper-profile.test.ts`.
    const profile = paperStartingProfile('paper');

    expect(profile.llmBudgetUsd).toBe(50);
    expect(profile.tickIntervalMs).toBe(2 * 60_000);
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
    exitCheck: async () => null,
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

function stubConfig(db: StoreHandle, overrides: Partial<ProductionConfig>): StubConfig {
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
      // #586: crypto brackets submit as plain limit entries; the pacing
      // tests below drive BTC-USD through this method, not submitOrder.
      submitLimitOrder: vi.fn(async () => ({
        id: 'alpaca-order-1',
        client_order_id: 'k',
        status: 'accepted',
      })),
      submitStopLimitOrder: vi.fn(async () => ({
        id: 'alpaca-order-2',
        client_order_id: 'k:stop',
        status: 'accepted',
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
    // Not an empty cast (#691): the composition root refuses a trader config
    // whose `flatten_before_close_ms` would silently disable flat-by-close.
    traderConfig: DEFAULT_TRADER_CONFIG,
    riskConfig: makeWiringRiskConfig(),
    // Carries the automation dial, which `buildProductionComponents` reads to
    // refuse a HITL-engaging config (#434). `auto` is ADR-0007's setting.
    verdictConfig: makeWiringVerdictConfig(),
    executionConfig: makeWiringExecutionConfig(),
    correlationConfig: makeWiringCorrelationConfig(),
    // Not an empty cast since #634: `CircuitBreakers` validates its
    // hysteresis band (`recovery_drawdown_pct < max_drawdown_pct`) at
    // construction, so `{}` no longer builds.
    breakerConfig: {
      daily_loss_pct: 0.05,
      daily_loss_pct_by_class: { crypto: 0.05, stocks: 0.05 },
      max_drawdown_pct: 0.3,
      max_consecutive_losses: 5,
      volatility: { baseline: { crypto: 0.05, stocks: 0.02 }, multiplier: 3 },
      auto_rearm: { recovery_drawdown_pct: 0.2, max_days_tripped: 5 },
    } as ProductionConfig['breakerConfig'],
    costConfig: makeWiringCostConfig(),
    ciiConsumerConfig: makeWiringCiiConsumerConfig(),
    ...overrides,
  } as StubConfig;
}
