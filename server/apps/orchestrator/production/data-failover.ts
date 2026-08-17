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
 * - ⚠️ Polygon's hourly series INCLUDES extended-hours bars (08:00Z–23:00Z)
 *   where Alpaca's does not, so a fallback-served `1h` window can carry
 *   pre/post-market bars a primary-served one would not. Detectable through
 *   `bars.source` and not corrected anywhere today.
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
      void deps.alertChannel
        .postDataFailoverAlert({ ...event, reported_at: deps.now() })
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
