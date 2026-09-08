/**
 * The wiring proof for #1348 — a control-arm residual-exposure alert and a
 * control-arm flatten-overfill warning are each distinguishable from their
 * live counterparts at the log line, the same property #1331
 * (flatten-reconcile-arm-wiring.test.ts) proved for unresolved flattens.
 *
 * `console-channels.test.ts` proves each channel writes whatever `trace_id`
 * the alert carries; `ingest-fills.test.ts` proves each producer
 * (`alertResidualExposure`, `redistributeOneFlatten`) threads `input.trace_id`
 * rather than a literal it picked itself. Neither can prove the property this
 * file exists for: that the SURFACE OBJECTS the composition root hands to
 * each arm's recurring fill-sync loop (`startFillSync`, production.ts) are
 * really the two arms' own — not swapped.
 *
 * ## Why this drives `.reconcile()`/`.ingestFills()` on the CAPTURED surface,
 * not a poll
 *
 * `production.test.ts`'s own #1321 fill-sync case documents why no test in
 * this codebase drives a genuine recurring poll through both arms' real
 * broker/store stacks: the control arm's `SimulatedBrokerAdapter` is
 * constructed inside `production.ts` and cannot be scripted from outside it.
 * That case falls back to asserting on the `startFillSync` call site's
 * SCALAR `reconcileTraceId`/`fillSyncTraceId` arguments — which is exactly
 * the gap this file closes: it never reads `.execution`, so a mutation that
 * swaps the `execution:` object between the two `startFillSync` calls
 * (production.ts, live arm second) stays green there.
 *
 * This file captures those two `execution:` objects via the same
 * `startFillSyncSpy` technique `production.test.ts` already uses, and calls
 * their PUBLIC methods directly — `.reconcile()`, `.ingestFills()` — rather
 * than waiting on the self-arming `setTimeout` `runPoll` lives behind. That
 * is not a shortcut around the root: the object under test is the exact one
 * `production.ts` constructed and handed to `startFillSync`; only the
 * timer-driven CALL to its methods is skipped, the same way calling a method
 * on a captured real object in any other white-box test would be.
 *
 * ## What this proves for `ResidualExposureAlert`/`FlattenOverfillWarning`
 * specifically
 *
 * Both are posted by code paths reachable only through THIS SAME captured
 * `Execution` instance's own `.reconcile()`/`.ingestFills()`/
 * `.sweepResidualProtection()` — `ExecutionImpl` (execute.ts) closes over one
 * `ExecutionInput` for its whole lifetime, and every one of those methods
 * reads `this.input.trace_id`. So the first test below — which drives
 * `.reconcile()` on each captured surface and reads the trace_id off the
 * (already-proven, #1331) `FlattenReconcileAlert` line — is evidence about
 * the SURFACE, not about that one alert type: whatever id it observes is the
 * id `sweepResidualProtection`'s residual-exposure escalations and
 * `ingestFills`'s overfill warnings would ALSO carry, were they raised on
 * that same call. The second and third tests then drive each of those two
 * alerts for real, on the live arm (whose broker `ProductionConfig.broker`
 * can script; the control arm's cannot — see `control-arm-wiring.ts`'s own
 * doc on why the control arm's broker is always an internally-constructed
 * `SimulatedBrokerAdapter`), closing the loop empirically for the arm this
 * file CAN drive fills through, while the first test's surface-identity proof
 * carries the control arm's half.
 */
import type { LlmClient } from '../../../pipeline/debate-engine/index.js';
import type {
  BrokerAck,
  BrokerAdapter,
  SharedStore as ExecutionSharedStore,
  NormalizedFill,
  NormalizedOrder,
  NormalizedPosition,
} from '../../../pipeline/execution/index.js';
import { SqliteExecutionStore } from '../../../pipeline/execution/index.js';
import { DEFAULT_TRADER_CONFIG } from '../../../pipeline/trader/index.js';
import { AlwaysOpenCalendar } from '../../../providers/market-data-service/index.js';
import { PolymarketClient } from '../../../providers/market-intelligence/index.js';
import type { Logger, OpenPosition } from '../../../shared/index.js';
import { SimulatedClock, TokenBucket } from '../../../shared/index.js';
import { recordingLogger } from '../../../shared/recording-logger.js';
import { guardedStore, openSharedStore, type SharedStore } from '../../../shared/store/index.js';
import { buildProductionOrchestrator, type ProductionConfig } from '../production.js';

/**
 * The same spy `production.test.ts` installs at file scope (#1321 round 2) —
 * duplicated here rather than shared, because `vi.mock` is hoisted per
 * module and this is a separate test file/module. Defaults to the real
 * implementation, so nothing about `startFillSync`'s own behaviour changes;
 * this only exposes the exact `FillSyncDeps` object (`.execution` included)
 * each call received.
 */
const { startFillSyncSpy } = vi.hoisted(() => ({ startFillSyncSpy: vi.fn() }));

vi.mock('../fill-sync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../fill-sync.js')>();
  startFillSyncSpy.mockImplementation(actual.startFillSync);
  return { ...actual, startFillSync: startFillSyncSpy };
});

const NOW = new Date('2026-07-20T16:00:00Z');
// Strictly before every scripted fill's timestamp (15:00/15:30) below —
// `ingestFills()` fetches fills since the lot's own `opened_at`
// (`ingest-fills.test.ts`'s identical split, `OPENED_AT` vs `NOW`), so a
// position opened AT `NOW` would filter every fill in this file out.
const OPENED_AT = new Date('2026-07-20T14:00:00Z');

/**
 * A venue that answers "no such order" to every flatten lookup and reports no
 * fills — `flatten-reconcile-arm-wiring.test.ts`'s `AmnesiacFlattenBroker`,
 * verbatim. Used only for the first test, which never enters a lot or ingests
 * a fill — it just needs `reconcile()`'s flatten sweep to resolve the seeded
 * rows below without a real venue.
 */
class AmnesiacFlattenBroker implements BrokerAdapter {
  async submitBracket(): Promise<BrokerAck> {
    throw new Error('AmnesiacFlattenBroker.submitBracket: this wiring proof never enters a lot');
  }
  async getOrder(): Promise<NormalizedOrder | null> {
    return null;
  }
  async fetchNewFills(): Promise<NormalizedFill[]> {
    return [];
  }
  async resizeProtectiveLegs(): Promise<void> {
    throw new Error('AmnesiacFlattenBroker.resizeProtectiveLegs: no fill is ingested here');
  }
  async rearmProtectiveLegs(): Promise<void> {
    throw new Error('AmnesiacFlattenBroker.rearmProtectiveLegs: no partial flatten here');
  }
  async resumeFlatten(): Promise<NormalizedOrder | null> {
    return null;
  }
  async submitFlatten(): Promise<BrokerAck> {
    throw new Error('AmnesiacFlattenBroker.submitFlatten: this wiring proof never flattens');
  }
  async cancel(): Promise<void> {
    throw new Error('AmnesiacFlattenBroker.cancel: this wiring proof never cancels');
  }
  async getOpenPositions(): Promise<NormalizedPosition[]> {
    return [];
  }
}

/** `flatten-reconcile-arm-wiring.test.ts`'s seeding helper, verbatim. */
async function seedAckedThenDeniedFlatten(store: ExecutionSharedStore, key: string): Promise<void> {
  await store.writeAheadFlatten({
    idempotency_key: key,
    instrument: 'AAPL',
    asset_class: 'stocks',
    side: 'sell',
    size: 10,
    submitted_at: NOW,
    lot_held_quantities: [{ idempotency_key: `${key}-entry`, held: 10 }],
    exit_reason: 'flatten',
    decision_price: null,
    quote_bid: null,
    quote_ask: null,
    quote_mid: null,
    quote_observed_at: null,
    modelled_cost_breakdown: null,
  });
  await store.resolveFlattenSubmitted(
    key,
    { order_state: 'submitted', broker_order_ids: [`${key}:order`] },
    NOW,
  );
}

/**
 * A scripted broker for the LIVE arm — `ingest-fills.test.ts`'s
 * `ScriptedBroker`, trimmed to what these two tests drive: a fixed fill list
 * and a configurable `rearmProtectiveLegs` outcome. `ProductionConfig.broker`
 * overrides only the live arm's broker (`production.ts`); the control arm's
 * is always an internally-constructed `SimulatedBrokerAdapter` — see this
 * file's header doc for why that makes the control arm's own alert
 * unreachable this way.
 */
class ScriptedLiveBroker implements BrokerAdapter {
  rearmFailure: Error | undefined;

  constructor(private readonly scriptedFills: NormalizedFill[]) {}

  async submitBracket(): Promise<BrokerAck> {
    throw new Error('ScriptedLiveBroker.submitBracket: positions are seeded directly, not placed');
  }
  async fetchNewFills(since: Date): Promise<NormalizedFill[]> {
    return this.scriptedFills.filter((fill) => fill.timestamp.getTime() >= since.getTime());
  }
  async resizeProtectiveLegs(): Promise<void> {}
  async rearmProtectiveLegs(): Promise<void> {
    if (this.rearmFailure !== undefined) throw this.rearmFailure;
  }
  async getOrder(): Promise<NormalizedOrder | null> {
    return null;
  }
  async resumeFlatten(): Promise<never> {
    throw new Error('ScriptedLiveBroker.resumeFlatten: ingestFills() does not reconcile');
  }
  async submitFlatten(): Promise<never> {
    throw new Error('ScriptedLiveBroker.submitFlatten: ingestFills() does not flatten');
  }
  async cancel(): Promise<never> {
    throw new Error('ScriptedLiveBroker.cancel: ingestFills() does not cancel');
  }
  async getOpenPositions(): Promise<NormalizedPosition[]> {
    return [];
  }
}

function fill(overrides: Partial<NormalizedFill> = {}): NormalizedFill {
  return {
    client_order_id: 'residual-live',
    broker_fill_id: 'fill-1',
    leg: 'entry',
    price: 100,
    qty: 5,
    fee: 1,
    timestamp: new Date('2026-07-20T15:00:00Z'),
    ...overrides,
  };
}

async function seedPosition(
  store: ExecutionSharedStore,
  overrides: Partial<OpenPosition> = {},
): Promise<void> {
  await store.writeAheadPosition({
    idempotency_key: 'residual-live',
    debate_id: 'debate-1',
    instrument: 'AAPL',
    asset_class: 'stocks',
    side: 'buy',
    intent_type: 'entry',
    requested_size: 10,
    filled_size: 0,
    avg_entry_price: 0,
    stop: 95,
    target: 110,
    // `'partially_filled'`, not `'submitted'`: the latter is IN_FLIGHT
    // (reconcile.ts), so the startup reconcile's OWN positions loop would
    // ask the (unrelated) broker double `getOrder(residual-live)`, get
    // `null` back, and reject the lot before `ingestFills()` below ever
    // runs — a real partial-flatten residual is well past that state.
    order_state: 'partially_filled',
    broker_order_ids: ['residual-live:entry', 'residual-live:stop', 'residual-live:target'],
    opened_at: OPENED_AT,
    decision_timestamp: OPENED_AT,
    conviction: 0.7,
    converged: true,
    ...overrides,
  });
}

/** `filled-zero-size-wiring.test.ts`'s `StubConfig`, verbatim reasoning. */
type StubConfig = ProductionConfig & Required<Pick<ProductionConfig, 'alpacaBrokerClient'>>;

function stubConfig(db: SharedStore, logger: Logger, broker: BrokerAdapter): StubConfig {
  return {
    db,
    clock: new SimulatedClock(NOW),
    mode: 'paper',
    logger,
    broker,
    llmClient: {
      complete: async () => {
        throw new Error('unreachable: this wiring test never runs a debate');
      },
    } as unknown as LlmClient,
    alpacaBrokerClient: {
      submitOrder: async () => {
        throw new Error('unreachable: `broker` override bypasses the Alpaca wire client');
      },
      submitLimitOrder: async () => {
        throw new Error('unreachable: `broker` override bypasses the Alpaca wire client');
      },
      submitStopLimitOrder: async () => {
        throw new Error('unreachable: `broker` override bypasses the Alpaca wire client');
      },
      cancelOrder: async () => {
        throw new Error('unreachable: `broker` override bypasses the Alpaca wire client');
      },
      getOrder: async () => {
        throw new Error('unreachable: `broker` override bypasses the Alpaca wire client');
      },
      listOrders: async () => [],
      listFills: async () => [],
    } as unknown as ProductionConfig['alpacaBrokerClient'],
    alpacaDataClient: {
      getBars: async () => [],
      getLatestQuote: async () => ({ t: NOW.toISOString(), ap: 100, bp: 99 }),
    } as unknown as ProductionConfig['alpacaDataClient'],
    accountState: {
      getAccountState: async () => ({
        cash: 100_000,
        peak_equity: 100_000,
        daily_basis: {
          crypto: { known: true, open_equity: 100_000, realized_pnl: 0 },
          stocks: { known: true, open_equity: 100_000, realized_pnl: 0 },
          portfolio: { known: true, open_equity: 100_000, realized_pnl: 0 },
        },
        consecutive_losses: 0,
      }),
    } as unknown as ProductionConfig['accountState'],
    traderConfig: DEFAULT_TRADER_CONFIG,
    riskConfig: {} as ProductionConfig['riskConfig'],
    verdictConfig: {
      automation_level: { crypto: 'auto', stocks: 'auto' },
    } as ProductionConfig['verdictConfig'],
    executionConfig: {} as ProductionConfig['executionConfig'],
    correlationConfig: {} as ProductionConfig['correlationConfig'],
    breakerConfig: {
      daily_loss_pct: 0.05,
      daily_loss_pct_by_class: { crypto: 0.05, stocks: 0.05 },
      max_drawdown_pct: 0.3,
      max_consecutive_losses: 5,
      volatility: { baseline: { crypto: 0.05, stocks: 0.02 }, multiplier: 3 },
      auto_rearm: { recovery_drawdown_pct: 0.2, max_days_tripped: 5 },
    } as ProductionConfig['breakerConfig'],
    costConfig: {} as ProductionConfig['costConfig'],
    ciiConsumerConfig: {} as ProductionConfig['ciiConsumerConfig'],
    tradingCalendar: new AlwaysOpenCalendar(),
    polymarketClient: new PolymarketClient({
      rateLimiter: new TokenBucket({ capacity: 1_000, refillPerSecond: 1_000 }),
      fetchImpl: (async () => {
        throw new Error('offline: this wiring proof must not reach Polymarket');
      }) as unknown as typeof fetch,
    }),
    polymarketPollIntervalMs: 20 * 24 * 60 * 60 * 1_000,
  } as StubConfig;
}

describe('residual-exposure and flatten-overfill alerts name the arm that raised them (#1348)', () => {
  let db: SharedStore;

  beforeEach(() => {
    db = openSharedStore(':memory:');
    startFillSyncSpy.mockClear();
  });

  afterEach(() => {
    db.close();
  });

  /**
   * THE MUTATION THIS KILLS: swap the `execution:` argument between the two
   * `startFillSync` calls at the composition root (production.ts) — control
   * arm's loop armed with the live arm's surface, or vice versa. Every OTHER
   * test in this codebase asserting on this call site (`production.test.ts`'s
   * #1321 case) reads only the scalar `reconcileTraceId`/`fillSyncTraceId`
   * arguments, which are wired independently of `execution:` and so stay
   * correct under this exact swap. This is the gap.
   *
   * Positional, not a sorted set — `production.ts` calls `startFillSync` for
   * the control arm first (#1321 round 2's own documented ordering).
   */
  it("captures each arm's own fill-sync surface, not a swapped one", async () => {
    const logger = recordingLogger();
    await seedAckedThenDeniedFlatten(
      new SqliteExecutionStore(guardedStore(db, 'execution')),
      'flatten-live',
    );
    await seedAckedThenDeniedFlatten(
      new SqliteExecutionStore(guardedStore(db, 'execution'), 'control'),
      'flatten-control',
    );

    const orchestrator = buildProductionOrchestrator(
      stubConfig(db, logger, new AmnesiacFlattenBroker()),
    );
    await orchestrator.start();

    expect(startFillSyncSpy).toHaveBeenCalledTimes(2);
    const controlExecution = startFillSyncSpy.mock.calls[0]?.[0].execution;
    const liveExecution = startFillSyncSpy.mock.calls[1]?.[0].execution;

    // `start()` already ran its own one-shot startup reconcile on the
    // RECONCILE surface (a different id, `reconcile`/`control-arm-reconcile`)
    // for these same two rows — cleared here so only the two calls below,
    // driven directly on the captured FILL-SYNC surfaces, are what this
    // assertion reads. See the file doc for why calling their methods
    // directly is still the root.
    logger.entries.length = 0;
    await controlExecution.reconcile();
    await liveExecution.reconcile();
    await orchestrator.stop();

    const alerts = logger.entries.filter((entry) => entry.event === 'flatten_reconcile_unresolved');
    expect(alerts).toHaveLength(2);
    expect(
      alerts.map((entry) => ({
        trace_id: entry.trace_id,
        idempotency_key: (entry.payload as { idempotency_key?: string } | undefined)
          ?.idempotency_key,
      })),
    ).toEqual([
      { trace_id: 'control-arm-fill-sync', idempotency_key: 'flatten-control' },
      { trace_id: 'fill-sync', idempotency_key: 'flatten-live' },
    ]);
  });

  /**
   * The live arm's real re-arm failure, driven through the real production
   * wiring's fill-sync surface (captured, not built here) rather than a
   * surface `ingest-fills.test.ts` constructs by hand — closing the loop the
   * test above cannot for the alert TYPE, on the arm whose broker
   * `ProductionConfig.broker` can script.
   */
  it("posts the live arm's own re-arm failure under the fill-sync trace id", async () => {
    const logger = recordingLogger();
    const store = new SqliteExecutionStore(guardedStore(db, 'execution'));
    await seedPosition(store);

    const broker = new ScriptedLiveBroker([
      fill({ broker_fill_id: 'e1', leg: 'entry', qty: 10, price: 100 }),
      fill({
        broker_fill_id: 'x1',
        leg: 'exit',
        qty: 4,
        price: 98,
        timestamp: new Date('2026-07-20T15:30:00Z'),
      }),
    ]);
    broker.rearmFailure = new Error('venue rejected the OCO order');

    const orchestrator = buildProductionOrchestrator(stubConfig(db, logger, broker));
    await orchestrator.start();
    const liveExecution = startFillSyncSpy.mock.calls[1]?.[0].execution;

    await liveExecution.ingestFills();
    await orchestrator.stop();

    const alerts = logger.entries.filter(
      (entry) => entry.event === 'residual_exposure_unprotected',
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.trace_id).toBe('fill-sync');
    expect((alerts[0]?.payload as { idempotency_key?: string } | undefined)?.idempotency_key).toBe(
      'residual-live',
    );
  });

  /**
   * The live arm's real over-filled flatten, same reasoning as the test
   * above — `redistributeOneFlatten` runs only inside `ingestFills()`, so
   * this is the only alert of the two `FlattenOverfillWarning.trace_id`
   * doc claims for it.
   */
  it("posts the live arm's own over-filled flatten under the fill-sync trace id", async () => {
    const logger = recordingLogger();
    const store = new SqliteExecutionStore(guardedStore(db, 'execution'));
    await seedPosition(store, { idempotency_key: 'overfill-live', requested_size: 10 });
    await store.writeAheadFlatten({
      idempotency_key: 'flatten-overfill-live',
      instrument: 'AAPL',
      asset_class: 'stocks',
      side: 'sell',
      size: 6,
      submitted_at: NOW,
      lot_held_quantities: [{ idempotency_key: 'overfill-live', held: 6 }],
      exit_reason: 'flatten',
      decision_price: null,
      quote_bid: null,
      quote_ask: null,
      quote_mid: null,
      quote_observed_at: null,
      modelled_cost_breakdown: null,
    });

    const broker = new ScriptedLiveBroker([
      fill({ client_order_id: 'overfill-live', broker_fill_id: 'e1', leg: 'entry', qty: 10 }),
      fill({
        client_order_id: 'flatten-overfill-live',
        broker_fill_id: 'f1',
        leg: 'exit',
        qty: 10,
        timestamp: new Date('2026-07-20T15:30:00Z'),
      }),
    ]);

    const orchestrator = buildProductionOrchestrator(stubConfig(db, logger, broker));
    await orchestrator.start();
    const liveExecution = startFillSyncSpy.mock.calls[1]?.[0].execution;

    await liveExecution.ingestFills();
    await orchestrator.stop();

    const warnings = logger.entries.filter((entry) => entry.event === 'flatten_overfill_dropped');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.trace_id).toBe('fill-sync');
    expect(
      (warnings[0]?.payload as { idempotency_key?: string } | undefined)?.idempotency_key,
    ).toBe('flatten-overfill-live');
  });
});
