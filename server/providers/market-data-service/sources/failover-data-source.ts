/**
 * Primary -> fallback failover at the `DataSource` port (#562), for the LIVE
 * orchestrator's bar reads.
 *
 * ## Why a second wrapper rather than reusing `withOhlcvFailover` directly
 *
 * `withOhlcvFailover` (./ohlcv-failover.ts) wraps a `BarFetcher` — the shape
 * the #512 warm-start backfill script composes, because that script talks to
 * vendor clients directly and never constructs a `DataSource`. The live
 * composition root (`server/apps/orchestrator/production.ts`) injects a
 * `DataSource` into `MarketDataServiceImpl`, so failover has to arrive as a
 * `DataSource`. This class is the adapter between the two: it holds a
 * primary `DataSource`, and delegates its `fetchBars` to the SAME
 * `withOhlcvFailover` the backfill uses, so there is exactly one
 * implementation of "try, alert, fall back" in the repo rather than two that
 * can drift.
 *
 * ## BARS ONLY — `fetchMark`/`fetchQuote` stay on the primary
 *
 * Both other port methods delegate straight to `primary` with no fallback,
 * and that is a decision rather than an omission. The fallback vendors named
 * by `docs/research/31-free-ohlcv-evidence.md` serve historical aggregates
 * and nothing else: Polygon's free tier has no quote endpoint at all and its
 * aggregates are delayed. A mark is what prices an open position, sizes the
 * next one and arms a stop — pricing those off a delayed, differently-
 * conventioned feed during a vendor stall is a worse failure than the read
 * failing loudly, because a loud failure is visible and a quietly-stale mark
 * is not. So: bars degrade to a second vendor, marks do not degrade at all.
 *
 * ## What counts as "the primary failed"
 *
 * Any THROW from `primary.fetchBars`, inherited unchanged from
 * `withOhlcvFailover`'s contract — including the underfetch errors
 * (`AlpacaDataUnderfetchError` after `AlpacaHttpDataClient`'s own
 * widen-and-retry, and `NormalizingDataSource`'s `InSessionUnderfetchError`).
 * Naming that explicitly because it has a real consequence: a mid-session
 * SHORT read, not just an outage, switches the vendor serving that
 * (instrument, timeframe) for that call, and Polygon reports up to ~8% less
 * volume than Alpaca on the same bar (polygon-bars-client.ts), which moves
 * `getADV()`'s denominator while a fallback-sourced bar sits in the window.
 * That is accepted deliberately: an underfetch that survived the primary's
 * own retry is a primary that cannot answer, and a second vendor's answer
 * with a known volume skew is worth more to a running book than no bars.
 * Every fallback bar is stamped with its own `source` (`bars.source`), so the
 * skew is detectable after the fact rather than anonymous.
 *
 * ## No re-derivation
 *
 * A bar served by the fallback is NOT replaced when the primary recovers —
 * explicitly decided in #562, not overlooked. `bars.source` makes a
 * fallback-sourced row detectable at any later time, so a re-derivation pass
 * is a separate, resumable job rather than something this wrapper must do
 * inline on a live tick; doing it inline would mean re-fetching history from
 * the vendor that just stalled, on the tick path, to fix a row that is
 * already usable.
 *
 * ## Circuit breaker on the primary (#824)
 *
 * Failing over is cheap ONCE and ruinous as a steady state. A stalled Alpaca
 * bar read is not a fast error: `AlpacaHttpDataClient` retries three times at
 * a 10s per-attempt timeout with backoff between, so ONE stalled read costs
 * ~30s of wall clock before the fallback is even attempted — and #562 exists
 * for a FOURTEEN-DAY UNATTENDED SOAK, where a stall lasts hours and every
 * instrument pays that on every tick. The tick loop's budget was never sized
 * for `universe.length x ~30s` per tick.
 *
 * So the primary sits behind a breaker: `FAILOVER_CIRCUIT_FAILURE_THRESHOLD`
 * consecutive primary failures OPEN it, and while open a bar read skips the
 * primary entirely and goes straight to the fallback. The skip is expressed
 * as a synthetic `PrimaryCircuitOpenError` thrown in place of the real call,
 * so `withOhlcvFailover` stays the single implementation of "try, alert, fall
 * back" — an open-circuit read still alerts (the throttle's failover rate
 * stays honest and an operator does not go quiet mid-stall) and still reports
 * a combined error if the fallback also fails.
 *
 * **This does not by itself make a sustained stall affordable.** It moves the
 * cost: an open circuit routes the whole universe onto a Polygon bucket sized
 * — `venue-pacing.ts` says so in its own margin derivation — for OCCASIONAL
 * use. #828 owns that steady-state budget. This breaker caps the PRIMARY-side
 * cost of BAR reads only: `fetchMark` has no fallback by design (see above)
 * and therefore no breaker, so a mark on an open position still pays the full
 * primary timeout every tick for as long as the stall lasts. That is the
 * deliberate trade — a mark must fail loudly rather than come from a delayed
 * feed — and it is not something this ticket makes cheaper.
 *
 * ### Keyed per LEG, not per instrument
 *
 * The failure being defended against is a vendor outage, which hits every
 * name at once. A per-instrument counter would need N ticks (45 minutes at
 * the 15-minute cadence) before the first instrument opened; a per-leg
 * counter opens inside the FIRST tick of a total stall on any universe of at
 * least `FAILOVER_CIRCUIT_FAILURE_THRESHOLD` names, and the rest of that
 * tick's reads skip the primary.
 *
 * "The rest of that tick" was exact when the tick loop walked the universe
 * one instrument at a time (`maxConcurrentInstruments: 1`). #1013 set paper
 * and live to an explicit `6` (`paper-profile.ts`); smoke and backtest still
 * run at 1, but now by explicit override rather than by the `?? 1` fallback
 * production.ts once relied on — `smoke-run.ts` sets it directly, and
 * `paperStartingProfile`'s `mode === 'backtest'` branch pins it back to 1 for
 * this same replay-determinism reason. At width 6, up to that many reads can
 * now snapshot a still-closed circuit before any of them has failed — the
 * skip starts a few reads later, never later than the following tick.
 *
 * The admission is deliberately taken ONCE per read rather than re-checked
 * mid-flight: a read already talking to the primary has paid the cost the
 * breaker exists to avoid, and cancelling it would gain nothing.
 *
 * Consecutive means consecutive across the leg, so ANY primary success
 * resets the count. That is deliberate rather than a hole: while the primary
 * is answering for other names it is not costing every read a timeout, and
 * opening the leg then would push healthy names onto a delayed vendor for no
 * saving. The accepted blind spot is the mirror of that: one instrument
 * failing persistently among healthy ones never opens the breaker and keeps
 * paying its own primary cost each tick — one read's worth, not the
 * universe's.
 *
 * ### It cannot stick open
 *
 * There is no operator in the loop for fourteen days, so recovery is by
 * cooldown expiry plus a half-open probe, never by intervention. After
 * `FAILOVER_CIRCUIT_COOLDOWN_MS` the next read is admitted to the primary as
 * a PROBE: it succeeds and the breaker closes, or it fails and the cooldown
 * restarts. Three separate things stop that wedging:
 *
 * - both probe outcomes clear the in-flight flag (success and failure are the
 *   only two ways `withOhlcvFailover`'s primary call settles);
 * - a probe that never settles at all is treated as STALE after one further
 *   cooldown, so a hung promise cannot hold the door shut forever;
 * - a clock that steps backwards reads as elapsed, not as "cooldown not yet
 *   over" — the one arithmetic that could otherwise pin a breaker open.
 */
import type { BarWindow, DataSource, Mark, Quote } from '../types.js';
import { type BarFetcher, type FailoverAlerter, withOhlcvFailover } from './ohlcv-failover.js';

/** One instrument's fallback: which leg it belongs to, what serves it, and what that vendor is called */
export interface DataSourceFallbackLeg {
  leg: 'equities' | 'crypto';
  /** Vendor name, as it appears in the alert and in `bars.source` (e.g. `'polygon'`). */
  name: string;
  fetchBars: BarFetcher;
}

export interface FailoverDataSourceConfig {
  primary: DataSource;
  /** Vendor name of `primary`, for the alert (e.g. `'alpaca'`). */
  primaryName: string;
  /**
   * The fallback for `instrument`, or `undefined` when that instrument has
   * none — in which case a primary failure propagates exactly as it did
   * before this wrapper existed.
   *
   * A per-instrument function rather than a per-asset-class map because the
   * legs genuinely differ in whether they HAVE a fallback: the equities leg
   * has Polygon; the crypto leg has no live fallback wired, crypto having
   * left Samurai's scope on 2026-08-16 (ADR-0015's amendment). Returning
   * `undefined` is the honest answer for an instrument nothing else can
   * serve, and is not the same as a silent pass-through default — the
   * composition root decides it explicitly.
   */
  fallbackFor: (instrument: string) => DataSourceFallbackLeg | undefined;
  /**
   * Raised BEFORE the fallback is attempted, so an operator learns about a
   * stall even when the fallback also fails. Guarded by `withOhlcvFailover`'s
   * own `safeAlert`: a throwing alerter can never mask the fallback's result.
   */
  alert: FailoverAlerter;
  /**
   * The clock the circuit breaker's cooldown is measured on (#824). Defaults
   * to wall time; the composition root passes the orchestrator's own `Clock`
   * so a soak, a simulated run and a test all age the cooldown on the same
   * clock the tick loop runs on.
   */
  now?: () => Date;
}

/**
 * How many CONSECUTIVE primary failures on a leg open its circuit (#824).
 *
 * Three, not one: a single failure is what the failover already handles well
 * and is not evidence of a stall — Alpaca returns transient 5xx, and
 * `AlpacaHttpDataClient` has already retried three times internally before
 * this ever sees a throw, so one throw here is genuinely "that read is dead",
 * not "the vendor is dead". Three consecutive reads failing across a leg is a
 * pattern, and on a universe of three or more names it is reached INSIDE the
 * first stalled tick, which is the case the ticket is about. Higher would
 * spend more of the tick's budget proving what three reads already showed.
 */
export const FAILOVER_CIRCUIT_FAILURE_THRESHOLD = 3;

/**
 * How long an open circuit skips the primary before admitting a half-open
 * probe (#824).
 *
 * Sized against the TICK CADENCE, not against a vendor SLA: five minutes is
 * strictly less than the 15-minute live cadence (ADR-0008), so every tick
 * admits exactly one probe. That single number carries both properties the
 * ticket asks for. Recovery: the first tick after Alpaca comes back probes
 * and closes — no operator, no restart, and never more than one tick late.
 * Cost: the residual per-tick primary cost of BAR reads during a sustained
 * stall is ONE stalled read (~30s: 3 attempts x 10s `DEFAULT_TIMEOUT_MS` plus
 * backoff) instead of one per instrument. Mark reads are outside this — they
 * have no fallback and no breaker, and keep paying the primary timeout. It also stays under a plausible tightening
 * of the cadence to 10 minutes without losing the once-per-tick property.
 */
export const FAILOVER_CIRCUIT_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Thrown IN PLACE OF a primary call that the breaker skipped, so the skip
 * travels the same path a real primary failure does — one alert, one
 * fallback attempt, one combined error if the fallback also fails. It is
 * never thrown out of `fetchBars` on its own: `withOhlcvFailover` always
 * catches it and either the fallback answers or it becomes the `cause` chain
 * of the combined error.
 */
class PrimaryCircuitOpenError extends Error {
  constructor(primaryName: string, consecutiveFailures: number) {
    super(
      `${primaryName} circuit is OPEN after ${consecutiveFailures} consecutive failures — the ` +
        `primary was SKIPPED for this read (#824) and the fallback is serving directly. It is ` +
        `re-probed automatically within ${FAILOVER_CIRCUIT_COOLDOWN_MS / 60_000} minutes; no ` +
        `operator action is needed to close it.`,
    );
    this.name = 'PrimaryCircuitOpenError';
  }
}

/** What the breaker says about the NEXT primary call */
type CircuitAdmission = 'closed' | 'probe' | 'open';

/**
 * One leg's breaker. In memory and restart-clean, the same posture
 * `DataFailoverAlertThrottle` takes: a process that just started has no
 * evidence about the previous one's reads.
 */
class PrimaryCircuitBreaker {
  #consecutiveFailures = 0;
  /** When the circuit opened (or last re-opened). `undefined` == closed. */
  #openedAt: number | undefined;
  /** When the outstanding half-open probe was admitted. `undefined` == none. */
  #probeStartedAt: number | undefined;

  get consecutiveFailures(): number {
    return this.#consecutiveFailures;
  }

  /**
   * Decides — and, for a probe, RESERVES — whether this read may touch the
   * primary. Reserving is what keeps a whole tick's worth of concurrent reads
   * from all probing at once and paying the very cost the breaker exists to
   * cap.
   */
  admit(at: number): CircuitAdmission {
    const openedAt = this.#openedAt;
    if (openedAt === undefined) return 'closed';

    // `hasElapsed` treats a NEGATIVE elapsed as expired: a clock that steps
    // backwards (an NTP correction, a simulated clock rewound between runs)
    // must not pin the circuit open for however long the step was
    if (!hasElapsed(at, openedAt, FAILOVER_CIRCUIT_COOLDOWN_MS)) return 'open';

    const probeStartedAt = this.#probeStartedAt;
    if (
      probeStartedAt !== undefined &&
      !hasElapsed(at, probeStartedAt, FAILOVER_CIRCUIT_COOLDOWN_MS)
    ) {
      // A probe is genuinely in flight — everyone else keeps skipping
      return 'open';
    }

    // Either no probe outstanding, or the outstanding one has been pending
    // for a whole further cooldown and is presumed hung. A promise that never
    // settles must not be able to hold the circuit open for the rest of a
    // fourteen-day soak
    this.#probeStartedAt = at;
    return 'probe';
  }

  /** A primary read answered: the circuit closes and the count resets */
  recordSuccess(): void {
    this.#consecutiveFailures = 0;
    this.#openedAt = undefined;
    this.#probeStartedAt = undefined;
  }

  /** A primary read threw. Opens at the threshold; re-arms the cooldown for a failed probe. */
  recordFailure(at: number): void {
    this.#probeStartedAt = undefined;
    this.#consecutiveFailures += 1;
    if (this.#consecutiveFailures >= FAILOVER_CIRCUIT_FAILURE_THRESHOLD) {
      this.#openedAt = at;
    }
  }
}

function hasElapsed(at: number, since: number, duration: number): boolean {
  const elapsed = at - since;
  return elapsed < 0 || elapsed >= duration;
}

export class FailoverDataSource implements DataSource {
  readonly #config: FailoverDataSourceConfig;
  /** One breaker per leg — see the module doc for why the key is the leg and not the instrument */
  readonly #breakers = new Map<string, PrimaryCircuitBreaker>();

  constructor(config: FailoverDataSourceConfig) {
    this.#config = config;
  }

  #now(): number {
    return (this.#config.now?.() ?? new Date()).getTime();
  }

  #breakerFor(leg: string): PrimaryCircuitBreaker {
    let breaker = this.#breakers.get(leg);
    if (breaker === undefined) {
      breaker = new PrimaryCircuitBreaker();
      this.#breakers.set(leg, breaker);
    }
    return breaker;
  }

  async fetchBars(instrument: string, window: BarWindow, asOf: Date) {
    const fallback = this.#config.fallbackFor(instrument);
    if (fallback === undefined) {
      // No fallback to route to, so there is nothing to break the circuit
      // TOWARDS: skipping the primary here would turn a slow read into a
      // guaranteed failure. The instrument keeps its pre-#562 behaviour
      // exactly
      return this.#config.primary.fetchBars(instrument, window, asOf);
    }

    const breaker = this.#breakerFor(fallback.leg);
    // Decided ONCE, before the fetch: `withOhlcvFailover` calls `primary`
    // exactly once, and reserving the probe at decision time is what stops a
    // tick's concurrent reads from probing in parallel
    const admission = breaker.admit(this.#now());

    const fetch = withOhlcvFailover({
      leg: fallback.leg,
      primary: async (symbol, barWindow, at) => {
        if (admission === 'open') {
          throw new PrimaryCircuitOpenError(this.#config.primaryName, breaker.consecutiveFailures);
        }
        try {
          const bars = await this.#config.primary.fetchBars(symbol, barWindow, at);
          breaker.recordSuccess();
          return bars;
        } catch (error) {
          breaker.recordFailure(this.#now());
          throw error;
        }
      },
      primaryName: this.#config.primaryName,
      fallback: fallback.fetchBars,
      fallbackName: fallback.name,
      alert: this.#config.alert,
    });

    return fetch(instrument, window, asOf);
  }

  /** Primary only — see the module doc: a mark must not come from a delayed fallback feed */
  async fetchMark(instrument: string, asOf: Date, mode: 'live' | 'backtest'): Promise<Mark> {
    return this.#config.primary.fetchMark(instrument, asOf, mode);
  }

  /**
   * Forwarded only when the primary implements it — `fetchQuote` is optional
   * on the port, and answering `null` is MDS's documented "no observable
   * spread", the same posture `AssetClassRoutingDataSource` takes. No
   * fallback here either: no fallback vendor quotes bid/ask.
   */
  async fetchQuote(instrument: string, asOf: Date): Promise<Quote | null> {
    const primary = this.#config.primary;
    if (primary.fetchQuote === undefined) return null;
    return primary.fetchQuote(instrument, asOf);
  }
}
