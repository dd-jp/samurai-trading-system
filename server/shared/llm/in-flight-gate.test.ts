import type { LogEntry } from '../types.js';
import {
  LlmInFlightRefusedError,
  NousAccountInFlightGate,
  UNGATED_LLM_IN_FLIGHT,
} from './in-flight-gate.js';

const EXPECTED_CALL_MS = 5_800;

function collector() {
  const entries: LogEntry[] = [];
  return { entries, logger: { log: (entry: LogEntry) => void entries.push(entry) } };
}

describe('NousAccountInFlightGate', () => {
  it('admits up to maxInFlight callers without queueing', async () => {
    const gate = new NousAccountInFlightGate({ maxInFlight: 2, expectedCallMs: EXPECTED_CALL_MS });

    const first = await gate.acquire({ budgetMs: 28_000 });
    const second = await gate.acquire({ budgetMs: 28_000 });

    expect(first).not.toBe(second);
    first.release();
    second.release();
  });

  it('holds the second caller until the first releases, FIFO', async () => {
    const { entries, logger } = collector();
    const gate = new NousAccountInFlightGate({
      maxInFlight: 1,
      expectedCallMs: EXPECTED_CALL_MS,
      logger,
    });

    const held = await gate.acquire({ budgetMs: 28_000 });
    const order: string[] = [];
    const second = gate.acquire({ budgetMs: 28_000, llmStage: 'debate' }).then((slot) => {
      order.push('second');
      return slot;
    });
    const third = gate.acquire({ budgetMs: 28_000, llmStage: 'debate' }).then((slot) => {
      order.push('third');
      return slot;
    });

    // Nothing may proceed while the single slot is held
    await Promise.resolve();
    expect(order).toEqual([]);

    held.release();
    (await second).release();
    (await third).release();

    expect(order).toEqual(['second', 'third']);
    const waits = entries.filter((entry) => entry.event === 'llm_gate_wait');
    expect(waits).toHaveLength(2);
    // `queue_depth` is what was ALREADY waiting when the call arrived: nothing
    // for the second caller, the second caller for the third
    expect(waits[0]?.payload).toMatchObject({
      queue_depth: 0,
      max_in_flight: 1,
      llm_stage: 'debate',
    });
    expect(waits[1]?.payload).toMatchObject({ queue_depth: 1 });
    expect((waits[0]?.payload as { wait_ms?: unknown } | undefined)?.wait_ms).toEqual(
      expect.any(Number),
    );
  });

  it('refuses admission when the estimated wait plus the call itself exceeds the caller budget', async () => {
    const { entries, logger } = collector();
    const gate = new NousAccountInFlightGate({
      maxInFlight: 1,
      expectedCallMs: EXPECTED_CALL_MS,
      logger,
    });

    const held = await gate.acquire({ budgetMs: 28_000 });
    // Three queued callers put the fourth at an estimated 4 x 5,800 = 23,200ms
    // of waiting. That wait ALONE fits inside 28,000 — the call it would then
    // have to make is what does not (23,200 + 5,800 = 29,000)
    const queued = [0, 1, 2].map(() => gate.acquire({ budgetMs: 28_000 }));

    await expect(gate.acquire({ budgetMs: 28_000, llmStage: 'debate' })).rejects.toBeInstanceOf(
      LlmInFlightRefusedError,
    );
    const refusals = entries.filter((entry) => entry.event === 'llm_gate_refused');
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.payload).toMatchObject({
      reason: 'admission',
      queue_depth: 3,
      budget_ms: 28_000,
      estimated_wait_ms: 23_200,
    });

    held.release();
    for (const pending of queued) (await pending).release();
  });

  it('admits when the estimated wait and the call both fit the caller budget', async () => {
    const gate = new NousAccountInFlightGate({ maxInFlight: 1, expectedCallMs: EXPECTED_CALL_MS });
    const held = await gate.acquire({ budgetMs: 28_000 });

    const queued = gate.acquire({ budgetMs: 28_000 });
    held.release();
    (await queued).release();
  });

  it("estimates a wait from the queue's OWN declared call durations, not one constant", async () => {
    const { entries, logger } = collector();
    const gate = new NousAccountInFlightGate({
      maxInFlight: 1,
      expectedCallMs: EXPECTED_CALL_MS,
      logger,
    });

    // One X-retrieval call in flight, measured at up to 60s — a debate caller
    // behind it waits for THAT, not for a 5,800ms debate call
    const held = await gate.acquire({ budgetMs: 60_000, expectedCallMs: 60_000 });

    await expect(gate.acquire({ budgetMs: 28_000, llmStage: 'debate' })).rejects.toBeInstanceOf(
      LlmInFlightRefusedError,
    );
    expect(entries.find((entry) => entry.event === 'llm_gate_refused')?.payload).toMatchObject({
      reason: 'admission',
      estimated_wait_ms: 60_000,
    });

    held.release();
  });

  it("charges a caller's own declared duration against its budget on admission", async () => {
    const gate = new NousAccountInFlightGate({ maxInFlight: 1, expectedCallMs: EXPECTED_CALL_MS });
    const held = await gate.acquire({ budgetMs: 28_000 });

    // A 5,800ms wait fits a 28,000ms budget; a 60,000ms call after it does not
    await expect(gate.acquire({ budgetMs: 28_000, expectedCallMs: 60_000 })).rejects.toBeInstanceOf(
      LlmInFlightRefusedError,
    );

    held.release();
  });

  it('rejects a non-positive expectedCallMs rather than silently disabling admission', () => {
    expect(() => new NousAccountInFlightGate({ maxInFlight: 1, expectedCallMs: 0 })).toThrow(
      /expectedCallMs/,
    );
  });

  it('refuses a queued caller whose budget expires before a slot frees', async () => {
    vi.useFakeTimers();
    try {
      const { entries, logger } = collector();
      const gate = new NousAccountInFlightGate({
        maxInFlight: 1,
        expectedCallMs: EXPECTED_CALL_MS,
        logger,
      });
      const held = await gate.acquire({ budgetMs: 14_000 });
      const queued = gate.acquire({ budgetMs: 14_000, llmStage: 'risk_critic' });
      const settled = queued.catch((error: unknown) => error);

      // Dropped at `budgetMs - expectedCallMs`, not at `budgetMs`: a waiter
      // granted any later could not make its own call inside the budget
      await vi.advanceTimersByTimeAsync(8_199);
      expect(entries.filter((entry) => entry.event === 'llm_gate_refused')).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      const error = await settled;
      expect(error).toBeInstanceOf(LlmInFlightRefusedError);
      expect((error as LlmInFlightRefusedError).reason).toBe('queue_deadline');
      expect(
        entries.filter(
          (entry) =>
            entry.event === 'llm_gate_refused' &&
            (entry.payload as { reason?: string }).reason === 'queue_deadline',
        ),
      ).toHaveLength(1);

      // The refused waiter must not have consumed the slot it never got
      held.release();
      const next = await gate.acquire({ budgetMs: 14_000 });
      next.release();
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases the slot to the next waiter when a holder is cancelled mid-call', async () => {
    const gate = new NousAccountInFlightGate({ maxInFlight: 1, expectedCallMs: EXPECTED_CALL_MS });
    const held = await gate.acquire({ budgetMs: 28_000 });
    const queued = gate.acquire({ budgetMs: 28_000 });

    // What a caller's `finally` does when its own AbortSignal fires in flight
    held.release();

    const slot = await queued;
    slot.release();
  });

  it('drops a queued caller whose signal aborts, and frees nothing it never held', async () => {
    const gate = new NousAccountInFlightGate({ maxInFlight: 1, expectedCallMs: EXPECTED_CALL_MS });
    const held = await gate.acquire({ budgetMs: 28_000 });
    const controller = new AbortController();
    const cancelled = gate
      .acquire({ budgetMs: 28_000, signal: controller.signal })
      .catch((error: unknown) => error);

    const reason = new Error('caller went away');
    controller.abort(reason);
    expect(await cancelled).toBe(reason);

    held.release();
    const next = await gate.acquire({ budgetMs: 28_000 });
    next.release();
  });

  it('refuses an already-aborted caller before it takes a slot', async () => {
    const gate = new NousAccountInFlightGate({ maxInFlight: 1, expectedCallMs: EXPECTED_CALL_MS });
    const controller = new AbortController();
    const reason = new Error('already gone');
    controller.abort(reason);

    await expect(gate.acquire({ signal: controller.signal })).rejects.toBe(reason);

    const next = await gate.acquire({ budgetMs: 28_000 });
    next.release();
  });

  it('counts a double release once', async () => {
    const gate = new NousAccountInFlightGate({ maxInFlight: 1, expectedCallMs: EXPECTED_CALL_MS });
    const held = await gate.acquire({ budgetMs: 28_000 });
    held.release();
    held.release();

    const first = await gate.acquire({ budgetMs: 28_000 });
    let secondGranted = false;
    void gate.acquire({ budgetMs: 28_000 }).then(() => {
      secondGranted = true;
    });
    await Promise.resolve();
    expect(secondGranted).toBe(false);
    first.release();
  });

  it('queues without a budget rather than refusing on admission', async () => {
    const gate = new NousAccountInFlightGate({ maxInFlight: 1, expectedCallMs: EXPECTED_CALL_MS });
    const held = await gate.acquire({});
    const queued = gate.acquire({});
    held.release();
    (await queued).release();
  });
});

describe('UNGATED_LLM_IN_FLIGHT', () => {
  it('admits every caller immediately', async () => {
    const slots = await Promise.all([
      UNGATED_LLM_IN_FLIGHT.acquire({ budgetMs: 1 }),
      UNGATED_LLM_IN_FLIGHT.acquire({ budgetMs: 1 }),
      UNGATED_LLM_IN_FLIGHT.acquire({ budgetMs: 1 }),
    ]);
    for (const slot of slots) slot.release();
    expect(slots).toHaveLength(3);
  });
});
