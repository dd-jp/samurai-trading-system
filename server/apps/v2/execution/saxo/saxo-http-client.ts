import type { Logger, RetryConfig } from '../../../../shared/index.js';
import {
  DEFAULT_VENUE_PACING,
  fetchWithTimeout,
  TokenBucket,
  truncateForError,
  withRetry,
} from '../../../../shared/index.js';
import type { SaxoHttpMethod } from './saxo-broker-errors.js';
import {
  classifySaxoBrokerNetworkError,
  classifySaxoBrokerResponse,
  isRetryableSaxoBrokerError,
  SaxoBrokerProviderError,
} from './saxo-broker-errors.js';
import type {
  SaxoAccountBalance,
  SaxoAccountBalanceReader,
  SaxoAssetType,
  SaxoCfdPriceDetails,
  SaxoInfoPrice,
  SaxoInstrumentDetails,
  SaxoNetPosition,
  SaxoOpenApiClient,
  SaxoOpenOrder,
  SaxoOrderActivity,
  SaxoOrderPlacement,
  SaxoOrderRequest,
} from './saxo-client.js';
import { isSaxoCfdAssetType } from './saxo-client.js';
import type { SaxoTradingEnvironment } from './saxo-environment.js';
import {
  SAXO_CREDENTIAL_ENV_VARS,
  SAXO_GATEWAY_URLS,
  saxoAccountKeyEnvVar,
} from './saxo-environment.js';
import type { SaxoTokenSource } from './saxo-token-source.js';
import { StaticSaxoTokenSource } from './saxo-token-source.js';

export { SAXO_CREDENTIAL_ENV_VARS, type SaxoTradingEnvironment };

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_CONFIG: RetryConfig = { maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 4_000 };
const PAGE_SIZE = 500;

export interface SaxoHttpBrokerClientOptions {
  tokenSource?: SaxoTokenSource;
  accessToken?: string;
  environment?: SaxoTradingEnvironment;
  baseUrl?: string;
  accountKey?: string;
  timeoutMs?: number;
  retry?: RetryConfig;
  rateLimiter?: TokenBucket;
  logger: Logger;
}

interface AccountIdentity {
  accountKey: string;
  clientKey: string;
}

type SaxoRequestInit = Omit<RequestInit, 'method'> & { method: SaxoHttpMethod };

type SaxoRequestPriority = 'priority' | 'background';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function failValidation(context: string, detail: string, body: unknown): never {
  throw new SaxoBrokerProviderError(
    `Saxo API error: malformed response body (${context}): ${detail} — ${truncateForError(
      JSON.stringify(body),
    )}`,
  );
}

function readData(body: unknown, context: string): unknown[] {
  if (!isRecord(body) || !Array.isArray(body.Data)) {
    failValidation(context, 'expected a {Data: [...]} envelope', body);
  }
  return body.Data;
}

function readNext(body: unknown): string | undefined {
  return isRecord(body) && typeof body.__next === 'string' ? body.__next : undefined;
}

function probeUrl(path: string): URL {
  return new URL(path, 'https://saxo-next.invalid');
}

function nextOnRoute(nextPath: string, route: string, context: string): URL {
  const parsed = /^\/(?![/\\])/.test(nextPath) ? probeUrl(nextPath) : undefined;
  if (parsed?.host !== 'saxo-next.invalid' || parsed.pathname !== route) {
    throw new SaxoBrokerProviderError(
      `Saxo API error: __next left the ${route} route (${context}).`,
    );
  }
  return parsed;
}

function keepAccountScope(
  nextPath: string,
  route: string,
  identity: AccountIdentity,
  context: string,
): string {
  const next = nextOnRoute(nextPath, route, context);
  const echoed = [...next.searchParams];
  const missing = new URLSearchParams();
  for (const [key, pinnedValue] of [
    ['AccountKey', identity.accountKey],
    ['ClientKey', identity.clientKey],
  ] as const) {
    const echoedValues = valuesOf(echoed, key);
    if (echoedValues.length === 0) {
      missing.set(key, pinnedValue);
    } else if (echoedValues.some((value) => value !== pinnedValue)) {
      throw new SaxoBrokerProviderError(
        `Saxo API error: __next changed ${key} between pages (${context}).`,
      );
    }
  }
  return withQuery(next, missing.toString());
}

function valuesOf(params: readonly [string, string][], key: string): string[] {
  const wanted = key.toLowerCase();
  return params.filter(([name]) => name.toLowerCase() === wanted).map(([, value]) => value);
}

function withQuery(next: URL, query: string): string {
  if (query === '') return `${next.pathname}${next.search}`;
  return `${next.pathname}${next.search === '' ? '?' : `${next.search}&`}${query}`;
}

function requireString(row: Record<string, unknown>, field: string, context: string): string {
  const value = row[field];
  if (typeof value !== 'string') failValidation(context, `${field} must be a string`, row);
  return value;
}

function requireNumber(row: Record<string, unknown>, field: string, context: string): number {
  const value = row[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    failValidation(context, `${field} must be a finite number`, row);
  }
  return value;
}

function optionalNumber(
  row: Record<string, unknown>,
  field: string,
  context: string,
): number | undefined {
  const value = row[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    failValidation(context, `${field} must be a finite number when present`, row);
  }
  return value;
}

function optionalString(
  row: Record<string, unknown>,
  field: string,
  context: string,
): string | undefined {
  const value = row[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') failValidation(context, `${field} must be a string`, row);
  return value;
}

function requireBuySell(row: Record<string, unknown>, context: string): 'Buy' | 'Sell' {
  const value = row.BuySell;
  if (value !== 'Buy' && value !== 'Sell')
    failValidation(context, "BuySell must be 'Buy'|'Sell'", row);
  return value;
}

function validatePlacement(body: unknown, context: string): SaxoOrderPlacement {
  if (!isRecord(body)) failValidation(context, 'expected an object', body);
  const OrderId = requireString(body, 'OrderId', context);
  const ExternalReference = optionalString(body, 'ExternalReference', context);
  const Orders = Array.isArray(body.Orders)
    ? body.Orders.map((related) => {
        if (!isRecord(related)) failValidation(context, 'Orders[] entries must be objects', body);
        return {
          OrderId: requireString(related, 'OrderId', context),
          ExternalReference: optionalString(related, 'ExternalReference', context),
        };
      })
    : undefined;
  return { OrderId, ExternalReference, Orders };
}

function validateOpenOrder(raw: unknown, context: string): SaxoOpenOrder {
  if (!isRecord(raw)) failValidation(context, 'order rows must be objects', raw);
  const related = raw.RelatedOpenOrders;
  return {
    OrderId: requireString(raw, 'OrderId', context),
    ExternalReference: optionalString(raw, 'ExternalReference', context),
    Status: requireString(raw, 'Status', context),
    OpenOrderType: requireString(raw, 'OpenOrderType', context),
    OrderRelation: optionalString(raw, 'OrderRelation', context),
    Price: optionalNumber(raw, 'Price', context),
    Amount: requireNumber(raw, 'Amount', context),
    FilledAmount: optionalNumber(raw, 'FilledAmount', context),
    BuySell: requireBuySell(raw, context),
    Uic: requireNumber(raw, 'Uic', context),
    AssetType: requireString(raw, 'AssetType', context),
    RelatedOpenOrders: Array.isArray(related)
      ? related.map((row) => {
          if (!isRecord(row)) failValidation(context, 'RelatedOpenOrders[] must be objects', raw);
          return {
            OrderId: requireString(row, 'OrderId', context),
            OpenOrderType: requireString(row, 'OpenOrderType', context),
            OrderPrice: optionalNumber(row, 'OrderPrice', context),
            Amount: requireNumber(row, 'Amount', context),
            Status: requireString(row, 'Status', context),
          };
        })
      : undefined,
  };
}

function validateActivity(raw: unknown, context: string): SaxoOrderActivity {
  if (!isRecord(raw)) failValidation(context, 'activity rows must be objects', raw);
  return {
    ActivityTime: requireString(raw, 'ActivityTime', context),
    LogId: requireString(raw, 'LogId', context),
    OrderId: requireString(raw, 'OrderId', context),
    ExternalReference: optionalString(raw, 'ExternalReference', context),
    Status: requireString(raw, 'Status', context),
    SubStatus: optionalString(raw, 'SubStatus', context),
    Amount: requireNumber(raw, 'Amount', context),
    Price: optionalNumber(raw, 'Price', context),
    FillAmount: optionalNumber(raw, 'FillAmount', context),
    AveragePrice: optionalNumber(raw, 'AveragePrice', context),
    BuySell: requireBuySell(raw, context),
    Uic: requireNumber(raw, 'Uic', context),
    AssetType: requireString(raw, 'AssetType', context),
  };
}

function validateNetPosition(raw: unknown, context: string): SaxoNetPosition {
  if (!isRecord(raw)) failValidation(context, 'position rows must be objects', raw);
  const base = raw.NetPositionBase;
  if (!isRecord(base)) failValidation(context, 'NetPositionBase must be an object', raw);
  const view = isRecord(raw.NetPositionView) ? raw.NetPositionView : {};
  const display = isRecord(raw.DisplayAndFormat) ? raw.DisplayAndFormat : undefined;
  return {
    NetPositionId: requireString(raw, 'NetPositionId', context),
    NetPositionBase: {
      Amount: requireNumber(base, 'Amount', context),
      Uic: requireNumber(base, 'Uic', context),
      AssetType: requireString(base, 'AssetType', context),
    },
    NetPositionView: { AverageOpenPrice: optionalNumber(view, 'AverageOpenPrice', context) },
    ...(display === undefined
      ? {}
      : { DisplayAndFormat: { Symbol: optionalString(display, 'Symbol', context) } }),
  };
}

function requireRequestedInstrument(
  body: Record<string, unknown>,
  context: string,
  requested: { uic: number; assetType: SaxoAssetType },
  what: string,
): number {
  const uic = requireNumber(body, 'Uic', context);
  const assetType = requireString(body, 'AssetType', context);
  if (uic !== requested.uic || assetType !== requested.assetType) {
    failValidation(
      context,
      `${what} for Uic ${requested.uic}/${requested.assetType} came back as ${uic}/${assetType}`,
      body,
    );
  }
  return uic;
}

function validateInstrumentDetails(
  body: unknown,
  context: string,
  requested: { uic: number; assetType: SaxoAssetType },
): SaxoInstrumentDetails {
  if (!isRecord(body)) failValidation(context, 'expected an object', body);
  const factor = requireNumber(body, 'PriceToContractFactor', context);
  if (factor <= 0) {
    failValidation(context, 'PriceToContractFactor must be positive', body);
  }
  const uic = requireRequestedInstrument(body, context, requested, 'details');
  return {
    Uic: uic,
    AssetType: requested.assetType,
    CurrencyCode: requireString(body, 'CurrencyCode', context),
    PriceCurrency: optionalString(body, 'PriceCurrency', context),
    PriceToContractFactor: factor,
  };
}

function optionalBoolean(
  row: Record<string, unknown>,
  field: string,
  context: string,
): boolean | undefined {
  const value = row[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') failValidation(context, `${field} must be a boolean`, row);
  return value;
}

// Fail closed like the catalogue job: a ShortTradeDisabled Saxo stops sending reads as disabled
function validateCfdPriceDetails(
  details: Record<string, unknown>,
  context: string,
): SaxoCfdPriceDetails {
  const borrow = optionalNumber(details, 'CfdBorrowingCost', context);
  if ((borrow ?? 0) < 0) {
    failValidation(context, 'CfdBorrowingCost must not be negative', details);
  }
  return {
    ShortTradeDisabled: optionalBoolean(details, 'ShortTradeDisabled', context) !== false,
    CfdBorrowingCost: borrow,
  };
}

function validateInfoPrice(
  body: unknown,
  context: string,
  requested: { uic: number; assetType: SaxoAssetType },
): SaxoInfoPrice {
  if (!isRecord(body)) failValidation(context, 'expected an object', body);
  const uic = requireRequestedInstrument(body, context, requested, 'price');
  const quote = body.Quote;
  if (!isRecord(quote)) failValidation(context, 'Quote must be an object', body);
  const details = isRecord(body.InstrumentPriceDetails) ? body.InstrumentPriceDetails : {};
  return {
    Uic: uic,
    AssetType: requested.assetType,
    Bid: optionalNumber(quote, 'Bid', context),
    Ask: optionalNumber(quote, 'Ask', context),
    IsMarketOpen: details.IsMarketOpen === true,
    Cfd: isSaxoCfdAssetType(requested.assetType)
      ? validateCfdPriceDetails(details, context)
      : undefined,
  };
}

function validateBalance(body: unknown, context: string): SaxoAccountBalance {
  if (!isRecord(body)) failValidation(context, 'expected an object', body);
  const Currency = requireString(body, 'Currency', context);
  if (Currency.length === 0) failValidation(context, 'Currency must not be empty', body);
  return {
    Currency,
    CashBalance: requireNumber(body, 'CashBalance', context),
    TotalValue: requireNumber(body, 'TotalValue', context),
  };
}

function validateIdentity(
  body: unknown,
  pinnedAccountKey: string | undefined,
  accountKeyEnvVar: string,
): AccountIdentity {
  const context = 'resolveAccount';
  const rows = readData(body, context).map((row) => {
    if (!isRecord(row)) failValidation(context, 'account rows must be objects', body);
    return {
      accountKey: requireString(row, 'AccountKey', context),
      clientKey: requireString(row, 'ClientKey', context),
    };
  });
  if (pinnedAccountKey !== undefined) {
    const pinned = rows.find((row) => row.accountKey === pinnedAccountKey);
    if (pinned === undefined) {
      throw new SaxoBrokerProviderError(
        'Saxo: the configured accountKey is not among the accounts this token can see.',
      );
    }
    return pinned;
  }
  const [only, second] = rows;
  if (only === undefined) {
    throw new SaxoBrokerProviderError('Saxo: /port/v1/accounts/me returned no account.');
  }
  if (second !== undefined) {
    throw new SaxoBrokerProviderError(
      `Saxo: ${rows.length} accounts are visible; set ${accountKeyEnvVar} or pass { accountKey } to pick the trading one.`,
    );
  }
  return only;
}

function nonBlank(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function saxoFromEnv(name: string): string | undefined {
  return nonBlank(process.env[name]);
}

function resolveSaxoTokenSource(
  options: SaxoHttpBrokerClientOptions,
  environment: SaxoTradingEnvironment,
  tokenEnvVar: string,
): SaxoTokenSource {
  if (options.tokenSource !== undefined) return options.tokenSource;
  const accessToken = options.accessToken ?? saxoFromEnv(tokenEnvVar);
  if (accessToken === undefined || accessToken.length === 0) {
    throw new Error(
      `SaxoHttpBrokerClient: ${tokenEnvVar} is not set. Provide it via the environment ` +
        `(.env.local), pass { accessToken } explicitly, or pass a { tokenSource } built ` +
        'from a `npm run saxo:login` session (#1523). This is the ' +
        `${environment} gateway's bearer; the SIM and live gateways issue separate tokens.`,
    );
  }
  return new StaticSaxoTokenSource(accessToken);
}

function resolveSaxoBaseUrl(
  options: SaxoHttpBrokerClientOptions,
  gatewayEnvVar: string,
  environment: SaxoTradingEnvironment,
): string {
  const baseUrl = options.baseUrl ?? saxoFromEnv(gatewayEnvVar) ?? SAXO_GATEWAY_URLS[environment];
  return baseUrl.replace(/\/+$/, '');
}

function resolveSaxoRateLimiter(options: SaxoHttpBrokerClientOptions): TokenBucket {
  return (
    options.rateLimiter ??
    new TokenBucket(DEFAULT_VENUE_PACING.saxo, undefined, {
      logger: options.logger,
      name: 'saxo',
    })
  );
}

async function responseText(response: Response, context: string): Promise<string> {
  try {
    return await response.text();
  } catch (cause) {
    throw new SaxoBrokerProviderError(
      `Saxo API error: response body could not be read (${context}): ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
}

function parseResponseJson(text: string, context: string): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new SaxoBrokerProviderError(
      `Saxo API error: response body could not be parsed as JSON (${context}): ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
}

export class SaxoHttpBrokerClient implements SaxoOpenApiClient, SaxoAccountBalanceReader {
  private readonly tokenSource: SaxoTokenSource;
  readonly baseUrl: string;
  private readonly pinnedAccountKey: string | undefined;
  private readonly accountKeyEnvVar: string;
  private readonly timeoutMs: number;
  private readonly retry: RetryConfig;
  private readonly rateLimiter: TokenBucket;
  private identity: Promise<AccountIdentity> | undefined;

  constructor(options: SaxoHttpBrokerClientOptions) {
    const environment = options.environment ?? 'sim';
    const names = SAXO_CREDENTIAL_ENV_VARS[environment];
    this.tokenSource = resolveSaxoTokenSource(options, environment, names.token);
    this.baseUrl = resolveSaxoBaseUrl(options, names.gateway, environment);
    this.accountKeyEnvVar = saxoAccountKeyEnvVar(environment);
    this.pinnedAccountKey = nonBlank(options.accountKey) ?? saxoFromEnv(this.accountKeyEnvVar);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retry = options.retry ?? DEFAULT_RETRY_CONFIG;
    this.rateLimiter = resolveSaxoRateLimiter(options);
  }

  private async headers(
    init: RequestInit,
    extra: Record<string, string> = {},
  ): Promise<Record<string, string>> {
    const accessToken = await this.tokenSource.getAccessToken();
    return {
      ...(init.body != null ? { 'content-type': 'application/json' } : {}),
      accept: 'application/json',
      authorization: `Bearer ${accessToken}`,
      ...extra,
    };
  }

  private async request<T>(
    path: string,
    init: SaxoRequestInit,
    context: string,
    validate: (body: unknown, context: string) => T,
    priority: SaxoRequestPriority,
    retry: RetryConfig = this.retry,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    return withRetry<T>(
      async () => {
        await this.acquireSlot(priority);
        const headers = await this.headers(init, extraHeaders);
        const response = await this.send(path, { ...init, headers }, context);
        const text = await responseText(response, context);
        if (text.length === 0) return validate(undefined, context);
        return validate(parseResponseJson(text, context), context);
      },
      retry,
      isRetryableSaxoBrokerError,
    );
  }

  private async acquireSlot(priority: SaxoRequestPriority): Promise<void> {
    if (priority === 'priority') {
      await this.rateLimiter.acquire();
    } else {
      await this.rateLimiter.acquireBackground();
    }
  }

  private async send(path: string, init: SaxoRequestInit, context: string): Promise<Response> {
    let response: Response;
    try {
      response = await fetchWithTimeout(`${this.baseUrl}${path}`, init, this.timeoutMs);
    } catch (cause) {
      throw classifySaxoBrokerNetworkError(cause, context, init.method);
    }
    if (!response.ok) {
      throw await classifySaxoBrokerResponse(response, context, init.method);
    }
    return response;
  }

  private resolveIdentity(): Promise<AccountIdentity> {
    this.identity ??= this.request(
      '/port/v1/accounts/me',
      { method: 'GET' },
      'resolveAccount',
      (body) => validateIdentity(body, this.pinnedAccountKey, this.accountKeyEnvVar),
      'priority',
    ).catch((cause: unknown) => {
      this.identity = undefined;
      throw cause;
    });
    return this.identity;
  }

  private relativeToGateway(next: string): string {
    return next.startsWith(this.baseUrl) ? next.slice(this.baseUrl.length) : next;
  }

  private async listAll<T>(
    firstPath: string,
    context: string,
    validateRow: (raw: unknown, context: string) => T,
    priority: SaxoRequestPriority,
  ): Promise<T[]> {
    const identity = await this.resolveIdentity();
    const route = probeUrl(firstPath).pathname;
    const rows: T[] = [];
    let path: string | undefined = firstPath;
    while (path !== undefined) {
      const page: { rows: T[]; next: string | undefined } = await this.request(
        path,
        { method: 'GET' },
        context,
        (body) => ({
          rows: readData(body, context).map((row) => validateRow(row, context)),
          next: readNext(body),
        }),
        priority,
      );
      rows.push(...page.rows);
      path =
        page.next === undefined
          ? undefined
          : keepAccountScope(this.relativeToGateway(page.next), route, identity, context);
    }
    return rows;
  }

  async getInstrumentDetails(
    uic: number,
    assetType: SaxoAssetType,
  ): Promise<SaxoInstrumentDetails> {
    return this.request(
      `/ref/v1/instruments/details/${encodeURIComponent(String(uic))}/${encodeURIComponent(
        assetType,
      )}`,
      { method: 'GET' },
      'getInstrumentDetails',
      (body, context) => validateInstrumentDetails(body, context, { uic, assetType }),
      'background',
    );
  }

  async getInfoPrice(uic: number, assetType: SaxoAssetType): Promise<SaxoInfoPrice> {
    const { accountKey } = await this.resolveIdentity();
    const query = new URLSearchParams({
      AccountKey: accountKey,
      Uic: String(uic),
      AssetType: assetType,
      FieldGroups: 'Quote,InstrumentPriceDetails',
    });
    return this.request(
      `/trade/v1/infoprices?${query.toString()}`,
      { method: 'GET' },
      'getInfoPrice',
      (body, context) => validateInfoPrice(body, context, { uic, assetType }),
      'background',
    );
  }

  async placeOrder(request: SaxoOrderRequest, requestId: string): Promise<SaxoOrderPlacement> {
    const { accountKey } = await this.resolveIdentity();
    return this.request(
      '/trade/v2/orders',
      { method: 'POST', body: JSON.stringify({ AccountKey: accountKey, ...request }) },
      'placeOrder',
      validatePlacement,
      'priority',
      { ...this.retry, maxAttempts: 1 },
      { 'x-request-id': requestId },
    );
  }

  async cancelOrder(orderId: string): Promise<void> {
    const { accountKey } = await this.resolveIdentity();
    await this.request(
      `/trade/v2/orders/${encodeURIComponent(orderId)}?AccountKey=${encodeURIComponent(accountKey)}`,
      { method: 'DELETE' },
      'cancelOrder',
      () => undefined,
      'priority',
    );
  }

  // /orders/me, /balances/me and /netpositions/me take no AccountKey/ClientKey
  // (Saxo ref docs); the routes without /me do, same response shape
  private async accountScopedQuery(extra: Record<string, string> = {}): Promise<string> {
    const { accountKey, clientKey } = await this.resolveIdentity();
    return new URLSearchParams({
      AccountKey: accountKey,
      ClientKey: clientKey,
      ...extra,
    }).toString();
  }

  async listOpenOrders(): Promise<SaxoOpenOrder[]> {
    const query = await this.accountScopedQuery({ $top: String(PAGE_SIZE) });
    return this.listAll(
      `/port/v1/orders?${query}`,
      'listOpenOrders',
      validateOpenOrder,
      'background',
    );
  }

  async listOrderActivities(from: Date): Promise<SaxoOrderActivity[]> {
    const query = await this.accountScopedQuery({
      FromDateTime: from.toISOString(),
      $top: String(PAGE_SIZE),
    });
    return this.listAll(
      `/cs/v1/audit/orderactivities?${query}`,
      'listOrderActivities',
      validateActivity,
      'background',
    );
  }

  async getBalances(): Promise<SaxoAccountBalance> {
    const query = await this.accountScopedQuery();
    return this.request(
      `/port/v1/balances?${query}`,
      { method: 'GET' },
      'getBalances',
      validateBalance,
      'background',
    );
  }

  async listNetPositions(): Promise<SaxoNetPosition[]> {
    const query = await this.accountScopedQuery({
      FieldGroups: 'NetPositionBase,NetPositionView,DisplayAndFormat',
      $top: String(PAGE_SIZE),
    });
    return this.listAll(
      `/port/v1/netpositions?${query}`,
      'listNetPositions',
      validateNetPosition,
      'background',
    );
  }
}
