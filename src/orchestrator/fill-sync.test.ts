import type { ReconcileReport } from '../execution/index.js';
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
              reason: 'broker has no order under this client_order_id',
            },
            {
              idempotency_key: 'key-tsla-1400',
              instrument: 'TSLA',
              store_state: 'pending',
              broker_state: null,
              action: 'undetermined',
              reason: 'venue unreachable',
            },
          ],
        }),
      ),
    });

    await runStartupReconcile({ execution, logger });

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

    await expect(runStartupReconcile({ execution, logger: makeLogger() })).rejects.toThrow(
      'store unreadable',
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

  it('stops polling after stop()', async () => {
    const execution = makeExecution();
    const sync = startFillSync({
      execution,
      clock: { now: () => new Date() },
      logger: makeLogger(),
      fillPollIntervalMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await sync.stop();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(execution.ingestFills).toHaveBeenCalledTimes(1);
  });
});
