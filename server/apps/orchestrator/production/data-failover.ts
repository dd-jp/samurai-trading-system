/**
 * The LIVE orchestrator's OHLCV failover wiring (#562) — the half #560 did
 * not cover.
 *
 * #560 wrapped the #512 warm-start backfill SCRIPT's fetchers in
 * `withOhlcvFailover` and said so; the live orchestrator kept a single
 * vendor for every bar it read, for a run that is meant to go fourteen days
 * unattended. This module is what `production.ts` calls to close that: it
 * builds the equities leg's fallback fetcher and hands
 * `FailoverDataSource` (providers/market-data-service) the per-instrument
 * lookup it routes on.
 *
 * ## Equities only — deliberately
 *
 * Only the equities leg (Alpaca -> Polygon) is wired. Crypto left Samurai's
 * scope on 2026-08-16 (ADR-0015's amendment; CLAUDE.md's "Live capital"
 * line), so the Coinbase/Bitstamp pairing the backfill script uses has no
 * live counterpart to wire here — and #562's own crypto criterion ("compare
 * Alpaca and Coinbase stamping and volume conventions before adding a third
 * crypto writer") is a prerequisite for work that is no longer this system's.
 * A crypto instrument therefore gets NO fallback and its primary error
 * propagates unchanged, which `FailoverDataSource` states as its contract
 * rather than reaching by accident.
 *
 * ## What the equities fallback actually serves (probed 2026-08-17, #562)
 *
 * Recorded in `docs/research/31-free-ohlcv-evidence.md` and repeated here
 * because it is the wiring's own risk surface:
 *
 * - Daily stamping AGREES in winter as well as summer — Alpaca and Polygon
 *   both anchor a `1Day` bar to ET midnight (05:00Z in EST, 04:00Z in EDT),
 *   so the `(instrument, timeframe, open_time)` key cannot take one trading
 *   day as two rows across the vendor boundary, and `getADV()` cannot
 *   double-count.
 * - Polygon's free tier DOES serve `1h` aggregates, which the live tick path
 *   runs on — a fallback that could not would have been inert where it
 *   matters most.
 * - Hourly SESSION COVERAGE AGREES. Both vendors return 16 `1h` bars per
 *   trading day over 08:00Z–23:00Z on the same window (SPY, 2026-08-10 ->
 *   2026-08-14, 80 bars each) — i.e. both include the extended-hours
 *   sessions, so a fallback-served `1h` window spans the same wall clock as
 *   a primary-served one and a fixed `lookback: N` does not silently change
 *   meaning across the vendor boundary. An earlier draft of this doc claimed
 *   Polygon carried extended hours where Alpaca did not; that was inferred
 *   from a one-sided probe and is FALSE — both were then measured.
 *
 * ## Alert volume — throttled, deliberately
 *
 * A stall is not one event; it is a condition that persists for as long as
 * the vendor is down, and every tick that reads bars while it lasts triggers
 * another failover. Unthrottled, a day-long Alpaca stall across a four-name
 * equities universe posts alerts into the escalation chat until the operator
 * mutes it — and #342's whole argument is that a muted escalation chat also
 * mutes the orphan verdict and the kill-line. So this follows the repo's
 * existing bounded-repeat convention (`ALERT_REPEAT_EVERY_NO_DATA`,
 * `ALERT_REPEAT_EVERY_DIAGNOSTICS`): loud on the FIRST failover of an
 * incident, then every `ALERT_REPEAT_EVERY_FAILOVERS`-th while it persists,
 * with the suppressed count carried on the next alert that does go out so
 * the operator still sees the true rate. A gap longer than
 * `FAILOVER_INCIDENT_GAP_MS` counts as a NEW incident and is loud again —
 * that is what makes a recovery-then-restall audible instead of being
 * swallowed by a counter that never resets.
 *
 * ## Pacing on the boot path — WARN AND DEFAULT, never refuse to boot
 *
 * #510/#512/#560 kept `SAMURAI_PACING_POLYGON_*` out of
 * `VENUE_KEYS`/`resolveVenuePacing` precisely so a typo in a backfill-only
 * variable could not fail live orchestrator startup mid-soak. Giving the
 * live path a Polygon fallback means the live path now reads that variable,
 * so that protection has to be re-established on purpose rather than lost as
 * a side effect. Two candidate postures, and the repo's default answer
 * elsewhere is the wrong one here:
 *
 * - **Refuse to boot on a malformed override** — what `SAMURAI_ALERTS`,
 *   `SAMURAI_MODE` and `dataSourceAssetClass` do. Those gate whether the
 *   system operates CORRECTLY: alerts that silently degrade, a live host
 *   reached from a paper mode, an asset class routed to the wrong API root.
 *   `SAMURAI_PACING_POLYGON_*` gates none of that. It gates how fast a
 *   DEGRADATION MITIGATION polls a vendor that is only touched when the
 *   primary has already failed. Refusing to boot for it inverts the risk
 *   this whole issue exists to reduce: a mistyped fallback-pacing variable
 *   would take the entire book offline, which is strictly worse than the
 *   stall the fallback exists to survive.
 * - **Resolve lazily, at first failover** — keeps boot clean, and detonates
 *   the malformed value at the exact moment the fallback is needed. That is
 *   the worst possible time to discover it.
 *
 * So: resolved AT BOOT (loud and early, in the startup log where an operator
 * checks their configuration) but never fatal — a malformed override is
 * logged at `warn`, naming the variable, and `DEFAULT_POLYGON_PACING` is used
 * instead. The system boots paced at a checked-in default that is known safe
 * for Polygon's free tier, which is what the operator would have got by not
 * setting the variable at all.
 *
 * The Polygon CLIENT stays lazily constructed for the same family of reason
 * `backfill-market-data.ts` gives: `PolygonBarsClient`'s constructor throws
 * when `POLYGON_API_KEY` is unset, and an unset key must not stop the
 * orchestrator booting on a day Alpaca never stalls. A missing key surfaces
 * as the fallback's own failure inside `withOhlcvFailover`'s combined error,
 * scoped to the one pair that failed over.
 */
import {
  type BarFetcher,
  type DataSource,
  type DataSourceFallbackLeg,
  FailoverDataSource,
  type FailoverEvent,
  PolygonBarsClient,
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
   * How many failovers for this instrument/timeframe were suppressed by the
   * throttle since the last alert that went out — 0 on the first alert of an
   * incident. Carried so a bounded-repeat alert still reports the true rate.
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
 * Per-(instrument, timeframe) alert throttle — in memory and restart-clean,
 * the same posture `TraderDiagnosticThrottle` and the MI coverage monitor
 * take: a process that just started has no evidence about the previous one's
 * ticks.
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
      return { alert: true, suppressedSinceLast: 0 };
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
   * The equities fallback fetcher. Injected for tests and for any caller
   * that wants a different vendor; defaults to a LAZILY constructed
   * `PolygonBarsClient` (see the module doc for why lazy).
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
  const fallbackBarFetcher: BarFetcher =
    deps.equitiesFallbackBarFetcher ??
    ((symbol, window, asOf) => {
      polygon ??= new PolygonBarsClient({ rateLimiter: new TokenBucket(pacing) });
      return polygon.getBars(symbol, window.timeframe, asOf, window.lookback);
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
