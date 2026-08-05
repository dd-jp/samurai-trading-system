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
 *   is enforced (see `VENUE_DOCUMENTED_CEILING_PER_SECOND`); the operating
 *   rate stays conservative and is flagged as untuned.
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
   * CEILING VERIFIED (200 req/min = 3.33/s, cited above), OPERATING RATE
   * DERIVED — unchanged from the value `production.ts` already wired, now with
   * its arithmetic written down instead of assumed.
   *
   * `refillPerSecond: 1.5` is 45% of the documented account ceiling, not 100%,
   * and the missing 55% is not caution — it is the market-data client, which
   * shares the same per-account 200/min and is NOT paced by any bucket today
   * (see the module doc: the ceiling is per account, and #386 is adding a
   * bounded widen-and-retry on that unpaced path). Sizing the broker at the
   * ceiling would mean the first data-side retry burst earns the 429 for the
   * order path.
   *
   * `capacity: 10` is the burst a single trade actually needs back-to-back: a
   * bracket submit plus its fill poll, with headroom for a reconcile sweep
   * landing on the same instant. Sustained 1.5/s = 90/min.
   *
   * Alpaca's published figure does not distinguish paper from live, and the
   * paper host is the one the soak uses; nothing was found that documents a
   * separate paper allowance, so the same ceiling is applied to both.
   */
  alpaca: { capacity: 10, refillPerSecond: 1.5 },
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
  ccxt: { capacity: 1, refillPerSecond: 1 },
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
  ibkr: { capacity: 5, refillPerSecond: 5 },
};

/** The two environment variables that override one venue's bucket. */
export function venuePacingEnvVars(venue: VenueKey): {
  capacity: string;
  refillPerSecond: string;
} {
  const prefix = `SAMURAI_PACING_${venue.toUpperCase()}`;
  return { capacity: `${prefix}_CAPACITY`, refillPerSecond: `${prefix}_REFILL_PER_SEC` };
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
  constraints: { min: number; minLabel: string; ceiling?: number | undefined },
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
        'and, sustained, a banned API key. Raise it only against a documented allowance for ' +
        'this account, and update VENUE_DOCUMENTED_CEILING_PER_SECOND with the citation.',
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
        ceiling: VENUE_DOCUMENTED_CEILING_PER_SECOND[venue],
      }),
    };
  }

  return resolved;
}
