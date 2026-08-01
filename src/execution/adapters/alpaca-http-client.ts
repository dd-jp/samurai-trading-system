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
 * **Base URL.** Defaults to the paper-trading host
 * (`https://paper-api.alpaca.markets`) — this system trades paper-only per
 * CLAUDE.md's money-graduation posture (backtest -> paper -> tiny live
 * capital); the live host (`https://api.alpaca.markets`) is an explicit
 * `baseUrl` override, never a silent default.
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
import type { AlpacaBracketOrderRequest, AlpacaClient, AlpacaOrder } from './alpaca-client.js';

const DEFAULT_BASE_URL = 'https://paper-api.alpaca.markets';
const DEFAULT_TIMEOUT_MS = 10_000;
/** ~200 req/min (issue #260 research) tolerates a short base delay; capped well under the reconciliation loop's own budget. */
const DEFAULT_RETRY_CONFIG: RetryConfig = { maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 4_000 };

export interface AlpacaHttpBrokerClientOptions {
  /** Defaults to `process.env.ALPACA_API_KEY`. Never logged or thrown into an error message. */
  apiKey?: string;
  /** Defaults to `process.env.ALPACA_API_SECRET`. Never logged or thrown into an error message. */
  apiSecret?: string;
  /** Defaults to the paper-trading host. Pass the live host explicitly to trade real money. */
  baseUrl?: string;
  /** Per-attempt network timeout passed to `fetchWithTimeout`. */
  timeoutMs?: number;
  retry?: RetryConfig;
}

/** Real HTTP broker `AlpacaClient` against Alpaca's Trading API v2. */
export class AlpacaHttpBrokerClient implements AlpacaClient {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly baseUrl: string;
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
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
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
  private async request(path: string, init: RequestInit, context: string): Promise<unknown> {
    return withRetry(
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
          return await response.json();
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
    const body = await this.request(
      '/v2/orders',
      { method: 'POST', body: JSON.stringify({ ...request, type: 'limit' }) },
      'submitOrder',
    );
    return body as AlpacaOrder;
  }

  async getOrder(alpacaOrderId: string): Promise<AlpacaOrder> {
    const body = await this.request(
      `/v2/orders/${encodeURIComponent(alpacaOrderId)}`,
      { method: 'GET' },
      'getOrder',
    );
    return body as AlpacaOrder;
  }

  async getOrderByClientOrderId(clientOrderId: string): Promise<AlpacaOrder | null> {
    try {
      const body = await this.request(
        `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}`,
        { method: 'GET' },
        'getOrderByClientOrderId',
      );
      return body as AlpacaOrder;
    } catch (error) {
      if (error instanceof AlpacaBrokerProviderError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }
}
