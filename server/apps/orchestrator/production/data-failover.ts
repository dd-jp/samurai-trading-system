/**
 * The LIVE orchestrator's OHLCV failover wiring: builds the equities leg's
 * fallback fetcher and hands `FailoverDataSource` (providers/market-data-service)
 * the per-instrument lookup it routes on. `production.ts` is the only caller.
 *
 * Equities only: crypto is out of Samurai's scope, so a crypto instrument
 * gets no fallback and its primary error propagates unchanged —
 * `FailoverDataSource` states that as its contract. Alpaca and Polygon both
 * anchor a `1Day` bar to ET midnight in both EST and EDT, so the
 * `(instrument, timeframe, open_time)` dedup key can't double-count across
 * the vendor boundary.
 *
 * Both vendors' raw `1h` payloads carry extended-hours sessions that the
 * primary (a `NormalizingDataSource`) drops before storage; a raw fallback
 * fetcher would put a different window behind the same `lookback` if left
 * unnormalized, so `withSessionNormalization` aligns it — see
 * `session-normalized-fetcher.ts` for the invariant.
 *
 * Failover alerts are throttled (bounded-repeat, loud on the first failover
 * of an incident and every `ALERT_REPEAT_EVERY_FAILOVERS`-th after) because a
 * stall is a condition, not an event — every tick that reads bars while it
 * lasts fails over again, and an unthrottled stall floods the escalation
 * channel.
 *
 * Polygon pacing (`SAMURAI_PACING_POLYGON_*` / `deps.fallbackPacing`) is
 * warn-and-default rather than refuse-to-boot: it paces a degradation path
 * touched only once the primary has already failed, so a malformed value
 * must not take the whole book offline to avoid a stall the fallback exists
 * to survive. It is resolved only when the default Polygon fetcher is
 * actually selected — an injected fallback fetcher must never consult or
 * warn about a variable it won't use.
 *
 * The pacing bucket is shared across the whole tick, so a sustained stall
 * costs roughly `13s x (fallback bar reads in the tick)` of serialized wait
 * — bounded against the 15-minute cadence, not cheap.
 *
 * The Polygon client is constructed lazily because its constructor throws
 * when `POLYGON_API_KEY` is unset, and an unset key must not stop the
 * orchestrator booting on a day Alpaca never stalls.
 */
import {
  type BarFetcher,
  type DataSource,
  type DataSourceFallbackLeg,
  FailoverDataSource,
  type FailoverEvent,
  PolygonBarsClient,
  type TradingCalendar,
  withSessionNormalization,
} from '../../../providers/market-data-service/index.js';
import {
  currentTraceId,
  DEFAULT_POLYGON_PACING,
  describeThrownSafely,
  escalatesAt,
  type Logger,
  resolvePolygonPacing,
  TokenBucket,
  type TokenBucketConfig,
} from '../../../shared/index.js';
import type { UniverseInstrument } from '../types.js';

/** The vendor names this wiring can name in an alert; matches the `bars.source` values each client stamps */
const EQUITIES_PRIMARY_VENDOR = 'alpaca';
const EQUITIES_FALLBACK_VENDOR = 'polygon';

/**
 * One live failover event, as the operator escalation sees it. A widened
 * `FailoverEvent`: the wire event plus when it happened, so an alert that
 * arrives late still says when the stall was.
 */
export interface DataFailoverAlert extends FailoverEvent {
  reported_at: Date;
  /**
   * How many failovers for this instrument/timeframe the throttle suppressed
   * since the last alert that went out. Non-zero on the first alert of a NEW
   * incident when the PREVIOUS incident ended with suppressed failovers — its
   * tail is reported here rather than lost, so the count over a run is the
   * true failover rate rather than the alerted one.
   */
  suppressed_since_last: number;
}

/**
 * Where a live OHLCV failover is escalated. Declared beside its caller, the
 * same convention `MiCoverageAlertChannel` (mi-coverage.ts) and
 * `TraderDiagnosticAlertChannel` (trader-diagnostic-alert.ts) follow.
 */
export interface DataFailoverAlertChannel {
  postDataFailoverAlert(alert: DataFailoverAlert): Promise<void>;
}

/**
 * `resolvePolygonPacing()`, downgraded from throwing to warning — see the
 * module doc for why this one variable is not worth refusing a boot over
 */
export function resolveFallbackPacing(logger: Logger, env: NodeJS.ProcessEnv = process.env) {
  try {
    return resolvePolygonPacing(env);
  } catch (error) {
    logger.log({
      trace_id: 'startup',
      stage: 'orchestrator',
      event: 'polygon_pacing_malformed',
      level: 'warn',
      message:
        'SAMURAI_PACING_POLYGON_* is malformed and was IGNORED: ' +
        `${error instanceof Error ? error.message : String(error)} — falling back to the ` +
        'checked-in DEFAULT_POLYGON_PACING. This variable paces only the equities OHLCV ' +
        'FALLBACK (#562), which is touched only while Alpaca is failing, so a typo in it must ' +
        'not stop the orchestrator booting (#510/#512/#560 kept it off the boot path for this ' +
        'reason). Fix or unset the variable; the run continues at the default rate.',
      payload: { pacing: 'polygon', applied: 'default' },
    });
    return DEFAULT_POLYGON_PACING;
  }
}

/**
 * `deps.fallbackPacing` is a plain config field handed straight to
 * `new TokenBucket(...)`, so it bypasses `resolvePolygonPacing`'s own
 * validation. `refillPerSecond <= 0` or `capacity < 1` would make
 * `TokenBucket.take` park forever rather than pace, and `withOhlcvFailover`
 * puts no timeout around the fallback to catch that — an indefinite park
 * would be a silent halt, not a stall. Warn-and-default rather than throw,
 * same reasoning as `resolveFallbackPacing`.
 */
function guardFallbackPacing(pacing: TokenBucketConfig, logger: Logger): TokenBucketConfig {
  const reserve = pacing.reserveForPriority ?? 0;
  const wedges =
    pacing.refillPerSecond <= 0 ||
    !Number.isFinite(pacing.refillPerSecond) ||
    pacing.capacity < 1 ||
    // `PolygonBarsClient.getBars` takes the BACKGROUND lane, which asks
    // `TokenBucket.take(reserveForPriority)` for `1 + reserve` tokens; `refill`
    // clamps the balance to `capacity`, so a reserve that leaves no room for
    // the background caller's own token never admits it at ANY refill rate
    reserve + 1 > pacing.capacity;
  if (!wedges) return pacing;

  logger.log({
    trace_id: 'startup',
    stage: 'orchestrator',
    event: 'polygon_pacing_unusable',
    level: 'warn',
    message:
      `Polygon fallback pacing is unusable (capacity ${pacing.capacity}, refillPerSecond ` +
      `${pacing.refillPerSecond}, reserveForPriority ${reserve}) and was IGNORED — falling back ` +
      'to the checked-in DEFAULT_POLYGON_PACING. A non-positive refill rate, a capacity below ' +
      'one, or a priority reserve that leaves no room for the background lane the Polygon ' +
      'client uses, never mints the token TokenBucket.take waits for, so every equities OHLCV fallback read ' +
      'would have parked forever with no timeout above it (#828) — a silent halt rather than ' +
      'a stall. Fix the configured pacing; the run continues at the default rate.',
    payload: { pacing: 'polygon', applied: 'default' },
  });
  return DEFAULT_POLYGON_PACING;
}

/**
 * Alert on the first failover of an incident, then every eighth while it
 * persists — the same bounded-repeat convention `ALERT_REPEAT_EVERY_NO_DATA`
 * (mi-coverage.ts) uses
 */
export const ALERT_REPEAT_EVERY_FAILOVERS = 8;

/** No grace: the first failover of an incident is already worth a page */
const FAILOVER_CADENCE = { after: 1, every: ALERT_REPEAT_EVERY_FAILOVERS };

/**
 * Quiet time after which the next failover for the same instrument/timeframe
 * is a NEW incident, loud again. One hour is the live tick path's own bar
 * interval: a vendor that served every bar for an hour recovered, and its
 * next failure is news rather than a continuation.
 */
export const FAILOVER_INCIDENT_GAP_MS = 60 * 60 * 1000;

/**
 * Per-(instrument, timeframe) alert throttle. The key deliberately omits
 * `leg`: exactly one leg (equities) is live, so an instrument identifies its
 * leg. A future system that runs two legs at once must widen the key, or the
 * same ticker on both legs would share one counter.
 *
 * In memory and restart-clean, the same posture `TraderDiagnosticThrottle` and
 * the MI coverage monitor take: a process that just started has no evidence
 * about the previous one's ticks.
 */
export class DataFailoverAlertThrottle {
  readonly #state = new Map<string, { count: number; lastAt: number; suppressed: number }>();

  /** Records a failover and answers whether it should reach the channel */
  decide(event: FailoverEvent, now: Date): { alert: boolean; suppressedSinceLast: number } {
    const key = `${event.symbol}|${event.timeframe}`;
    const at = now.getTime();
    const previous = this.#state.get(key);

    if (previous === undefined || at - previous.lastAt > FAILOVER_INCIDENT_GAP_MS) {
      this.#state.set(key, { count: 1, lastAt: at, suppressed: 0 });
      // The previous incident's TAIL — the failovers between its last
      // bounded-repeat alert and the quiet gap — is reported here rather than
      // discarded. Dropping it makes the claimed "true rate" false by
      // construction: 12 failovers then an hour quiet alerts at #1 and #9, and
      // #10-#12 are never counted anywhere
      return { alert: true, suppressedSinceLast: previous?.suppressed ?? 0 };
    }

    const count = previous.count + 1;
    const alert = escalatesAt(count, FAILOVER_CADENCE);
    this.#state.set(key, { count, lastAt: at, suppressed: alert ? 0 : previous.suppressed + 1 });
    return { alert, suppressedSinceLast: alert ? previous.suppressed : 0 };
  }
}

export interface LiveDataFailoverDeps {
  /** The single-vendor source `buildAlpacaDataSource` returns — what this wraps */
  primary: DataSource;
  universe: readonly UniverseInstrument[];
  /**
   * The equities session calendar — THE SAME instance the primary was built
   * with (`buildAlpacaDataSource`'s `tradingCalendar`). The fallback's bars
   * are normalized against it so a bar reaching the store carries the same
   * session semantics whichever vendor served it; passing a different
   * calendar here reintroduces exactly the divergence this closes.
   */
  calendar: TradingCalendar;
  /**
   * The equities fallback fetcher, as the vendor serves it — raw,
   * uncalendared. Injected for tests and for any caller that wants a
   * different vendor; defaults to a lazily constructed `PolygonBarsClient`.
   * Always wrapped in `withSessionNormalization` before `FailoverDataSource`
   * sees it, so an injected fetcher cannot opt out of the session invariant.
   */
  equitiesFallbackBarFetcher?: BarFetcher | undefined;
  /**
   * The Polygon fallback's outbound pacing, passed through unresolved by the
   * composition root so a caller that supplies it skips the env read
   * entirely. Resolved from env only inside `buildFailoverDataSource`'s
   * default branch, and ignored when `equitiesFallbackBarFetcher` is
   * supplied — there is no vendor left for it to pace.
   */
  fallbackPacing?: TokenBucketConfig | undefined;
  /** Raised on every failover. Guarded — a throwing channel cannot break a fetch. */
  alertChannel: DataFailoverAlertChannel;
  logger: Logger;
  now: () => Date;
}

/**
 * Wraps `deps.primary` so every equities instrument in the universe falls
 * back to Polygon when Alpaca throws, alerting on the live transport as it
 * does.
 *
 * The alert bridge is fire-and-forget with a logged `.catch`: awaiting an
 * operator notification inside a bar fetch would put a vendor round-trip on
 * the tick path, and a failed POST must not turn "the fallback served the
 * bars" into "the tick threw".
 */
export function buildFailoverDataSource(deps: LiveDataFailoverDeps): DataSource {
  const equities = new Set(
    deps.universe.filter((i) => i.asset_class === 'stocks').map((i) => i.asset),
  );

  // Only resolve (and possibly warn about) Polygon pacing when the default
  // Polygon fetcher is actually selected — an injected fetcher must never
  // consult a variable it won't use. Built here rather than inside the
  // returned closure so it still resolves at boot, not on first failover
  let rawFallbackBarFetcher: BarFetcher;
  if (deps.equitiesFallbackBarFetcher !== undefined) {
    rawFallbackBarFetcher = deps.equitiesFallbackBarFetcher;
  } else {
    const pacing = guardFallbackPacing(
      deps.fallbackPacing ?? resolveFallbackPacing(deps.logger),
      deps.logger,
    );
    let polygon: PolygonBarsClient | undefined;
    rawFallbackBarFetcher = (symbol, window, asOf) => {
      polygon ??= new PolygonBarsClient({ rateLimiter: new TokenBucket(pacing) });
      return polygon.getBars(symbol, window.timeframe, asOf, window.lookback);
    };
  }

  // The session invariant, applied to whatever serves the fallback — see
  // `session-normalized-fetcher.ts`. Applied here rather than inside
  // `FailoverDataSource` because the calendar belongs to the composition
  // root: the primary's own calendar is private to `NormalizingDataSource`,
  // and the wrapper must use the SAME one rather than a second guess at it
  const fallbackBarFetcher = withSessionNormalization({
    fetch: rawFallbackBarFetcher,
    source: EQUITIES_FALLBACK_VENDOR,
    asset_class: 'stocks',
    calendar: deps.calendar,
  });

  const throttle = new DataFailoverAlertThrottle();

  const equitiesLeg: DataSourceFallbackLeg = {
    leg: 'equities',
    name: EQUITIES_FALLBACK_VENDOR,
    fetchBars: fallbackBarFetcher,
  };

  return new FailoverDataSource({
    primary: deps.primary,
    primaryName: EQUITIES_PRIMARY_VENDOR,
    // The orchestrator's own clock, not wall time: the circuit breaker's
    // cooldown must age on the same clock the tick loop runs on, or a
    // simulated run would hold a breaker open forever while ticks fly past
    now: deps.now,
    fallbackFor: (instrument) => (equities.has(instrument) ? equitiesLeg : undefined),
    alert: (event) => {
      const reportedAt = deps.now();
      const { alert, suppressedSinceLast } = throttle.decide(event, reportedAt);
      if (!alert) return;

      void deps.alertChannel
        .postDataFailoverAlert({
          ...event,
          reported_at: reportedAt,
          suppressed_since_last: suppressedSinceLast,
        })
        .catch((error: unknown) => {
          deps.logger.log({
            trace_id: currentTraceId() ?? 'data-failover',
            stage: 'orchestrator',
            event: 'ohlcv_failover_alert_send_failed',
            level: 'error',
            message:
              `OHLCV failover alert for ${event.symbol} ${event.timeframe} could not be ` +
              `delivered: ${describeThrownSafely(error)}. The ` +
              `failover itself proceeded — ${event.fallbackName} is serving these bars.`,
            payload: { instrument: event.symbol, timeframe: event.timeframe },
          });
        });
    },
  });
}
