
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

type ServerMode = DashboardSnapshot['mode'];

export const RECOGNISED_MODES = [
  'paper',
  'live',
  'backtest',
] as const satisfies readonly ServerMode[];

export type WireSnapshot = Omit<DashboardSnapshot, 'mode' | 'llm_spend' | 'pnl'> & {
  mode: ServerMode | null;
  llm_spend: WireLlmSpendSummary | null;
  pnl: PnlHeadlineWire | null;
};

type WireLlmSpendSummary = Omit<LlmSpendSummary, 'cap_usd' | 'cap_armed_at'> & {
  cap_usd: number | null | undefined;
  cap_armed_at: string | null | undefined;
};

const SNAPSHOT_URL = '/api/snapshot';
const POLL_INTERVAL_MS = 3_000;
export const STALE_AFTER_MISSED_POLLS = 2;
function pollTimeoutMs(intervalMs: number): number {
  return intervalMs * STALE_AFTER_MISSED_POLLS;
}

export type FeedStatus = 'contract-mismatch' | 'waiting' | 'stale' | 'alive';

type ColdStatus = Exclude<FeedStatus, 'stale' | 'alive'>;

export interface SnapshotFeed {
  snapshot: WireSnapshot | null;
  lastSuccessAt: string | null;
  error: string | null;
  status: FeedStatus;
}

export type LiveFeed = Omit<SnapshotFeed, 'snapshot'> & { snapshot: WireSnapshot };

export type ColdFeed = Omit<SnapshotFeed, 'snapshot' | 'status'> & {
  snapshot: null;
  status: ColdStatus;
};

export type FeedView = { kind: 'cold'; feed: ColdFeed } | { kind: 'live'; feed: LiveFeed };

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
  fetchImpl?: typeof fetch;
  now?: () => number;
  authToken?: string | null;
  arm?: TradingArmWire;
}

export function snapshotUrl(url: string, arm?: TradingArmWire): string {
  if (arm !== 'control') return url;
  return `${url}${url.includes('?') ? '&' : '?'}arm=control`;
}

function readServerContractVersion(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const version = (value as Record<string, unknown>).contract_version;
  return typeof version === 'string' ? version : undefined;
}

function hasWireShape(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.generated_at !== 'string') return false;
  for (const key of ['positions', 'debates', 'verdicts', 'analysts']) {
    if (!Array.isArray(candidate[key])) return false;
  }
  for (const key of ['metrics', 'providers']) {
    const field = candidate[key];
    if (typeof field !== 'object' || field === null) return false;
  }
  const pipeline = candidate.pipeline;
  if (typeof pipeline !== 'object' || pipeline === null) return false;
  return Array.isArray((pipeline as Record<string, unknown>).lanes);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSpendSummary(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  for (const key of ['last_24h', 'last_7d', 'all_time']) {
    const window = value[key];
    if (!isPlainObject(window)) return false;
    if (!isPlainObject(window.per_debate)) return false;
  }
  return true;
}

function isPnlHeadline(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return isPlainObject(value.overall) && isPlainObject(value.today);
}

function normalizeCapUsd(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

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
  watchdogStale: boolean;
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

function deriveStatus(state: FeedState): FeedStatus {
  if (state.contractMismatch) return 'contract-mismatch';
  if (state.snapshot === null) return 'waiting';
  return state.watchdogStale ? 'stale' : 'alive';
}

function describeError(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

function buildAuthHeaders(token: string | null | undefined): { Authorization: string } | undefined {
  return token !== undefined && token !== null && token !== ''
    ? { Authorization: `Bearer ${token}` }
    : undefined;
}

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
  if (deps.isCancelled() || deps.isAborted()) return;
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
  if (deps.isCancelled() || deps.isTimedOut()) return null;
  const serverVersion = readServerContractVersion(body);
  if (serverVersion !== CONTRACT_VERSION) {
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

  const optionsRef = useRef({ url, fetchImpl, now, authToken, arm });
  optionsRef.current = { url, fetchImpl, now, authToken, arm };

  useEffect(() => {
    let cancelled = false;
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
      if (inFlight) return;
      inFlight = true;
      const controller = new AbortController();
      controllers.add(controller);
      const doFetch = optionsRef.current.fetchImpl ?? globalThis.fetch.bind(globalThis);

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
