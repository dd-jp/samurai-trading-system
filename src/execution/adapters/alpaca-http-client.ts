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
import { fetchWithTimeout, truncateForError, withRetry } from '../../shared/index.js';
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
  AlpacaMarketOrderRequest,
  AlpacaOcoOrderRequest,
  AlpacaOrder,
  AlpacaPosition,
} from './alpaca-client.js';

/**
 * Wire-shape validation for the broker client (issue #509). `request<T>`
 * used to be a bare `(await response.json()) as T` — every field of every
 * response shape (`AlpacaOrder`, `AlpacaPosition[]`, `AlpacaAccount`) rode
 * along unvalidated, and this is the ONE client whose fields feed money math
 * (fill quantity, average price, account equity) directly.
 *
 * A per-shape validator per call site, not one generic check inside
 * `request<T>` — the three response shapes have nothing in common, and a
 * single shape-checker parameterized by `T` would have to be either a
 * runtime-schema library (the issue's "no schema library is needed") or a
 * pile of `T`-conditional branches indistinguishable from three functions.
 *
 * Every message is built ONLY from the parsed body (never the request, which
 * would carry the `APCA-API-*` headers) and is truncated — but this is a
 * belt no braces are actually needed for: `alpaca-adapter.ts`'s `call()`
 * wraps every one of these methods and converts whatever they throw through
 * `sanitizeBrokerError`, which discards the original message entirely before
 * it can reach a durable `audit_log` row or the dashboard. See
 * `broker-error.ts`'s doc comment — this file does not duplicate that
 * boundary, it relies on it being upstream of every caller.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Alpaca reports every decimal as a STRING (`alpaca-client.ts`'s doc comment
 * on `AlpacaOrder`/`AlpacaPosition`/`AlpacaAccount`: "parsing belongs to the
 * consumer"). This file keeps that contract — a validated numeric-string
 * field is still returned as a `string` — but rejects a string that could
 * never be a valid decimal, so a garbage `filled_qty: "N/A"` cannot reach
 * `Number.parseFloat` downstream and silently become `NaN` in a `Fill`.
 * `Number('')` is `0`, which passes this check; empty-string is not
 * special-cased, since Alpaca never sends one for a field that reaches this
 * validator (missing is `null`, not `''`, per the interface).
 */
function isFiniteNumericString(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Number(value));
}

/** Throws a classified, message-bounded `AlpacaBrokerProviderError` for a validation failure. */
function failValidation(context: string, detail: string, body: unknown): never {
  throw new AlpacaBrokerProviderError(
    `Alpaca API error: malformed response body (${context}): ${detail} — ${truncateForError(
      JSON.stringify(body),
    )}`,
  );
}

/**
 * A bracket leg, validated leniently on purpose. `id`/`type` are the only
 * fields ANY caller reads off a leg at submit time (`alpaca-adapter.ts`'s
 * `legOrderIds`/`legIds`), so those are required. `status`/`filled_qty`/
 * `filled_avg_price`/`filled_at` are declared required by the `AlpacaOrderLeg`
 * interface but are only read later, by `fetchNewFills`'s `getOrder` polling
 * path (`collectFill`) — and whether Alpaca populates them on a freshly
 * submitted, not-yet-filled leg is not verified against a live account here.
 * Requiring them at submit time on an unverified guess would turn every
 * bracket submission into a thrown error the moment the guess is wrong — the
 * exact "unverified guess must fail loudly, never silently" principle this
 * module doc's `lookupCryptoKey` reasoning warns against applying backwards.
 * `collectFill` already has its own `Number.isFinite` guard on `filled_qty`
 * (issue H1's original mitigation) for the case where it IS present but
 * garbage, so validating it here too — when present — closes the gap without
 * guessing about a field's presence.
 *
 * Validates in place and returns nothing: this client's whole contract is
 * that a response passes through UNMODIFIED (pinned by
 * `alpaca-http-client.test.ts`'s "passes through a full bracket response ...
 * unmodified" — Alpaca's real payload carries fields this repo's `AlpacaOrderLeg`
 * does not declare, e.g. `limit_price`/`stop_price`, and a validator that
 * rebuilds the object from only the fields it knows about would silently drop
 * them). The caller keeps the original parsed value; this only decides
 * whether to throw.
 */
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
 * The parent order. Strict only on the fields `alpaca-adapter.ts` actually
 * reads off a RESPONSE object: `id` (bracket tracking, `submitBracket:312`),
 * `status` (`mapOrderState`), `legs`, and the fill triad `filled_qty`/
 * `filled_avg_price`/`filled_at` (`collectFill`, and `getOrder:376`'s
 * unguarded `Number.parseFloat(order.filled_qty)`).
 *
 * `client_order_id`/`qty`/`side`/`order_class` are declared on the
 * `AlpacaOrder` interface but nothing reads them back off a response —
 * `submitBracket` reads those three off its own REQUEST object, and
 * `getOrder`/`getOrderByClientOrderId` return the caller's own id, not the
 * field. Requiring them here would be exactly the unverified-shape risk this
 * ticket's design note warns against for the legs, applied to a field with
 * no payoff: `submitMarketOrder` is the flatten (#429), and if Alpaca's
 * response to a plain market order omits `order_class` (no verified live
 * sample to confirm either way), a strict check here would fail the
 * emergency exit on a shape guess. `symbol` gets the same treatment for the
 * same reason `symbolOf` (below) already degrades a missing/malformed one to
 * `'unknown'` rather than throwing — this validator must not be stricter
 * than the consumer that was deliberately built to tolerate it.
 *
 * Same "validate, don't rebuild" posture as the leg validator: returns the
 * original parsed `body`, cast, rather than a reconstructed object — Alpaca's
 * real order payload carries fields (`extended_hours`, `trail_price`, …) this
 * repo's `AlpacaOrder` does not declare, and a caller that has always received
 * the raw object must keep receiving it.
 */
function validateAlpacaOrder(body: unknown, context: string): AlpacaOrder {
  if (!isRecord(body)) failValidation(context, 'expected an object', body);
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
    legs,
  } = body;
  if (typeof id !== 'string') failValidation(context, 'id must be a string', body);
  // Declared but unread-off-a-response (see doc comment): checked only when
  // present, never required.
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
  if (legs !== undefined) {
    if (!Array.isArray(legs)) failValidation(context, 'legs must be an array', body);
    for (const leg of legs) validateAlpacaOrderLeg(leg, context, body);
  }
  // Double cast: `isRecord` narrowed `body` to `Record<string, unknown>`, which
  // TS considers too dissimilar to `AlpacaOrder` for a direct assertion — the
  // fields above are exactly what were checked, so `unknown` first is safe.
  return body as unknown as AlpacaOrder;
}

/**
 * One position row. `getOpenPositions` (`alpaca-adapter.ts:283-291`) already
 * guards `qty`/`avg_entry_price` with `Number.isFinite` after parsing — this
 * validator's job is the type-level half that guard cannot reach: a `qty`
 * that is a non-numeric STRING still parses to `NaN` and is already caught,
 * but a `qty` that is not a string at all (a vendor sending a raw number,
 * say) would otherwise flow through as a structurally-wrong `AlpacaPosition`.
 * Validates in place, returns nothing — same "don't rebuild" reasoning as
 * `validateAlpacaOrder`.
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
 * The account ledger. `cash`/`equity` feed `AccountStateProvider` directly
 * (`account-state.ts`'s `parseMoney`), which is the high-water-mark input —
 * validated here too so a malformed body fails at the transport boundary
 * rather than inside that provider. `last_equity` is deliberately never read
 * (typed `never` on the interface, #332) and is not validated here either:
 * validating a field nothing may read would be dead code the moment the
 * interface's `never` already makes it a compile error to use.
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
  // See `validateAlpacaOrder`'s comment on the double cast.
  return body as unknown as AlpacaAccount;
}

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

/**
 * Which environment variables carry which account's credentials (#511).
 *
 * **Alpaca issues a DIFFERENT key pair for paper and live.** A paper key
 * against `api.alpaca.markets` authenticates nothing, so the pair is keyed off
 * `environment` here — at the option site, where `environment` is already the
 * one control (coding-standards.md: "an option with an env default, never a
 * mid-wiring read"). Putting the rule anywhere else means every construction
 * path has to remember it, and the orchestrator, the dashboard and any future
 * caller would each have to remember it identically.
 *
 * Exported so a composition root's credential pre-flight names the same
 * variables this constructor will actually read, rather than a second list of
 * strings that can drift out of agreement with it.
 */
export const ALPACA_CREDENTIAL_ENV_VARS: Readonly<
  Record<AlpacaTradingEnvironment, { readonly key: string; readonly secret: string }>
> = {
  paper: { key: 'ALPACA_API_KEY', secret: 'ALPACA_API_SECRET' },
  live: { key: 'ALPACA_LIVE_API_KEY', secret: 'ALPACA_LIVE_API_SECRET' },
};

export interface AlpacaHttpBrokerClientOptions {
  /**
   * Defaults to the variable `ALPACA_CREDENTIAL_ENV_VARS[environment].key`
   * names — `ALPACA_API_KEY` for paper, `ALPACA_LIVE_API_KEY` for live. Never
   * logged or thrown into an error message.
   *
   * There is deliberately NO fallback from the live pair to the paper pair: a
   * live client built on a paper key either fails on its first request or, if
   * the base URL were also wrong, quietly trades the wrong account. Both are
   * worse than refusing to construct.
   */
  apiKey?: string;
  /** Defaults to `ALPACA_CREDENTIAL_ENV_VARS[environment].secret`. Never logged or thrown into an error message. */
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
    // Resolved first: it is what decides WHICH pair of variables the defaults
    // below read (#511), as well as which host `resolveBaseUrl` returns.
    const environment = options.environment ?? 'paper';
    const names = ALPACA_CREDENTIAL_ENV_VARS[environment];
    // Whitespace-only counts as absent for an env-sourced value, matching
    // `missingCredentialEnvVars` (orchestrator/index.ts): `--env-file` turns a
    // placeholder `ALPACA_LIVE_API_KEY=` into `''`, which is "not configured".
    // Only the env default is trimmed — a value the caller passed explicitly is
    // theirs, and silently rewriting a credential is worse than using it.
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
   * Runs one HTTP attempt through `withRetry`, returning the parsed AND
   * VALIDATED JSON body of a 2xx response. `validate` is supplied per call
   * site (issue #509) rather than this method doing one generic shape check:
   * `AlpacaOrder`, `AlpacaPosition[]` and `AlpacaAccount` share no structure,
   * so a single `T`-parameterized validator would need to branch on `T` at
   * runtime anyway — three named functions are the same amount of code and
   * traceable to the shape they check.
   */
  private async request<T>(
    path: string,
    init: RequestInit,
    context: string,
    validate: (body: unknown, context: string) => T,
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
          throw classifyAlpacaBrokerNetworkError(cause, context);
        }

        if (!response.ok) {
          throw await classifyAlpacaBrokerResponse(response, context);
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

        // Outside the JSON-parse try/catch: `validate` throws its own
        // already-classified `AlpacaBrokerProviderError` (`failValidation`
        // above), and catching it here would just re-wrap it as an identical
        // instance for no benefit — see #509's reviewer note on guarding
        // catch blocks that can themselves throw. There is nothing in this
        // one worth guarding against.
        return validate(parsed, context);
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
      validateAlpacaOrder,
    );
  }

  /**
   * The flatten (#429). `type: 'market'` is the wire-only field here, exactly
   * as `submitOrder` adds `type: 'limit'` — the request interface carries no
   * price, which already implies a market order, but Alpaca's body requires
   * the field.
   */
  async submitMarketOrder(request: AlpacaMarketOrderRequest): Promise<AlpacaOrder> {
    return this.request<AlpacaOrder>(
      '/v2/orders',
      { method: 'POST', body: JSON.stringify({ ...request, type: 'market' }) },
      'submitMarketOrder',
      validateAlpacaOrder,
    );
  }

  /**
   * Re-arm on a residual (#525) — `order_class: 'oco'`, take-profit +
   * stop-loss, no entry: this closes quantity the account already holds
   * rather than opening any. `type: 'limit'` is the wire-only field, added
   * here for the same reason `submitOrder`/`submitMarketOrder` add theirs —
   * the interface's `limit_price` already implies it.
   *
   * NOT verified against a live paper account: this mirrors Alpaca's
   * documented OCO shape, but nothing in this repo has exercised it against
   * the real API.
   */
  async submitOcoOrder(request: AlpacaOcoOrderRequest): Promise<AlpacaOrder> {
    return this.request<AlpacaOrder>(
      '/v2/orders',
      { method: 'POST', body: JSON.stringify({ ...request, type: 'limit' }) },
      'submitOcoOrder',
      validateAlpacaOrder,
    );
  }

  /**
   * Cancel, made idempotent at the transport (#429).
   *
   * Alpaca answers `204` on an accepted cancel, `404` when it has no such
   * order, and `422` when the order is no longer cancelable (already filled or
   * cancelled). All three mean the same thing to the caller — there is nothing
   * working under that id any more — so only a genuine transport or auth
   * failure propagates. A cancel that threw on `422` would be a tool that
   * fails precisely in the race it exists to handle.
   *
   * Uses `fetch` directly rather than `request<T>`: a `204` has no body, and
   * `request` parses one unconditionally.
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
          throw classifyAlpacaBrokerNetworkError(cause, 'cancelOrder');
        }

        if (response.ok || response.status === 404 || response.status === 422) return;
        throw await classifyAlpacaBrokerResponse(response, 'cancelOrder');
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

  async getOrderByClientOrderId(clientOrderId: string): Promise<AlpacaOrder | null> {
    try {
      return await this.request<AlpacaOrder>(
        `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}`,
        { method: 'GET' },
        'getOrderByClientOrderId',
        validateAlpacaOrder,
      );
    } catch (error) {
      // A validation failure has no `status` (`failValidation` never sets
      // one), so it falls through to the rethrow below rather than being
      // mistaken for "no such order" — only a genuine 404 maps to null.
      if (error instanceof AlpacaBrokerProviderError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }
}
