
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

export interface ReplayBarSource {
  bars(symbol: string, window: DateRange): Bar[];
}

export interface ReplayInstrument {
  symbol: string;
  asset_class: 'crypto' | 'stocks';
  venue?: CostVenue;
}

export interface ReplayDriverDeps {
  barSource: ReplayBarSource;
  timeline: ReplayTimeline;
  registry: InstrumentRegistry;
  costModel: CostModel;
  clock: SimulatedClock;
  universe: readonly ReplayInstrument[];
  capitalPerTrade: number;
  advWindow?: number;
  timeframe: string;
  sessionCalendar: TradingCalendar;
  flattenBeforeCloseMs?: number;
}

export interface ReplayRunResult {
  trades: ReplayTradeSource;
  timeline: ReplayTimeline;
}

const DEFAULT_ADV_WINDOW = 20;

const DEFAULT_FLATTEN_BEFORE_CLOSE_MS = 5 * 60 * 1_000;

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

interface OpenLot {
  idempotency_key: string;
  side: 'buy' | 'sell';
  direction: 'long' | 'short';
  size: number;
  entry: number;
  stop: number;
  target: number;
  fees: number;
  opened_at: Date;
  session_end: Date | null;
}

class BarCursor {
  private readonly all: readonly Bar[];
  private cursor = 0;
  private readonly revealed: Bar[] = [];

  constructor(
    private readonly symbol: string,
    source: ReplayBarSource,
    window: DateRange,
    private readonly auditor: LookaheadAuditor,
    timeframe: string,
  ) {
    this.all = source.bars(symbol, window);

    const first = this.all[0];
    if (first !== undefined && first.timeframe !== timeframe) {
      throw new Error(
        `ReplayDriver: bar source served ${symbol} at '${first.timeframe}' but the driver is ` +
          `configured for '${timeframe}'. Replaying one resolution while labelling it another ` +
          'mislabels every indicator and mis-sizes the flat-by-close window.',
      );
    }

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

  settle(): void {
    for (let i = this.cursor; i < this.all.length; i++) {
      this.auditor.auditRead(`stage2_bars:${this.symbol}`, (this.all[i] as Bar).close_time);
    }
    this.cursor = this.all.length;
  }
}

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

class SteppedTimeline implements ReplayTimeline {
  constructor(private readonly stepped: readonly Date[]) {}

  async barTimestamps(window: DateRange): Promise<readonly Date[]> {
    return this.stepped.filter(
      (at) => at.getTime() >= window.start.getTime() && at.getTime() <= window.end.getTime(),
    );
  }
}

interface RunState {
  config: ProxyStrategyConfig;
  records: ReplayRecords;
  open: Map<string, OpenLot>;
  pendingFills: Map<string, Fill[]>;
}

export class ReplayDriver {
  constructor(private readonly deps: ReplayDriverDeps) {}

  async run(config: ProxyStrategyConfig, window: DateRange): Promise<ReplayRunResult> {
    await assertSurvivorshipFree(
      this.deps.universe.map((instrument) => instrument.symbol),
      window,
      this.deps.registry,
    );

    const auditor = new LookaheadAuditor(this.deps.clock);
    const cursors = this.buildCursors(auditor, window);

    const state: RunState = {
      config,
      records: new ReplayRecords(),
      open: new Map<string, OpenLot>(),
      pendingFills: new Map<string, Fill[]>(),
    };
    const warmup = proxyWarmupBars(config, this.deps.timeframe);

    const stepped = await this.deps.timeline.barTimestamps(window);

    for (const at of stepped) {
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

    for (const cursor of cursors.values()) cursor.settle();

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

    if (bar === undefined || bar.close_time.getTime() !== at.getTime()) return;
    if (bars.length < warmup) return;

    const signal = proxySignal(bars, state.config, this.deps.timeframe);
    const lot = state.open.get(instrument.symbol);

    const boundary = flattenBoundary(bar, this.deps.timeframe, this.deps.sessionCalendar);
    const flattenBeforeCloseMs = Math.max(
      this.deps.flattenBeforeCloseMs ?? DEFAULT_FLATTEN_BEFORE_CLOSE_MS,
      timeframeToMs(this.deps.timeframe),
    );
    const withinFlattenWindow = boundary !== null && boundary.remainingMs <= flattenBeforeCloseMs;

    if (lot !== undefined) {
      this.handleOpenLot(state, instrument, lot, bar, bars, signal, withinFlattenWindow);
      return;
    }

    if (signal.direction === 'flat') return;

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
    direction: 'long' | 'short',
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
        modelled_cost_charged: true,
      },
      fills,
    );
  }

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
      volatility: computeIndicator(bars.slice(-atrSpec.lookback) as Bar[], atrSpec),
      asset_class: instrument.asset_class,
      ...(instrument.venue === undefined ? {} : { venue: instrument.venue }),
      timestamp: this.deps.clock.now(),
    };
  }
}

type ReplayCloseReason = 'stop' | 'target' | 'exit' | 'flatten';

function flattenExit(bar: Bar): { reason: ReplayCloseReason; reference: number } {
  return { reason: 'flatten', reference: bar.close };
}

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

function exitOf(
  lot: OpenLot,
  bar: Bar,
  signal: ProxySignal,
): { reason: ReplayCloseReason; reference: number } | undefined {
  const bracket = lot.direction === 'long' ? longBracketExit(lot, bar) : shortBracketExit(lot, bar);
  if (bracket !== undefined) return bracket;

  if (signal.direction !== lot.direction) {
    return { reason: 'exit', reference: bar.close };
  }

  return undefined;
}
