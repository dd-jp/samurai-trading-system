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
 * ## Equities / crypto sources
 *
 * Equities (SPY/QQQ/AAPL/TSLA) source from `AlpacaHttpDataClient` — the
 * same real client the production composition root constructs — paced
 * through `resolveVenuePacing().alpaca` / `TokenBucket.acquireBackground()`,
 * exactly as the live path already does. Crypto (BTC-USD/ETH-USD) sources
 * from `CoinbaseCandlesClient` (`./coinbase-candles-client.ts`), the
 * ADR-0001 crypto PRIMARY, paced through `resolveCoinbasePacing()`. Polygon
 * (equities fallback) and Bitstamp (crypto fallback) are named in ADR-0001
 * as fallbacks that must never become the backfill source — satisfied here
 * by not calling either (see the PR body's "found but did not build"
 * section).
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
import {
  AlpacaHttpDataClient,
  type Bar,
  type BarWindow,
  closeTimeOf,
  type MarketDataStore,
  SqliteMarketDataStore,
} from '../market-data-service/index.js';
import { DEFAULT_UNIVERSE, type UniverseInstrument } from '../orchestrator/index.js';
import { resolveCoinbasePacing, resolveVenuePacing, TokenBucket } from '../shared/index.js';
import { openSharedStore, sharedStorePath } from '../shared/store/index.js';
import { CoinbaseCandlesClient } from './coinbase-candles-client.js';

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
      };
      coverage.push(row);

      print(
        `  ${row.instrument.padEnd(8)} ${row.timeframe.padEnd(3)} ` +
          `${String(row.rows).padStart(3)}/${row.required} bars` +
          (row.first_bar && row.last_bar ? `  (${row.first_bar} .. ${row.last_bar})` : '  (none)') +
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

async function runFromEnvironment(): Promise<void> {
  const dbPath = sharedStorePath();
  const db = openSharedStore(dbPath);
  const store = new SqliteMarketDataStore(db);
  const asOf = new Date();

  const venuePacing = resolveVenuePacing();
  const alpacaBucket = new TokenBucket(venuePacing.alpaca);
  const coinbaseBucket = new TokenBucket(resolveCoinbasePacing());

  const equityClient = new AlpacaHttpDataClient({
    assetClass: 'stocks',
    rateLimiter: alpacaBucket,
  });
  const cryptoClient = new CoinbaseCandlesClient({ rateLimiter: coinbaseBucket });

  console.log(`Warm-start backfill (#512) -> ${dbPath}`);
  console.log(`DEFAULT_UNIVERSE: ${DEFAULT_UNIVERSE.map((i) => i.asset).join(', ')}`);
  console.log(
    `Windows: ${WARM_START_WINDOWS.map((w) => `${w.timeframe}/${w.lookback}`).join(', ')}`,
  );

  const coverage = await backfillMarketData({
    store,
    asOf,
    fetchEquityBars: async (symbol, window, at) => {
      // Default `partial: 'error'` (NOT 'allow') — deliberately: 'allow'
      // skips `AlpacaHttpDataClient`'s own widen-and-retry (issue #292),
      // which exists precisely to rescue a first read that came back short
      // over too-narrow a window. Losing that here would trade a rescuable
      // short read for a guaranteed one. A genuinely unrescuable throw is
      // instead caught by `backfillMarketData`'s own per-pair try/catch and
      // turned into a SHORT coverage row — the same "don't abort the whole
      // run, don't lose the signal" contract `CoinbaseCandlesClient.getBars`
      // already gives its short reads, just enforced one layer up here since
      // the Alpaca client's own contract is "throw on a genuine underfetch".
      const bars = await equityClient.getBars(symbol, window.timeframe, at, window.lookback);
      return bars.map((bar) => alpacaBarToBar(symbol, window.timeframe, bar));
    },
    fetchCryptoBars: (symbol, window, at) =>
      cryptoClient.getBars(symbol, window.timeframe, at, window.lookback),
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
