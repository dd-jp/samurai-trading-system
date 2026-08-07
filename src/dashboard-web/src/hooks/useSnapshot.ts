/**
 * The 3-second `/api/snapshot` poll (issue #538; dashboard-spec.md
 * "hooks/useSnapshot.ts"). Owns three things and nothing else: the interval,
 * the staleness watchdog, and retention of the previous snapshot so the walk
 * planner has two observations to work from.
 *
 * Three properties this hook exists to guarantee, each of which is a way an
 * operator surface lies if it is missing:
 *
 *  1. **A failed poll never advances `previous`.** The walk plan is a function
 *     of (previous, next); if a failure shifted `previous <- snapshot` the next
 *     successful poll would replan from a snapshot it had already animated and
 *     replay the same transitions twice.
 *  2. **Staleness is measured against the clock, not against a failure
 *     counter.** A hung fetch never rejects, so a counter stays at zero while
 *     the data rots. The watchdog asks "how long since a successful poll",
 *     which is true of a hang, a rejection, and a 500 alike.
 *  3. **A stale poll keeps the last numbers.** They are marked stale by the
 *     strip, never blanked — a blank field reads as zero (spec, telemetry
 *     strip).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { DashboardSnapshot } from '../../../dashboard/types.ts';

/**
 * The client's view of the wire payload.
 *
 * Exactly the server's `DashboardSnapshot` since
 * [#539](https://github.com/dd-jp/samurai-trading-system/issues/539) added
 * `mode` to it — the client-side widening that stood in for the missing wire
 * field is gone, so the strip reads a real one. The alias stays because the
 * name says what it is (an untrusted payload off the network) at every use
 * site, and because the runtime is still allowed to hand us a payload from an
 * older server: `TelemetryStrip` validates `mode` against the two literals it
 * renders rather than trusting the type.
 */
export type WireSnapshot = DashboardSnapshot;

export const SNAPSHOT_URL = '/api/snapshot';
export const POLL_INTERVAL_MS = 3_000;
/** Two consecutive missed polls put the page into its stale state (spec). */
export const STALE_AFTER_MISSED_POLLS = 2;

export interface SnapshotFeed {
  /** The most recent successfully-fetched payload, or `null` before the first. */
  snapshot: WireSnapshot | null;
  /** The payload before it — the walk planner's `prev`. `null` on first paint. */
  previous: WireSnapshot | null;
  /** Increments once per successful poll. The identity effects key on. */
  revision: number;
  /** No previous snapshot has been rendered: place chips, do not walk (Motion rule 3). */
  firstPaint: boolean;
  /**
   * The tab was hidden when this payload arrived, so its transitions were never
   * observed by this client — snap on return rather than replay (Motion rule 4).
   */
  snapOnly: boolean;
  /** Two poll intervals have passed with no successful poll. */
  stale: boolean;
  /** `generated_at` of the last successful poll — what the stale label reports. */
  lastSuccessAt: string | null;
  /** Why the last poll failed, for the strip to name. `null` when the last poll worked. */
  error: string | null;
}

export interface UseSnapshotOptions {
  url?: string;
  intervalMs?: number;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injected for tests; defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Structural check on the parsed body. A dashboard served through a captive
 * portal or a misconfigured proxy answers `200` with HTML, and `JSON.parse`
 * failing is only one of the ways that goes wrong — a payload that parses but
 * carries no `pipeline.lanes` would render an empty theater as though the
 * system had gone quiet. Failing the check keeps the last good numbers on
 * screen and lets the watchdog mark them stale, which is the honest outcome.
 */
function isWireSnapshot(value: unknown): value is WireSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.generated_at !== 'string') return false;
  for (const key of ['positions', 'debates', 'verdicts', 'analysts']) {
    if (!Array.isArray(candidate[key])) return false;
  }
  for (const key of ['metrics', 'providers', 'llm_spend']) {
    const field = candidate[key];
    if (typeof field !== 'object' || field === null) return false;
  }
  const pipeline = candidate.pipeline;
  if (typeof pipeline !== 'object' || pipeline === null) return false;
  return Array.isArray((pipeline as Record<string, unknown>).lanes);
}

interface FeedState {
  snapshot: WireSnapshot | null;
  previous: WireSnapshot | null;
  revision: number;
  snapOnly: boolean;
  stale: boolean;
  error: string | null;
}

const INITIAL: FeedState = {
  snapshot: null,
  previous: null,
  revision: 0,
  snapOnly: false,
  stale: false,
  error: null,
};

function describeError(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

export function useSnapshot(options: UseSnapshotOptions = {}): SnapshotFeed {
  const { url = SNAPSHOT_URL, intervalMs = POLL_INTERVAL_MS, fetchImpl, now = Date.now } = options;

  const [state, setState] = useState<FeedState>(INITIAL);

  // A ref, not state: the interval callback must see the current url/fetch/now
  // without the effect being torn down and rebuilt, which would restart the
  // poll clock on every payload.
  const optionsRef = useRef({ url, fetchImpl, now });
  optionsRef.current = { url, fetchImpl, now };

  useEffect(() => {
    let cancelled = false;
    // Both of these are per-effect locals rather than refs on purpose. A ref
    // would outlive the effect, and a remount (React StrictMode does exactly
    // this in development) would then find `inFlight` still true from the
    // previous mount's aborted request and skip its own first poll — leaving
    // the page blank until the next interval tick.
    let inFlight = false;
    let lastSuccessMs = optionsRef.current.now();
    const controllers = new Set<AbortController>();

    const markStale = (stale: boolean) => {
      setState((prev) => (prev.stale === stale ? prev : { ...prev, stale }));
    };

    const poll = async () => {
      // A poll already in flight is not replaced: overlapping requests would
      // let an older response land after a newer one and walk the chips
      // backwards. The watchdog below is what notices a hang.
      if (inFlight) return;
      inFlight = true;
      const controller = new AbortController();
      controllers.add(controller);
      const doFetch = optionsRef.current.fetchImpl ?? globalThis.fetch;
      try {
        const response = await doFetch(optionsRef.current.url, {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`snapshot request failed: HTTP ${response.status}`);
        const body: unknown = await response.json();
        if (cancelled) return;
        if (!isWireSnapshot(body)) throw new Error('snapshot payload did not match the wire shape');
        lastSuccessMs = optionsRef.current.now();
        // `document.hidden` is read where the payload is APPLIED, not where the
        // request was issued: what matters is whether this client was in a
        // position to observe the transition, and a tab hidden for the whole
        // round trip is exactly the case Motion rule 4 snaps for.
        const hidden = typeof document !== 'undefined' && document.hidden;
        setState((prev) => ({
          snapshot: body,
          previous: prev.snapshot,
          revision: prev.revision + 1,
          snapOnly: hidden,
          stale: false,
          error: null,
        }));
      } catch (cause) {
        if (cancelled || controller.signal.aborted) return;
        // Deliberately leaves `snapshot`/`previous`/`revision` untouched: the
        // numbers stay on screen and the watchdog decides when they are stale.
        const message = describeError(cause);
        setState((prev) => (prev.error === message ? prev : { ...prev, error: message }));
      } finally {
        controllers.delete(controller);
        inFlight = false;
      }
    };

    void poll();

    const timer = setInterval(() => {
      // Evaluated on every tick, whether or not a request is outstanding: a
      // hung fetch never rejects, so a failure counter would sit at zero while
      // the data rots. "How long since a successful poll" is true of a hang, a
      // rejection and a 500 alike.
      markStale(optionsRef.current.now() - lastSuccessMs > intervalMs * STALE_AFTER_MISSED_POLLS);
      void poll();
    }, intervalMs);

    return () => {
      cancelled = true;
      clearInterval(timer);
      for (const controller of controllers) controller.abort();
    };
  }, [intervalMs]);

  return useMemo(
    () => ({
      snapshot: state.snapshot,
      previous: state.previous,
      revision: state.revision,
      firstPaint: state.previous === null,
      snapOnly: state.snapOnly,
      stale: state.stale,
      lastSuccessAt: state.snapshot?.generated_at ?? null,
      error: state.error,
    }),
    [state],
  );
}
