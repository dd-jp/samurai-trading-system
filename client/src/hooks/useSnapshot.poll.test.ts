// @vitest-environment jsdom
import { CONTRACT_VERSION } from '@contracts';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { fakeFetch, HANGS, makeSnapshot } from '../test-fixtures.ts';
import { STALE_AFTER_MISSED_POLLS, useSnapshot } from './useSnapshot.ts';

const INTERVAL_MS = 20;

function pollDrivenClock(payloads: Parameters<typeof fakeFetch>[0]): {
  fetchImpl: typeof fetch;
  now: () => number;
} {
  const STEP_MS = INTERVAL_MS * (STALE_AFTER_MISSED_POLLS + 1);
  const inner = fakeFetch(payloads);
  let clockMs = 0;

  const fetchImpl = ((...args: Parameters<typeof fetch>) => {
    clockMs += STEP_MS;
    return inner(...args);
  }) as typeof fetch;

  return { fetchImpl, now: () => clockMs };
}

async function stepFakeTimersUntil(predicate: () => boolean): Promise<void> {
  const MAX_STEPS = 20;
  for (let step = 0; step < MAX_STEPS; step += 1) {
    if (predicate()) return;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    });
  }
  if (predicate()) return;
  throw new Error(`stepFakeTimersUntil: predicate still false after ${MAX_STEPS} steps`);
}

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
    vi.useFakeTimers();
    try {
      const { fetchImpl, now } = pollDrivenClock([HANGS, makeSnapshot()]);
      const { result } = renderHook(() => useSnapshot({ fetchImpl, now, intervalMs: INTERVAL_MS }));

      await stepFakeTimersUntil(() => result.current.snapshot !== null);

      expect(result.current.snapshot?.as_of).toBe('2026-08-07T12:00:00.000Z');
      expect(result.current.error).toBeNull();
      expect(result.current.status).toBe('alive');
      expect(now()).toBeGreaterThan(INTERVAL_MS * STALE_AFTER_MISSED_POLLS);
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies a poll that lands after earlier polls timed out', async () => {
    vi.useFakeTimers();
    try {
      const timeoutMs = INTERVAL_MS * STALE_AFTER_MISSED_POLLS;
      const landing = makeSnapshot();
      const { fetchImpl, callCount, land } = hangsTwiceThenGatedFetch(landing);

      const { result } = renderHook(() => useSnapshot({ fetchImpl, intervalMs: INTERVAL_MS }));

      await stepFakeTimersUntil(() => callCount() >= 3);

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
    expect(result.current.error).toBe(`snapshot request timed out after ${INTERVAL_MS * 2}ms`);
    expect(result.current.status).toBe('waiting');
  });
});

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
    expect(staleServerPayload.alert_delivery_failures_24h).toBe(0);

    const { result } = renderHook(() =>
      useSnapshot({ fetchImpl: fakeFetch([staleServerPayload]), intervalMs: INTERVAL_MS }),
    );

    await waitFor(() => expect(result.current.status).toBe('contract-mismatch'));
    expect(result.current.error).toMatch(/contract/i);
    expect(result.current.error).not.toMatch(/did not match the wire shape/);
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
