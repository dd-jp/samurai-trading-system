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
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { fakeFetch, HANGS, makeSnapshot } from '../test-fixtures.ts';
import { useSnapshot } from './useSnapshot.ts';

/** Short enough to keep the suite fast; the ratios are what the code reads. */
const INTERVAL_MS = 20;

describe('useSnapshot polling', () => {
  it('abandons a poll that never answers, and the next tick still fires', async () => {
    // The first request hangs forever and ignores its abort signal — a server
    // that accepted the connection and never wrote to it. Before the timeout
    // existed, this wedged `inFlight` true for the life of the page: every
    // later `poll()` returned at the guard, no retry was ever issued, and only
    // a manual reload recovered. The second payload landing is the proof that
    // a retry happened.
    const { result } = renderHook(() =>
      useSnapshot({ fetchImpl: fakeFetch([HANGS, makeSnapshot()]), intervalMs: INTERVAL_MS }),
    );

    await waitFor(() => expect(result.current.snapshot).not.toBeNull(), { timeout: 2_000 });
    expect(result.current.snapshot?.as_of).toBe('2026-08-07T12:00:00.000Z');
    // The recovered poll clears the hang's error rather than leaving the page
    // reporting a failure it has since recovered from.
    expect(result.current.error).toBeNull();
    expect(result.current.stale).toBe(false);
  });

  it('applies a poll that lands after earlier polls timed out', async () => {
    // PR #607 review round 1 read `timedOut` as effect-scoped and expected a
    // recovered poll to be discarded. It is declared per invocation, and this
    // is the behaviour that says so: TWO consecutive hangs, then a payload
    // that must be applied rather than swallowed by a previous poll's verdict.
    const { result } = renderHook(() =>
      useSnapshot({
        fetchImpl: fakeFetch([HANGS, HANGS, makeSnapshot()]),
        intervalMs: INTERVAL_MS,
      }),
    );

    await waitFor(() => expect(result.current.snapshot).not.toBeNull(), { timeout: 3_000 });
    expect(result.current.error).toBeNull();
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
