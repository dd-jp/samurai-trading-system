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

/**
 * The three broker venues `BrokerAdapter` has implementations for.
 *
 * **Polygon is deliberately NOT one of these (#510, reversed after review on
 * PR #520).** An earlier version of this module added `'polygon'` here so
 * `HttpPolygonClient`'s free-tier pacing would go through the same
 * env-override/ceiling machinery every broker venue gets. That worked, but
 * `resolveVenuePacing()` validates every key in `VENUE_KEYS` in one pass —
 * which is the right fail-fast posture for `production.ts`, the LIVE
 * composition root, but means `production.ts` would now also validate
 * `SAMURAI_PACING_POLYGON_*` and build a bucket for a venue no live path
 * ever called AT THE TIME. A typo in a Stage-2-only env var would fail
 * orchestrator boot during the unattended soak (#238) — nobody watching,
 * dead before the first tick. #562 gave the live path a Polygon FALLBACK,
 * so a live path does now call `resolvePolygonPacing` — and the exclusion
 * below matters more rather than less for it: `data-failover.ts` calls that
 * separate entry point inside a try/catch and WARNS-AND-DEFAULTS on a
 * malformed override instead of refusing to boot, precisely so this
 * paragraph's failure mode stays impossible. See `resolvePolygonPacing` below:
 * same underlying parsing/validation (`resolveBucketPacing`), a separate entry
 * point that only ever reads `SAMURAI_PACING_POLYGON_*`, so neither direction
 * of the coupling exists — this module's own `resolveVenuePacing()` never
 * touches Polygon, and Polygon's resolution never touches Alpaca/ccxt/IBKR.
 */
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
 * Polygon's documented ceiling — VERIFIED, same evidence as every other
 * `VERIFIED` figure in this file, but kept OUT of
 * `VENUE_DOCUMENTED_CEILING_PER_SECOND` (see the `VenueKey` doc above for
 * why Polygon is not a `VenueKey` at all): "Free tier is both rate-limited
 * (5 calls/min — meaningfully slow for backfilling 6 symbols) and capped at
 * 2 years of history" — docs/research/32-vendor-api-reference.md
 * ("Rate limits and lookback (Free / Starter tier)"), and the provisioned
 * key IS on that tier (docs/reviews/codebase-review-2026-08-06.md, "Premise
 * correction: the Polygon subscription" — David dropped it to free
 * 2026-08-06). Exceeding it returns HTTP 429 and, per ADR-0001, Polygon is
 * a fallback source that must not trip its own limit on the first burst.
 */
export const POLYGON_DOCUMENTED_CEILING_PER_SECOND = 5 / 60;

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
   * **`capacity: 41` — BURST, and NO PUBLISHED ALPACA BURST LIMIT COULD BE
   * ESTABLISHED.** Alpaca's own support page states only "200 requests per
   * minute, per account" with no burst qualifier; secondary write-ups describe
   * that as a rolling 60-second window, but that is not Alpaca's wording and
   * is not relied on here. So, per this module's own honesty rule, the number
   * is DERIVED FROM OUR WORKLOAD — specifically from the worst moment, which
   * is a COLD START rather than steady state: `TokenBucket` begins full, and
   * on a fresh process the bar cache is empty, so all `DEFAULT_UNIVERSE`
   * instruments fetch bars at once (20) while `reconcile()` sweeps open
   * brackets with one `getOrder` each (up to 20), plus a `submitBracket` from
   * the first tick (1). 41. Pinned against the universe size by a test, so
   * widening the universe again cannot silently outgrow the burst — and that
   * test is exactly what caught the 3 -> 20 widening: the old `14` was derived
   * against a 6-instrument universe and would have throttled a cold start into
   * `withRetry` back-off rather than failing loudly.
   *
   * **`reserveForPriority: 20` — WORKLOAD-DERIVED.** The tokens market data may
   * not spend. One full fill-poll sweep of the 20-instrument universe is 20
   * `getOrder` calls, so this guarantees the order path can always complete a
   * sweep — and place a leg — without waiting behind a bar burst. Market data
   * is therefore capped at `capacity - reserve` = 21 back-to-back calls, which
   * still covers a cold-start bar sweep of all 20 with one to spare. That
   * margin is now thin by construction: it is the reason `capacity` is derived
   * from the universe rather than rounded up casually.
   *
   * **`refillPerSecond: 1.8` — LOWERED FROM 2.5 BY THE CAPACITY RAISE, not an
   * independent retune.** The 75%-of-ceiling budget above is a claim about
   * what this bucket can spend against a documented 200 req/min, and a token
   * bucket's worst first minute is `capacity + 60 x refillPerSecond`, not the
   * refill alone. At the old pair that was `14 + 150 = 164/min` (82%); holding
   * `refillPerSecond` at 2.5 while raising capacity to 41 would have made it
   * `191/min` — 96% of a ceiling this module deliberately stays a quarter clear
   * of, and the burst raise would have quietly eaten the sustained margin it
   * was never scoped to touch. `1.8/s` restores it: `41 + 108 = 149/min`, i.e.
   * ~75%, the same posture the original split states. Steady state is
   * unaffected — one `tickIntervalMs` (2 min) needs ~45 calls across both
   * consumers, ~0.4/s, far under 1.8. What genuinely slows is bulk historical
   * backfill (`yarn backfill-market-data`), by ~28%; that is an offline tool
   * and not a reason to spend live-path margin.
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
  alpaca: { capacity: 41, refillPerSecond: 1.8, reserveForPriority: 20 },
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

/**
 * Polygon's checked-in default — VERIFIED CEILING (5 calls/min, cited at
 * `POLYGON_DOCUMENTED_CEILING_PER_SECOND`), OPERATING RATE a deliberate
 * margin under it — not at it, the same posture `DEFAULT_VENUE_PACING`
 * takes for every venue. Kept OUT of `DEFAULT_VENUE_PACING` itself for the
 * same reason Polygon is not a `VenueKey` — see that type's doc.
 *
 * **`refillPerSecond: 1 / 13` — MIGRATED, NOT RE-DERIVED.** Ticket #510
 * replaces `HttpPolygonClient`'s own ungoverned `MIN_REQUEST_SPACING_MS =
 * 13_000` (added by the 2026-08-06 codebase review, item A1) with this
 * bucket; the 13s figure carries over unchanged rather than being
 * re-derived, so this PR does not also silently change the operating
 * rate that has been running since that review landed. 1/13 ≈ 0.0769/s =
 * 4.615/min, ~92% of the 5/min ceiling — a THINNER margin than Alpaca's
 * deliberate 75%, and honestly labelled as such rather than glossed over.
 * It is accepted rather than tightened here because the workload this
 * paces is nothing like Alpaca's: a continuous live trading loop cannot
 * absorb a margin slip, where Polygon is invoked by hand-run Stage 2
 * scripts (`run-stage2.ts` and friends) fetching a handful of symbols per
 * run, and — since #562 — by the live orchestrator's equities FALLBACK,
 * which is touched only while Alpaca is already failing. Neither is a
 * sustained load anywhere near steady-state that would actually test how
 * thin the margin is; if a live stall ever runs long enough to make the
 * fallback the steady-state source, this margin is the first thing to
 * re-derive. Widening it up front
 * is a legitimate follow-up, not this ticket's scope — #510 is about
 * making the existing rate governable (env override, ceiling check),
 * not re-tuning it. Polygon is still a FALLBACK source per ADR-0001 with
 * no paid tier to fail over to, which is exactly why exceeding the
 * ceiling — not just running close to it — must stay impossible; that is
 * what the ceiling check in `readPositive` enforces regardless of this
 * default.
 *
 * **`capacity: 1` — WORKLOAD-DERIVED, deliberately NO BURST.** Unlike
 * Alpaca, nothing in this client's workload benefits from a burst: Stage 2
 * ingestion fetches one symbol's whole date range per call (pagination
 * inside `fetchAggregates` already serializes via this same bucket), and
 * the MVP universe is ingested by a hand-run script, never a concurrent
 * sweep. A capacity above 1 would let the first few calls of a cold start
 * fire back-to-back and eat into the margin the refill rate above is
 * counting on. Single-consumer, so no `reserveForPriority` (#391 does not
 * apply here — see DEFAULT_VENUE_PACING.ibkr for the other 0-reserve
 * venue).
 */
export const DEFAULT_POLYGON_PACING: TokenBucketConfig = {
  capacity: 1,
  refillPerSecond: 1 / 13,
  reserveForPriority: 0,
};

/**
 * Coinbase Exchange public candles pacing (#512, warm-start backfill script
 * only — same posture as `DEFAULT_POLYGON_PACING`/`resolvePolygonPacing`
 * above and for the identical reason: the live composition root
 * (`production.ts`) never calls `resolveCoinbasePacing`, so a typo'd
 * `SAMURAI_PACING_COINBASE_*` cannot fail orchestrator boot during an
 * unattended soak. Kept OUT of `VENUE_KEYS`/`resolveVenuePacing` for that
 * reason, not because Coinbase is unpaced.
 *
 * No documented per-key ceiling exists to enforce — the endpoint is
 * unauthenticated (no key, no account; ADR-0001 "Appendix: Broker/Data —
 * historical OHLCV sourcing" names Coinbase Exchange public candles as the
 * crypto primary; `docs/research/31-free-ohlcv-evidence.md` "no
 * `RateLimit-*` headers are returned, so pace conservatively rather than
 * reading back a budget").
 * `capacity: 2, refillPerSecond: 1` (a burst of 2, then 1 req/s sustained)
 * is comfortably under the ~10 req/s the research measured as tolerated,
 * with headroom for the backfill script's own retries.
 */
export const DEFAULT_COINBASE_PACING: TokenBucketConfig = {
  capacity: 2,
  refillPerSecond: 1,
  reserveForPriority: 0,
};

/**
 * Bitstamp OHLC pacing (#496, warm-start backfill script's CRYPTO FALLBACK
 * only — same posture as `DEFAULT_COINBASE_PACING`/`resolveCoinbasePacing`
 * above and for the identical reason: the live composition root
 * (`production.ts`) never calls `resolveBitstampPacing`, so a typo'd
 * `SAMURAI_PACING_BITSTAMP_*` cannot fail orchestrator boot during an
 * unattended soak. Kept OUT of `VENUE_KEYS`/`resolveVenuePacing` for that
 * reason, not because Bitstamp is unpaced.
 *
 * No documented per-key ceiling exists to enforce — the endpoint is
 * unauthenticated (no key, no account; ADR-0001 /
 * `docs/research/31-free-ohlcv-evidence.md` names Bitstamp
 * `/api/v2/ohlc` as the crypto fallback and records no rate-limit headers
 * observed while probing it). `capacity: 2, refillPerSecond: 1` mirrors
 * `DEFAULT_COINBASE_PACING` exactly — same UNVERIFIED-but-conservative
 * posture, same shape of workload (a hand-run backfill script fetching a
 * handful of symbols, not a sustained loop), so there is no basis to pick a
 * different number rather than an honest label.
 */
export const DEFAULT_BITSTAMP_PACING: TokenBucketConfig = {
  capacity: 2,
  refillPerSecond: 1,
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
 * Resolves ONE bucket's config from env: the checked-in `fallback`, with
 * that bucket's own `SAMURAI_PACING_*` override applied and validated
 * against `documentedCeiling` (if any). This is the piece `resolveVenuePacing`
 * and `resolvePolygonPacing` both call — one implementation of the
 * parsing/validation rules, two entry points that read disjoint env-var
 * namespaces (review feedback on PR #520: extracted specifically so Polygon
 * could get its own resolution without a second, divergence-prone copy of
 * this logic).
 */
function resolveBucketPacing(
  env: NodeJS.ProcessEnv,
  names: ReturnType<typeof venuePacingEnvVars>,
  fallback: TokenBucketConfig,
  documentedCeiling: number | undefined,
): TokenBucketConfig {
  return {
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
      ceiling: resolveCeiling(env, documentedCeiling, names.ceilingPerSecond),
      ceilingEnvVar: names.ceilingPerSecond,
    }),
    reserveForPriority: resolveReserve(env, names, fallback),
  };
}

/**
 * The pacing this deployment runs at: the checked-in defaults, with any
 * `SAMURAI_PACING_<VENUE>_*` override applied and validated.
 *
 * `env` is injected rather than read from `process.env` at module scope so the
 * validation is testable without mutating the process, matching
 * `sharedStorePath`/`rotating-file-sink.ts`.
 *
 * Reads and validates `VENUE_KEYS` (`alpaca`/`ccxt`/`ibkr`) ONLY — Polygon is
 * deliberately excluded (see the `VenueKey` doc above) so the live
 * composition root that calls this never depends on a Stage-2-only env var.
 * `resolvePolygonPacing` is the parallel entry point for Polygon.
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
 * Polygon's own pacing resolution — reads and validates ONLY
 * `SAMURAI_PACING_POLYGON_*`, via the same `resolveBucketPacing` every
 * `VenueKey` uses, so a malformed override for Alpaca/ccxt/IBKR can never
 * affect a Polygon-only construction, and a malformed
 * `SAMURAI_PACING_POLYGON_*` can never affect `resolveVenuePacing()`.
 * See the `VenueKey` doc above for why this is a separate entry point
 * rather than one more key in `VENUE_KEYS`.
 *
 * **This function DOES have a live caller as of #562** — the previous
 * sentence claiming the live orchestrator never calls it is no longer true.
 * `orchestrator/production/data-failover.ts` calls it at boot for the
 * equities OHLCV fallback's bucket, and calls it inside a try/catch: a
 * malformed `SAMURAI_PACING_POLYGON_*` is logged at `warn` and
 * `DEFAULT_POLYGON_PACING` is used instead, so the boot-time refusal this
 * throw would otherwise cause cannot take a live run down over a variable
 * that paces a degradation mitigation.
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
 * Coinbase's own pacing resolution — reads and validates ONLY
 * `SAMURAI_PACING_COINBASE_*`, via the same `resolveBucketPacing` every
 * other venue uses, so a malformed override here can never affect
 * `resolveVenuePacing()` (which never calls this) and vice versa. See
 * `DEFAULT_COINBASE_PACING` for why this is a separate entry point rather
 * than one more `VENUE_KEYS` member — same reasoning as `resolvePolygonPacing`.
 * `documentedCeiling` is `undefined`: Coinbase publishes no per-key ceiling
 * to enforce against (there is no key).
 */
export function resolveCoinbasePacing(env: NodeJS.ProcessEnv = process.env): TokenBucketConfig {
  return resolveBucketPacing(
    env,
    venuePacingEnvVars('coinbase'),
    DEFAULT_COINBASE_PACING,
    undefined,
  );
}

/**
 * Bitstamp's own pacing resolution — reads and validates ONLY
 * `SAMURAI_PACING_BITSTAMP_*`, via the same `resolveBucketPacing` every
 * other venue uses, so a malformed override here can never affect
 * `resolveVenuePacing()` (which never calls this) and vice versa. See
 * `DEFAULT_BITSTAMP_PACING` for why this is a separate entry point rather
 * than one more `VENUE_KEYS` member — same reasoning as
 * `resolveCoinbasePacing`. `documentedCeiling` is `undefined`: Bitstamp
 * publishes no per-key ceiling to enforce against (there is no key).
 */
export function resolveBitstampPacing(env: NodeJS.ProcessEnv = process.env): TokenBucketConfig {
  return resolveBucketPacing(
    env,
    venuePacingEnvVars('bitstamp'),
    DEFAULT_BITSTAMP_PACING,
    undefined,
  );
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
