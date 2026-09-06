/**
 * The 3-second `/api/snapshot` poll (issue #538; dashboard-spec.md
 * "hooks/useSnapshot.ts"). Owns two things and nothing else: the interval and
 * the staleness watchdog.
 *
 * Three properties this hook exists to guarantee, each of which is a way an
 * operator surface lies if it is missing:
 *
 *  1. **Staleness is measured against the clock, not against a failure
 *     counter.** A hung fetch never rejects, so a counter stays at zero while
 *     the data rots. The watchdog asks "how long since a successful poll",
 *     which is true of a hang, a rejection, and a 500 alike.
 *  2. **A stale poll keeps the last numbers.** They are marked stale by the
 *     rail, never blanked — a blank field reads as zero (spec, "Layout — the
 *     Rail").
 *  3. **Every poll is bounded in time.** A hung request (the server accepts
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
 * the rail's mode-pill literal check as the only thing standing between a
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
   * way (#606 item 2). The rail's LLM cap bar takes `WireLlmSpendSummary |
   * null` and renders "meter not drawable" naming the reason — so the
   * consumer of this field already degrades honestly, and the boundary
   * rejecting the payload was the only thing standing between a missing
   * spend read and that rendering.
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
  llm_spend: WireLlmSpendSummary | null;
};

/**
 * `LlmSpendSummary` with its two cap fields widened to admit `undefined`,
 * meaning "this client could not read the wire value" — a third state
 * distinct from `null`'s "the field is present and says so"
 * (`contracts/snapshot.ts`'s `cap_usd` / `cap_armed_at` doc comments).
 * `normalizeCapUsd` / `normalizeCapArmedAt` below are what produce
 * `undefined`; `Rail.tsx`'s `capReasonOf` is what reads it back out as
 * `'unreadable'` / `'ambiguous'`.
 *
 * Without this widening, the cast at the end of `toWireSnapshot` was the
 * only thing keeping these fields' real, three-valued range out of the
 * compiler's sight (review round 3, MINOR): `contracts/snapshot.ts` declares
 * both as non-optional `string | null` / `number | null`, so a reader typed
 * against that declaration would see the `undefined` branch as unreachable
 * dead code, not as a case the compiler requires it to handle — exactly the
 * "type that lies" failure mode `mode`'s docblock above describes, reached
 * one field deeper.
 */
export type WireLlmSpendSummary = Omit<LlmSpendSummary, 'cap_usd' | 'cap_armed_at'> & {
  cap_usd: number | null | undefined;
  cap_armed_at: string | null | undefined;
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
 * window where the rail says stale while a zombie request still holds the
 * poll slot; anything shorter would abandon a merely slow response the page
 * could still have used.
 */
function pollTimeoutMs(intervalMs: number): number {
  return intervalMs * STALE_AFTER_MISSED_POLLS;
}

export interface SnapshotFeed {
  /** The most recent successfully-fetched payload, or `null` before the first. */
  snapshot: WireSnapshot | null;
  /** Two poll intervals have passed with no successful poll. */
  stale: boolean;
  /**
   * Client wall-clock time of the last successful poll — distinct from
   * `snapshot.generated_at`, which the server stamps. The rail's poll clock
   * reads this one; its snapshot clock reads `generated_at`/`as_of` (#1166).
   */
  lastSuccessAt: string | null;
  /** Why the last poll failed, for the rail to name. `null` when the last poll worked. */
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
 * carries no `pipeline.lanes` would render an empty lane matrix as though the
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
 * Is this shape one the rail's LLM cap block can actually render?
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
 * block of em dashes that looks like a real, empty spend summary rather than a
 * failed read. A wrong shape admitted is worse than a null rejected.
 *
 * `cap_usd` and `cap_armed_at` are DELIBERATELY NOT checked here (review round
 * 2, MINOR 3) — the three windows above are structural (a missing `all_time`
 * or `per_debate` throws on dereference), but the cap fields are two scalars
 * neither consumer dereferences into. Rejecting the whole summary over one bad
 * scalar would be exactly the `mode` mistake this function's sibling below
 * exists to avoid: three valid spend windows thrown away over one malformed
 * cap field would blank the 24h/7d/all-time footnote over a fault in an
 * unrelated field. `normalizeCapUsd` / `normalizeCapArmedAt` degrade those two
 * scalars per-field instead, the same way `mode` degrades below.
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
 * `null` and "anything else that is not a finite number" are DIFFERENT
 * claims and must not collapse into each other (review round 3's MAJOR —
 * the previous version mapped both to `null`, which this state machine
 * reads as "the field said so", so a malformed `cap_usd` alongside an
 * intact `cap_armed_at` rendered `'uncapped'`: an affirmative claim that the
 * operator chose to remove the ceiling, manufactured from a value this
 * client just rejected as unreadable).
 *
 * That pair — a corrupt `cap_usd` with a real `cap_armed_at` — is reachable
 * with no version skew and no client bug required:
 * `SqliteLlmSpendCapStore.read()` (`server/shared/store/sqlite-llm-spend-
 * cap-store.ts`) nullifies a non-finite stored `budget_usd` while KEEPING
 * `armed_at`, so a corrupted `REAL` column alone produces exactly this wire
 * shape (`contracts/snapshot.ts`'s `cap_armed_at` doc comment names the same
 * case). The fix once this was understood as a state-machine gap rather than
 * a scalar-typing gap: `null` here means ONLY "the wire said `null`" — the
 * legitimate discriminator input `cap_armed_at` gets to split into
 * never-armed/uncapped — and every other non-finite shape, absent included,
 * degrades to `undefined`, which `Rail.tsx`'s `capReasonOf` reports as its
 * own `'unreadable'` reason, asserting nothing about intent either way.
 */
function normalizeCapUsd(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * `undefined` (the field absent — a pre-#1196 server) and `null` (the field
 * present, explicitly saying "no row was ever written") are DIFFERENT claims
 * and must not collapse into each other (review round 2's MAJOR — that
 * collapse, done with `??` in `Rail.tsx`, was this ticket's own defect one
 * level up). A malformed present value — wrong type, empty, or not even
 * `Date.parse`-able — is treated the SAME as absent: this client was told
 * nothing trustworthy about arming, not that arming is `null`, so guessing
 * "never armed" from noise would be as false as guessing "armed".
 *
 * Checked against the store's own shape AND parsed (review round 3, NIT 1 —
 * revised after the shape-only version was itself found loose). A bare
 * `Date.parse` gate admitted strings the store never writes (`"2026"`,
 * `"March 1 2026"`), and `formatClockUtc` (`client/src/lib/format.ts`) then
 * rendered them with a fabricated-looking `00:00:00Z` second precision — a
 * footnote that looked like a real arming instant for input this client
 * could not actually have received from `toStoredTimestamp`. Swapping to a
 * shape-only regex traded that looseness for the opposite one: the regex
 * alone admits `"2026-13-45T99:99:99.999Z"`, which matches the digit grammar
 * but is not a real instant, and `Date.parse` was the only check that caught
 * it — dropping it would let a nonsense string through as a trustworthy
 * arming record on a live-money surface. Both checks run: the shape rules
 * out formats the store never writes (loose ISO variants `Date.parse` alone
 * accepts), and `Date.parse` rules out digit strings the shape alone accepts
 * but no calendar produces. The regex is a literal duplicate of
 * `STORED_TIMESTAMP` (`server/shared/store/sqlite-utils.ts`), not an import
 * — `client/` and `server/` do not import each other (CLAUDE.md) — kept in
 * sync by inspection, the same way the two processes' timestamp grammar
 * always has been. `toStoredTimestamp` calls `Date#toISOString()` unguarded,
 * which always emits millisecond precision, so every value this store's
 * `arm()` ever writes satisfies both checks — the tightening has no false
 * negative against a real write.
 */
const STORED_TIMESTAMP_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function normalizeCapArmedAt(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === 'string' &&
    STORED_TIMESTAMP_SHAPE.test(value) &&
    !Number.isNaN(Date.parse(value))
    ? value
    : undefined;
}

/**
 * Validates a parsed body ONCE, at the fetch boundary, and returns it with
 * `mode` narrowed — or `null` if it is not a snapshot at all.
 *
 * `mode` is deliberately NOT part of the structural check above: an
 * unrecognised or absent mode must not throw the whole payload away, because
 * positions, verdicts and the pipeline are still true and the rail has an
 * honest rendering for an unknown mode ("mode unknown" on the rail). Discarding a good
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
 * the value the rail's LLM cap block is already written to handle.
 * Degrading is NOT the same as trusting: see `isSpendSummary` for why the check
 * has to reject an array and a summary missing its windows rather than casting
 * whatever object arrived. Once the windows are known good, `cap_usd` and
 * `cap_armed_at` degrade PER FIELD (`normalizeCapUsd` / `normalizeCapArmedAt`)
 * rather than voiding the whole summary — the same `mode` reasoning, applied
 * one level deeper (review round 2, MINOR 3).
 */
export function toWireSnapshot(body: unknown): WireSnapshot | null {
  if (!hasWireShape(body)) return null;
  const candidate = body as Record<string, unknown>;
  const mode = (RECOGNISED_MODES as readonly string[]).includes(candidate.mode as string)
    ? (candidate.mode as ServerMode)
    : null;
  const spend = candidate.llm_spend;
  const llm_spend = isSpendSummary(spend)
    ? ({
        ...(spend as Record<string, unknown>),
        cap_usd: normalizeCapUsd((spend as Record<string, unknown>).cap_usd),
        cap_armed_at: normalizeCapArmedAt((spend as Record<string, unknown>).cap_armed_at),
      } as unknown as WireLlmSpendSummary)
    : null;
  return {
    ...(candidate as unknown as Omit<WireSnapshot, 'mode' | 'llm_spend'>),
    mode,
    llm_spend,
  };
}

interface FeedState {
  snapshot: WireSnapshot | null;
  stale: boolean;
  lastSuccessAt: string | null;
  error: string | null;
}

const INITIAL: FeedState = {
  snapshot: null,
  stale: false,
  lastSuccessAt: null,
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
      // let an older response land after a newer one and move the numbers
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
        // rewrite the page from a snapshot the page never showed.
        if (cancelled || timedOut) return;
        const snapshot = toWireSnapshot(body);
        if (snapshot === null) throw new Error('snapshot payload did not match the wire shape');
        lastSuccessMs = optionsRef.current.now();
        setState(() => ({
          snapshot,
          stale: false,
          lastSuccessAt: new Date(lastSuccessMs).toISOString(),
          error: null,
        }));
      } catch (cause) {
        // An abort is either this effect tearing down or the timeout above,
        // and the timeout has already named itself in `error`.
        if (cancelled || controller.signal.aborted) return;
        // Deliberately leaves `snapshot` untouched: the
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
      stale: state.stale,
      lastSuccessAt: state.lastSuccessAt,
      error: state.error,
    }),
    [state],
  );
}
