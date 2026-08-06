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

import type { Bar } from '../market-data-service/index.js';
import { computeIndicator } from '../market-data-service/index.js';
import type { ClosedTrade, Fill, SimulatedClock } from '../shared/index.js';
import type { ReplayTradeSource } from './eval-types.js';
import { LookaheadAuditor } from './lookahead.js';
import { type ProxySignal, type ProxyStrategyConfig, proxySignal } from './proxy-strategy.js';
import type { CostModel, MarketState, ReplayTimeline } from './types.js';
import { assertSurvivorshipFree, type DateRange, type InstrumentRegistry } from './universe.js';

/** The audited source of historical bars — `Stage2HistoricalStore` (#241) in production. */
export interface ReplayBarSource {
  /** Bars for `symbol` with `close_time` inside `window` (inclusive), ascending. */
  bars(symbol: string, window: DateRange): Bar[];
}

/** One replayed instrument. `asset_class` selects the cost model's parameter set. */
export interface ReplayInstrument {
  symbol: string;
  asset_class: 'crypto' | 'stocks';
}

export interface ReplayDriverDeps {
  barSource: ReplayBarSource;
  /** The bar timestamps to step — `Stage2HistoricalStore` implements this too. */
  timeline: ReplayTimeline;
  registry: InstrumentRegistry;
  costModel: CostModel;
  /** Stepped bar-by-bar; the `LookaheadAuditor`'s reference for "now". */
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
}

export interface ReplayRunResult {
  trades: ReplayTradeSource;
  timeline: ReplayTimeline;
}

const DEFAULT_ADV_WINDOW = 20;

/** An open lot, held between bars until an exit prices it. */
interface OpenLot {
  idempotency_key: string;
  side: 'buy' | 'sell';
  direction: 'long' | 'short';
  size: number;
  /** `CostModelResult.fill_price` of the entry — never an assumed level. */
  entry: number;
  /** The INITIAL protective stop: the denominator of R (shared/types.ts). */
  stop: number;
  target: number;
  fees: number;
  opened_at: Date;
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
  /** Every bar the source served for the run window, source order preserved. */
  private readonly all: readonly Bar[];
  /** Count of bars revealed so far — also the exclusive end of the visible prefix. */
  private cursor = 0;

  constructor(
    private readonly symbol: string,
    source: ReplayBarSource,
    window: DateRange,
    private readonly auditor: LookaheadAuditor,
  ) {
    this.all = source.bars(symbol, window);

    // The cursor stops at the first bar stamped after `at`, so it only reads
    // an ascending array correctly: a misordered row would cut the visible
    // prefix short and every indicator would then be computed over too few
    // bars, silently. `ReplayBarSource` documents ascending order; this is
    // that contract asserted rather than assumed, matching the module's
    // distrust-the-source posture (`settle()` cannot catch it, because a
    // past-stamped straggler passes the lookahead audit cleanly).
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
      this.cursor++;
    }
    return this.all.slice(0, this.cursor);
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

/** In-memory `ReplayTradeSource` over one run's hand-constructed records. */
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
  /** Entry fills, held until their lot closes and the `ClosedTrade` is built. */
  pendingFills: Map<string, Fill[]>;
}

export class ReplayDriver {
  constructor(private readonly deps: ReplayDriverDeps) {}

  async run(config: ProxyStrategyConfig, window: DateRange): Promise<ReplayRunResult> {
    // Survivorship gate first, before a single bar is stepped — a biased
    // universe invalidates the run, so fail before producing trades from it.
    await assertSurvivorshipFree(
      this.deps.universe.map((instrument) => instrument.symbol),
      window,
      this.deps.registry,
    );

    // Per-run, never per-driver: `RunState` is rebuilt each run so a previous
    // run's lots cannot leak into this one, and a cached bar cursor held on
    // the driver would leak the same way.
    const auditor = new LookaheadAuditor(this.deps.clock);
    const cursors = new Map<string, BarCursor>();
    for (const instrument of this.deps.universe) {
      cursors.set(
        instrument.symbol,
        new BarCursor(instrument.symbol, this.deps.barSource, window, auditor),
      );
    }

    const state: RunState = {
      config,
      records: new ReplayRecords(),
      open: new Map<string, OpenLot>(),
      pendingFills: new Map<string, Fill[]>(),
    };
    const warmup = Math.max(config.fastWindow, config.slowWindow, config.atrWindow + 1);

    const stepped = await this.deps.timeline.barTimestamps(window);

    for (const at of stepped) {
      // Monotonic by construction: `advanceTo` throws on a backwards step, so
      // an unsorted timeline fails the run instead of rewinding T.
      this.deps.clock.advanceTo(at);

      for (const instrument of this.deps.universe) {
        const bars = (cursors.get(instrument.symbol) as BarCursor).visibleAt(at);
        const bar = bars[bars.length - 1];

        // This instrument has no bar closing at this timestamp (the timeline
        // is the union across the universe), or is still inside its warmup —
        // `computeIndicator` on a short window returns a wrong SMA/ATR rather
        // than erroring, so a short slice is never evaluated.
        if (bar === undefined || bar.close_time.getTime() !== at.getTime()) continue;
        if (bars.length < warmup) continue;

        const signal = proxySignal(bars, config);
        const lot = state.open.get(instrument.symbol);

        if (lot !== undefined) {
          const exit = exitOf(lot, bar, signal);
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

        state.open.set(
          instrument.symbol,
          this.openLot(state, instrument, bar, bars, signal, signal.direction),
        );
      }
    }

    // Anything the source served that the run never stepped to is audited
    // now, against the final clock — a source that ignored the requested
    // window fails the run instead of having its extra rows silently dropped.
    for (const cursor of cursors.values()) cursor.settle();

    // A lot still open at the last bar produces no `ClosedTrade`: only a
    // round-trip-to-flat is a realized record (shared/types.ts), and marking
    // it out at the final close would invent an exit no cost model priced.
    return { trades: state.records, timeline: new SteppedTimeline(stepped) };
  }

  private openLot(
    state: RunState,
    instrument: ReplayInstrument,
    bar: Bar,
    bars: readonly Bar[],
    signal: ProxySignal,
    /** The signal's direction, narrowed by the caller's flat check. */
    direction: 'long' | 'short',
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
        broker_fill_id: `${idempotency_key}:entry`,
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
    };
  }

  private closeLot(
    state: RunState,
    instrument: ReplayInstrument,
    lot: OpenLot,
    bar: Bar,
    bars: readonly Bar[],
    exit: { reason: ClosedTrade['close_reason']; reference: number },
  ): void {
    // Closing side is the opposite of the entry's, so the cost model moves the
    // price adversely against the exit — not in its favor.
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
      broker_fill_id: `${lot.idempotency_key}:${exit.reason}`,
      leg: exit.reason,
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
      },
      fills,
    );
  }

  /**
   * The bar's market context. `spread` is null by design: daily historical
   * bars carry no bid/ask, so the cost model fallback-models the spread from
   * volatility (cross-spec OPEN-GAP-A). `volatility` is the same ATR the
   * strategy sized its stop with, and `adv` the rolling mean bar volume.
   */
  private marketState(
    config: ProxyStrategyConfig,
    instrument: ReplayInstrument,
    bar: Bar,
    bars: readonly Bar[],
    mid: number,
  ): MarketState {
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
      // estimate, so the cost model and the stop cannot disagree about it.
      volatility: computeIndicator(bars.slice(-(config.atrWindow + 1)) as Bar[], {
        indicator: 'atr',
        params: {},
        // Daily bars — this is the Stage 2 replay grid, ingested as daily
        // aggregates. Descriptive rather than selecting: `computeIndicator`
        // runs on a slice the caller already holds, so the field records
        // WHICH bars these are (#315).
        timeframe: '1d',
        lookback: config.atrWindow,
      }),
      asset_class: instrument.asset_class,
      timestamp: this.deps.clock.now(),
    };
  }
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
): { reason: ClosedTrade['close_reason']; reference: number } | undefined {
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
  // the close — the bar on which the signal became knowable.
  if (signal.direction !== lot.direction) {
    return { reason: 'exit', reference: bar.close };
  }

  return undefined;
}
