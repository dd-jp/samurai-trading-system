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
 *   - `5m`, lookback `WARMUP_5M` (260) — #742 moved the technical analyst's
 *     `SMA_SPEC`/`RSI_SPEC` from `1h` to `5m` (RSI's own `recommendedWarmupFor`
 *     window is 57 5m bars; `WARMUP_5M` is the shared, wider pre-warm those
 *     specs collapse onto, imported directly rather than re-derived so this
 *     list cannot drift from the constant that actually governs the fetch).
 *     Leaving this timeframe out would not fabricate anything — a cold
 *     `computeIndicator` call still throws `InsufficientBarsError` below its
 *     15-bar floor rather than answering short — but it would make the warm
 *     start inert for the path that matters most: a first live/paper tick
 *     would fall through to a live `DataSource.fetchBars` call instead of
 *     reading the pre-filled store, defeating this script's whole purpose for
 *     the very analyst it was written to serve.
 *   - `1h`, lookback 57 — retained for what #742 left on `1h`: the technical
 *     analyst's own context-candle read (`CONTEXT_TIMEFRAME`, `key_points`
 *     prose only, never direction/confidence), the trader's ATR stop window
 *     and the volatility-breaker's ATR reading — #742 deliberately did not
 *     move `TraderConfig.atr_timeframe` or `DEFAULT_VOLATILITY_INDICATOR`, so
 *     both still read `1h`. Both of those used to ask for only 15 (the
 *     arity floor); #757 moved them onto `recommendedWarmupFor` too (57,
 *     `docs/reviews/indicator-characterisation-2026-08-16.md` F1), so this
 *     line is no longer "wider than any remaining `1h` consumer needs" — it
 *     is now exactly what the widest `1h` consumer asks for. The context
 *     read still only needs 20; kept at 57 rather than trimmed, since
 *     over-covering a lookback is free and under-covering silently degrades
 *     a real analyst input.
 *   - `1d`, lookback 30 — the Risk Manager's pairwise-correlation window,
 *     the only `1d` consumer that fires on a real (non-`SimulatedAdapter`)
 *     paper run. It dominates the simulated cost model's `adv_window`
 *     (`1d`/20, inert on the wired paper adapter), so backfilling `1d`/30
 *     covers both regardless of which adapter a future profile wires.
 *
 * If any of those specs changes, `WARM_START_WINDOWS` needs re-deriving —
 * the full symbol-by-symbol derivation, with file:line citations, is in the
 * #512 PR body (and, for the `5m` line, the #742 PR body) rather than pinned
 * here as line numbers that would rot on the next edit to any of those files
 * (see `docs/coding-standards.md` "Comments state invariants, not
 * changelogs").
 *
 * ## Equities source, and failover (#496)
 *
 * Equities (`DEFAULT_UNIVERSE`) source from `AlpacaHttpDataClient` — the
 * same real client the production composition root constructs — paced
 * through `resolveVenuePacing().alpaca` / `TokenBucket.acquireBackground()`,
 * exactly as the live path already does.
 *
 * The equities leg is wrapped in `withOhlcvFailover` (`./ohlcv-failover.ts`):
 * Alpaca -> `PolygonBarsClient` (`./polygon-bars-client.ts`, `adjusted=false`
 * to match Alpaca's raw convention), named in ADR-0001 / #487 as a fallback
 * that must never become the backfill SOURCE OF FIRST RESORT — satisfied
 * here by trying the primary first on every call and only invoking the
 * fallback when the primary THROWS (see `./ohlcv-failover.ts`'s doc for
 * exactly what counts as a "failure"). This is the increment-only role
 * #487/#496's research describes: `WARM_START_WINDOWS` asks for days of
 * history, not years, which is what keeps Polygon's free-tier 2-year window
 * from ever being the binding constraint here.
 *
 * A fallback bar is stamped `source: 'polygon'` (`PolygonBarsClient`'s own
 * `Bar.source`) and persisted into `bars.source` by
 * `SqliteMarketDataStore.appendBars` exactly like every other bar — the
 * column has existed since `0001_init.sql`, so no migration was needed to
 * add provenance. `backfillMarketData`'s `CoverageRow.source` (below)
 * surfaces which source served each pair in the printed table itself, and
 * `CoverageRow.quarantined` (#791 AC2) flags a pair whose window contains a
 * `QUARANTINED_BAR_SOURCES` bar (`'polygon'` — see that constant's doc for
 * why); a failover additionally posts to the SAME `dataFailoverAlerts`
 * transport the live orchestrator uses, via `buildBackfillFailoverAlerter`
 * (#791 AC1) passed to `withOhlcvFailover` in `runFromEnvironment` below —
 * this used to be a bare `console.error` `FAILOVER:` line, which reached a
 * stream nobody watches unattended.
 *
 * **The residual gap this doc used to record is CLOSED for equities
 * (#562).** It read: this failover covers only this script's fetch path,
 * and the live orchestrator sources both legs from Alpaca alone with no
 * fallback. The live equities leg now fails over Alpaca -> Polygon through
 * `FailoverDataSource`, built by
 * `server/apps/orchestrator/production/data-failover.ts` and injected at
 * `production.ts`'s `config.dataSource` seam, alerting on the live
 * `SAMURAI_ALERTS` transport — the same one this script now uses instead of
 * its own stdout (#791). What remains true: the live path fails over BARS
 * only (never marks or quotes).
 *
 * **Crypto backfill removed (#1157).** This script backfilled a Coinbase
 * (primary) -> Bitstamp (fallback) crypto leg until #1157: crypto left
 * Samurai's scope 2026-08-16 (ADR-0015's amendment) and `DEFAULT_UNIVERSE`
 * has carried no crypto instrument since #738, so that leg had no caller
 * left — its only reachers were its own two clients' tests, the repo's named
 * dominant defect class. `backfillMarketData` below now refuses any
 * `asset_class: 'crypto'` row outright (a SHORT coverage row, not a silent
 * misroute onto equities data) instead of keeping the fetch path alive.
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

import { LoggingDataFailoverAlertChannel } from '../apps/orchestrator/console-channels.js';
import {
  buildAlertChannels,
  DEFAULT_UNIVERSE,
  JsonLogger,
  resolveAlertsMode,
  type UniverseInstrument,
} from '../apps/orchestrator/index.js';
import type {
  DataFailoverAlert,
  DataFailoverAlertChannel,
} from '../apps/orchestrator/production/data-failover.js';
import type { Logger } from '../apps/orchestrator/types.js';
import { WARMUP_5M } from '../pipeline/analysts/technical-analyst.js';
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

/** See the module doc "The derived timeframe list" above for the citation trail. */
export const WARM_START_WINDOWS: readonly BarWindow[] = [
  { timeframe: '5m', lookback: WARMUP_5M },
  { timeframe: '1h', lookback: 57 },
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
   * `'alpaca'`/`'polygon'` (equities-only — crypto left Samurai's scope,
   * ADR-0015's amendment), or a fixture/test source. Read
   * off the store's own rows rather than tracked separately, so it can never
   * disagree with what `bars.source` actually holds. `undefined` only when
   * the pair has no bars at all — never fabricated. This is what lets an
   * operator see a failover in the printed coverage table itself, not only
   * in a stderr alert line that scrolled past.
   */
  source: string | undefined;
  /**
   * True when ANY bar in this pair's returned window carries a quarantined
   * `Bar.source` (#791 AC2, implementing David's #612 disposition) — checked
   * across every row `deps.store.readBars` returned for the pair, not just
   * the most recent one (a mixed window with an alpaca bar last must not
   * slip through by only sampling `rows.at(-1)`). Quarantined bars are still
   * durably written — `PolygonBarsClient` stays in the failover chain, #612
   * declined dropping it, and a warm-started tick still needs the rows — but
   * this flag is what stops them being silently used as a clean SOURCE OF
   * RECORD for a threshold or measurement that reaches an ADR (Massive
   * Businesses ToS §6.1(j) forbids using "the Information" to build an
   * "investment strategy"). `runFromEnvironment` below refuses to exit 0
   * when any row is quarantined, precisely so an automated caller — not only
   * a human reading the printed table — cannot miss it.
   */
  quarantined: boolean;
}

/**
 * `Bar.source` values that must never be treated as a clean source of
 * record (#791/#612). Polygon-only, deliberately: `stage2-source.ts`'s own
 * direct `HttpPolygonClient` use is a separate, already-settled decision
 * (#612 (2)) this constant does not touch, and the crypto leg this backfill
 * once ran (Coinbase primary / Bitstamp fallback) was removed entirely by
 * #1157 rather than quarantined.
 */
export const QUARANTINED_BAR_SOURCES: ReadonlySet<string> = new Set(['polygon']);

export interface BackfillMarketDataDeps {
  store: MarketDataStore;
  /** Defaults to `DEFAULT_UNIVERSE`; overridable for testing. */
  universe?: readonly UniverseInstrument[];
  /** Defaults to `WARM_START_WINDOWS`; overridable for testing. */
  windows?: readonly BarWindow[];
  asOf: Date;
  fetchEquityBars: (symbol: string, window: BarWindow, asOf: Date) => Promise<Bar[]>;
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
        // A thrown fetch (a rate-limit hiccup, a genuinely sparse window)
        // must not abort the whole run — every OTHER pair, and every pair
        // already fetched this run, has already durably persisted its bars
        // via `appendBars` above, so aborting here would throw that progress
        // away from the OPERATOR's view even though the store itself kept
        // it. Caught here, turned into a SHORT row instead (AC: "so a short
        // backfill is visible rather than silent") — never rethrown, so this
        // catch cannot itself throw out of the loop. A crypto instrument
        // hits the same path: #1157 removed the crypto fetch leg entirely,
        // so refusing here (a SHORT row) is deliberate — the alternative,
        // falling through to `fetchEquityBars`, would silently price a
        // crypto symbol off an equities venue.
        try {
          if (instrument.asset_class === 'crypto') {
            throw new Error(
              "backfillMarketData: crypto backfill is not supported — crypto left Samurai's " +
                "scope 2026-08-16 (ADR-0015's amendment) and #1157 removed this script's " +
                'Coinbase/Bitstamp fetch leg',
            );
          }
          const fetched = await deps.fetchEquityBars(instrument.asset, window, deps.asOf);
          deps.store.appendBars(fetched);
          rows = deps.store.readBars(
            instrument.asset,
            window.timeframe,
            deps.asOf,
            window.lookback,
          );
        } catch (error) {
          fetchError = describeThrownSafely(error);
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
        quarantined: rows.some((bar) => QUARANTINED_BAR_SOURCES.has(bar.source)),
      };
      coverage.push(row);

      print(
        `  ${row.instrument.padEnd(8)} ${row.timeframe.padEnd(3)} ` +
          `${String(row.rows).padStart(3)}/${row.required} bars` +
          (row.first_bar && row.last_bar ? `  (${row.first_bar} .. ${row.last_bar})` : '  (none)') +
          (row.source !== undefined ? `  source=${row.source}` : '') +
          (row.satisfied ? '' : '  SHORT') +
          (row.quarantined ? '  QUARANTINED' : '') +
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
 * Builds the `FailoverAlerter` `withOhlcvFailover` calls on the equities leg
 * (#791 AC1). Reaches the SAME `dataFailoverAlerts` transport the live orchestrator
 * uses (#818/`alert-transport.ts`) instead of `console.error` — a backfill
 * run unattended or from cron used to report a failover to a stream nobody
 * reads.
 *
 * `FailoverAlerter` is synchronous by design (`(event) => void`) —
 * `withOhlcvFailover` calls it BEFORE attempting the fallback, so an
 * operator learns of a stall even when the fallback also fails, and that
 * ordering is preserved here for free: this function does not change WHEN
 * the alert fires, only WHERE it goes. `postDataFailoverAlert` is async
 * (it posts to Telegram), so the post is fire-and-forget with a logged
 * `.catch` — the same bridge `buildFailoverDataSource`
 * (`orchestrator/production/data-failover.ts`) uses for the live path.
 * Awaiting it here would block a bar fetch on a Telegram round trip, and a
 * failed POST must not turn "the fallback served the bars" into "the fetch
 * threw" — `withOhlcvFailover`'s own `safeAlert` guards a THROWING alerter,
 * not a REJECTING promise it kicked off and forgot, so the `.catch` below is
 * load-bearing: without it a rejected post would become an unhandled
 * rejection, which is strictly worse than the `console.error` this replaces
 * (#791 AC1's "making the alert louder must not make the backfill more
 * fragile").
 *
 * No throttle, unlike the live path's `DataFailoverAlertThrottle`: this is a
 * one-shot CLI run over `WARM_START_WINDOWS` (three windows) x
 * `DEFAULT_UNIVERSE` (20 instruments today), not a 14-day tick loop —
 * the alert volume a sustained live stall would produce never arises here,
 * so `suppressed_since_last` is always `0`.
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

  // Resolved BEFORE the store is opened, mirroring `startFromEnvironment`
  // (`orchestrator/index.ts`): a missing/unrecognised `SAMURAI_ALERTS` is a
  // startup failure this run should not leave a freshly-created SQLite file
  // behind for (#791 AC1 reuses the live path's compiler-enforced
  // `AlertChannelSlots` mechanism rather than inventing a parallel one, and
  // that mechanism has no silent default — see `alert-transport.ts`).
  const alertsMode = resolveAlertsMode({});

  const dbPath = sharedStorePath();
  const db = openSharedStore(dbPath);
  const store = new SqliteMarketDataStore(db);
  const asOf = new Date();

  // `buildAlertChannels` needs the store handle (its Telegram client
  // audit-logs inbound allowlist rejections through it), so this comes after
  // `openSharedStore` even though `alertsMode` was resolved before it.
  // `alertsMode` is never `undefined` here — this script injects nothing —
  // but the ternary mirrors `startFromEnvironment`'s own shape rather than
  // asserting it away.
  const channels =
    alertsMode === undefined ? {} : buildAlertChannels({ alertsMode, injected: {}, db, logger });
  // `log-only` mode returns no `dataFailoverAlerts` slot at all (see
  // `buildAlertChannels`'s doc) — default to the SAME log-only stand-in
  // `production.ts` defaults to for the live path (`production.ts:640`),
  // rather than inventing a second one, so both paths degrade identically.
  const dataFailoverAlertChannel: DataFailoverAlertChannel =
    channels.dataFailoverAlerts ?? new LoggingDataFailoverAlertChannel(logger);
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

  // #496 fallback, constructed LAZILY (on first actual use, memoized) rather
  // than up front. `PolygonBarsClient`'s constructor throws when
  // `POLYGON_API_KEY` is unset (same fail-fast posture `HttpPolygonClient`
  // already has) — constructing it eagerly here would make an UNSET Polygon
  // key break the whole backfill run even on a day Alpaca never stalls,
  // which would turn an optional fallback into a hard dependency nobody
  // asked for. Lazy construction means the key is only required at the
  // moment it is actually needed, and a missing key then surfaces as the
  // fallback's own failure inside `withOhlcvFailover`'s combined error
  // (still loud, just scoped to the pair that actually failed over) rather
  // than as a startup crash.
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

  // #791 AC2: fail loudly, not warn. A quarantined pair still has its bars
  // durably written (the next warm tick is still served — #612 declined
  // dropping Polygon from the failover chain), but this run must not exit 0
  // as if it were a clean run: a caller that greps for a non-zero exit code
  // — cron, a CI step, an operator's own habit — is exactly who else must
  // not miss a polygon-sourced fill, not only the human reading the
  // QUARANTINED rows above.
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
