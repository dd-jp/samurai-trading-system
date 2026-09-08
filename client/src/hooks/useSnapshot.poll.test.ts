// @vitest-environment jsdom
//
// The POLL LOOP's failure behaviour (#606 item 3), as opposed to
// `useSnapshot.test.ts`, which covers the pure boundary check. These tests need
// timers and a mounted hook, so they live in their own jsdom file rather than
// pulling the pure suite into a DOM environment.
//
// The property under test is the one an operator only discovers by reloading:
// a dashboard that stopped polling looks exactly like a dashboard whose server
// went quiet. A hung request must therefore be abandoned by the CLIENT, not
// waited on indefinitely.
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { fakeFetch, HANGS, makeSnapshot } from '../test-fixtures.ts';
import { STALE_AFTER_MISSED_POLLS, useSnapshot } from './useSnapshot.ts';

/** Short enough to keep the suite fast; the ratios are what the code reads. */
const INTERVAL_MS = 20;

/**
 * A clock that advances with POLLS rather than with wall-clock time (#709).
 *
 * The staleness watchdog compares `now() - lastSuccessMs` against
 * `intervalMs * STALE_AFTER_MISSED_POLLS`, which at this interval is a 40ms
 * horizon. Against the real clock that is not a test, it is a race with the
 * machine: `waitFor` polls every 50ms by default, so under full-suite load the
 * assertion can only ever observe the state AFTER the horizon has passed, and
 * `stale` reads true for reasons that have nothing to do with the behaviour
 * under test. That is the flake in #709 — `expected true to be false`.
 *
 * Injecting the clock makes elapsed time a function of how many requests the
 * hook actually made. `fakeFetch` holds its last payload once the queue drains,
 * so every poll after the recovery succeeds and re-stamps `lastSuccessMs` to
 * the current reading — leaving `stale` false no matter how loaded the box is,
 * while a hang still advances time past the horizon and marks it true for real.
 *
 * The step is one full horizon plus an interval: enough that a single
 * unanswered poll genuinely trips the watchdog rather than approaching it.
 */
function pollDrivenClock(payloads: Parameters<typeof fakeFetch>[0]): {
  fetchImpl: typeof fetch;
  now: () => number;
} {
  // Derived, never `* 3`. The step has to exceed the watchdog's own horizon of
  // `INTERVAL_MS * STALE_AFTER_MISSED_POLLS`, and hardcoding the product only
  // held while that constant was 2. Raise it to 3 and a literal step would sit
  // exactly ON the horizon rather than past it, so a single hang would stop
  // tripping the watchdog and this test would quietly stop covering the
  // stale-then-recovered path — with the `now()` guard below still passing.
  const STEP_MS = INTERVAL_MS * (STALE_AFTER_MISSED_POLLS + 1);
  const inner = fakeFetch(payloads);
  let clockMs = 0;

  const fetchImpl = ((...args: Parameters<typeof fetch>) => {
    clockMs += STEP_MS;
    return inner(...args);
  }) as typeof fetch;

  return { fetchImpl, now: () => clockMs };
}

/**
 * Advances FAKE timers one `INTERVAL_MS` tick at a time until `predicate`
 * holds, flushing microtasks (`act`) after every step so a poll's own
 * promise chain settles before the next tick is considered.
 *
 * One tick can never straddle both a poll's start and its own
 * `INTERVAL_MS * STALE_AFTER_MISSED_POLLS` timeout budget, so stopping the
 * instant `predicate` is satisfied always leaves any timer that just fired
 * with its full budget ahead of it — the caller can act on that state
 * (resolve a gated fetch, read `error`) without a later, test-uncontrolled
 * tick racing in first. `step < 20` is a generous bound (400ms of virtual
 * time) against a `predicate` that never becomes true, not a tuned value.
 */
async function stepFakeTimersUntil(predicate: () => boolean): Promise<void> {
  for (let step = 0; !predicate() && step < 20; step += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    });
  }
}

/**
 * The first two calls hang like `HANGS`; the third waits on a gate the test
 * holds open, so "the payload lands" is an event the test fires rather than
 * one that falls out of Promise microtask scheduling racing the fake clock.
 */
function hangsTwiceThenGatedFetch(payload: unknown): {
  fetchImpl: typeof fetch;
  callCount: () => number;
  land: () => void;
} {
  let calls = 0;
  let resolveLanding = () => {};
  const landingGate = new Promise<void>((resolve) => {
    resolveLanding = resolve;
  });
  const fetchImpl = (async () => {
    calls += 1;
    if (calls <= 2) return new Promise<Response>(() => {});
    await landingGate;
    return { ok: true, status: 200, json: async () => payload } as Response;
  }) as typeof fetch;
  return { fetchImpl, callCount: () => calls, land: resolveLanding };
}

describe('useSnapshot polling', () => {
  it('abandons a poll that never answers, and the next tick still fires', async () => {
    // The first request hangs forever and ignores its abort signal — a server
    // that accepted the connection and never wrote to it. Before the timeout
    // existed, this wedged `inFlight` true for the life of the page: every
    // later `poll()` returned at the guard, no retry was ever issued, and only
    // a manual reload recovered. The second payload landing is the proof that
    // a retry happened.
    vi.useFakeTimers();
    try {
      const { fetchImpl, now } = pollDrivenClock([HANGS, makeSnapshot()]);
      const { result } = renderHook(() => useSnapshot({ fetchImpl, now, intervalMs: INTERVAL_MS }));

      await stepFakeTimersUntil(() => result.current.snapshot !== null);

      expect(result.current.snapshot?.as_of).toBe('2026-08-07T12:00:00.000Z');
      // The recovered poll clears the hang's error rather than leaving the page
      // reporting a failure it has since recovered from.
      expect(result.current.error).toBeNull();
      // Not stale BECAUSE a poll succeeded, not because the clock happened not to
      // have moved: the hang pushed the injected clock a full horizon past the
      // last success, so the watchdog had genuinely marked it stale before the
      // recovery landed and cleared it (#709).
      expect(result.current.stale).toBe(false);
      // Keeps the line above honest. If the injected clock ever stopped being
      // read — a renamed option, a default reinstated — `stale` would sit false
      // for want of elapsed time and the assertion would pass while testing
      // nothing. This fails in that case, because time only moves here when a
      // poll is issued.
      expect(now()).toBeGreaterThan(INTERVAL_MS * STALE_AFTER_MISSED_POLLS);
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies a poll that lands after earlier polls timed out', async () => {
    // PR #607 review round 1 read `timedOut` as effect-scoped and expected a
    // recovered poll to be discarded. It is declared per invocation, and this
    // is the behaviour that says so: TWO consecutive hangs, then a payload
    // that must be applied rather than swallowed by a previous poll's verdict.
    //
    // #1362: this used to run on real timers with `fakeFetch`'s instantly-
    // resolving third payload, racing the real 40ms budget against however
    // long the box took to actually run that resolution — flaking under
    // full-suite load, not on a hook defect. Fake timers plus a fetch the
    // test gates itself remove the race: the third payload lands only when
    // this test resolves it, never on wall-clock luck.
    vi.useFakeTimers();
    try {
      const timeoutMs = INTERVAL_MS * STALE_AFTER_MISSED_POLLS;
      const landing = makeSnapshot();
      const { fetchImpl, callCount, land } = hangsTwiceThenGatedFetch(landing);

      const { result } = renderHook(() => useSnapshot({ fetchImpl, intervalMs: INTERVAL_MS }));

      await stepFakeTimersUntil(() => callCount() >= 3);

      // The gate gives the test full control of the mechanism under test:
      // both hangs have genuinely timed out (their own `timedOut` flags
      // true), and the third poll is in flight but not yet resolved.
      expect(callCount()).toBe(3);
      expect(result.current.snapshot).toBeNull();
      expect(result.current.error).toBe(`snapshot request timed out after ${timeoutMs}ms`);

      await act(async () => {
        land();
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(result.current.snapshot).not.toBeNull();
      expect(result.current.error).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('exposes lastSuccessAt as the client clock, decoupled from a frozen generated_at (#1166)', async () => {
    // A single payload, reused by reference on every poll (`fakeFetch` clamps
    // to its last entry): `generated_at` never changes, modelling a stall in
    // the underlying data while the HTTP round trip keeps succeeding.
    const generatedAt = '2026-08-07T12:00:00.000Z';
    const payload = makeSnapshot({ generated_at: generatedAt });
    let clockMs = 1_000_000;
    const now = () => clockMs;

    const { result } = renderHook(() =>
      useSnapshot({ fetchImpl: fakeFetch([payload]), now, intervalMs: INTERVAL_MS }),
    );

    await waitFor(() => expect(result.current.lastSuccessAt).toBe(new Date(clockMs).toISOString()));
    const firstPoll = result.current.lastSuccessAt;

    clockMs += 60_000;
    await waitFor(() => expect(result.current.lastSuccessAt).toBe(new Date(clockMs).toISOString()));

    expect(result.current.lastSuccessAt).not.toBe(firstPoll);
    expect(result.current.snapshot?.generated_at).toBe(generatedAt);
  });

  it('names the timeout, and the budget it gave the request, while every poll hangs', async () => {
    const { result } = renderHook(() =>
      useSnapshot({ fetchImpl: fakeFetch([HANGS]), intervalMs: INTERVAL_MS }),
    );

    await waitFor(() => expect(result.current.error).not.toBeNull(), { timeout: 2_000 });
    // The message states the budget the request actually got, and that budget
    // is the staleness horizon — two missed polls at this cadence — rather than
    // an independently chosen number. Asserted through the operator-visible
    // string, because that is where the choice is observable; comparing
    // `pollTimeoutMs` to its own formula would only fail if someone edited the
    // implementation on purpose (PR #607 review round 1).
    expect(result.current.error).toBe(`snapshot request timed out after ${INTERVAL_MS * 2}ms`);
    // The clock-based watchdog is unchanged by any of this: a hang is stale
    // for the same reason a rejection is.
    await waitFor(() => expect(result.current.stale).toBe(true), { timeout: 2_000 });
  });
});
