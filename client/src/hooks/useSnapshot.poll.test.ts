// @vitest-environment jsdom
//
// The POLL LOOP's failure behaviour (#606 item 3), as opposed to
// `useSnapshot.test.ts`, which covers the pure boundary check. These tests need
// timers and a mounted hook, so they live in their own jsdom file rather than
// pulling the pure suite into a DOM environment
//
// The property under test is the one an operator only discovers by reloading:
// a dashboard that stopped polling looks exactly like a dashboard whose server
// went quiet. A hung request must therefore be abandoned by the CLIENT, not
// waited on indefinitely
import { CONTRACT_VERSION } from '@contracts';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { fakeFetch, HANGS, makeSnapshot } from '../test-fixtures.ts';
import { STALE_AFTER_MISSED_POLLS, useSnapshot } from './useSnapshot.ts';

/** Short enough to keep the suite fast; the ratios are what the code reads */
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
  // stale-then-recovered path — with the `now()` guard below still passing
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
 * `poll()` only ever starts on an interval-tick boundary — a multiple of
 * `INTERVAL_MS` — so a poll that starts on the step where `predicate` first
 * becomes true always has its full `INTERVAL_MS * STALE_AFTER_MISSED_POLLS`
 * timeout still ahead of it: that timeout is a LATER multiple of
 * `INTERVAL_MS`, and a single `INTERVAL_MS` step cannot reach it in the same
 * step it started in. Stopping the instant `predicate` holds therefore
 * always leaves that poll's timeout un-fired, whatever order the fake-timer
 * engine processes same-instant timers in.
 *
 * Throws instead of returning silently on exhaustion, so a `predicate` that
 * never becomes true fails here — naming the loop — rather than surfacing
 * later as an assertion on state the loop never reached.
 */
async function stepFakeTimersUntil(predicate: () => boolean): Promise<void> {
  const MAX_STEPS = 20; // 400ms of virtual time; generous, not tuned
  for (let step = 0; step < MAX_STEPS; step += 1) {
    if (predicate()) return;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    });
  }
  if (predicate()) return;
  throw new Error(`stepFakeTimersUntil: predicate still false after ${MAX_STEPS} steps`);
}

/**
 * Repeatedly flushes microtasks via a zero-length fake-timer advance —
 * crossing no virtual-time boundary, so no timer already scheduled can fire
 * here — until `predicate` holds.
 *
 * A gated fetch's resolution reaches `result.current` through several
 * chained awaits inside the hook (the gate, `response.json()`, the
 * `timedOut` check, `setState`). A fixed flush count would tie this to that
 * chain's exact length and silently under-flush if it ever grew by one hop;
 * looping on the actual observable removes that coupling.
 */
async function flushMicrotasksUntil(predicate: () => boolean): Promise<void> {
  const MAX_FLUSHES = 10;
  for (let flush = 0; flush < MAX_FLUSHES; flush += 1) {
    if (predicate()) return;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }
  if (predicate()) return;
  throw new Error(`flushMicrotasksUntil: predicate still false after ${MAX_FLUSHES} flushes`);
}

/**
 * The first two calls hang like `HANGS`; the third waits on a gate the test
 * holds open, so "the payload lands" is an event the test fires rather than
 * one that falls out of Promise microtask scheduling racing the fake clock
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
    // a retry happened
    vi.useFakeTimers();
    try {
      const { fetchImpl, now } = pollDrivenClock([HANGS, makeSnapshot()]);
      const { result } = renderHook(() => useSnapshot({ fetchImpl, now, intervalMs: INTERVAL_MS }));

      await stepFakeTimersUntil(() => result.current.snapshot !== null);

      expect(result.current.snapshot?.as_of).toBe('2026-08-07T12:00:00.000Z');
      // The recovered poll clears the hang's error rather than leaving the page
      // reporting a failure it has since recovered from
      expect(result.current.error).toBeNull();
      // Not stale BECAUSE a poll succeeded, not because the clock happened not to
      // have moved: the hang pushed the injected clock a full horizon past the
      // last success, so the watchdog had genuinely marked it stale before the
      // recovery landed and cleared it (#709)
      expect(result.current.status).toBe('alive');
      // Keeps the line above honest. If the injected clock ever stopped being
      // read — a renamed option, a default reinstated — the status would sit alive
      // for want of elapsed time and the assertion would pass while testing
      // nothing. This fails in that case, because time only moves here when a
      // poll is issued
      expect(now()).toBeGreaterThan(INTERVAL_MS * STALE_AFTER_MISSED_POLLS);
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies a poll that lands after earlier polls timed out', async () => {
    // PR #607 review round 1 read `timedOut` as effect-scoped and expected a
    // recovered poll to be discarded. It is declared per invocation, and this
    // is the behaviour that says so: TWO consecutive hangs, then a payload
    // that must be applied rather than swallowed by a previous poll's verdict
    //
    // #1362: this used to run on real timers, and `waitFor(snapshot !== null)`
    // followed by `expect(error).toBeNull()` are two SEPARATE reads of
    // `result.current`, a tick apart. Under full-suite load, a poll AFTER the
    // one `waitFor` had already observed succeeding could have its own
    // resolution delayed past its 40ms budget; its timeout handler spreads
    // `prev`, so `snapshot` stayed set while `error` was overwritten by that
    // later poll's timeout — a race between two assertions, not a hook
    // defect. Fake timers plus a fetch the test gates itself mean no poll
    // this test does not explicitly drive can ever fire between them
    vi.useFakeTimers();
    try {
      const timeoutMs = INTERVAL_MS * STALE_AFTER_MISSED_POLLS;
      const landing = makeSnapshot();
      const { fetchImpl, callCount, land } = hangsTwiceThenGatedFetch(landing);

      const { result } = renderHook(() => useSnapshot({ fetchImpl, intervalMs: INTERVAL_MS }));

      await stepFakeTimersUntil(() => callCount() >= 3);

      // The gate gives the test full control of the mechanism under test:
      // both hangs have genuinely timed out (their own `timedOut` flags
      // true), and the third poll is in flight but not yet resolved
      expect(callCount()).toBe(3);
      expect(result.current.snapshot).toBeNull();
      expect(result.current.error).toBe(`snapshot request timed out after ${timeoutMs}ms`);

      land();
      await flushMicrotasksUntil(() => result.current.snapshot !== null);

      expect(result.current.snapshot?.as_of).toBe(landing.as_of);
      expect(result.current.error).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('exposes lastSuccessAt as the client clock, decoupled from a frozen generated_at (#1166)', async () => {
    // A single payload, reused by reference on every poll (`fakeFetch` clamps
    // to its last entry): `generated_at` never changes, modelling a stall in
    // the underlying data while the HTTP round trip keeps succeeding
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
    // implementation on purpose (PR #607 review round 1)
    expect(result.current.error).toBe(`snapshot request timed out after ${INTERVAL_MS * 2}ms`);
    // Still WAITING, never STALE: nothing has ever landed, so there are no
    // numbers to call old — the honest reading, and the one the page-level
    // cold start renders (#1520). The timeout above is what names the failure.
    expect(result.current.status).toBe('waiting');
  });
});

/**
 * #1038: the client's only network primitive is this poll, and the dashboard
 * has no other way to supply the credential a configured
 * `SAMURAI_DASHBOARD_TOKEN` now requires per request (`request-auth.ts`,
 * server-side). Local, recording `fetchImpl` here rather than reusing the
 * shared `fakeFetch` fixture (`test-fixtures.ts`) — that fixture's `impl`
 * takes no parameters and cannot observe what `init` a caller passed, and
 * widening a fixture other suites depend on for this one feature is a wider
 * change than the ruling asked for.
 */
function recordingFetch(payload: unknown): {
  fetchImpl: typeof fetch;
  lastInit: () => RequestInit | undefined;
  lastUrl: () => unknown;
} {
  let lastInit: RequestInit | undefined;
  let lastUrl: unknown;
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    lastUrl = input;
    lastInit = init;
    return { ok: true, status: 200, json: async () => payload } as Response;
  }) as typeof fetch;
  return { fetchImpl, lastInit: () => lastInit, lastUrl: () => lastUrl };
}

/**
 * #1316: the served client bundle and the answering server can disagree
 * about the wire shape in either direction — a rebuild-without-restart
 * serving a newer client against an older running server (`server.ts` serves
 * `dist/client/` per request with `Cache-Control: no-cache`), or a
 * long-lived operator tab holding an old client against a server that has
 * since restarted on new code. Before this field existed, that skew was
 * silent: a renamed or dropped field simply read as absent, and
 * `Rail.tsx`'s `AlertDeliveryBlock` collapsed that absence into a healthy
 * zero (`?? 0`) — the bug #1316 is named for. These tests are the mutation
 * evidence: each fails against `useSnapshot.ts` as it stood before this
 * change (no `contract_version` comparison existed at all — every payload
 * below would have been accepted as a normal, healthy poll) and passes
 * after.
 */
describe('useSnapshot — contract mismatch (#1316)', () => {
  it('is a healthy poll when the payload carries the client’s own contract_version', async () => {
    const { result } = renderHook(() =>
      useSnapshot({ fetchImpl: fakeFetch([makeSnapshot()]), intervalMs: INTERVAL_MS }),
    );

    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    expect(result.current.status).toBe('alive');
    expect(result.current.error).toBeNull();
  });

  it('reports contract-mismatch, not a healthy zero, when contract_version is absent (old-server/new-client)', async () => {
    const staleServerPayload = makeSnapshot() as unknown as Record<string, unknown>;
    delete staleServerPayload.contract_version;
    // Old-server behaviour, pinned directly: `alert_delivery_failures_24h`
    // absent too would already fail `hasWireShape`'s literal field checks in
    // other ways, so this payload otherwise validates — the ONLY thing wrong
    // with it is the missing version, which is exactly the skew this test
    // exists to catch rather than let fall through as a healthy read
    expect(staleServerPayload.alert_delivery_failures_24h).toBe(0);

    const { result } = renderHook(() =>
      useSnapshot({ fetchImpl: fakeFetch([staleServerPayload]), intervalMs: INTERVAL_MS }),
    );

    await waitFor(() => expect(result.current.status).toBe('contract-mismatch'));
    // Not routed through the generic "did not match the wire shape" rejection
    // — the error names the skew specifically, not a proxy/captive-portal-
    // shaped failure
    expect(result.current.error).toMatch(/contract/i);
    expect(result.current.error).not.toMatch(/did not match the wire shape/);
    // Never silently treated as healthy: no snapshot is admitted from a
    // payload this client could not validate the shape of
    expect(result.current.snapshot).toBeNull();
  });

  it('reports contract-mismatch when contract_version is present but does not equal this client’s constant (new-server/old-client)', async () => {
    const newerServerPayload = makeSnapshot({
      contract_version: `${CONTRACT_VERSION}-different`,
    });

    const { result } = renderHook(() =>
      useSnapshot({ fetchImpl: fakeFetch([newerServerPayload]), intervalMs: INTERVAL_MS }),
    );

    await waitFor(() => expect(result.current.status).toBe('contract-mismatch'));
    expect(result.current.error).toContain(CONTRACT_VERSION);
    expect(result.current.snapshot).toBeNull();
  });

  it('diagnoses the mismatch specifically even when the same skew would ALSO fail the structural check', async () => {
    // A renamed field is exactly what #1316's decision comment names as the
    // motivating case: it fails `hasWireShape` too (no `positions` array),
    // and the version check must win the race to explain why, rather than
    // the generic structural rejection masking a diagnosable skew
    const renamed = makeSnapshot() as unknown as Record<string, unknown>;
    renamed.open_positions = renamed.positions;
    delete renamed.positions;
    delete renamed.contract_version;

    const { result } = renderHook(() =>
      useSnapshot({ fetchImpl: fakeFetch([renamed]), intervalMs: INTERVAL_MS }),
    );

    await waitFor(() => expect(result.current.status).toBe('contract-mismatch'));
    expect(result.current.error).toMatch(/contract/i);
  });

  it('clears a mismatch and resumes reading the feed once a poll lands with the matching contract_version', async () => {
    // Fake timers, like the file's other multi-poll tests above: under real
    // timers this raced flaky (the healthy poll's state landing observed
    // before the mismatched poll's had fully settled) — the same flake class
    // `pollDrivenClock`'s doc comment exists to explain, one poll earlier
    vi.useFakeTimers();
    try {
      const staleServerPayload = makeSnapshot() as unknown as Record<string, unknown>;
      delete staleServerPayload.contract_version;
      const healthy = makeSnapshot();

      const { result } = renderHook(() =>
        useSnapshot({
          fetchImpl: fakeFetch([staleServerPayload, healthy]),
          intervalMs: INTERVAL_MS,
        }),
      );

      await stepFakeTimersUntil(() => result.current.status === 'contract-mismatch');
      await stepFakeTimersUntil(() => result.current.status === 'alive');
      expect(result.current.snapshot).not.toBeNull();
      expect(result.current.error).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not advance lastSuccessAt on a mismatched poll — it is not a success by either measure', async () => {
    const staleServerPayload = makeSnapshot() as unknown as Record<string, unknown>;
    delete staleServerPayload.contract_version;

    const { result } = renderHook(() =>
      useSnapshot({ fetchImpl: fakeFetch([staleServerPayload]), intervalMs: INTERVAL_MS }),
    );

    await waitFor(() => expect(result.current.status).toBe('contract-mismatch'));
    expect(result.current.lastSuccessAt).toBeNull();
  });
});

describe('useSnapshot — Authorization header (#1038)', () => {
  it('sends no Authorization header when authToken is absent — the default, no-credential path', async () => {
    const { fetchImpl, lastInit } = recordingFetch(makeSnapshot());
    const { result } = renderHook(() => useSnapshot({ fetchImpl, intervalMs: INTERVAL_MS }));

    await waitFor(() => expect(result.current.snapshot).not.toBeNull());

    const headers = lastInit()?.headers as Record<string, string> | undefined;
    expect(headers === undefined || headers.Authorization === undefined).toBe(true);
  });

  it('sends no Authorization header when authToken is null or empty', async () => {
    for (const authToken of [null, ''] as const) {
      const { fetchImpl, lastInit } = recordingFetch(makeSnapshot());
      const { result } = renderHook(() =>
        useSnapshot({ fetchImpl, intervalMs: INTERVAL_MS, authToken }),
      );

      await waitFor(() => expect(result.current.snapshot).not.toBeNull());

      const headers = lastInit()?.headers as Record<string, string> | undefined;
      expect(headers === undefined || headers.Authorization === undefined).toBe(true);
    }
  });

  it('sends Authorization: Bearer <authToken> on every poll once a token is supplied', async () => {
    const { fetchImpl, lastInit } = recordingFetch(makeSnapshot());
    const { result } = renderHook(() =>
      useSnapshot({ fetchImpl, intervalMs: INTERVAL_MS, authToken: 'fixture-dashboard-token' }),
    );

    await waitFor(() => expect(result.current.snapshot).not.toBeNull());

    const headers = lastInit()?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBe('Bearer fixture-dashboard-token');
  });
});

/**
 * #1593: the poll's request URL, end to end through the hook — not just
 * `snapshotUrl` in isolation (`useSnapshot.test.ts`). This is the mutation
 * evidence that the hook actually calls that helper rather than the raw
 * `optionsRef.current.url`: reverting the `poll()` fetch call to the
 * pre-#1593 line (`doFetch(optionsRef.current.url, …)`) makes the third case
 * below fail, since `arm` would then have nowhere to reach the request from.
 */
describe('useSnapshot — arm query param (#1593)', () => {
  it('polls the plain URL when arm is not given', async () => {
    const { fetchImpl, lastUrl } = recordingFetch(makeSnapshot());
    const { result } = renderHook(() => useSnapshot({ fetchImpl, intervalMs: INTERVAL_MS }));

    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    expect(lastUrl()).toBe('/api/snapshot');
  });

  it('polls the plain URL when arm is explicitly live', async () => {
    const { fetchImpl, lastUrl } = recordingFetch(makeSnapshot());
    const { result } = renderHook(() =>
      useSnapshot({ fetchImpl, intervalMs: INTERVAL_MS, arm: 'live' }),
    );

    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    expect(lastUrl()).toBe('/api/snapshot');
  });

  it('polls ?arm=control when arm is control', async () => {
    const { fetchImpl, lastUrl } = recordingFetch(makeSnapshot());
    const { result } = renderHook(() =>
      useSnapshot({ fetchImpl, intervalMs: INTERVAL_MS, arm: 'control' }),
    );

    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    expect(lastUrl()).toBe('/api/snapshot?arm=control');
  });
});
