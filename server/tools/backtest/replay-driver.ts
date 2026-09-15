/**
 * Stage 2 replay driver (ticket #243) — see
 * docs/specs/stage2-validation-execution-spec.md ("Module: Replay Driver")
 * and wayfinder map #154 (decision #158).
 *
 * Steps the mechanical proxy strategy (#242) bar-by-bar through the ingested
 * historical bars (#241) and hands the result to `EvalExecutorImpl` through
 * the ports it already declares (`ReplayTradeSource` in `eval-types.ts`,
 * `ReplayTimeline` in `types.ts`). Neither of those files, nor
 * `eval-executor.ts`, changes for this module: the driver adapts to them.
 *
 * **What this path deliberately does NOT do.** It never calls
 * `BrokerAdapter`, `Trader.decide`, `RiskManagerImpl.evaluate` or
 * `VerdictImpl.decide` — enforced structurally, by not importing any of them
 * (there is a test asserting the import list stays clean). The proxy strategy
 * is a complete stand-in for the whole pipeline here, not just for
 * Analysts/Debate: this pass validates the *harness's honesty* (costs, no
 * lookahead, survivorship), not the live gate sequence, which the Backtest
 * Harness (#88) exercises over the real stage chain. Nothing here touches
 * Execution's live write path.
 *
 * **Why fills go straight to `CostModel.fill`.** `BrokerAdapter` has no
 * flatten/cancel method, so a signal exit cannot be routed through it — and
 * routing entries through it while exits bypass it would price the two legs
 * by different models. Both legs therefore call `CostModel.fill` directly,
 * and every produced `Fill` carries the resulting `cost_breakdown` (mirroring
 * the Simulated adapter's `CostModelResult` → `Fill` mapping, shared/types.ts)
 * so `eval-executor.ts`'s `assertCostModelPriced` attestation passes without
 * this path being special-cased.
 *
 * **Gaps are not wished away.** A stop or target exit is priced against the
 * price the market actually offered: the bar's open when it already gapped
 * through the level, otherwise the level itself. Assuming a fill at the exact
 * stop through a gap is the flattering lie this whole component exists to
 * prevent. `CostModel.fill` then moves that reference adversely, as it does
 * for any fill.
 *
 * **`debate_id` on this path is synthetic.** There is no debate — it is
 * derived deterministically from the lot's idempotency key purely so the
 * `ClosedTrade` record is well-formed. Nothing here writes to `SetupStore` or
 * `DebateLogStore`, so the "exactly once per setup" join invariant
 * (cross-spec-contracts.md registry #1) is untouched by this module.
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
   * The timeframe the replayed bars are on — `'1d'`, `'1m'`, `'5m'` (#664).
   *
   * REQUIRED, not defaulted to `'1d'`. A default is how a parameter becomes
   * the thing this repo calls a "tested mechanism nothing calls": every
   * existing caller would keep compiling, keep replaying daily, and the
   * intraday path would exist only in its own test. Required, the compiler
   * enumerates every construction.
   *
   * Checked against each bar's own `Bar.timeframe` as the cursor loads it, so
   * a store serving a different resolution than the driver was told fails the
   * run instead of mislabelling every indicator and every session boundary.
   */
  timeframe: string;
  /**
   * The venue calendar this replay's session boundaries come from (#664).
   *
   * `UsEquityRegularHoursCalendar` for US equities, `AlwaysOpenCalendar` for a
   * 24/7 venue. Required for the same anti-inertness reason as `timeframe`:
   * flat-by-close (ADR-0014) is the recorded thesis, and a defaulted
   * always-open calendar would silently disable it.
   *
   * Consulted ONLY on intraday timeframes — see `flattenBoundary`.
   */
  sessionCalendar: TradingCalendar;
  /**
   * The flat-by-close window, as an offset before the session close.
   *
   * Defaults to `TRADER_CONFIG_DEFAULTS.flatten_before_close_ms`'s five
   * minutes, which is the live rule ADR-0014 records and
   * `trader/decide.ts`'s `withinFlattenWindow` enforces. Duplicated as a
   * number rather than imported from `server/pipeline/trader`: this module
   * documents that it imports nothing from the live pipeline, and a test
   * asserting the two agree is cheaper than breaking that.
   *
   * WIDENED to one bar when the timeframe is coarser than this — see `run`.
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
   * The close of the session this lot was opened in, or `null` where the
   * question does not arise (daily replay, or a venue with no close).
   *
   * Carried on the lot rather than recomputed, so the flat-by-close INVARIANT
   * can be checked directly: a lot whose bar has moved past this instant
   * survived a session close, which ADR-0014 forbids. See `run`.
   */
  session_end: Date | null;
}

/**
 * One instrument's bars for the whole run, read from the injected source
 * **once** and then revealed prefix-by-prefix as the clock steps.
 *
 * Re-reading the source on every (timestamp × instrument) step is what the
 * naive shape does, and against `Stage2HistoricalStore` that is a SQL query
 * plus a full row-to-`Bar` materialization per step — O(steps × bars) row
 * allocations for a strategy that only ever needs one more bar than it had
 * last step. The cursor collapses that to one read per instrument per run.
 *
 * It is *not* just a cache: the `LookaheadAuditor` seam is preserved exactly,
 * because the audit is what this whole component exists to keep honest.
 *
 * - Each bar is audited against `clock.now()` at the step it first becomes
 *   visible — the same point-in-time assertion the per-step read made, since
 *   a bar is only exposed once the clock has reached its `close_time`.
 * - Rows the source served *outside* the requested window are never silently
 *   dropped. They stay behind the cursor and are audited by `settle()` at the
 *   end of the run, so a misbehaving source still fails the run rather than
 *   having its extra rows quietly filtered away.
 *
 * `Bar` carries `close_time` rather than the `timestamp` field `auditRows`
 * expects, so rows are audited one at a time against that key.
 */
class BarCursor {
  /** Every bar the source served for the run window, source order preserved */
  private readonly all: readonly Bar[];
  /** Count of bars revealed so far — also the exclusive end of the visible prefix */
  private cursor = 0;
  /**
   * The visible prefix, grown in place rather than re-sliced from `this.all`
   * on every `visibleAt` call (#836, #289 H11). The previous shape returned
   * `this.all.slice(0, this.cursor)` — an O(cursor) copy — on every single
   * (instrument, timestamp) pair the outer loop visits, T*M times per run,
   * for O(T^2 * M) total; the indicator maths `proxySignal`/`marketState`
   * do downstream is already bounded by each indicator's own window
   * (`bars.slice(-window)`), so this copy was the actual quadratic cost, not
   * the indicator recompute. Pushing the newly-revealed bars onto the same
   * array each call, and returning that array by reference, makes an
   * unchanged step (no new bar to reveal) O(1) and a growing step O(1)
   * amortized.
   *
   * Sharing the array across calls is safe here specifically because every
   * caller (`run()`'s loop body) only reads from the returned reference
   * synchronously, within the same iteration, before the next `visibleAt`
   * call (for the next instrument or the next timestamp) can grow it
   * further — this module has no concurrency and nothing retains `bars`
   * past that iteration.
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

    // #664. The driver is TOLD its timeframe and the bars carry their own, so
    // the two can disagree — a store opened at '1d' handed to a driver
    // configured for '1m' is one wrong argument away at any composition root
    // Nothing downstream would notice: the indicator label is descriptive, and
    // the session-boundary maths would quietly evaluate a five-minute flatten
    // window against day bars. Checked on the first bar only, because
    // `Stage2HistoricalStore` now scopes every read to a single timeframe and
    // the ordering loop below is the only other whole-series pass — one
    // mismatched row inside an otherwise-correct series is not a failure mode
    // this seam can produce
    const first = this.all[0];
    if (first !== undefined && first.timeframe !== timeframe) {
      throw new Error(
        `ReplayDriver: bar source served ${symbol} at '${first.timeframe}' but the driver is ` +
          `configured for '${timeframe}'. Replaying one resolution while labelling it another ` +
          'mislabels every indicator and mis-sizes the flat-by-close window.',
      );
    }

    // The cursor stops at the first bar stamped after `at`, so it only reads
    // an ascending array correctly: a misordered row would cut the visible
    // prefix short and every indicator would then be computed over too few
    // bars, silently. `ReplayBarSource` documents ascending order; this is
    // that contract asserted rather than assumed, matching the module's
    // distrust-the-source posture (`settle()` cannot catch it, because a
    // past-stamped straggler passes the lookahead audit cleanly)
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
   * well-behaved source this is empty (the timeline is the union of every
   * ingested bar's close time). A row still sitting here after the last step
   * is a row from outside the requested window, and auditing it against the
   * final clock is what turns that into a failed run.
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
    // Derived, never restated (#857). This was
    // `Math.max(fastWindow, slowWindow, atrWindow + 1)` — the ATR ARITY floor,
    // which capped the visible prefix so low that both ATR slices below could
    // only ever contain the seed. Widening the slices without widening this
    // gate is the inert half of the same change; `proxyWarmupBars` is the one
    // place the width is stated
    const warmup = proxyWarmupBars(config, this.deps.timeframe);

    const stepped = await this.deps.timeline.barTimestamps(window);

    for (const at of stepped) {
      // Monotonic by construction: `advanceTo` throws on a backwards step, so
      // an unsorted timeline fails the run instead of rewinding T
      this.deps.clock.advanceTo(at);

      for (const instrument of this.deps.universe) {
        const bars = (cursors.get(instrument.symbol) as BarCursor).visibleAt(at);
        const bar = bars[bars.length - 1];

        // This instrument has no bar closing at this timestamp (the timeline
        // is the union across the universe), or is still inside its warmup —
        // `computeIndicator` on a short window returns a wrong SMA/ATR rather
        // than erroring, so a short slice is never evaluated
        if (bar === undefined || bar.close_time.getTime() !== at.getTime()) continue;
        if (bars.length < warmup) continue;

        const signal = proxySignal(bars, config, this.deps.timeframe);
        const lot = state.open.get(instrument.symbol);

        // Where this bar sits in its session (#664). `null` on a daily replay
        // and on a venue with no close, which is what keeps both of those
        // paths byte-identical to their pre-#664 behaviour
        const boundary = flattenBoundary(bar, this.deps.timeframe, this.deps.sessionCalendar);
        // AT LEAST ONE BAR WIDE (#664). The live rule is wall-clock — flatten
        // in the last five minutes before the close (trader/decide.ts). A
        // replay cannot act inside a bar, so on any grid coarser than the
        // window no bar's OPEN ever falls inside it: on the 15-minute cadence
        // ADR-0008 §2 records, the last bar of the session opens at CLOSE−15m,
        // the window never opens, the lot is held, and the carry assertion
        // below aborts the run — blaming the calendar for what is really an
        // arithmetic mismatch between the window and the bar size. Widening to
        // one bar is the honest bar-replay reading of "be flat by close":
        // flatten on the final bar of the session. `'1m'` and `'5m'` are
        // unchanged (`max(5min, 1min) = 5min`)
        const flattenBeforeCloseMs = Math.max(
          this.deps.flattenBeforeCloseMs ?? DEFAULT_FLATTEN_BEFORE_CLOSE_MS,
          timeframeToMs(this.deps.timeframe),
        );
        const withinFlattenWindow =
          boundary !== null && boundary.remainingMs <= flattenBeforeCloseMs;

        if (lot !== undefined) {
          // The flat-by-close INVARIANT, asserted rather than assumed
          //
          // Reaching a bar in a LATER session with a lot still open means the
          // flatten window never opened on the session that lot belongs to —
          // and the known cause is a calendar that does not know the session's
          // real close. `UsEquityRegularHoursCalendar`'s holiday and
          // early-close tables are HAND-ENTERED and currently cover 2026-2027
          // only, so a replay of, say, 25 November 2016 (a 13:00 half-day)
          // gets a phantom 16:00 close, prints no bar inside [15:55, 16:00),
          // and carries the position overnight
          //
          // Throwing is this repo's own posture for exactly this gap:
          // `#closeMinutesFor` throws past its table rather than assuming a
          // normal close. Silently carrying overnight would produce a
          // flat-by-close backtest that is not flat by close, which is a
          // wrong NUMBER rather than a failed run — the worse of the two
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

          // Bracket first, flatten second: a stop or target that the bar's
          // range already went through happened INSIDE the bar, before the
          // flatten window's clock ran out at its open. Flattening a lot the
          // market had already stopped out would book an exit at the wrong
          // price, in the flattering direction
          const exit =
            exitOf(lot, bar, signal) ?? (withinFlattenWindow ? flattenExit(bar) : undefined);
          if (exit !== undefined) {
            this.closeLot(state, instrument, lot, bar, bars, exit);
            state.open.delete(instrument.symbol);
          }
          // No same-bar re-entry: the lot's exit is already priced at this
          // bar, and re-entering on it would open a second lot against the
          // same bar's information
          continue;
        }

        if (signal.direction === 'flat') continue;

        // Nothing new opens inside the flatten window — the live rule
        // (`withinFlattenWindow` in trader/decide.ts) turns the same `true`
        // into an entry skip. An entry here would be flattened on the next bar
        // at best, and carried overnight at worst
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

    // Anything the source served that the run never stepped to is audited
    // now, against the final clock — a source that ignored the requested
    // window fails the run instead of having its extra rows silently dropped
    for (const cursor of cursors.values()) cursor.settle();

    // A lot still open at the last bar produces no `ClosedTrade`: only a
    // round-trip-to-flat is a realized record (shared/types.ts), and marking
    // it out at the final close would invent an exit no cost model priced
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

    // `CostModelResult.filled_size` "may be < requested size in principle"
    // (types.ts); `CostModelImpl` always fills fully today. If that ever
    // changes, a `ClosedTrade` cannot represent the half-closed lot — its
    // `filled_size` and `realized_pnl_net` would both describe a round-trip
    // that did not happen. Fail loudly rather than book the fiction.
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
      // `closed_trades.close_reason`, NOT `fills.leg` (#793). So a flatten is
      // recorded on the trade as `'flatten'` and on its fill as the generic
      // `'exit'`, which is what the live path does too: a flatten produces an
      // `intent_type: 'exit'` intent carrying `exit_reason: 'flatten'`
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
        // #1121: always true here — the replay prices EVERY leg through
        // `CostModel.fill` itself (`result.cost_breakdown.commission` is what
        // `fees_total` above is built from), so there is no venue report to
        // fall back from and no uncharged leg to record
        modelled_cost_charged: true,
      },
      fills,
    );
  }

  /**
   * The bar's market context. `spread` is null by design: historical OHLCV
   * bars carry no bid/ask, so the cost model fallback-models the spread from
   * volatility (cross-spec OPEN-GAP-A). `volatility` is the same ATR the
   * strategy sized its stop with, and `adv` the rolling mean bar volume.
   *
   * **The cost config must match the replay resolution (#664, fixed by #875).**
   * `spreadVolatilityCoefficient` is a ratio of measured spread to ATR14, so it
   * is only meaningful against the ATR of the bars it was fitted on.
   * `costConfigFor(timeframe)` (run-stage2.ts) now selects a 1-minute fit for
   * intraday runs and keeps `CALIBRATED_COST_CONFIG` for daily ones; a caller
   * passing `CALIBRATED_COST_CONFIG` to an intraday replay by hand still gets
   * the daily-fitted ratio and the flattering spread that comes with it.
   *
   * What the recalibration did NOT change: measured at 1m, the modelled raw
   * half-spread stays BELOW `STRUCTURAL_MIN_HALF_SPREAD_RATE` for every symbol
   * sampled, so the charged spread is the floor either way and the repricing
   * arrives entirely through the unfloored slippage term. Do not read a change
   * in this coefficient as a change in what a fill is charged.
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
      // The same ATR the strategy sized this lot's stop with — one volatility
      // estimate, so the cost model and the stop cannot disagree about it
      // Both now read the CONVERGED window (#857) via the shared
      // `proxyAtrSpec`, which is also what keeps that "same ATR" claim true:
      // one spec, two call sites, no literal to drift
      //
      // Until #857 this was `slice(-(config.atrWindow + 1))` with
      // `params: {}`, so `atr()`'s true-range array was exactly `atrWindow`
      // long, `trueRanges.slice(period)` was always empty, and the value was
      // a plain re-seeded mean wearing Wilder's name. #836/#289 H11 found
      // that while investigating a rolling accumulator here and correctly
      // did NOT fix it — a repricing of every backtest number does not belong
      // inside a perf-only ticket. It is fixed here, with the measurement, in
      // its own
      //
      // The spec's `timeframe` is the replay's OWN (#664) — a literal `'1d'`
      // here was one of the four hard-coded sites that ticket removed, and
      // the most silent: descriptive rather than selecting (`computeIndicator`
      // runs on a slice the caller already holds, #315), so a wrong label
      // produces no error, just a false record of which bars the cost model's
      // volatility was measured on
      volatility: computeIndicator(bars.slice(-atrSpec.lookback) as Bar[], atrSpec),
      asset_class: instrument.asset_class,
      ...(instrument.venue === undefined ? {} : { venue: instrument.venue }),
      timestamp: this.deps.clock.now(),
    };
  }
}

/**
 * #793: this proxy replay models exactly three exits — a bracket hit
 * ('stop'/'target') or the signal turning ('exit', the pre-#748 shape). It
 * has no `flatten_submissions` journal and no `OrderIntent.metadata` to read
 * an `ExitReason` from, so it never produces 'flatten' | 'signal_decay' |
 * 'direction_flip' — a narrower type than `ClosedTrade['close_reason']`
 * (which now also carries those three) rather than reusing it, so a fill's
 * `leg` (unaffected by migration 0031 — `fills.leg` keeps its original four
 * values) can still be assigned `exit.reason` directly.
 */
type ReplayCloseReason = 'stop' | 'target' | 'exit' | 'flatten';

/**
 * The flat-by-close exit (#664), priced at the bar's close.
 *
 * The close is the honest reference: the flatten window opened at this bar's
 * OPEN, so the position was held through the bar and the market's last quoted
 * price for it is the close. `CostModel.fill` then moves that adversely, as it
 * does for every fill, so a flatten is not a free exit.
 *
 * `'flatten'` is `ExitReason`'s own member (shared/types/records.ts, #748) —
 * time, not price or signal — so the replay's close reason vocabulary matches
 * the live path's rather than collapsing a mandatory session-close exit into
 * the generic `'exit'` a signal turn produces.
 */
function flattenExit(bar: Bar): { reason: ReplayCloseReason; reference: number } {
  return { reason: 'flatten', reference: bar.close };
}

/**
 * Which exit, if any, this bar produces — and the reference price it is
 * priced against.
 *
 * Stop is checked before target: when a single bar's range spans both levels,
 * the intrabar path is unknowable from OHLC alone, and assuming the target
 * came first is the optimistic reading.
 *
 * The reference is the bar's open when the open already gapped through the
 * level, otherwise the level itself — the price the market actually offered,
 * never an assumed fill at a level that was never available.
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

  // Signal exit: the trend no longer favors the side the lot is on. Priced at
  // the close — the bar on which the signal became knowable
  if (signal.direction !== lot.direction) {
    return { reason: 'exit', reference: bar.close };
  }

  return undefined;
}
