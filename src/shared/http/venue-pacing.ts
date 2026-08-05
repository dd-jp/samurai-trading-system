/**
 * Per-venue outbound pacing, as OPS CONFIG rather than compile-time constants
 * (ticket #299, follow-up to PR #297's security finding C2).
 *
 * PR #297 gave every broker adapter a `TokenBucket` and hard-coded its size in
 * the adapter's own constructor default. #299's objection is not that those
 * numbers were wrong — it is that **a rate limit is a property of the account,
 * not of the code**. Two operators on different Alpaca tiers, or one operator
 * who writes to Alpaca support and gets a raise, cannot both be right about a
 * literal compiled into `alpaca-adapter.ts`. So the numbers live here, one
 * place, overridable per deployment by the environment that already holds the
 * credentials they pace.
 *
 * ## Provenance, and the honesty rule
 *
 * Every value below is labelled with what is actually known about it. The
 * distinction is load-bearing, because the two directions of error are not
 * symmetric: a rate set too LOW costs latency (and, for `CcxtBrokerAdapter`,
 * widens the unprotected-lot window its own header calls out), while a rate
 * set too HIGH costs the API key. An invented number that is too high is a ban.
 *
 * - **`VERIFIED`** — the venue publishes the figure and it was read from the
 *   venue's own documentation, cited by URL.
 * - **`CEILING VERIFIED, RATE UNVERIFIED`** — the venue publishes a hard
 *   ceiling, but the rate this system should actually run at underneath it
 *   depends on an account/tier/connection that does not exist yet. The ceiling
 *   is enforced (see `VENUE_DOCUMENTED_CEILING_PER_SECOND`) and is itself
 *   overridable per account (`SAMURAI_PACING_<VENUE>_CEILING_PER_SEC`); the
 *   operating rate stays conservative and is flagged as untuned.
 * - **`UNVERIFIED`** — nothing about this venue's real limit could be
 *   established for the account in use, because there is no account and no
 *   venue decision. The conservative placeholder is KEPT and said to be a
 *   placeholder, rather than replaced with a plausible-looking invention.
 */
import type { TokenBucketConfig } from './token-bucket.js';

/** The three broker venues `BrokerAdapter` has implementations for. */
export type VenueKey = 'alpaca' | 'ccxt' | 'ibkr';

export type VenuePacingConfig = Record<VenueKey, TokenBucketConfig>;

export const VENUE_KEYS: readonly VenueKey[] = ['alpaca', 'ccxt', 'ibkr'];

/**
 * The venue's own published hard limit, in requests per second, where one
 * could be read from the venue's documentation. `resolveVenuePacing` refuses
 * any configured sustained rate above it.
 *
 * A venue absent from this map has no verified ceiling and is NOT given an
 * invented one — the operator is trusted and the default stays at a floor.
 *
 * These are the PUBLISHED figures, not a claim about what this deployment's
 * account is entitled to. An account with a granted allowance above its
 * venue's published rate states it with
 * `SAMURAI_PACING_<VENUE>_CEILING_PER_SEC` rather than editing this map — see
 * `resolveCeiling`, and #299's premise that a rate limit belongs to the
 * account rather than to the code.
 */
export const VENUE_DOCUMENTED_CEILING_PER_SECOND: Partial<Record<VenueKey, number>> = {
  /**
   * VERIFIED. "the API is throttled, currently 200 requests per minute, per
   * account" — https://alpaca.markets/support/usage-limit-api-calls
   * (200/60 = 3.333/s). Exceeding it returns HTTP 429.
   *
   * Note "per ACCOUNT", not per endpoint: the trading calls this bucket paces
   * and the market-data calls `market-data-service/sources/alpaca-http-client.ts`
   * makes draw on the SAME 200/min. That is why the default below is set well
   * under the ceiling rather than at it — see `DEFAULT_VENUE_PACING.alpaca`.
   */
  alpaca: 200 / 60,
  /**
   * VERIFIED. "50 messages per second" and "a maximum of 50 orders per second
   * being sent to the TWS" —
   * https://interactivebrokers.github.io/tws-api/order_limitations.html
   * Exceeding it is a pacing violation, which TWS answers by CLOSING THE
   * CONNECTION — for a bracket-holding adapter that means the venue stops
   * taking calls while a lot is live.
   */
  ibkr: 50,
  // ccxt: deliberately absent. See DEFAULT_VENUE_PACING.ccxt.
};

/**
 * The checked-in starting values. Overridable per deployment; see
 * `resolveVenuePacing`.
 */
export const DEFAULT_VENUE_PACING: VenuePacingConfig = {
  /**
   * The three numbers here are set on DIFFERENT AXES for different reasons and
   * have different evidence behind them. Stating that split was a PR #390
   * review finding: the old comment cited Alpaca's sustained figure and let it
   * read as if it justified the burst too, which it does not.
   *
   * **ONE BUCKET, TWO CONSUMERS (#391).** This config now paces the broker
   * adapter AND `market-data-service/sources/alpaca-http-client.ts`, which
   * share Alpaca's per-ACCOUNT 200 req/min. Before #391 only the broker was
   * paced, and the headroom left for the unpaced data client was reserved by
   * simply running the broker at 45% of the ceiling — headroom a consumer
   * that could exceed it freely was expected to respect.
   *
   * **`refillPerSecond: 2.5` — SUSTAINED, CEILING VERIFIED / RATE UNVERIFIED.**
   * RE-DERIVED, not inherited (#391's fourth criterion): with both consumers
   * inside the budget there is no unpaced third party to leave 55% for, so
   * the split is now a deliberate 75% of the documented 200 req/min = 3.33/s
   * ceiling — 2.5/s = 150/min. The remaining 25% is margin for what this
   * bucket still does NOT pace: `withRetry`'s own retry attempts, and any
   * future consumer on the same key. This is an OPERATING rate under a
   * verified ceiling, not a figure Alpaca publishes — it has not been
   * measured against a real account under load.
   *
   * **`capacity: 14` — BURST, and NO PUBLISHED ALPACA BURST LIMIT COULD BE
   * ESTABLISHED.** Alpaca's own support page states only "200 requests per
   * minute, per account" with no burst qualifier; secondary write-ups describe
   * that as a rolling 60-second window, but that is not Alpaca's wording and
   * is not relied on here. So, per this module's own honesty rule, the number
   * is DERIVED FROM OUR WORKLOAD — specifically from the worst moment, which
   * is a COLD START rather than steady state: `TokenBucket` begins full, and
   * on a fresh process the bar cache is empty, so all 6 ADR-0001 instruments
   * fetch bars at once (6) while `reconcile()` sweeps open brackets with one
   * `getOrder` each (up to 6), plus a `submitBracket` from the first tick (1).
   * 13, rounded to 14. Pinned against the universe size by a test, so widening
   * the universe again cannot silently outgrow the burst.
   *
   * **`reserveForPriority: 6` — WORKLOAD-DERIVED.** The tokens market data may
   * not spend. One full fill-poll sweep of the 6-instrument universe is 6
   * `getOrder` calls, so this guarantees the order path can always complete a
   * sweep — and place a leg — without waiting behind a bar burst. Market data
   * is therefore capped at `capacity - reserve` = 8 back-to-back calls.
   *
   * Why an unverified burst is an acceptable risk where an unverified
   * SUSTAINED rate would not be: exceeding a burst allowance returns 429,
   * which `withRetry` already handles and the bucket then paces; a BAN comes
   * from sustained abuse, and on that axis this value stays a quarter clear of
   * a verified ceiling.
   *
   * Alpaca's published figure does not distinguish paper from live, and the
   * paper host is the one the soak uses; nothing was found that documents a
   * separate paper allowance, so the same ceiling is applied to both.
   */
  alpaca: { capacity: 14, refillPerSecond: 2.5, reserveForPriority: 6 },
  /**
   * UNVERIFIED, and kept conservative on purpose.
   *
   * #299 asks for "the account tier in use". There is none: ADR-0001 puts the
   * crypto venue at "Kraken or Coinbase Advanced via ccxt" as a LONG-TERM
   * path, no account has been opened, and `CcxtBrokerAdapter` is not
   * constructed at the composition root at all today. Both candidates publish
   * more headroom than 1/s for their cheapest tier — Kraken's spot trading
   * rate limits give the Starter tier a threshold of 60 with a decay of 1/s
   * (https://docs.kraken.com/api/docs/guides/spot-ratelimits), and Coinbase
   * documents 5 req/s with bursts to 10 on private endpoints
   * (https://docs.cdp.coinbase.com/exchange/rest-api/rate-limits) — but
   * neither figure is a limit for OUR key, and Kraken's is a decaying counter
   * with per-call penalties rather than a flat rate, so it cannot be
   * transcribed into a token bucket without a real account to calibrate
   * against.
   *
   * So the honest answer is the one #299 explicitly permits: keep the
   * conservative value and label it, rather than invent one. The KNOWN COST of
   * keeping it is real and is the reason this is configurable rather than
   * merely documented — at `{capacity: 1, refillPerSecond: 1}` the two
   * protective legs in `armLegs`' `Promise.all` serialize and are placed ≥1s
   * apart, widening the unprotected-lot window, and a `syncBrackets` sweep
   * over N brackets costs ~N seconds. The day a venue and tier are chosen,
   * `SAMURAI_PACING_CCXT_*` closes that window without a code change.
   */
  ccxt: { capacity: 1, refillPerSecond: 1, reserveForPriority: 0 },
  /**
   * CEILING VERIFIED (50 msg/s, cited above), OPERATING RATE UNVERIFIED.
   *
   * The ceiling is a documented property of the TWS API. The rate this system
   * should sit at underneath it is not: TWS pacing in practice varies by
   * account, by connection and by request kind (historical-data pacing is a
   * separate and much stricter regime), and there is no TWS gateway, no
   * `IbkrBrokerClient` implementation in this repo, and no IBKR account to
   * measure against. `5/s` is therefore retained as a deliberate 10% of the
   * documented ceiling — conservative, and labelled untuned rather than
   * presented as IBKR's number.
   *
   * The failure mode is what justifies staying an order of magnitude clear: a
   * pacing violation is answered with a DISCONNECT, and this adapter's
   * disconnects happen while the venue holds live bracket legs.
   */
  ibkr: { capacity: 5, refillPerSecond: 5, reserveForPriority: 0 },
};

/** The environment variables that override one venue's bucket. */
export function venuePacingEnvVars(venue: VenueKey): {
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
 * The ceiling this deployment's account is actually entitled to, which is the
 * checked-in published figure unless the operator states otherwise.
 *
 * **Why this escape hatch exists (code review, spec axis).** #299's whole point
 * is that "a rate limit is a property of the account, not of the code". A
 * ceiling that can only be raised by editing `VENUE_DOCUMENTED_CEILING_PER_SECOND`
 * re-hardcodes exactly that, in the one direction an operator would ever need
 * it: Alpaca grants raised allowances on request, and an operator who has been
 * granted one should not have to patch and redeploy to use it.
 *
 * It is a SEPARATE variable rather than simply dropping the check, because the
 * two mistakes are not symmetric. Setting a rate above a published limit does
 * not make the system faster — it earns 429s and, sustained, a banned key. So
 * raising the ceiling stays a deliberate, separate act that says "my account is
 * documented at this figure", rather than something an operator does by
 * accident while tuning throughput.
 */
function resolveCeiling(env: NodeJS.ProcessEnv, venue: VenueKey, name: string): number | undefined {
  const raw = (env[name] ?? '').trim();
  if (raw.length === 0) return VENUE_DOCUMENTED_CEILING_PER_SECOND[venue];

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a finite number greater than 0; got '${raw}'.`);
  }
  return value;
}

/**
 * Reads a positive, finite number, or throws naming the variable.
 *
 * Whitespace-only counts as unset, the same rule `missingCredentialEnvVars`,
 * `requireEnv` and `rotating-file-sink.ts`'s `nonEmpty` already apply — a
 * quoted-empty value in an `--env-file` must mean "not configured", not
 * "configured as garbage".
 *
 * Throws rather than falling back to the default, and that direction is
 * deliberate: an operator who typed a pacing value meant to change the pacing,
 * and silently ignoring the typo would run the venue at a rate nobody chose
 * while the operator believes otherwise.
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
 * The pacing this deployment runs at: the checked-in defaults, with any
 * `SAMURAI_PACING_<VENUE>_*` override applied and validated.
 *
 * `env` is injected rather than read from `process.env` at module scope so the
 * validation is testable without mutating the process, matching
 * `sharedStorePath`/`rotating-file-sink.ts`.
 */
export function resolveVenuePacing(env: NodeJS.ProcessEnv = process.env): VenuePacingConfig {
  const resolved = {} as VenuePacingConfig;

  for (const venue of VENUE_KEYS) {
    const names = venuePacingEnvVars(venue);
    const fallback = DEFAULT_VENUE_PACING[venue];
    resolved[venue] = {
      // A bucket whose capacity is under one token can never satisfy
      // `acquire()`'s `tokens >= 1` test, so every call parks forever. That is
      // a stopped trading system, not a slow one — refused rather than paced.
      capacity: readPositive(env, names.capacity, fallback.capacity, {
        min: 1,
        minLabel: 'at least 1 (a bucket under one token never releases a call)',
      }),
      refillPerSecond: readPositive(env, names.refillPerSecond, fallback.refillPerSecond, {
        min: Number.MIN_VALUE,
        minLabel: 'greater than 0 (a non-positive rate parks every call forever)',
        ceiling: resolveCeiling(env, venue, names.ceilingPerSecond),
        ceilingEnvVar: names.ceilingPerSecond,
      }),
      reserveForPriority: resolveReserve(env, names, fallback),
    };
  }

  return resolved;
}

/**
 * The tokens `acquireBackground()` may not spend (#391).
 *
 * Validated against the RESOLVED capacity rather than the default, because
 * the failure it prevents is silent and total: a reserve at or above capacity
 * means a background caller can never reach `1 + reserve` tokens on a bucket
 * that refills to `capacity`, so every market-data call parks forever and the
 * process looks like a quiet market rather than a stopped one. Same posture as
 * `capacity`'s own `min: 1` check — a configuration that cannot release a call
 * is refused at startup, not paced.
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
