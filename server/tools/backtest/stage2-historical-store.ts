/**
 * Stage 2 historical OHLCV store (ticket #241) — see
 * docs/specs/stage2-validation-execution-spec.md ("Module: Historical Data
 * Ingestion") and wayfinder map #154 (decisions #155, #157).
 *
 * Ingests daily bars from Polygon/Massive for the MVP universe and persists
 * them to a research-only scratch SQLite file — deliberately NOT the shared
 * store's `bars` table, although that table exists (0001_init.sql) with the
 * same columns and key: the shared store is runtime state the Feedback Loop
 * and dashboard read live, and research ingests must not be able to corrupt
 * it or collide with the orchestrator's writes. (The original justification
 * here — "that table doesn't exist yet" — was never true; the split stands
 * on the isolation argument alone. Review 2026-08-06 A3.) A fresh
 * `Stage2HistoricalStore` over `:memory:` is also the fixture shape for tests.
 *
 * The Polygon HTTP client is injected (`PolygonClient`), matching
 * `AlpacaDataSource`'s precedent in market-data-service/sources —
 * provisioning the API key is an ops/setup task, not this module's concern.
 *
 * `membershipDuring` reports every ingested symbol as currently listed
 * (`delisted_at: undefined`): none of the fixed MVP-universe six
 * (SPY/QQQ/AAPL/TSLA/BTC-USD/ETH-USD) has been delisted, so there is no real
 * delisting data to source. The seam is real — `assertSurvivorshipFree` runs
 * against it — it simply has nothing to report for this universe.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import type { Bar } from '../../providers/market-data-service/index.js';
import { closeTimeOf, timeframeToMs } from '../../providers/market-data-service/index.js';
import { fromStoredTimestamp, toStoredTimestamp } from '../../shared/store/index.js';
import type { ReplayTimeline } from './types.js';
import type { DateRange, InstrumentListing, InstrumentRegistry } from './universe.js';

/** The timeframe every path used before #664 made it a parameter. */
export const DEFAULT_STAGE2_TIMEFRAME = '1d';

/** One Polygon aggregate, timestamped at the bar's open (epoch ms). */
export interface PolygonAggregate {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/** The transport seam — a real Polygon/Massive HTTP client, or a test fake. */
export interface PolygonClient {
  /**
   * Aggregates for `symbol` over `window` at `timeframe`, ascending by open
   * time.
   *
   * `timeframe` is REQUIRED, not defaulted to `'1d'` (#664). A defaulted
   * parameter is how this repo's dominant defect class — a mechanism nothing
   * calls with a non-default value — gets introduced: every implementation and
   * every fake would keep serving daily bars and typecheck. Required, the
   * compiler enumerates every call site instead.
   */
  fetchAggregates(
    symbol: string,
    window: DateRange,
    timeframe: string,
  ): Promise<PolygonAggregate[]>;
}

interface Stage2BarRow {
  instrument: string;
  timeframe: string;
  open_time: string;
  close_time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface Stage2ListingRow {
  symbol: string;
  delisted_at: string | null;
}

/**
 * What a symbol has already been ASKED for, and what actually came back.
 *
 * The two are tracked separately, and that separation is the point. Coverage
 * derived from stored bars alone (`MIN`/`MAX(open_time)`) cannot be satisfied
 * by a window whose end falls after the last bar the vendor has — which is
 * ALWAYS true in practice: `STAGE2_PINNED_WINDOW` ends at an intraday instant,
 * daily bars open at midnight, and equities print nothing at a weekend. Such a
 * store would see a permanent tail gap and re-request it on every run, so
 * "re-running is a no-op" would be false forever, just cheaper than before.
 */
export interface Stage2Coverage {
  /** The union of every window requested so far — contiguous by construction. */
  requestedFrom: Date;
  requestedTo: Date;
  /** `MIN`/`MAX(open_time)` of what the vendor actually served, if anything. */
  firstBar?: Date | undefined;
  lastBar?: Date | undefined;
}

/**
 * The parts of `window` not already requested — at most a head range and a
 * tail range, in that order. Empty means the whole window is already on disk
 * and no vendor call is needed.
 *
 * Split out as a pure function because it is the whole of #495's decision, and
 * every interesting case (nothing stored, fully covered, earlier start, later
 * end, both ends, a vendor that served less than was asked) is a boundary
 * condition worth testing without a database or a network in the way.
 *
 * Gaps stay contiguous with existing coverage — the head extends backwards
 * from `requestedFrom`, the tail forwards to `window.end` — so the union of
 * requested ranges is always a single interval and never needs a gap list.
 *
 * The tail starts at the LAST STORED BAR rather than at `requestedTo` when one
 * exists: that bar is the only one that could have been provisional, and
 * re-reading it costs one bar. See `ingest`.
 */
export function uncoveredRanges(
  window: DateRange,
  coverage: Stage2Coverage | undefined,
): DateRange[] {
  if (!coverage) return [window];

  const gaps: DateRange[] = [];
  if (window.start < coverage.requestedFrom) {
    gaps.push({ start: window.start, end: coverage.requestedFrom });
  }
  if (window.end > coverage.requestedTo) {
    const lastBar = coverage.lastBar;
    const start =
      lastBar !== undefined && lastBar < coverage.requestedTo ? lastBar : coverage.requestedTo;
    gaps.push({ start, end: window.end });
  }
  return gaps;
}

/**
 * SQLite creates the database FILE, never the directory holding it, and the
 * scratch path convention is `data/…` which is gitignored — so it is absent on
 * every fresh clone and better-sqlite3 throws an error naming neither the path
 * nor the fix. `openSharedStore` already learnt this (#323); this store opens
 * its own handle and has to learn it too. `recursive: true` is idempotent.
 */
function ensureParentDirectory(dbPath: string): void {
  if (dbPath === ':memory:') return;
  const directory = dirname(dbPath);
  if (directory === '.') return;
  mkdirSync(directory, { recursive: true });
}

/**
 * How a store is opened. An OPTIONS OBJECT rather than a second positional
 * string (#664): `dbPath` was already positional and `timeframe` is also a
 * string, so a positional addition would let the two be swapped silently at a
 * call site and still typecheck. Requiring the object also makes the compiler
 * enumerate every construction, which is the point — a store whose timeframe
 * defaulted to `'1d'` would be the exact "parameter nothing ever sets" defect
 * this ticket exists to avoid.
 */
export interface Stage2HistoricalStoreOptions {
  /** `'1d'`, `'1m'`, `'5m'`… — parsed by `timeframeToMs`, so garbage throws here. */
  timeframe: string;
  /** Scratch SQLite path. `':memory:'` is the test/fixture shape. */
  dbPath?: string;
}

export class Stage2HistoricalStore implements ReplayTimeline, InstrumentRegistry {
  private readonly db: BetterSqlite3.Database;
  /**
   * The ONE timeframe this store instance ingests, stores and serves.
   *
   * Every read below is scoped by it (#664 item 5). The table is shared across
   * timeframes — its PRIMARY KEY already carries `timeframe`, so a `'1m'` row
   * and a `'1d'` row for the same instrument and open time are distinct rows
   * and neither overwrites the other. What was missing was scoping on the READ
   * side: `bars`, `barTimestamps`, `barTimestampsFor` and the
   * "never ingested" diagnostic all ignored the column, so a file holding both
   * resolutions would have served their UNION to a replay — silently, as a
   * jagged series no assertion could catch.
   *
   * The alternative considered and rejected: a separate scratch FILE (or table)
   * per timeframe. It gets the same isolation, but splits the coverage
   * bookkeeping (`stage2_coverage` is already keyed by `(instrument,
   * timeframe)`, so one file holds both cleanly), makes a daily-vs-intraday
   * comparison a two-connection job, and buys nothing the composite index below
   * does not already buy. Existing daily scratch files keep working untouched
   * either way — their rows are already stamped `'1d'` — which is what makes
   * this a reversible choice rather than a migration.
   */
  readonly timeframe: string;

  constructor(
    private readonly client: PolygonClient,
    options: Stage2HistoricalStoreOptions,
  ) {
    // Parsed, not merely stored: `closeTimeOf` would throw later, mid-ingest,
    // after the network spend. `timeframeToMs` throws here on anything this
    // repo cannot key bars on.
    timeframeToMs(options.timeframe);
    this.timeframe = options.timeframe;
    const dbPath = options.dbPath ?? ':memory:';
    ensureParentDirectory(dbPath);
    this.db = new BetterSqlite3(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS stage2_bars (
        instrument TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        open_time TEXT NOT NULL,
        close_time TEXT NOT NULL,
        open REAL NOT NULL,
        high REAL NOT NULL,
        low REAL NOT NULL,
        close REAL NOT NULL,
        volume REAL NOT NULL,
        PRIMARY KEY (instrument, timeframe, open_time)
      );
      CREATE TABLE IF NOT EXISTS stage2_listing (
        symbol TEXT PRIMARY KEY,
        delisted_at TEXT
      );
      -- What has been ASKED of the vendor, which is not what came back (#495).
      -- A store that inferred coverage from bars alone could never call an
      -- intraday-ending window satisfied, because no daily bar opens at
      -- 18:17 — so it would re-request the tail on every run. See
      -- \`Stage2Coverage\`.
      --
      -- No migration: this schema is research scratch, private to this module
      -- and created on open, unlike the shared store's migration-managed one.
      -- An existing scratch file simply gains the table and, with no recorded
      -- request range, re-ingests once before becoming a no-op.
      CREATE TABLE IF NOT EXISTS stage2_coverage (
        instrument TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        requested_from TEXT NOT NULL,
        requested_to TEXT NOT NULL,
        PRIMARY KEY (instrument, timeframe)
      );
      -- #664. Every read here filters on (instrument, timeframe, close_time),
      -- and the PRIMARY KEY is on OPEN time, so none of them could use it:
      -- \`bars\` and both timeline queries were full table SCANs. Invisible at
      -- ~500 daily rows per symbol; a cliff at minute resolution, where one
      -- instrument-year is ~98k rows and ten years across four symbols is
      -- ~4M. \`EXPLAIN QUERY PLAN\` before/after is in the PR body.
      CREATE INDEX IF NOT EXISTS idx_stage2_bars_read
        ON stage2_bars (instrument, timeframe, close_time);
    `);
  }

  /**
   * What `symbol` already has on disk, or `undefined` if it has never been
   * ingested.
   *
   * BOTH ends of the requested range are read, not just the latest (#495
   * review point). A tail-only strategy is wrong the moment a run asks for an
   * EARLIER start than a previous one did: coverage would look satisfied, no
   * fetch would happen, and the caller would be served a window quietly
   * shorter than the one it asked for — the same silent-truncation class of
   * bug this ticket exists to remove, merely relocated from the vendor to the
   * cache.
   */
  #coverage(symbol: string): Stage2Coverage | undefined {
    const requested = this.db
      .prepare(
        `SELECT requested_from, requested_to FROM stage2_coverage
          WHERE instrument = ? AND timeframe = ?`,
      )
      .get(symbol, this.timeframe) as { requested_from: string; requested_to: string } | undefined;
    if (!requested) return undefined;

    const bars = this.db
      .prepare(
        `SELECT MIN(open_time) AS first, MAX(open_time) AS last
           FROM stage2_bars WHERE instrument = ? AND timeframe = ?`,
      )
      .get(symbol, this.timeframe) as { first: string | null; last: string | null } | undefined;

    return {
      requestedFrom: fromStoredTimestamp(requested.requested_from),
      requestedTo: fromStoredTimestamp(requested.requested_to),
      firstBar: bars?.first ? fromStoredTimestamp(bars.first) : undefined,
      lastBar: bars?.last ? fromStoredTimestamp(bars.last) : undefined,
    };
  }

  /**
   * Widens the recorded request range to include `window`. Recorded only after
   * the fetch resolves, so a vendor error leaves the range unchanged and the
   * next run retries the same gap instead of treating a failed call as cached.
   */
  #recordCoverage(symbol: string, window: DateRange, previous: Stage2Coverage | undefined): void {
    const from =
      previous && previous.requestedFrom < window.start ? previous.requestedFrom : window.start;
    const to = previous && previous.requestedTo > window.end ? previous.requestedTo : window.end;

    this.db
      .prepare(
        `INSERT INTO stage2_coverage (instrument, timeframe, requested_from, requested_to)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(instrument, timeframe) DO UPDATE SET
           requested_from = excluded.requested_from,
           requested_to = excluded.requested_to`,
      )
      .run(symbol, this.timeframe, toStoredTimestamp(from), toStoredTimestamp(to));
  }

  /**
   * Fetches the parts of `window` not already on disk and persists them.
   * Idempotent per `(instrument, timeframe, open_time)`, matching
   * `SqliteMarketDataStore.appendBars`'s re-ingest-is-a-no-op convention.
   *
   * **Before #495 this fetched the whole window every time.** The database was
   * consulted only on the WRITE (`INSERT OR IGNORE` dedups after the network
   * round-trip), so nothing was ever reused and every run re-pulled five
   * years. That made the free-data decision (#487) rest on a false premise:
   * a free, no-SLA source is only acceptable because history lives on disk and
   * a dead vendor costs new bars alone. It is also what makes an equities
   * fallback possible at all — Polygon's free tier 403s beyond two years
   * against a five-year window, so it can only ever serve the increment.
   *
   * Coverage is read first and only the uncovered head and tail are requested.
   * A window already requested at both ends issues NO call at all, so a repeat
   * run is a true no-op and a partial window tops up rather than restarting.
   *
   * The tail refetch starts at the LAST STORED BAR rather than at the previous
   * request boundary, because that bar is the only one that could have been
   * PROVISIONAL: a run whose window ended mid-session stored a partially
   * formed daily bar. `INSERT OR REPLACE` then corrects it. This costs one
   * re-read bar per top-up.
   *
   * Residual, stated so it is not rediscovered as a surprise: a repeat run
   * with an UNCHANGED window fetches nothing, so it does not revisit a bar
   * that was provisional when first stored. Correcting that would cost a
   * request per symbol on every re-run and contradict this ticket's own
   * "re-running must stay a no-op". It does not arise on the path that
   * matters — `STAGE2_PINNED_WINDOW` ends at a fixed PAST instant, so no run
   * of it can store a forming bar — and any run that does advance its window
   * picks up the correction on the next call.
   */
  async ingest(symbol: string, window: DateRange): Promise<void> {
    const coverage = this.#coverage(symbol);
    for (const gap of uncoveredRanges(window, coverage)) {
      this.#persist(symbol, await this.client.fetchAggregates(symbol, gap, this.timeframe));
    }
    this.#recordCoverage(symbol, window, coverage);

    this.db
      .prepare(
        `INSERT INTO stage2_listing (symbol, delisted_at) VALUES (?, NULL)
         ON CONFLICT(symbol) DO NOTHING`,
      )
      .run(symbol);
  }

  /**
   * `INSERT OR REPLACE`, not `OR IGNORE`. What protects this store from
   * restated history is that both primaries are UNADJUSTED (Alpaca pinned
   * `adjustment=raw`; crypto venues do not restate candles), so a re-read bar
   * carries identical values — not the choice of SQL verb, which cannot tell
   * a restatement from a correction. `IGNORE` would not preserve history; it
   * would only make the provisional-bar case above permanent.
   */
  #persist(symbol: string, aggregates: PolygonAggregate[]): void {
    const upsert = this.db.prepare(
      `INSERT OR REPLACE INTO stage2_bars
         (instrument, timeframe, open_time, close_time, open, high, low, close, volume)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    // ONE transaction for the whole page, not one implicit transaction per row
    // (#664). Measured on this branch before the change: a single
    // instrument-year of 1-minute bars — 98,280 rows — took **25.9 seconds** to
    // persist, because each `run()` outside a transaction commits on its own.
    // Ten years across the four-symbol equity universe is ~4M rows, i.e. ~17
    // HOURS of writing for a backfill whose network side is minutes. Batched,
    // the same 98,280 rows take well under a second.
    //
    // Invisible at daily resolution — 2,500 rows a symbol committed one at a
    // time is under a second — which is why it survived until intraday made it
    // the binding cost. `better-sqlite3`'s `transaction()` is synchronous and
    // rolls back on a throw, so a malformed page leaves no half-written series.
    this.db.transaction((rows: PolygonAggregate[]) => {
      for (const aggregate of rows) {
        const openTime = new Date(aggregate.t);
        const closeTime = closeTimeOf(openTime, this.timeframe);
        upsert.run(
          symbol,
          this.timeframe,
          toStoredTimestamp(openTime),
          toStoredTimestamp(closeTime),
          aggregate.o,
          aggregate.h,
          aggregate.l,
          aggregate.c,
          aggregate.v,
        );
      }
    })(aggregates);
  }

  /**
   * Point-in-time read: bars for `symbol` with `close_time` inside `window`
   * (inclusive), ascending — the shape `proxySignal` (#242) and the replay
   * driver (#243) consume directly.
   */
  bars(symbol: string, window: DateRange): Bar[] {
    const rows = this.db
      .prepare(
        `SELECT instrument, timeframe, open_time, close_time, open, high, low, close, volume
           FROM stage2_bars
          WHERE instrument = ? AND timeframe = ?
            AND close_time >= ? AND close_time <= ?
          ORDER BY close_time ASC`,
      )
      .all(
        symbol,
        this.timeframe,
        toStoredTimestamp(window.start),
        toStoredTimestamp(window.end),
      ) as Stage2BarRow[];

    return rows.map((row) => ({
      instrument: row.instrument,
      timeframe: row.timeframe,
      open_time: fromStoredTimestamp(row.open_time),
      close_time: fromStoredTimestamp(row.close_time),
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume,
      source: 'polygon',
    }));
  }

  /**
   * `ReplayTimeline.barTimestamps` — the union of **every** ingested
   * instrument's close times, across all asset classes.
   *
   * **Almost certainly not what a replay wants (#420).** A replay trades one
   * asset class, and stock and crypto daily bars close at different UTC times,
   * so this union is close to their *sum*: over a 2-year window it returns
   * ~1,229 timestamps where stocks have ~504 bars and crypto ~730. Driving a
   * stock replay off it pads the return series with a zero on every
   * crypto-only bar, which scales the per-period Sharpe by roughly
   * `sqrt(n_real / n_union)` and leaves `periodsPerYear` describing a cadence
   * the series no longer has.
   *
   * Use `timelineFor(symbols)` for anything scored per asset class. This
   * method is kept because `ReplayTimeline` is a single-method interface the
   * store legitimately satisfies, and a whole-universe timeline is still the
   * right answer for a whole-universe question.
   */
  async barTimestamps(window: DateRange): Promise<readonly Date[]> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT close_time
           FROM stage2_bars
          WHERE timeframe = ? AND close_time >= ? AND close_time <= ?
          ORDER BY close_time ASC`,
      )
      .all(this.timeframe, toStoredTimestamp(window.start), toStoredTimestamp(window.end)) as {
      close_time: string;
    }[];

    return rows.map((row) => fromStoredTimestamp(row.close_time));
  }

  /**
   * A `ReplayTimeline` scoped to `symbols` — the close times of those
   * instruments only (#420).
   *
   * This is the timeline a per-asset-class replay must step. `ReplayDriver`
   * already scopes its `universe` correctly, so only the right instruments
   * ever trade; the defect this fixes was that the *timeline* was not scoped
   * with it, and the return series is built one slot per stepped bar.
   */
  timelineFor(symbols: readonly string[]): ReplayTimeline {
    if (symbols.length === 0) {
      throw new Error(
        'Stage2HistoricalStore.timelineFor: at least one symbol is required — an empty scope ' +
          'yields an empty timeline, which fails much later as "no bars in the sample".',
      );
    }

    return {
      barTimestamps: async (window: DateRange): Promise<readonly Date[]> =>
        this.barTimestampsFor(symbols, window),
    };
  }

  /** The close times of `symbols` only, ascending. See `timelineFor`. */
  private barTimestampsFor(
    symbols: readonly string[],
    window: DateRange,
  ): Promise<readonly Date[]> {
    const placeholders = symbols.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT DISTINCT close_time
           FROM stage2_bars
          WHERE instrument IN (${placeholders})
            AND timeframe = ?
            AND close_time >= ? AND close_time <= ?
          ORDER BY close_time ASC`,
      )
      .all(
        ...symbols,
        this.timeframe,
        toStoredTimestamp(window.start),
        toStoredTimestamp(window.end),
      ) as {
      close_time: string;
    }[];

    if (rows.length === 0) {
      // Name the cause here rather than let it surface four layers up as
      // `toReturnSeries: no bars in the sample` (pitfall P3).
      const ingested = (
        this.db
          .prepare('SELECT DISTINCT instrument FROM stage2_bars WHERE timeframe = ?')
          .all(this.timeframe) as {
          instrument: string;
        }[]
      ).map((row) => row.instrument);

      const unknown = symbols.filter((symbol) => !ingested.includes(symbol));

      throw new Error(
        `Stage2HistoricalStore.timelineFor: no bars for [${symbols.join(', ')}] at ` +
          `${this.timeframe} between ` +
          `${window.start.toISOString()} and ${window.end.toISOString()}. ` +
          (unknown.length > 0
            ? `Never ingested: [${unknown.join(', ')}]. Ingested: [${ingested.join(', ')}].`
            : 'Those symbols are ingested but have no bars inside this window.'),
      );
    }

    return Promise.resolve(rows.map((row) => fromStoredTimestamp(row.close_time)));
  }

  /** `InstrumentRegistry.membershipDuring` — see class doc for the "nothing delisted" posture. */
  async membershipDuring(_window: DateRange): Promise<InstrumentListing[]> {
    const rows = this.db
      .prepare('SELECT symbol, delisted_at FROM stage2_listing')
      .all() as Stage2ListingRow[];

    return rows.map((row) =>
      row.delisted_at === null
        ? { symbol: row.symbol }
        : { symbol: row.symbol, delisted_at: fromStoredTimestamp(row.delisted_at) },
    );
  }
}
