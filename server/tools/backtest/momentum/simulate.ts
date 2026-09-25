import type { DailyBar, Side } from '../../../pipeline/momentum/index.js';
import {
  adjustedQuantity,
  alpacaFillCost,
  annualisedVolatility,
  averageTrueRange,
  crossSectionalTopK,
  equalWeights,
  inverseVolatilityWeights,
  LossBudget,
  neverMovedUp,
  restingStopLevel,
  saxoCustodyAccrual,
  saxoFillCost,
  stopFillPrice,
  stopTriggered,
  timeSeriesTrend,
  trailingReturn,
  wholeShares,
} from '../../../pipeline/momentum/index.js';
import type { BookFx } from './fx.js';
import type { TrialConfig, Venue } from './grid.js';
import type { AlignedMarket } from './market.js';
import { monthEndIndices, yearOf } from './market.js';

export type Role = 'strategy' | 'benchmark';

export interface BookConfig {
  readonly startCapitalGbp: number;
  readonly wholeShares: boolean;
  readonly fx: BookFx;
}

export interface VenueCosts {
  readonly venue: Venue;
  readonly halfSpreadBps: (symbol: string) => number;
}

export type UniverseAt = (decisionDate: string) => readonly string[];

export interface SimulationInput {
  readonly market: AlignedMarket;
  readonly universe: UniverseAt;
  readonly config: TrialConfig;
  readonly role: Role;
  readonly book: BookConfig;
  readonly costs: VenueCosts;
  readonly evaluationStartIndex: number;
}

export type FillReason = 'rebalance' | 'stop' | 'delisted' | 'halt';

export interface FillRecord {
  readonly date: string;
  readonly symbol: string;
  readonly side: Side;
  readonly quantity: number;
  readonly price: number;
  readonly notional: number;
  readonly cost: number;
  readonly reason: FillReason;
}

export interface BudgetDayCounts {
  half: number;
  quarter: number;
  halted: number;
  capBlocked: number;
}

export interface SimulationResult {
  readonly dates: readonly string[];
  readonly equity: readonly number[];
  readonly returns: readonly number[];
  readonly fills: readonly FillRecord[];
  readonly stopHits: number;
  readonly skippedFills: number;
  readonly zeroShareTargets: number;
  readonly totalCost: number;
  readonly custodyCost: number;
  readonly budgetDays: BudgetDayCounts;
  readonly rebalances: number;
}

interface Position {
  quantity: number;
  stop: number | undefined;
}

interface Order {
  readonly symbol: string;
  readonly targetUnits: number | undefined;
  readonly targetCash: number | undefined;
  readonly reason: FillReason;
}

export function simulate(input: SimulationInput): SimulationResult {
  return new Simulation(input).run();
}

class Simulation {
  private readonly market: AlignedMarket;
  private readonly calendar: readonly string[];
  private readonly decisionDays: ReadonlySet<number>;
  private readonly budget: LossBudget;
  private readonly positions = new Map<string, Position>();
  private readonly fills: FillRecord[] = [];
  private readonly equity: number[] = [];
  private readonly dates: string[] = [];
  private readonly budgetDays: BudgetDayCounts = { half: 0, quarter: 0, halted: 0, capBlocked: 0 };
  private cash: number;
  private pending: Order[] = [];
  private stopHits = 0;
  private skippedFills = 0;
  private zeroShareTargets = 0;
  private totalCost = 0;
  private custodyCost = 0;
  private rebalances = 0;
  private halted = false;
  private entriesBlocked = false;
  private sizeMultiplier = 1;

  constructor(private readonly input: SimulationInput) {
    this.market = input.market;
    this.calendar = input.market.calendar;
    this.decisionDays = new Set(monthEndIndices(this.calendar));
    this.budget = new LossBudget(input.book.startCapitalGbp);
    this.cash = input.book.startCapitalGbp * this.rate(input.evaluationStartIndex);
    if (!this.decisionDays.has(input.evaluationStartIndex)) {
      throw new Error(
        `simulate: evaluationStartIndex ${input.evaluationStartIndex} is not a month-end decision day`,
      );
    }
  }

  run(): SimulationResult {
    const start = this.input.evaluationStartIndex;
    this.equity.push(this.cash);
    this.dates.push(this.calendar[start] as string);
    this.decide(start);
    for (let index = start + 1; index < this.calendar.length; index++) this.step(index);
    return this.result();
  }

  private step(index: number): void {
    this.resetYearIfNeeded(index);
    this.processStops(index);
    this.processDelistings(index);
    this.fillPending(index);
    this.accrueCustody(index);
    const equity = this.markToMarket(index);
    this.equity.push(equity);
    this.dates.push(this.calendar[index] as string);
    this.updateBudget(index, equity);
    this.decide(index);
  }

  private rate(index: number): number {
    return this.input.book.fx.usdPerGbpFor(yearOf(this.calendar[index] as string));
  }

  private toGbp(amount: number, index: number): number {
    return amount / this.rate(index);
  }

  private resetYearIfNeeded(index: number): void {
    const previous = this.calendar[index - 1] as string;
    const current = this.calendar[index] as string;
    if (yearOf(previous) === yearOf(current)) return;
    const priorClose = this.equity[this.equity.length - 1] as number;
    this.budget.resetYear(this.toGbp(priorClose, index));
    this.halted = false;
  }

  private updateBudget(index: number, equity: number): void {
    const previous = this.equity[this.equity.length - 2] as number;
    const state = this.budget.markClose(this.toGbp(equity, index), this.toGbp(previous, index));
    this.sizeMultiplier = state.sizeMultiplier;
    this.entriesBlocked = state.entriesBlockedAtNextFill;
    if (state.halted && !this.halted) {
      this.halted = true;
      this.pending = this.exitAllOrders('halt');
    }
    if (state.halted) this.budgetDays.halted++;
    else if (state.sizeMultiplier === 0.25) this.budgetDays.quarter++;
    else if (state.sizeMultiplier === 0.5) this.budgetDays.half++;
    if (state.entriesBlockedAtNextFill && !state.halted) this.budgetDays.capBlocked++;
  }

  private decide(index: number): void {
    if (this.halted || !this.decisionDays.has(index)) return;
    this.rebalances++;
    const weights = this.targetWeights(index);
    const equity = this.equity[this.equity.length - 1] as number;
    this.pending = this.ordersFor(index, weights, equity);
  }

  private targetWeights(index: number): Map<string, number> {
    const { config, role } = this.input;
    const date = this.calendar[index] as string;
    const eligible = this.input
      .universe(date)
      .filter(
        (symbol) =>
          this.market.has(symbol) && this.market.coverageOk(symbol, index, config.lookbackDays),
      );
    return config.family === 'time-series-trend'
      ? this.timeSeriesWeights(eligible, index, role)
      : this.crossSectionalWeights(eligible, index, role);
  }

  private timeSeriesWeights(
    eligible: readonly string[],
    index: number,
    role: Role,
  ): Map<string, number> {
    const { config } = this.input;
    const volatilities = new Map<string, number>();
    for (const symbol of eligible) {
      const long = role === 'benchmark' || this.trend(symbol, index) === 'long';
      if (!long) continue;
      const volatility = this.recentVolatility(symbol, index, config.volWindowDays ?? 60);
      if (volatility !== undefined) volatilities.set(symbol, volatility);
    }
    return inverseVolatilityWeights(volatilities, config.targetVolatility ?? 0.1, config.grossCap);
  }

  private crossSectionalWeights(
    eligible: readonly string[],
    index: number,
    role: Role,
  ): Map<string, number> {
    const { config } = this.input;
    if (role === 'benchmark') return equalWeights(eligible, config.grossCap);
    const scores = new Map<string, number>();
    for (const symbol of eligible) {
      const score = this.trailing(symbol, index);
      if (score !== undefined) scores.set(symbol, score);
    }
    return equalWeights(crossSectionalTopK(scores, config.topK ?? 10), config.grossCap);
  }

  private trailing(symbol: string, index: number): number | undefined {
    return trailingReturn(
      (calendarIndex) => this.market.closeAtOrBefore(symbol, calendarIndex),
      index,
      this.input.config,
    );
  }

  private trend(symbol: string, index: number): 'long' | 'flat' | undefined {
    const trailing = this.trailing(symbol, index);
    return trailing === undefined ? undefined : timeSeriesTrend(trailing);
  }

  private recentVolatility(symbol: string, index: number, window: number): number | undefined {
    const barIndex = this.market.barIndexAt(symbol, index);
    if (barIndex === undefined || barIndex - window < 0) return undefined;
    const bars = this.market.bars(symbol);
    const returns: number[] = [];
    for (let at = barIndex - window + 1; at <= barIndex; at++) {
      const current = bars[at] as DailyBar;
      const previous = bars[at - 1] as DailyBar;
      returns.push(current.close / previous.close - 1);
    }
    const volatility = annualisedVolatility(returns);
    return volatility > 0 ? volatility : undefined;
  }

  private ordersFor(index: number, weights: ReadonlyMap<string, number>, equity: number): Order[] {
    const symbols = new Set([...weights.keys(), ...this.positions.keys()]);
    const orders: Order[] = [];
    for (const symbol of [...symbols].sort()) {
      const order = this.orderFor(symbol, index, weights.get(symbol) ?? 0, equity);
      if (order !== undefined) orders.push(order);
    }
    return orders;
  }

  private orderFor(
    symbol: string,
    index: number,
    weight: number,
    equity: number,
  ): Order | undefined {
    const targetCash = weight * this.sizeMultiplier * equity;
    return this.input.book.wholeShares
      ? this.wholeShareOrder(symbol, index, targetCash)
      : this.fractionalOrder(symbol, index, targetCash);
  }

  private fractionalOrder(symbol: string, index: number, targetCash: number): Order | undefined {
    const held = this.positions.get(symbol);
    const heldValue = held === undefined ? 0 : this.value(symbol, index, held);
    if (this.entriesBlocked && targetCash > heldValue) return undefined;
    return { symbol, targetUnits: undefined, targetCash, reason: 'rebalance' };
  }

  private wholeShareOrder(symbol: string, index: number, targetCash: number): Order | undefined {
    const bar = this.market.barAtOrBefore(symbol, index);
    if (bar === undefined) return undefined;
    const targetShares = wholeShares(targetCash, bar.rawClose);
    if (targetCash > 0 && targetShares === 0) this.zeroShareTargets++;
    const held = this.positions.get(symbol);
    const heldShares =
      held === undefined ? 0 : Math.round((held.quantity * bar.close) / bar.rawClose);
    if (this.entriesBlocked && targetShares > heldShares) return undefined;
    const targetUnits = adjustedQuantity(targetShares, bar.rawClose, bar.close);
    return { symbol, targetUnits, targetCash: undefined, reason: 'rebalance' };
  }

  private value(symbol: string, index: number, position: Position): number {
    return position.quantity * (this.market.closeAtOrBefore(symbol, index) ?? 0);
  }

  private exitAllOrders(reason: FillReason): Order[] {
    return [...this.positions.keys()].sort().map((symbol) => ({
      symbol,
      targetUnits: this.input.book.wholeShares ? 0 : undefined,
      targetCash: this.input.book.wholeShares ? undefined : 0,
      reason,
    }));
  }

  private processStops(index: number): void {
    for (const [symbol, position] of [...this.positions].sort(([a], [b]) => a.localeCompare(b))) {
      if (position.stop === undefined) continue;
      const bar = this.market.barAt(symbol, index);
      if (bar === undefined || !stopTriggered(bar, position.stop)) continue;
      const halfSpread = this.input.costs.halfSpreadBps(symbol) / 10_000;
      const price = stopFillPrice(bar, position.stop, halfSpread);
      this.execute(index, symbol, -position.quantity, price, 'stop', bar, 0);
      this.stopHits++;
      this.pending = this.pending.filter((order) => order.symbol !== symbol);
    }
  }

  private processDelistings(index: number): void {
    for (const [symbol, position] of [...this.positions].sort(([a], [b]) => a.localeCompare(b))) {
      // A gap past the carry-forward window is a delisting: in the Alpaca set every such gap is a
      // ticker retired and later reused (FB, POM, BBBY), so waiting would mark the line at £0
      const gone =
        this.market.seriesEndedBefore(symbol, index) ||
        this.market.barAtOrBefore(symbol, index) === undefined;
      if (!gone) continue;
      const bar = this.market.lastBarAtOrBefore(symbol, index - 1) as DailyBar;
      this.execute(
        index,
        symbol,
        -position.quantity,
        bar.close,
        'delisted',
        bar,
        this.halfSpread(symbol),
      );
      this.pending = this.pending.filter((order) => order.symbol !== symbol);
    }
  }

  private halfSpread(symbol: string): number {
    return this.input.costs.halfSpreadBps(symbol);
  }

  private fillPending(index: number): void {
    const orders = this.pending;
    const carried: Order[] = [];
    const sells: Order[] = [];
    const buys: Order[] = [];
    for (const order of orders) {
      const bar = this.market.barAt(order.symbol, index);
      if (bar === undefined) {
        this.skippedFills++;
        // Nothing re-issues a halt exit while halted, so a dropped one would hold the line to 1 January
        if (order.reason === 'halt') carried.push(order);
        continue;
      }
      const delta = this.deltaFor(order, bar);
      if (delta === undefined) continue;
      (delta < 0 ? sells : buys).push(order);
    }
    this.pending = carried;
    for (const order of sells) this.fillOrder(order, index);
    for (const order of buys) this.fillOrder(order, index);
  }

  private deltaFor(order: Order, bar: DailyBar): number | undefined {
    const held = this.positions.get(order.symbol)?.quantity ?? 0;
    const target =
      order.targetCash !== undefined
        ? order.targetCash / bar.close
        : this.wholeShareQuantity(order.targetUnits ?? 0, bar);
    const delta = target - held;
    return Math.abs(delta) * bar.close < 0.01 ? undefined : delta;
  }

  private wholeShareQuantity(targetUnits: number, bar: DailyBar): number {
    const shares = Math.round((targetUnits * bar.close) / bar.rawClose);
    return adjustedQuantity(shares, bar.rawClose, bar.close);
  }

  private fillOrder(order: Order, index: number): void {
    const bar = this.market.barAt(order.symbol, index) as DailyBar;
    let delta = this.deltaFor(order, bar) ?? 0;
    if (delta === 0) return;
    if (delta > 0) delta = this.affordable(delta, bar);
    if (delta === 0) return;
    this.execute(
      index,
      order.symbol,
      delta,
      bar.close,
      order.reason,
      bar,
      this.halfSpread(order.symbol),
    );
  }

  private affordable(delta: number, bar: DailyBar): number {
    const notional = delta * bar.close;
    if (notional <= this.cash) return delta;
    if (!this.input.book.wholeShares) return Math.max(0, this.cash / bar.close);
    const shares = wholeShares(this.cash, bar.rawClose);
    if (shares === 0) this.skippedFills++;
    return shares === 0 ? 0 : Math.min(delta, adjustedQuantity(shares, bar.rawClose, bar.close));
  }

  private execute(
    index: number,
    symbol: string,
    delta: number,
    price: number,
    reason: FillReason,
    bar: DailyBar,
    halfSpreadBps: number,
  ): void {
    const side: Side = delta > 0 ? 'buy' : 'sell';
    const notional = Math.abs(delta) * price;
    const rawShares = (Math.abs(delta) * bar.close) / bar.rawClose;
    const cost = this.fillCost(side, notional, rawShares, halfSpreadBps);
    this.cash -= delta * price + cost;
    this.totalCost += cost;
    this.fills.push({
      date: this.calendar[index] as string,
      symbol,
      side,
      quantity: Math.abs(delta),
      price,
      notional,
      cost,
      reason,
    });
    this.applyToPosition(index, symbol, delta, price, bar, side);
  }

  private fillCost(side: Side, notional: number, shares: number, halfSpreadBps: number): number {
    const fill = { side, notional, shares, halfSpreadBps };
    return this.input.costs.venue === 'lse' ? saxoFillCost(fill) : alpacaFillCost(fill);
  }

  private applyToPosition(
    index: number,
    symbol: string,
    delta: number,
    price: number,
    bar: DailyBar,
    side: Side,
  ): void {
    const existing = this.positions.get(symbol);
    const quantity = (existing?.quantity ?? 0) + delta;
    if (quantity * bar.close < 0.01) {
      this.positions.delete(symbol);
      return;
    }
    const stop =
      side === 'buy' ? this.stopAfterBuy(index, symbol, price, existing?.stop) : existing?.stop;
    this.positions.set(symbol, { quantity, stop });
  }

  private stopAfterBuy(
    index: number,
    symbol: string,
    entryPrice: number,
    existing: number | undefined,
  ): number | undefined {
    const stopConfig = this.input.config.stop;
    if (stopConfig === null) return undefined;
    const bars = this.market.bars(symbol);
    const barIndex = this.market.barIndexAt(symbol, index);
    const atr =
      barIndex === undefined ? undefined : averageTrueRange(bars, barIndex, stopConfig.atrWindow);
    if (atr === undefined) return existing;
    return neverMovedUp(existing, restingStopLevel(entryPrice, atr, stopConfig.atrMultiple));
  }

  private accrueCustody(index: number): void {
    if (this.input.costs.venue !== 'lse') return;
    let invested = 0;
    for (const [symbol, position] of this.positions)
      invested += this.value(symbol, index - 1, position);
    const days = calendarDaysBetween(
      this.calendar[index - 1] as string,
      this.calendar[index] as string,
    );
    const accrual = saxoCustodyAccrual(invested, days);
    this.cash -= accrual;
    this.custodyCost += accrual;
    this.totalCost += accrual;
  }

  private markToMarket(index: number): number {
    let total = this.cash;
    for (const [symbol, position] of this.positions) total += this.value(symbol, index, position);
    return total;
  }

  private result(): SimulationResult {
    const returns: number[] = [];
    for (let index = 1; index < this.equity.length; index++) {
      returns.push((this.equity[index] as number) / (this.equity[index - 1] as number) - 1);
    }
    return {
      dates: this.dates,
      equity: this.equity,
      returns,
      fills: this.fills,
      stopHits: this.stopHits,
      skippedFills: this.skippedFills,
      zeroShareTargets: this.zeroShareTargets,
      totalCost: this.totalCost,
      custodyCost: this.custodyCost,
      budgetDays: this.budgetDays,
      rebalances: this.rebalances,
    };
  }
}

export function calendarDaysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
