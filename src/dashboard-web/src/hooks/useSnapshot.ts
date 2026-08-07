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

/** The modes the server may send (`DashboardSnapshot['mode']`, #539). */
type ServerMode = DashboardSnapshot['mode'];

/**
 * The same list at runtime, for the boundary check below. `satisfies` rather
 * than a bare array so a value that is not a real server mode cannot be added
 * here by hand.
 */
export const RECOGNISED_MODES = [
  'paper',
  'live',
  'backtest',
] as const satisfies readonly ServerMode[];

/**
 * The client's view of the wire payload: the server's `DashboardSnapshot`
 * with `mode` widened to `| null` — and NARROWED at the fetch boundary by
 * `toWireSnapshot`, so every consumer downstream can trust it.
 *
 * Not a plain alias of `DashboardSnapshot` (PR #597 review). That version
 * asserted `mode` was always one of three literals while its own docblock
 * admitted an older server or a rewriting proxy may omit it — leaving
 * `TelemetryStrip`'s literal check as the only thing standing between a
 * missing field and a mis-render, and the next consumer to read
 * `snapshot.mode` would have trusted the type and been wrong. A type that
 * lies is worse than one that is wide: `null` is the honest name for "the
 * server did not tell us", it is unrepresentable as a mode word, and the
 * compiler now forces every reader to handle it.
 */
export type WireSnapshot = Omit<DashboardSnapshot, 'mode'> & { mode: ServerMode | null };

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
function hasWireShape(value: unknown): boolean {
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

/**
 * Validates a parsed body ONCE, at the fetch boundary, and returns it with
 * `mode` narrowed — or `null` if it is not a snapshot at all.
 *
 * `mode` is deliberately NOT part of the structural check above: an
 * unrecognised or absent mode must not throw the whole payload away, because
 * positions, verdicts and the pipeline are still true and the strip has an
 * honest rendering for an unknown mode ("mode unknown"). Discarding a good
 * snapshot over one bad field would blank the screen an operator is watching
 * live money on — the opposite of what the field is for. So it degrades to
 * `null` here rather than rejecting, and nothing downstream has to re-check.
 *
 * A mode the server sends but this client does not list is treated as unknown
 * rather than passed through: rendering a word we have never seen would be
 * the "trust the wire" failure this function exists to end.
 */
export function toWireSnapshot(body: unknown): WireSnapshot | null {
  if (!hasWireShape(body)) return null;
  const candidate = body as Record<string, unknown>;
  const mode = (RECOGNISED_MODES as readonly string[]).includes(candidate.mode as string)
    ? (candidate.mode as ServerMode)
    : null;
  return { ...(candidate as unknown as Omit<WireSnapshot, 'mode'>), mode };
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
        const snapshot = toWireSnapshot(body);
        if (snapshot === null) throw new Error('snapshot payload did not match the wire shape');
        lastSuccessMs = optionsRef.current.now();
        // `document.hidden` is read where the payload is APPLIED, not where the
        // request was issued: what matters is whether this client was in a
        // position to observe the transition, and a tab hidden for the whole
        // round trip is exactly the case Motion rule 4 snaps for.
        const hidden = typeof document !== 'undefined' && document.hidden;
        setState((prev) => ({
          snapshot,
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
