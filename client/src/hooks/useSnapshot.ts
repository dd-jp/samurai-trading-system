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
 *  4. **Every poll is bounded in time.** A hung request (the server accepts
 *     the connection and never answers) is abandoned at the staleness horizon
 *     and its slot released, so the next tick retries. Without that, one hang
 *     wedges the in-flight guard forever: the watchdog still marks the page
 *     stale, but no retry is ever issued and only a manual reload recovers —
 *     the worst failure mode for an always-on surface, because the page looks
 *     like it is trying (#606 item 3).
 */

import type { DashboardSnapshot, LlmSpendSummary } from '@contracts';
import { useEffect, useMemo, useRef, useState } from 'react';

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
export type WireSnapshot = Omit<DashboardSnapshot, 'mode' | 'llm_spend'> & {
  mode: ServerMode | null;
  /**
   * Widened to `| null` for the same reason `mode` is, and settled the same
   * way (#606 item 2). `SpendPanel` takes `LlmSpendSummary | null` and renders
   * a deliberate empty state naming the reason, and `TelemetryStrip`'s burn
   * meter renders "meter not drawable" — so both consumers of this field
   * already degrade honestly, and the boundary rejecting the payload was the
   * only thing standing between a missing spend read and those renderings.
   *
   * The server cannot send `null` today: `DashboardSnapshot.llm_spend` is
   * non-nullable and a failed `getLlmSpend` throws out of `buildSnapshot`,
   * which the server answers as a 500 (`server.ts`) — a case the `!response.ok`
   * path below already survives. This is therefore a boundary POLICY fix, not
   * a live bug: an older server or a rewriting proxy is outside that guarantee,
   * and discarding positions, verdicts and the pipeline over one absent
   * summary would blank a live-money screen exactly as the `mode` docblock
   * below forbids.
   */
  llm_spend: LlmSpendSummary | null;
};

export const SNAPSHOT_URL = '/api/snapshot';
export const POLL_INTERVAL_MS = 3_000;
/** Two consecutive missed polls put the page into its stale state (spec). */
export const STALE_AFTER_MISSED_POLLS = 2;
/**
 * How long a single poll may hang before it is abandoned (#606 item 3).
 *
 * Tied to the staleness horizon rather than picked independently: a request is
 * given exactly as long as the page is willing to keep calling its numbers
 * current, so the slot is released at the same instant the watchdog admits the
 * page is stale, and the NEXT interval tick retries. Anything longer leaves a
 * window where the strip says stale while a zombie request still holds the
 * poll slot; anything shorter would abandon a merely slow response the page
 * could still have used.
 */
function pollTimeoutMs(intervalMs: number): number {
  return intervalMs * STALE_AFTER_MISSED_POLLS;
}

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
  // `llm_spend` is deliberately NOT required here — see `WireSnapshot`. It is
  // narrowed to `null` by `toWireSnapshot` instead, so an absent summary costs
  // one panel its numbers rather than costing the operator the whole page.
  for (const key of ['metrics', 'providers']) {
    const field = candidate[key];
    if (typeof field !== 'object' || field === null) return false;
  }
  const pipeline = candidate.pipeline;
  if (typeof pipeline !== 'object' || pipeline === null) return false;
  return Array.isArray((pipeline as Record<string, unknown>).lanes);
}

/** A non-null object that is not an array — `typeof [] === 'object'`. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Is this shape one `SpendPanel` and the burn meter can actually render?
 *
 * The depth is chosen from what the consumers DEREFERENCE, not from the type
 * (PR #607 review). Every scalar they read goes through `formatUsd` /
 * `formatCount` / `formatStageDuration`, which return the module's em dash for
 * anything non-finite — so a window missing `cost_usd` degrades honestly on its
 * own. What throws is a missing OBJECT: `spend.all_time.per_debate.debates`
 * blows up on an absent `all_time` or `per_debate`, and `main.tsx` mounts
 * `<App/>` with no error boundary, so that is a white screen on a live-money
 * surface — strictly worse than the rejected-payload behaviour this branch was
 * added to replace.
 *
 * `Array.isArray` is checked at every level for the same reason: `[]` satisfies
 * `typeof x === 'object'`, so an array cast to `LlmSpendSummary` would render a
 * panel of em dashes that looks like a real, empty spend summary rather than a
 * failed read. A wrong shape admitted is worse than a null rejected.
 */
function isSpendSummary(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  for (const key of ['last_24h', 'last_7d', 'all_time']) {
    const window = value[key];
    if (!isPlainObject(window)) return false;
    if (!isPlainObject(window.per_debate)) return false;
  }
  return true;
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
 *
 * `llm_spend` degrades the same way and for the same reason (#606 item 2): a
 * summary that is absent, or not a shape the panel can render, becomes `null` —
 * the value `SpendPanel` and the burn meter are both already written to handle.
 * Degrading is NOT the same as trusting: see `isSpendSummary` for why the check
 * has to reject an array and a summary missing its windows rather than casting
 * whatever object arrived.
 */
export function toWireSnapshot(body: unknown): WireSnapshot | null {
  if (!hasWireShape(body)) return null;
  const candidate = body as Record<string, unknown>;
  const mode = (RECOGNISED_MODES as readonly string[]).includes(candidate.mode as string)
    ? (candidate.mode as ServerMode)
    : null;
  const spend = candidate.llm_spend;
  const llm_spend = isSpendSummary(spend) ? (spend as LlmSpendSummary) : null;
  return {
    ...(candidate as unknown as Omit<WireSnapshot, 'mode' | 'llm_spend'>),
    mode,
    llm_spend,
  };
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

    const timeoutMs = pollTimeoutMs(intervalMs);

    const poll = async () => {
      // A poll already in flight is not replaced: overlapping requests would
      // let an older response land after a newer one and walk the chips
      // backwards. The watchdog below is what notices a hang.
      if (inFlight) return;
      inFlight = true;
      const controller = new AbortController();
      controllers.add(controller);
      const doFetch = optionsRef.current.fetchImpl ?? globalThis.fetch;

      // Per POLL INVOCATION, not per effect (PR #607 review round 1, which
      // read it as effect-scoped): a fresh `timedOut` is created on every call,
      // so one poll being declared dead cannot discard the NEXT poll's payload.
      // The flag reaching the guard below is always the one belonging to the
      // request whose response is being examined.
      let timedOut = false;
      // Releasing the poll slot is idempotent and reachable from BOTH the
      // timeout and the `finally` (#606 item 3). Aborting a controller does
      // not settle a request that ignores its signal, so a `finally`-only
      // release leaves `inFlight` true forever after a hang — every later
      // `poll()` returns at the guard above, no retry is ever issued, and the
      // page merely looks stale while having silently stopped polling.
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        controllers.delete(controller);
        inFlight = false;
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
        release();
        if (cancelled) return;
        const message = `snapshot request timed out after ${timeoutMs}ms`;
        setState((prev) => (prev.error === message ? prev : { ...prev, error: message }));
      }, timeoutMs);

      try {
        const response = await doFetch(optionsRef.current.url, {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`snapshot request failed: HTTP ${response.status}`);
        const body: unknown = await response.json();
        // `timedOut` is checked after BOTH awaits, so a response whose headers
        // arrived in time but whose body hung is discarded too: a payload this
        // poll has already been declared dead over must not land later and
        // walk the chips from a snapshot the page never showed.
        if (cancelled || timedOut) return;
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
        // An abort is either this effect tearing down or the timeout above,
        // and the timeout has already named itself in `error`.
        if (cancelled || controller.signal.aborted) return;
        // Deliberately leaves `snapshot`/`previous`/`revision` untouched: the
        // numbers stay on screen and the watchdog decides when they are stale.
        const message = describeError(cause);
        setState((prev) => (prev.error === message ? prev : { ...prev, error: message }));
      } finally {
        clearTimeout(timeout);
        release();
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
