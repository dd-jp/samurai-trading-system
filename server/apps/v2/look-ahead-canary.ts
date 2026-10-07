import type { MarketData, Sleeve, SleeveDecision } from '../../../contracts/index.js';
import type { BarSeries } from '../../shared/index.js';
import type { BacktestTrial } from './backtest.js';
import type { BarsSource } from './data/index.js';

function delayed<T extends { readonly date: string }>(bars: readonly T[]): T[] {
  return bars.slice(0, -1).map((bar, index) => ({ ...bar, date: (bars[index + 1] as T).date }));
}

// David, 2026-10-07 on #1747 (ruling 3): deciding on a session, the sleeve sees the bars up to the
// session before. Each bar takes its successor's date, so every read made "before D" ends one
// bar earlier and the series still ends on the decision day for the coverage check
export function delayedBars(source: BarsSource): BarsSource {
  const cache = new WeakMap<BarSeries, BarSeries>();
  return {
    load: (symbol) => {
      const series = source.load(symbol);
      if (series === undefined) return undefined;
      const hit = cache.get(series) ?? { ...series, bars: delayed(series.bars) };
      cache.set(series, hit);
      return hit;
    },
    noteWindow: (symbol, bars) => source.noteWindow?.(symbol, bars + 1),
  };
}

export function delayedMarket(market: MarketData): MarketData {
  return {
    lastBarBefore: (instrument, tradingDate) =>
      delayed(market.barsBefore(instrument, tradingDate, 2)).at(-1),
    barsBefore: (instrument, tradingDate, count) =>
      count < 1 ? [] : delayed(market.barsBefore(instrument, tradingDate, count + 1)),
    gbpUsdAtYearStart: (year) => market.gbpUsdAtYearStart(year),
    gbpUsdYearStartFixDate: (year) => market.gbpUsdYearStartFixDate?.(year),
  };
}

function moved(level: number | undefined, delta: number): number | undefined {
  return level === undefined ? undefined : level + delta;
}

// Ruling 3 keeps the fill at the session's own close and the backtest guard unchanged, so an
// entry moves to the quoted close and its levels move with it, keeping the sleeve's distances
function atQuote(decision: SleeveDecision, quote: number | undefined): SleeveDecision {
  if (quote === undefined) return decision;
  const delta = quote - decision.price;
  return {
    ...decision,
    price: quote,
    stop_price: moved(decision.stop_price, delta),
    target_price: moved(decision.target_price, delta),
    entry_trigger: moved(decision.entry_trigger, delta),
    entry_limit: moved(decision.entry_limit, delta),
  };
}

function isEntry(decision: SleeveDecision): boolean {
  return decision.action === 'enter_long' || decision.action === 'enter_short';
}

function quotedEntries(sleeve: Sleeve, market: MarketData): Sleeve {
  return {
    id: sleeve.id,
    spec: sleeve.spec,
    universe: (context) => sleeve.universe(context),
    decide: async (context, instruments) => {
      const output = await sleeve.decide(context, instruments);
      const quote = (decision: SleeveDecision) =>
        market.lastBarBefore(decision.instrument, context.tradingDate)?.rawClose;
      return {
        ...output,
        decisions: output.decisions.map((decision) =>
          isEntry(decision) ? atQuote(decision, quote(decision)) : decision,
        ),
      };
    },
  };
}

export function delayedTrial(trial: BacktestTrial): BacktestTrial {
  return {
    config: trial.config,
    sleeve: (market) => quotedEntries(trial.sleeve(delayedMarket(market)), market),
  };
}
