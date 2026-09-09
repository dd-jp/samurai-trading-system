/**
 * `MiRefreshQueue` (#1085) — the three properties the queue exists for.
 *
 * 1. The analyst stage no longer blocks on a live MI LLM call.
 * 2. Two metered MI calls cannot both pass a spend check the pair would fail —
 *    including ACROSS instruments, which the sequential composition never
 *    covered, because #1013 admits several instrument passes concurrently.
 * 3. An MI failure still degrades to "no new intelligence" and never escapes.
 */
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

/**
 * Lets the enqueue-driven worker run to completion.
 *
 * A macrotask turn, so the whole microtask queue — every iteration of the
 * drain loop, since every refresher below settles on it — has run by the time
 * this resolves. NOT `stop()`: that is the shutdown path and it
 * deliberately discards work still waiting, which would make a test about
 * refusals pass because the item was dropped.
 */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function recordingLogger(): Logger & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { entries, log: (entry) => entries.push(entry) };
}

/**
 * A cap with the shape that matters: `check()` is a PURE READ of a total that
 * only a completed call moves. That is what makes the concurrency question
 * real — two callers reading before either records both see the same figure.
 */
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

/** Bills the cap the way a real agent does: admitted first, recorded only after the call returns. */
function billingRefresher(
  cap: { spentUsd: number },
  costUsd: number,
  calls: string[],
): MarketIntelligenceRefresh {
  return {
    async refresh(_trace_id, instrument) {
      calls.push(instrument);
      // The await is the point: real spend lands after a round trip, so
      // anything checking the cap during it reads a stale total.
      await Promise.resolve();
      cap.spentUsd += costUsd;
      return true;
    },
  };
}

/**
 * Bills like `billingRefresher`, but reads the cap first and refuses on a
 * breach — the shape BOTH `MiIngestAgent` and `GrokAgent` carry since #1106.
 * Tags its own calls with `label` so a test composing two of these (one per
 * "agent") can tell which one actually billed, not just how much was spent.
 * Needed because the two agents are now indistinguishable in shape: composing
 * two UNLABELLED instances would make a "reversed order" test a no-op, since
 * swapping two identical calls changes nothing observable.
 */
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

/**
 * The real `composeMarketIntelligence`, narrowed by a throw rather than a cast.
 * It returns `undefined` only for an empty list, which two agents cannot be.
 */
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
    // The property the whole change rests on: the stage's wait no longer
    // includes the refresh, however long the refresh takes.
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
    // The property the sequential composition existed to protect, true
    // globally for the first time. Each call costs the WHOLE budget, so a
    // second admitted call is exactly "both passed a check the pair fails".
    const cap = meteredCap(1);
    const calls: string[] = [];
    const queue = new MiRefreshQueue({
      spendCap: cap,
      refresher: billingRefresher(cap, 1, calls),
    });

    // Two instruments requested without awaiting the first — the shape
    // #1013's concurrently-admitted passes produce.
    await Promise.all([
      queue.refresh('tick-1', 'TSLA', 'stocks'),
      queue.refresh('tick-1', 'AAPL', 'stocks'),
    ]);
    await settle();

    expect(calls).toEqual(['TSLA']);
    expect(cap.spentUsd).toBe(1);
  });

  it('is the only thing enforcing that — the composed agents alone overshoot on the same two requests', async () => {
    // The mutation, run as a test rather than by hand: this is what those two
    // requests did WITHOUT the queue, which is what production did for every
    // pair of concurrently-admitted instruments.
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

  /**
   * Table over both orderings rather than two near-duplicate `it`s (round-2
   * review, #1106): a fixed pair of labels asserting "first bills, second
   * refuses" would let the SAME assertion pass for either row regardless of
   * which label the fixture put first, so each row names its own expected
   * `calls` entry — the property under test is "the FIRST-COMPOSED side
   * bills, whichever agent that is", not "ingest bills" or "grok bills".
   */
  it.each([
    { first: 'ingest', second: 'grok', instrument: 'TSLA' },
    { first: 'grok', second: 'ingest', instrument: 'AAPL' },
  ] as const)('holds the pair inside the budget with $first composed first, now that both self-gate (#1106)', async ({
    first,
    second,
    instrument,
  }) => {
    // Before #1106, `MiIngestAgent` billed through the shared `LlmClient`
    // and read no cap of its own, so ingest-first was the only safe
    // ordering at the composition root. Now both agents read the cap
    // before they call (the `labeledCapReadingRefresher` shape on both
    // sides), so the SAME pair spends the same total whichever one runs
    // first: the first call is admitted and bills, the second reads the
    // post-bill total and refuses — which one that is DOES flip with
    // order, and `labeledCapReadingRefresher`'s label is what makes that
    // flip observable rather than the two composed calls being
    // indistinguishable.
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

    // The FIRST-composed side bills, the second reads the post-bill total
    // and refuses — pinned by label, not just by count, so this cannot
    // pass for a pair that billed twice or for the wrong side billing
    // once.
    expect(calls).toEqual([`${first}:${instrument}`]);
    // EXACTLY the budget, not "at most" — `<= 1` would also pass for a
    // pass that spent nothing at all, which is what a queue refusing
    // everything looks like.
    expect(cap.spentUsd).toBe(1);
  });

  it('refuses a queued refresh once the cap is reached, logging the first then every Nth', async () => {
    // The queue's own `#dispatch` check, exercised directly against a
    // generic non-gating refresher — independent of whether the composed
    // agent behind it also self-gates, which both `MiIngestAgent` and
    // `GrokAgent` do as of #1106.
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
    // The seam's standing promise: an MI outage degrades the debate to the
    // NO_DATA marker, it does not fail a tick that would otherwise have
    // traded. Off the critical path the failure changes shape — an unhandled
    // rejection would kill the WORKER, so every later instrument would
    // silently stop refreshing — which is what this pins.
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
    // `SqliteSpendCap` converts its own store failure into a refusal, so this
    // is about any other cap the seam accepts. It sits outside the refresher's
    // own try in the naive shape, which is where an escape would kill the
    // worker and silently stop every LATER instrument refreshing.
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
    // Backpressure: the tick rate is fixed and the drain is not, so without
    // per-instrument dedup a slow sweep would accumulate one entry per name
    // per tick for as long as it lagged.
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
      // Re-requesting the IN-FLIGHT instrument must not queue a duplicate either.
      await queue.refresh(`tick-${i + 2}`, 'TSLA', 'stocks');
    }

    expect(queue.depth).toBe(2);

    release();
    await settle();
    expect(calls).toEqual(['TSLA', 'AAPL']);
    await queue.stop();
  });

  it('runs the refresh under its own trace id, not the tick that asked', async () => {
    // The call lands after the requesting tick has closed, so stamping the
    // tick's id on a `market_intelligence` line — and on the `llm_spend` row
    // behind it — would place off-tick work inside a finished trace.
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

  /**
   * The AMBIENT half of the test above. `AsyncLocalStorage` captures at the
   * point a continuation is registered, so a drain scheduled from inside the
   * analysts step would otherwise run under the enqueuing tick and the deep
   * log sites — `TokenBucket`, `MarketDataService` — would stamp that tick on
   * work it never waited for.
   */
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

  /**
   * The worse arm: one drain serves every queued name, so a leaked context
   * does not merely mislabel the tick that started it — it stamps that tick
   * on a LATER instrument's refresh, which is a wrong join rather than a
   * missing one.
   */
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
    // What the coverage alert gate reads (`CheckMiCoverageDeps.refreshAttempted`).
    // ATTEMPTED, not succeeded: a name whose refresh threw has no data and is
    // not going to get any, so it must be allowed to alert.
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
    // `stop()` drains the tick loop and this queue CONCURRENTLY, so a pass
    // still finishing can trigger a refresh after the drain has begun. Latched
    // rather than merely awaited, or that refresh would write to a closing store.
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
    // The half `mi-refresh-wiring.test.ts` cannot see: a refresh can only be
    // held open here. This is what the orchestrator's drain line buys — the
    // in-flight refresh ends in an archive and store write, so a `stop()` that
    // resolved early would let it race a closing store.
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
    // The test above proves the request is not LOST, and would pass just as
    // well if a second worker picked it up — which is what a re-entrant
    // enqueue used to cause. `#pump` is entered from inside the first
    // dispatch's SYNCHRONOUS prefix, so it must already see a worker by then
    // or two dispatches overlap and both read one pre-spend total, defeating
    // the single property this class exists for.
    const cap = meteredCap(1);
    const calls: string[] = [];
    let inFlight = 0;
    let mostInFlightAtOnce = 0;
    let reentered = false;
    const queue = new MiRefreshQueue({
      spendCap: cap,
      refresher: {
        async refresh(_trace_id, instrument) {
          // Before the first await, so this runs while `#pump` is still on
          // the stack below it.
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
    // The budget is the real assertion: overlapping dispatches would both
    // read a spent total of 0 and bill on top of each other.
    expect(cap.spentUsd).toBe(1);
    expect(calls).toEqual(['TSLA']);
  });

  describe('spend-cap refusal wording (#1372)', () => {
    // `mi_refresh_refused_spend_cap` used to assert "the budget does not
    // refill" unconditionally, which is false on the two fault refusal kinds
    // — a transient `llm_spend` read failure clears on its own. Assertions
    // below compare against the exported remedy constants, not literal
    // substrings, so a swap of which constant a kind maps to still reddens
    // here while a wording-only edit does not touch this file.
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
    /** Returns each scripted verdict in turn, then repeats the last. */
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
      // AC2: the shared counter this replaces would have consumed the
      // un-throttled "first" slot on the read-fault refusal and pushed the
      // budget refusal's first appearance out to refusal 20 — so this reds
      // against the old behaviour and greens against the per-kind counter.
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
      // Against the exported remedy constants, never `spendCapRefusalRemedy(kind)`
      // — comparing against the function under test would pass even if the
      // function itself regressed to the wrong text for a kind.
      expect(refusals[0]?.message).toContain(READ_FAULT_REMEDY);
      expect(refusals[0]?.message).not.toContain(BUDGET_REMEDY);
      expect(refusals[1]?.message).toContain(BUDGET_REMEDY);
      expect(refusals[1]?.message).not.toContain(READ_FAULT_REMEDY);
      expect(calls).toEqual([]);
    });

    it('leaves a single-kind stream throttled exactly as before (AC3)', async () => {
      // Per-kind counting is observationally identical to the old shared
      // counter when only one kind is ever seen, which is the count this pins.
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
      // 20 budget refusals, then 1 read_fault, then 20 more budget: if the
      // budget counter survives the read_fault refusal untouched, budget logs
      // at 1 and REFUSAL_LOG_EVERY, read_fault logs once at 1, and budget
      // resumes counting through the interleaving to log again at
      // 2 * REFUSAL_LOG_EVERY — 4 lines. A counter that resets on kind change
      // would instead restart the second budget run at 1, adding a 5th line.
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
