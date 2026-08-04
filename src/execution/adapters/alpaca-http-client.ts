/**
 * Real broker `AlpacaClient` (ticket #273) — see
 * docs/specs/transport-layer-spec.md ("Module: AlpacaClient (broker)"),
 * Wayfinder map "Live Transport Layer" #259 (closed), decision #260, and
 * docs/research/alpaca-rest-api-surface-2026-07-29.md.
 *
 * Implements `alpaca-client.ts`'s `AlpacaClient` (`submitOrder`/`getOrder`/
 * `getOrderByClientOrderId`) against Alpaca's Trading API v2
 * (`POST /v2/orders`, `GET /v2/orders/{id}`,
 * `GET /v2/orders:by_client_order_id`). No interface change — this module
 * only supplies the real HTTP implementation `AlpacaBrokerAdapter` is
 * already injected against.
 *
 * **404 -> `null` is load-bearing.** `getOrderByClientOrderId` catches a 404
 * from Alpaca and resolves `null`, never throws — issue #86's crash-restart
 * reconciliation depends on the interface's documented `null` contract
 * holding for real (see alpaca-client.ts's doc comment on why: after a
 * restart, the client_order_id we chose ourselves is the only identifier
 * that survives).
 *
 * **Auth.** `APCA-API-KEY-ID`/`APCA-API-SECRET-KEY` headers, per Alpaca's
 * public docs (docs/research/alpaca-rest-api-surface-2026-07-29.md flags
 * this as unconfirmed against a live account — re-verify before trusting in
 * production; see this ticket's PR description). Credentials default to
 * `ALPACA_API_KEY`/`ALPACA_API_SECRET`, the same pair the market-data client
 * (market-data-service/sources/alpaca-http-client.ts) defaults to — per
 * public docs, one paper-account key pair covers both Trading and Market
 * Data APIs.
 *
 * **Base URL and environment (#293).** `environment` — `'paper'` (default) or
 * `'live'` — is the single control over which of Alpaca's two trading hosts
 * this client may reach, and `baseUrl` must agree with it. Reaching the live
 * host takes typing `environment: 'live'`; omitting the option, mis-setting an
 * env var, or passing an empty `baseUrl` all fail closed to paper or throw,
 * never to real money. A `baseUrl` naming one host while `environment` names
 * the other throws at construction, before any order can be placed — the
 * money-safety decision is made once, loudly, rather than inferred from a
 * constant nobody passed. Alpaca exposes no cheap "is this key paper or live"
 * probe (docs/research/alpaca-rest-api-surface-2026-07-29.md), so this is a
 * consistency check between two operator-supplied facts, not a verification
 * that the credentials themselves belong to the named environment. Non-Alpaca
 * hosts (a local mock, a staging proxy) are allowed in either environment:
 * they spend nothing, so there is nothing to guard.
 *
 * This posture is CLAUDE.md's money-graduation ladder (backtest -> paper ->
 * tiny live capital) expressed in code.
 *
 * Uses `fetchWithTimeout`/`withRetry` (issue #271, shared/http/) — same
 * boilerplate every real HTTP client in this transport layer shares. Retry
 * config is sized for Alpaca's ~200 req/min limit, the tightest of the four
 * transport clients' known limits (transport-layer-spec.md, "Shared
 * Conventions" story 29) — a short base delay is enough headroom without
 * risking a slow reconciliation loop.
 */

import type { RetryConfig } from '../../shared/index.js';
import { fetchWithTimeout, withRetry } from '../../shared/index.js';
import {
  AlpacaBrokerProviderError,
  classifyAlpacaBrokerNetworkError,
  classifyAlpacaBrokerResponse,
  isRetryableAlpacaBrokerError,
} from './alpaca-broker-errors.js';
import type {
  AlpacaAccount,
  AlpacaBracketOrderRequest,
  AlpacaClient,
  AlpacaOrder,
} from './alpaca-client.js';

/** Which of Alpaca's two trading environments a client is permitted to reach. */
export type AlpacaTradingEnvironment = 'paper' | 'live';

/**
 * Alpaca's two trading hosts, keyed by hostname.
 *
 * Hostname-keyed rather than prefix-matched on the full URL: DNS is
 * case-insensitive and indifferent to port, path and surrounding whitespace,
 * so `https://API.ALPACA.MARKETS`, `https://api.alpaca.markets:443/v2` and
 * `' https://api.alpaca.markets'` all reach real money while failing a
 * `startsWith` comparison. Anything a prefix check would wave through is a
 * paper process placing live orders.
 *
 * The live URL is deliberately not exported as a named constant (PR #301
 * review): an importable `ALPACA_LIVE_BASE_URL` is an affordance for reaching
 * the live host without going through the guard. Callers name the environment;
 * this module resolves the host.
 */
const ALPACA_TRADING_HOSTS: Readonly<Record<string, AlpacaTradingEnvironment>> = {
  'paper-api.alpaca.markets': 'paper',
  'api.alpaca.markets': 'live',
};

const BASE_URL_BY_ENVIRONMENT: Readonly<Record<AlpacaTradingEnvironment, string>> = {
  paper: 'https://paper-api.alpaca.markets',
  live: 'https://api.alpaca.markets',
};

/**
 * Which Alpaca trading environment a base URL actually reaches.
 *
 * `'other'` is a host Alpaca does not serve trading from (a local mock, a
 * staging proxy) — permitted in either environment. `'invalid'` is a string
 * that is not an absolute URL at all, including the empty string; it is
 * reported rather than defaulted, because a base URL nobody can parse is a
 * misconfiguration, and quietly substituting one is how a process ends up
 * somewhere its operator did not choose.
 *
 * Exported so the orchestrator's composition root classifies `ALPACA_BASE_URL`
 * with exactly the same rules this client enforces, rather than a second
 * approximation of them.
 */
export function classifyAlpacaTradingHost(
  baseUrl: string,
): AlpacaTradingEnvironment | 'other' | 'invalid' {
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return 'invalid';
  }
  return ALPACA_TRADING_HOSTS[hostname] ?? 'other';
}

/**
 * The base URL this client will use, or a throw.
 *
 * Absent `baseUrl` resolves from `environment` — so the failure mode of
 * "nobody passed anything" is the paper host, and the failure mode of "someone
 * passed the wrong thing" is a crash rather than a wrong-account order. The
 * messages carry `environment` and `baseUrl` only; credentials are never
 * interpolated into an error from this module (see the options' doc comments).
 */
function resolveBaseUrl(environment: AlpacaTradingEnvironment, override?: string): string {
  if (override === undefined) return BASE_URL_BY_ENVIRONMENT[environment];

  const host = classifyAlpacaTradingHost(override);
  if (host === 'invalid') {
    throw new Error(
      `AlpacaHttpBrokerClient: baseUrl '${override}' is not an absolute URL. Omit it to use the ` +
        `${environment} host, or pass a full origin such as https://localhost:9999 for a mock.`,
    );
  }
  if (host !== 'other' && host !== environment) {
    throw new Error(
      `AlpacaHttpBrokerClient: baseUrl '${override}' is Alpaca's ${host} trading host but ` +
        `environment is '${environment}'. Refusing to construct: these must agree, because the ` +
        'one is the account the orders land in and the other is what the operator believes they ' +
        `set. Pass environment: '${host}' if that is genuinely intended.`,
    );
  }
  return override;
}

const DEFAULT_TIMEOUT_MS = 10_000;
/** ~200 req/min (issue #260 research) tolerates a short base delay; capped well under the reconciliation loop's own budget. */
const DEFAULT_RETRY_CONFIG: RetryConfig = { maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 4_000 };

export interface AlpacaHttpBrokerClientOptions {
  /** Defaults to `process.env.ALPACA_API_KEY`. Never logged or thrown into an error message. */
  apiKey?: string;
  /** Defaults to `process.env.ALPACA_API_SECRET`. Never logged or thrown into an error message. */
  apiSecret?: string;
  /**
   * Which Alpaca trading environment this client may reach. Defaults to
   * `'paper'` — live is never reached by omission, only by naming it. Must
   * agree with `baseUrl` when that names one of Alpaca's trading hosts.
   */
  environment?: AlpacaTradingEnvironment;
  /**
   * Defaults to the host `environment` implies. Supply it only to point at a
   * non-Alpaca endpoint (mock/staging) — naming the other environment's host
   * throws rather than overriding `environment`.
   */
  baseUrl?: string;
  /** Per-attempt network timeout passed to `fetchWithTimeout`. */
  timeoutMs?: number;
  retry?: RetryConfig;
}

/** Real HTTP broker `AlpacaClient` against Alpaca's Trading API v2. */
export class AlpacaHttpBrokerClient implements AlpacaClient {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  /**
   * Public and readonly: the resolved host is the fact a startup log needs to
   * state, and re-deriving it at the composition root would be a second copy
   * of the resolution rules. Carries no credential.
   */
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly retry: RetryConfig;

  constructor(options: AlpacaHttpBrokerClientOptions = {}) {
    const apiKey = options.apiKey ?? process.env.ALPACA_API_KEY;
    const apiSecret = options.apiSecret ?? process.env.ALPACA_API_SECRET;
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error(
        'AlpacaHttpBrokerClient: ALPACA_API_KEY is not set. Provide it via the environment ' +
          '(.env.local) or pass { apiKey } explicitly.',
      );
    }
    if (apiSecret === undefined || apiSecret.length === 0) {
      throw new Error(
        'AlpacaHttpBrokerClient: ALPACA_API_SECRET is not set. Provide it via the environment ' +
          '(.env.local) or pass { apiSecret } explicitly.',
      );
    }
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.baseUrl = resolveBaseUrl(options.environment ?? 'paper', options.baseUrl);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retry = options.retry ?? DEFAULT_RETRY_CONFIG;
  }

  private headers(init: RequestInit): Record<string, string> {
    return {
      ...(init.body != null ? { 'content-type': 'application/json' } : {}),
      'APCA-API-KEY-ID': this.apiKey,
      'APCA-API-SECRET-KEY': this.apiSecret,
    };
  }

  /** Runs one HTTP attempt through `withRetry`, returning the parsed JSON body of a 2xx response. */
  private async request<T>(path: string, init: RequestInit, context: string): Promise<T> {
    return withRetry<T>(
      async () => {
        let response: Response;
        try {
          response = await fetchWithTimeout(
            `${this.baseUrl}${path}`,
            { ...init, headers: this.headers(init) },
            this.timeoutMs,
          );
        } catch (cause) {
          throw classifyAlpacaBrokerNetworkError(cause, context);
        }

        if (!response.ok) {
          throw await classifyAlpacaBrokerResponse(response, context);
        }

        try {
          return (await response.json()) as T;
        } catch (cause) {
          throw new AlpacaBrokerProviderError(
            `Alpaca API error: response body could not be parsed as JSON (${context}): ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          );
        }
      },
      this.retry,
      isRetryableAlpacaBrokerError,
    );
  }

  async submitOrder(request: AlpacaBracketOrderRequest): Promise<AlpacaOrder> {
    // `type: 'limit'` is a wire-only field, not part of `AlpacaBracketOrderRequest` — the
    // interface's `limit_price` already implies a limit entry, but Alpaca's `POST /v2/orders`
    // still requires the `type` field on the request body itself (#260 research). Adding it
    // here, not to the interface, keeps the "no interface change" constraint intact.
    return this.request<AlpacaOrder>(
      '/v2/orders',
      { method: 'POST', body: JSON.stringify({ ...request, type: 'limit' }) },
      'submitOrder',
    );
  }

  async getAccount(): Promise<AlpacaAccount> {
    return this.request<AlpacaAccount>('/v2/account', { method: 'GET' }, 'getAccount');
  }

  async getOrder(alpacaOrderId: string): Promise<AlpacaOrder> {
    return this.request<AlpacaOrder>(
      `/v2/orders/${encodeURIComponent(alpacaOrderId)}`,
      { method: 'GET' },
      'getOrder',
    );
  }

  async getOrderByClientOrderId(clientOrderId: string): Promise<AlpacaOrder | null> {
    try {
      return await this.request<AlpacaOrder>(
        `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}`,
        { method: 'GET' },
        'getOrderByClientOrderId',
      );
    } catch (error) {
      if (error instanceof AlpacaBrokerProviderError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }
}
