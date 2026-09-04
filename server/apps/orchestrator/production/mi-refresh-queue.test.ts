/**
 * `MiRefreshQueue` (#1085) — the three properties the queue exists for.
 *
 * 1. The analyst stage no longer blocks on a live MI LLM call.
 * 2. Two metered MI calls cannot both pass a spend check the pair would fail —
 *    including ACROSS instruments, which the sequential composition never
 *    covered, because #1013 admits several instrument passes concurrently.
 * 3. An MI failure still degrades to "no new intelligence" and never escapes.
 */
import type { SpendCap, SpendCapVerdict } from '../../../pipeline/debate-engine/index.js';
import type { LogEntry, Logger } from '../../../shared/index.js';
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
 * breach — the `GrokAgent` shape, which is the only MI agent that carries its
 * own `SpendCap`.
 */
function capReadingRefresher(
  cap: SpendCap & { spentUsd: number },
  costUsd: number,
  calls: string[],
): MarketIntelligenceRefresh {
  return {
    async refresh(_trace_id, instrument) {
      if (!cap.check().admitted) return false;
      calls.push(instrument);
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

  it('holds the pair inside the budget only while the agent that reads no cap runs FIRST', async () => {
    // The queue's ONE check covers a WHOLE composed pass, so within a pass the
    // agents' order is load-bearing and the root's `[miIngestAgent, grokAgent]`
    // is the safe one. `MiIngestAgent` bills through the shared `LlmClient` and
    // reads no cap; `GrokAgent` re-reads the cap itself before it calls. Ingest
    // first means Grok's own read sees the POST-ingest total and refuses. This
    // is `A` (bills, reads nothing) then `B` (reads, refuses, bills).
    const cap = meteredCap(1);
    const calls: string[] = [];
    const queue = new MiRefreshQueue({
      spendCap: cap,
      refresher: composePair(billingRefresher(cap, 1, calls), capReadingRefresher(cap, 1, calls)),
    });

    await queue.refresh('tick-1', 'TSLA', 'stocks');
    await settle();

    // On SPEND, not on which names ran: the invariant is the budget, and an
    // index assertion would still pass for a pair that both called and both
    // billed. EXACTLY the budget, not "at most" — `<= 1` would also pass for a
    // pass that spent nothing at all, which is what a queue refusing
    // everything looks like.
    expect(cap.spentUsd).toBe(1);
  });

  it('and overshoots when that order is reversed, which is why the order is an invariant', async () => {
    // Same queue, same single check, same budget — only the composition order
    // changes. `B` reads a total no one has moved yet and admits itself, then
    // `A` bills under a check made before either ran. Exactly what AC2 forbids,
    // reachable today by editing one array at the composition root.
    const cap = meteredCap(1);
    const calls: string[] = [];
    const queue = new MiRefreshQueue({
      spendCap: cap,
      refresher: composePair(capReadingRefresher(cap, 1, calls), billingRefresher(cap, 1, calls)),
    });

    await queue.refresh('tick-1', 'TSLA', 'stocks');
    await settle();

    // Exactly double the budget: both agents called, neither stopped by a check
    // the pair fails. `> 1` would leave the size of the breach unpinned.
    expect(cap.spentUsd).toBe(2);
  });

  it('refuses a queued refresh once the cap is reached, logging the first then every Nth', async () => {
    // The news-scoring path (`MiIngestAgent` -> `scoreItems` -> the shared
    // `LlmClient`) meters into `llm_spend` and reads no cap at all, so this
    // check is the first ceiling it has ever had.
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
});
