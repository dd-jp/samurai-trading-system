/**
 * Stage 2 replay driver (#243). Never calls `BrokerAdapter`, `Trader.decide`,
 * `RiskManagerImpl.evaluate` or `VerdictImpl.decide` — enforced structurally by
 * not importing any of them (a test asserts the import list stays clean). Both
 * legs price through `CostModel.fill` directly, since `BrokerAdapter` has no
 * flatten/cancel method a signal exit could route through.
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

/** The audited source of historical bars — `Stage2HistoricalStore` (#241) in production */
export interface ReplayBarSource {
  /** Bars for `symbol` with `close_time` inside `window` (inclusive), ascending */
  bars(symbol: string, window: DateRange): Bar[];
}

/** One replayed instrument. `asset_class` selects the cost model's parameter set. */
export interface ReplayInstrument {
  symbol: string;
  asset_class: 'crypto' | 'stocks';
  /** Layers `CostConfig.venues[venue]` over the asset-class set (#1032 item 2) */
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
   * Notional committed per entry. Deliberately a dependency, not a
   * `ProxyStrategyConfig` field — the spec pins the trial grid at exactly 12
   * configs, and widening it with a sizing knob would make that N ambiguous.
   */
  capitalPerTrade: number;
  /** Bars of volume averaged into `MarketState.adv`. Default 20. */
  advWindow?: number;
  /**
   * The replayed bars' timeframe (#664). REQUIRED, not defaulted — a default
   * would let every caller keep compiling against daily data while the
   * intraday path exists only in its own test. Checked against each bar's own
   * `Bar.timeframe` as the cursor loads it.
   */
  timeframe: string;
  /**
   * The venue calendar session boundaries come from (#664) — required for the
   * same reason as `timeframe`, since a defaulted always-open calendar would
   * silently disable flat-by-close (ADR-0014). Consulted only on intraday
   * timeframes — see `flattenBoundary`.
   */
  sessionCalendar: TradingCalendar;
  /**
   * The flat-by-close window before session close. Defaults to the live
   * ADR-0014 rule, duplicated rather than imported since this module imports
   * nothing from the live pipeline (a test asserts the two agree). WIDENED to
   * one bar when the timeframe is coarser — see `run`.
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
 * Where this bar sits relative to its session's close (#664).
 *
 * `null` means the question does not arise: a DAILY replay (whose bar already
 * spans the whole session — flattening "before the close" inside a bar that IS
 * the session is meaningless), or a venue whose calendar returns no close at
 * all (crypto; `TradingCalendar.sessionEnd` documents `null` as a real answer,
 * and #668 is explicit that a crypto flatten must not be invented ahead of the
 * thesis amendment #667).
 *
 * Keyed on `bar.open_time`, NOT `close_time`, and that is load-bearing.
 * `sessionEnd` answers "the next close STRICTLY AFTER this instant", so the
 * last 1-minute bar of a US session — open 15:59, close exactly 16:00 ET —
 * asked by its close time reports TOMORROW'S close, ~18 hours away, and the
 * flatten window would never open on the one bar that matters most to a
 * flat-by-close thesis. Asked by its open time it reports today's 16:00.
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
   * The close of the session this lot opened in, or null where that doesn't
   * apply. Carried on the lot (not recomputed) so the flat-by-close invariant
   * can be checked directly — see `run`.
   */
  session_end: Date | null;
}

/**
 * One instrument's bars, read from the source once and revealed
 * prefix-by-prefix as the clock steps — collapses what would otherwise be
 * O(steps x bars) re-reads to one read per run. The `LookaheadAuditor` seam is
 * preserved: each bar is audited when it first becomes visible, and rows
 * outside the window are audited by `settle()` rather than silently dropped.
 */
class BarCursor {
  /** Every bar the source served for the run window, source order preserved */
  private readonly all: readonly Bar[];
  /** Count of bars revealed so far — also the exclusive end of the visible prefix */
  private cursor = 0;
  /**
   * Grown in place rather than re-sliced every `visibleAt` call (#836, #289
   * H11) — the previous O(cursor) copy per (instrument, timestamp) pair was
   * the actual quadratic cost. Safe to share by reference: every caller reads
   * synchronously within one iteration before the next call can grow it.
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

    // #664: the driver is told its timeframe and bars carry their own, so
    // they can disagree — checked on the first bar only, since
    // `Stage2HistoricalStore` now scopes every read to one timeframe.
    const first = this.all[0];
    if (first !== undefined && first.timeframe !== timeframe) {
      throw new Error(
        `ReplayDriver: bar source served ${symbol} at '${first.timeframe}' but the driver is ` +
          `configured for '${timeframe}'. Replaying one resolution while labelling it another ` +
          'mislabels every indicator and mis-sizes the flat-by-close window.',
      );
    }

    // The cursor only reads an ascending array correctly — a misordered row
    // would cut the visible prefix short and every indicator would silently
    // compute over too few bars. `settle()` can't catch this: a past-stamped
    // straggler passes the lookahead audit cleanly.
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
   * Inclusive of a bar closing exactly at `at` — the current bar, the one the
   * strategy may act on.
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
   * Audits whatever the source served that the run never stepped to — empty
   * for a well-behaved source. A row still here after the last step is one
   * from outside the requested window, turned into a failed run rather than
   * silently dropped.
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
 * One run's mutable state, held here (not on the driver) so a driver instance
 * can be re-run without a previous run's half-open lots leaking in.
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
    // Survivorship gate first, before a single bar is stepped — fail before
    // producing trades from a biased universe.
    await assertSurvivorshipFree(
      this.deps.universe.map((instrument) => instrument.symbol),
      window,
      this.deps.registry,
    );

    // Per-run, never per-driver: rebuilt each run so a previous run's lots
    // (or a cached bar cursor) cannot leak into this one.
    const auditor = new LookaheadAuditor(this.deps.clock);
    const cursors = new Map<string, BarCursor>();
    for (const instrument of this.deps.universe) {
      cursors.set(
        instrument.symbol,
        new BarCursor(instrument.symbol, this.deps.barSource, window, auditor, this.deps.timeframe),
      );
    }

    const state: RunState = {
      config,
      records: new ReplayRecords(),
      open: new Map<string, OpenLot>(),
      pendingFills: new Map<string, Fill[]>(),
    };
    // Derived, never restated (#857) — `proxyWarmupBars` is the one place the
    // warmup width is stated; previously a separate ATR arity floor here
    // silently capped the visible prefix to the seed.
    const warmup = proxyWarmupBars(config, this.deps.timeframe);

    const stepped = await this.deps.timeline.barTimestamps(window);

    for (const at of stepped) {
      // Monotonic by construction: `advanceTo` throws on a backwards step, so
      // an unsorted timeline fails the run instead of rewinding T.
      this.deps.clock.advanceTo(at);

      for (const instrument of this.deps.universe) {
        const bars = (cursors.get(instrument.symbol) as BarCursor).visibleAt(at);
        const bar = bars[bars.length - 1];

        // No bar closing at this timestamp, or still inside warmup —
        // `computeIndicator` on a short window returns a wrong value rather
        // than erroring, so it's never evaluated.
        if (bar === undefined || bar.close_time.getTime() !== at.getTime()) continue;
        if (bars.length < warmup) continue;

        const signal = proxySignal(bars, config, this.deps.timeframe);
        const lot = state.open.get(instrument.symbol);

        // Where this bar sits in its session (#664) — null on a daily replay
        // or a venue with no close.
        const boundary = flattenBoundary(bar, this.deps.timeframe, this.deps.sessionCalendar);
        // AT LEAST ONE BAR WIDE (#664) — on a grid coarser than the flatten
        // window, no bar's open would ever fall inside it (the carry
        // assertion below would abort every run). Widening to one bar is the
        // honest reading of "be flat by close": flatten on the final bar of
        // the session.
        const flattenBeforeCloseMs = Math.max(
          this.deps.flattenBeforeCloseMs ?? DEFAULT_FLATTEN_BEFORE_CLOSE_MS,
          timeframeToMs(this.deps.timeframe),
        );
        const withinFlattenWindow =
          boundary !== null && boundary.remainingMs <= flattenBeforeCloseMs;

        if (lot !== undefined) {
          // The flat-by-close INVARIANT, asserted rather than assumed — a lot
          // still open in a later session means the flatten window never
          // opened, usually because `UsEquityRegularHoursCalendar`'s
          // hand-entered holiday/early-close tables (2026-2027 only) don't
          // know this session's real close. Throws rather than silently
          // carrying overnight, which would be a wrong number, not a failed
          // run.
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

          // Bracket first, flatten second: a stop/target already hit inside
          // the bar happened before the flatten window's clock ran out —
          // flattening it instead would book an exit at the wrong price.
          const exit =
            exitOf(lot, bar, signal) ?? (withinFlattenWindow ? flattenExit(bar) : undefined);
          if (exit !== undefined) {
            this.closeLot(state, instrument, lot, bar, bars, exit);
            state.open.delete(instrument.symbol);
          }
          // No same-bar re-entry: the lot's exit is already priced at this
          // bar, and re-entering on it would open a second lot against the
          // same bar's information.
          continue;
        }

        if (signal.direction === 'flat') continue;

        // Nothing new opens inside the flatten window — the live rule
        // (`withinFlattenWindow`, trader/decide.ts) turns the same `true`
        // into an entry skip.
        if (withinFlattenWindow) continue;

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
    }

    for (const cursor of cursors.values()) cursor.settle();

    // A lot still open at the last bar produces no `ClosedTrade` — only a
    // round-trip-to-flat is a realized record.
    return { trades: state.records, timeline: new SteppedTimeline(stepped) };
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

    // `CostModelImpl` always fills fully today; if that changes, a
    // `ClosedTrade` cannot represent a half-closed lot's `filled_size` /
    // `realized_pnl_net`. Fail loudly rather than book the fiction.
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
      // `closed_trades.close_reason` only (#793), so a flatten is 'flatten'
      // on the trade but the generic 'exit' on its fill, matching the live
      // path.
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
        // #1121: always true — every leg is priced through `CostModel.fill`
        // itself, so there's no venue report to fall back from.
        modelled_cost_charged: true,
      },
      fills,
    );
  }

  /**
   * `spread` is null (historical bars carry no bid/ask; the cost model
   * fallback-models it from volatility). The cost config must match the
   * replay resolution (#664/#875) — `spreadVolatilityCoefficient` is fitted
   * to a specific ATR, so passing the daily config to an intraday replay
   * silently flatters the spread.
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
      // Same ATR the strategy sized this lot's stop with (`proxyAtrSpec`) —
      // one spec, two call sites, no literal to drift. Until #857 this read a
      // slice one short of a converged window, so the value was a plain
      // re-seeded mean wearing Wilder's name (fixed here, with the
      // measurement).
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
 * The flat-by-close exit (#664), priced at the bar's close — the market's
 * last quoted price during the bar the position was held through. `'flatten'`
 * is `ExitReason`'s own member (#748), matching the live path's vocabulary
 * rather than collapsing into the generic `'exit'`.
 */
function flattenExit(bar: Bar): { reason: ReplayCloseReason; reference: number } {
  return { reason: 'flatten', reference: bar.close };
}

/**
 * Stop is checked before target: when a bar's range spans both, the intrabar
 * path is unknowable from OHLC alone, and target-first would be the
 * optimistic reading. Reference price is the bar's open when it already
 * gapped through the level, otherwise the level itself.
 */
function exitOf(
  lot: OpenLot,
  bar: Bar,
  signal: ProxySignal,
): { reason: ReplayCloseReason; reference: number } | undefined {
  if (lot.direction === 'long') {
    if (bar.low <= lot.stop) {
      return { reason: 'stop', reference: bar.open < lot.stop ? bar.open : lot.stop };
    }
    if (bar.high >= lot.target) {
      return { reason: 'target', reference: bar.open > lot.target ? bar.open : lot.target };
    }
  } else {
    if (bar.high >= lot.stop) {
      return { reason: 'stop', reference: bar.open > lot.stop ? bar.open : lot.stop };
    }
    if (bar.low <= lot.target) {
      return { reason: 'target', reference: bar.open < lot.target ? bar.open : lot.target };
    }
  }

  // Signal exit: priced at the close, the bar on which the signal became
  // knowable.
  if (signal.direction !== lot.direction) {
    return { reason: 'exit', reference: bar.close };
  }

  return undefined;
}
