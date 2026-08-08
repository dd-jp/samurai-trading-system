/**
 * The #549 residual-protection sweep, tested across the crash windows the
 * durable marker (migration 0024) exists to close. "A restart" here is
 * `reconcile.test.ts`'s own definition: a SECOND `ExecutionImpl` over a FRESH
 * `SqliteExecutionStore` on the SAME database handle — everything in-memory
 * is gone, everything durable survives.
 */
import type { CostModel } from '../cost-model-backtest/index.js';
import type { MarketDataService } from '../market-data-service/index.js';
import type { Clock, Fill, Logger, OpenPosition } from '../shared/index.js';
import { recordingLogger } from '../shared/recording-logger.js';
import { ExecutionImpl } from './execute.js';
import { openTestExecutionStore, TestExecutionStore } from './sqlite-store-harness.js';
import type {
  BrokerAck,
  BrokerAdapter,
  ExecutionConfig,
  ExecutionInput,
  NativeBracketRequest,
  NormalizedFill,
  NormalizedOrder,
  ResidualExposureAlert,
  ResidualExposureAlertChannel,
} from './types.js';

const NOW = new Date('2026-08-07T16:00:00Z');
const OPENED_AT = new Date('2026-08-07T14:00:00Z');
const LOT = 'key-1';

async function seedPosition(
  store: TestExecutionStore,
  overrides: Partial<OpenPosition> = {},
): Promise<OpenPosition> {
  const position: OpenPosition = {
    idempotency_key: LOT,
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
    // NOT in reconcile's IN_FLIGHT set, so `reconcile()`'s bracket pass
    // leaves it alone and only the #549 sweep acts on it.
    order_state: 'partially_filled',
    broker_order_ids: [`${LOT}:entry`],
    opened_at: OPENED_AT,
    decision_timestamp: OPENED_AT,
    conviction: 0.7,
    converged: true,
    ...overrides,
  };
  await store.writeAheadPosition(position);
  return position;
}

/** Persists the durable state a partial flatten leaves: entry 10, exit 4, lot not flat. */
async function seedPartiallyFlattenedFills(store: TestExecutionStore): Promise<void> {
  const entry: Fill = {
    idempotency_key: LOT,
    broker_fill_id: 'e1',
    leg: 'entry',
    price: 100,
    qty: 10,
    fee: 1,
    timestamp: new Date('2026-08-07T15:00:00Z'),
  };
  const exit: Fill = {
    idempotency_key: LOT,
    broker_fill_id: 'x1',
    leg: 'exit',
    price: 104,
    qty: 4,
    fee: 0.4,
    timestamp: new Date('2026-08-07T15:30:00Z'),
  };
  await store.applyLotAdvance({
    idempotency_key: LOT,
    fills: [entry, exit],
    position_update: { filled_size: 10, avg_entry_price: 100, order_state: 'partially_filled' },
  });
}

/** A broker for the sweep: only `rearmProtectiveLegs` (scriptable) and reconcile's reads matter. */
class SweepBroker implements BrokerAdapter {
  readonly rearmCalls: Array<{ clientOrderId: string; qty: number }> = [];
  /** When set, `rearmProtectiveLegs` rejects with this. */
  rearmFailure: Error | undefined;

  async submitBracket(order: NativeBracketRequest): Promise<BrokerAck> {
    return {
      client_order_id: order.client_order_id,
      broker_order_ids: [order.client_order_id],
      order_state: 'submitted',
    };
  }
  async fetchNewFills(_since: Date): Promise<NormalizedFill[]> {
    return [];
  }
  async resizeProtectiveLegs(): Promise<void> {}
  async rearmProtectiveLegs(
    clientOrderId: string,
    _instrument: string,
    _side: 'buy' | 'sell',
    qty: number,
  ): Promise<void> {
    this.rearmCalls.push({ clientOrderId, qty });
    if (this.rearmFailure !== undefined) throw this.rearmFailure;
  }
  async getOrder(): Promise<NormalizedOrder | null> {
    return null;
  }
  async resumeFlatten(): Promise<NormalizedOrder | null> {
    return null;
  }
  async submitFlatten(): Promise<never> {
    throw new Error('SweepBroker.submitFlatten: not part of these scenarios');
  }
  async cancel(): Promise<void> {}
  /** Empty so `reconcile()`'s unrecorded-position pass reports nothing. */
  async getOpenPositions(): ReturnType<BrokerAdapter['getOpenPositions']> {
    return [];
  }
}

function makeResidualExposureAlerts(): ResidualExposureAlertChannel & {
  alerts: ResidualExposureAlert[];
} {
  const alerts: ResidualExposureAlert[] = [];
  return {
    alerts,
    async postResidualExposureAlert(alert: ResidualExposureAlert): Promise<void> {
      alerts.push(alert);
    },
  };
}

function makeInput(
  broker: BrokerAdapter,
  store: TestExecutionStore,
  residualExposureAlerts: ResidualExposureAlertChannel = makeResidualExposureAlerts(),
  logger: Logger = recordingLogger(),
): ExecutionInput {
  const config: ExecutionConfig = {
    simulated: {
      volatility_indicator: {
        indicator: 'atr',
        params: { period: 14 },
        timeframe: '1h',
        lookback: 15,
      },
      adv_window: { timeframe: '1d', lookback: 20 },
    },
  };
  const clock: Clock = { now: () => NOW };
  return {
    trace_id: 'trace-sweep',
    clock,
    broker,
    store,
    costModel: {} as CostModel,
    marketData: {} as MarketDataService,
    config,
    mode: 'backtest',
    residualExposureAlerts,
    flattenOverfillAlerts: { postFlattenOverfillWarning: async () => {} },
    flattenReconcileAlerts: { postFlattenReconcileAlert: async () => {} },
    logger,
  };
}

describe('residual-protection sweep (#549)', () => {
  it('window (a): crash after the exit fill persisted, before the re-arm attempt — the restarted reconcile() retries and clears the marker', async () => {
    const { db, store } = openTestExecutionStore();
    await seedPosition(store);
    await seedPartiallyFlattenedFills(store);
    // The durable trace the crashed poll left: `redistributeOneFlatten`
    // marks a named lot's unclosed share BEFORE any advance persists, so
    // this exact state — exit fill durable, marker durable, no re-arm ever
    // attempted, nothing left in the fill feed — is what a restart finds.
    await store.markResidualUnprotected(LOT, NOW);

    // Restart: fresh store instance + fresh broker over the same database.
    const restartedStore = new TestExecutionStore(db);
    const broker = new SweepBroker();
    const alerts = makeResidualExposureAlerts();
    const report = await new ExecutionImpl(makeInput(broker, restartedStore, alerts)).reconcile();

    // The sweep, not the fill path, re-armed the residual (10 − 4 = 6).
    expect(broker.rearmCalls).toEqual([{ clientOrderId: LOT, qty: 6 }]);
    // Marker cleared only because protection was CONFIRMED.
    expect(await restartedStore.getResidualProtectionMarker(LOT)).toEqual({
      unprotected_since: null,
      alerted_at: null,
    });
    // Reported through reconcile's own divergence surface, and counted.
    const divergence = report.divergences.find((entry) => entry.idempotency_key === LOT);
    expect(divergence?.action).toBe('adopted');
    expect(report.checked).toBeGreaterThanOrEqual(1);
    expect(report.corrected).toBeGreaterThanOrEqual(1);
    // A successful retry pages nobody.
    expect(alerts.alerts).toEqual([]);
  });

  it('window (b): re-arm succeeded venue-side but crashed before confirming — the sweep retry is adopt-or-place, not a double submit', async () => {
    // The seam-level contract: the sweep retries through the SAME
    // `rearmProtectiveLegs` call, and the adapter resolves it by ADOPTING
    // the live prior order under the deterministic wire id (asserted against
    // the real AlpacaBrokerAdapter in alpaca-adapter.test.ts, "re-arm
    // adopt-or-place (#549)"). Here: the retry resolving must clear the
    // marker exactly as a fresh place does, and must call the seam ONCE.
    const { db, store } = openTestExecutionStore();
    await seedPosition(store);
    await seedPartiallyFlattenedFills(store);
    await store.markResidualUnprotected(LOT, NOW);

    const restartedStore = new TestExecutionStore(db);
    const broker = new SweepBroker(); // resolves = adopted-or-placed, either way confirmed.
    const execution = new ExecutionImpl(makeInput(broker, restartedStore));
    const result = await execution.sweepResidualProtection();

    expect(broker.rearmCalls).toEqual([{ clientOrderId: LOT, qty: 6 }]);
    expect(result.checked).toBe(1);
    expect(result.divergences.map((entry) => entry.action)).toEqual(['adopted']);
    expect(await restartedStore.getResidualProtectionMarker(LOT)).toEqual({
      unprotected_since: null,
      alerted_at: null,
    });

    // And the pass after that is a no-op: nothing marked, no broker call.
    const second = await execution.sweepResidualProtection();
    expect(second).toEqual({ checked: 0, divergences: [] });
    expect(broker.rearmCalls).toHaveLength(1);
  });

  it('window (c): the observing poll’s re-arm threw and the process lived — the marker survives, the sweep retries and clears it without paging twice', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, { order_state: 'filled', filled_size: 10, avg_entry_price: 100 });
    // Entry already on record from an earlier poll; THIS poll offers the
    // partial exit fill, whose re-arm fails — the real ingest path writes
    // the marker and the alert dedup.
    await store.applyLotAdvance({
      idempotency_key: LOT,
      fills: [
        {
          idempotency_key: LOT,
          broker_fill_id: 'e1',
          leg: 'entry',
          price: 100,
          qty: 10,
          fee: 1,
          timestamp: new Date('2026-08-07T15:00:00Z'),
        },
      ],
      position_update: { filled_size: 10, avg_entry_price: 100, order_state: 'filled' },
    });

    const failingBroker = new (class extends SweepBroker {
      override async fetchNewFills(): Promise<NormalizedFill[]> {
        return [
          {
            client_order_id: LOT,
            broker_fill_id: 'x1',
            leg: 'exit',
            price: 104,
            qty: 4,
            fee: 0.4,
            timestamp: new Date('2026-08-07T15:30:00Z'),
          },
        ];
      }
    })();
    failingBroker.rearmFailure = new Error('venue briefly unreachable');
    const alerts = makeResidualExposureAlerts();
    const execution = new ExecutionImpl(makeInput(failingBroker, store, alerts));

    await execution.ingestFills();

    // The observing poll alerted once (the pre-#549 behaviour) AND left the
    // durable episode: marked unprotected, marked alerted.
    expect(alerts.alerts).toHaveLength(1);
    const marker = await store.getResidualProtectionMarker(LOT);
    expect(marker?.unprotected_since).not.toBeNull();
    expect(marker?.alerted_at).not.toBeNull();

    // The venue heals; the fill-sync-cadence sweep (same live Execution, no
    // restart) retries, confirms, clears — and does NOT page again.
    failingBroker.rearmFailure = undefined;
    const result = await execution.sweepResidualProtection();

    expect(result.divergences.map((entry) => entry.action)).toEqual(['adopted']);
    expect(await store.getResidualProtectionMarker(LOT)).toEqual({
      unprotected_since: null,
      alerted_at: null,
    });
    expect(alerts.alerts).toHaveLength(1);
  });

  it('window (d): protection was confirmed on the observing poll — no marker survives and the sweep no-ops', async () => {
    const { db, store } = openTestExecutionStore();
    await seedPosition(store, { order_state: 'filled', filled_size: 10, avg_entry_price: 100 });
    const broker = new (class extends SweepBroker {
      override async fetchNewFills(): Promise<NormalizedFill[]> {
        return [
          {
            client_order_id: LOT,
            broker_fill_id: 'e1',
            leg: 'entry',
            price: 100,
            qty: 10,
            fee: 1,
            timestamp: new Date('2026-08-07T15:00:00Z'),
          },
          {
            client_order_id: LOT,
            broker_fill_id: 'x1',
            leg: 'exit',
            price: 104,
            qty: 4,
            fee: 0.4,
            timestamp: new Date('2026-08-07T15:30:00Z'),
          },
        ];
      }
    })();
    const alerts = makeResidualExposureAlerts();
    await new ExecutionImpl(makeInput(broker, store, alerts)).ingestFills();

    // The observing poll re-armed successfully → marker cleared same poll.
    expect(broker.rearmCalls).toEqual([{ clientOrderId: LOT, qty: 6 }]);
    expect(await store.getResidualProtectionMarker(LOT)).toEqual({
      unprotected_since: null,
      alerted_at: null,
    });

    // Restart: the sweep finds nothing — no retry, no alert, no divergence.
    const restartedStore = new TestExecutionStore(db);
    const restartedBroker = new SweepBroker();
    const result = await new ExecutionImpl(
      makeInput(restartedBroker, restartedStore),
    ).sweepResidualProtection();
    expect(result).toEqual({ checked: 0, divergences: [] });
    expect(restartedBroker.rearmCalls).toEqual([]);
    expect(alerts.alerts).toEqual([]);
  });

  it('escalates from the SWEEP when the retry fails — once per episode, not once per pass (#342)', async () => {
    // Window (a) shape — the crash meant NO inline alert ever fired — so the
    // sweep is the only surface left that can page.
    const { db, store } = openTestExecutionStore();
    await seedPosition(store);
    await seedPartiallyFlattenedFills(store);
    await store.markResidualUnprotected(LOT, NOW);

    const restartedStore = new TestExecutionStore(db);
    const broker = new SweepBroker();
    broker.rearmFailure = new Error('venue still down');
    const alerts = makeResidualExposureAlerts();
    const execution = new ExecutionImpl(makeInput(broker, restartedStore, alerts));

    const first = await execution.sweepResidualProtection();
    expect(first.divergences.map((entry) => entry.action)).toEqual(['undetermined']);
    expect(alerts.alerts).toHaveLength(1);
    expect(alerts.alerts[0]).toMatchObject({
      idempotency_key: LOT,
      residual_qty: 6,
      residual_qty_is_upper_bound: false,
    });

    // Pass 2 and 3: retried (every attempt), NOT re-paged (once per episode).
    const second = await execution.sweepResidualProtection();
    const third = await execution.sweepResidualProtection();
    expect(second.divergences.map((entry) => entry.action)).toEqual(['undetermined']);
    expect(third.divergences.map((entry) => entry.action)).toEqual(['undetermined']);
    expect(broker.rearmCalls).toHaveLength(3);
    expect(alerts.alerts).toHaveLength(1);

    // The episode ends when a retry finally confirms — and a FUTURE episode
    // may page afresh, because the dedup clears with the marker.
    broker.rearmFailure = undefined;
    await execution.sweepResidualProtection();
    expect(await restartedStore.getResidualProtectionMarker(LOT)).toEqual({
      unprotected_since: null,
      alerted_at: null,
    });
  });

  it('re-pages on the next pass when the alert channel swallowed the first delivery — dedup records only accepted pages (#549 review)', async () => {
    const { db, store } = openTestExecutionStore();
    await seedPosition(store);
    await seedPartiallyFlattenedFills(store);
    await store.markResidualUnprotected(LOT, NOW);

    const restartedStore = new TestExecutionStore(db);
    const broker = new SweepBroker();
    broker.rearmFailure = new Error('venue still down');
    // A transport that is DOWN for the first delivery and healthy after —
    // the transient outage that must not permanently silence the page.
    const delivered: ResidualExposureAlert[] = [];
    let failDeliveriesRemaining = 1;
    const flakyChannel: ResidualExposureAlertChannel = {
      async postResidualExposureAlert(alert: ResidualExposureAlert): Promise<void> {
        if (failDeliveriesRemaining > 0) {
          failDeliveriesRemaining -= 1;
          throw new Error('alert transport outage');
        }
        delivered.push(alert);
      },
    };
    const execution = new ExecutionImpl(makeInput(broker, restartedStore, flakyChannel));

    await execution.sweepResidualProtection();
    // The delivery was swallowed, so the episode must NOT read as alerted.
    expect(delivered).toHaveLength(0);
    expect((await restartedStore.getResidualProtectionMarker(LOT))?.alerted_at).toBeNull();

    // Next pass: still failing, transport healthy — the page goes out now,
    // and only now is the dedup recorded.
    await execution.sweepResidualProtection();
    expect(delivered).toHaveLength(1);
    expect((await restartedStore.getResidualProtectionMarker(LOT))?.alerted_at).not.toBeNull();

    // And a third pass stays deduped.
    await execution.sweepResidualProtection();
    expect(delivered).toHaveLength(1);
  });

  it('clears a marker whose lot reads flat on the persisted record without any broker call', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store);
    await store.applyLotAdvance({
      idempotency_key: LOT,
      fills: [
        {
          idempotency_key: LOT,
          broker_fill_id: 'e1',
          leg: 'entry',
          price: 100,
          qty: 10,
          fee: 1,
          timestamp: new Date('2026-08-07T15:00:00Z'),
        },
        {
          idempotency_key: LOT,
          broker_fill_id: 'x1',
          leg: 'exit',
          price: 104,
          qty: 10,
          fee: 1,
          timestamp: new Date('2026-08-07T15:30:00Z'),
        },
      ],
      position_update: { filled_size: 10, avg_entry_price: 100, order_state: 'partially_filled' },
    });
    await store.markResidualUnprotected(LOT, NOW);

    const broker = new SweepBroker();
    const result = await new ExecutionImpl(makeInput(broker, store)).sweepResidualProtection();

    expect(broker.rearmCalls).toEqual([]);
    expect(result.divergences.map((entry) => entry.action)).toEqual(['adopted']);
    expect(await store.getResidualProtectionMarker(LOT)).toEqual({
      unprotected_since: null,
      alerted_at: null,
    });
  });

  it('excludes terminal lots from the worklist — a closed lot with a stale marker is settled, not swept', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store);
    await store.markResidualUnprotected(LOT, NOW);
    await store.updatePositionState(LOT, { order_state: 'closed', broker_order_ids: [] });

    expect(await store.getUnprotectedResidualLots()).toEqual([]);
  });

  // #549 review (cycle 2): every containment branch of `sweepOne`, pinned
  // directly — not through the smoke run's happy path and not through
  // fill-sync's mocked surface.
  describe('sweep containment branches', () => {
    it('pages the upper-bound requested_size and keeps the marker when the fill read fails', async () => {
      const { db, store } = openTestExecutionStore();
      await seedPosition(store);
      await seedPartiallyFlattenedFills(store);
      await store.markResidualUnprotected(LOT, NOW);

      const failingStore = new (class extends TestExecutionStore {
        override async getFills(): Promise<never> {
          throw new Error('fills table unreadable');
        }
      })(db);
      const broker = new SweepBroker();
      const alerts = makeResidualExposureAlerts();
      const result = await new ExecutionImpl(
        makeInput(broker, failingStore, alerts),
      ).sweepResidualProtection();

      // The exact residual is unknowable — the page carries the lot's whole
      // requested size, flagged as an upper bound (#569's semantics).
      expect(alerts.alerts).toEqual([
        expect.objectContaining({
          idempotency_key: LOT,
          residual_qty: 10,
          residual_qty_is_upper_bound: true,
        }),
      ]);
      // No re-arm was attempted off a figure that could not be computed.
      expect(broker.rearmCalls).toEqual([]);
      expect(result.divergences.map((entry) => entry.action)).toEqual(['undetermined']);
      // The marker stays for the next pass's fresh read.
      expect(
        (await failingStore.getResidualProtectionMarker(LOT))?.unprotected_since,
      ).not.toBeNull();
    });

    it('refuses a non-finite recomputed residual — alert, no broker call, marker stays', async () => {
      const { db, store } = openTestExecutionStore();
      await seedPosition(store);
      await store.markResidualUnprotected(LOT, NOW);

      // Entry and exit both sum to Infinity: `coversQty(Inf, Inf)` is false
      // (Inf − Inf·ε is NaN, and Inf >= NaN is false) so the lot reads
      // not-flat, while the residual recomputes to NaN — the exact
      // store-numbers-disagree shape the guard refuses to hand the broker.
      const garbageStore = new (class extends TestExecutionStore {
        override async getFills(): Promise<Fill[]> {
          const base = {
            idempotency_key: LOT,
            price: 100,
            fee: 0,
            timestamp: new Date('2026-08-07T15:00:00Z'),
          };
          return [
            { ...base, broker_fill_id: 'e1', leg: 'entry', qty: Number.POSITIVE_INFINITY },
            { ...base, broker_fill_id: 'x1', leg: 'exit', qty: Number.POSITIVE_INFINITY },
          ];
        }
      })(db);
      const broker = new SweepBroker();
      const alerts = makeResidualExposureAlerts();
      const result = await new ExecutionImpl(
        makeInput(broker, garbageStore, alerts),
      ).sweepResidualProtection();

      expect(broker.rearmCalls).toEqual([]);
      expect(alerts.alerts).toHaveLength(1);
      expect(result.divergences.map((entry) => entry.action)).toEqual(['undetermined']);
      expect(
        (await garbageStore.getResidualProtectionMarker(LOT))?.unprotected_since,
      ).not.toBeNull();
    });

    it('contains a confirm-write failure after a successful re-arm — undetermined, no page, next pass re-verifies', async () => {
      const { db, store } = openTestExecutionStore();
      await seedPosition(store);
      await seedPartiallyFlattenedFills(store);
      await store.markResidualUnprotected(LOT, NOW);

      const confirmFailingStore = new (class extends TestExecutionStore {
        failConfirm = true;
        override async confirmResidualProtected(idempotency_key: string): Promise<void> {
          if (this.failConfirm) throw new Error('marker write refused');
          return super.confirmResidualProtected(idempotency_key);
        }
      })(db);
      const broker = new SweepBroker();
      const alerts = makeResidualExposureAlerts();
      const execution = new ExecutionImpl(makeInput(broker, confirmFailingStore, alerts));

      const first = await execution.sweepResidualProtection();

      // The re-arm itself succeeded — a bookkeeping failure is NOT a naked
      // residual, so nobody is paged; the outer containment reports it and
      // the marker survives for the next pass's idempotent re-verify.
      expect(broker.rearmCalls).toHaveLength(1);
      expect(alerts.alerts).toEqual([]);
      expect(first.divergences.map((entry) => entry.action)).toEqual(['undetermined']);
      expect(
        (await confirmFailingStore.getResidualProtectionMarker(LOT))?.unprotected_since,
      ).not.toBeNull();

      // The store heals: the next pass re-verifies (idempotent re-arm) and
      // finally clears the marker.
      confirmFailingStore.failConfirm = false;
      const second = await execution.sweepResidualProtection();
      expect(second.divergences.map((entry) => entry.action)).toEqual(['adopted']);
      expect(await confirmFailingStore.getResidualProtectionMarker(LOT)).toEqual({
        unprotected_since: null,
        alerted_at: null,
      });
    });

    it('contains an alert-dedup mark failure — the page went out, the pass survives, the next pass may re-page', async () => {
      const { db, store } = openTestExecutionStore();
      await seedPosition(store);
      await seedPartiallyFlattenedFills(store);
      await store.markResidualUnprotected(LOT, NOW);

      const markFailingStore = new (class extends TestExecutionStore {
        override async markResidualAlerted(): Promise<never> {
          throw new Error('dedup write refused');
        }
      })(db);
      const broker = new SweepBroker();
      broker.rearmFailure = new Error('venue still down');
      const alerts = makeResidualExposureAlerts();
      const execution = new ExecutionImpl(makeInput(broker, markFailingStore, alerts));

      const first = await execution.sweepResidualProtection();
      expect(alerts.alerts).toHaveLength(1);
      expect(first.divergences.map((entry) => entry.action)).toEqual(['undetermined']);
      // The dedup never persisted, so the next pass re-pages — noisy, not
      // unsafe, exactly the trade the catch documents.
      await execution.sweepResidualProtection();
      expect(alerts.alerts).toHaveLength(2);
    });
  });

  describe('the marker store methods (migration 0024)', () => {
    it('markResidualUnprotected keeps the FIRST observation and never resets the alert dedup', async () => {
      const { store } = openTestExecutionStore();
      await seedPosition(store);
      const first = new Date('2026-08-07T15:00:00Z');
      await store.markResidualUnprotected(LOT, first);
      await store.markResidualAlerted(LOT, NOW);
      await store.markResidualUnprotected(LOT, new Date('2026-08-07T15:45:00Z'));

      expect(await store.getResidualProtectionMarker(LOT)).toEqual({
        unprotected_since: first.toISOString(),
        alerted_at: NOW.toISOString(),
      });
      const [row] = await store.getUnprotectedResidualLots();
      expect(row?.unprotected_since).toEqual(first);
      expect(row?.alerted_at).toEqual(NOW);
      expect(row?.position.idempotency_key).toBe(LOT);
    });

    it('markResidualUnprotected refuses a key with no lot — a marker protecting nothing must not silently succeed', async () => {
      const { store } = openTestExecutionStore();
      await expect(store.markResidualUnprotected('no-such-lot', NOW)).rejects.toThrow(
        /no open_positions row/,
      );
    });

    it('markResidualAlerted is first-writer-wins: conditional on the episode being un-alerted, reporting who won (#549 review)', async () => {
      const { store } = openTestExecutionStore();
      await seedPosition(store);
      await store.markResidualUnprotected(LOT, NOW);

      const later = new Date('2026-08-07T17:00:00Z');
      await expect(store.markResidualAlerted(LOT, NOW)).resolves.toBe(true);
      // A second surface arriving later does NOT overwrite the record — the
      // dedup holds regardless of caller ordering.
      await expect(store.markResidualAlerted(LOT, later)).resolves.toBe(false);
      expect((await store.getResidualProtectionMarker(LOT))?.alerted_at).toBe(NOW.toISOString());
      // An unknown key is `false`, never a throw — the write is a claim, not
      // an assertion the lot exists.
      await expect(store.markResidualAlerted('no-such-lot', NOW)).resolves.toBe(false);

      // The claim re-opens with the episode: confirm clears both columns,
      // and a NEW episode's first writer wins again.
      await store.confirmResidualProtected(LOT);
      await store.markResidualUnprotected(LOT, later);
      await expect(store.markResidualAlerted(LOT, later)).resolves.toBe(true);
    });

    it('confirmResidualProtected clears both columns and is a no-op on an unmarked lot', async () => {
      const { store } = openTestExecutionStore();
      await seedPosition(store);
      await store.markResidualUnprotected(LOT, NOW);
      await store.markResidualAlerted(LOT, NOW);
      await store.confirmResidualProtected(LOT);
      expect(await store.getResidualProtectionMarker(LOT)).toEqual({
        unprotected_since: null,
        alerted_at: null,
      });
      // No throw on the already-clear (or unknown) key — the sweep and the
      // observing poll may race to clear.
      await expect(store.confirmResidualProtected(LOT)).resolves.toBeUndefined();
      await expect(store.confirmResidualProtected('no-such-lot')).resolves.toBeUndefined();
    });
  });
});
