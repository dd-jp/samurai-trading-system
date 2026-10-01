import type {
  DataFailoverAlert,
  DataFailoverAlertChannel,
  Logger,
} from '../apps/orchestrator/index.js';
import {
  buildAlertChannels,
  DEFAULT_UNIVERSE,
  FIRST_TICK_BAR_WINDOWS,
  JsonLogger,
  loggingAlertChannel,
  resolveAlertsMode,
  type UniverseInstrument,
} from '../apps/orchestrator/index.js';
import type { FailoverAlerter } from '../providers/market-data-service/index.js';
import {
  AlpacaHttpDataClient,
  type Bar,
  type BarWindow,
  closeTimeOf,
  type MarketDataStore,
  PolygonBarsClient,
  SqliteMarketDataStore,
  withOhlcvFailover,
} from '../providers/market-data-service/index.js';
import {
  describeThrownSafely,
  resolvePolygonPacing,
  resolveVenuePacing,
  TokenBucket,
} from '../shared/index.js';
import { openSharedStore, sharedStorePath } from '../shared/store/index.js';

export const WARM_START_WINDOWS: readonly BarWindow[] = FIRST_TICK_BAR_WINDOWS;

export interface CoverageRow {
  instrument: string;
  timeframe: string;
  rows: number;
  required: number;
  first_bar: string | undefined;
  last_bar: string | undefined;
  satisfied: boolean;
  error: string | undefined;
  source: string | undefined;
  quarantined: boolean;
}

const QUARANTINED_BAR_SOURCES: ReadonlySet<string> = new Set(['polygon']);

export interface BackfillMarketDataDeps {
  store: MarketDataStore;
  universe?: readonly UniverseInstrument[];
  windows?: readonly BarWindow[];
  asOf: Date;
  fetchEquityBars: (symbol: string, window: BarWindow, asOf: Date) => Promise<Bar[]>;
  print?: (line: string) => void;
}

async function resolvePairCoverage(
  deps: BackfillMarketDataDeps,
  instrument: UniverseInstrument,
  window: BarWindow,
  existing: Bar[],
  isCrypto: boolean,
): Promise<{ rows: Bar[]; fetchError: string | undefined }> {
  let rows = existing;
  let fetchError: string | undefined;

  if (isCrypto) {
    fetchError =
      "backfillMarketData: crypto backfill is not supported — crypto left Samurai's " +
      "scope 2026-08-16 (ADR-0015's amendment) and #1157 removed this script's " +
      'Coinbase/Bitstamp fetch leg';
  } else if (existing.length < window.lookback) {
    try {
      const fetched = await deps.fetchEquityBars(instrument.asset, window, deps.asOf);
      deps.store.appendBars(fetched);
      rows = deps.store.readBars(instrument.asset, window.timeframe, deps.asOf, window.lookback);
    } catch (error) {
      fetchError = describeThrownSafely(error);
      try {
        rows = deps.store.readBars(instrument.asset, window.timeframe, deps.asOf, window.lookback);
      } catch (readError) {
        fetchError += ` (coverage may under-report: re-read failed: ${
          readError instanceof Error ? readError.message : String(readError)
        })`;
      }
    }
  }

  return { rows, fetchError };
}

function buildCoverageRow(
  instrument: UniverseInstrument,
  window: BarWindow,
  rows: Bar[],
  fetchError: string | undefined,
  isCrypto: boolean,
): CoverageRow {
  return {
    instrument: instrument.asset,
    timeframe: window.timeframe,
    rows: rows.length,
    required: window.lookback,
    first_bar: rows[0]?.close_time.toISOString(),
    last_bar: rows.at(-1)?.close_time.toISOString(),
    satisfied: !isCrypto && rows.length >= window.lookback,
    error: fetchError,
    source: rows.at(-1)?.source,
    quarantined: rows.some((bar) => QUARANTINED_BAR_SOURCES.has(bar.source)),
  };
}

function formatCoverageLine(row: CoverageRow): string {
  return (
    `  ${row.instrument.padEnd(8)} ${row.timeframe.padEnd(3)} ` +
    `${String(row.rows).padStart(3)}/${row.required} bars` +
    (row.first_bar && row.last_bar ? `  (${row.first_bar} .. ${row.last_bar})` : '  (none)') +
    (row.source !== undefined ? `  source=${row.source}` : '') +
    (row.satisfied ? '' : '  SHORT') +
    (row.quarantined ? '  QUARANTINED' : '') +
    (row.error !== undefined ? `  (fetch failed: ${row.error})` : '')
  );
}

export async function backfillMarketData(deps: BackfillMarketDataDeps): Promise<CoverageRow[]> {
  const universe = deps.universe ?? DEFAULT_UNIVERSE;
  const windows = deps.windows ?? WARM_START_WINDOWS;
  const print = deps.print ?? console.log;

  const coverage: CoverageRow[] = [];

  for (const instrument of universe) {
    for (const window of windows) {
      const existing = deps.store.readBars(
        instrument.asset,
        window.timeframe,
        deps.asOf,
        window.lookback,
      );

      const isCrypto = instrument.asset_class === 'crypto';
      const { rows, fetchError } = await resolvePairCoverage(
        deps,
        instrument,
        window,
        existing,
        isCrypto,
      );

      const row = buildCoverageRow(instrument, window, rows, fetchError, isCrypto);
      coverage.push(row);

      print(formatCoverageLine(row));
    }
  }

  return coverage;
}

function alpacaBarToBar(
  instrument: string,
  timeframe: string,
  raw: { t: string; o: number; h: number; l: number; c: number; v: number },
): Bar {
  const open_time = new Date(raw.t);
  return {
    instrument,
    timeframe,
    open_time,
    close_time: closeTimeOf(open_time, timeframe),
    open: raw.o,
    high: raw.h,
    low: raw.l,
    close: raw.c,
    volume: raw.v,
    source: 'alpaca',
  };
}

export function buildBackfillFailoverAlerter(deps: {
  alertChannel: DataFailoverAlertChannel;
  logger: Logger;
  now: () => Date;
}): FailoverAlerter {
  return (event) => {
    const alert: DataFailoverAlert = {
      ...event,
      reported_at: deps.now(),
      suppressed_since_last: 0,
    };
    void deps.alertChannel.postDataFailoverAlert(alert).catch((error: unknown) => {
      deps.logger.log({
        trace_id: 'backfill-market-data',
        stage: 'orchestrator',
        event: 'ohlcv_failover_alert_send_failed',
        level: 'error',
        message:
          `OHLCV failover alert for ${event.symbol} ${event.timeframe} could not be delivered: ` +
          `${describeThrownSafely(error)}. The failover itself ` +
          `proceeded — ${event.fallbackName} is serving these bars.`,
        payload: { instrument: event.symbol, timeframe: event.timeframe },
      });
    });
  };
}

export async function runFromEnvironment(): Promise<void> {
  const logger: Logger = new JsonLogger();

  const alertsMode = resolveAlertsMode({});

  const dbPath = sharedStorePath();
  const db = openSharedStore(dbPath);
  const store = new SqliteMarketDataStore(db);
  const asOf = new Date();

  const channels =
    alertsMode === undefined ? {} : buildAlertChannels({ alertsMode, injected: {}, db, logger });
  const dataFailoverAlertChannel: DataFailoverAlertChannel =
    channels.dataFailoverAlerts ?? loggingAlertChannel('dataFailoverAlerts', logger);
  const alertFailover = buildBackfillFailoverAlerter({
    alertChannel: dataFailoverAlertChannel,
    logger,
    now: () => new Date(),
  });

  const venuePacing = resolveVenuePacing();
  const alpacaBucket = new TokenBucket(venuePacing.alpaca);
  const polygonBucket = new TokenBucket(resolvePolygonPacing());

  const equityClient = new AlpacaHttpDataClient({
    assetClass: 'stocks',
    rateLimiter: alpacaBucket,
  });

  let polygonClient: PolygonBarsClient | undefined;
  const getPolygonClient = (): PolygonBarsClient => {
    polygonClient ??= new PolygonBarsClient({ rateLimiter: polygonBucket });
    return polygonClient;
  };

  console.log(`Warm-start backfill (#512, failover #496) -> ${dbPath}`);
  console.log(`DEFAULT_UNIVERSE: ${DEFAULT_UNIVERSE.map((i) => i.asset).join(', ')}`);
  console.log(
    `Windows: ${WARM_START_WINDOWS.map((w) => `${w.timeframe}/${w.lookback}`).join(', ')}`,
  );

  const fetchEquityBars = withOhlcvFailover({
    leg: 'equities',
    primaryName: 'alpaca',
    fallbackName: 'polygon',
    alert: alertFailover,
    primary: async (symbol, window, at) => {
      const bars = await equityClient.getBars(symbol, window.timeframe, at, window.lookback);
      return bars.map((bar) => alpacaBarToBar(symbol, window.timeframe, bar));
    },
    fallback: (symbol, window, at) =>
      getPolygonClient().getBars(symbol, window.timeframe, at, window.lookback),
  });

  const coverage = await backfillMarketData({
    store,
    asOf,
    fetchEquityBars,
  });

  if (!reportBackfillOutcome(coverage)) process.exitCode = 1;
}

export function reportBackfillOutcome(
  coverage: readonly CoverageRow[],
  out: Pick<Console, 'log' | 'error'> = console,
): boolean {
  const short = coverage.filter((row) => !row.satisfied);
  if (short.length > 0) {
    out.error(
      `Backfill incomplete: ${short.length} of ${coverage.length} (instrument, timeframe) ` +
        `pair(s) short of the derived minimum — see the SHORT rows above.`,
    );
    return false;
  }

  const quarantined = coverage.filter((row) => row.quarantined);
  if (quarantined.length > 0) {
    out.error(
      `Backfill served ${quarantined.length} of ${coverage.length} (instrument, timeframe) ` +
        'pair(s) from the QUARANTINED Polygon fallback — see the QUARANTINED rows above. Those ' +
        'bars are durably stored and still usable for warm-starting a tick, but MUST NOT be ' +
        'treated as a clean source of record for any threshold or measurement that reaches an ' +
        'ADR (#791/#612 — Massive Businesses ToS §6.1(j) forbids using "the Information" to ' +
        'build an "investment strategy"). Re-run once Alpaca recovers before trusting this ' +
        "run's coverage for that purpose.",
    );
    return false;
  }

  out.log('Backfill complete — store is warm for every DEFAULT_UNIVERSE instrument.');
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runFromEnvironment().catch((error: unknown) => {
    console.error(
      `Warm-start backfill failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
