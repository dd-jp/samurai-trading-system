/**
 * Stage 2 replay driver — see
 * docs/specs/stage2-validation-execution-spec.md ("Module: Replay Driver").
 * Steps the proxy strategy bar-by-bar through ingested historical bars and
 * hands the result to `EvalExecutorImpl` through its existing ports
 * (`ReplayTradeSource`, `ReplayTimeline`); neither port nor `eval-executor.ts`
 * changes for this module — the driver adapts to them.
 *
 * Never calls `BrokerAdapter`, `Trader.decide`, `RiskManagerImpl.evaluate` or
 * `VerdictImpl.decide` — enforced structurally by not importing them. The
 * proxy strategy stands in for the whole pipeline to validate the harness's
 * own honesty (costs, no lookahead, survivorship), not the live gate
 * sequence.
 *
 * Fills go straight to `CostModel.fill`: `BrokerAdapter` has no flatten/cancel
 * method, so routing entries through it while exits bypassed it would price
 * the two legs by different models.
 *
 * A stop/target exit is priced against what the market actually offered — the
 * bar's open if it already gapped through the level, otherwise the level
 * itself — never an assumed fill at the exact stop through a gap.
 *
 * `debate_id` here is synthetic, derived from the lot's idempotency key —
 * there is no debate, and nothing writes to `SetupStore` or `DebateLogStore`.
 */

import type { Bar, TradingCalendar } from '../../providers/market-data-service/index.js';
import {
  computeIndicator,
  isDailyTimeframe,
  timeframeToMs,
} from '../../providers/market-data-service/index.js';
import type { ClosedTrade, Fill, SimulatedClock } from '../../shared/index.js';
import { toBrokerFillId } from '../../shared/index.js';
import type { ReplayTradeSource } from './eval-types.js';
import { LookaheadAuditor } from './lookahead.js';
import {
  type ProxySignal,
  type ProxyStrategyConfig,
  proxyAtrSpec,
  proxySignal,
  proxyWarmupBars,
} from './proxy-strategy.js';
import type { CostModel, CostVenue, MarketState, ReplayTimeline } from './types.js';
import { assertSurvivorshipFree, type DateRange, type InstrumentRegistry } from './universe.js';

/** The audited source of historical bars — `Stage2HistoricalStore` in production */
export interface ReplayBarSource {
  /** Bars for `symbol` with `close_time` inside `window` (inclusive), ascending */
  bars(symbol: string, window: DateRange): Bar[];
}

/** One replayed instrument. `asset_class` selects the cost model's parameter set. */
export interface ReplayInstrument {
  symbol: string;
  asset_class: 'crypto' | 'stocks';
  /** Layers `CostConfig.venues[venue]` over the asset-class set */
  venue?: CostVenue;
}

export interface ReplayDriverDeps {
  barSource: ReplayBarSource;
  /** The bar timestamps to step — `Stage2HistoricalStore` implements this too */
  timeline: ReplayTimeline;
  registry: InstrumentRegistry;
  costModel: CostModel;
  /** Stepped bar-by-bar; the `LookaheadAuditor`'s reference for "now" */
  clock: SimulatedClock;
  universe: readonly ReplayInstrument[];
  /**
   * Notional committed per entry; `size = capitalPerTrade / reference price`.
   *
   * Deliberately a dependency and not a field on `ProxyStrategyConfig`: the
   * spec pins the trial grid at exactly 12 configs, and `config_hash` is that
   * config's identity. Widening it with a sizing knob would make N ambiguous.
   */
  capitalPerTrade: number;
  /** Bars of volume averaged into `MarketState.adv`. Default 20. */
  advWindow?: number;
  /**
   * The timeframe the replayed bars are on (e.g. `'1d'`, `'1m'`, `'5m'`).
   *
   * REQUIRED, not defaulted — a default would let every existing caller keep
   * compiling and replaying daily while the intraday path silently went
   * untested. Checked against each bar's own `Bar.timeframe` as the cursor
   * loads it, so a mismatched store fails the run instead of mislabelling
   * every indicator and session boundary.
   */
  timeframe: string;
  /**
   * The venue calendar this replay's session boundaries come from
   * (`UsEquityRegularHoursCalendar` for US equities, `AlwaysOpenCalendar` for
   * 24/7). Required, not defaulted — a defaulted always-open calendar would
   * silently disable ADR-0014's flat-by-close. Consulted only on intraday
   * timeframes; see `flattenBoundary`.
   */
  sessionCalendar: TradingCalendar;
  /**
   * The flat-by-close window, as an offset before the session close.
   * Defaults to ADR-0014's five minutes. Duplicated as a number rather than
   * imported from `server/pipeline/trader`, since this module deliberately
   * imports nothing from the live pipeline (a test asserts the two agree).
   * Widened to one bar when the timeframe is coarser — see `run`.
   */
  flattenBeforeCloseMs?: number;
}

export interface ReplayRunResult {
  trades: ReplayTradeSource;
  timeline: ReplayTimeline;
}

const DEFAULT_ADV_WINDOW = 20;

/**
 * ADR-0014's flat-by-close offset, mirroring
 * `TRADER_CONFIG_DEFAULTS.flatten_before_close_ms` (server/pipeline/trader/
 * types.ts). Restated rather than imported — see `flattenBeforeCloseMs`.
 */
export const DEFAULT_FLATTEN_BEFORE_CLOSE_MS = 5 * 60 * 1_000;

/**
 * Where this bar sits relative to its session's close. `null` when the
 * question does not arise: a daily replay (the bar already spans the whole
 * session) or a venue with no close (crypto).
 *
 * Keyed on `bar.open_time`, NOT `close_time` — load-bearing. `sessionEnd`
 * answers "next close strictly after this instant", so the last 1-minute bar
 * of a session (open 15:59, close 16:00) asked by its close time would report
 * tomorrow's close instead of today's.
 */
function flattenBoundary(
  bar: Bar,
  timeframe: string,
  calendar: TradingCalendar,
): { sessionEnd: Date; remainingMs: number } | null {
  if (isDailyTimeframe(timeframe)) return null;
  const sessionEnd = calendar.sessionEnd(bar.open_time);
  if (sessionEnd === null) return null;
  return { sessionEnd, remainingMs: sessionEnd.getTime() - bar.open_time.getTime() };
}

/** An open lot, held between bars until an exit prices it */
interface OpenLot {
  idempotency_key: string;
  side: 'buy' | 'sell';
  direction: 'long' | 'short';
  size: number;
  /** `CostModelResult.fill_price` of the entry — never an assumed level */
  entry: number;
  /** The INITIAL protective stop: the denominator of R (shared/types.ts) */
  stop: number;
  target: number;
  fees: number;
  opened_at: Date;
  /**
   * The close of the session this lot opened in, or `null` when the question
   * does not arise (daily replay, or a venue with no close).
   *
   * Carried on the lot rather than recomputed, so the flat-by-close invariant
   * can be checked directly — see `run`.
   */
  session_end: Date | null;
}

/**
 * One instrument's bars for the whole run, read from the injected source
 * once and revealed prefix-by-prefix as the clock steps — re-reading per
 * (timestamp x instrument) step would be O(steps x bars) against
 * `Stage2HistoricalStore` for a strategy that only ever needs one more bar.
 *
 * Not just a cache: the `LookaheadAuditor` seam is preserved exactly. Each
 * bar is audited against `clock.now()` when it first becomes visible; rows
 * outside the requested window are never dropped, only audited later by
 * `settle()`, so a misbehaving source still fails the run.
 */
class BarCursor {
  /** Every bar the source served for the run window, source order preserved */
  private readonly all: readonly Bar[];
  /** Count of bars revealed so far — also the exclusive end of the visible prefix */
  private cursor = 0;
  /**
   * The visible prefix, grown in place rather than re-sliced from `this.all`
   * on every `visibleAt` call — re-slicing was O(cursor) per call, O(T^2 * M)
   * total across the run; growing in place makes each step O(1) amortized.
   *
   * Sharing the array across calls is safe only because every caller
   * (`run()`'s loop body) reads the returned reference synchronously, within
   * the same iteration, before the next `visibleAt` call can grow it further.
   */
  private readonly revealed: Bar[] = [];

  constructor(
    private readonly symbol: string,
    source: ReplayBarSource,
    window: DateRange,
    private readonly auditor: LookaheadAuditor,
    timeframe: string,
  ) {
    this.all = source.bars(symbol, window);

    // The driver is TOLD its timeframe and the bars carry their own, so the
    // two can disagree without this check — nothing downstream would notice,
    // it would just silently mislabel every indicator. Checked on the first
    // bar only: `Stage2HistoricalStore` scopes every read to one timeframe
    const first = this.all[0];
    if (first !== undefined && first.timeframe !== timeframe) {
      throw new Error(
        `ReplayDriver: bar source served ${symbol} at '${first.timeframe}' but the driver is ` +
          `configured for '${timeframe}'. Replaying one resolution while labelling it another ` +
          'mislabels every indicator and mis-sizes the flat-by-close window.',
      );
    }

    // `visibleAt` only reads an ascending array correctly — a misordered row
    // would silently cut the visible prefix short. `ReplayBarSource`
    // documents ascending order; this asserts that contract rather than
    // assuming it, since `settle()` cannot catch a past-stamped straggler
    for (let i = 1; i < this.all.length; i++) {
      const previous = this.all[i - 1] as Bar;
      const current = this.all[i] as Bar;
      if (current.close_time.getTime() <= previous.close_time.getTime()) {
        throw new Error(
          `ReplayDriver: bar source served ${symbol} out of order — ` +
            `${current.close_time.toISOString()} follows ${previous.close_time.toISOString()}. ` +
            'ReplayBarSource must return bars ascending by close_time; replaying an unsorted ' +
            'series would compute indicators over the wrong window without erroring.',
        );
      }
    }
  }

  /**
   * The bars visible at `at`: every bar with `close_time <= at`, ascending.
   * Inclusive of a bar closing exactly at `at` — that is the current bar, the
   * one the strategy is allowed to act on.
   */
  visibleAt(at: Date): readonly Bar[] {
    while (this.cursor < this.all.length) {
      const next = this.all[this.cursor] as Bar;
      if (next.close_time.getTime() > at.getTime()) break;
      this.auditor.auditRead(`stage2_bars:${this.symbol}`, next.close_time);
      this.revealed.push(next);
      this.cursor++;
    }
    return this.revealed;
  }

  /**
   * Audits whatever the source served that the run never stepped to. With a
   * well-behaved source this is empty; a row left here is one outside the
   * requested window, and auditing it against the final clock turns that
   * into a failed run.
   */
  settle(): void {
    for (let i = this.cursor; i < this.all.length; i++) {
      this.auditor.auditRead(`stage2_bars:${this.symbol}`, (this.all[i] as Bar).close_time);
    }
    this.cursor = this.all.length;
  }
}

/** In-memory `ReplayTradeSource` over one run's hand-constructed records */
class ReplayRecords implements ReplayTradeSource {
  readonly trades: ClosedTrade[] = [];
  private readonly fillsByKey = new Map<string, Fill[]>();

  record(trade: ClosedTrade, fills: readonly Fill[]): void {
    this.trades.push(trade);
    this.fillsByKey.set(trade.idempotency_key, [...fills]);
  }

  async closedTrades(window: DateRange): Promise<readonly ClosedTrade[]> {
    return this.trades
      .filter(
        (trade) =>
          trade.closed_at.getTime() >= window.start.getTime() &&
          trade.closed_at.getTime() <= window.end.getTime(),
      )
      .sort((a, b) => a.closed_at.getTime() - b.closed_at.getTime());
  }

  async fills(idempotency_key: string): Promise<readonly Fill[]> {
    return this.fillsByKey.get(idempotency_key) ?? [];
  }
}

/**
 * `ReplayTimeline` over the timestamps the run actually stepped — not the
 * injected timeline verbatim. `toReturnSeries` throws if a trade closes after
 * the sample's last bar, so the timeline handed to the eval executor must be
 * the one the trades were produced against.
 */
class SteppedTimeline implements ReplayTimeline {
  constructor(private readonly stepped: readonly Date[]) {}

  async barTimestamps(window: DateRange): Promise<readonly Date[]> {
    return this.stepped.filter(
      (at) => at.getTime() >= window.start.getTime() && at.getTime() <= window.end.getTime(),
    );
  }
}

/**
 * One run's mutable state. Held here, not on the driver, so a driver instance
 * can be re-run without a previous run's half-open lots leaking into it.
 */
interface RunState {
  config: ProxyStrategyConfig;
  records: ReplayRecords;
  open: Map<string, OpenLot>;
  /** Entry fills, held until their lot closes and the `ClosedTrade` is built */
  pendingFills: Map<string, Fill[]>;
}

export class ReplayDriver {
  constructor(private readonly deps: ReplayDriverDeps) {}

  async run(config: ProxyStrategyConfig, window: DateRange): Promise<ReplayRunResult> {
    // Survivorship gate first, before a single bar is stepped — a biased
    // universe invalidates the run, so fail before producing trades from it
    await assertSurvivorshipFree(
      this.deps.universe.map((instrument) => instrument.symbol),
      window,
      this.deps.registry,
    );

    // Per-run, never per-driver: `RunState` is rebuilt each run so a previous
    // run's lots cannot leak into this one, and a cached bar cursor held on
    // the driver would leak the same way
    const auditor = new LookaheadAuditor(this.deps.clock);
    const cursors = this.buildCursors(auditor, window);

    const state: RunState = {
      config,
      records: new ReplayRecords(),
      open: new Map<string, OpenLot>(),
      pendingFills: new Map<string, Fill[]>(),
    };
    // Derived, never restated — `proxyWarmupBars` is the single source of
    // truth for the warmup width
    const warmup = proxyWarmupBars(config, this.deps.timeframe);

    const stepped = await this.deps.timeline.barTimestamps(window);

    for (const at of stepped) {
      // Monotonic by construction: `advanceTo` throws on a backwards step, so
      // an unsorted timeline fails the run instead of rewinding T
      this.deps.clock.advanceTo(at);

      for (const instrument of this.deps.universe) {
        this.stepInstrument(
          state,
          instrument,
          cursors.get(instrument.symbol) as BarCursor,
          at,
          warmup,
        );
      }
    }

    // Audited now against the final clock — a source that ignored the
    // requested window fails the run instead of dropping rows silently
    for (const cursor of cursors.values()) cursor.settle();

    // A lot still open at the last bar produces no `ClosedTrade`: only a
    // round-trip-to-flat is a realized record (shared/types.ts), and marking
    // it out at the final close would invent an exit no cost model priced
    return { trades: state.records, timeline: new SteppedTimeline(stepped) };
  }

  private buildCursors(auditor: LookaheadAuditor, window: DateRange): Map<string, BarCursor> {
    const cursors = new Map<string, BarCursor>();
    for (const instrument of this.deps.universe) {
      cursors.set(
        instrument.symbol,
        new BarCursor(instrument.symbol, this.deps.barSource, window, auditor, this.deps.timeframe),
      );
    }
    return cursors;
  }

  private stepInstrument(
    state: RunState,
    instrument: ReplayInstrument,
    cursor: BarCursor,
    at: Date,
    warmup: number,
  ): void {
    const bars = cursor.visibleAt(at);
    const bar = bars[bars.length - 1];

    // No bar closing at this timestamp, or still inside warmup —
    // `computeIndicator` on a short window returns a wrong value rather than
    // erroring, so a short slice is never evaluated
    if (bar === undefined || bar.close_time.getTime() !== at.getTime()) return;
    if (bars.length < warmup) return;

    const signal = proxySignal(bars, state.config, this.deps.timeframe);
    const lot = state.open.get(instrument.symbol);

    // `null` on a daily replay or a venue with no close — see `flattenBoundary`
    const boundary = flattenBoundary(bar, this.deps.timeframe, this.deps.sessionCalendar);
    // Widened to at least one bar: the live rule is wall-clock (last five
    // minutes before close), but a replay can't act inside a bar — on a
    // coarser grid no bar's open would ever fall inside a sub-bar window,
    // and the lot would be carried and trip the assertion below instead
    const flattenBeforeCloseMs = Math.max(
      this.deps.flattenBeforeCloseMs ?? DEFAULT_FLATTEN_BEFORE_CLOSE_MS,
      timeframeToMs(this.deps.timeframe),
    );
    const withinFlattenWindow = boundary !== null && boundary.remainingMs <= flattenBeforeCloseMs;

    if (lot !== undefined) {
      this.handleOpenLot(state, instrument, lot, bar, bars, signal, withinFlattenWindow);
      // No same-bar re-entry: the lot's exit is already priced at this
      // bar, and re-entering on it would open a second lot against the
      // same bar's information
      return;
    }

    if (signal.direction === 'flat') return;

    // Nothing new opens inside the flatten window, mirroring the live rule
    // (`withinFlattenWindow` in trader/decide.ts) — an entry here would be
    // flattened on the next bar at best, carried overnight at worst
    if (withinFlattenWindow) return;

    state.open.set(
      instrument.symbol,
      this.openLot(
        state,
        instrument,
        bar,
        bars,
        signal,
        signal.direction,
        boundary?.sessionEnd ?? null,
      ),
    );
  }

  private handleOpenLot(
    state: RunState,
    instrument: ReplayInstrument,
    lot: OpenLot,
    bar: Bar,
    bars: readonly Bar[],
    signal: ProxySignal,
    withinFlattenWindow: boolean,
  ): void {
    // The flat-by-close invariant, asserted rather than assumed: a lot still
    // open in a LATER session means the flatten window never opened for it —
    // typically a calendar whose hand-entered holiday/early-close tables
    // don't cover the replayed date. Throwing here is preferred over
    // silently carrying overnight, which would produce a "flat-by-close"
    // backtest that quietly isn't
    if (lot.session_end !== null && bar.open_time.getTime() >= lot.session_end.getTime()) {
      throw new Error(
        `ReplayDriver: ${instrument.symbol} carried a position from the session ending ` +
          `${lot.session_end.toISOString()} into the bar opening ` +
          `${bar.open_time.toISOString()}. ADR-0014 is flat-by-close, so this is either a ` +
          'session whose real close the calendar does not know (its holiday/early-close ' +
          'tables are hand-entered and cover 2026-2027 — see #684) or a bar series with ' +
          'no bar inside the flatten window. Fix the calendar rather than reading the ' +
          'result: an overnight carry here is not a modelling choice, it is a wrong number.',
      );
    }

    // Bracket checked before flatten: a stop/target inside the bar's range
    // happened before the flatten window's clock ran out at the bar's open —
    // flattening it instead would book the exit at the wrong, flattering price
    const exit = exitOf(lot, bar, signal) ?? (withinFlattenWindow ? flattenExit(bar) : undefined);
    if (exit !== undefined) {
      this.closeLot(state, instrument, lot, bar, bars, exit);
      state.open.delete(instrument.symbol);
    }
  }

  private openLot(
    state: RunState,
    instrument: ReplayInstrument,
    bar: Bar,
    bars: readonly Bar[],
    signal: ProxySignal,
    /** The signal's direction, narrowed by the caller's flat check */
    direction: 'long' | 'short',
    /** The close of the session this lot opens in — see `OpenLot.session_end` */
    session_end: Date | null,
  ): OpenLot {
    const side = direction === 'long' ? 'buy' : 'sell';
    const idempotency_key = `proxy-${instrument.symbol}-${bar.close_time.toISOString()}`;
    const size = this.deps.capitalPerTrade / bar.close;

    const result = this.deps.costModel.fill(
      {
        instrument: instrument.symbol,
        side,
        size,
        order_type: 'market',
        idempotency_key,
      },
      this.marketState(state.config, instrument, bar, bars, bar.close),
    );

    state.pendingFills.set(idempotency_key, [
      {
        idempotency_key,
        broker_fill_id: toBrokerFillId(`${idempotency_key}:entry`),
        leg: 'entry',
        price: result.fill_price,
        qty: result.filled_size,
        fee: result.cost_breakdown.commission,
        timestamp: bar.close_time,
        cost_breakdown: { ...result.cost_breakdown },
      },
    ]);

    return {
      idempotency_key,
      side,
      direction,
      size: result.filled_size,
      entry: result.fill_price,
      stop: signal.stop,
      target: signal.target,
      fees: result.cost_breakdown.commission,
      opened_at: bar.close_time,
      session_end,
    };
  }

  private closeLot(
    state: RunState,
    instrument: ReplayInstrument,
    lot: OpenLot,
    bar: Bar,
    bars: readonly Bar[],
    exit: { reason: ReplayCloseReason; reference: number },
  ): void {
    // Closing side is the opposite of the entry's, so the cost model moves the
    // price adversely against the exit — not in its favor
    const side = lot.side === 'buy' ? 'sell' : 'buy';

    const result = this.deps.costModel.fill(
      {
        instrument: instrument.symbol,
        side,
        size: lot.size,
        order_type: 'market',
        idempotency_key: lot.idempotency_key,
      },
      this.marketState(state.config, instrument, bar, bars, exit.reference),
    );

    // `CostModelResult.filled_size` may be < requested size in principle
    // (types.ts), though `CostModelImpl` always fills fully today. A
    // `ClosedTrade` can't represent a half-closed lot, so fail loudly here
    // rather than book a round-trip that didn't happen
    if (result.filled_size !== lot.size) {
      throw new Error(
        `ReplayDriver: exit of lot ${lot.idempotency_key} filled partially ` +
          `(${result.filled_size} of ${lot.size}). A ClosedTrade records a completed round-trip ` +
          'only; partial closes need per-leg lot accounting this replay path does not model.',
      );
    }

    const fills = state.pendingFills.get(lot.idempotency_key) ?? [];
    fills.push({
      idempotency_key: lot.idempotency_key,
      broker_fill_id: toBrokerFillId(`${lot.idempotency_key}:${exit.reason}`),
      // `Fill.leg` keeps its original four values — migration 0031 widened
      // `closed_trades.close_reason`, not `fills.leg`. A flatten is recorded
      // as `'flatten'` on the trade but the generic `'exit'` on its fill,
      // matching the live path
      leg: exit.reason === 'flatten' ? 'exit' : exit.reason,
      price: result.fill_price,
      qty: result.filled_size,
      fee: result.cost_breakdown.commission,
      timestamp: bar.close_time,
      cost_breakdown: { ...result.cost_breakdown },
    });
    state.pendingFills.delete(lot.idempotency_key);

    const fees_total = lot.fees + result.cost_breakdown.commission;
    const direction = lot.direction === 'long' ? 1 : -1;
    const gross = (result.fill_price - lot.entry) * lot.size * direction;

    state.records.record(
      {
        idempotency_key: lot.idempotency_key,
        debate_id: `proxy-replay:${lot.idempotency_key}`,
        instrument: instrument.symbol,
        asset_class: instrument.asset_class,
        side: lot.side,
        entry: lot.entry,
        stop: lot.stop,
        filled_size: lot.size,
        realized_pnl_net: gross - fees_total,
        fees_total,
        opened_at: lot.opened_at,
        closed_at: bar.close_time,
        close_reason: exit.reason,
        // Always true here — every leg is priced through `CostModel.fill`
        // itself, so there is no venue report to fall back from and no
        // uncharged leg to record
        modelled_cost_charged: true,
      },
      fills,
    );
  }

  /**
   * The bar's market context. `spread` is null by design: historical OHLCV
   * bars carry no bid/ask, so the cost model fallback-models spread from
   * volatility. `volatility` is the same ATR the strategy sized its stop
   * with, and `adv` the rolling mean bar volume.
   *
   * The cost config must match the replay resolution: `spreadVolatilityCoefficient`
   * is a ratio fitted to a specific bar size, so a caller passing the
   * daily-fitted `CALIBRATED_COST_CONFIG` to an intraday replay by hand would
   * get a flattering spread. Use `costConfigFor(timeframe)`.
   */
  private marketState(
    config: ProxyStrategyConfig,
    instrument: ReplayInstrument,
    bar: Bar,
    bars: readonly Bar[],
    mid: number,
  ): MarketState {
    const atrSpec = proxyAtrSpec(config, this.deps.timeframe);
    const advWindow = this.deps.advWindow ?? DEFAULT_ADV_WINDOW;
    const recent = bars.slice(-advWindow);
    const adv = recent.reduce((sum, row) => sum + row.volume, 0) / recent.length;

    if (!(adv > 0)) {
      throw new Error(
        `ReplayDriver: ${instrument.symbol} has non-positive average volume (${adv}) at ` +
          `${bar.close_time.toISOString()} — CostModel.fill cannot size market impact against ` +
          'it. Re-ingest the instrument rather than replaying it as if it were liquid.',
      );
    }

    return {
      mid,
      spread: null,
      adv,
      // The same ATR the strategy sized this lot's stop with — one estimate,
      // via the shared `proxyAtrSpec`, so the cost model and the stop can't
      // disagree about it. `timeframe` is the replay's own, not a hardcoded
      // literal — a wrong label here wouldn't error, just falsely record
      // which bars the volatility was measured on
      volatility: computeIndicator(bars.slice(-atrSpec.lookback) as Bar[], atrSpec),
      asset_class: instrument.asset_class,
      ...(instrument.venue === undefined ? {} : { venue: instrument.venue }),
      timestamp: this.deps.clock.now(),
    };
  }
}

/**
 * Narrower than `ClosedTrade['close_reason']`: never 'signal_decay' or
 * 'direction_flip', which need an `OrderIntent.metadata` this path never
 * builds. `Fill.leg` (migration 0031, #793) keeps its original four values,
 * so `exit.reason` maps onto it directly.
 */
type ReplayCloseReason = 'stop' | 'target' | 'exit' | 'flatten';

/**
 * The flat-by-close exit, priced at the bar's close — the flatten window
 * opened at this bar's open, so the close is the last quoted price for a
 * position held through it. `CostModel.fill` then moves that adversely, like
 * any fill, so this is not a free exit.
 *
 * `'flatten'` is `ExitReason`'s own member, matching the live path's
 * vocabulary rather than collapsing it into the generic `'exit'`.
 */
function flattenExit(bar: Bar): { reason: ReplayCloseReason; reference: number } {
  return { reason: 'flatten', reference: bar.close };
}

/**
 * A long lot's bracket exit, if this bar produced one — stop checked before
 * target (see `exitOf`). The reference is the bar's open when it already
 * gapped through the level, otherwise the level itself.
 */
function longBracketExit(
  lot: OpenLot,
  bar: Bar,
): { reason: ReplayCloseReason; reference: number } | undefined {
  if (bar.low <= lot.stop) {
    return { reason: 'stop', reference: bar.open < lot.stop ? bar.open : lot.stop };
  }
  if (bar.high >= lot.target) {
    return { reason: 'target', reference: bar.open > lot.target ? bar.open : lot.target };
  }
  return undefined;
}

function shortBracketExit(
  lot: OpenLot,
  bar: Bar,
): { reason: ReplayCloseReason; reference: number } | undefined {
  if (bar.high >= lot.stop) {
    return { reason: 'stop', reference: bar.open > lot.stop ? bar.open : lot.stop };
  }
  if (bar.low <= lot.target) {
    return { reason: 'target', reference: bar.open < lot.target ? bar.open : lot.target };
  }
  return undefined;
}

/**
 * Which exit, if any, this bar produces — and the reference price it is
 * priced against.
 *
 * Stop is checked before target: when a single bar's range spans both,
 * the intrabar path is unknowable from OHLC alone, and assuming the target
 * came first is the optimistic reading.
 *
 * The reference is the bar's open when it already gapped through the level,
 * otherwise the level itself — never an assumed fill at an unavailable price.
 */
function exitOf(
  lot: OpenLot,
  bar: Bar,
  signal: ProxySignal,
): { reason: ReplayCloseReason; reference: number } | undefined {
  const bracket = lot.direction === 'long' ? longBracketExit(lot, bar) : shortBracketExit(lot, bar);
  if (bracket !== undefined) return bracket;

  // Signal exit: the trend no longer favors the side the lot is on. Priced at
  // the close — the bar on which the signal became knowable
  if (signal.direction !== lot.direction) {
    return { reason: 'exit', reference: bar.close };
  }

  return undefined;
}
