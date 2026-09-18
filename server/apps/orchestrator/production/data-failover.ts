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

const EQUITIES_PRIMARY_VENDOR = 'alpaca';
const EQUITIES_FALLBACK_VENDOR = 'polygon';

export interface DataFailoverAlert extends FailoverEvent {
  reported_at: Date;
  suppressed_since_last: number;
}

export interface DataFailoverAlertChannel {
  postDataFailoverAlert(alert: DataFailoverAlert): Promise<void>;
}

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

function guardFallbackPacing(pacing: TokenBucketConfig, logger: Logger): TokenBucketConfig {
  const reserve = pacing.reserveForPriority ?? 0;
  const wedges =
    pacing.refillPerSecond <= 0 ||
    !Number.isFinite(pacing.refillPerSecond) ||
    pacing.capacity < 1 ||
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

export const ALERT_REPEAT_EVERY_FAILOVERS = 8;

const FAILOVER_CADENCE = { after: 1, every: ALERT_REPEAT_EVERY_FAILOVERS };

export const FAILOVER_INCIDENT_GAP_MS = 60 * 60 * 1000;

export class DataFailoverAlertThrottle {
  readonly #state = new Map<string, { count: number; lastAt: number; suppressed: number }>();

  decide(event: FailoverEvent, now: Date): { alert: boolean; suppressedSinceLast: number } {
    const key = `${event.symbol}|${event.timeframe}`;
    const at = now.getTime();
    const previous = this.#state.get(key);

    if (previous === undefined || at - previous.lastAt > FAILOVER_INCIDENT_GAP_MS) {
      this.#state.set(key, { count: 1, lastAt: at, suppressed: 0 });
      return { alert: true, suppressedSinceLast: previous?.suppressed ?? 0 };
    }

    const count = previous.count + 1;
    const alert = escalatesAt(count, FAILOVER_CADENCE);
    this.#state.set(key, { count, lastAt: at, suppressed: alert ? 0 : previous.suppressed + 1 });
    return { alert, suppressedSinceLast: alert ? previous.suppressed : 0 };
  }
}

export interface LiveDataFailoverDeps {
  primary: DataSource;
  universe: readonly UniverseInstrument[];
  calendar: TradingCalendar;
  equitiesFallbackBarFetcher?: BarFetcher | undefined;
  fallbackPacing?: TokenBucketConfig | undefined;
  alertChannel: DataFailoverAlertChannel;
  logger: Logger;
  now: () => Date;
}

export function buildFailoverDataSource(deps: LiveDataFailoverDeps): DataSource {
  const equities = new Set(
    deps.universe.filter((i) => i.asset_class === 'stocks').map((i) => i.asset),
  );

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
