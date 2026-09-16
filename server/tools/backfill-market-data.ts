/**
 * Warm-start backfill — `npm run backfill-market-data`.
 *
 * Fills `SqliteMarketDataStore` for every `DEFAULT_UNIVERSE` instrument, at
 * the timeframes a first orchestrator tick actually requests, before
 * `npm run orchestrator` starts. Idempotent — safe to re-run any time.
 *
 * Resolves its database the same way `startFromEnvironment` does
 * (`sharedStorePath()` then `openSharedStore(dbPath)`), not a parallel
 * derivation of the filename, so both processes always agree on the same
 * `SAMURAI_MODE`-keyed file.
 *
 * `WARM_START_WINDOWS` re-exports `FIRST_TICK_BAR_WINDOWS`
 * (`bar-prefetch.ts`) rather than maintaining a second copy — two
 * independently maintained lists of what a first tick needs drifted out of
 * sync before (#1543).
 *
 * Equities source from `AlpacaHttpDataClient`, wrapped in `withOhlcvFailover`
 * to `PolygonBarsClient` (`adjusted=false` to match Alpaca's raw
 * convention). Polygon is a fallback only (ADR-0001/#487), tried only when
 * the primary throws — `WARM_START_WINDOWS` asks for days of history, well
 * under Polygon's free-tier 2-year window.
 *
 * A fallback bar is stamped `source: 'polygon'` and flagged via
 * `CoverageRow.quarantined`: such bars are durably stored and usable for
 * warm-starting a tick, but must never be treated as a clean source of
 * record for a threshold or measurement that reaches an ADR (Massive
 * Businesses ToS §6.1(j) forbids using "the Information" to build an
 * "investment strategy"). A failover also posts to the same
 * `dataFailoverAlerts` transport the live orchestrator uses.
 *
 * The live equities leg fails over Alpaca -> Polygon independently, through
 * `FailoverDataSource` (`orchestrator/production/data-failover.ts`); it
 * fails over bars only, never marks or quotes.
 *
 * Crypto is refused, not fetched: crypto left Samurai's scope 2026-08-16
 * (ADR-0015's amendment), so any `asset_class: 'crypto'` row is always a
 * SHORT row.
 *
 * Resumable: a fetch is skipped when the store already holds
 * `>= window.lookback` rows at or before `asOf`, and
 * `SqliteMarketDataStore.appendBars` is `INSERT OR IGNORE` on
 * `(instrument, timeframe, open_time)`, so a re-fetched overlapping window
 * can never double-write a bar.
 */

import type { Logger } from '../apps/orchestrator/index.js';
import {
  buildAlertChannels,
  DEFAULT_UNIVERSE,
  JsonLogger,
  loggingAlertChannel,
  resolveAlertsMode,
  type UniverseInstrument,
} from '../apps/orchestrator/index.js';
import { FIRST_TICK_BAR_WINDOWS } from '../apps/orchestrator/production/bar-prefetch.js';
import type {
  DataFailoverAlert,
  DataFailoverAlertChannel,
} from '../apps/orchestrator/production/data-failover.js';
import {
  AlpacaHttpDataClient,
  type Bar,
  type BarWindow,
  closeTimeOf,
  type MarketDataStore,
  SqliteMarketDataStore,
} from '../providers/market-data-service/index.js';
import type { FailoverAlerter } from '../providers/market-data-service/sources/ohlcv-failover.js';
import { withOhlcvFailover } from '../providers/market-data-service/sources/ohlcv-failover.js';
import { PolygonBarsClient } from '../providers/market-data-service/sources/polygon-bars-client.js';
import {
  describeThrownSafely,
  resolvePolygonPacing,
  resolveVenuePacing,
  TokenBucket,
} from '../shared/index.js';
import { openSharedStore, sharedStorePath } from '../shared/store/index.js';

/**
 * Aliases `FIRST_TICK_BAR_WINDOWS` (`bar-prefetch.ts`) — the orchestrator's
 * boot-time prefetch and this hand-run backfill must not be able to
 * disagree about which windows a first tick needs (#1543)
 */
export const WARM_START_WINDOWS: readonly BarWindow[] = FIRST_TICK_BAR_WINDOWS;

export interface CoverageRow {
  instrument: string;
  timeframe: string;
  rows: number;
  required: number;
  first_bar: string | undefined;
  last_bar: string | undefined;
  satisfied: boolean;
  /** Set when the fetch for this pair threw — a thrown fetch is a SHORT row, not an aborted run */
  error: string | undefined;
  /**
   * `Bar.source` of the most recently stored bar for this pair. Read off
   * the store's own rows rather than tracked separately, so it can never
   * disagree with what `bars.source` actually holds.
   */
  source: string | undefined;
  /**
   * True when any bar in this pair's returned window carries a quarantined
   * `Bar.source` — checked across every returned row, not just the last, so
   * a mixed window can't slip through by sampling only `rows.at(-1)`.
   * Quarantined bars are still durably written (#612 declined dropping
   * Polygon from the failover chain), but must never be treated as a clean
   * source of record for a threshold or measurement that reaches an ADR.
   */
  quarantined: boolean;
}

/**
 * `Bar.source` values that must never be treated as a clean source of
 * record. Polygon-only — `stage2-source.ts`'s own direct `HttpPolygonClient`
 * use is a separate decision this constant does not touch.
 */
const QUARANTINED_BAR_SOURCES: ReadonlySet<string> = new Set(['polygon']);

export interface BackfillMarketDataDeps {
  store: MarketDataStore;
  /** Defaults to `DEFAULT_UNIVERSE`; overridable for testing */
  universe?: readonly UniverseInstrument[];
  /** Defaults to `WARM_START_WINDOWS`; overridable for testing */
  windows?: readonly BarWindow[];
  asOf: Date;
  fetchEquityBars: (symbol: string, window: BarWindow, asOf: Date) => Promise<Bar[]>;
  print?: (line: string) => void;
}

/**
 * Resolves `rows`/`fetchError` for one (instrument, window) pair. Split out
 * of `backfillMarketData` to keep that function's cyclomatic complexity
 * readable.
 */
async function resolvePairCoverage(
  deps: BackfillMarketDataDeps,
  instrument: UniverseInstrument,
  window: BarWindow,
  existing: Bar[],
  isCrypto: boolean,
): Promise<{ rows: Bar[]; fetchError: string | undefined }> {
  let rows = existing;
  let fetchError: string | undefined;

  // Checked before the "already warm" branch below — stale bars must never
  // satisfy a crypto row
  if (isCrypto) {
    fetchError =
      "backfillMarketData: crypto backfill is not supported — crypto left Samurai's " +
      "scope 2026-08-16 (ADR-0015's amendment) and #1157 removed this script's " +
      'Coinbase/Bitstamp fetch leg';
  } else if (existing.length < window.lookback) {
    // A thrown fetch must not abort the whole run — other pairs have
    // already durably persisted their bars via `appendBars`. Caught here
    // and turned into a SHORT row instead of rethrown
    try {
      const fetched = await deps.fetchEquityBars(instrument.asset, window, deps.asOf);
      deps.store.appendBars(fetched);
      rows = deps.store.readBars(instrument.asset, window.timeframe, deps.asOf, window.lookback);
    } catch (error) {
      fetchError = describeThrownSafely(error);
      // Re-read rather than falling back to `existing`: `appendBars` is
      // `INSERT OR IGNORE`, so a throw partway through still leaves the
      // bars it already wrote durably in the store
      //
      // Guarded: if the re-read also fails, keep the pre-fetch rows rather
      // than throwing out of the handler and aborting every remaining pair
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

/** Assembles the `CoverageRow` for one pair from its resolved `rows`/`fetchError` */
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

/** Formats one `CoverageRow` as the printed coverage-table line */
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

/**
 * Fills `deps.store` for every (instrument, window) pair, skipping any pair
 * the store already covers, then returns a per-pair coverage report
 */
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

/** `AlpacaBar` (`t,o,h,l,c,v`, timestamped at open) -> `Bar`, matching `AlpacaDataSource.fetchRawCandles`'s mapping */
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

/**
 * Builds the `FailoverAlerter` `withOhlcvFailover` calls on the equities
 * leg. Posts to the same `dataFailoverAlerts` transport the live
 * orchestrator uses, instead of `console.error`, so an unattended/cron
 * run's failover isn't silent.
 *
 * The post is fire-and-forget with a logged `.catch`: awaiting it would
 * block a bar fetch on a Telegram round trip, and a rejected post must not
 * become an unhandled rejection or turn "the fallback served the bars"
 * into "the fetch threw".
 *
 * No throttle, unlike the live path: this is a one-shot CLI run, not a
 * sustained tick loop, so `suppressed_since_last` is always `0`.
 */
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

  // Resolved before the store is opened, mirroring `startFromEnvironment`:
  // a missing/unrecognised `SAMURAI_ALERTS` should not leave a
  // freshly-created SQLite file behind
  const alertsMode = resolveAlertsMode({});

  const dbPath = sharedStorePath();
  const db = openSharedStore(dbPath);
  const store = new SqliteMarketDataStore(db);
  const asOf = new Date();

  // `buildAlertChannels` needs the store handle (its Telegram client
  // audit-logs inbound allowlist rejections through it), so this comes
  // after `openSharedStore` even though `alertsMode` was resolved before it
  // `alertsMode` is never `undefined` here, but the ternary mirrors
  // `startFromEnvironment`'s own shape rather than asserting it away
  const channels =
    alertsMode === undefined ? {} : buildAlertChannels({ alertsMode, injected: {}, db, logger });
  // `log-only` mode returns no `dataFailoverAlerts` slot — default to the
  // same log-only stand-in `production.ts` uses for the live path, so both
  // paths degrade identically
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

  // Constructed lazily (on first use, memoized): `PolygonBarsClient`'s
  // constructor throws when `POLYGON_API_KEY` is unset, and constructing it
  // eagerly would make an unset key break the whole run even on a day
  // Alpaca never stalls, turning an optional fallback into a hard
  // dependency
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
      // Default `partial: 'error'` (not 'allow') deliberately: 'allow'
      // would skip `AlpacaHttpDataClient`'s own widen-and-retry, trading a
      // rescuable short read for a guaranteed one. An unrescuable throw is
      // instead caught by `withOhlcvFailover` (triggering the Polygon
      // fallback) and, failing that, by the per-pair try/catch above
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

  const short = coverage.filter((row) => !row.satisfied);
  if (short.length > 0) {
    console.error(
      `Backfill incomplete: ${short.length} of ${coverage.length} (instrument, timeframe) ` +
        `pair(s) short of the derived minimum — see the SHORT rows above.`,
    );
    process.exitCode = 1;
    return;
  }

  // Fail loudly, not warn: a quarantined pair's bars are durably written
  // (#612 declined dropping Polygon from the failover chain), but this run
  // must not exit 0 as if clean — an automated caller (cron, CI) must not
  // miss a polygon-sourced fill
  const quarantined = coverage.filter((row) => row.quarantined);
  if (quarantined.length > 0) {
    console.error(
      `Backfill served ${quarantined.length} of ${coverage.length} (instrument, timeframe) ` +
        'pair(s) from the QUARANTINED Polygon fallback — see the QUARANTINED rows above. Those ' +
        'bars are durably stored and still usable for warm-starting a tick, but MUST NOT be ' +
        'treated as a clean source of record for any threshold or measurement that reaches an ' +
        'ADR (#791/#612 — Massive Businesses ToS §6.1(j) forbids using "the Information" to ' +
        'build an "investment strategy"). Re-run once Alpaca recovers before trusting this ' +
        "run's coverage for that purpose.",
    );
    process.exitCode = 1;
    return;
  }

  console.log('Backfill complete — store is warm for every DEFAULT_UNIVERSE instrument.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runFromEnvironment().catch((error: unknown) => {
    console.error(
      `Warm-start backfill failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
