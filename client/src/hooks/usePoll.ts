import { useCallback, useEffect, useRef, useState } from 'react';
import { type FetchOutcome, fetchWire } from '../lib/api.ts';

export const POLL_INTERVAL_MS = 30_000;

export type PollStatus = 'waiting' | 'ok' | 'unauthorized' | 'contract-mismatch' | 'failed';

export interface PollState<T> {
  readonly data: T | null;
  readonly status: PollStatus;
  readonly error: string | null;
  readonly lastSuccessAt: number | null;
}

export interface PollOptions {
  readonly intervalMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

const WAITING = { data: null, status: 'waiting', error: null, lastSuccessAt: null } as const;

interface HeldState<T> extends PollState<T> {
  readonly url: string;
}

function nextHeld<T>(
  previous: HeldState<T>,
  outcome: FetchOutcome<T>,
  url: string,
  at: number,
): HeldState<T> {
  if (outcome.kind === 'ok') {
    return { data: outcome.body, status: 'ok', error: null, lastSuccessAt: at, url };
  }
  return {
    ...(previous.url === url ? previous : WAITING),
    status: outcome.kind,
    error: outcome.kind === 'failed' ? outcome.error : null,
    url,
  };
}

export function usePoll<T>(
  url: string,
  token: string | null,
  options: PollOptions = {},
): PollState<T> & { readonly refresh: () => void } {
  const { intervalMs = POLL_INTERVAL_MS, fetchImpl = fetch, now = Date.now } = options;
  const [held, setHeld] = useState<HeldState<T>>({ ...WAITING, url });
  const [tick, setTick] = useState(0);
  const latest = useRef({ fetchImpl, now });
  latest.current = { fetchImpl, now };

  const refresh = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    void tick;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const outcome = await fetchWire<T>(url, token, latest.current.fetchImpl, controller.signal);
      if (controller.signal.aborted) return;
      const at = latest.current.now();
      setHeld((previous) => nextHeld(previous, outcome, url, at));
      timer = setTimeout(() => void poll(), intervalMs);
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [url, token, intervalMs, tick]);

  const { url: heldUrl, ...state } = held;
  return heldUrl === url ? { ...state, refresh } : { ...WAITING, refresh };
}
