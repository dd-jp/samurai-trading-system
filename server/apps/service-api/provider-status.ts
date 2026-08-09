/**
 * Provider status panel — the Alpaca balance and Polygon health half of the
 * dashboard's provider tiles. (The Anthropic half is metered spend, which is
 * persisted; see `llm_spend` / migrations/0010_llm_spend.sql.)
 *
 * ## Why this is polled in-process instead of read from SQLite
 *
 * Every other number on this dashboard is written by the orchestrator and read
 * back out of the shared store, and the obvious symmetry would be to have the
 * orchestrator poll these providers too. It is the wrong shape here, for two
 * reasons:
 *
 *  1. **The data would be as dead as the orchestrator.** Cash, equity and
 *     "is my market-data key working" are exactly the questions an operator
 *     asks WHEN the orchestrator is down — the moment a store-backed tile
 *     would go stale and stop answering them.
 *  2. **It would make the dashboard a writer.** dashboard-spec.md's "strictly
 *     read-only" is about trading actions, but the process currently opens the
 *     shared store and never issues an `INSERT`; keeping it that way is worth
 *     more than the symmetry.
 *
 * So this is live state, held in memory, refreshed on a timer, and read
 * synchronously by `buildSnapshot`. Nothing here is persisted, and losing it
 * on restart costs one poll interval.
 *
 * ## Why the snapshot builder stays pure
 *
 * The poller owns the I/O and the clock; `readProviderStatus()` is a
 * synchronous read of whatever the last poll left behind. `buildSnapshot`
 * therefore remains a pure function of its injected readers (dashboard-spec.md
 * "Testing Decisions"), and no request handler ever awaits a third-party API —
 * a hung Alpaca call slows a background timer, never the operator's page load.
 *
 * ## What "balance" means per provider
 *
 * Only Alpaca has one. Polygon sells a subscription and publishes no balance,
 * credits, or quota endpoint at all, so its tile reports reachability and
 * entitlement instead — which is the more useful signal anyway, since a dead
 * market-data key is what stalls the pipeline at `analysts: quorum_skip`.
 */

import type { AlpacaClient } from '../../pipeline/execution/adapters/alpaca-client.js';
import { fetchWithTimeout } from '../../shared/http/fetch-with-timeout.js';

/**
 * The rendered tile shapes live in `contracts/providers.ts` — the browser
 * draws them, so they are wire, not server-internal. Re-exported here so the
 * poller's own callers keep one import site.
 *
 * The split is along behavior: everything below this line does live HTTP
 * probing and holds mutable in-memory state, and none of it can cross to a
 * browser. `ProviderStatusPoller` in particular reaches `AlpacaClient` in
 * `server/pipeline/execution/`, so moving it would have dragged the broker adapter types
 * into the client's TypeScript program — the opposite of the point.
 */
export type {
  AlpacaBalanceWire,
  AlpacaTile,
  PolygonTile,
  ProviderState,
  ProviderStatusPanel,
  ProviderTile,
} from '../../../contracts/providers.js';

// Imported as well as re-exported above: `export … from` publishes a name
// without binding it locally, and the poller below annotates with all four.
import type {
  AlpacaTile,
  PolygonTile,
  ProviderState,
  ProviderStatusPanel,
} from '../../../contracts/providers.js';

/** The synchronous seam `buildSnapshot` reads. */
export interface ProviderStatusReader {
  readProviderStatus(): ProviderStatusPanel;
}

const NOT_YET_POLLED: ProviderStatusPanel = {
  alpaca: {
    provider: 'alpaca',
    state: 'not_configured',
    detail: 'not polled yet',
    observed_at: null,
    balance: null,
  },
  polygon: {
    provider: 'polygon',
    state: 'not_configured',
    detail: 'not polled yet',
    observed_at: null,
  },
};

/**
 * Returned when no poller is wired (e.g. a test server, or a dashboard started
 * without credentials). Keeps `buildSnapshot`'s signature total — the panel is
 * always present, and "not configured" is a state the UI renders rather than a
 * missing key consumers must guard.
 */
export const NULL_PROVIDER_STATUS: ProviderStatusReader = {
  readProviderStatus: () => NOT_YET_POLLED,
};

/**
 * 15 minutes (review 2026-08-06 A5; was 60s). Both probes cost a real,
 * authenticated API call, and a status light does not need to be fresher
 * than the tick cadence it sits next to (ADR-0008: 15 min). At 60s the
 * Polygon probe alone was 1,440 calls/day — by itself in breach of the free
 * tier's 5-requests/minute budget the moment anything ran alongside it, all
 * to answer a reachability tile whose answer changes approximately never.
 */
export const DEFAULT_POLL_INTERVAL_MS = 15 * 60_000;

/** Per-probe network timeout. Well under the poll interval so probes cannot overlap. */
const PROBE_TIMEOUT_MS = 10_000;

const DEFAULT_POLYGON_BASE_URL = 'https://api.polygon.io';

/**
 * `/v1/marketstatus/now` is the probe endpoint: it is authenticated (so it
 * actually exercises the key), cheap, has no date/ticker parameters to get
 * wrong, and is not tied to a symbol whose absence from a plan would produce a
 * misleading 403. A 403 from THIS path means the key genuinely lacks access,
 * which is the thing worth reporting.
 */
const POLYGON_PROBE_PATH = '/v1/marketstatus/now';

/** Alpaca returns money as decimal strings; anything unparseable becomes `null`, never `NaN`. */
function parseMoney(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Last-resort rejection sink for the poll timer. Intentionally silent: the
 * only way to reach it is a bug in a probe's own error handling, and the tile
 * that bug produces is already the operator-visible symptom.
 */
function swallow(): void {}

/**
 * Bounds a promise that this module cannot bound from the inside.
 *
 * The Polygon probe gets its deadline from `fetchWithTimeout`, but the Alpaca
 * probe goes through the injected `AlpacaClient` interface, which promises
 * nothing about timeouts — the real `AlpacaHttpBrokerClient` has its own, a
 * different implementation need not. Without this, one hung `getAccount()`
 * leaves `pollOnce` pending forever, and because the two probes share a
 * `Promise.all`, it takes the POLYGON tile down with it: the whole panel
 * freezes at its last value with nothing on screen saying so.
 *
 * The loser of a `Promise.race` stays pending, so if the slow call later
 * rejects with nobody listening Node treats it as an unhandled rejection and
 * kills the process. `work.catch(swallow)` is what makes the race safe; the
 * `finally` clears the timer so a fast win does not leave one armed.
 */
function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  work.catch(swallow);
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([work, expiry]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** Maps an HTTP status onto the operator-facing cause. */
function stateForStatus(status: number): ProviderState {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 429) return 'rate_limited';
  return 'error';
}

export interface ProviderStatusPollerOptions {
  /**
   * The same `AlpacaClient` the broker adapter uses. Omit to render Alpaca as
   * `not_configured` — a dashboard started without trading credentials still
   * works, it just cannot show a balance.
   */
  // Explicit `| undefined` rather than a bare `?`: under
  // `exactOptionalPropertyTypes` the two differ, and the caller
  // (dashboard/index.ts) passes the result of a build that returns `undefined`
  // when credentials are missing — which is the normal case here, not an edge.
  alpaca?: AlpacaClient | undefined;
  /** Defaults to `process.env.POLYGON_API_KEY`; absent renders Polygon as `not_configured`. */
  polygonApiKey?: string;
  polygonBaseUrl?: string;
  intervalMs?: number;
}

/**
 * Polls both providers on a timer and holds the latest result in memory.
 *
 * Failure is a RESULT here, not an exception: every probe resolves to a tile,
 * including the failed ones, because "Polygon is 401" is precisely what the
 * operator opened the dashboard to find out. Nothing in this class throws to
 * its caller, and an unhandled rejection inside the timer would take down the
 * dashboard process for a status light.
 */
export class ProviderStatusPoller implements ProviderStatusReader {
  private panel: ProviderStatusPanel = NOT_YET_POLLED;
  private timer: NodeJS.Timeout | undefined;
  private readonly alpaca: AlpacaClient | undefined;
  private readonly polygonApiKey: string | undefined;
  private readonly polygonBaseUrl: string;
  private readonly intervalMs: number;

  constructor(options: ProviderStatusPollerOptions = {}) {
    this.alpaca = options.alpaca;
    this.polygonApiKey = options.polygonApiKey ?? process.env.POLYGON_API_KEY;
    this.polygonBaseUrl = options.polygonBaseUrl ?? DEFAULT_POLYGON_BASE_URL;
    this.intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  readProviderStatus(): ProviderStatusPanel {
    return this.panel;
  }

  /**
   * Runs one poll immediately (so the first page load is not a screen of
   * "not polled yet") and then on the interval. `unref()` keeps the timer from
   * holding the process open on shutdown.
   */
  async start(): Promise<void> {
    // Both probes resolve rather than reject by construction, so `swallow`
    // should never fire. It is here because the caller uses `void start()` —
    // an unhandled rejection in that position terminates the Node process, and
    // taking the dashboard down over a status light would be an absurd way to
    // lose the operator surface. Belt on top of the braces, deliberately.
    await this.pollOnce().catch(swallow);
    this.timer = setInterval(() => {
      void this.pollOnce().catch(swallow);
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Exported behaviour for tests: one probe of each provider, concurrently. */
  async pollOnce(): Promise<ProviderStatusPanel> {
    const [alpaca, polygon] = await Promise.all([this.probeAlpaca(), this.probePolygon()]);
    this.panel = { alpaca, polygon };
    return this.panel;
  }

  private async probeAlpaca(): Promise<AlpacaTile> {
    const observed_at = new Date().toISOString();
    if (this.alpaca === undefined) {
      return {
        provider: 'alpaca',
        state: 'not_configured',
        // Both pairs named, because which one is missing depends on
        // `SAMURAI_MODE` (#511): the dashboard builds its client for the same
        // environment the orchestrator trades in, and Alpaca issues a separate
        // key pair per account. Naming only the paper pair sent a live operator
        // to check a variable that was already set.
        detail:
          'no Alpaca client wired (ALPACA_API_KEY / ALPACA_API_SECRET unset — or, under ' +
          'SAMURAI_MODE=live, ALPACA_LIVE_API_KEY / ALPACA_LIVE_API_SECRET?)',
        observed_at,
        balance: null,
      };
    }

    try {
      const account = await withTimeout(
        this.alpaca.getAccount(),
        PROBE_TIMEOUT_MS,
        'Alpaca account probe',
      );
      const cash = parseMoney(account.cash);
      const equity = parseMoney(account.equity);
      if (cash === null || equity === null) {
        // A 200 whose numbers do not parse is not a healthy account — surfacing
        // it as `ok` with a blank balance would read as "zero", which on a
        // money tile is the one wrong answer that looks like a right one.
        return {
          provider: 'alpaca',
          state: 'error',
          detail: 'account returned unparseable cash/equity',
          observed_at,
          balance: null,
        };
      }
      return {
        provider: 'alpaca',
        state: 'ok',
        detail: 'account reachable',
        observed_at,
        balance: { cash, equity, buying_power: parseMoney(account.buying_power) },
      };
    } catch (error) {
      return {
        provider: 'alpaca',
        state: this.stateForError(error),
        detail: this.describeError(error),
        observed_at,
        balance: null,
      };
    }
  }

  private async probePolygon(): Promise<PolygonTile> {
    const observed_at = new Date().toISOString();
    if (this.polygonApiKey === undefined || this.polygonApiKey.length === 0) {
      return {
        provider: 'polygon',
        state: 'not_configured',
        detail: 'POLYGON_API_KEY unset',
        observed_at,
      };
    }

    try {
      const response = await fetchWithTimeout(
        `${this.polygonBaseUrl}${POLYGON_PROBE_PATH}`,
        // Bearer header rather than the `apiKey` query parameter Polygon also
        // accepts: a URL-embedded key ends up in any error message, proxy log
        // or stack trace that quotes the request URL.
        { headers: { Authorization: `Bearer ${this.polygonApiKey}` } },
        PROBE_TIMEOUT_MS,
      );
      if (!response.ok) {
        return {
          provider: 'polygon',
          state: stateForStatus(response.status),
          detail: `HTTP ${response.status} from ${POLYGON_PROBE_PATH}`,
          observed_at,
        };
      }
      return {
        provider: 'polygon',
        state: 'ok',
        detail: 'key valid, market data reachable',
        observed_at,
      };
    } catch (error) {
      return {
        provider: 'polygon',
        state: 'error',
        detail: this.describeError(error),
        observed_at,
      };
    }
  }

  /** Duck-types `.status` the same way `AnthropicLlmClient.classifyProviderError` does. */
  private stateForError(error: unknown): ProviderState {
    const status = (error as { status?: unknown } | null)?.status;
    return typeof status === 'number' ? stateForStatus(status) : 'error';
  }

  /**
   * Truncated, and never interpolating anything credential-shaped: this string
   * is rendered verbatim into a web page, so it is treated as untrusted output
   * rather than a log line.
   */
  private describeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.length > 200 ? `${message.slice(0, 200)}…` : message;
  }
}
