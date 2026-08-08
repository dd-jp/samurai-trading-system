/**
 * Warm-start backfill (#512) — `yarn backfill-market-data`.
 *
 * Fills `SqliteMarketDataStore` for every `DEFAULT_UNIVERSE` instrument,
 * at the timeframes a first orchestrator tick actually requests, BEFORE
 * `yarn orchestrator` starts. Run once before a soak; safe to re-run any
 * time (idempotent — see `backfillMarketData` below).
 *
 * ## Same database the orchestrator injects (#512 requirement 1)
 *
 * This script resolves its database exactly the way `startFromEnvironment`
 * does before handing `config.db` to the production composition root:
 * `sharedStorePath()` then `openSharedStore(dbPath)` — the same two
 * functions, not a parallel derivation of the filename, so both processes
 * always agree on the same `SAMURAI_MODE`-keyed file
 * (`data/samurai-{mode}.sqlite`). `resolveStoreMode` is left to throw on a
 * missing/invalid `SAMURAI_MODE` exactly as it does for the orchestrator;
 * this script does not add a second, backfill-only DB-path environment
 * variable. The exact call-site trail is in the #512 PR body.
 *
 * ## The derived timeframe list (#512 requirement 2)
 *
 * `WARM_START_WINDOWS` below is not chosen — it is the max, per timeframe,
 * over every production call site that requests bars/indicators for a
 * `DEFAULT_UNIVERSE` instrument on a live/paper first tick. As of this
 * writing that is:
 *
 *   - `1h`, lookback 20 — the deepest of the technical analyst's and
 *     sentiment analyst's context-candle windows (both 20), their SMA/RSI
 *     specs (14/15), the trader's ATR stop window (15), and the
 *     volatility-breaker's ATR reading (15). All five read `1h` bars.
 *   - `1d`, lookback 30 — the Risk Manager's pairwise-correlation window,
 *     the only `1d` consumer that fires on a real (non-`SimulatedAdapter`)
 *     paper run. It dominates the simulated cost model's `adv_window`
 *     (`1d`/20, inert on the wired paper adapter), so backfilling `1d`/30
 *     covers both regardless of which adapter a future profile wires.
 *
 * If any of those specs changes, `WARM_START_WINDOWS` needs re-deriving —
 * the full symbol-by-symbol derivation, with file:line citations, is in the
 * #512 PR body rather than pinned here as line numbers that would rot on
 * the next edit to any of those files (see `docs/coding-standards.md`
 * "Comments state invariants, not changelogs").
 *
 * ## Equities / crypto sources, and failover (#496)
 *
 * Equities (SPY/QQQ/AAPL/TSLA) source from `AlpacaHttpDataClient` — the
 * same real client the production composition root constructs — paced
 * through `resolveVenuePacing().alpaca` / `TokenBucket.acquireBackground()`,
 * exactly as the live path already does. Crypto (BTC-USD/ETH-USD) sources
 * from `CoinbaseCandlesClient` (`./coinbase-candles-client.ts`), the
 * ADR-0001 crypto PRIMARY, paced through `resolveCoinbasePacing()`.
 *
 * Both legs are wrapped in `withOhlcvFailover` (`./ohlcv-failover.ts`):
 * Alpaca -> `PolygonBarsClient` (`./polygon-bars-client.ts`, `adjusted=false`
 * to match Alpaca's raw convention) for equities, Coinbase ->
 * `BitstampCandlesClient` (`./bitstamp-candles-client.ts`) for crypto. Both
 * fallbacks are named in ADR-0001 / #487 as fallbacks that must never become
 * the backfill SOURCE OF FIRST RESORT — satisfied here by trying the primary
 * first on every call and only invoking the fallback when the primary
 * THROWS (see `./ohlcv-failover.ts`'s doc for exactly what counts as a
 * "failure"). This is the increment-only role #487/#496's research
 * describes: `WARM_START_WINDOWS` asks for days of history, not years, which
 * is what keeps Polygon's free-tier 2-year window from ever being the
 * binding constraint here.
 *
 * A fallback bar is stamped `source: 'polygon'`/`'bitstamp'` (both clients'
 * own `Bar.source`) and persisted into `bars.source` by
 * `SqliteMarketDataStore.appendBars` exactly like every other bar — the
 * column has existed since `0001_init.sql`, so no migration was needed to
 * add provenance. `backfillMarketData`'s `CoverageRow.source` (below) surfaces
 * which source served each pair in the printed table itself; a failover
 * additionally logs a `FAILOVER:` line via the alerter passed to
 * `withOhlcvFailover` in `runFromEnvironment` below.
 *
 * **Residual gap, stated rather than implied away:** this failover covers
 * ONLY this script's fetch path. The LIVE orchestrator
 * (`server/apps/orchestrator/production.ts` -> `buildAlpacaDataSource`,
 * `./production/defaults.ts`) sources BOTH legs from Alpaca alone — crypto
 * included, not Coinbase/ccxt — and has no fallback at all. An Alpaca stall
 * during a live tick is not mitigated by this change.
 *
 * ## Resumable and idempotent
 *
 * For each (instrument, window) pair, a fetch is skipped when the store
 * ALREADY holds >= `window.lookback` rows at or before `asOf` — so a
 * re-run after an interrupted fill only fetches what is still missing, and
 * a full re-run after success makes zero network calls.
 * `SqliteMarketDataStore.appendBars` is itself `INSERT OR IGNORE` on the
 * `(instrument, timeframe, open_time)` primary key, so even a re-fetched
 * overlapping window can never double-write a bar.
 */

import { DEFAULT_UNIVERSE, type UniverseInstrument } from '../apps/orchestrator/index.js';
import {
  AlpacaHttpDataClient,
  type Bar,
  type BarWindow,
  closeTimeOf,
  type MarketDataStore,
  SqliteMarketDataStore,
} from '../providers/market-data-service/index.js';
import { BitstampCandlesClient } from '../providers/market-data-service/sources/bitstamp-candles-client.js';
import { CoinbaseCandlesClient } from '../providers/market-data-service/sources/coinbase-candles-client.js';
import type { FailoverAlerter } from '../providers/market-data-service/sources/ohlcv-failover.js';
import { withOhlcvFailover } from '../providers/market-data-service/sources/ohlcv-failover.js';
import { PolygonBarsClient } from '../providers/market-data-service/sources/polygon-bars-client.js';
import {
  resolveBitstampPacing,
  resolveCoinbasePacing,
  resolvePolygonPacing,
  resolveVenuePacing,
  TokenBucket,
} from '../shared/index.js';
import { openSharedStore, sharedStorePath } from '../shared/store/index.js';

/** See the module doc "The derived timeframe list" above for the citation trail. */
export const WARM_START_WINDOWS: readonly BarWindow[] = [
  { timeframe: '1h', lookback: 20 },
  { timeframe: '1d', lookback: 30 },
];

export interface CoverageRow {
  instrument: string;
  timeframe: string;
  rows: number;
  required: number;
  first_bar: string | undefined;
  last_bar: string | undefined;
  satisfied: boolean;
  /** Set when the fetch for this pair threw — a thrown fetch is a SHORT row, not an aborted run. */
  error: string | undefined;
  /**
   * `Bar.source` of the most recently stored bar for this pair (#496) —
   * `'alpaca'`/`'polygon'` for equities, `'coinbase'`/`'bitstamp'` for
   * crypto, or a fixture/test source. Read off the store's own rows rather
   * than tracked separately, so it can never disagree with what
   * `bars.source` actually holds. `undefined` only when the pair has no
   * bars at all — never fabricated. This is what lets an operator see a
   * failover in the printed coverage table itself, not only in a stderr
   * alert line that scrolled past.
   */
  source: string | undefined;
}

export interface BackfillMarketDataDeps {
  store: MarketDataStore;
  /** Defaults to `DEFAULT_UNIVERSE`; overridable for testing. */
  universe?: readonly UniverseInstrument[];
  /** Defaults to `WARM_START_WINDOWS`; overridable for testing. */
  windows?: readonly BarWindow[];
  asOf: Date;
  fetchEquityBars: (symbol: string, window: BarWindow, asOf: Date) => Promise<Bar[]>;
  fetchCryptoBars: (symbol: string, window: BarWindow, asOf: Date) => Promise<Bar[]>;
  print?: (line: string) => void;
}

/**
 * Fills `deps.store` for every (instrument, window) pair, skipping any pair
 * the store already covers, then returns a per-pair coverage report (AC:
 * "reports per-instrument coverage — first bar, last bar, row count").
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

      let rows = existing;
      let fetchError: string | undefined;
      if (existing.length < window.lookback) {
        const fetch =
          instrument.asset_class === 'crypto' ? deps.fetchCryptoBars : deps.fetchEquityBars;
        // A thrown fetch (a rate-limit hiccup, a genuinely sparse window)
        // must not abort the whole run — every OTHER pair, and every pair
        // already fetched this run, has already durably persisted its bars
        // via `appendBars` above, so aborting here would throw that progress
        // away from the OPERATOR's view even though the store itself kept
        // it. Caught here, turned into a SHORT row instead (AC: "so a short
        // backfill is visible rather than silent") — never rethrown, so this
        // catch cannot itself throw out of the loop.
        try {
          const fetched = await fetch(instrument.asset, window, deps.asOf);
          deps.store.appendBars(fetched);
          rows = deps.store.readBars(
            instrument.asset,
            window.timeframe,
            deps.asOf,
            window.lookback,
          );
        } catch (error) {
          fetchError = error instanceof Error ? error.message : String(error);
          // Re-read rather than falling back to `existing`. `appendBars` is
          // `INSERT OR IGNORE` per bar, so a throw partway through leaves the
          // bars it already wrote durably in the store — reporting the
          // pre-fetch count would under-report real coverage and send the
          // operator back to re-fetch bars that are already there.
          //
          // Guarded, because this runs inside a catch: if the store read
          // ALSO fails, keep the pre-fetch rows and say so, rather than
          // throwing out of the handler and aborting every remaining pair —
          // which is the abort this catch exists to prevent.
          try {
            rows = deps.store.readBars(
              instrument.asset,
              window.timeframe,
              deps.asOf,
              window.lookback,
            );
          } catch (readError) {
            fetchError += ` (coverage may under-report: re-read failed: ${
              readError instanceof Error ? readError.message : String(readError)
            })`;
          }
        }
      }

      const row: CoverageRow = {
        instrument: instrument.asset,
        timeframe: window.timeframe,
        rows: rows.length,
        required: window.lookback,
        first_bar: rows[0]?.close_time.toISOString(),
        last_bar: rows.at(-1)?.close_time.toISOString(),
        satisfied: rows.length >= window.lookback,
        error: fetchError,
        source: rows.at(-1)?.source,
      };
      coverage.push(row);

      print(
        `  ${row.instrument.padEnd(8)} ${row.timeframe.padEnd(3)} ` +
          `${String(row.rows).padStart(3)}/${row.required} bars` +
          (row.first_bar && row.last_bar ? `  (${row.first_bar} .. ${row.last_bar})` : '  (none)') +
          (row.source !== undefined ? `  source=${row.source}` : '') +
          (row.satisfied ? '' : '  SHORT') +
          (row.error !== undefined ? `  (fetch failed: ${row.error})` : ''),
      );
    }
  }

  return coverage;
}

/** `AlpacaBar` (`t,o,h,l,c,v`, timestamped at open) -> `Bar`, matching `AlpacaDataSource.fetchRawCandles`'s mapping. */
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
 * Prints a `FAILOVER:` line naming the leg, symbol, timeframe, both source
 * names and the primary's own error — the operator-facing half of #496's
 * "alert on failover" requirement. `CoverageRow.source` (surfaced in the
 * printed table by `backfillMarketData` above) is the durable half: this
 * line can scroll past, the coverage table cannot.
 *
 * `console.error` itself can throw (a broken stdout pipe, `EPIPE`) —
 * `withOhlcvFailover`'s `safeAlert` already guards every call to this
 * function, so a crash here cannot mask the fallback's own result, but this
 * function does not additionally guard itself: one guard at the call site
 * is enough, and a second one here would just be dead code shadowing it.
 */
const alertFailover: FailoverAlerter = (event) => {
  console.error(
    `FAILOVER: ${event.leg} ${event.symbol} ${event.timeframe} — ${event.primaryName} failed ` +
      `(${event.primaryError}); using ${event.fallbackName}.`,
  );
};

export async function runFromEnvironment(): Promise<void> {
  const dbPath = sharedStorePath();
  const db = openSharedStore(dbPath);
  const store = new SqliteMarketDataStore(db);
  const asOf = new Date();

  const venuePacing = resolveVenuePacing();
  const alpacaBucket = new TokenBucket(venuePacing.alpaca);
  const coinbaseBucket = new TokenBucket(resolveCoinbasePacing());
  const polygonBucket = new TokenBucket(resolvePolygonPacing());
  const bitstampBucket = new TokenBucket(resolveBitstampPacing());

  const equityClient = new AlpacaHttpDataClient({
    assetClass: 'stocks',
    rateLimiter: alpacaBucket,
  });
  const cryptoClient = new CoinbaseCandlesClient({ rateLimiter: coinbaseBucket });

  // #496 fallbacks, constructed LAZILY (on first actual use, memoized) rather
  // than up front. `PolygonBarsClient`'s constructor throws when
  // `POLYGON_API_KEY` is unset (same fail-fast posture `HttpPolygonClient`
  // already has) — constructing it eagerly here would make an UNSET Polygon
  // key break the whole backfill run even on a day Alpaca never stalls,
  // which would turn an optional fallback into a hard dependency nobody
  // asked for. Lazy construction means the key is only required at the
  // moment it is actually needed, and a missing key then surfaces as the
  // fallback's own failure inside `withOhlcvFailover`'s combined error
  // (still loud, just scoped to the pair that actually failed over) rather
  // than as a startup crash. `BitstampCandlesClient` needs no key and could
  // be built eagerly, but is built the same lazy way for symmetry — there is
  // no cost to it either way.
  let polygonClient: PolygonBarsClient | undefined;
  const getPolygonClient = (): PolygonBarsClient => {
    polygonClient ??= new PolygonBarsClient({ rateLimiter: polygonBucket });
    return polygonClient;
  };
  let bitstampClient: BitstampCandlesClient | undefined;
  const getBitstampClient = (): BitstampCandlesClient => {
    bitstampClient ??= new BitstampCandlesClient({ rateLimiter: bitstampBucket });
    return bitstampClient;
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
      // Default `partial: 'error'` (NOT 'allow') — deliberately: 'allow'
      // skips `AlpacaHttpDataClient`'s own widen-and-retry (issue #292),
      // which exists precisely to rescue a first read that came back short
      // over too-narrow a window. Losing that here would trade a rescuable
      // short read for a guaranteed one. A genuinely unrescuable throw is
      // instead caught here by `withOhlcvFailover` (triggering the Polygon
      // fallback) and, if THAT also fails, by `backfillMarketData`'s own
      // per-pair try/catch, turned into a SHORT coverage row.
      const bars = await equityClient.getBars(symbol, window.timeframe, at, window.lookback);
      return bars.map((bar) => alpacaBarToBar(symbol, window.timeframe, bar));
    },
    fallback: (symbol, window, at) =>
      getPolygonClient().getBars(symbol, window.timeframe, at, window.lookback),
  });

  const fetchCryptoBars = withOhlcvFailover({
    leg: 'crypto',
    primaryName: 'coinbase',
    fallbackName: 'bitstamp',
    alert: alertFailover,
    primary: (symbol, window, at) =>
      cryptoClient.getBars(symbol, window.timeframe, at, window.lookback),
    fallback: (symbol, window, at) =>
      getBitstampClient().getBars(symbol, window.timeframe, at, window.lookback),
  });

  const coverage = await backfillMarketData({
    store,
    asOf,
    fetchEquityBars,
    fetchCryptoBars,
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
