/**
 * The wiring proof for #1087's review — `FilledZeroSizeThrottle` is threaded
 * through the REAL composition root, not just implemented, unit-tested and
 * exported (the failure shape `rate-limit-wiring.test.ts`'s file header
 * names, and this repo's dominant defect class: #322).
 *
 * `ingest-fills.test.ts` and `filled-zero-size-throttle.test.ts` already
 * prove the mechanism ITSELF — `warn` fires once per episode, then `info`
 * re-announces on a low wall-clock cadence while the lot stays wedged
 * (#1383; the pre-#1383 design bounded-repeated at `warn`, every 8th poll
 * after the first at 3), carries `stuck_ms`/`consecutive`. Neither can prove
 * the thing this
 * file exists for: that `production.ts`'s `executionDeps.filledZeroSizeThrottle`
 * is the SAME instance every surface built from it shares, for the process's
 * whole lifetime — the property finding 2's throttle depends on to actually
 * bound the line count in production. A unit test builds one `ExecutionInput`
 * object by hand and reuses it directly; it cannot see a root that
 * constructs a fresh throttle per surface, because it never constructs a
 * surface at all.
 *
 * `smoke-run.ts`'s own exit-path harness deliberately does NOT cover this
 * (see its comment at the `filledZeroSizeThrottle:` line). Not because the
 * wedge is unconstructible post-fix — this file's own `WedgingBroker`
 * constructs it store-side, without touching `SimulatedBrokerAdapter` at
 * all, proving the opposite. The reason was structural: that harness wires a
 * single `innerBroker` (`SimulatedBrokerAdapter`) through one composition
 * root, and putting a wedged lot through THAT gate would mean reintroducing
 * the fixed defect rather than exercising it honestly.
 *
 * **#1125 closed that gap with a second, dedicated broker/harness surface**
 * (`SmokeWedgedLotBroker`/`runFilledZeroSizeWedgeScenario`, smoke-run.ts),
 * so `yarn smoke` itself now fails if the warning path regresses — this file
 * is no longer the only thing standing between a deleted mechanism and an
 * all-green suite. It stays, proving a DIFFERENT property #1125's scenario
 * does not: that `production.ts`'s `executionDeps.filledZeroSizeThrottle` is
 * the SAME instance every surface built from it shares — option (b) from
 * the #1096 review, a mutation-verified composition-root wiring test run
 * through `buildProductionComponents`/`buildExecutionSurface`
 * (production.ts, direct-bind.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LlmClient } from '../../../pipeline/debate-engine/index.js';
import type {
  BrokerAck,
  BrokerAdapter,
  SharedStore as ExecutionSharedStore,
  NormalizedFill,
  NormalizedOrder,
  NormalizedPosition,
} from '../../../pipeline/execution/index.js';
import { FILLED_ZERO_SIZE_REANNOUNCE_EVERY_MS } from '../../../pipeline/execution/index.js';
import { FILLED_WITH_ZERO_SIZE } from '../../../pipeline/execution/ingest-fills.js';
import { DEFAULT_TRADER_CONFIG } from '../../../pipeline/trader/index.js';
import type { Logger, OpenPosition } from '../../../shared/index.js';
import { SimulatedClock, toBrokerFillId } from '../../../shared/index.js';
import { recordingLogger } from '../../../shared/recording-logger.js';
import { openSharedStore, type SharedStore } from '../../../shared/store/index.js';
import { buildProductionComponents, type ProductionConfig } from '../production.js';
import { buildExecutionSurface } from './direct-bind.js';
import {
  makeWiringCiiConsumerConfig,
  makeWiringCorrelationConfig,
  makeWiringCostConfig,
  makeWiringExecutionConfig,
  makeWiringRiskConfig,
} from './wiring-config-fixtures.js';

const NOW = new Date('2026-07-20T16:00:00Z');
const OPENED_AT = new Date('2026-07-20T14:00:00Z');

/**
 * The shape a broker that VIOLATES the "no fill predates its own lot's
 * `opened_at`" invariant produces (what `SimulatedBrokerAdapter` did before
 * #1087, ingest-fills.test.ts's own scenario) — the ONLY way to genuinely
 * wedge a lot at zero `filled_size` forever, since every other adapter
 * upholds that invariant by construction. Trimmed to exactly the surface
 * `reconcile()`/`ingestFills()` touch; every other method throws, so an
 * unexpected call fails loudly rather than returning a silently-wrong stub.
 */
class WedgingBroker implements BrokerAdapter {
  constructor(
    private readonly order: NormalizedOrder,
    private readonly scriptedFills: NormalizedFill[],
  ) {}

  async submitBracket(): Promise<BrokerAck> {
    throw new Error('WedgingBroker.submitBracket: this wiring proof never enters a lot');
  }
  async getOrder(): Promise<NormalizedOrder | null> {
    return this.order;
  }
  async fetchNewFills(since: Date): Promise<NormalizedFill[]> {
    return this.scriptedFills.filter((fill) => fill.timestamp.getTime() >= since.getTime());
  }
  async resizeProtectiveLegs(): Promise<void> {
    throw new Error('WedgingBroker.resizeProtectiveLegs: no new fill is ever ingested here');
  }
  async rearmProtectiveLegs(): Promise<void> {
    throw new Error('WedgingBroker.rearmProtectiveLegs: no partial flatten in this scenario');
  }
  async resumeFlatten(): Promise<NormalizedOrder | null> {
    throw new Error('WedgingBroker.resumeFlatten: reconcile() has nothing unresolved to sweep');
  }
  async submitFlatten(): Promise<BrokerAck> {
    throw new Error('WedgingBroker.submitFlatten: this wiring proof never flattens');
  }
  async cancel(): Promise<void> {
    throw new Error('WedgingBroker.cancel: this wiring proof never cancels');
  }
  async getOpenPositions(): Promise<NormalizedPosition[]> {
    return [];
  }
}

async function seedWedgedPosition(store: ExecutionSharedStore): Promise<void> {
  const position: OpenPosition = {
    idempotency_key: 'key-1',
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
    order_state: 'submitted',
    broker_order_ids: ['key-1:entry', 'key-1:stop', 'key-1:target'],
    opened_at: OPENED_AT,
    decision_timestamp: OPENED_AT,
    conviction: 0.7,
    converged: true,
  };
  await store.writeAheadPosition(position);
}

/**
 * The narrowest `ProductionConfig` that reaches a bound `executionDeps` —
 * copied from `rate-limit-wiring.test.ts`'s `stubConfig` (same required
 * fields, same reason each cast is safe), trimmed of the debate-only
 * overrides this file never needs. `StubConfig` is that same file's own
 * device for the same reason: `exactOptionalPropertyTypes` refuses an
 * `X | undefined`-typed value on an optional `X` field, and
 * `Required<Pick<...>>` is what makes `alpacaBrokerClient` assignable
 * without a per-field cast fight.
 */
type StubConfig = ProductionConfig & Required<Pick<ProductionConfig, 'alpacaBrokerClient'>>;

function stubConfig(db: SharedStore, logger: Logger): StubConfig {
  return {
    db,
    clock: new SimulatedClock(NOW),
    mode: 'paper',
    logger,
    // This wiring proof never debates — a stub that throws if ever called
    // would silently pass on a `.complete` never invoked, same as leaving it
    // out; this documents the "never reached" contract instead of hoping it.
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
    verdictConfig: {
      automation_level: { crypto: 'auto', stocks: 'auto' },
    } as ProductionConfig['verdictConfig'],
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
  } as StubConfig;
}

describe('the FILLED_WITH_ZERO_SIZE throttle is wired through the real composition root (#1087)', () => {
  let db: SharedStore;

  beforeEach(() => {
    db = openSharedStore(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  /**
   * THE MUTATION THIS KILLS (verified by hand, not just asserted): change
   * `buildExecutionSurface` in `direct-bind.ts` to construct
   * `new FilledZeroSizeThrottle()` fresh on every call instead of passing
   * through `deps.filledZeroSizeThrottle`. Dropping the field entirely is
   * a `tsc` error (it's required on `ExecutionStepDeps`) — this is the
   * mutation that survives typecheck and still breaks the shared-instance
   * property. Every unit test in `ingest-fills.test.ts` and
   * `filled-zero-size-throttle.test.ts` still passes under it — they build
   * one `ExecutionInput` by hand and drive it directly, never touching
   * `buildExecutionSurface`. Only a test that goes through the REAL root and
   * builds two surfaces off the SAME `executionDeps` — exactly what
   * production does when it builds `fillSyncExecution` once at startup and
   * polls it forever — can see a throttle that quietly stopped being shared.
   *
   * Post-#1383 (round 1: warn once, then a low-cadence `info` reannounce —
   * not the transition-only "warn once, total silence" design) the
   * shared/unshared difference shows up in announcement LEVELS, not count:
   * both cases produce exactly two `FILLED_WITH_ZERO_SIZE` lines here.
   * Shared: `surfaceA` warns once on its 3rd poll (`consecutive: 3`);
   * `surfaceB`'s first poll lands past the reannounce interval inside the
   * SAME episode and reannounces at `info` (`consecutive: 4`) instead of a
   * second `warn`. Unshared: `surfaceB` starts its own fresh episode and
   * warns again on ITS OWN 3rd poll (`consecutive: 3`, not 4) — the
   * mutation this proves. Applying the mutation locally: this test goes red
   * — `announcements` levels become `['warn', 'warn']`, not `['warn',
   * 'info']`; reverting restores green.
   */
  it('shares one throttle across every surface built from the same executionDeps, so a second surface does not re-warn mid-episode', async () => {
    const logger = recordingLogger();
    const { entries } = logger;
    const order: NormalizedOrder = {
      client_order_id: 'key-1',
      broker_order_ids: ['key-1:entry', 'key-1:stop', 'key-1:target'],
      order_state: 'filled',
      filled_qty: 10,
    };
    // Dated one millisecond before `opened_at` — with this lot the SOLE open
    // position, its own `opened_at` is the poll's `since` floor, so
    // `fetchNewFills` excludes this fill on every single poll, forever
    // (`WedgingBroker.fetchNewFills` filters by `since` exactly like every
    // real adapter — the invariant violation is entirely in the fixture,
    // never in the filtering).
    const broker = new WedgingBroker(order, [
      {
        client_order_id: 'key-1',
        broker_fill_id: toBrokerFillId('e1'),
        leg: 'entry',
        qty: 10,
        price: 100,
        fee: 1,
        timestamp: new Date(OPENED_AT.getTime() - 1),
      },
    ]);
    const config = stubConfig(db, logger);
    // Captured before `buildProductionComponents` (which threads it, never
    // copies it) so this test can advance wall-clock time across surfaces —
    // the property that distinguishes a shared throttle from a fresh one
    // now that the throttle's re-announcement is time-based, not
    // poll-count-based (#1383).
    const clock = config.clock as SimulatedClock;
    const components = buildProductionComponents({ ...config, broker });
    await seedWedgedPosition(components.executionStore);

    // Surface #1: what `fillSyncExecution` actually is in production —
    // `buildExecutionSurface(components.executionDeps, ...)`, built once.
    const surfaceA = buildExecutionSurface(components.executionDeps, 'trace-wiring-a');
    await surfaceA.reconcile();
    // Three polls: `ALERT_AFTER_CONSECUTIVE_ZERO_SIZE=3` stays quiet for the
    // first two (consecutive 1, 2), warns once on the 3rd.
    for (let poll = 0; poll < 3; poll += 1) {
      await surfaceA.ingestFills();
    }

    // Past the reannounce interval before surface #2 polls at all — the
    // mutation this proves: if the root silently stopped threading one
    // shared throttle instance, surface #2 would start its own fresh
    // episode (quiet at consecutive 1, 2, `warn` on ITS OWN consecutive 3);
    // sharing correctly, its first poll lands inside `surfaceA`'s
    // already-warned episode, past due for the low-cadence `info`
    // reannounce, and its next two polls are too soon to reannounce again.
    clock.advanceTo(new Date(NOW.getTime() + FILLED_ZERO_SIZE_REANNOUNCE_EVERY_MS + 1));

    // Surface #2: a SEPARATE `buildExecutionSurface` call against the SAME
    // `components.executionDeps` — the shape a second consumer of the same
    // root's deps takes.
    const surfaceB = buildExecutionSurface(components.executionDeps, 'trace-wiring-b');
    for (let poll = 0; poll < 3; poll += 1) {
      await surfaceB.ingestFills();
    }

    // No `getPosition` on the `SharedStore` port itself (only the test
    // harness's `TestExecutionStore` adds that convenience) — `getOpenPositions`
    // is the real port surface, same as `ingestFills()` itself reads.
    const [position] = await components.executionStore.getOpenPositions();
    expect(position?.idempotency_key).toBe('key-1');
    expect(position?.order_state).toBe('filled');
    expect(position?.filled_size).toBe(0);
    expect(await components.executionStore.getFills('key-1')).toHaveLength(0);

    const announcements = entries.filter((entry) => entry.message === FILLED_WITH_ZERO_SIZE);
    // Exactly one `warn` and one `info`: the throttle counted all six polls
    // as ONE continuous episode across two independently-built surfaces —
    // an unshared surface #2 would instead have produced a SECOND `warn`
    // (its own consecutive 3) and no `info` at all (see the note above).
    expect(announcements.map((entry) => entry.level)).toEqual(['warn', 'info']);
    expect(announcements[0]?.payload).toMatchObject({
      idempotency_key: 'key-1',
      instrument: 'AAPL',
      order_state: 'filled',
      consecutive: 3,
    });
    expect(announcements[1]?.payload).toMatchObject({
      idempotency_key: 'key-1',
      instrument: 'AAPL',
      order_state: 'filled',
      consecutive: 4,
    });
    // Both carry how long the lot has been stuck, and it grows across them
    // — the property #1128's `ExitSkipWriteThrottle` docblock relies on
    // this channel to provide.
    const stuckMsValues = announcements.map(
      (entry) => (entry.payload as { stuck_ms?: unknown })?.stuck_ms,
    );
    for (const stuckMs of stuckMsValues) {
      expect(typeof stuckMs).toBe('number');
    }
    expect(stuckMsValues[1]).toBeGreaterThan(stuckMsValues[0] as number);

    // And this IS the root's own logger — `config.logger`, the same seam
    // `startFromEnvironment` resolves from `SAMURAI_ALERTS` in a real boot —
    // not a channel `ingestFills()` was handed directly by the test.
    expect(logger).toBe(config.logger);
  });
});
