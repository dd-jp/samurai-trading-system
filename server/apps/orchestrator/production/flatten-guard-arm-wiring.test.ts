/**
 * The wiring proof for #1389's in-flight flatten guard — each arm's guard reads
 * its OWN flatten journal.
 *
 * `decide.test.ts` proves the guard skips when `unresolvedFlattens` names the
 * instrument, and `flat-by-close-to-execution.test.ts` proves the live arm's
 * thunk is bound to the store its positions come from. Neither can prove the
 * property this file exists for, because both build their trader steps
 * themselves: that the CONTROL arm's thunk is bound to the control book.
 *
 * `buildControlArmWiring` composes the control Trader by spreading the live
 * arm's `TraderStepDeps` and overriding the per-arm fields one at a time. An
 * override omitted there is invisible — the spread silently supplies the live
 * arm's binding, `tsc` is satisfied (the field is required and present), and
 * every existing test stays green because none of them builds the control arm's
 * trader steps at all. `getUnresolvedFlattens` shipped that way in #1389's first
 * round: the control arm asked the live book whether a flatten was in flight,
 * so a live flatten wedged at `submitting` (a lost ack, or a flatten that never
 * fills and so is never swept) made the control arm skip its own flatten for
 * that instrument — on every later tick and every future close, in a MATCHED
 * control where every instrument is an instrument both arms hold. The arm whose
 * whole job is to be the falsifier baseline would then carry lots past the
 * close, which is the failure #1389 was filed for.
 *
 * Driven through `buildProductionOrchestrator(...)`, not through a
 * `buildControlArmWiring` call this file assembles: the deps that reach the
 * control arm are the ROOT's `traderStepDeps`, and a test that hands
 * `buildControlArmWiring` a deps object of its own asserts a binding it chose.
 * `flatten-reconcile-arm-wiring.test.ts`'s reasoning, and its stub config.
 *
 * The two thunks are read directly rather than by driving a tick. What is under
 * test is which BOOK each guard consults, and a row's visibility is the whole
 * of that — `SqliteExecutionStore` scopes `getUnresolvedFlattens` with
 * `WHERE arm = ?` (migration 0050), so arm-scoping is a property of the store
 * INSTANCE the thunk closes over and nothing downstream of the thunk can
 * restore it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmClient } from '../../../pipeline/debate-engine/index.js';
import type {
  BrokerAck,
  BrokerAdapter,
  SharedStore as ExecutionSharedStore,
  NormalizedFill,
  NormalizedOrder,
  NormalizedPosition,
} from '../../../pipeline/execution/index.js';
import {
  SqliteExecutionStore,
  UNRESOLVABLE_FLATTEN_MAX_AGE_MS,
} from '../../../pipeline/execution/index.js';
import { DEFAULT_TRADER_CONFIG } from '../../../pipeline/trader/index.js';
import { AlwaysOpenCalendar } from '../../../providers/market-data-service/index.js';
import { PolymarketClient } from '../../../providers/market-intelligence/index.js';
import type { Logger } from '../../../shared/index.js';
import { SimulatedClock, TokenBucket } from '../../../shared/index.js';
import { recordingLogger } from '../../../shared/recording-logger.js';
import { guardedStore, openSharedStore, type StoreHandle } from '../../../shared/store/index.js';
import { buildProductionOrchestrator, type ProductionConfig } from '../production.js';
import type { TraderStepDeps } from './direct-bind.js';
import {
  makeWiringCiiConsumerConfig,
  makeWiringCorrelationConfig,
  makeWiringCostConfig,
  makeWiringExecutionConfig,
  makeWiringRiskConfig,
  makeWiringVerdictConfig,
} from './wiring-config-fixtures.js';

/**
 * `residual-and-overfill-arm-wiring.test.ts`'s `startFillSync` spy, same shape
 * and same reason: defaults to the real implementation, so nothing about what
 * the root builds changes — this only exposes the exact `TraderStepDeps` object
 * each of the two `buildTraderSteps` calls received. The thunk is not reachable
 * from `ControlArmWiring`'s return value (it exposes the tick step, the two
 * execution surfaces and the store), so capturing the deps at the builder is
 * the only way to read it.
 */
const { buildTraderStepsSpy } = vi.hoisted(() => ({ buildTraderStepsSpy: vi.fn() }));

vi.mock('./direct-bind.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./direct-bind.js')>();
  buildTraderStepsSpy.mockImplementation(actual.buildTraderSteps);
  return { ...actual, buildTraderSteps: buildTraderStepsSpy };
});

const NOW = new Date('2026-07-20T16:00:00Z');

/** `flatten-reconcile-arm-wiring.test.ts`'s broker, verbatim reasoning. */
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

/**
 * A flatten left at `'submitting'` — the write-ahead is on record and no ack
 * has come back. That is `getUnresolvedFlattens`'s first disjunct and the state
 * the guard exists to refuse a second flatten in, so it is what a seeded row
 * has to be. Written AFTER the boot on purpose: `start()`'s reconcile sweep
 * would otherwise settle it, and this file is about which rows each thunk can
 * SEE, not about the sweep.
 */
async function seedUnresolvedFlatten(
  store: ExecutionSharedStore,
  key: string,
  instrument: string,
): Promise<void> {
  await store.writeAheadFlatten({
    idempotency_key: key,
    instrument,
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
}

/**
 * The one `buildTraderSteps` call made for `arm`, with `undefined` read as
 * `'live'` (`TraderStepDeps.arm`'s documented absent state). `arm` is the field
 * `buildControlArmWiring` demonstrably does override, so it identifies the two
 * calls without depending on the order the root happens to build them in.
 */
function onlyArm(captured: readonly TraderStepDeps[], arm: 'live' | 'control'): TraderStepDeps {
  const matches = captured.filter((deps) => (deps.arm ?? 'live') === arm);
  expect(matches).toHaveLength(1);
  const [only] = matches;
  if (only === undefined) {
    throw new Error(`no ${arm}-arm buildTraderSteps call was captured`);
  }
  return only;
}

/** `flatten-reconcile-arm-wiring.test.ts`'s `StubConfig`, verbatim reasoning. */
type StubConfig = ProductionConfig & Required<Pick<ProductionConfig, 'alpacaBrokerClient'>>;

/** `flatten-reconcile-arm-wiring.test.ts`'s stub config, verbatim. */
function stubConfig(db: StoreHandle, logger: Logger): StubConfig {
  return {
    db,
    clock: new SimulatedClock(NOW),
    mode: 'paper',
    logger,
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
    riskConfig: makeWiringRiskConfig(),
    verdictConfig: makeWiringVerdictConfig(),
    executionConfig: makeWiringExecutionConfig(),
    correlationConfig: makeWiringCorrelationConfig(),
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

describe("the in-flight flatten guard reads its own arm's journal (#1389)", () => {
  let db: StoreHandle;

  beforeEach(() => {
    db = openSharedStore(':memory:');
    buildTraderStepsSpy.mockClear();
  });

  afterEach(() => {
    db.close();
  });

  /**
   * THE MUTATION THIS KILLS: drop `getUnresolvedFlattens` from
   * `buildControlArmWiring`'s `buildTraderSteps({ ... })` overrides
   * (control-arm-wiring.ts). The spread then supplies the live arm's binding,
   * `tsc` stays green (the field is required and present), and the whole suite
   * stays green except this case — which is exactly how the defect shipped.
   *
   * The rows are seeded on DIFFERENT instruments, not on one: a same-instrument
   * pair would leave the control thunk returning a row of the right shape under
   * the defect, and only the arm-scoping (which row) is under test here. Each
   * arm is asserted to see its own row AND not to see the other's, so binding
   * the control thunk to the live store fails on both halves and binding the
   * LIVE thunk to the control store fails too.
   */
  it("binds each arm's `getUnresolvedFlattens` to that arm's own store", async () => {
    const orchestrator = buildProductionOrchestrator({
      ...stubConfig(db, recordingLogger()),
      broker: new AmnesiacFlattenBroker(),
    });
    await orchestrator.start();
    await orchestrator.stop();

    const capturedDeps = buildTraderStepsSpy.mock.calls.map(([deps]) => deps as TraderStepDeps);
    const liveDeps = onlyArm(capturedDeps, 'live');
    const controlDeps = onlyArm(capturedDeps, 'control');

    await seedUnresolvedFlatten(
      new SqliteExecutionStore(guardedStore(db, 'execution')),
      'flatten-live',
      'AAPL',
    );
    await seedUnresolvedFlatten(
      new SqliteExecutionStore(guardedStore(db, 'execution'), 'control'),
      'flatten-control',
      'TSLA',
    );

    expect((await liveDeps.getUnresolvedFlattens()).map((row) => row.instrument)).toEqual(['AAPL']);
    expect((await controlDeps.getUnresolvedFlattens()).map((row) => row.instrument)).toEqual([
      'TSLA',
    ]);
  });

  /**
   * #1500: both arms' `getUnresolvedFlattens` binding must be the AGE-BOUNDED
   * thunk (`boundedUnresolvedFlattens`), not the store's raw, unbounded scan
   * — see `flatten-guard.ts`'s doc. THE MUTATION THIS KILLS: either
   * composition root (production.ts's live-arm bind, or
   * `buildControlArmWiring`'s `getUnresolvedFlattens` override) reverting to
   * `() => store.getUnresolvedFlattens()`. That mutation is invisible to the
   * test above — it still asserts the right ROW comes back for a fresh
   * flatten — so it needs its own row that has aged out.
   */
  it("bounds each arm's guard by age, not only by arm (#1500)", async () => {
    const clock = new SimulatedClock(NOW);
    const orchestrator = buildProductionOrchestrator({
      ...stubConfig(db, recordingLogger()),
      clock,
      broker: new AmnesiacFlattenBroker(),
    });
    await orchestrator.start();
    await orchestrator.stop();

    const capturedDeps = buildTraderStepsSpy.mock.calls.map(([deps]) => deps as TraderStepDeps);
    const liveDeps = onlyArm(capturedDeps, 'live');
    const controlDeps = onlyArm(capturedDeps, 'control');

    await seedUnresolvedFlatten(
      new SqliteExecutionStore(guardedStore(db, 'execution')),
      'flatten-live-aged',
      'AAPL',
    );
    await seedUnresolvedFlatten(
      new SqliteExecutionStore(guardedStore(db, 'execution'), 'control'),
      'flatten-control-aged',
      'TSLA',
    );

    // Still within the bound — both #1389 guards see their own row.
    expect((await liveDeps.getUnresolvedFlattens()).map((row) => row.instrument)).toEqual(['AAPL']);
    expect((await controlDeps.getUnresolvedFlattens()).map((row) => row.instrument)).toEqual([
      'TSLA',
    ]);

    clock.advanceTo(new Date(NOW.getTime() + UNRESOLVABLE_FLATTEN_MAX_AGE_MS + 1));

    expect(await liveDeps.getUnresolvedFlattens()).toEqual([]);
    expect(await controlDeps.getUnresolvedFlattens()).toEqual([]);

    // The row itself is untouched — this gate stops CITING it, not resolving
    // it. `reconcile()`'s own worklist (the raw, unbounded scan) still sees it.
    expect(
      (await new SqliteExecutionStore(guardedStore(db, 'execution')).getUnresolvedFlattens()).map(
        (row) => row.idempotency_key,
      ),
    ).toEqual(['flatten-live-aged']);
  });
});
