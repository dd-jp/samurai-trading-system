/**
 * Per-venue outbound pacing, as ops config rather than compile-time constants
 * (#299): a rate limit is a property of the account, not of the code, so
 * these live here, overridable per deployment via env.
 *
 * Each value below is labelled with what is actually known: `VERIFIED`
 * (venue's own published figure, cited by URL), `CEILING VERIFIED, RATE
 * UNVERIFIED` (ceiling is real, operating rate is a conservative guess), or
 * `UNVERIFIED` (no venue decision exists yet; kept as a flagged placeholder).
 */
import type { TokenBucketConfig } from './token-bucket.js';

/**
 * The three broker venues `BrokerAdapter` has implementations for. Polygon
 * is deliberately excluded (#510) — including it here would make
 * `resolveVenuePacing()` validate `SAMURAI_PACING_POLYGON_*` and fail live
 * boot on a Stage-2-only typo; see `resolvePolygonPacing` below instead.
 */
export type VenueKey = 'alpaca' | 'ccxt' | 'ibkr' | 'saxo';

export type VenuePacingConfig = Record<VenueKey, TokenBucketConfig>;

const VENUE_KEYS: readonly VenueKey[] = ['alpaca', 'ccxt', 'ibkr', 'saxo'];

/**
 * Venue's own published hard limit, req/sec. `resolveVenuePacing` refuses
 * any configured sustained rate above it. A venue absent here has no
 * verified ceiling and is not given an invented one. An account with a
 * granted allowance above the published rate overrides via
 * `SAMURAI_PACING_<VENUE>_CEILING_PER_SEC` rather than editing this map.
 */
export const VENUE_DOCUMENTED_CEILING_PER_SECOND: Partial<Record<VenueKey, number>> = {
  /**
   * VERIFIED: 200 req/min per account —
   * https://alpaca.markets/support/usage-limit-api-calls. Shared with
   * market-data-service/alpaca-http-client.ts, hence the default well under
   * this ceiling (#391).
   */
  alpaca: 200 / 60,
  /**
   * VERIFIED: 50 orders/sec to TWS —
   * https://interactivebrokers.github.io/tws-api/order_limitations.html.
   * Exceeding it closes the TWS connection while a bracket is live.
   */
  ibkr: 50,
  /** Saxo OpenAPI: 120 req/min per service group, tightest published figure (#1032); orders additionally capped at 1/sec/session. */
  saxo: 120 / 60,
  // ccxt: deliberately absent. See DEFAULT_VENUE_PACING.ccxt.
};

/**
 * Polygon's documented ceiling — VERIFIED: free tier is 5 calls/min with a
 * 2-year history cap (docs/research/32-vendor-api-reference.md). Kept out
 * of `VENUE_DOCUMENTED_CEILING_PER_SECOND` since Polygon is not a `VenueKey`.
 */
export const POLYGON_DOCUMENTED_CEILING_PER_SECOND = 5 / 60;

/**
 * The checked-in starting values. Overridable per deployment; see
 * `resolveVenuePacing`.
 */
export const DEFAULT_VENUE_PACING: VenuePacingConfig = {
  /**
   * Shared by the broker adapter and alpaca-http-client.ts against Alpaca's
   * 200/min per-account ceiling (#391). `refillPerSecond: 2.0` = 80% of
   * ceiling (120/min), measured against #1080's soak demand (~0.95 tok/s
   * coalesced). `capacity: 41` is a cold-start burst for a 20-instrument
   * universe (20 bar fetches + 20 getOrder + 1 submit), pinned by
   * `rate-limit-wiring.test.ts`. `reserveForPriority: 21` guarantees the
   * order path can sweep and place a leg without waiting behind a bar burst.
   * Revisit all three together if the universe size changes.
   */
  alpaca: { capacity: 41, refillPerSecond: 2.0, reserveForPriority: 21 },
  /**
   * UNVERIFIED, deliberately conservative: no crypto venue/account exists
   * yet (ADR-0001, long-term ccxt path). Kraken/Coinbase both publish more
   * headroom than 1/s, but neither figure is a limit for our key.
   * `SAMURAI_PACING_CCXT_*` overrides once a venue and tier are chosen.
   */
  ccxt: { capacity: 1, refillPerSecond: 1, reserveForPriority: 0 },
  /**
   * Ceiling verified (50 msg/s), operating rate unverified: no IBKR account
   * or gateway exists to measure against, so `5/s` is a conservative 10% of
   * the documented ceiling. A pacing violation disconnects the TWS session
   * while it holds live bracket legs, hence the wide margin.
   */
  ibkr: { capacity: 5, refillPerSecond: 5, reserveForPriority: 0 },
  /**
   * Saxo's order-placement session throttle is 1 req/sec (not the 120/min
   * service-group ceiling); `capacity: 2` covers the first two requests of
   * a fan-out before queuing on the refill. `reserveForPriority: 1` (#1419)
   * keeps `acquireBackground()` reads from draining the bucket to 0 and
   * starving `placeOrder`/`cancelOrder`. Unverified beyond the published
   * ceilings — no live account exists yet to calibrate against (#1222).
   */
  saxo: { capacity: 2, refillPerSecond: 1, reserveForPriority: 1 },
};

/**
 * Polygon's checked-in default. `refillPerSecond: 1/13` migrates
 * `HttpPolygonClient`'s prior `MIN_REQUEST_SPACING_MS = 13_000` unchanged
 * rather than re-deriving it (#510) — ~92% of the 5/min ceiling, a thinner
 * margin than Alpaca's but acceptable since Polygon is hand-run Stage 2
 * scripts plus an equities fallback (#562), never sustained load.
 * `capacity: 1`: nothing in this workload benefits from a burst, and a
 * higher capacity would eat into that thin margin.
 */
export const DEFAULT_POLYGON_PACING: TokenBucketConfig = {
  capacity: 1,
  refillPerSecond: 1 / 13,
  reserveForPriority: 0,
};

/**
 * The environment variables that override one bucket. Not scoped to
 * `VenueKey` — the string it prefixes is a plain label (`'alpaca'`,
 * `'polygon'`, ...), because `resolvePolygonPacing` below reuses this same
 * name-building for a label that is deliberately not a `VenueKey`.
 */
export function venuePacingEnvVars(venue: string): {
  capacity: string;
  refillPerSecond: string;
  ceilingPerSecond: string;
  reserveForPriority: string;
} {
  const prefix = `SAMURAI_PACING_${venue.toUpperCase()}`;
  return {
    capacity: `${prefix}_CAPACITY`,
    refillPerSecond: `${prefix}_REFILL_PER_SEC`,
    ceilingPerSecond: `${prefix}_CEILING_PER_SEC`,
    reserveForPriority: `${prefix}_PRIORITY_RESERVE`,
  };
}

/**
 * The ceiling this deployment's account is actually entitled to — the
 * checked-in published figure unless overridden. A separate env var rather
 * than dropping the check: raising it must be a deliberate act ("my account
 * is documented at this figure"), not an accident while tuning throughput.
 */
function resolveCeiling(
  env: NodeJS.ProcessEnv,
  documented: number | undefined,
  name: string,
): number | undefined {
  const raw = (env[name] ?? '').trim();
  if (raw.length === 0) return documented;

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a finite number greater than 0; got '${raw}'.`);
  }
  return value;
}

/**
 * Reads a positive, finite number, or throws naming the variable — a typo
 * must not silently run the venue at a rate nobody chose. Whitespace-only
 * counts as unset (same rule as `requireEnv`/`nonEmpty`).
 */
function readPositive(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  constraints: {
    min: number;
    minLabel: string;
    ceiling?: number | undefined;
    ceilingEnvVar?: string;
  },
): number {
  const raw = (env[name] ?? '').trim();
  if (raw.length === 0) return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number; got '${raw}'.`);
  }
  if (value < constraints.min) {
    throw new Error(`${name} must be ${constraints.minLabel}; got ${value}.`);
  }
  if (constraints.ceiling !== undefined && value > constraints.ceiling) {
    throw new Error(
      `${name}=${value} exceeds the venue's documented limit of ${constraints.ceiling}/s. ` +
        'Pacing above a published rate limit does not make the system faster — it earns a 429 ' +
        'and, sustained, a banned API key. If THIS ACCOUNT has a documented allowance above ' +
        `that figure, state it with ${constraints.ceilingEnvVar} — no code change needed.`,
    );
  }
  return value;
}

/**
 * Resolves one bucket's config from env, validated against
 * `documentedCeiling`. Shared by `resolveVenuePacing` and
 * `resolvePolygonPacing` so the two entry points don't diverge (#520).
 */
function resolveBucketPacing(
  env: NodeJS.ProcessEnv,
  names: ReturnType<typeof venuePacingEnvVars>,
  fallback: TokenBucketConfig,
  documentedCeiling: number | undefined,
): TokenBucketConfig {
  return {
    // Capacity under 1 token never satisfies `acquire()`'s `tokens >= 1` test.
    capacity: readPositive(env, names.capacity, fallback.capacity, {
      min: 1,
      minLabel: 'at least 1 (a bucket under one token never releases a call)',
    }),
    refillPerSecond: readPositive(env, names.refillPerSecond, fallback.refillPerSecond, {
      min: Number.MIN_VALUE,
      minLabel: 'greater than 0 (a non-positive rate parks every call forever)',
      ceiling: resolveCeiling(env, documentedCeiling, names.ceilingPerSecond),
      ceilingEnvVar: names.ceilingPerSecond,
    }),
    reserveForPriority: resolveReserve(env, names, fallback),
  };
}

/**
 * The pacing this deployment runs at: checked-in defaults with any
 * `SAMURAI_PACING_<VENUE>_*` override applied. `env` is injected so
 * validation is testable without mutating the process. Reads `VENUE_KEYS`
 * only — Polygon is excluded (see `VenueKey`'s doc); `resolvePolygonPacing`
 * is its parallel entry point.
 */
export function resolveVenuePacing(env: NodeJS.ProcessEnv = process.env): VenuePacingConfig {
  const resolved = {} as VenuePacingConfig;

  for (const venue of VENUE_KEYS) {
    resolved[venue] = resolveBucketPacing(
      env,
      venuePacingEnvVars(venue),
      DEFAULT_VENUE_PACING[venue],
      VENUE_DOCUMENTED_CEILING_PER_SECOND[venue],
    );
  }

  return resolved;
}

/**
 * Polygon's own pacing resolution — reads only `SAMURAI_PACING_POLYGON_*`,
 * isolated from `resolveVenuePacing()`. Called at boot by
 * `data-failover.ts` inside a try/catch: a malformed override logs a
 * `warn` and falls back to `DEFAULT_POLYGON_PACING` rather than refusing
 * to boot over a variable that paces a degradation mitigation.
 */
export function resolvePolygonPacing(env: NodeJS.ProcessEnv = process.env): TokenBucketConfig {
  return resolveBucketPacing(
    env,
    venuePacingEnvVars('polygon'),
    DEFAULT_POLYGON_PACING,
    POLYGON_DOCUMENTED_CEILING_PER_SECOND,
  );
}

/**
 * MEASURED (#1080): a warm-store sweep asks the venue for at most this many
 * distinct bar windows per instrument. Kept as one exported constant so
 * `rate-limit-wiring.test.ts`'s pin cannot drift from this value.
 */
export const DISTINCT_BAR_WINDOWS_PER_INSTRUMENT = 4;

/**
 * Queue wait `pacing` forces on the last token a warm-store sweep of
 * `universeSize` instruments needs before that fetch can even start
 * (#1542). Drain of background headroom (`capacity - reserveForPriority`)
 * at `refillPerSecond`; floored at zero when headroom alone covers the
 * sweep. Exported separately from `deriveAnalystTimeoutMs` so the #1080
 * drift guard can assert on this term alone.
 */
export function deriveAnalystDrainMs(pacing: TokenBucketConfig, universeSize: number): number {
  const backgroundHeadroom = pacing.capacity - (pacing.reserveForPriority ?? 0);
  const sweepRequests = universeSize * DISTINCT_BAR_WINDOWS_PER_INSTRUMENT;
  return Math.max(((sweepRequests - backgroundHeadroom) / pacing.refillPerSecond) * 1_000, 0);
}

/**
 * Analyst per-attempt deadline `pacing` forces on a warm-store sweep of
 * `universeSize` instruments (#1542) — the derivation the composition root
 * runs against the resolved bucket, so an operator's `SAMURAI_PACING_*`
 * override cannot silently outrun a hand-computed constant. Sums the queue
 * wait (`deriveAnalystDrainMs`, which floors at zero) with `fetchBoundMs`
 * (the bounded fetch itself once a token is granted) rather than taking
 * `max`, since the two wait sequentially.
 */
export function deriveAnalystTimeoutMs(
  pacing: TokenBucketConfig,
  universeSize: number,
  fetchBoundMs: number,
): number {
  return deriveAnalystDrainMs(pacing, universeSize) + fetchBoundMs;
}

/**
 * The tokens `acquireBackground()` may not spend (#391). Validated against
 * the resolved capacity: a reserve at or above capacity would park every
 * market-data call forever, refused at startup rather than paced.
 */
function resolveReserve(
  env: NodeJS.ProcessEnv,
  names: ReturnType<typeof venuePacingEnvVars>,
  fallback: TokenBucketConfig,
): number {
  const capacity = readPositive(env, names.capacity, fallback.capacity, {
    min: 1,
    minLabel: 'at least 1 (a bucket under one token never releases a call)',
  });
  const reserve = readPositive(env, names.reserveForPriority, fallback.reserveForPriority ?? 0, {
    min: 0,
    minLabel: 'at least 0',
  });

  if (reserve > capacity - 1) {
    throw new Error(
      `${names.reserveForPriority}=${reserve} leaves no token for background callers under a ` +
        `capacity of ${capacity}: a background acquire needs 1 + reserve tokens, so market-data ` +
        'calls would park forever and the run would look like a quiet market rather than a ' +
        `stopped one. Use at most ${capacity - 1}, or raise ${names.capacity}.`,
    );
  }
  return reserve;
}
