/**
 * The 3-second `/api/snapshot` poll. Owns the interval and the staleness
 * watchdog: staleness is measured against wall-clock time since the last
 * successful poll (a hung fetch never rejects, so a failure counter would
 * stay at zero), a stale poll keeps the last numbers rather than blanking
 * them, and a hung request is abandoned at the staleness horizon so its slot
 * is released and the next tick can retry.
 */

import {
  CONTRACT_VERSION,
  type DashboardSnapshot,
  type LlmSpendSummary,
  type MetricsSuiteWire,
  type PnlHeadlineWire,
  type ProfitFactorWire,
  type TradingArmWire,
  toProfitFactorWire,
} from '@contracts';
import { useEffect, useMemo, useRef, useState } from 'react';

/** The modes the server may send (`DashboardSnapshot['mode']`) */
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
 * with `mode` widened to `| null` and narrowed at the fetch boundary by
 * `toWireSnapshot`. Not a plain alias — an older server or a rewriting proxy
 * may omit `mode`, and a type asserting it is always one of three literals
 * would let a reader trust a field the server never sent.
 */
export type WireSnapshot = Omit<DashboardSnapshot, 'mode' | 'llm_spend' | 'pnl'> & {
  mode: ServerMode | null;
  /**
   * Widened to `| null` for the same reason `mode` is: an older server or a
   * rewriting proxy may omit it even though today's server always sends one.
   * The rail's LLM cap bar already renders "meter not drawable" for `null`,
   * so degrading beats discarding the whole snapshot over one absent field.
   */
  llm_spend: WireLlmSpendSummary | null;
  /**
   * Widened to `| null` for the same reason as `llm_spend`, but a server
   * missing `pnl` entirely is caught by the `CONTRACT_VERSION` mismatch
   * check instead: `CONTRACT_VERSION` only hashes top-level field names, not
   * shapes nested inside, so a rename inside `PnlHeadlineWire` can pass that
   * check yet leave `pnl.overall`/`.today` missing — and `PnlCard`
   * dereferences both with no error boundary. `isPnlHeadline` is that check.
   */
  pnl: PnlHeadlineWire | null;
};

/**
 * `LlmSpendSummary` with its two cap fields widened to admit `undefined`,
 * meaning "this client could not read the wire value" — a third state
 * distinct from `null`'s "the field is present and says so". Without the
 * widening, `contracts/snapshot.ts`'s non-optional declaration would let the
 * compiler treat the `undefined` branch as unreachable dead code rather than
 * a case readers must handle.
 */
type WireLlmSpendSummary = Omit<LlmSpendSummary, 'cap_usd' | 'cap_armed_at'> & {
  cap_usd: number | null | undefined;
  cap_armed_at: string | null | undefined;
};

const SNAPSHOT_URL = '/api/snapshot';
const POLL_INTERVAL_MS = 3_000;
/** Two consecutive missed polls put the page into its stale state (spec) */
export const STALE_AFTER_MISSED_POLLS = 2;
/**
 * How long a single poll may hang before it is abandoned. Tied to the
 * staleness horizon rather than picked independently, so the poll slot is
 * released at the same instant the watchdog admits the page is stale.
 */
function pollTimeoutMs(intervalMs: number): number {
  return intervalMs * STALE_AFTER_MISSED_POLLS;
}

/**
 * The rail's single health discriminator — every consumer that needs to know
 * how much of the feed to trust reads this field, not `stale`/`snapshot`/
 * `error` combined by hand. Ranked highest-priority first, since more than
 * one can be true of the underlying facts at once and only one word can be
 * shown: `'contract-mismatch'` (the answering server disagrees about the
 * wire shape — a wrong diagnosis if read as merely stale) outranks
 * `'waiting'` (no snapshot ever read), which outranks `'stale'` (two poll
 * intervals since the last valid one), which outranks `'alive'`.
 */
export type FeedStatus = 'contract-mismatch' | 'waiting' | 'stale' | 'alive';

/**
 * The two members reachable while no snapshot has ever validated. The
 * cold-start page must be able to say `'contract-mismatch'` rather than
 * `'waiting'` — reporting silence the feed is not actually keeping.
 */
type ColdStatus = Exclude<FeedStatus, 'stale' | 'alive'>;

export interface SnapshotFeed {
  /**
   * The most recent successfully-fetched payload, or `null` before the
   * first — including while `status === 'contract-mismatch'`, since a
   * mismatched poll must not overwrite this with a shape this client cannot
   * trust. Callers must check `status`, not this field's nullness, before
   * reading health off it.
   */
  snapshot: WireSnapshot | null;
  /**
   * Client wall-clock time of the last successful poll — distinct from
   * `snapshot.generated_at`, which the server stamps
   */
  lastSuccessAt: string | null;
  /** Why the last poll failed, for the rail to name. `null` when the last poll worked. */
  error: string | null;
  /** The rail's health discriminator — see `FeedStatus`'s doc comment */
  status: FeedStatus;
}

/**
 * A feed that has produced at least one validated snapshot, and so always
 * will: `snapshot` is only ever replaced by a later validated payload, never
 * cleared. That makes the non-nullness a guarantee for the session's whole
 * life, not a momentary reading — callers gate on "has one ever arrived".
 */
export type LiveFeed = Omit<SnapshotFeed, 'snapshot'> & { snapshot: WireSnapshot };

/** A feed before its first validated snapshot — see `ColdStatus` */
export type ColdFeed = Omit<SnapshotFeed, 'snapshot' | 'status'> & {
  snapshot: null;
  status: ColdStatus;
};

/**
 * The only place in the client that asks whether a snapshot exists.
 * Deliberately keyed on `snapshot` nullness, not `status === 'waiting'`: a
 * version-skewed first poll has no snapshot either but ranks as
 * `'contract-mismatch'`, so keying on the status word would send it down the
 * live branch with nothing to render.
 */
export type FeedView = { kind: 'cold'; feed: ColdFeed } | { kind: 'live'; feed: LiveFeed };

/**
 * What each `FeedStatus` reads as when no snapshot has arrived; `null` marks
 * the two `deriveStatus` cannot produce against a null snapshot, which fall
 * back to `'waiting'`. A record rather than a ternary so a new `FeedStatus`
 * member fails to compile here until someone says whether it is reachable
 * cold, rather than silently defaulting to WAITING.
 */
const COLD_STATUS: { readonly [S in FeedStatus]: ColdStatus | null } = {
  'contract-mismatch': 'contract-mismatch',
  waiting: 'waiting',
  stale: null,
  alive: null,
};

export function feedView(feed: SnapshotFeed): FeedView {
  const { snapshot, status } = feed;
  if (snapshot !== null) return { kind: 'live', feed: { ...feed, snapshot } };
  const coldStatus: ColdStatus = COLD_STATUS[status] ?? 'waiting';
  return { kind: 'cold', feed: { ...feed, snapshot, status: coldStatus } };
}

export interface UseSnapshotOptions {
  url?: string;
  intervalMs?: number;
  /** Injected for tests; defaults to the global `fetch` */
  fetchImpl?: typeof fetch;
  /** Injected for tests; defaults to `Date.now` */
  now?: () => number;
  /**
   * Sent as `Authorization: Bearer <authToken>` on every poll when non-empty.
   * `undefined`, `null` or `''` all mean "send no header at all" — not an
   * empty-string header — keeping the no-credential-configured request
   * shape unchanged.
   */
  authToken?: string | null;
  /**
   * Which arm's `positions`/`closed_trades` to poll for. `undefined` and
   * `'live'` are the same request (see `snapshotUrl`), so a caller that
   * never heard of arms is unaffected.
   */
  arm?: TradingArmWire;
}

/**
 * The URL a poll actually fetches. `arm=control` is appended only for the
 * control arm — every other case leaves `url` untouched, matching the
 * server's own `'live'` default. The separator depends on whether `url`
 * already carries a query string, since `UseSnapshotOptions.url` is a
 * public, caller-supplied value that might.
 */
export function snapshotUrl(url: string, arm?: TradingArmWire): string {
  if (arm !== 'control') return url;
  return `${url}${url.includes('?') ? '&' : '?'}arm=control`;
}

/**
 * Reads `contract_version` off a body that at least parsed as an object,
 * without trusting anything else about its shape yet. Runs before
 * `hasWireShape` in `poll()` deliberately, so a renamed or dropped field is
 * diagnosed as a contract mismatch rather than the generic "did not match
 * the wire shape" error, which reads like a proxy fault instead.
 */
function readServerContractVersion(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const version = (value as Record<string, unknown>).contract_version;
  return typeof version === 'string' ? version : undefined;
}

/**
 * Structural check on the parsed body. A captive portal or misconfigured
 * proxy can answer `200` with HTML that still parses as an object, so this
 * checks for `pipeline.lanes` too — failing keeps the last good numbers on
 * screen instead of rendering an empty lane matrix as though gone quiet.
 */
function hasWireShape(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.generated_at !== 'string') return false;
  for (const key of ['positions', 'debates', 'verdicts', 'analysts']) {
    if (!Array.isArray(candidate[key])) return false;
  }
  // `llm_spend` is deliberately not required here — see `WireSnapshot`. It is
  // narrowed to `null` by `toWireSnapshot` instead, so an absent summary
  // costs one panel its numbers rather than the whole page
  for (const key of ['metrics', 'providers']) {
    const field = candidate[key];
    if (typeof field !== 'object' || field === null) return false;
  }
  const pipeline = candidate.pipeline;
  if (typeof pipeline !== 'object' || pipeline === null) return false;
  return Array.isArray((pipeline as Record<string, unknown>).lanes);
}

/** A non-null object that is not an array — `typeof [] === 'object'` */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Is this shape one the rail's LLM cap block can render? Checks the object
 * fields consumers dereference into (which throw if absent, with no error
 * boundary), not scalars, which already degrade honestly through the format
 * helpers. `cap_usd`/`cap_armed_at` degrade per-field instead — see
 * `normalizeCapUsd`/`normalizeCapArmedAt`.
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
 * Is this shape one `GlanceTab.tsx`'s `PnlCard` can render? Structural only,
 * for `isSpendSummary`'s reason: `PnlCard` dereferences `overall`/`today`
 * straight through with no error boundary, but the numeric fields inside
 * already degrade to an em dash rather than throwing.
 */
function isPnlHeadline(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return isPlainObject(value.overall) && isPlainObject(value.today);
}

/**
 * `null` ("the wire said null") and any other non-finite value ("unreadable")
 * must not collapse together: `SqliteLlmSpendCapStore.read()` nullifies a
 * corrupt stored `budget_usd` while keeping `armed_at`, so a corrupt `REAL`
 * column alone can produce a real `cap_armed_at` beside a bad `cap_usd` —
 * mapping both to `null` would render `'uncapped'`, an affirmative claim
 * manufactured from a value this client just rejected
 */
function normalizeCapUsd(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * `undefined` (field absent) and `null` (field present, explicitly "never
 * armed") are different claims and must not collapse together; a malformed
 * present value is treated as absent rather than guessed either way.
 * Both the shape regex and `Date.parse` are required: the regex alone
 * admits digit-grammar nonsense like `"2026-13-45T99:99:99.999Z"`, and
 * `Date.parse` alone admits loose formats the store never writes. The regex
 * duplicates `STORED_TIMESTAMP` (`server/shared/store/sqlite-utils.ts`)
 * rather than importing it — `client/` and `server/` do not import each
 * other — kept in sync by inspection.
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
 * `MetricsSuiteWire['profit_factor']`'s boundary normalizer. `hasWireShape`
 * only checks that `metrics` is a non-null object, not what's inside, so an
 * old server's bare `number` or collapsed-`Infinity` `null` would otherwise
 * reach `ReviewTab.tsx`'s exhaustive `switch (pf.kind)` with no `.kind` at
 * all and no error boundary. A `null` degrades to `unreadable`, not
 * `no_losses` — `JSON.stringify` collapses `Infinity`/`NaN`/`-Infinity`
 * alike, so guessing the affirmative case from ambiguous input would be
 * wrong. A bare finite number routes through `toProfitFactorWire` itself
 * rather than duplicating its branches here.
 */
function profitFactorOf(value: unknown): ProfitFactorWire {
  if (isPlainObject(value)) {
    if (value.kind === 'no_losses' || value.kind === 'unreadable') {
      return { kind: value.kind };
    }
    if (value.kind === 'ratio' && typeof value.value === 'number' && Number.isFinite(value.value)) {
      return { kind: 'ratio', value: value.value };
    }
    return { kind: 'unreadable' };
  }
  if (typeof value === 'number') return toProfitFactorWire(value);
  return { kind: 'unreadable' };
}

/**
 * Validates a parsed body once, at the fetch boundary, and returns it with
 * `mode` narrowed — or `null` if it is not a snapshot at all. `mode` is
 * deliberately not part of the structural check above: an unrecognised or
 * absent mode must not throw away a payload whose positions, verdicts and
 * pipeline are still good, so it degrades to `null` instead of rejecting.
 * `llm_spend`, `metrics.profit_factor` and `pnl` degrade the same way, each
 * for its own field rather than voiding the whole snapshot — see
 * `isSpendSummary`, `profitFactorOf` and `isPnlHeadline`.
 */
export function toWireSnapshot(body: unknown): WireSnapshot | null {
  if (!hasWireShape(body)) return null;
  const candidate = body as Record<string, unknown>;
  const mode = (RECOGNISED_MODES as readonly string[]).includes(candidate.mode as string)
    ? (candidate.mode as ServerMode)
    : null;
  const spend = candidate.llm_spend;
  // `spend` is `unknown`, so the spread source still needs a cast; narrowed
  // to `Omit<..., 'cap_usd' | 'cap_armed_at'>` so the two fields actually
  // being normalized below stay compiler-checked against `WireLlmSpendSummary`
  const llm_spend: WireLlmSpendSummary | null = isSpendSummary(spend)
    ? {
        ...(spend as unknown as Omit<LlmSpendSummary, 'cap_usd' | 'cap_armed_at'>),
        cap_usd: normalizeCapUsd((spend as Record<string, unknown>).cap_usd),
        cap_armed_at: normalizeCapArmedAt((spend as Record<string, unknown>).cap_armed_at),
      }
    : null;
  const metricsField = candidate.metrics as Record<string, unknown>;
  const metrics: MetricsSuiteWire = {
    ...(metricsField as unknown as MetricsSuiteWire),
    profit_factor: profitFactorOf(metricsField.profit_factor),
  };
  const pnl: PnlHeadlineWire | null = isPnlHeadline(candidate.pnl)
    ? (candidate.pnl as PnlHeadlineWire)
    : null;
  return {
    ...(candidate as unknown as Omit<WireSnapshot, 'mode' | 'llm_spend' | 'metrics' | 'pnl'>),
    mode,
    llm_spend,
    metrics,
    pnl,
  };
}

interface FeedState {
  snapshot: WireSnapshot | null;
  /** Two poll intervals with no successful (matching-contract) poll */
  watchdogStale: boolean;
  /**
   * The most recent poll parsed as an object but carried a `contract_version`
   * other than this client's own (or none at all). Cleared only by a poll
   * that validates, not by the passage of time or the staleness watchdog,
   * which answers a different question.
   */
  contractMismatch: boolean;
  lastSuccessAt: string | null;
  error: string | null;
}

const INITIAL: FeedState = {
  snapshot: null,
  watchdogStale: false,
  contractMismatch: false,
  lastSuccessAt: null,
  error: null,
};

/**
 * The single place `FeedStatus` is computed from the raw booleans above —
 * see `FeedStatus`'s doc for the ranking. Also the only reader of
 * `watchdogStale`, which stays internal state rather than a second exposed
 * flag that could disagree with `status`.
 */
function deriveStatus(state: FeedState): FeedStatus {
  if (state.contractMismatch) return 'contract-mismatch';
  if (state.snapshot === null) return 'waiting';
  return state.watchdogStale ? 'stale' : 'alive';
}

function describeError(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

// Omitted entirely when there is no token, rather than sent as an
// empty/blank `Authorization` header — keeps the no-token request shape
// unchanged
function buildAuthHeaders(token: string | null | undefined): { Authorization: string } | undefined {
  return token !== undefined && token !== null && token !== ''
    ? { Authorization: `Bearer ${token}` }
    : undefined;
}

/**
 * Releasing the poll slot on timeout is idempotent and reachable from both
 * this timer and the caller's `finally` — aborting a controller does not
 * settle a request that ignores its signal, so a `finally`-only release
 * would leave `inFlight` true forever after a hang. `isTimedOut` is created
 * fresh per invocation, so one poll declared dead cannot discard the next.
 */
function armPollTimeout(deps: {
  timeoutMs: number;
  controller: AbortController;
  release: () => void;
  isCancelled: () => boolean;
  setState: (updater: (prev: FeedState) => FeedState) => void;
}): { timeout: ReturnType<typeof setTimeout>; isTimedOut: () => boolean } {
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    deps.controller.abort();
    deps.release();
    if (deps.isCancelled()) return;
    const message = `snapshot request timed out after ${deps.timeoutMs}ms`;
    deps.setState((prev) => (prev.error === message ? prev : { ...prev, error: message }));
  }, deps.timeoutMs);
  return { timeout, isTimedOut: () => timedOut };
}

// Idempotent and reachable from both the timeout arm and the caller's
// `finally` — see `armPollTimeout`'s doc for why both paths must release
function createReleaser(
  controllers: Set<AbortController>,
  controller: AbortController,
  setInFlight: (value: boolean) => void,
): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    controllers.delete(controller);
    setInFlight(false);
  };
}

function handlePollFailure(
  cause: unknown,
  deps: {
    isCancelled: () => boolean;
    isAborted: () => boolean;
    setState: (updater: (prev: FeedState) => FeedState) => void;
  },
): void {
  // An abort is either this effect tearing down or the timeout above, and
  // the timeout has already named itself in `error`
  if (deps.isCancelled() || deps.isAborted()) return;
  // Deliberately leaves `snapshot` and `contractMismatch` untouched: the
  // numbers stay on screen and the watchdog decides when they are stale; a
  // prior mismatch stays a mismatch until a validating poll clears it,
  // rather than being papered over by an unrelated network error's message
  const message = describeError(cause);
  deps.setState((prev) => (prev.error === message ? prev : { ...prev, error: message }));
}

async function attemptPollFetch(deps: {
  doFetch: typeof fetch;
  url: string;
  arm: TradingArmWire | undefined;
  authToken: string | null | undefined;
  controller: AbortController;
  isCancelled: () => boolean;
  isTimedOut: () => boolean;
  now: () => number;
  setState: (updater: (prev: FeedState) => FeedState) => void;
}): Promise<number | null> {
  const headers = buildAuthHeaders(deps.authToken);
  const response = await deps.doFetch(snapshotUrl(deps.url, deps.arm), {
    cache: 'no-store',
    signal: deps.controller.signal,
    ...(headers !== undefined ? { headers } : {}),
  });
  return resolveSnapshotResponse(response, {
    isCancelled: deps.isCancelled,
    isTimedOut: deps.isTimedOut,
    now: deps.now,
    setState: deps.setState,
  });
}

/**
 * Returns the new `lastSuccessMs` on a snapshot that landed, `null` on
 * anything that isn't a fresh, trustworthy snapshot (a discarded stale
 * response or a contract mismatch) — `poll()` only advances its own
 * `lastSuccessMs` on non-null
 */
async function resolveSnapshotResponse(
  response: Response,
  deps: {
    isCancelled: () => boolean;
    isTimedOut: () => boolean;
    now: () => number;
    setState: (updater: (prev: FeedState) => FeedState) => void;
  },
): Promise<number | null> {
  if (!response.ok) throw new Error(`snapshot request failed: HTTP ${response.status}`);
  const body: unknown = await response.json();
  // Checked after both awaits, so a response whose headers arrived in time
  // but whose body hung is discarded too — a payload this poll already
  // declared dead must not land later and rewrite the page
  if (deps.isCancelled() || deps.isTimedOut()) return null;
  // Checked before the structural check below, deliberately: a renamed or
  // dropped field would also fail that check, whose generic error reads
  // like a proxy fault rather than a version mismatch
  const serverVersion = readServerContractVersion(body);
  if (serverVersion !== CONTRACT_VERSION) {
    // Does not advance `lastSuccessMs` or touch `snapshot` — see
    // `FeedState.contractMismatch`'s doc comment
    const message =
      serverVersion === undefined
        ? `served bundle disagrees with the server's wire contract (server sent no contract_version; this client expects ${CONTRACT_VERSION})`
        : `served bundle disagrees with the server's wire contract (server ${serverVersion}, client ${CONTRACT_VERSION})`;
    deps.setState((prev) =>
      prev.contractMismatch && prev.error === message
        ? prev
        : { ...prev, contractMismatch: true, error: message },
    );
    return null;
  }
  const snapshot = toWireSnapshot(body);
  if (snapshot === null) throw new Error('snapshot payload did not match the wire shape');
  const lastSuccessMs = deps.now();
  deps.setState(() => ({
    snapshot,
    watchdogStale: false,
    contractMismatch: false,
    lastSuccessAt: new Date(lastSuccessMs).toISOString(),
    error: null,
  }));
  return lastSuccessMs;
}

export function useSnapshot(options: UseSnapshotOptions = {}): SnapshotFeed {
  const {
    url = SNAPSHOT_URL,
    intervalMs = POLL_INTERVAL_MS,
    fetchImpl,
    now = Date.now,
    authToken,
    arm,
  } = options;

  const [state, setState] = useState<FeedState>(INITIAL);

  // A ref, not state: the interval callback must see current option values
  // without the effect tearing down and restarting the poll clock
  const optionsRef = useRef({ url, fetchImpl, now, authToken, arm });
  optionsRef.current = { url, fetchImpl, now, authToken, arm };

  useEffect(() => {
    let cancelled = false;
    // Per-effect locals rather than refs: a ref would outlive the effect, so
    // a StrictMode remount would find `inFlight` still true from the
    // previous mount and skip its own first poll
    let inFlight = false;
    let lastSuccessMs = optionsRef.current.now();
    const controllers = new Set<AbortController>();

    const markStale = (watchdogStale: boolean) => {
      setState((prev) =>
        prev.watchdogStale === watchdogStale ? prev : { ...prev, watchdogStale },
      );
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

      const release = createReleaser(controllers, controller, (value) => {
        inFlight = value;
      });
      const { timeout, isTimedOut } = armPollTimeout({
        timeoutMs,
        controller,
        release,
        isCancelled: () => cancelled,
        setState,
      });

      try {
        const resolvedSuccessMs = await attemptPollFetch({
          doFetch,
          url: optionsRef.current.url,
          arm: optionsRef.current.arm,
          authToken: optionsRef.current.authToken,
          controller,
          isCancelled: () => cancelled,
          isTimedOut,
          now: () => optionsRef.current.now(),
          setState,
        });
        if (resolvedSuccessMs !== null) lastSuccessMs = resolvedSuccessMs;
      } catch (cause) {
        handlePollFailure(cause, {
          isCancelled: () => cancelled,
          isAborted: () => controller.signal.aborted,
          setState,
        });
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
      // rejection and a 500 alike
      markStale(optionsRef.current.now() - lastSuccessMs > intervalMs * STALE_AFTER_MISSED_POLLS);
      void poll();
    }, intervalMs);

    return () => {
      cancelled = true;
      clearInterval(timer);
      for (const controller of controllers) controller.abort();
    };
  }, [intervalMs]);

  return useMemo(() => {
    const status = deriveStatus(state);
    return {
      snapshot: state.snapshot,
      lastSuccessAt: state.lastSuccessAt,
      error: state.error,
      status,
    };
  }, [state]);
}
