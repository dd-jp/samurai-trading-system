/**
 * The `/api/snapshot` poll. Guarantees: staleness is measured against the
 * clock, not a failure counter (a hung fetch never rejects); a stale poll
 * keeps the last numbers rather than blanking them; every poll is bounded in
 * time and its slot released on timeout, so a hang cannot wedge the
 * in-flight guard and silently stop future retries.
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

/** The modes the server may send */
type ServerMode = DashboardSnapshot['mode'];

/**
 * The same list at runtime, for the boundary check below. `satisfies` rather
 * than a bare array so an invalid mode cannot be added here by hand.
 */
export const RECOGNISED_MODES = [
  'paper',
  'live',
  'backtest',
] as const satisfies readonly ServerMode[];

/**
 * The client's view of the wire payload: `DashboardSnapshot` with `mode`
 * widened to `| null` and NARROWED at the fetch boundary by `toWireSnapshot`.
 * Not a plain alias: asserting `mode` always one of three literals would let
 * a reader trust a field an older server or rewriting proxy may omit — a
 * type that lies is worse than one that is wide.
 */
export type WireSnapshot = Omit<DashboardSnapshot, 'mode' | 'llm_spend' | 'pnl'> & {
  mode: ServerMode | null;
  /**
   * Widened to `| null` for the same reason `mode` is. The server cannot
   * send `null` today (a failed read 500s instead) — this is a boundary
   * policy fix for an older server or rewriting proxy, not a live bug.
   */
  llm_spend: WireLlmSpendSummary | null;
  /**
   * Widened to `| null` for the same reason as `llm_spend`, but reachable
   * differently: `CONTRACT_VERSION` only hashes top-level field names, so a
   * rename nested inside `PnlHeadlineWire.overall`/`.today` would pass the
   * version check and still leave a field missing. `isPnlHeadline` is that
   * structural check.
   */
  pnl: PnlHeadlineWire | null;
};

/**
 * `LlmSpendSummary` with its two cap fields widened to admit `undefined`,
 * meaning "this client could not read the wire value" — a third state
 * distinct from `null`'s "the field is present and says so". Without the
 * widening, the compiler would see the `undefined` branch as dead code
 * rather than a case it requires handling.
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
 * Tied to the staleness horizon rather than picked independently: the slot is
 * released at the same instant the watchdog admits the page is stale, so the
 * next interval tick can retry
 */
function pollTimeoutMs(intervalMs: number): number {
  return intervalMs * STALE_AFTER_MISSED_POLLS;
}

/**
 * The rail's single health discriminator — every consumer reads THIS field,
 * not `stale/snapshot/error` combined by hand. Ranked, highest priority
 * first, since more than one can be true at once and only one word is shown:
 * `'contract-mismatch'` (client/server wire-shape disagreement — outranks
 * everything, since a wrong diagnosis is worse than a less specific one) >
 * `'waiting'` (no snapshot ever read) > `'stale'` (two poll intervals since
 * last valid) > `'alive'`.
 */
export type FeedStatus = 'contract-mismatch' | 'waiting' | 'stale' | 'alive';

/**
 * The two members reachable while no snapshot has EVER validated —
 * `'contract-mismatch'` outranks `'waiting'` here too, so a cold-start page
 * can say MISMATCH rather than report silence the feed isn't keeping
 */
type ColdStatus = Exclude<FeedStatus, 'stale' | 'alive'>;

export interface SnapshotFeed {
  /**
   * The most recent successfully-fetched payload, or `null` before the
   * first — including while `status === 'contract-mismatch'`, which does not
   * overwrite this with an untrusted shape. Check `status`, not this field's
   * nullness, before reading health off it.
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
 * will — `snapshot` is only ever replaced by a later validated payload,
 * never cleared. Gate on "has a snapshot ever arrived", not on "is one
 * present right now".
 */
export type LiveFeed = Omit<SnapshotFeed, 'snapshot'> & { snapshot: WireSnapshot };

/** A feed before its first validated snapshot — see `ColdStatus` */
export type ColdFeed = Omit<SnapshotFeed, 'snapshot' | 'status'> & {
  snapshot: null;
  status: ColdStatus;
};

/**
 * The ONLY place in the client that asks whether a snapshot exists.
 * Downstream of a `'live'` view every consumer receives `WireSnapshot`, not
 * `WireSnapshot | null`. Keyed on snapshot nullness, not `status ===
 * 'waiting'` — a version-skewed first poll has no snapshot either but ranks
 * as `'contract-mismatch'`, which must still render as cold, not live.
 */
export type FeedView = { kind: 'cold'; feed: ColdFeed } | { kind: 'live'; feed: LiveFeed };

/**
 * What each `FeedStatus` reads as when no snapshot has arrived. A record
 * rather than a ternary so a new `FeedStatus` member fails to compile here
 * until someone says whether it is reachable cold.
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
   * Sent as `Authorization: Bearer <authToken>` when non-empty. `undefined`,
   * `null` or `''` all mean "send no header at all", keeping the
   * no-credential request shape unchanged.
   */
  authToken?: string | null;
  /** Which arm's `positions`/`closed_trades` to poll for; `undefined` and `'live'` are the same request */
  arm?: TradingArmWire;
}

/**
 * `arm=control` is appended ONLY for the control arm, so the default
 * dashboard's request stays unchanged. The separator is chosen from whether
 * `url` already carries a query string — `UseSnapshotOptions.url` is
 * caller-supplied and may.
 */
export function snapshotUrl(url: string, arm?: TradingArmWire): string {
  if (arm !== 'control') return url;
  return `${url}${url.includes('?') ? '&' : '?'}arm=control`;
}

/**
 * Reads `contract_version` off a body that at least parsed as an object.
 * Runs BEFORE `hasWireShape` in `poll()`, so a renamed/dropped field is
 * diagnosed as a contract mismatch rather than falling through to the
 * generic "did not match the wire shape" error. Returns `undefined` for both
 * "not an object" and "field absent/not a string" — both read as
 * unversioned, the conservative default.
 */
function readServerContractVersion(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const version = (value as Record<string, unknown>).contract_version;
  return typeof version === 'string' ? version : undefined;
}

/**
 * Structural check on the parsed body. A payload that parses as JSON but
 * carries no `pipeline.lanes` (captive portal, misconfigured proxy) would
 * otherwise render an empty lane matrix as though the system had gone quiet;
 * failing here keeps the last good numbers on screen instead.
 */
function hasWireShape(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.generated_at !== 'string') return false;
  for (const key of ['positions', 'debates', 'verdicts', 'analysts']) {
    if (!Array.isArray(candidate[key])) return false;
  }
  // `llm_spend` deliberately NOT required here — narrowed to `null` by
  // `toWireSnapshot` instead, so an absent summary costs one panel, not the page
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
 * Is this shape one the rail's LLM cap block can actually render? Checks
 * depth chosen from what consumers DEREFERENCE: a missing scalar degrades
 * honestly via the format helpers, but a missing OBJECT
 * (`all_time.per_debate.debates`) throws with no error boundary. `cap_usd`/
 * `cap_armed_at` are deliberately NOT checked here — they're two scalars no
 * consumer dereferences into, and `normalizeCapUsd`/`normalizeCapArmedAt`
 * degrade them per-field instead of voiding the whole summary.
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
 * Is this shape one `PnlCard` can actually render? Structural only —
 * `PnlCard` dereferences `overall`/`today` straight through with no error
 * boundary, so a missing OBJECT throws; individual numeric fields degrade
 * honestly via the format helpers and don't need checking here.
 */
function isPnlHeadline(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return isPlainObject(value.overall) && isPlainObject(value.today);
}

/**
 * `null` ("the wire said so") and "anything else non-finite" must not
 * collapse into each other: a corrupt `cap_usd` alongside a real
 * `cap_armed_at` is reachable with no version skew (a nullified `REAL`
 * column keeps `armed_at`), and reading it as `null` would manufacture an
 * affirmative "operator removed the ceiling" claim from an unreadable value
 */
function normalizeCapUsd(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * `undefined` (field absent) and `null` (explicitly no arming) must not
 * collapse into each other — a malformed present value is treated as
 * absent, never guessed. Checked against the store's shape AND `Date.parse`,
 * since neither alone is safe: shape-only admits calendar-invalid strings
 * (`Date.parse` rolls "Feb 30" forward instead of rejecting it), and
 * `Date.parse`-only admits non-ISO junk. The regex duplicates
 * `STORED_TIMESTAMP` (`server/shared/store/sqlite-utils.ts`) — not imported,
 * since client/ and server/ don't import each other — kept in sync by inspection.
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
 * only checks `metrics` is a non-null object, not what's inside it, so a
 * bare `number` or a `null` (from `JSON.stringify` collapsing
 * `Infinity`/`NaN`) would otherwise reach `ReviewTab.tsx`'s exhaustive
 * `switch (pf.kind)` with no `.kind` at all and throw. `null` degrades to
 * `unreadable`, not `no_losses` — `JSON.stringify` collapses `Infinity`,
 * `NaN` and `-Infinity` alike, so guessing the affirmative one would be
 * wrong. A bare finite number routes through `toProfitFactorWire` itself
 * rather than re-implementing its branches here.
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
 * Validates a parsed body ONCE, at the fetch boundary, returning it with
 * `mode` narrowed, or `null` if it's not a snapshot at all. Every degradable
 * field (`mode`, `llm_spend`, `metrics.profit_factor`, `pnl`) falls back to
 * `null`/`unreadable` per-field rather than rejecting the whole payload —
 * discarding a good snapshot over one bad field would blank a live-money
 * screen over a fault elsewhere.
 */
export function toWireSnapshot(body: unknown): WireSnapshot | null {
  if (!hasWireShape(body)) return null;
  const candidate = body as Record<string, unknown>;
  const mode = (RECOGNISED_MODES as readonly string[]).includes(candidate.mode as string)
    ? (candidate.mode as ServerMode)
    : null;
  const spend = candidate.llm_spend;
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
   * The most recent poll carried a `contract_version` other than this
   * client's own (or none). Cleared only by a poll that validates — not by
   * time or the staleness watchdog, which answers a different question.
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

/** The single place `FeedStatus` is computed from the raw booleans above */
function deriveStatus(state: FeedState): FeedStatus {
  if (state.contractMismatch) return 'contract-mismatch';
  if (state.snapshot === null) return 'waiting';
  return state.watchdogStale ? 'stale' : 'alive';
}

function describeError(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
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

  // A ref, not state: the interval callback must see current options without
  // the effect tearing down and restarting the poll clock on every payload
  const optionsRef = useRef({ url, fetchImpl, now, authToken, arm });
  optionsRef.current = { url, fetchImpl, now, authToken, arm };

  useEffect(() => {
    let cancelled = false;
    // Per-effect locals, not refs: a ref would outlive a StrictMode remount
    // and find `inFlight` still true, skipping the remount's first poll
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
      // Not replaced when already in flight: overlapping requests could let
      // an older response land after a newer one and move numbers backwards
      if (inFlight) return;
      inFlight = true;
      const controller = new AbortController();
      controllers.add(controller);
      const doFetch = optionsRef.current.fetchImpl ?? globalThis.fetch;

      // Per POLL INVOCATION, not per effect: a fresh `timedOut` per call means
      // one poll being declared dead cannot discard the next poll's payload
      let timedOut = false;
      // Idempotent, reachable from BOTH the timeout and `finally`: aborting a
      // controller does not settle a request that ignores its signal, so a
      // finally-only release would leave `inFlight` true forever after a hang
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
        const { authToken: token } = optionsRef.current;
        // Omitted entirely when there is no token, rather than sent as an
        // empty/blank header, so the default no-token request is unchanged
        const headers =
          token !== undefined && token !== null && token !== ''
            ? { Authorization: `Bearer ${token}` }
            : undefined;
        const response = await doFetch(
          snapshotUrl(optionsRef.current.url, optionsRef.current.arm),
          {
            cache: 'no-store',
            signal: controller.signal,
            ...(headers !== undefined ? { headers } : {}),
          },
        );
        if (!response.ok) throw new Error(`snapshot request failed: HTTP ${response.status}`);
        const body: unknown = await response.json();
        // Checked after BOTH awaits: a response whose headers arrived in time
        // but whose body hung must be discarded too
        if (cancelled || timedOut) return;
        // Checked BEFORE the structural check below, so a renamed/dropped
        // field is diagnosed as a contract mismatch rather than the generic
        // "did not match the wire shape" error
        const serverVersion = readServerContractVersion(body);
        if (serverVersion !== CONTRACT_VERSION) {
          // Does NOT advance `lastSuccessMs` or touch `snapshot` — not a
          // success by either measure this hook uses
          const message =
            serverVersion === undefined
              ? `served bundle disagrees with the server's wire contract (server sent no contract_version; this client expects ${CONTRACT_VERSION})`
              : `served bundle disagrees with the server's wire contract (server ${serverVersion}, client ${CONTRACT_VERSION})`;
          setState((prev) =>
            prev.contractMismatch && prev.error === message
              ? prev
              : { ...prev, contractMismatch: true, error: message },
          );
          return;
        }
        const snapshot = toWireSnapshot(body);
        if (snapshot === null) throw new Error('snapshot payload did not match the wire shape');
        lastSuccessMs = optionsRef.current.now();
        setState(() => ({
          snapshot,
          watchdogStale: false,
          contractMismatch: false,
          lastSuccessAt: new Date(lastSuccessMs).toISOString(),
          error: null,
        }));
      } catch (cause) {
        // An abort is either this effect tearing down or the timeout above,
        // which has already named itself in `error`
        if (cancelled || controller.signal.aborted) return;
        // Leaves `snapshot` and `contractMismatch` untouched: numbers stay on
        // screen, and a prior mismatch stays one until a validating poll clears it
        const message = describeError(cause);
        setState((prev) => (prev.error === message ? prev : { ...prev, error: message }));
      } finally {
        clearTimeout(timeout);
        release();
      }
    };

    void poll();

    const timer = setInterval(() => {
      // Evaluated every tick regardless of an outstanding request — "how long
      // since a successful poll" is true of a hang, a rejection and a 500 alike
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
