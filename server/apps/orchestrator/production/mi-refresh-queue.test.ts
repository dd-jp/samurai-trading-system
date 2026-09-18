import {
  BUDGET_REMEDY,
  CORRUPT_LEDGER_REMEDY,
  READ_FAULT_REMEDY,
  type SpendCap,
  type SpendCapVerdict,
} from '../../../pipeline/debate-engine/index.js';
import type { LogEntry, Logger } from '../../../shared/index.js';
import { currentTraceId, runWithTraceId } from '../../../shared/index.js';
import { composeMarketIntelligence, type MarketIntelligenceRefresh } from './analysts-adapter.js';
import { MI_REFRESH_TRACE_ID, MiRefreshQueue, REFUSAL_LOG_EVERY } from './mi-refresh-queue.js';

function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function recordingLogger(): Logger & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { entries, log: (entry) => entries.push(entry) };
}

function meteredCap(budgetUsd: number): SpendCap & { spentUsd: number } {
  const cap = {
    spentUsd: 0,
    check(): SpendCapVerdict {
      return cap.spentUsd >= budgetUsd
        ? {
            admitted: false,
            spent_usd: cap.spentUsd,
            budget_usd: budgetUsd,
            reason: 'LLM spend cap reached',
            kind: 'budget',
          }
        : { admitted: true, spent_usd: cap.spentUsd, budget_usd: budgetUsd };
    },
  };
  return cap;
}

function billingRefresher(
  cap: { spentUsd: number },
  costUsd: number,
  calls: string[],
): MarketIntelligenceRefresh {
  return {
    async refresh(_trace_id, instrument) {
      calls.push(instrument);
      await Promise.resolve();
      cap.spentUsd += costUsd;
      return true;
    },
  };
}

function labeledCapReadingRefresher(
  label: string,
  cap: SpendCap & { spentUsd: number },
  costUsd: number,
  calls: string[],
): MarketIntelligenceRefresh {
  return {
    async refresh(_trace_id, instrument) {
      if (!cap.check().admitted) return false;
      calls.push(`${label}:${instrument}`);
      await Promise.resolve();
      cap.spentUsd += costUsd;
      return true;
    },
  };
}

function composePair(
  first: MarketIntelligenceRefresh,
  second: MarketIntelligenceRefresh,
): MarketIntelligenceRefresh {
  const composed = composeMarketIntelligence([first, second]);
  if (composed === undefined) throw new Error('test setup: two agents must compose to one');
  return composed;
}

const UNCAPPED: SpendCap = {
  check: () => ({ admitted: true, spent_usd: 0, budget_usd: Number.POSITIVE_INFINITY }),
};

describe('MiRefreshQueue (#1085)', () => {
  it('returns before the refresh has run, so the analyst stage never waits on an LLM call', async () => {
    let release = (): void => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    const queue = new MiRefreshQueue({
      spendCap: UNCAPPED,
      refresher: {
        async refresh() {
          started = true;
          await blocked;
          return true;
        },
      },
    });

    await expect(queue.refresh('tick-1', 'TSLA', 'stocks')).resolves.toBe(false);
    expect(started).toBe(true);
    expect(queue.depth).toBe(1);

    release();
    await queue.stop();
  });

  it('never lets two MI calls pass a spend check the pair would fail, across instruments', async () => {
    const cap = meteredCap(1);
    const calls: string[] = [];
    const queue = new MiRefreshQueue({
      spendCap: cap,
      refresher: billingRefresher(cap, 1, calls),
    });

    await Promise.all([
      queue.refresh('tick-1', 'TSLA', 'stocks'),
      queue.refresh('tick-1', 'AAPL', 'stocks'),
    ]);
    await settle();

    expect(calls).toEqual(['TSLA']);
    expect(cap.spentUsd).toBe(1);
  });

  it('is the only thing enforcing that — the composed agents alone overshoot on the same two requests', async () => {
    const cap = meteredCap(1);
    const calls: string[] = [];
    const composed = composeMarketIntelligence([billingRefresher(cap, 1, calls)]);

    await Promise.all([
      composed?.refresh('tick-1', 'TSLA', 'stocks'),
      composed?.refresh('tick-1', 'AAPL', 'stocks'),
    ]);

    expect(calls).toEqual(['TSLA', 'AAPL']);
    expect(cap.spentUsd).toBe(2);
  });

  it.each([
    { first: 'ingest', second: 'grok', instrument: 'TSLA' },
    { first: 'grok', second: 'ingest', instrument: 'AAPL' },
  ] as const)(
    'holds the pair inside the budget with $first composed first, now that both self-gate (#1106)',
    async ({ first, second, instrument }) => {
      const cap = meteredCap(1);
      const calls: string[] = [];
      const queue = new MiRefreshQueue({
        spendCap: cap,
        refresher: composePair(
          labeledCapReadingRefresher(first, cap, 1, calls),
          labeledCapReadingRefresher(second, cap, 1, calls),
        ),
      });

      await queue.refresh('tick-1', instrument, 'stocks');
      await settle();

      expect(calls).toEqual([`${first}:${instrument}`]);
      expect(cap.spentUsd).toBe(1);
    },
  );

  it('refuses a queued refresh once the cap is reached, logging the first then every Nth', async () => {
    const cap = meteredCap(1);
    cap.spentUsd = 1;
    const calls: string[] = [];
    const logger = recordingLogger();
    const queue = new MiRefreshQueue({
      spendCap: cap,
      refresher: billingRefresher(cap, 1, calls),
      logger,
    });

    for (let i = 0; i < REFUSAL_LOG_EVERY; i += 1) {
      void queue.refresh('tick-1', `NAME${i}`, 'stocks');
    }
    await settle();

    expect(calls).toEqual([]);
    const refusals = logger.entries.filter((entry) => entry.message.includes('refresh for NAME'));
    expect(refusals).toHaveLength(2);
    expect(refusals[0]?.trace_id).toBe(MI_REFRESH_TRACE_ID);
    expect(refusals[0]?.level).toBe('warn');
  });

  it('survives a refresher that throws, and keeps draining the rest', async () => {
    const calls: string[] = [];
    const logger = recordingLogger();
    const queue = new MiRefreshQueue({
      spendCap: UNCAPPED,
      logger,
      refresher: {
        async refresh(_trace_id, instrument) {
          calls.push(instrument);
          if (instrument === 'TSLA') throw new Error('nous unreachable');
          return true;
        },
      },
    });

    await expect(queue.refresh('tick-1', 'TSLA', 'stocks')).resolves.toBe(false);
    void queue.refresh('tick-1', 'AAPL', 'stocks');
    await settle();

    expect(calls).toEqual(['TSLA', 'AAPL']);
    expect(
      logger.entries.some(
        (entry) => entry.level === 'warn' && entry.message.includes('queued refresh for TSLA'),
      ),
    ).toBe(true);
  });

  it('survives a spend cap that throws rather than refusing', async () => {
    const calls: string[] = [];
    const logger = recordingLogger();
    let throwOnce = true;
    const queue = new MiRefreshQueue({
      spendCap: {
        check() {
          if (!throwOnce) return { admitted: true, spent_usd: 0, budget_usd: 1 };
          throwOnce = false;
          throw new Error('cap unreadable');
        },
      },
      logger,
      refresher: {
        async refresh(_trace_id, instrument) {
          calls.push(instrument);
          return true;
        },
      },
    });

    await queue.refresh('tick-1', 'TSLA', 'stocks');
    void queue.refresh('tick-1', 'AAPL', 'stocks');
    await settle();

    expect(calls).toEqual(['AAPL']);
    expect(logger.entries.some((entry) => entry.message.includes('TSLA'))).toBe(true);
  });

  it('holds at most one entry per instrument, so the queue cannot outgrow the universe', async () => {
    let release = (): void => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    const queue = new MiRefreshQueue({
      spendCap: UNCAPPED,
      refresher: {
        async refresh(_trace_id, instrument) {
          calls.push(instrument);
          await blocked;
          return true;
        },
      },
    });

    await queue.refresh('tick-1', 'TSLA', 'stocks');
    for (let i = 0; i < 5; i += 1) {
      await queue.refresh(`tick-${i + 2}`, 'AAPL', 'stocks');
      await queue.refresh(`tick-${i + 2}`, 'TSLA', 'stocks');
    }

    expect(queue.depth).toBe(2);

    release();
    await settle();
    expect(calls).toEqual(['TSLA', 'AAPL']);
    await queue.stop();
  });

  it('runs the refresh under its own trace id, not the tick that asked', async () => {
    const seen: string[] = [];
    const queue = new MiRefreshQueue({
      spendCap: UNCAPPED,
      refresher: {
        async refresh(trace_id) {
          seen.push(trace_id);
          return true;
        },
      },
    });

    await queue.refresh('tick-abc', 'TSLA', 'stocks');
    await settle();

    expect(seen).toEqual([MI_REFRESH_TRACE_ID]);
  });

  it("does not leak the enqueuing tick's id into the drain", async () => {
    const seen: (string | undefined)[] = [];
    const queue = new MiRefreshQueue({
      spendCap: UNCAPPED,
      refresher: {
        async refresh() {
          seen.push(currentTraceId());
          return true;
        },
      },
    });

    await runWithTraceId('tick-abc', async () => {
      await queue.refresh('tick-abc', 'TSLA', 'stocks');
    });
    await settle();

    expect(seen).toEqual([MI_REFRESH_TRACE_ID]);
    await queue.stop();
  });

  it("does not stamp one tick's id on a later instrument's refresh", async () => {
    let release = (): void => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: { instrument: string; trace: string | undefined }[] = [];
    const queue = new MiRefreshQueue({
      spendCap: UNCAPPED,
      refresher: {
        async refresh(_trace_id, instrument) {
          seen.push({ instrument, trace: currentTraceId() });
          await blocked;
          return true;
        },
      },
    });

    await runWithTraceId('tick-a', async () => {
      await queue.refresh('tick-a', 'TSLA', 'stocks');
    });
    await runWithTraceId('tick-b', async () => {
      await queue.refresh('tick-b', 'AAPL', 'stocks');
    });

    release();
    await settle();

    expect(seen).toEqual([
      { instrument: 'TSLA', trace: MI_REFRESH_TRACE_ID },
      { instrument: 'AAPL', trace: MI_REFRESH_TRACE_ID },
    ]);
    await queue.stop();
  });

  it('reports a refresh as attempted however it ended, and not before', async () => {
    const queue = new MiRefreshQueue({
      spendCap: UNCAPPED,
      refresher: {
        async refresh(_trace_id, instrument) {
          if (instrument === 'TSLA') throw new Error('nous unreachable');
          return true;
        },
      },
    });

    expect(queue.refreshAttempted('TSLA')).toBe(false);
    await queue.refresh('tick-1', 'TSLA', 'stocks');
    await settle();

    expect(queue.refreshAttempted('TSLA')).toBe(true);
    expect(queue.refreshAttempted('AAPL')).toBe(false);
  });

  it('takes no new work after stop, so a shutdown cannot be outrun by a tick', async () => {
    const calls: string[] = [];
    const queue = new MiRefreshQueue({
      spendCap: UNCAPPED,
      refresher: {
        async refresh(_trace_id, instrument) {
          calls.push(instrument);
          return true;
        },
      },
    });

    await queue.stop();
    await queue.refresh('tick-1', 'TSLA', 'stocks');
    await settle();

    expect(calls).toEqual([]);
  });

  it('does not resolve stop until the refresh already dispatched has finished', async () => {
    let release = (): void => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finished = false;
    const queue = new MiRefreshQueue({
      spendCap: UNCAPPED,
      refresher: {
        async refresh() {
          await blocked;
          finished = true;
          return true;
        },
      },
    });

    await queue.refresh('tick-1', 'TSLA', 'stocks');
    let stopped = false;
    const stopping = queue.stop().then(() => {
      stopped = true;
    });

    await settle();
    expect(finished).toBe(false);
    expect(stopped).toBe(false);

    release();
    await stopping;
    expect(finished).toBe(true);
  });

  it('picks up a request enqueued while a refresh is in flight', async () => {
    const calls: string[] = [];
    const queue = new MiRefreshQueue({
      spendCap: UNCAPPED,
      refresher: {
        async refresh(_trace_id, instrument) {
          calls.push(instrument);
          if (instrument === 'TSLA') void queue.refresh('tick-2', 'AAPL', 'stocks');
          return true;
        },
      },
    });

    await queue.refresh('tick-1', 'TSLA', 'stocks');
    await settle();

    expect(calls).toEqual(['TSLA', 'AAPL']);
  });

  it('serialises a re-entrant enqueue rather than starting a second worker', async () => {
    const cap = meteredCap(1);
    const calls: string[] = [];
    let inFlight = 0;
    let mostInFlightAtOnce = 0;
    let reentered = false;
    const queue = new MiRefreshQueue({
      spendCap: cap,
      refresher: {
        async refresh(_trace_id, instrument) {
          if (!reentered) {
            reentered = true;
            void queue.refresh('tick-2', 'AAPL', 'stocks');
          }
          inFlight += 1;
          mostInFlightAtOnce = Math.max(mostInFlightAtOnce, inFlight);
          calls.push(instrument);
          await Promise.resolve();
          cap.spentUsd += 1;
          inFlight -= 1;
          return true;
        },
      },
    });

    await queue.refresh('tick-1', 'TSLA', 'stocks');
    await settle();

    expect(mostInFlightAtOnce).toBe(1);
    expect(cap.spentUsd).toBe(1);
    expect(calls).toEqual(['TSLA']);
  });

  describe('spend-cap refusal wording (#1372)', () => {
    function refusingCap(verdict: Extract<SpendCapVerdict, { admitted: false }>): SpendCap {
      return { check: () => verdict };
    }

    it('states the budget remedy on a budget refusal, and its kind in the payload', async () => {
      const cap = meteredCap(1);
      cap.spentUsd = 1;
      const calls: string[] = [];
      const logger = recordingLogger();
      const queue = new MiRefreshQueue({
        spendCap: cap,
        refresher: billingRefresher(cap, 1, calls),
        logger,
      });

      await queue.refresh('tick-1', 'TSLA', 'stocks');
      await settle();

      const refusal = logger.entries.find(
        (entry) => entry.event === 'mi_refresh_refused_spend_cap',
      );
      expect(refusal).toBeDefined();
      expect(refusal?.message).toContain(BUDGET_REMEDY);
      expect(refusal?.message).not.toContain(READ_FAULT_REMEDY);
      expect(refusal?.message).not.toContain(CORRUPT_LEDGER_REMEDY);
      expect(refusal?.payload).toMatchObject({ kind: 'budget' });
    });

    it('states the read-fault remedy on a read-fault refusal, and its kind in the payload', async () => {
      const calls: string[] = [];
      const logger = recordingLogger();
      const faultCap = refusingCap({
        admitted: false,
        spent_usd: Number.NaN,
        budget_usd: 1,
        reason: 'spend cap unreadable (fail-closed)',
        kind: 'read_fault',
      });
      const queue = new MiRefreshQueue({
        spendCap: faultCap,
        refresher: billingRefresher({ spentUsd: 0 }, 1, calls),
        logger,
      });

      await queue.refresh('tick-1', 'TSLA', 'stocks');
      await settle();

      const refusal = logger.entries.find(
        (entry) => entry.event === 'mi_refresh_refused_spend_cap',
      );
      expect(refusal).toBeDefined();
      expect(refusal?.message).toContain(READ_FAULT_REMEDY);
      expect(refusal?.message).not.toContain(BUDGET_REMEDY);
      expect(refusal?.message).not.toContain(CORRUPT_LEDGER_REMEDY);
      expect(refusal?.payload).toMatchObject({ kind: 'read_fault' });
      expect(calls).toEqual([]);
    });

    it('states the corrupt-ledger remedy on a corrupt-ledger refusal, and its kind in the payload', async () => {
      const calls: string[] = [];
      const logger = recordingLogger();
      const corruptCap = refusingCap({
        admitted: false,
        spent_usd: Number.NaN,
        budget_usd: 1,
        reason: 'llm_spend total is not a finite number (fail-closed)',
        kind: 'corrupt_ledger',
      });
      const queue = new MiRefreshQueue({
        spendCap: corruptCap,
        refresher: billingRefresher({ spentUsd: 0 }, 1, calls),
        logger,
      });

      await queue.refresh('tick-1', 'TSLA', 'stocks');
      await settle();

      const refusal = logger.entries.find(
        (entry) => entry.event === 'mi_refresh_refused_spend_cap',
      );
      expect(refusal).toBeDefined();
      expect(refusal?.message).toContain(CORRUPT_LEDGER_REMEDY);
      expect(refusal?.message).not.toContain(BUDGET_REMEDY);
      expect(refusal?.message).not.toContain(READ_FAULT_REMEDY);
      expect(refusal?.payload).toMatchObject({ kind: 'corrupt_ledger' });
      expect(calls).toEqual([]);
    });
  });

  describe('refusal-log throttle is per spend-cap refusal kind (#1376)', () => {
    function scriptedCap(verdicts: Extract<SpendCapVerdict, { admitted: false }>[]): SpendCap {
      let call = 0;
      return {
        check: () => {
          const verdict = verdicts[Math.min(call, verdicts.length - 1)];
          call += 1;
          if (verdict === undefined) throw new Error('scriptedCap: no verdict scripted');
          return verdict;
        },
      };
    }

    it('logs both remedy texts when a read-fault refusal is followed by a budget refusal', async () => {
      const calls: string[] = [];
      const logger = recordingLogger();
      const cap = scriptedCap([
        {
          admitted: false,
          spent_usd: Number.NaN,
          budget_usd: 1,
          reason: 'spend cap unreadable (fail-closed)',
          kind: 'read_fault',
        },
        {
          admitted: false,
          spent_usd: 1,
          budget_usd: 1,
          reason: 'LLM spend cap reached',
          kind: 'budget',
        },
      ]);
      const queue = new MiRefreshQueue({
        spendCap: cap,
        refresher: billingRefresher({ spentUsd: 0 }, 1, calls),
        logger,
      });

      await queue.refresh('tick-1', 'TSLA', 'stocks');
      await settle();
      await queue.refresh('tick-1', 'AAPL', 'stocks');
      await settle();

      const refusals = logger.entries.filter(
        (entry) => entry.event === 'mi_refresh_refused_spend_cap',
      );
      expect(refusals).toHaveLength(2);
      expect(refusals[0]?.message).toContain(READ_FAULT_REMEDY);
      expect(refusals[0]?.message).not.toContain(BUDGET_REMEDY);
      expect(refusals[1]?.message).toContain(BUDGET_REMEDY);
      expect(refusals[1]?.message).not.toContain(READ_FAULT_REMEDY);
      expect(calls).toEqual([]);
    });

    it('leaves a single-kind stream throttled exactly as before (AC3)', async () => {
      const cap = meteredCap(1);
      cap.spentUsd = 1;
      const calls: string[] = [];
      const logger = recordingLogger();
      const queue = new MiRefreshQueue({
        spendCap: cap,
        refresher: billingRefresher(cap, 1, calls),
        logger,
      });

      for (let i = 0; i < 1000; i += 1) {
        void queue.refresh('tick-1', `NAME${i}`, 'stocks');
      }
      await settle();

      const refusals = logger.entries.filter(
        (entry) => entry.event === 'mi_refresh_refused_spend_cap',
      );
      expect(refusals).toHaveLength(1 + 1000 / REFUSAL_LOG_EVERY);
    });

    it("carries a kind's count across another kind interleaving, rather than resetting it", async () => {
      const budgetVerdict: Extract<SpendCapVerdict, { admitted: false }> = {
        admitted: false,
        spent_usd: 1,
        budget_usd: 1,
        reason: 'LLM spend cap reached',
        kind: 'budget',
      };
      const readFaultVerdict: Extract<SpendCapVerdict, { admitted: false }> = {
        admitted: false,
        spent_usd: Number.NaN,
        budget_usd: 1,
        reason: 'spend cap unreadable (fail-closed)',
        kind: 'read_fault',
      };
      const cap = scriptedCap([
        ...Array.from({ length: REFUSAL_LOG_EVERY }, () => budgetVerdict),
        readFaultVerdict,
        ...Array.from({ length: REFUSAL_LOG_EVERY }, () => budgetVerdict),
      ]);
      const calls: string[] = [];
      const logger = recordingLogger();
      const queue = new MiRefreshQueue({
        spendCap: cap,
        refresher: billingRefresher({ spentUsd: 0 }, 1, calls),
        logger,
      });

      for (let i = 0; i < 2 * REFUSAL_LOG_EVERY + 1; i += 1) {
        void queue.refresh('tick-1', `NAME${i}`, 'stocks');
      }
      await settle();

      const refusals = logger.entries.filter(
        (entry) => entry.event === 'mi_refresh_refused_spend_cap',
      );
      expect(refusals).toHaveLength(4);
      expect(refusals[0]?.payload).toMatchObject({ kind: 'budget', refusals_of_kind: 1 });
      expect(refusals[1]?.payload).toMatchObject({
        kind: 'budget',
        refusals_of_kind: REFUSAL_LOG_EVERY,
      });
      expect(refusals[2]?.payload).toMatchObject({ kind: 'read_fault', refusals_of_kind: 1 });
      expect(refusals[3]?.payload).toMatchObject({
        kind: 'budget',
        refusals_of_kind: 2 * REFUSAL_LOG_EVERY,
      });
    });
  });
});
