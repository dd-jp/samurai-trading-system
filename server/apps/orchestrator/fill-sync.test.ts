import type { ReconcileReport } from '../../pipeline/execution/index.js';
import { type FillSyncSurface, runStartupReconcile, startFillSync } from './fill-sync.js';
import type { LogEntry, Logger } from './types.js';

function makeLogger(): Logger & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { entries, log: (entry: LogEntry) => entries.push(entry) };
}

function makeReport(overrides: Partial<ReconcileReport> = {}): ReconcileReport {
  return {
    checked: 0,
    corrected: 0,
    divergences: [],
    swept: 0,
    timestamp: new Date('2026-08-03T12:00:00Z'),
    ...overrides,
  };
}

function makeExecution(overrides: Partial<FillSyncSurface> = {}): FillSyncSurface {
  return {
    reconcile: vi.fn().mockResolvedValue(makeReport()),
    ingestFills: vi.fn().mockResolvedValue(undefined),
    sweepResidualProtection: vi.fn().mockResolvedValue({ checked: 0, divergences: [] }),
    ...overrides,
  };
}

describe('runStartupReconcile', () => {
  it('logs each divergence, warning only on the ones a human must settle', async () => {
    const logger = makeLogger();
    const execution = makeExecution({
      reconcile: vi.fn().mockResolvedValue(
        makeReport({
          checked: 2,
          corrected: 1,
          divergences: [
            {
              idempotency_key: 'key-aapl-1355',
              instrument: 'AAPL',
              store_state: 'submitted',
              broker_state: null,
              action: 'rejected',
              kind: 'bracket',
              reason: 'broker has no order under this client_order_id',
            },
            {
              idempotency_key: 'key-tsla-1400',
              instrument: 'TSLA',
              store_state: 'pending',
              broker_state: null,
              action: 'undetermined',
              kind: 'bracket',
              reason: 'venue unreachable',
            },
          ],
        }),
      ),
    });

    await runStartupReconcile({ execution, logger, traceId: 'test-reconcile' });

    const divergences = logger.entries.filter((e) => e.message === 'reconcile divergence');
    expect(divergences.map((e) => e.level)).toEqual(['info', 'warn']);
    expect(divergences[1]?.payload).toMatchObject({ action: 'undetermined' });
  });

  it('propagates a reconcile failure instead of swallowing it', async () => {
    const execution = makeExecution({
      reconcile: vi.fn().mockRejectedValue(new Error('store unreadable')),
    });

    await expect(
      runStartupReconcile({ execution, logger: makeLogger(), traceId: 'test-reconcile' }),
    ).rejects.toThrow('store unreadable');
  });

  it('logs the terminal-row sweep count when it deleted rows, and not otherwise', async () => {
    const logger = makeLogger();
    const execution = makeExecution({
      reconcile: vi.fn().mockResolvedValue(makeReport({ swept: 3 })),
    });

    await runStartupReconcile({ execution, logger, traceId: 'test-reconcile' });

    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        message: 'reconcile: terminal-row sweep',
        level: 'info',
        payload: { swept: 3 },
      }),
    );
  });

  it('does not log a terminal-row sweep line when nothing was swept', async () => {
    const logger = makeLogger();
    const execution = makeExecution({
      reconcile: vi.fn().mockResolvedValue(makeReport({ swept: 0 })),
    });

    await runStartupReconcile({ execution, logger, traceId: 'test-reconcile' });

    expect(logger.entries).not.toContainEqual(
      expect.objectContaining({ message: 'reconcile: terminal-row sweep' }),
    );
  });
});

describe('startFillSync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls ingestFills once per interval, and not before the first one elapses', async () => {
    const execution = makeExecution();
    const sync = startFillSync({
      execution,
      clock: { now: () => new Date() },
      logger: makeLogger(),
      fillPollIntervalMs: 1_000,
      reconcileTraceId: 'test-reconcile',
      fillSyncTraceId: 'test-fill-sync',
    });

    expect(execution.ingestFills).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(execution.ingestFills).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(execution.ingestFills).toHaveBeenCalledTimes(2);

    await sync.stop();
  });

  it('never overlaps two polls when one runs longer than the interval', async () => {
    let active = 0;
    let maxActive = 0;
    const execution = makeExecution({
      ingestFills: vi.fn().mockImplementation(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        active -= 1;
      }),
    });
    const sync = startFillSync({
      execution,
      clock: { now: () => new Date() },
      logger: makeLogger(),
      fillPollIntervalMs: 1_000,
      reconcileTraceId: 'test-reconcile',
      fillSyncTraceId: 'test-fill-sync',
    });

    await vi.advanceTimersByTimeAsync(20_000);

    expect(maxActive).toBe(1);
    expect(execution.ingestFills).toHaveBeenCalledTimes(4);

    const stopping = sync.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    await stopping;
  });

  it('survives a failing poll and keeps polling', async () => {
    const logger = makeLogger();
    const execution = makeExecution({
      ingestFills: vi
        .fn()
        .mockRejectedValueOnce(new Error('venue unreachable'))
        .mockResolvedValue(undefined),
    });
    const sync = startFillSync({
      execution,
      clock: { now: () => new Date() },
      logger,
      fillPollIntervalMs: 1_000,
      reconcileTraceId: 'test-reconcile',
      fillSyncTraceId: 'test-fill-sync',
    });

    await vi.advanceTimersByTimeAsync(2_000);

    expect(logger.entries).toContainEqual(
      expect.objectContaining({ message: 'fill poll failed', level: 'error' }),
    );
    expect(execution.ingestFills).toHaveBeenCalledTimes(2);

    await sync.stop();
  });

  it('stop() awaits the in-flight poll rather than abandoning it mid-write', async () => {
    let finished = false;
    const execution = makeExecution({
      ingestFills: vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        finished = true;
      }),
    });
    const sync = startFillSync({
      execution,
      clock: { now: () => new Date() },
      logger: makeLogger(),
      fillPollIntervalMs: 1_000,
      reconcileTraceId: 'test-reconcile',
      fillSyncTraceId: 'test-fill-sync',
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(finished).toBe(false);

    const stopping = sync.stop();
    await vi.advanceTimersByTimeAsync(3_000);
    await stopping;

    expect(finished).toBe(true);
  });

  describe('the residual-protection sweep leg (#549)', () => {
    it('still runs the sweep when ingestFills rejects, and the logged poll failure is the INGEST error', async () => {
      const logger = makeLogger();
      const execution = makeExecution({
        ingestFills: vi.fn().mockRejectedValue(new Error('venue unreachable')),
      });
      const sync = startFillSync({
        execution,
        clock: { now: () => new Date() },
        logger,
        fillPollIntervalMs: 1_000,
        reconcileTraceId: 'test-reconcile',
        fillSyncTraceId: 'test-fill-sync',
      });

      await vi.advanceTimersByTimeAsync(1_000);

      expect(execution.sweepResidualProtection).toHaveBeenCalledTimes(1);
      expect(logger.entries).toContainEqual(
        expect.objectContaining({
          message: 'fill poll failed',
          level: 'error',
          payload: { error: 'venue unreachable' },
        }),
      );

      await sync.stop();
    });

    it("contains a sweep throw to its own log line — it cannot mask the poll's error or end the run", async () => {
      const logger = makeLogger();
      const execution = makeExecution({
        ingestFills: vi.fn().mockRejectedValue(new Error('venue unreachable')),
        sweepResidualProtection: vi.fn().mockRejectedValue(new Error('marker store down')),
      });
      const sync = startFillSync({
        execution,
        clock: { now: () => new Date() },
        logger,
        fillPollIntervalMs: 1_000,
        reconcileTraceId: 'test-reconcile',
        fillSyncTraceId: 'test-fill-sync',
      });

      await vi.advanceTimersByTimeAsync(2_000);

      expect(logger.entries).toContainEqual(
        expect.objectContaining({
          message: 'residual-protection sweep failed',
          level: 'error',
          payload: { error: 'marker store down' },
        }),
      );
      expect(logger.entries).toContainEqual(
        expect.objectContaining({
          message: 'fill poll failed',
          level: 'error',
          payload: { error: 'venue unreachable' },
        }),
      );
      expect(execution.ingestFills).toHaveBeenCalledTimes(2);

      await sync.stop();
    });

    it('logs a sweep divergence on first observation and on state transitions, not on every pass (#342)', async () => {
      const logger = makeLogger();
      const undetermined = {
        idempotency_key: 'lot-1',
        instrument: 'AAPL',
        store_state: 'partially_filled',
        broker_state: null,
        action: 'undetermined',
        reason: 're-arm retry failed',
      };
      const adopted = { ...undetermined, action: 'adopted', reason: 're-armed' };
      const execution = makeExecution({
        sweepResidualProtection: vi
          .fn()
          .mockResolvedValueOnce({ checked: 1, divergences: [undetermined] })
          .mockResolvedValueOnce({ checked: 1, divergences: [undetermined] })
          .mockResolvedValueOnce({ checked: 1, divergences: [adopted] })
          .mockResolvedValue({ checked: 0, divergences: [] }),
      });
      const sync = startFillSync({
        execution,
        clock: { now: () => new Date() },
        logger,
        fillPollIntervalMs: 1_000,
        reconcileTraceId: 'test-reconcile',
        fillSyncTraceId: 'test-fill-sync',
      });

      await vi.advanceTimersByTimeAsync(4_000);

      const divergenceLines = logger.entries.filter(
        (entry) => entry.message === 'residual-protection sweep divergence',
      );
      expect(divergenceLines.map((entry) => entry.level)).toEqual(['warn', 'info']);
      expect(divergenceLines[0]?.payload).toMatchObject({ action: 'undetermined' });
      expect(divergenceLines[1]?.payload).toMatchObject({ action: 'adopted' });

      await sync.stop();
    });

    it('logs two different residual-sweep escalations on the same lot as distinct episodes, not deduped as one', async () => {
      const logger = makeLogger();
      const base = {
        idempotency_key: 'key-nvda-9001',
        instrument: 'NVDA',
        store_state: 'partially_filled' as const,
        broker_state: null,
        action: 'undetermined' as const,
        kind: 'sweep' as const,
      };
      const garbageResidual = {
        ...base,
        reason: 'marked residual recomputes to -1 (non-finite or non-positive)',
        escalation: 'residual_sweep_garbage_residual' as const,
      };
      const rearmUnsupported = {
        ...base,
        reason: 'this lot can never be re-armed and the residual could not be closed either',
        escalation: 'residual_sweep_rearm_unsupported' as const,
      };
      const execution = makeExecution({
        sweepResidualProtection: vi
          .fn()
          .mockResolvedValueOnce({ checked: 1, divergences: [garbageResidual] })
          .mockResolvedValueOnce({ checked: 1, divergences: [rearmUnsupported] })
          .mockResolvedValue({ checked: 0, divergences: [] }),
      });
      const sync = startFillSync({
        execution,
        clock: { now: () => new Date() },
        logger,
        fillPollIntervalMs: 1_000,
        reconcileTraceId: 'test-reconcile',
        fillSyncTraceId: 'test-fill-sync',
      });

      await vi.advanceTimersByTimeAsync(2_000);

      const divergenceLines = logger.entries.filter(
        (entry) => entry.message === 'residual-protection sweep divergence',
      );
      expect(
        divergenceLines.map((entry) => (entry.payload as { escalation?: string }).escalation),
      ).toEqual(['residual_sweep_garbage_residual', 'residual_sweep_rearm_unsupported']);

      await sync.stop();
    });
  });

  describe('the periodic reconcile leg (#921)', () => {
    it("calls reconcile() on every poll, before that poll's ingestFills()", async () => {
      const callSequence: string[] = [];
      const execution = makeExecution({
        reconcile: vi.fn().mockImplementation(async () => {
          callSequence.push('reconcile');
          return makeReport();
        }),
        ingestFills: vi.fn().mockImplementation(async () => {
          callSequence.push('ingestFills');
        }),
      });
      const sync = startFillSync({
        execution,
        clock: { now: () => new Date() },
        logger: makeLogger(),
        fillPollIntervalMs: 1_000,
        reconcileTraceId: 'test-reconcile',
        fillSyncTraceId: 'test-fill-sync',
      });

      await vi.advanceTimersByTimeAsync(2_000);

      expect(execution.reconcile).toHaveBeenCalledTimes(2);
      expect(callSequence).toEqual(['reconcile', 'ingestFills', 'reconcile', 'ingestFills']);

      await sync.stop();
    });

    it("a reconcile() failure is caught on its own and does not prevent that same pass's ingestFills() from running", async () => {
      const logger = makeLogger();
      const execution = makeExecution({
        reconcile: vi.fn().mockRejectedValue(new Error('venue unreachable during reconcile')),
      });
      const sync = startFillSync({
        execution,
        clock: { now: () => new Date() },
        logger,
        fillPollIntervalMs: 1_000,
        reconcileTraceId: 'test-reconcile',
        fillSyncTraceId: 'test-fill-sync',
      });

      await vi.advanceTimersByTimeAsync(1_000);

      expect(execution.ingestFills).toHaveBeenCalledTimes(1);
      expect(logger.entries).toContainEqual(
        expect.objectContaining({
          message: 'periodic reconcile failed',
          level: 'error',
          payload: { error: 'venue unreachable during reconcile' },
        }),
      );
      expect(logger.entries).not.toContainEqual(
        expect.objectContaining({ message: 'fill poll failed' }),
      );

      await sync.stop();
    });

    it('an unrenderable reconcile() failure still runs ingestFills and the residual-protection sweep', async () => {
      const logger = makeLogger();
      const hostile: Record<string, unknown> = {
        [Symbol.toPrimitive]: () => {
          throw new Error('render boom');
        },
      };
      hostile.self = hostile;
      const execution = makeExecution({
        reconcile: vi.fn().mockRejectedValue(hostile),
      });
      const sync = startFillSync({
        execution,
        clock: { now: () => new Date() },
        logger,
        fillPollIntervalMs: 1_000,
        reconcileTraceId: 'test-reconcile',
        fillSyncTraceId: 'test-fill-sync',
      });

      await vi.advanceTimersByTimeAsync(1_000);

      expect(execution.ingestFills).toHaveBeenCalledTimes(1);
      expect(execution.sweepResidualProtection).toHaveBeenCalledTimes(1);
      expect(logger.entries).toContainEqual(
        expect.objectContaining({
          message: 'periodic reconcile failed',
          level: 'error',
          payload: { error: '[unrenderable error]' },
        }),
      );

      await sync.stop();
    });

    it('logs a reconcile divergence on first observation and on state transitions, not on every pass, mirroring the #549 sweep dedup', async () => {
      const logger = makeLogger();
      const undetermined = {
        idempotency_key: 'key-tsla-1400',
        instrument: 'TSLA',
        store_state: 'submitted' as const,
        broker_state: null,
        action: 'undetermined' as const,
        kind: 'bracket' as const,
        reason: 'venue unreachable',
      };
      const adopted = {
        ...undetermined,
        broker_state: 'filled' as const,
        action: 'adopted' as const,
        reason: 'adopted on retry',
      };
      const execution = makeExecution({
        reconcile: vi
          .fn()
          .mockResolvedValueOnce(makeReport({ divergences: [undetermined] }))
          .mockResolvedValueOnce(makeReport({ divergences: [undetermined] }))
          .mockResolvedValueOnce(makeReport({ divergences: [adopted] }))
          .mockResolvedValue(makeReport()),
      });
      const sync = startFillSync({
        execution,
        clock: { now: () => new Date() },
        logger,
        fillPollIntervalMs: 1_000,
        reconcileTraceId: 'test-reconcile',
        fillSyncTraceId: 'test-fill-sync',
      });

      await vi.advanceTimersByTimeAsync(4_000);

      const divergenceLines = logger.entries.filter(
        (entry) => entry.message === 'reconcile divergence',
      );
      expect(divergenceLines.map((entry) => entry.level)).toEqual(['warn', 'debug']);
      expect(divergenceLines[0]?.payload).toMatchObject({ action: 'undetermined' });
      expect(divergenceLines[1]?.payload).toMatchObject({ action: 'adopted' });

      await sync.stop();
    });

    it('logs the wedged-flatten cancel escalation even though it shares action: adopted with the benign adopt already logged for the episode', async () => {
      const logger = makeLogger();
      const benignAdopted = {
        idempotency_key: 'key-nvda-flatten',
        instrument: 'NVDA',
        store_state: 'submitted' as const,
        broker_state: 'submitted' as const,
        action: 'adopted' as const,
        kind: 'flatten' as const,
        reason: "flatten journal said 'submitted'; broker reports 'submitted'",
      };
      const escalatedAdopted = {
        ...benignAdopted,
        reason:
          "flatten journal said 'submitted'; broker reports 'submitted'; the venue still " +
          'reports this flatten after 300s — past the bound, so it is being CANCELLED',
        escalation: 'wedge_cancelled' as const,
      };
      const execution = makeExecution({
        reconcile: vi
          .fn()
          .mockResolvedValueOnce(makeReport({ divergences: [benignAdopted] }))
          .mockResolvedValueOnce(makeReport({ divergences: [escalatedAdopted] }))
          .mockResolvedValue(makeReport()),
      });
      const sync = startFillSync({
        execution,
        clock: { now: () => new Date() },
        logger,
        fillPollIntervalMs: 1_000,
        reconcileTraceId: 'test-reconcile',
        fillSyncTraceId: 'test-fill-sync',
      });

      await vi.advanceTimersByTimeAsync(2_000);

      const divergenceLines = logger.entries.filter(
        (entry) => entry.message === 'reconcile divergence',
      );
      expect(divergenceLines).toHaveLength(2);
      const firstPayload = divergenceLines[0]?.payload as { action: string; escalation?: string };
      expect(firstPayload).toMatchObject({ action: 'adopted' });
      expect(firstPayload.escalation).toBeUndefined();
      expect(divergenceLines[1]?.payload).toMatchObject({
        action: 'adopted',
        escalation: 'wedge_cancelled',
      });

      await sync.stop();
    });

    it("logs a never-confirmed-flatten escalation even though it shares action: undetermined with the row's own prior state", async () => {
      const logger = makeLogger();
      const priorUndetermined = {
        idempotency_key: 'key-tsla-flatten',
        instrument: 'TSLA',
        store_state: 'submitted' as const,
        broker_state: null,
        action: 'undetermined' as const,
        kind: 'flatten' as const,
        reason: 'the venue could not describe this flatten (resumeFlatten: venue unreachable)',
      };
      const coverageShort = {
        ...priorUndetermined,
        reason:
          `${priorUndetermined.reason}. It was CANCELLED at the venue, but the venue holds ` +
          'less than the store does, so the row keeps blocking',
        escalation: 'never_confirmed_coverage_short' as const,
      };
      const execution = makeExecution({
        reconcile: vi
          .fn()
          .mockResolvedValueOnce(makeReport({ divergences: [priorUndetermined] }))
          .mockResolvedValueOnce(makeReport({ divergences: [coverageShort] }))
          .mockResolvedValue(makeReport()),
      });
      const sync = startFillSync({
        execution,
        clock: { now: () => new Date() },
        logger,
        fillPollIntervalMs: 1_000,
        reconcileTraceId: 'test-reconcile',
        fillSyncTraceId: 'test-fill-sync',
      });

      await vi.advanceTimersByTimeAsync(2_000);

      const divergenceLines = logger.entries.filter(
        (entry) => entry.message === 'reconcile divergence',
      );
      expect(divergenceLines).toHaveLength(2);
      const firstPayload = divergenceLines[0]?.payload as { action: string; escalation?: string };
      expect(firstPayload).toMatchObject({ action: 'undetermined' });
      expect(firstPayload.escalation).toBeUndefined();
      expect(divergenceLines[1]?.payload).toMatchObject({
        action: 'undetermined',
        escalation: 'never_confirmed_coverage_short',
      });

      await sync.stop();
    });

    it('logs two different never-confirmed-flatten escalations on the same row as distinct episodes', async () => {
      const logger = makeLogger();
      const base = {
        idempotency_key: 'key-tsla-flatten',
        instrument: 'TSLA',
        store_state: 'submitted' as const,
        broker_state: null,
        action: 'undetermined' as const,
        kind: 'flatten' as const,
      };
      const cancelFailed = {
        ...base,
        reason: 'the cancel FAILED (venue refused); the row keeps blocking',
        escalation: 'never_confirmed_cancel_failed' as const,
      };
      const coverageShort = {
        ...base,
        reason: 'it was CANCELLED at the venue, but the venue holds less than the store does',
        escalation: 'never_confirmed_coverage_short' as const,
      };
      const execution = makeExecution({
        reconcile: vi
          .fn()
          .mockResolvedValueOnce(makeReport({ divergences: [cancelFailed] }))
          .mockResolvedValueOnce(makeReport({ divergences: [coverageShort] }))
          .mockResolvedValue(makeReport()),
      });
      const sync = startFillSync({
        execution,
        clock: { now: () => new Date() },
        logger,
        fillPollIntervalMs: 1_000,
        reconcileTraceId: 'test-reconcile',
        fillSyncTraceId: 'test-fill-sync',
      });

      await vi.advanceTimersByTimeAsync(2_000);

      const divergenceLines = logger.entries.filter(
        (entry) => entry.message === 'reconcile divergence',
      );
      expect(
        divergenceLines.map((entry) => (entry.payload as { escalation?: string }).escalation),
      ).toEqual(['never_confirmed_cancel_failed', 'never_confirmed_coverage_short']);

      await sync.stop();
    });

    it('logs two different wedged-zero-fill sweep escalations on the same lot as distinct episodes', async () => {
      const logger = makeLogger();
      const base = {
        idempotency_key: 'key-meta-1',
        instrument: 'META',
        store_state: 'filled' as const,
        broker_state: null,
        action: 'undetermined' as const,
        kind: 'sweep' as const,
      };
      const shapeMismatch = {
        ...base,
        reason: 'wedged-zero-fill shape mismatch: isWedgedZeroFillLot still matches',
        escalation: 'sweep_shape_mismatch' as const,
      };
      const abandonFailed = {
        ...base,
        reason: 'wedged-zero-fill abandon failed: store write failed',
        escalation: 'sweep_abandon_failed' as const,
      };
      const execution = makeExecution({
        reconcile: vi
          .fn()
          .mockResolvedValueOnce(makeReport({ divergences: [shapeMismatch] }))
          .mockResolvedValueOnce(makeReport({ divergences: [abandonFailed] }))
          .mockResolvedValue(makeReport()),
      });
      const sync = startFillSync({
        execution,
        clock: { now: () => new Date() },
        logger,
        fillPollIntervalMs: 1_000,
        reconcileTraceId: 'test-reconcile',
        fillSyncTraceId: 'test-fill-sync',
      });

      await vi.advanceTimersByTimeAsync(2_000);

      const divergenceLines = logger.entries.filter(
        (entry) => entry.message === 'reconcile divergence',
      );
      expect(
        divergenceLines.map((entry) => (entry.payload as { escalation?: string }).escalation),
      ).toEqual(['sweep_shape_mismatch', 'sweep_abandon_failed']);

      await sync.stop();
    });

    it('does not demote an adopted divergence the zero-size throttle cannot back — a flatten row, or a bracket adopt not yet filled (#1122)', async () => {
      const logger = makeLogger();
      const flattenAdopted = {
        idempotency_key: 'key-nvda-flatten',
        instrument: 'NVDA',
        store_state: 'submitted' as const,
        broker_state: 'filled' as const,
        action: 'adopted' as const,
        kind: 'flatten' as const,
        reason: "flatten journal said 'submitted'; broker reports 'filled'",
      };
      const bracketSubmittedOnly = {
        idempotency_key: 'key-msft-1200',
        instrument: 'MSFT',
        store_state: 'pending' as const,
        broker_state: 'submitted' as const,
        action: 'adopted' as const,
        kind: 'bracket' as const,
        reason: "store said 'pending', broker says 'submitted'",
      };
      const execution = makeExecution({
        reconcile: vi
          .fn()
          .mockResolvedValueOnce(
            makeReport({ divergences: [flattenAdopted, bracketSubmittedOnly] }),
          )
          .mockResolvedValue(makeReport()),
      });
      const sync = startFillSync({
        execution,
        clock: { now: () => new Date() },
        logger,
        fillPollIntervalMs: 1_000,
        reconcileTraceId: 'test-reconcile',
        fillSyncTraceId: 'test-fill-sync',
      });

      await vi.advanceTimersByTimeAsync(1_000);

      const divergenceLines = logger.entries.filter(
        (entry) => entry.message === 'reconcile divergence',
      );
      expect(divergenceLines.map((entry) => entry.level)).toEqual(['info', 'info']);

      await sync.stop();
    });

    it("demotes a bracket adopt whose broker_state is 'partially_filled' to debug — the throttle still watches it", async () => {
      const logger = makeLogger();
      const partiallyFilledAdopted = {
        idempotency_key: 'key-amd-900',
        instrument: 'AMD',
        store_state: 'submitted' as const,
        broker_state: 'partially_filled' as const,
        action: 'adopted' as const,
        kind: 'bracket' as const,
        reason: "store said 'submitted', broker says 'partially_filled'",
      };
      const execution = makeExecution({
        reconcile: vi
          .fn()
          .mockResolvedValueOnce(makeReport({ divergences: [partiallyFilledAdopted] }))
          .mockResolvedValue(makeReport()),
      });
      const sync = startFillSync({
        execution,
        clock: { now: () => new Date() },
        logger,
        fillPollIntervalMs: 1_000,
        reconcileTraceId: 'test-reconcile',
        fillSyncTraceId: 'test-fill-sync',
      });

      await vi.advanceTimersByTimeAsync(1_000);

      const divergenceLines = logger.entries.filter(
        (entry) => entry.message === 'reconcile divergence',
      );
      expect(divergenceLines.map((entry) => entry.level)).toEqual(['debug']);

      await sync.stop();
    });

    it("does not collapse two different unrecorded-venue-position divergences (both idempotency_key: '') onto one dedup slot", async () => {
      const logger = makeLogger();
      const unrecordedAapl = {
        idempotency_key: '',
        instrument: 'AAPL',
        store_state: 'submitted' as const,
        broker_state: null,
        action: 'unrecorded' as const,
        kind: 'unrecorded' as const,
        reason: 'venue holds a position the store has no open lot for',
      };
      const unrecordedTsla = { ...unrecordedAapl, instrument: 'TSLA' };
      const execution = makeExecution({
        reconcile: vi
          .fn()
          .mockResolvedValueOnce(makeReport({ divergences: [unrecordedAapl] }))
          .mockResolvedValueOnce(makeReport({ divergences: [unrecordedAapl, unrecordedTsla] })),
      });
      const sync = startFillSync({
        execution,
        clock: { now: () => new Date() },
        logger,
        fillPollIntervalMs: 1_000,
        reconcileTraceId: 'test-reconcile',
        fillSyncTraceId: 'test-fill-sync',
      });

      await vi.advanceTimersByTimeAsync(2_000);

      const divergenceLines = logger.entries.filter(
        (entry) => entry.message === 'reconcile divergence',
      );
      expect(divergenceLines).toHaveLength(2);
      expect(
        divergenceLines.map((entry) => (entry.payload as { instrument: string }).instrument),
      ).toEqual(['AAPL', 'TSLA']);

      await sync.stop();
    });

    it('warns on an unrecorded venue position, and leaves a rejected divergence at info', async () => {
      const logger = makeLogger();
      const unrecorded = {
        idempotency_key: '',
        instrument: 'AAPL',
        store_state: 'pending' as const,
        broker_state: null,
        action: 'unrecorded' as const,
        kind: 'unrecorded' as const,
        reason: 'venue holds 4 AAPL (buy) with no open lot in the store',
      };
      const rejected = {
        idempotency_key: 'key-tsla-1',
        instrument: 'TSLA',
        store_state: 'pending' as const,
        broker_state: null,
        action: 'rejected' as const,
        kind: 'bracket' as const,
        reason: 'venue has no such order',
      };
      const execution = makeExecution({
        reconcile: vi
          .fn()
          .mockResolvedValueOnce(makeReport({ divergences: [unrecorded, rejected] }))
          .mockResolvedValue(makeReport()),
      });
      const sync = startFillSync({
        execution,
        clock: { now: () => new Date() },
        logger,
        fillPollIntervalMs: 1_000,
        reconcileTraceId: 'test-reconcile',
        fillSyncTraceId: 'test-fill-sync',
      });

      await vi.advanceTimersByTimeAsync(1_000);

      const divergenceLines = logger.entries.filter(
        (entry) => entry.message === 'reconcile divergence',
      );
      expect(divergenceLines.map((entry) => entry.level)).toEqual(['warn', 'info']);

      await sync.stop();
    });

    it('logs the terminal-row sweep count on a poll that deleted rows, and not on one that did not', async () => {
      const logger = makeLogger();
      const execution = makeExecution({
        reconcile: vi
          .fn()
          .mockResolvedValueOnce(makeReport({ swept: 2 }))
          .mockResolvedValueOnce(makeReport({ swept: 0 })),
      });
      const sync = startFillSync({
        execution,
        clock: { now: () => new Date() },
        logger,
        fillPollIntervalMs: 1_000,
        reconcileTraceId: 'test-reconcile',
        fillSyncTraceId: 'test-fill-sync',
      });

      await vi.advanceTimersByTimeAsync(2_000);

      const sweepLines = logger.entries.filter(
        (entry) => entry.message === 'reconcile: terminal-row sweep',
      );
      expect(sweepLines).toHaveLength(1);
      expect(sweepLines[0]?.payload).toEqual({ swept: 2 });

      await sync.stop();
    });
  });

  it('stops polling after stop()', async () => {
    const execution = makeExecution();
    const sync = startFillSync({
      execution,
      clock: { now: () => new Date() },
      logger: makeLogger(),
      fillPollIntervalMs: 1_000,
      reconcileTraceId: 'test-reconcile',
      fillSyncTraceId: 'test-fill-sync',
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await sync.stop();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(execution.ingestFills).toHaveBeenCalledTimes(1);
  });
});

describe('per-arm trace ids (#1321)', () => {
  it('runStartupReconcile stamps the caller-supplied traceId, not a shared default', async () => {
    const logger = makeLogger();
    const divergingExecution = (): FillSyncSurface =>
      makeExecution({
        reconcile: vi.fn().mockResolvedValue(
          makeReport({
            divergences: [
              {
                idempotency_key: 'key-1',
                instrument: 'AAPL',
                store_state: 'submitted',
                broker_state: null,
                action: 'undetermined',
                kind: 'bracket',
                reason: 'venue unreachable',
              },
            ],
          }),
        ),
      });

    await runStartupReconcile({
      execution: divergingExecution(),
      logger,
      traceId: 'live-arm-reconcile',
    });
    await runStartupReconcile({
      execution: divergingExecution(),
      logger,
      traceId: 'control-arm-reconcile',
    });

    const divergenceTraceIds = logger.entries
      .filter((e) => e.message === 'reconcile divergence')
      .map((e) => e.trace_id);
    expect(divergenceTraceIds).toEqual(['live-arm-reconcile', 'control-arm-reconcile']);
    expect(divergenceTraceIds[0]).not.toEqual(divergenceTraceIds[1]);
  });

  it('two startFillSync loops sharing one logger stamp their own reconcile and fill-sync trace ids', async () => {
    vi.useFakeTimers();
    try {
      const logger = makeLogger();
      const undetermined = {
        idempotency_key: 'key-live',
        instrument: 'AAPL',
        store_state: 'submitted' as const,
        broker_state: null,
        action: 'undetermined' as const,
        kind: 'bracket' as const,
        reason: 'venue unreachable',
      };
      const liveExecution = makeExecution({
        reconcile: vi.fn().mockResolvedValue(makeReport({ divergences: [undetermined] })),
        ingestFills: vi.fn().mockRejectedValue(new Error('live poll broke')),
      });
      const controlExecution = makeExecution({
        reconcile: vi
          .fn()
          .mockResolvedValue(
            makeReport({ divergences: [{ ...undetermined, idempotency_key: 'key-control' }] }),
          ),
        ingestFills: vi.fn().mockRejectedValue(new Error('control poll broke')),
      });

      const live = startFillSync({
        execution: liveExecution,
        clock: { now: () => new Date() },
        logger,
        fillPollIntervalMs: 1_000,
        reconcileTraceId: 'live-arm-reconcile',
        fillSyncTraceId: 'live-arm-fill-sync',
      });
      const control = startFillSync({
        execution: controlExecution,
        clock: { now: () => new Date() },
        logger,
        fillPollIntervalMs: 1_000,
        reconcileTraceId: 'control-arm-reconcile',
        fillSyncTraceId: 'control-arm-fill-sync',
      });

      await vi.advanceTimersByTimeAsync(1_000);
      await live.stop();
      await control.stop();

      const divergenceEntries = logger.entries.filter((e) => e.message === 'reconcile divergence');
      const failedPollEntries = logger.entries.filter((e) => e.message === 'fill poll failed');

      expect(divergenceEntries).toHaveLength(2);
      expect(divergenceEntries.map((e) => e.trace_id).sort()).toEqual([
        'control-arm-reconcile',
        'live-arm-reconcile',
      ]);

      expect(failedPollEntries).toHaveLength(2);
      expect(failedPollEntries.map((e) => e.trace_id).sort()).toEqual([
        'control-arm-fill-sync',
        'live-arm-fill-sync',
      ]);

      const liveEntries = logger.entries.filter(
        (e) => e.trace_id === 'live-arm-reconcile' || e.trace_id === 'live-arm-fill-sync',
      );
      const controlEntries = logger.entries.filter(
        (e) => e.trace_id === 'control-arm-reconcile' || e.trace_id === 'control-arm-fill-sync',
      );
      expect(liveEntries.length).toBeGreaterThan(0);
      expect(controlEntries.length).toBeGreaterThan(0);
      expect(
        logger.entries.every(
          (e) =>
            e.trace_id === 'live-arm-reconcile' ||
            e.trace_id === 'live-arm-fill-sync' ||
            e.trace_id === 'control-arm-reconcile' ||
            e.trace_id === 'control-arm-fill-sync',
        ),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
