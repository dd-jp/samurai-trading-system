/**
 * The LIVE orchestrator's OHLCV failover wiring (#562): builds the equities
 * leg's fallback fetcher and hands `FailoverDataSource`
 * (providers/market-data-service) the per-instrument lookup it routes on.
 * `production.ts` is the only caller.
 *
 * ## Equities only
 *
 * Only the equities leg (Alpaca -> Polygon) is wired. Crypto is out of
 * Samurai's scope (ADR-0015's 2026-08-16 amendment), so the Coinbase/Bitstamp
 * pairing the backfill script uses has no live counterpart. A crypto
 * instrument gets NO fallback and its primary error propagates unchanged —
 * `FailoverDataSource` states that as its contract rather than reaching it by
 * accident.
 *
 * ## What the equities fallback serves (probed 2026-08-17, #562)
 *
 * Recorded in `docs/research/31-free-ohlcv-evidence.md`; repeated here because
 * it is this wiring's own risk surface.
 *
 * - Daily stamping agrees, in winter as in summer: Alpaca and Polygon both
 *   anchor a `1Day` bar to ET midnight (05:00Z in EST, 04:00Z in EDT), so the
 *   `(instrument, timeframe, open_time)` key cannot take one trading day as
 *   two rows across the vendor boundary and `getADV()` cannot double-count.
 * - Polygon's free tier serves `1h` aggregates, which is the timeframe the
 *   live tick path runs on.
 * - Both vendors' RAW `1h` payloads carry the extended-hours sessions (16 bars
 *   per trading day over 08:00Z-23:00Z; SPY, 2026-08-10 -> 2026-08-14, 80 bars
 *   each). That is a claim about the WIRE, not about the `DataSource` port:
 *   the primary is a `NormalizingDataSource` and drops out-of-session candles
 *   before they leave it, so a raw fallback fetcher would put a different
 *   window behind the same `lookback`. `withSessionNormalization` closes that
 *   — see `session-normalized-fetcher.ts` for the invariant it holds.
 *
 * ## Alert volume — throttled
 *
 * A stall is a CONDITION, not an event: every tick that reads bars while it
 * lasts fails over again, and an unthrottled day-long stall floods the
 * escalation chat until the operator mutes it — which under #342 also mutes
 * the orphan verdict and the kill-line. So, per the repo's bounded-repeat
 * convention (`ALERT_REPEAT_EVERY_NO_DATA`, `ALERT_REPEAT_EVERY_DIAGNOSTICS`):
 * loud on the first failover of an incident, then every
 * `ALERT_REPEAT_EVERY_FAILOVERS`-th while it persists, with the suppressed
 * count carried onto the next alert that goes out so the operator sees the
 * true rate. A gap longer than `FAILOVER_INCIDENT_GAP_MS` is a NEW incident
 * and is loud again, which is what keeps a recovery-then-restall audible.
 *
 * ## Pacing on the boot path — warn and default, never refuse to boot
 *
 * `SAMURAI_PACING_POLYGON_*` is resolved AT BOOT, so an operator sees a
 * malformed override in the startup log rather than at first failover — but it
 * is never fatal: the variable is logged at `warn` and `DEFAULT_POLYGON_PACING`
 * applies. It paces a DEGRADATION MITIGATION touched only once the primary has
 * already failed, so refusing to boot for a typo in it would take the whole
 * book offline to avoid a stall the fallback exists to survive. That is the
 * opposite of `SAMURAI_ALERTS`/`SAMURAI_MODE`/`dataSourceAssetClass`, which do
 * refuse, and which gate whether the system operates correctly at all.
 * `venue-pacing.ts` keeps the variable out of `VENUE_KEYS` so this stays
 * possible.
 *
 * The Polygon CLIENT is constructed lazily: its constructor throws when
 * `POLYGON_API_KEY` is unset, and an unset key must not stop the orchestrator
 * booting on a day Alpaca never stalls. A missing key then surfaces inside
 * `withOhlcvFailover`'s combined error, scoped to the one pair that failed
 * over.
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
  DEFAULT_POLYGON_PACING,
  type Logger,
  resolvePolygonPacing,
  TokenBucket,
} from '../../../shared/index.js';
import type { UniverseInstrument } from '../types.js';

/** The vendor names this wiring can name in an alert; matches the `bars.source` values each client stamps. */
export const EQUITIES_PRIMARY_VENDOR = 'alpaca';
export const EQUITIES_FALLBACK_VENDOR = 'polygon';

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
 * module doc for why this one variable is not worth refusing a boot over.
 */
export function resolveFallbackPacing(logger: Logger, env: NodeJS.ProcessEnv = process.env) {
  try {
    return resolvePolygonPacing(env);
  } catch (error) {
    logger.log({
      trace_id: 'startup',
      stage: 'orchestrator',
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
 * Alert on the first failover of an incident, then every eighth while it
 * persists — the same bounded-repeat constant `ALERT_REPEAT_EVERY_NO_DATA`
 * (mi-coverage.ts) and `ALERT_REPEAT_EVERY_DIAGNOSTICS` (#698) use.
 */
export const ALERT_REPEAT_EVERY_FAILOVERS = 8;

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

  /** Records a failover and answers whether it should reach the channel. */
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
      // #10-#12 are never counted anywhere.
      return { alert: true, suppressedSinceLast: previous?.suppressed ?? 0 };
    }

    const count = previous.count + 1;
    const alert = (count - 1) % ALERT_REPEAT_EVERY_FAILOVERS === 0;
    this.#state.set(key, { count, lastAt: at, suppressed: alert ? 0 : previous.suppressed + 1 });
    return { alert, suppressedSinceLast: alert ? previous.suppressed : 0 };
  }
}

export interface LiveDataFailoverDeps {
  /** The single-vendor source `buildAlpacaDataSource` returns — what this wraps. */
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
   * The equities fallback fetcher, as the VENDOR serves it — raw, uncalendared.
   * Injected for tests and for any caller that wants a different vendor;
   * defaults to a LAZILY constructed `PolygonBarsClient` (see the module doc
   * for why lazy). Whatever it is, it is wrapped in
   * `withSessionNormalization` before `FailoverDataSource` sees it, so an
   * injected fetcher cannot opt out of the session invariant either.
   */
  equitiesFallbackBarFetcher?: BarFetcher | undefined;
  /** Raised on every failover. Guarded — a throwing channel cannot break a fetch. */
  alertChannel: DataFailoverAlertChannel;
  logger: Logger;
  now: () => Date;
}

/**
 * Wraps `deps.primary` so every EQUITIES instrument in the universe falls
 * back to Polygon when Alpaca throws, alerting on the live transport as it
 * does.
 *
 * The alert bridge is fire-and-forget with a logged `.catch`: the channel is
 * `async` (it posts to Telegram) while `FailoverAlerter` is synchronous by
 * design — awaiting an operator notification inside a bar fetch would put a
 * vendor round-trip on the tick path, and a failed POST must not turn "the
 * fallback served the bars" into "the tick threw". Same posture
 * `checkMiCoverage` documents for its own alert.
 */
export function buildFailoverDataSource(deps: LiveDataFailoverDeps): DataSource {
  const equities = new Set(
    deps.universe.filter((i) => i.asset_class === 'stocks').map((i) => i.asset),
  );

  const pacing = resolveFallbackPacing(deps.logger);
  let polygon: PolygonBarsClient | undefined;
  const rawFallbackBarFetcher: BarFetcher =
    deps.equitiesFallbackBarFetcher ??
    ((symbol, window, asOf) => {
      polygon ??= new PolygonBarsClient({ rateLimiter: new TokenBucket(pacing) });
      return polygon.getBars(symbol, window.timeframe, asOf, window.lookback);
    });

  // The session invariant, applied to whatever serves the fallback — see
  // `session-normalized-fetcher.ts`. Applied here rather than inside
  // `FailoverDataSource` because the calendar belongs to the composition
  // root: the primary's own calendar is private to `NormalizingDataSource`,
  // and the wrapper must use the SAME one rather than a second guess at it.
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
            trace_id: 'data-failover',
            stage: 'orchestrator',
            level: 'error',
            message:
              `OHLCV failover alert for ${event.symbol} ${event.timeframe} could not be ` +
              `delivered: ${error instanceof Error ? error.message : String(error)}. The ` +
              `failover itself proceeded — ${event.fallbackName} is serving these bars.`,
            payload: { instrument: event.symbol, timeframe: event.timeframe },
          });
        });
    },
  });
}
