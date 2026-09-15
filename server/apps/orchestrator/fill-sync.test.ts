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
    // `undetermined` is the one an operator has to look at: the adapter could
    // not answer, so the lot is neither adopted nor freed.
    expect(divergences[1]?.payload).toMatchObject({ action: 'undetermined' });
  });

  it('propagates a reconcile failure instead of swallowing it', async () => {
    // Trading against a store that still disagrees with the venue is exactly
    // what reconcile exists to prevent, so start() must not continue.
    const execution = makeExecution({
      reconcile: vi.fn().mockRejectedValue(new Error('store unreadable')),
    });

    await expect(
      runStartupReconcile({ execution, logger: makeLogger(), traceId: 'test-reconcile' }),
    ).rejects.toThrow('store unreadable');
  });

  // #1088: the sweep runs unconditionally on every reconcile() pass but is
  // not a divergence, so it needed its own trace — otherwise a DELETE
  // against open_positions happened with nothing anywhere to show it.
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

  // The reason this loop is a self-scheduling setTimeout and not setInterval:
  // two concurrent passes would both read getOpenPositions() and both call
  // resizeProtectiveLegs, racing on a mid-fill lot's protective quantity.
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
    // Several polls actually ran — otherwise `maxActive === 1` would pass
    // vacuously on a loop that only ever fired once.
    // 6s per cycle (1s gap + 5s poll): polls begin at t=1s, 7s, 13s, 19s.
    expect(execution.ingestFills).toHaveBeenCalledTimes(4);

    // Drain with the clock still moving: stop() awaits the in-flight poll,
    // which needs fake time to finish.
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
    // The run continues: a transient venue failure costs one poll, not the run.
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

    // Enter a poll, then stop mid-flight.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(finished).toBe(false);

    const stopping = sync.stop();
    await vi.advanceTimersByTimeAsync(3_000);
    await stopping;

    // Abandoning here could cut between writeFill and updatePositionFill.
    expect(finished).toBe(true);
  });

  // #549: the sweep-in-finally control flow, pinned. A rejecting poll is the
  // case the sweep exists FOR (a failed poll is exactly what can leave a
  // residual's re-arm unconfirmed), so it must still run — and its own
  // throw is contained to a log line, never allowed to mask the poll's error.
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

      // Both failures surfaced, each under its own line — the sweep's throw
      // did not replace the poll's error, and vice versa.
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
      // And the loop survived to poll again.
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
      // Pass 1 logs the warn; pass 2 (same lot, same state) is deduped; pass
      // 3's transition to adopted logs the info; pass 4 reports nothing.
      expect(divergenceLines.map((entry) => entry.level)).toEqual(['warn', 'info']);
      expect(divergenceLines[0]?.payload).toMatchObject({ action: 'undetermined' });
      expect(divergenceLines[1]?.payload).toMatchObject({ action: 'adopted' });

      await sync.stop();
    });
  });

  // #921: `reconcile()` moves from startup-only to also running on every
  // recurring poll, before that poll's `ingestFills()` — the same ordering
  // rationale `runStartupReconcile` establishes at startup (this module's
  // top-of-file doc), now repeated on cadence so a lost ack between polls
  // does not sit unrecovered until the next restart.
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
      // No 'fill poll failed' line — ingestFills itself did not throw, and the
      // reconcile failure must not masquerade as one.
      expect(logger.entries).not.toContainEqual(
        expect.objectContaining({ message: 'fill poll failed' }),
      );

      await sync.stop();
    });

    // #1351: an unguarded render of `reconcileError` sits ahead of BOTH
    // `ingestFills()` and the `finally`-wrapped #549 sweep in `runPoll`'s
    // first block — a throw there skips them entirely, defeating the sweep's
    // own comment that it must run "even when the poll itself failed, and
    // ESPECIALLY then."
    it('an unrenderable reconcile() failure still runs ingestFills and the residual-protection sweep', async () => {
      const logger = makeLogger();
      // Circular (defeats `JSON.stringify`) with a throwing `Symbol.toPrimitive`
      // (defeats the `String()` fallback too) — same shape as the #1262
      // tick-loop hostile value.
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

      // The durable artifacts: both the pass's ingest and the #549 sweep ran,
      // not just "nothing threw".
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
      // Pass 1 logs the warn; pass 2 (same key, same state) is deduped; pass
      // 3's transition to a bracket adopt reaching `filled` logs at debug
      // (#1122 — FilledZeroSizeThrottle already watches this exact condition
      // independently); pass 4 reports nothing.
      expect(divergenceLines.map((entry) => entry.level)).toEqual(['warn', 'debug']);
      expect(divergenceLines[0]?.payload).toMatchObject({ action: 'undetermined' });
      expect(divergenceLines[1]?.payload).toMatchObject({ action: 'adopted' });

      await sync.stop();
    });

    // #1577: `action` alone collapsed `cancelWedgedFlatten`'s escalated cancel
    // onto the benign flatten adopt one pass earlier — both are
    // `action: 'adopted'`, differing only in `reason`, so the escalation
    // never reached the log once the benign line had already deduped it.
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
        escalated: true as const,
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
      const firstPayload = divergenceLines[0]?.payload as { action: string; escalated?: true };
      expect(firstPayload).toMatchObject({ action: 'adopted' });
      expect(firstPayload.escalated).toBeUndefined();
      expect(divergenceLines[1]?.payload).toMatchObject({ action: 'adopted', escalated: true });

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

    // Pins the OTHER terminal-adjacent broker_state the narrowing predicate
    // must also demote — `'filled'` is covered by "logs a reconcile
    // divergence on first observation..." above; a mutant
    // that swapped `'partially_filled'` for `'cancelled'` in
    // `reconcileDivergenceLevel` would leave that test green (it never
    // exercises `'partially_filled'`) while silently excluding every
    // partial-fill adopt from FilledZeroSizeThrottle's backstop, since
    // getOpenPositions() excludes `'cancelled'` rows (#1122 review round 1).
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

    // The empty-string collision this dedup must not fall into:
    // `findUnrecordedVenuePositions` reports every unrecorded position with
    // `idempotency_key: ''`, so a naive dedup keyed on that field alone would
    // treat every such divergence as the SAME episode and mask all but the
    // first. Keying on `idempotency_key || instrument` keeps them distinct.
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
      // Pass 1: AAPL logs once. Pass 2: AAPL is the same episode (deduped),
      // but TSLA is a genuinely NEW divergence sharing the same empty
      // idempotency_key, and must log despite that collision.
      expect(divergenceLines).toHaveLength(2);
      expect(
        divergenceLines.map((entry) => (entry.payload as { instrument: string }).instrument),
      ).toEqual(['AAPL', 'TSLA']);

      await sync.stop();
    });

    // #1506: the shape `findUnrecordedVenuePositions` raises means the VENUE
    // holds a position no open lot explains — exposure invisible to Risk's
    // caps, with no backstop detector anywhere else, which is the argument
    // for raising the level rather than the one this docblock used to give
    // for leaving it at `info` alongside `rejected`.
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

    // #1088: the sweep runs unconditionally on every periodic reconcile()
    // pass but is not a divergence, so it needed its own trace at this call
    // site too — otherwise a DELETE against open_positions happened on every
    // poll cadence with nothing anywhere to show it.
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

// #1321: both arms drove this SAME loop's log lines under one hardcoded
// `trace_id`, so a control-arm reconcile divergence and a live-arm one were
// indistinguishable in `logs/orchestrator.log` — the exact confusion that
// made #1124 read as one arm racing itself. These tests drive two loops
// side by side (one per arm) against a SHARED logger and assert their lines
// carry different `trace_id`s — a test asserting only the constant's value
// would stay green even with both arms wired to the same literal.
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
    // The point of the ticket: the two calls must not collapse onto one id.
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

      // One divergence per loop, and each one carries THAT loop's own
      // reconcile trace id — not the other loop's, and not a shared default.
      expect(divergenceEntries).toHaveLength(2);
      expect(divergenceEntries.map((e) => e.trace_id).sort()).toEqual([
        'control-arm-reconcile',
        'live-arm-reconcile',
      ]);

      // Same for the fill-poll failure lines, under the fill-sync trace id.
      expect(failedPollEntries).toHaveLength(2);
      expect(failedPollEntries.map((e) => e.trace_id).sort()).toEqual([
        'control-arm-fill-sync',
        'live-arm-fill-sync',
      ]);

      // Nothing from either loop lands on the OTHER loop's trace id.
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
