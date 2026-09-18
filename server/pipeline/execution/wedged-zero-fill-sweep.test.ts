import type { Clock, Logger, OpenPosition } from '../../shared/index.js';
import { recordingLogger } from '../../shared/recording-logger.js';
import { openTestExecutionStore, type TestExecutionStore } from './sqlite-store-harness.js';
import type { WedgedSweepInput } from './types.js';
import {
  sweepWedgedZeroFillLots,
  WEDGED_ZERO_FILL_ABANDON_AFTER_MS,
} from './wedged-zero-fill-sweep.js';

const NOW = new Date('2026-09-09T12:00:00Z');
const KEY = 'key-meta-1';

async function seedWedgedPosition(
  store: TestExecutionStore,
  overrides: Partial<OpenPosition> = {},
): Promise<OpenPosition> {
  const position: OpenPosition = {
    idempotency_key: KEY,
    debate_id: 'debate-1',
    instrument: 'META',
    asset_class: 'stocks',
    side: 'buy',
    intent_type: 'entry',
    requested_size: 8,
    filled_size: 0,
    avg_entry_price: 0,
    stop: 0,
    target: 0,
    order_state: 'filled',
    broker_order_ids: [`${KEY}:entry`],
    opened_at: new Date(NOW.getTime() - WEDGED_ZERO_FILL_ABANDON_AFTER_MS - 1),
    decision_timestamp: new Date(NOW.getTime() - WEDGED_ZERO_FILL_ABANDON_AFTER_MS - 1),
    conviction: 0.7,
    converged: true,
    ...overrides,
  };
  await store.writeAheadPosition(position);
  return position;
}

function makeInput(
  store: WedgedSweepInput['store'],
  logger: Logger = recordingLogger(),
): WedgedSweepInput {
  const clock: Clock = { now: () => NOW };
  return { trace_id: 'trace-1186', clock, store, logger };
}

describe('sweepWedgedZeroFillLots (#1186)', () => {
  it('abandons a lot wedged past the bounded window, on store evidence alone', async () => {
    const { store } = openTestExecutionStore();
    await seedWedgedPosition(store);

    const result = await sweepWedgedZeroFillLots(makeInput(store));

    expect(result.checked).toBe(1);
    expect(result.divergences).toHaveLength(1);
    expect(result.divergences[0]).toMatchObject({
      idempotency_key: KEY,
      instrument: 'META',
      store_state: 'filled',
      broker_state: null,
      action: 'adopted',
      kind: 'sweep',
    });

    const settled = await store.getPosition(KEY);
    expect(settled?.order_state).toBe('abandoned');
    expect(settled?.abandon_reason).toBeDefined();
    expect(settled?.abandon_reason).toContain('#1186');

    expect(await store.getOpenPositions()).toEqual([]);
  });

  it('leaves a lot inside the bounded window untouched — propagation lag is not a wedge', async () => {
    const { store } = openTestExecutionStore();
    const position = await seedWedgedPosition(store, {
      opened_at: new Date(NOW.getTime() - WEDGED_ZERO_FILL_ABANDON_AFTER_MS + 1),
    });

    const result = await sweepWedgedZeroFillLots(makeInput(store));

    expect(result.checked).toBe(0);
    expect(result.divergences).toEqual([]);
    expect((await store.getPosition(KEY))?.order_state).toBe(position.order_state);
    expect(await store.getOpenPositions()).toHaveLength(1);
  });

  it('leaves a lot with a nonzero filled_size untouched, however long it has been open', async () => {
    const { store } = openTestExecutionStore();
    await seedWedgedPosition(store, { filled_size: 3, avg_entry_price: 400 });

    const result = await sweepWedgedZeroFillLots(makeInput(store));

    expect(result.checked).toBe(0);
    expect((await store.getPosition(KEY))?.order_state).toBe('filled');
  });

  it("leaves a pending/submitted lot untouched — that is reconcileLot's IN_FLIGHT_ORDER_STATES scope, not this sweep's", async () => {
    const { store } = openTestExecutionStore();
    await seedWedgedPosition(store, { order_state: 'submitted' });

    const result = await sweepWedgedZeroFillLots(makeInput(store));

    expect(result.checked).toBe(0);
    expect((await store.getPosition(KEY))?.order_state).toBe('submitted');
  });

  it('does not overwrite a lot that un-wedged itself between the worklist read and the write (race safety)', async () => {
    const { store } = openTestExecutionStore();
    await seedWedgedPosition(store);

    const abandoned = await store.abandonWedgedZeroFillLot(KEY, 'test-forced');
    expect(abandoned).toBe(true);
    const secondCall = await store.abandonWedgedZeroFillLot(KEY, 'test-forced-again');
    expect(secondCall).toBe(false);
    expect((await store.getPosition(KEY))?.abandon_reason).toBe('test-forced');
  });

  it('reports a shape-mismatch divergence, not a silent no-op, when the SQL guard misses a lot isWedgedZeroFillLot still matches (#1601)', async () => {
    const { store } = openTestExecutionStore();
    await seedWedgedPosition(store);

    const divergedStore: WedgedSweepInput['store'] = {
      getOpenPositions: () => store.getOpenPositions(),
      getExitFillSizes: (keys) => store.getExitFillSizes(keys),
      sweepTerminalPositions: (cutoff) => store.sweepTerminalPositions(cutoff),
      abandonWedgedZeroFillLot: async () => false,
    };

    const result = await sweepWedgedZeroFillLots(makeInput(divergedStore));

    expect(result.checked).toBe(1);
    expect(result.divergences).toHaveLength(1);
    expect(result.divergences[0]).toMatchObject({
      idempotency_key: KEY,
      instrument: 'META',
      store_state: 'filled',
      broker_state: null,
      action: 'undetermined',
      kind: 'sweep',
      escalation: 'sweep_shape_mismatch',
    });
    expect(result.divergences[0]?.reason).toContain('shape mismatch');

    expect((await store.getPosition(KEY))?.order_state).toBe('filled');
  });

  it('reports an abandon-failed divergence with its own escalation, distinct from the shape-mismatch one (#1609)', async () => {
    const { store } = openTestExecutionStore();
    await seedWedgedPosition(store);

    const failingStore: WedgedSweepInput['store'] = {
      getOpenPositions: () => store.getOpenPositions(),
      getExitFillSizes: (keys) => store.getExitFillSizes(keys),
      sweepTerminalPositions: (cutoff) => store.sweepTerminalPositions(cutoff),
      abandonWedgedZeroFillLot: async () => {
        throw new Error('store write failed');
      },
    };

    const result = await sweepWedgedZeroFillLots(makeInput(failingStore));

    expect(result.checked).toBe(1);
    expect(result.divergences).toHaveLength(1);
    expect(result.divergences[0]).toMatchObject({
      idempotency_key: KEY,
      instrument: 'META',
      store_state: 'filled',
      broker_state: null,
      action: 'undetermined',
      kind: 'sweep',
      escalation: 'sweep_abandon_failed',
    });
    expect(result.divergences[0]?.reason).toContain('abandon failed');
  });

  it('treats a no-op abandon as the benign race when a fresh read no longer matches isWedgedZeroFillLot', async () => {
    const { store } = openTestExecutionStore();
    const position = await seedWedgedPosition(store);
    const unwedged: OpenPosition = { ...position, filled_size: 3 };

    let reads = 0;
    const divergedStore: WedgedSweepInput['store'] = {
      getOpenPositions: async () => {
        reads += 1;
        return [reads === 1 ? position : unwedged];
      },
      getExitFillSizes: (keys) => store.getExitFillSizes(keys),
      sweepTerminalPositions: (cutoff) => store.sweepTerminalPositions(cutoff),
      abandonWedgedZeroFillLot: async () => false,
    };

    const result = await sweepWedgedZeroFillLots(makeInput(divergedStore));

    expect(result.checked).toBe(1);
    expect(result.divergences).toEqual([]);
  });
});
