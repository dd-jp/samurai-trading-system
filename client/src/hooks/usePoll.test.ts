// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse, overview } from '../test-wire.ts';
import { POLL_INTERVAL_MS, usePoll } from './usePoll.ts';

afterEach(() => vi.useRealTimers());

describe('usePoll', () => {
  it('polls every 30 seconds with the token and keeps the last good body', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const body = overview();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(body))
      .mockResolvedValueOnce(jsonResponse({ error: 'x' }, 503));
    const { result } = renderHook(() =>
      usePoll('/api/v2/overview', 'tok', { fetchImpl, now: () => 1_000 }),
    );
    expect(result.current.status).toBe('waiting');
    await waitFor(() => expect(result.current.status).toBe('ok'));
    expect(result.current).toMatchObject({ data: body, lastSuccessAt: 1_000, error: null });
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: 'Bearer tok' },
    });

    expect(POLL_INTERVAL_MS).toBe(30_000);
    await act(() => vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS));
    await waitFor(() => expect(result.current.status).toBe('failed'));
    expect(result.current).toMatchObject({ data: body, error: 'HTTP 503' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('refuses a body from a different contract version', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ ...overview(), contract_version: 'other' }));
    const { result } = renderHook(() => usePoll('/u', 'tok', { fetchImpl }));
    await waitFor(() => expect(result.current.status).toBe('contract-mismatch'));
    expect(result.current.data).toBeNull();
  });

  it('reports a missing token as unauthorized and sends no header', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}, 401));
    const { result } = renderHook(() => usePoll('/u', null, { fetchImpl }));
    await waitFor(() => expect(result.current.status).toBe('unauthorized'));
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ headers: {} });
  });

  it('reports a network failure, and refetches at once on refresh', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(jsonResponse(overview()));
    const { result } = renderHook(() => usePoll('/u', 't', { fetchImpl }));
    await waitFor(() => expect(result.current.error).toBe('offline'));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.status).toBe('ok'));
  });

  it('stops polling once unmounted', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(overview()));
    const { result, unmount } = renderHook(() => usePoll('/u', 't', { fetchImpl }));
    await waitFor(() => expect(result.current.status).toBe('ok'));
    unmount();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
