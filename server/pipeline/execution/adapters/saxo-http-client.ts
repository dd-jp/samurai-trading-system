/**
 * Real `SaxoOpenApiClient` over `fetch` (#1032 item 1) — the Saxo counterpart
 * of `alpaca-http-client.ts`: same `withRetry` + `fetchWithTimeout` transport,
 * same validate-at-the-boundary posture, same env-sourced credential rule.
 *
 * Authentication is an OAuth bearer read from a `SaxoTokenSource` **per
 * request** (#1523), not captured once at construction: the access token
 * lasts 1200 s and the refresher rotates it underneath, so a client that held
 * a string would 401 twenty minutes into any run. Obtaining and renewing the
 * token is still not this client's job — it asks for the current one and
 * sends it. A session that can no longer be renewed surfaces as
 * `SaxoSessionLostError` from the token source rather than as a 401 here.
 * `SAXO_SIM_ACCESS_TOKEN`/`SAXO_LIVE_ACCESS_TOKEN` remain the fallback for an
 * operator-pasted developer-portal token, wrapped in a `StaticSaxoTokenSource`.
 * The token is never logged or embedded in an error message.
 *
 * `AccountKey`/`ClientKey` are resolved once from `/port/v1/accounts/me` and
 * memoised, so the adapter never holds an account identifier.
 */
import type { Logger, RetryConfig } from '../../../shared/index.js';
import {
  DEFAULT_VENUE_PACING,
  fetchWithTimeout,
  TokenBucket,
  truncateForError,
  withRetry,
} from '../../../shared/index.js';
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
  SaxoInstrumentDetails,
  SaxoNetPosition,
  SaxoOpenApiClient,
  SaxoOpenOrder,
  SaxoOrderActivity,
  SaxoOrderPlacement,
  SaxoOrderRequest,
} from './saxo-client.js';
import type { SaxoTradingEnvironment } from './saxo-environment.js';
import { SAXO_CREDENTIAL_ENV_VARS, SAXO_GATEWAY_URLS } from './saxo-environment.js';
import type { SaxoTokenSource } from './saxo-token-source.js';
import { StaticSaxoTokenSource } from './saxo-token-source.js';

export { SAXO_CREDENTIAL_ENV_VARS, SAXO_GATEWAY_URLS, type SaxoTradingEnvironment };

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_CONFIG: RetryConfig = { maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 4_000 };
/** Saxo pages with `$top`; 500 is well above any single-account working set. */
const PAGE_SIZE = 500;

export interface SaxoHttpBrokerClientOptions {
  /**
   * Where the bearer for the NEXT request comes from (#1523). The composition
   * root passes the refresher (`buildSaxoTokenSource`, saxo-venue.ts); omitted,
   * `accessToken`/the environment variable is wrapped in a
   * `StaticSaxoTokenSource`, which is the pre-#1523 behaviour and cannot be
   * renewed.
   */
  tokenSource?: SaxoTokenSource;
  /** Defaults to `SAXO_CREDENTIAL_ENV_VARS[environment].token`. Never logged. Ignored when `tokenSource` is given. */
  accessToken?: string;
  environment?: SaxoTradingEnvironment;
  /** Defaults to `SAXO_CREDENTIAL_ENV_VARS[environment].gateway`, then `SAXO_GATEWAY_URLS[environment]`. */
  baseUrl?: string;
  /** Pins the account when the client holds more than one; otherwise the sole account is used. */
  accountKey?: string;
  timeoutMs?: number;
  retry?: RetryConfig;
  /**
   * Paces every upstream HTTP request this client issues, one token per
   * `fetchWithTimeout` call (#1222 — a public operation like `submitBracket`
   * or `cancel` can fan out to several, so pacing lives at the transport
   * boundary rather than the caller). Defaults to `DEFAULT_VENUE_PACING.saxo`.
   *
   * Since #1419, each call site spends one of two lanes on this same bucket
   * (`SaxoRequestPriority`): `placeOrder`/`cancelOrder` go through
   * `acquire()`, everything else — polling, pagination, reference-data
   * reads — through `acquireBackground()`, so `DEFAULT_VENUE_PACING.saxo`'s
   * `reserveForPriority` protects a pending placement/cancel from a
   * draining read sweep. The one-time account-identity lookup
   * (`resolveIdentity()`) always spends `acquire()` too, REGARDLESS of
   * which caller triggers it — see that method's own doc for why a
   * background-triggered identity fetch would otherwise reopen this same
   * stall one layer removed.
   */
  rateLimiter?: TokenBucket;
  /**
   * REQUIRED, no default (#1222 round 2): wires `TokenBucketTelemetry`
   * (#1083) onto the DEFAULT bucket — the fallback for a caller that
   * constructs this client standalone with no `rateLimiter` (the
   * composition root builds its own shared bucket with telemetry the same way
   * `production.ts` does for Alpaca and passes it as `rateLimiter` — see
   * `buildSaxoRateLimiter` (saxo-venue.ts, #1400) — so this option never
   * reaches that path). Made
   * unconditional rather than optional: the pre-#1222 `SaxoBrokerAdapter`
   * always built its default bucket with telemetry, because its own
   * `logger` was required — an omitted seam at a composition root is this
   * repo's dominant defect class (`AlpacaBrokerAdapterInput.logger` refuses
   * a silent default for the identical reason), and pacing moving to this
   * client should not weaken that guarantee.
   */
  logger: Logger;
}

interface AccountIdentity {
  accountKey: string;
  clientKey: string;
}

/**
 * `RequestInit` with `method` narrowed from optional `string` to a required
 * `SaxoHttpMethod` (#1223) — every call into `request()` must state its verb
 * explicitly. That verb is what decides retryability for every classified
 * failure shape this client can throw: a status-less transport failure
 * (`classifySaxoBrokerNetworkError`, #1223) and, since #1273, a timeout,
 * rate-limit or 5xx response (`classifySaxoBrokerResponse`) too — both read
 * it back out of `init.method`. This is what stops a new operation from
 * silently inheriting `fetch`'s implicit "no method means GET" default and
 * picking up retries it never asked for.
 */
type SaxoRequestInit = Omit<RequestInit, 'method'> & { method: SaxoHttpMethod };

/**
 * Which `TokenBucket` lane a request spends (#1419). `'priority'` is for
 * anything that arms or removes a protective leg or flattens a position —
 * `placeOrder`/`cancelOrder`. Everything else (position/order/activity
 * polling, pagination, reference-data reads) is `'background'`, so a
 * multi-page sweep can drain down to `DEFAULT_VENUE_PACING.saxo`'s reserve
 * without delaying a pending placement/cancel. The account-identity lookup
 * (`resolveIdentity()`) is NOT classified by its caller's own lane — it
 * hard-codes `'priority'` regardless, because `this.identity` memoises a
 * shared PROMISE rather than a per-call lane: whichever caller runs first
 * is the one whose request actually goes over the wire, and every later
 * caller (on either lane) just awaits it. If a background reader were
 * allowed to create that promise on the background lane, a concurrent
 * priority caller sharing this client would be waiting on a promise gated
 * by the background reserve threshold instead of the priority one.
 */
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

/**
 * A missing or non-positive `PriceToContractFactor` fails here rather than
 * defaulting to 1: the whole point of reading this endpoint is that the unit
 * must not be guessed (#1302), and a line whose unit the venue will not state
 * is a line this adapter must refuse to price.
 *
 * The returned `Uic`/`AssetType` are checked against the pair the path asked
 * for. This endpoint is the sole authority on the unit and the response is
 * the only place a mismatch can surface: a body describing a DIFFERENT
 * instrument would hand the resolver a factor for the wrong line, which is
 * the same 100x error read from a different direction.
 */
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
  const uic = requireNumber(body, 'Uic', context);
  const assetType = requireString(body, 'AssetType', context);
  if (uic !== requested.uic || assetType !== requested.assetType) {
    failValidation(
      context,
      `details for Uic ${requested.uic}/${requested.assetType} came back as ` +
        `${uic}/${assetType}`,
      body,
    );
  }
  return {
    Uic: uic,
    AssetType: assetType,
    CurrencyCode: requireString(body, 'CurrencyCode', context),
    PriceCurrency: optionalString(body, 'PriceCurrency', context),
    PriceToContractFactor: factor,
  };
}

/**
 * `/port/v1/balances/me` answers a single object, not a `{Data: [...]}`
 * envelope, so this does not go through `readData`/`listAll`.
 */
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

function validateIdentity(body: unknown, pinnedAccountKey: string | undefined): AccountIdentity {
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
      `Saxo: ${rows.length} accounts are visible; pass { accountKey } to pick the trading one.`,
    );
  }
  return only;
}

export class SaxoHttpBrokerClient implements SaxoOpenApiClient, SaxoAccountBalanceReader {
  private readonly tokenSource: SaxoTokenSource;
  readonly baseUrl: string;
  private readonly pinnedAccountKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly retry: RetryConfig;
  private readonly rateLimiter: TokenBucket;
  private identity: Promise<AccountIdentity> | undefined;

  constructor(options: SaxoHttpBrokerClientOptions) {
    const environment = options.environment ?? 'sim';
    const names = SAXO_CREDENTIAL_ENV_VARS[environment];
    const fromEnv = (name: string): string | undefined => {
      const value = process.env[name]?.trim();
      return value === undefined || value.length === 0 ? undefined : value;
    };
    if (options.tokenSource === undefined) {
      const accessToken = options.accessToken ?? fromEnv(names.token);
      if (accessToken === undefined || accessToken.length === 0) {
        throw new Error(
          `SaxoHttpBrokerClient: ${names.token} is not set. Provide it via the environment ` +
            `(.env.local), pass { accessToken } explicitly, or pass a { tokenSource } built ` +
            'from a `yarn saxo:login` session (#1523). This is the ' +
            `${environment} gateway's bearer; the SIM and live gateways issue separate tokens.`,
        );
      }
      this.tokenSource = new StaticSaxoTokenSource(accessToken);
    } else {
      this.tokenSource = options.tokenSource;
    }
    this.baseUrl = (
      options.baseUrl ??
      fromEnv(names.gateway) ??
      SAXO_GATEWAY_URLS[environment]
    ).replace(/\/+$/, '');
    this.pinnedAccountKey = options.accountKey;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retry = options.retry ?? DEFAULT_RETRY_CONFIG;
    this.rateLimiter =
      options.rateLimiter ??
      new TokenBucket(DEFAULT_VENUE_PACING.saxo, undefined, {
        logger: options.logger,
        name: 'saxo',
      });
  }

  /**
   * Asks the token source on every attempt, not once per client and not once
   * per operation: a rotation that lands between a failed attempt and its
   * retry is picked up by the retry (#1523).
   */
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
        // One token per attempt (#1222): a retried request is a second
        // upstream call and must be paced as one, not covered by the first
        // attempt's token.
        if (priority === 'priority') {
          await this.rateLimiter.acquire();
        } else {
          await this.rateLimiter.acquireBackground();
        }
        const headers = await this.headers(init, extraHeaders);
        let response: Response;
        try {
          response = await fetchWithTimeout(
            `${this.baseUrl}${path}`,
            { ...init, headers },
            this.timeoutMs,
          );
        } catch (cause) {
          throw classifySaxoBrokerNetworkError(cause, context, init.method);
        }
        if (!response.ok) {
          throw await classifySaxoBrokerResponse(response, context, init.method);
        }
        let text: string;
        try {
          text = await response.text();
        } catch (cause) {
          throw new SaxoBrokerProviderError(
            `Saxo API error: response body could not be read (${context}): ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          );
        }
        // A 2xx with an empty body is a legitimate cancel/placement ack shape.
        if (text.length === 0) return validate(undefined, context);
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch (cause) {
          throw new SaxoBrokerProviderError(
            `Saxo API error: response body could not be parsed as JSON (${context}): ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          );
        }
        return validate(parsed, context);
      },
      retry,
      isRetryableSaxoBrokerError,
    );
  }

  /**
   * ALWAYS priority, regardless of which caller triggers it (#1419 round 2).
   * `this.identity` memoises the PROMISE, not a per-call lane — whichever
   * caller runs first (`placeOrder`/`cancelOrder`, or a background reader
   * like `listOrderActivities`) is the one whose request actually goes over
   * the wire, and every later caller just awaits that same promise. If that
   * first request spent the background lane (because a background reader
   * happened to race ahead — real in this repo: `placeIdempotently` awaits
   * `lookup()`, which can itself resolve identity via `listOrderActivities`,
   * before ever calling `placeOrder`), a concurrent write elsewhere sharing
   * this client would be waiting on a promise gated by the BACKGROUND
   * reserve threshold, not the priority one — exactly the stall #1419
   * exists to prevent, one layer removed. Since this is a one-shot,
   * per-client bootstrap (cheap: `needed` is 1 on the priority lane, not
   * `1 + reserveForPriority`), there is no reason to ever let it draw from
   * the background lane, and the identity-gates-every-write property only
   * holds if it doesn't.
   */
  private resolveIdentity(): Promise<AccountIdentity> {
    this.identity ??= this.request(
      '/port/v1/accounts/me',
      { method: 'GET' },
      'resolveAccount',
      (body) => validateIdentity(body, this.pinnedAccountKey),
      'priority',
    ).catch((cause: unknown) => {
      this.identity = undefined;
      throw cause;
    });
    return this.identity;
  }

  private async listAll<T>(
    firstPath: string,
    context: string,
    validateRow: (raw: unknown, context: string) => T,
    priority: SaxoRequestPriority,
  ): Promise<T[]> {
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
      // `__next` is absolute on the gateway; strip the base so `request` re-prefixes it.
      path = page.next?.startsWith(this.baseUrl) ? page.next.slice(this.baseUrl.length) : page.next;
    }
    return rows;
  }

  /** Unauthenticated by account: reference data, no `AccountKey` in the path or query. */
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

  /**
   * Single attempt, no transport retry: Saxo's duplicate guard only covers a
   * 15 s window (doc 43), so a retried POST after a slow reply can place a
   * second order. Recovery is the adapter's adopt-or-place lookup instead.
   *
   * Since #1273, `isRetryableSaxoBrokerError` (via `isRetrySafeMethod`)
   * already refuses retry for every error shape `request()` can throw on a
   * POST: a status-less transport failure (`retryableTransportFailure` is
   * `method === 'GET'`), a timeout, a rate-limit, and a 5xx response (all
   * three gated by the same POST-excluding allowlist), plus the unclassified
   * body-read/parse failures below, which were never retryable regardless of
   * verb. So `maxAttempts: 1` here no longer carries the guarantee — the
   * classifier does, on its own, verb by verb. It stays as defense in depth:
   * a future error shape that skips classification, or a classifier edit
   * that stops consulting `method`, would silently re-open retry on
   * placement without it. Do not remove it on the strength of the
   * classifier alone.
   */
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

  async listOpenOrders(): Promise<SaxoOpenOrder[]> {
    return this.listAll(
      `/port/v1/orders/me?$top=${PAGE_SIZE}`,
      'listOpenOrders',
      validateOpenOrder,
      'background',
    );
  }

  async listOrderActivities(from: Date): Promise<SaxoOrderActivity[]> {
    const { clientKey } = await this.resolveIdentity();
    const query = new URLSearchParams({
      ClientKey: clientKey,
      FromDateTime: from.toISOString(),
      $top: String(PAGE_SIZE),
    });
    return this.listAll(
      `/cs/v1/audit/orderactivities?${query.toString()}`,
      'listOrderActivities',
      validateActivity,
      'background',
    );
  }

  /**
   * The GBP-native funding read (#1509). No `AccountKey` in the path: `/me`
   * resolves to the token's own account, the same one `resolveIdentity`
   * pins, so this cannot drift onto a different account than orders go to.
   */
  async getBalances(): Promise<SaxoAccountBalance> {
    return this.request(
      '/port/v1/balances/me',
      { method: 'GET' },
      'getBalances',
      validateBalance,
      // A once-per-boot funding read, not an order path: the priority lane
      // (#1419) exists for `placeOrder`/`cancelOrder` and the identity call
      // they depend on, which must not queue behind a portfolio sweep.
      'background',
    );
  }

  async listNetPositions(): Promise<SaxoNetPosition[]> {
    return this.listAll(
      `/port/v1/netpositions/me?FieldGroups=NetPositionBase,NetPositionView,DisplayAndFormat&$top=${PAGE_SIZE}`,
      'listNetPositions',
      validateNetPosition,
      'background',
    );
  }
}
