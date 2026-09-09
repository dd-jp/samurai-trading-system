import type { Clock } from '../../shared/index.js';
import { DebateBarDecisionGate } from './decision-bar-gate.js';
import { orderHeldFirst } from './flatten-tail-priority.js';
import { DEFAULT_UNIVERSE } from './scheduler.js';
import { runTickPlan } from './tick-loop.js';
import type { Logger, TickContext, TickOutcome, TickPlan, TickRunner } from './types.js';

interface Named {
  readonly asset: string;
}

const at = (...assets: string[]): Named[] => assets.map((asset) => ({ asset }));
const names = (instruments: readonly Named[]): string[] => instruments.map((i) => i.asset);

describe('orderHeldFirst (#1390)', () => {
  it('moves held instruments ahead of flat ones, preserving each group order', () => {
    // Mirrors the incident's fixed universe order: QQQ and AAPL already led,
    // but held lots further back (TSLA, META) queued behind flat names ahead
    // of them (AAPL..META spans several flats in DEFAULT_UNIVERSE).
    const instruments = at('QQQ', 'AAPL', 'TSLA', 'NVDA', 'AMD', 'META');
    const held = new Set(['QQQ', 'TSLA', 'META']);

    const ordered = orderHeldFirst(instruments, held);

    expect(names(ordered)).toEqual(['QQQ', 'TSLA', 'META', 'AAPL', 'NVDA', 'AMD']);
  });

  it('is a no-op ordering when nothing is held', () => {
    const instruments = at('QQQ', 'AAPL', 'TSLA');

    const ordered = orderHeldFirst(instruments, new Set());

    expect(names(ordered)).toEqual(['QQQ', 'AAPL', 'TSLA']);
  });

  it('is a no-op ordering when everything is held', () => {
    const instruments = at('QQQ', 'AAPL', 'TSLA');

    const ordered = orderHeldFirst(instruments, new Set(['QQQ', 'AAPL', 'TSLA']));

    expect(names(ordered)).toEqual(['QQQ', 'AAPL', 'TSLA']);
  });

  it('ignores held assets absent from the plan', () => {
    const instruments = at('QQQ', 'AAPL');

    const ordered = orderHeldFirst(instruments, new Set(['AMZN']));

    expect(names(ordered)).toEqual(['QQQ', 'AAPL']);
  });

  it('handles an empty plan', () => {
    expect(orderHeldFirst([], new Set(['QQQ']))).toEqual([]);
  });

  it('does not mutate its input array', () => {
    const instruments = at('QQQ', 'AAPL', 'TSLA');
    const snapshot = [...instruments];

    orderHeldFirst(instruments, new Set(['TSLA']));

    expect(instruments).toEqual(snapshot);
  });

  it('is stable within the held group when held membership repeats across a wider plan', () => {
    // Matches the ticket's 9-held-of-20 shape closely enough to pin ordering:
    // held members scattered through the fixed order come out in THEIR
    // original relative order, not resorted.
    const instruments = at(
      'QQQ',
      'AAPL',
      'TSLA',
      'NVDA',
      'AMD',
      'MSFT',
      'AMZN',
      'GOOGL',
      'META',
      'AVGO',
    );
    const held = new Set(['TSLA', 'AMD', 'AMZN', 'META']);

    const ordered = orderHeldFirst(instruments, held);

    expect(names(ordered)).toEqual([
      'TSLA',
      'AMD',
      'AMZN',
      'META',
      'QQQ',
      'AAPL',
      'NVDA',
      'MSFT',
      'GOOGL',
      'AVGO',
    ]);
  });
});

/**
 * Reproduces the 2026-09-08 incident (#1390's own measured table) at the
 * `runTickPlan` seam: `DEFAULT_UNIVERSE`'s 20 names, the same 9 held
 * positions the incident recorded (QQQ, AAPL, AMZN, NFLX, SMCI, PLTR, MSTR,
 * RIOT, UBER — positions 1, 2, 7, 11, 13, 14, 16, 18, 20).
 *
 * `TailSequencer` grants tails STRICTLY in plan order regardless of
 * completion order (`tick-loop.ts`'s "tail order is plan order" invariant,
 * already pinned by `phase-split.test.ts`). `tailArrivalOrder` below lets
 * every instrument run to completion and simply RECORDS that granted order;
 * a throughput ceiling ("the window only fits N tails before it closes") is
 * then the first N entries of that recording, sliced off AFTER the pass
 * settles. Gating turns inside the runner itself was tried and rejected: a
 * synchronous budget check racing every worker's initial dispatch saw every
 * instrument as "under budget" before any tail had actually settled, since
 * `max_concurrent_instruments` here equals the universe size and no worker's
 * own check can observe another's still-pending turn.
 */
function tailArrivalOrder(plan: TickPlan): {
  pending: Promise<TickOutcome[]>;
  order: () => string[];
} {
  // Records the TRUE order tails are granted in, per the invariant above —
  // not an order this helper imposes. A throughput ceiling ("the window
  // allows N tails") is then just the first N entries of this array, applied
  // by the caller AFTER the pass settles, so the ceiling can never leak back
  // into which instrument gets which turn.
  const order: string[] = [];
  const runner: TickRunner = {
    async runInstrument(signal, ctx) {
      await ctx.beginPortfolioTail?.();
      order.push(signal.asset);
      return { trace_id: ctx.trace_id, final_stage: 'execution' };
    },
  };

  const logger: Logger = { log: () => {} };
  const clock: Clock = { now: () => plan.tick_time };
  const pending = runTickPlan(plan, runner, clock, {
    max_concurrent_instruments: plan.instruments.length,
    logger,
    auditLog: { record: () => {} },
    currentTickStore: { upsert: () => {}, delete: () => {}, get: () => undefined },
    decisionGate: new DebateBarDecisionGate(),
  });
  return { pending, order: () => order };
}

describe('flatten-tail throughput at incident scale (#1390)', () => {
  const HELD = new Set(['QQQ', 'AAPL', 'AMZN', 'NFLX', 'SMCI', 'PLTR', 'MSTR', 'RIOT', 'UBER']);
  const universe = [...DEFAULT_UNIVERSE];
  const tickTime = new Date('2026-09-08T19:58:00Z');

  it(
    'MUTATION EVIDENCE — at the incident throughput, the fixed order reaches only 2 of 9 ' +
      'held lots; held-first ordering reaches 5 at the same throughput',
    async () => {
      const budget = 5; // roughly the incident's own throughput before the bell

      const fixed = tailArrivalOrder({ instruments: universe, tick_time: tickTime });
      await fixed.pending;
      const fixedHeldReached = fixed
        .order()
        .slice(0, budget)
        .filter((asset) => HELD.has(asset));

      const reordered = orderHeldFirst(universe, HELD);
      const withFix = tailArrivalOrder({ instruments: reordered, tick_time: tickTime });
      await withFix.pending;
      const reorderedHeldReached = withFix
        .order()
        .slice(0, budget)
        .filter((asset) => HELD.has(asset));

      // Fixed order: QQQ, AAPL, TSLA, NVDA, AMD get the first 5 turns — only
      // the first two are held, matching the incident's own "the two that sat
      // first in the list are the two that flattened".
      expect(fixed.order().slice(0, budget)).toEqual(['QQQ', 'AAPL', 'TSLA', 'NVDA', 'AMD']);
      expect(fixedHeldReached).toEqual(['QQQ', 'AAPL']);
      // Held-first: the first 5 turns all go to held instruments.
      expect(reorderedHeldReached).toEqual(['QQQ', 'AAPL', 'AMZN', 'NFLX', 'SMCI']);
      expect(reorderedHeldReached.length).toBeGreaterThan(fixedHeldReached.length);
    },
  );

  it('acceptance criterion 4 — a universe larger than the tail can serve still flattens every held lot, once throughput covers the held count', async () => {
    // 20 instruments, 9 held: the universe is larger than 9, so the tail
    // cannot serve everyone — but held-first ordering means "cannot serve
    // everyone" only ever costs FLAT instruments once the budget covers the
    // held count.
    const budget = HELD.size;

    const reordered = orderHeldFirst(universe, HELD);
    const withFix = tailArrivalOrder({ instruments: reordered, tick_time: tickTime });
    await withFix.pending;

    expect(new Set(withFix.order().slice(0, budget))).toEqual(HELD);

    // The fixed order, unpatched, misses most of them at the identical
    // budget — the defect this criterion exists to close.
    const unpatched = tailArrivalOrder({ instruments: universe, tick_time: tickTime });
    await unpatched.pending;
    const unpatchedHeldReached = unpatched
      .order()
      .slice(0, budget)
      .filter((asset) => HELD.has(asset));
    expect(unpatchedHeldReached.length).toBeLessThan(HELD.size);
  });
});

/**
 * Acceptance criterion 3: the exit path's tail latency does not depend on
 * debate latency. `tick-runner.ts`'s tick/decision split already guarantees
 * the exit check itself never calls `debate` (`SequentialTickRunner tick
 * pass (#743)`, `tick-runner.test.ts`) — what is new here is the SEQUENCING
 * half: with held-first ordering, a held instrument's tail is granted before
 * any flat instrument's, so it can never be made to wait on a flat
 * instrument's debate call even when that call never resolves.
 */
describe('a held lot flattens without waiting on a blocking flat instrument (#1390)', () => {
  it('reaches its tail even when a flat instrument ahead of it in the universe is stuck in debate', async () => {
    let debateBlocked: () => void = () => {};
    const debateGate = new Promise<void>((resolve) => {
      debateBlocked = resolve;
    });
    let heldReachedTail = false;

    const runner: TickRunner = {
      async runInstrument(signal: { asset: string }, ctx: TickContext): Promise<TickOutcome> {
        if (signal.asset === 'AAPL') {
          // Stands in for a flat instrument's decision pass stuck mid-debate
          // — never resolves within this test, simulating #1080/#1380's
          // saturation. It never reaches `beginPortfolioTail`.
          await debateGate;
          return { trace_id: ctx.trace_id, final_stage: 'debate' };
        }
        await ctx.beginPortfolioTail?.();
        heldReachedTail = true;
        return { trace_id: ctx.trace_id, final_stage: 'execution' };
      },
    };

    // QQQ (held) reordered ahead of AAPL (flat, blocking) even though AAPL
    // sits first in DEFAULT_UNIVERSE.
    const plan: TickPlan = {
      instruments: orderHeldFirst(
        [
          { asset: 'AAPL', asset_class: 'stocks' as const },
          { asset: 'QQQ', asset_class: 'stocks' as const },
        ],
        new Set(['QQQ']),
      ),
      tick_time: new Date('2026-09-08T19:58:00Z'),
    };

    const logger: Logger = { log: () => {} };
    const clock: Clock = { now: () => plan.tick_time };
    const pending = runTickPlan(plan, runner, clock, {
      max_concurrent_instruments: 2,
      logger,
      auditLog: { record: () => {} },
      currentTickStore: { upsert: () => {}, delete: () => {}, get: () => undefined },
      decisionGate: new DebateBarDecisionGate(),
    });

    // QQQ's tail settles without ever waiting for AAPL's blocked debate —
    // observed here by yielding one macrotask while AAPL is still stuck.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(heldReachedTail).toBe(true);

    debateBlocked();
    await pending;
  });
});
