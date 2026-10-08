import type { RetryConfig } from '../../../../shared/index.js';
import {
  fetchWithTimeout,
  nonEmpty,
  truncateForError,
  withRetry,
} from '../../../../shared/index.js';
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
  AlpacaCashActivity,
  AlpacaCashInLieuActivity,
  AlpacaLatestQuote,
  AlpacaMarketOrderRequest,
  AlpacaOcoOrderRequest,
  AlpacaOrder,
  AlpacaPosition,
  AlpacaQuoteClient,
} from './alpaca-client.js';

type AlpacaRequestInit = Omit<RequestInit, 'method'> & { method: AlpacaHttpMethod };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFiniteNumericString(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Number(value));
}

function failValidation(context: string, detail: string, body: unknown): never {
  throw new AlpacaBrokerProviderError(
    `Alpaca API error: malformed response body (${context}): ${detail} — ${truncateForError(
      JSON.stringify(body),
    )}`,
  );
}

function runValidationRules(
  rules: ReadonlyArray<readonly [failed: boolean, message: string]>,
  context: string,
  body: unknown,
): void {
  for (const [failed, message] of rules) {
    if (failed) failValidation(context, message, body);
  }
}

function validateAlpacaOrderLeg(raw: unknown, context: string, body: unknown): void {
  if (!isRecord(raw)) failValidation(context, 'a bracket leg was not an object', body);
  const { id, type, status, filled_qty, filled_avg_price, filled_at } = raw;
  runValidationRules(
    [
      [typeof id !== 'string', 'leg.id must be a string'],
      [type !== 'limit' && type !== 'stop', "leg.type must be 'limit' or 'stop'"],
      [status !== undefined && typeof status !== 'string', 'leg.status must be a string'],
      [
        filled_qty !== undefined && !isFiniteNumericString(filled_qty),
        'leg.filled_qty must be a numeric string',
      ],
      [
        filled_avg_price !== undefined &&
          filled_avg_price !== null &&
          !isFiniteNumericString(filled_avg_price),
        'leg.filled_avg_price must be a numeric string or null',
      ],
      [
        filled_at !== undefined && filled_at !== null && typeof filled_at !== 'string',
        'leg.filled_at must be a string or null',
      ],
    ],
    context,
    body,
  );
}

function validateAlpacaOrderIdentityFields(body: Record<string, unknown>, context: string): void {
  const { id, client_order_id, symbol, side, qty, order_class } = body;
  runValidationRules(
    [
      [typeof id !== 'string', 'id must be a string'],
      [
        client_order_id !== undefined && typeof client_order_id !== 'string',
        'client_order_id must be a string',
      ],
      [symbol !== undefined && typeof symbol !== 'string', 'symbol must be a string'],
      [side !== undefined && side !== 'buy' && side !== 'sell', "side must be 'buy' or 'sell'"],
      [qty !== undefined && !isFiniteNumericString(qty), 'qty must be a numeric string'],
      [
        order_class !== undefined && typeof order_class !== 'string',
        'order_class must be a string',
      ],
    ],
    context,
    body,
  );
}

function validateAlpacaOrderCoreFields(body: Record<string, unknown>, context: string): void {
  validateAlpacaOrderIdentityFields(body, context);
  const { status, filled_qty, filled_avg_price, filled_at } = body;
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
  if (legs !== undefined && legs !== null) {
    if (!Array.isArray(legs)) failValidation(context, 'legs must be an array', body);
    for (const leg of legs) validateAlpacaOrderLeg(leg, context, body);
  }
  return body as unknown as AlpacaOrder;
}

function validateAlpacaOrders(body: unknown, context: string): AlpacaOrder[] {
  if (!Array.isArray(body)) failValidation(context, 'expected an array', body);
  return body.map((raw) => validateAlpacaOrder(raw, context));
}

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
  return body as unknown as AlpacaAccount;
}

function validateAlpacaLatestQuote(body: unknown, context: string): AlpacaLatestQuote {
  const quote = isRecord(body) ? body.quote : undefined;
  if (!isRecord(quote)) failValidation(context, 'quote must be an object', body);
  const { t, ap, bp } = quote;
  runValidationRules(
    [
      [typeof t !== 'string' || Number.isNaN(Date.parse(t)), 'quote.t must be a timestamp'],
      [typeof ap !== 'number' || !Number.isFinite(ap), 'quote.ap must be a finite number'],
      [typeof bp !== 'number' || !Number.isFinite(bp), 'quote.bp must be a finite number'],
    ],
    context,
    body,
  );
  return { t: t as string, ap: ap as number, bp: bp as number };
}

type ValidationRules = ReadonlyArray<readonly [failed: boolean, message: string]>;

function activityRules(raw: Record<string, unknown>): ValidationRules {
  const { id, date, net_amount, status } = raw;
  return [
    [typeof id !== 'string' || id === '', 'id must be a non-empty string'],
    [typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date), 'date must be YYYY-MM-DD'],
    [!isFiniteNumericString(net_amount), 'net_amount must be a numeric string'],
    [
      status !== 'executed' && status !== 'correct' && status !== 'canceled',
      "status must be 'executed', 'correct' or 'canceled'",
    ],
  ];
}

function cashInLieuRules(raw: Record<string, unknown>): ValidationRules {
  const { activity_type, symbol, qty } = raw;
  return [
    [activity_type !== 'CIL', "activity_type must be 'CIL'"],
    [typeof symbol !== 'string' || symbol === '', 'symbol must be a non-empty string'],
    [qty != null && !isFiniteNumericString(qty), 'qty must be a numeric string or null'],
  ];
}

function activitiesValidator<T>(
  rulesOf: (raw: Record<string, unknown>) => ValidationRules,
): (body: unknown, context: string) => T[] {
  return (body, context) => {
    if (!Array.isArray(body)) failValidation(context, 'expected an array', body);
    for (const raw of body) {
      if (!isRecord(raw)) failValidation(context, 'an activity was not an object', raw);
      runValidationRules([...activityRules(raw), ...rulesOf(raw)], context, raw);
    }
    return body as T[];
  };
}

const validateCashInLieuActivities = activitiesValidator<AlpacaCashInLieuActivity>(cashInLieuRules);

function cashActivitiesValidator(
  types: readonly string[],
): (body: unknown, context: string) => AlpacaCashActivity[] {
  return activitiesValidator<AlpacaCashActivity>(({ activity_type }) => [
    [
      typeof activity_type !== 'string' || !types.includes(activity_type),
      `activity_type must be one of ${types.join(', ')}`,
    ],
  ]);
}

export const ALPACA_ACTIVITY_PAGE_SIZE = 100;
// Alpaca's GET /v2/orders reference: limit "defaults to 50 and max is 500"
export const ALPACA_ORDER_HISTORY_LIMIT = 500;

export type AlpacaTradingEnvironment = 'paper' | 'live';

const ALPACA_TRADING_HOSTS: Readonly<Record<string, AlpacaTradingEnvironment>> = {
  'paper-api.alpaca.markets': 'paper',
  'api.alpaca.markets': 'live',
};

const ALPACA_DATA_BASE_URL = 'https://data.alpaca.markets';

const BASE_URL_BY_ENVIRONMENT: Readonly<Record<AlpacaTradingEnvironment, string>> = {
  paper: 'https://paper-api.alpaca.markets',
  live: 'https://api.alpaca.markets',
};

function bracketParentType(request: AlpacaBracketOrderRequest): 'limit' | 'stop_limit' {
  return request.stop_price === undefined ? 'limit' : 'stop_limit';
}

function classifyAlpacaTradingHost(
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
const DEFAULT_RETRY_CONFIG: RetryConfig = { maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 4_000 };

function requireAlpacaCredential(
  value: string | undefined,
  envVar: string,
  optionName: 'apiKey' | 'apiSecret',
  noun: 'key' | 'secret',
  environment: AlpacaTradingEnvironment,
): string {
  if (value !== undefined && value.length > 0) return value;
  throw new Error(
    `AlpacaHttpBrokerClient: ${envVar} is not set. Provide it via the environment ` +
      `(.env.local) or pass { ${optionName} } explicitly. This is the ${environment} account's ` +
      `${noun}; Alpaca issues a different pair per account and neither substitutes for the ` +
      'other.',
  );
}

const ALPACA_CREDENTIAL_ENV_VARS: Readonly<
  Record<AlpacaTradingEnvironment, { readonly key: string; readonly secret: string }>
> = {
  paper: { key: 'ALPACA_API_KEY', secret: 'ALPACA_API_SECRET' },
  live: { key: 'ALPACA_LIVE_API_KEY', secret: 'ALPACA_LIVE_API_SECRET' },
};

export interface AlpacaHttpBrokerClientOptions {
  apiKey?: string;
  apiSecret?: string;
  environment?: AlpacaTradingEnvironment;
  baseUrl?: string;
  dataBaseUrl?: string;
  timeoutMs?: number;
  retry?: RetryConfig;
}

async function parseAlpacaJson(response: Response, context: string): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    throw new AlpacaBrokerProviderError(
      `Alpaca API error: response body could not be parsed as JSON (${context}): ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
}

export class AlpacaHttpBrokerClient implements AlpacaBrokerClient, AlpacaQuoteClient {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  readonly baseUrl: string;
  readonly dataBaseUrl: string;
  private readonly timeoutMs: number;
  private readonly retry: RetryConfig;

  constructor(options: AlpacaHttpBrokerClientOptions = {}) {
    const environment = options.environment ?? 'paper';
    const names = ALPACA_CREDENTIAL_ENV_VARS[environment];
    const fromEnv = (name: string): string | undefined => nonEmpty(process.env[name]);
    this.apiKey = requireAlpacaCredential(
      options.apiKey ?? fromEnv(names.key),
      names.key,
      'apiKey',
      'key',
      environment,
    );
    this.apiSecret = requireAlpacaCredential(
      options.apiSecret ?? fromEnv(names.secret),
      names.secret,
      'apiSecret',
      'secret',
      environment,
    );
    this.baseUrl = resolveBaseUrl(environment, options.baseUrl);
    this.dataBaseUrl = options.dataBaseUrl ?? ALPACA_DATA_BASE_URL;
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

  private async request<T>(
    path: string,
    init: AlpacaRequestInit,
    context: string,
    validate: (body: unknown, context: string) => T,
    retry: RetryConfig = this.retry,
    origin: string = this.baseUrl,
  ): Promise<T> {
    return withRetry<T>(
      async () =>
        validate(
          await parseAlpacaJson(await this.send(`${origin}${path}`, init, context), context),
          context,
        ),
      retry,
      isRetryableAlpacaBrokerError,
    );
  }

  private async send(url: string, init: AlpacaRequestInit, context: string): Promise<Response> {
    let response: Response;
    try {
      response = await fetchWithTimeout(
        url,
        { ...init, headers: this.headers(init) },
        this.timeoutMs,
      );
    } catch (cause) {
      throw classifyAlpacaBrokerNetworkError(cause, context, init.method);
    }

    if (!response.ok) {
      throw await classifyAlpacaBrokerResponse(response, context, init.method);
    }
    return response;
  }

  private async submitPlacement<T>(
    path: string,
    init: AlpacaRequestInit,
    context: string,
    validate: (body: unknown, context: string) => T,
  ): Promise<T> {
    return this.request<T>(path, init, context, validate, { ...this.retry, maxAttempts: 1 });
  }

  async submitOrder(request: AlpacaBracketOrderRequest): Promise<AlpacaOrder> {
    return this.submitPlacement<AlpacaOrder>(
      '/v2/orders',
      { method: 'POST', body: JSON.stringify({ ...request, type: bracketParentType(request) }) },
      'submitOrder',
      validateAlpacaOrder,
    );
  }

  async submitMarketOrder(request: AlpacaMarketOrderRequest): Promise<AlpacaOrder> {
    return this.submitPlacement<AlpacaOrder>(
      '/v2/orders',
      { method: 'POST', body: JSON.stringify({ ...request, type: 'market' }) },
      'submitMarketOrder',
      validateAlpacaOrder,
    );
  }

  async submitOcoOrder(request: AlpacaOcoOrderRequest): Promise<AlpacaOrder> {
    return this.submitPlacement<AlpacaOrder>(
      '/v2/orders',
      { method: 'POST', body: JSON.stringify({ ...request, type: 'limit' }) },
      'submitOcoOrder',
      validateAlpacaOrder,
    );
  }

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

  // No feed parameter, so Alpaca answers from the account's own data feed (David 2026-10-08, #2024)
  async getLatestQuote(symbol: string): Promise<AlpacaLatestQuote> {
    return this.request<AlpacaLatestQuote>(
      `/v2/stocks/${encodeURIComponent(symbol)}/quotes/latest`,
      { method: 'GET' },
      'getLatestQuote',
      validateAlpacaLatestQuote,
      this.retry,
      this.dataBaseUrl,
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
      '/v2/orders?status=open&nested=false&direction=asc&limit=500',
      { method: 'GET' },
      'listOpenOrders',
      validateAlpacaOrders,
    );
  }

  async listOrderHistory(symbols: readonly string[]): Promise<AlpacaOrder[]> {
    const query = new URLSearchParams({
      status: 'all',
      nested: 'true',
      symbols: symbols.join(','),
      direction: 'desc',
      limit: String(ALPACA_ORDER_HISTORY_LIMIT),
    });
    return this.request<AlpacaOrder[]>(
      `/v2/orders?${query.toString()}`,
      { method: 'GET' },
      'listOrderHistory',
      validateAlpacaOrders,
    );
  }

  async listCashInLieu(after: string, pageToken?: string): Promise<AlpacaCashInLieuActivity[]> {
    return this.listActivities(
      '/v2/account/activities/CIL',
      { after },
      pageToken,
      'listCashInLieu',
      validateCashInLieuActivities,
    );
  }

  async listCashActivities(
    types: readonly string[],
    after: string,
    pageToken?: string,
  ): Promise<AlpacaCashActivity[]> {
    return this.listActivities(
      '/v2/account/activities',
      { activity_types: types.join(','), after },
      pageToken,
      'listCashActivities',
      cashActivitiesValidator(types),
    );
  }

  private async listActivities<T>(
    path: string,
    filter: Readonly<Record<string, string>>,
    pageToken: string | undefined,
    context: string,
    validate: (body: unknown, context: string) => T[],
  ): Promise<T[]> {
    const query = new URLSearchParams({
      ...filter,
      direction: 'asc',
      page_size: String(ALPACA_ACTIVITY_PAGE_SIZE),
    });
    if (pageToken !== undefined) query.set('page_token', pageToken);
    return this.request<T[]>(`${path}?${query.toString()}`, { method: 'GET' }, context, validate);
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
      if (error instanceof AlpacaBrokerProviderError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }
}
