/**
 * Real HTTP implementation of `AlpacaBrokerClient` against Alpaca's Trading API v2.
 * `environment`/`baseUrl` must agree — a mismatch throws at construction rather than risking a wrong-account order.
 */

import type { RetryConfig } from '../../../shared/index.js';
import { fetchWithTimeout, truncateForError, withRetry } from '../../../shared/index.js';
import type { AlpacaHttpMethod } from './alpaca-broker-errors.js';
import {
  AlpacaBrokerProviderError,
  classifyAlpacaBrokerNetworkError,
  classifyAlpacaBrokerResponse,
  isRetryableAlpacaBrokerError,
} from './alpaca-broker-errors.js';
import type {
  AlpacaAccount,
  AlpacaBracketOrderRequest,
  AlpacaBrokerClient,
  AlpacaLimitOrderRequest,
  AlpacaMarketOrderRequest,
  AlpacaOcoOrderRequest,
  AlpacaOrder,
  AlpacaPosition,
  AlpacaStopLimitOrderRequest,
} from './alpaca-client.js';

/**
 * Per-shape response validation (#509): this is the one client whose fields feed money math directly,
 * so `AlpacaOrder`/`AlpacaPosition[]`/`AlpacaAccount` are each validated at their call site
 */

/** `method` is required (#1275): retry classification (`isRetryableAlpacaBrokerError`) reads it back off `init.method` */
type AlpacaRequestInit = Omit<RequestInit, 'method'> & { method: AlpacaHttpMethod };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Alpaca reports decimals as strings; this validates the string is numeric-parseable without converting it,
 * so a garbage value can't silently become `NaN` downstream
 */
function isFiniteNumericString(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Number(value));
}

/** Throws a classified, message-bounded `AlpacaBrokerProviderError` for a validation failure */
function failValidation(context: string, detail: string, body: unknown): never {
  throw new AlpacaBrokerProviderError(
    `Alpaca API error: malformed response body (${context}): ${detail} — ${truncateForError(
      JSON.stringify(body),
    )}`,
  );
}

/**
 * Validates only the leg fields callers actually read (`id`/`type` always; fill fields only when present) —
 * Alpaca's real payload carries fields this repo's `AlpacaOrderLeg` doesn't declare, so validation happens
 * in place without rebuilding the object
 */
/** Scalar/string fields of an order response, split out to keep `validateAlpacaOrder` under the complexity gate */
function validateAlpacaOrderLeg(raw: unknown, context: string, body: unknown): void {
  if (!isRecord(raw)) failValidation(context, 'a bracket leg was not an object', body);
  const { id, type, status, filled_qty, filled_avg_price, filled_at } = raw;
  if (typeof id !== 'string') failValidation(context, 'leg.id must be a string', body);
  if (type !== 'limit' && type !== 'stop') {
    failValidation(context, "leg.type must be 'limit' or 'stop'", body);
  }
  if (status !== undefined && typeof status !== 'string') {
    failValidation(context, 'leg.status must be a string', body);
  }
  if (filled_qty !== undefined && !isFiniteNumericString(filled_qty)) {
    failValidation(context, 'leg.filled_qty must be a numeric string', body);
  }
  if (
    filled_avg_price !== undefined &&
    filled_avg_price !== null &&
    !isFiniteNumericString(filled_avg_price)
  ) {
    failValidation(context, 'leg.filled_avg_price must be a numeric string or null', body);
  }
  if (filled_at !== undefined && filled_at !== null && typeof filled_at !== 'string') {
    failValidation(context, 'leg.filled_at must be a string or null', body);
  }
}

/**
 * Validates only the fields `alpaca-adapter.ts` actually reads off a response (`id`, `status`, `legs`, fill triad) —
 * requiring undocumented fields like `order_class` would fail order submission on an unverified shape guess.
 * Validates in place; does not rebuild the object, since Alpaca's real payload carries undeclared fields callers rely on.
 */
function validateAlpacaOrderCoreFields(body: Record<string, unknown>, context: string): void {
  const {
    id,
    client_order_id,
    symbol,
    side,
    qty,
    order_class,
    status,
    filled_qty,
    filled_avg_price,
    filled_at,
  } = body;
  if (typeof id !== 'string') failValidation(context, 'id must be a string', body);
  // Declared but unread off a response; checked only when present (see validateAlpacaOrder doc comment)
  if (client_order_id !== undefined && typeof client_order_id !== 'string') {
    failValidation(context, 'client_order_id must be a string', body);
  }
  if (symbol !== undefined && typeof symbol !== 'string') {
    failValidation(context, 'symbol must be a string', body);
  }
  if (side !== undefined && side !== 'buy' && side !== 'sell') {
    failValidation(context, "side must be 'buy' or 'sell'", body);
  }
  if (qty !== undefined && !isFiniteNumericString(qty)) {
    failValidation(context, 'qty must be a numeric string', body);
  }
  if (order_class !== undefined && typeof order_class !== 'string') {
    failValidation(context, 'order_class must be a string', body);
  }
  if (typeof status !== 'string') failValidation(context, 'status must be a string', body);
  if (!isFiniteNumericString(filled_qty)) {
    failValidation(context, 'filled_qty must be a numeric string', body);
  }
  if (filled_avg_price !== null && !isFiniteNumericString(filled_avg_price)) {
    failValidation(context, 'filled_avg_price must be a numeric string or null', body);
  }
  if (filled_at !== null && typeof filled_at !== 'string') {
    failValidation(context, 'filled_at must be a string or null', body);
  }
}

function validateAlpacaOrder(body: unknown, context: string): AlpacaOrder {
  if (!isRecord(body)) failValidation(context, 'expected an object', body);
  validateAlpacaOrderCoreFields(body, context);
  const { legs } = body;
  // `null` is ABSENT here, not malformed (#921): Alpaca returns `"legs": null` for every order with no legs,
  // which broke `submitFlatten`/`resumeFlatten` when only `undefined` was excused
  // Verified live 2026-08-26: a filled market sell returns `"legs": null` with `"order_class": ""`
  if (legs !== undefined && legs !== null) {
    if (!Array.isArray(legs)) failValidation(context, 'legs must be an array', body);
    for (const leg of legs) validateAlpacaOrderLeg(leg, context, body);
  }
  // Double cast: TS considers isRecord's Record<string, unknown> too dissimilar for a direct assertion to AlpacaOrder
  return body as unknown as AlpacaOrder;
}

function validateAlpacaOrders(body: unknown, context: string): AlpacaOrder[] {
  if (!Array.isArray(body)) failValidation(context, 'expected an array', body);
  return body.map((raw) => validateAlpacaOrder(raw, context));
}

/**
 * Complements `getOpenPositions`'s `Number.isFinite` guard with the type-level check it can't do:
 * a non-string `qty` would otherwise pass through as a structurally wrong `AlpacaPosition`
 */
function validateAlpacaPosition(raw: unknown, context: string): void {
  if (!isRecord(raw)) failValidation(context, 'a position was not an object', raw);
  const { symbol, qty, side, avg_entry_price } = raw;
  if (typeof symbol !== 'string') failValidation(context, 'symbol must be a string', raw);
  if (!isFiniteNumericString(qty)) failValidation(context, 'qty must be a numeric string', raw);
  if (side !== 'long' && side !== 'short') {
    failValidation(context, "side must be 'long' or 'short'", raw);
  }
  if (!isFiniteNumericString(avg_entry_price)) {
    failValidation(context, 'avg_entry_price must be a numeric string', raw);
  }
}

function validateAlpacaPositions(body: unknown, context: string): AlpacaPosition[] {
  if (!Array.isArray(body)) failValidation(context, 'expected an array', body);
  for (const raw of body) validateAlpacaPosition(raw, context);
  return body as AlpacaPosition[];
}

/**
 * Validates `cash`/`equity`, which feed `AccountStateProvider`'s high-water mark.
 * `last_equity` is typed `never` (#332) and deliberately not validated — nothing may read it.
 */
function validateAlpacaAccount(body: unknown, context: string): AlpacaAccount {
  if (!isRecord(body)) failValidation(context, 'expected an object', body);
  const { cash, equity, buying_power } = body;
  if (!isFiniteNumericString(cash)) failValidation(context, 'cash must be a numeric string', body);
  if (!isFiniteNumericString(equity)) {
    failValidation(context, 'equity must be a numeric string', body);
  }
  if (buying_power !== undefined && !isFiniteNumericString(buying_power)) {
    failValidation(context, 'buying_power must be a numeric string', body);
  }
  // See `validateAlpacaOrder`'s comment on the double cast
  return body as unknown as AlpacaAccount;
}

/** Which of Alpaca's two trading environments a client is permitted to reach */
export type AlpacaTradingEnvironment = 'paper' | 'live';

/**
 * Alpaca's two trading hosts, keyed by hostname (not URL-prefix-matched — case/port/whitespace variance
 * would let a live host slip past a `startsWith` check). Live URL is not exported as a constant (PR #301)
 * so callers name the environment, not the host, directly.
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
 * Classifies a base URL's environment. `'invalid'` (unparseable, including empty) is reported rather than
 * defaulted — a misconfigured URL should crash, not silently resolve somewhere unintended.
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
 * Resolves the base URL or throws. Absent `baseUrl` defaults to paper; a `baseUrl`/`environment` mismatch
 * throws rather than silently picking one, so a misconfiguration crashes instead of trading the wrong account.
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
/** ~200 req/min (issue #260 research) tolerates a short base delay; capped well under the reconciliation loop's own budget */
const DEFAULT_RETRY_CONFIG: RetryConfig = { maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 4_000 };

/**
 * Alpaca issues separate key pairs for paper and live (#511); keyed off `environment` here since that's
 * the single point of control an option-with-env-default requires callers to pass
 */
export const ALPACA_CREDENTIAL_ENV_VARS: Readonly<
  Record<AlpacaTradingEnvironment, { readonly key: string; readonly secret: string }>
> = {
  paper: { key: 'ALPACA_API_KEY', secret: 'ALPACA_API_SECRET' },
  live: { key: 'ALPACA_LIVE_API_KEY', secret: 'ALPACA_LIVE_API_SECRET' },
};

export interface AlpacaHttpBrokerClientOptions {
  /**
   * Defaults to `ALPACA_CREDENTIAL_ENV_VARS[environment].key`. No fallback from live to paper key —
   * a live client on a paper key must fail rather than silently trade the wrong account.
   */
  apiKey?: string;
  /** Defaults to `ALPACA_CREDENTIAL_ENV_VARS[environment].secret`. Never logged or thrown into an error message. */
  apiSecret?: string;
  /** Which Alpaca environment to reach. Defaults to `'paper'` — live is never reached by omission, only by naming it. */
  environment?: AlpacaTradingEnvironment;
  /** Defaults to the host `environment` implies; naming the other environment's host throws rather than overriding it */
  baseUrl?: string;
  /** Per-attempt network timeout passed to `fetchWithTimeout` */
  timeoutMs?: number;
  retry?: RetryConfig;
}

/** Real HTTP broker `AlpacaBrokerClient` against Alpaca's Trading API v2 */
export class AlpacaHttpBrokerClient implements AlpacaBrokerClient {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  /** Public so a startup log can state the resolved host without re-deriving the resolution rules */
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly retry: RetryConfig;

  constructor(options: AlpacaHttpBrokerClientOptions = {}) {
    // Resolved first: decides which credential pair (#511) and which host apply below
    const environment = options.environment ?? 'paper';
    const names = ALPACA_CREDENTIAL_ENV_VARS[environment];
    // Whitespace-only env value counts as absent (an `--env-file` placeholder becomes `''`); only the
    // env default is trimmed, never a value the caller passed explicitly
    const fromEnv = (name: string): string | undefined => {
      const value = process.env[name]?.trim();
      return value === undefined || value.length === 0 ? undefined : value;
    };
    const apiKey = options.apiKey ?? fromEnv(names.key);
    const apiSecret = options.apiSecret ?? fromEnv(names.secret);
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error(
        `AlpacaHttpBrokerClient: ${names.key} is not set. Provide it via the environment ` +
          `(.env.local) or pass { apiKey } explicitly. This is the ${environment} account's ` +
          'key; Alpaca issues a different pair per account and neither substitutes for the ' +
          'other.',
      );
    }
    if (apiSecret === undefined || apiSecret.length === 0) {
      throw new Error(
        `AlpacaHttpBrokerClient: ${names.secret} is not set. Provide it via the environment ` +
          `(.env.local) or pass { apiSecret } explicitly. This is the ${environment} account's ` +
          'secret; Alpaca issues a different pair per account and neither substitutes for the ' +
          'other.',
      );
    }
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.baseUrl = resolveBaseUrl(environment, options.baseUrl);
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

  /**
   * One HTTP attempt via `withRetry`, returning the parsed and validated body. `validate` is supplied
   * per call site (#509) since the three response shapes share no structure.
   */
  private async request<T>(
    path: string,
    init: AlpacaRequestInit,
    context: string,
    validate: (body: unknown, context: string) => T,
    retry: RetryConfig = this.retry,
  ): Promise<T> {
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
          throw classifyAlpacaBrokerNetworkError(cause, context, init.method);
        }

        if (!response.ok) {
          throw await classifyAlpacaBrokerResponse(response, context, init.method);
        }

        let parsed: unknown;
        try {
          parsed = await response.json();
        } catch (cause) {
          throw new AlpacaBrokerProviderError(
            `Alpaca API error: response body could not be parsed as JSON (${context}): ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          );
        }

        // Outside the try/catch: `validate` throws its own already-classified error, and catching it
        // here would just re-wrap it for no benefit (#509)
        return validate(parsed, context);
      },
      retry,
      isRetryableAlpacaBrokerError,
    );
  }

  /**
   * Single attempt, no transport retry (#1275) — the one place `maxAttempts: 1` for order placement lives,
   * so removing it removes it from every placement at once rather than leaving per-call copies to drift
   */
  private async submitPlacement<T>(
    path: string,
    init: AlpacaRequestInit,
    context: string,
    validate: (body: unknown, context: string) => T,
  ): Promise<T> {
    return this.request<T>(path, init, context, validate, { ...this.retry, maxAttempts: 1 });
  }

  async submitOrder(request: AlpacaBracketOrderRequest): Promise<AlpacaOrder> {
    // `type` is wire-only (not on the interface) — Alpaca's POST /v2/orders requires it on the body
    // even though `limit_price` already implies a limit entry
    return this.submitPlacement<AlpacaOrder>(
      '/v2/orders',
      { method: 'POST', body: JSON.stringify({ ...request, type: 'limit' }) },
      'submitOrder',
      validateAlpacaOrder,
    );
  }

  /** The flatten (#429): `type: 'market'` is wire-only, same as `submitOrder`'s `type: 'limit'` */
  async submitMarketOrder(request: AlpacaMarketOrderRequest): Promise<AlpacaOrder> {
    return this.submitPlacement<AlpacaOrder>(
      '/v2/orders',
      { method: 'POST', body: JSON.stringify({ ...request, type: 'market' }) },
      'submitMarketOrder',
      validateAlpacaOrder,
    );
  }

  /**
   * Re-arm on an equity residual (#525): closes existing quantity via OCO, opens nothing.
   * Crypto never reaches this — #550 verified Alpaca rejects OCO for crypto (422 42210000).
   */
  async submitOcoOrder(request: AlpacaOcoOrderRequest): Promise<AlpacaOrder> {
    return this.submitPlacement<AlpacaOrder>(
      '/v2/orders',
      { method: 'POST', body: JSON.stringify({ ...request, type: 'limit' }) },
      'submitOcoOrder',
      validateAlpacaOrder,
    );
  }

  /** Crypto emulation entry/take-profit leg (#586): plain limit order, no `order_class` — crypto rejects advanced order classes (#550) */
  async submitLimitOrder(request: AlpacaLimitOrderRequest): Promise<AlpacaOrder> {
    return this.submitPlacement<AlpacaOrder>(
      '/v2/orders',
      { method: 'POST', body: JSON.stringify({ ...request, type: 'limit' }) },
      'submitLimitOrder',
      validateAlpacaOrder,
    );
  }

  /** Crypto emulation stop leg (#586): plain stop-limit order carrying both `stop_price` and `limit_price` */
  async submitStopLimitOrder(request: AlpacaStopLimitOrderRequest): Promise<AlpacaOrder> {
    return this.submitPlacement<AlpacaOrder>(
      '/v2/orders',
      { method: 'POST', body: JSON.stringify({ ...request, type: 'stop_limit' }) },
      'submitStopLimitOrder',
      validateAlpacaOrder,
    );
  }

  /**
   * Cancel, made idempotent (#429): 204/404/422 all mean "nothing working under this id any more,"
   * so only a genuine transport/auth failure propagates
   */
  async cancelOrder(alpacaOrderId: string): Promise<void> {
    const path = `/v2/orders/${encodeURIComponent(alpacaOrderId)}`;
    await withRetry<void>(
      async () => {
        let response: Response;
        try {
          response = await fetchWithTimeout(
            `${this.baseUrl}${path}`,
            { method: 'DELETE', headers: this.headers({ method: 'DELETE' }) },
            this.timeoutMs,
          );
        } catch (cause) {
          throw classifyAlpacaBrokerNetworkError(cause, 'cancelOrder', 'DELETE');
        }

        if (response.ok || response.status === 404 || response.status === 422) return;
        throw await classifyAlpacaBrokerResponse(response, 'cancelOrder', 'DELETE');
      },
      this.retry,
      isRetryableAlpacaBrokerError,
    );
  }

  async getPositions(): Promise<AlpacaPosition[]> {
    return this.request<AlpacaPosition[]>(
      '/v2/positions',
      { method: 'GET' },
      'getPositions',
      validateAlpacaPositions,
    );
  }

  async getAccount(): Promise<AlpacaAccount> {
    return this.request<AlpacaAccount>(
      '/v2/account',
      { method: 'GET' },
      'getAccount',
      validateAlpacaAccount,
    );
  }

  async getOrder(alpacaOrderId: string): Promise<AlpacaOrder> {
    return this.request<AlpacaOrder>(
      `/v2/orders/${encodeURIComponent(alpacaOrderId)}`,
      { method: 'GET' },
      'getOrder',
      validateAlpacaOrder,
    );
  }

  async listOpenOrders(): Promise<AlpacaOrder[]> {
    return this.request<AlpacaOrder[]>(
      // `nested=false` so bracket legs arrive as their own rows, matchable by `client_order_id`
      // `direction=asc` against Alpaca's `desc` default is load-bearing at the 500-row cap (#1500):
      // oldest-first means rows dropped at the cap are the newest, never the wedged-flatten this lookup wants
      '/v2/orders?status=open&nested=false&direction=asc&limit=500',
      { method: 'GET' },
      'listOpenOrders',
      validateAlpacaOrders,
    );
  }

  async getOrderByClientOrderId(clientOrderId: string): Promise<AlpacaOrder | null> {
    try {
      return await this.request<AlpacaOrder>(
        `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}`,
        { method: 'GET' },
        'getOrderByClientOrderId',
        validateAlpacaOrder,
      );
    } catch (error) {
      // A validation failure has no `status`, so it falls through to rethrow rather than being mistaken for a 404
      if (error instanceof AlpacaBrokerProviderError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }
}
