/**
 * The Polymarket wire client (#504, from research #481 /
 * `docs/research/23-polymarket-source.md`).
 *
 * Two public read-only endpoints, no authentication, no key to provision, and
 * — unlike every other Market Intelligence source with an agent — **no LLM
 * call anywhere in the path**. That is why the agent above it carries no
 * `spendCap`/`spendSink`: there is nothing to meter, and zero-cost rows in
 * `llm_spend` would only make ADR-0008's ledger harder to read (#504 scope
 * item 6).
 *
 * ## What it talks to
 *
 * - **Gamma** `/events?slug=<slug>` — the curated event and its markets, with
 *   the book-quality fields the agent's fail-closed guard reads (`bestBid`,
 *   `bestAsk`, `spread`, `volume24hr`, `liquidityNum`, `updatedAt`).
 * - **CLOB** `/prices-history?market=<tokenId>&interval=1d&fidelity=60` — the
 *   probability series the 24h delta is computed from. #504 scope item 3
 *   names this endpoint: the LEVEL is not the signal, the CHANGE is.
 *
 * Both shapes were verified live on 2026-08-17 (see the PR body) — this is a
 * public, unversioned API with no stability contract, so what it returns is
 * measured rather than taken from documentation.
 *
 * ## The parse is the point
 *
 * Gamma returns `outcomes`, `outcomePrices` and `clobTokenIds` as
 * JSON-encoded **strings**, not arrays:
 *
 *     "outcomes": "[\"Yes\", \"No\"]", "outcomePrices": "[\"0.295\", \"0.705\"]"
 *
 * A cast would compile and then index a string by position, so the decode is
 * explicit and every failure is a throw the agent catches — never a silently
 * wrong probability, which on this path becomes a `sentiment` an analyst
 * votes with.
 *
 * ## What it deliberately does NOT do
 *
 * No scoring, no `IntelligenceItem`, no store write, no cadence — same split
 * as `GdeltGkgClient`/`GdeltIngestAgent`. It returns normalised wire records;
 * `PolymarketAgent` owns everything that decides what reaches an analyst.
 */

import { TokenBucket } from '../../../shared/index.js';

const DEFAULT_GAMMA_BASE_URL = 'https://gamma-api.polymarket.com';
const DEFAULT_CLOB_BASE_URL = 'https://clob.polymarket.com';

/**
 * How long any single request may stall before it is abandoned.
 *
 * Measured latencies are 80–170 ms (#481 §5). These are small JSON documents
 * over a public CDN, so 20 s is ~100x the observed worst case: generous enough
 * that a slow link does not lose a refresh, short enough that a half-open
 * connection cannot hold a poll across the hourly cadence.
 */
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Refuse a response larger than this rather than parsing it.
 *
 * A 25-point price history is ~1KB and the largest event payload measured is
 * a few tens of KB. 8MB is orders of magnitude above both, so anything past it
 * is a mis-routed response, not data.
 */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * Published limits are Gamma 4,000 req/10s and CLOB 9,000 req/10s (#481 §5).
 * Eight curated rows at two requests each, once an hour, is ~16 requests/hour
 * — four orders of magnitude of headroom. This bucket therefore exists to
 * bound a BUG (a retry loop, a table that grew by accident), not to pace
 * normal traffic.
 */
const DEFAULT_PACING = { capacity: 20, refillPerSecond: 5 } as const;

/** One Polymarket binary market, decoded off the Gamma wire shape. */
export interface PolymarketMarket {
  slug: string;
  question: string;
  /** Outcome names, in token order — `['Yes', 'No']` for every market tracked. */
  outcomes: string[];
  /** Current implied probabilities, index-aligned with `outcomes`. */
  outcomePrices: number[];
  /** CLOB token ids, index-aligned with `outcomes`. This is what `/prices-history` keys on. */
  tokenIds: string[];
  /** Best bid/ask on the FIRST outcome's book. `undefined` when the wire omits them. */
  bestBid: number | undefined;
  bestAsk: number | undefined;
  spread: number | undefined;
  /** 24h traded volume in USDC. `undefined` when the wire omits it — which it does on quiet markets. */
  volume24hr: number | undefined;
  liquidity: number | undefined;
  /** The vendor's revision stamp — the agent's staleness guard reads this. */
  updatedAt: Date | undefined;
  closed: boolean;
  /** The market object as fetched, for the archive. Not re-parsed anywhere. */
  payload: string;
}

/** One point of a market's probability history. */
export interface PolymarketPricePoint {
  at: Date;
  probability: number;
}

export interface PolymarketClientOptions {
  gammaBaseUrl?: string | undefined;
  clobBaseUrl?: string | undefined;
  fetchImpl?: typeof fetch;
  rateLimiter?: TokenBucket;
}

/**
 * `redirect: 'error'`, for the reason `GdeltGkgClient` states: this feed
 * reaches an analyst and therefore an order, so a redirect off the configured
 * host is a change of behaviour worth failing on rather than absorbing.
 *
 * Built per call, never hoisted: `AbortSignal.timeout` starts counting when it
 * is created, so a shared signal would abort everything after the first 20
 * seconds of process life.
 */
function requestInit(): RequestInit {
  return { redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
}

/** Decodes one of Gamma's JSON-encoded-string array fields. */
function decodeJsonArray(raw: unknown, field: string, slug: string): string[] {
  if (Array.isArray(raw)) return raw.map((entry) => String(entry));
  if (typeof raw !== 'string') {
    throw new Error(`polymarket: market '${slug}' has no ${field}`);
  }
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`polymarket: market '${slug}' has a non-array ${field}`);
  }
  return parsed.map((entry) => String(entry));
}

function optionalNumber(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.length > 0) {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function optionalDate(raw: unknown): Date | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export class PolymarketClient {
  private readonly gammaBaseUrl: string;
  private readonly clobBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly rateLimiter: TokenBucket;

  constructor(options: PolymarketClientOptions = {}) {
    this.gammaBaseUrl = options.gammaBaseUrl ?? DEFAULT_GAMMA_BASE_URL;
    this.clobBaseUrl = options.clobBaseUrl ?? DEFAULT_CLOB_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.rateLimiter = options.rateLimiter ?? new TokenBucket(DEFAULT_PACING);
  }

  /**
   * One curated market, or `undefined` when the event or the market slug no
   * longer exists.
   *
   * `undefined` and a throw mean different things on purpose, and the agent
   * treats them differently. `undefined` is **slug rot** — the event resolved
   * and its replacement was minted under a new slug — which is expected,
   * permanent until the table is edited, and worth a distinct log line.
   * A throw is a transport or shape failure, which is transient and retried on
   * the next refresh. Collapsing the two would make a decayed table look like
   * a flaky vendor forever.
   */
  async fetchEventMarket(
    eventSlug: string,
    marketSlug: string,
  ): Promise<PolymarketMarket | undefined> {
    const url = `${this.gammaBaseUrl}/events?slug=${encodeURIComponent(eventSlug)}`;
    const body = await this.getJson(url);
    if (!Array.isArray(body) || body.length === 0) return undefined;

    const event = body[0] as { markets?: unknown };
    const markets = Array.isArray(event.markets) ? event.markets : [];
    const raw = markets.find((market) => (market as { slug?: unknown }).slug === marketSlug) as
      | Record<string, unknown>
      | undefined;
    if (raw === undefined) return undefined;

    const outcomes = decodeJsonArray(raw.outcomes, 'outcomes', marketSlug);
    const prices = decodeJsonArray(raw.outcomePrices, 'outcomePrices', marketSlug).map(Number);
    const tokenIds = decodeJsonArray(raw.clobTokenIds, 'clobTokenIds', marketSlug);
    // Checked rather than trusted: an outcome/price/token misalignment would
    // silently take the delta of the WRONG side of the book, which reaches an
    // analyst as a correctly-formed and exactly-inverted signal.
    if (outcomes.length !== prices.length || outcomes.length !== tokenIds.length) {
      throw new Error(
        `polymarket: market '${marketSlug}' has ${outcomes.length} outcomes but ` +
          `${prices.length} prices and ${tokenIds.length} token ids`,
      );
    }
    if (prices.some((price) => !Number.isFinite(price))) {
      throw new Error(`polymarket: market '${marketSlug}' has an unparseable outcome price`);
    }

    return {
      slug: marketSlug,
      question: typeof raw.question === 'string' ? raw.question : marketSlug,
      outcomes,
      outcomePrices: prices,
      tokenIds,
      bestBid: optionalNumber(raw.bestBid),
      bestAsk: optionalNumber(raw.bestAsk),
      spread: optionalNumber(raw.spread),
      volume24hr: optionalNumber(raw.volume24hr),
      liquidity: optionalNumber(raw.liquidityNum) ?? optionalNumber(raw.liquidity),
      updatedAt: optionalDate(raw.updatedAt),
      closed: raw.closed === true,
      payload: JSON.stringify(raw),
    };
  }

  /**
   * One token's probability series over the last day, oldest-first.
   *
   * `fidelity=60` (hourly) rather than the minute granularity the API also
   * offers: the agent needs one point ~24h back and one now, and 25 points is
   * enough to find both while `fidelity=1` would return 1,441 points per
   * market per refresh for no added precision at this cadence.
   */
  async fetchPriceHistory(tokenId: string): Promise<PolymarketPricePoint[]> {
    const url =
      `${this.clobBaseUrl}/prices-history?market=${encodeURIComponent(tokenId)}` +
      '&interval=1d&fidelity=60';
    const body = await this.getJson(url);
    const history = (body as { history?: unknown }).history;
    if (!Array.isArray(history)) return [];
    return history
      .map((point) => {
        const record = point as { t?: unknown; p?: unknown };
        const seconds = optionalNumber(record.t);
        const probability = optionalNumber(record.p);
        if (seconds === undefined || probability === undefined) return undefined;
        return { at: new Date(seconds * 1000), probability };
      })
      .filter((point): point is PolymarketPricePoint => point !== undefined);
  }

  private async getJson(url: string): Promise<unknown> {
    await this.rateLimiter.acquire();
    const response = await this.fetchImpl(url, requestInit());
    if (!response.ok) {
      throw new Error(`polymarket: ${url} returned HTTP ${response.status}`);
    }
    // Bounded before the body is parsed whenever the server declares a length.
    // The post-read check below is what catches a missing or understated
    // header — the same two-sided shape `GdeltGkgClient` uses, with the same
    // admitted limit: an undeclared oversized body is still materialised once.
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      throw new Error(`polymarket: ${url} declared ${declared} bytes`);
    }
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      throw new Error(`polymarket: ${url} returned ${text.length} bytes`);
    }
    return JSON.parse(text);
  }
}
