import { describe, expect, it, vi } from 'vitest';
import type {
  MarketData,
  SleeveContext,
  SleeveDecision,
  SleeveSpec,
} from '../../../contracts/index.js';
import type { BarSeries, DailyBar } from '../../shared/index.js';
import type { BacktestTrial } from './backtest.js';
import { BarsMarketData, parseBoeGbpUsdCsv } from './data/index.js';
import { delayedBars, delayedMarket, delayedTrial } from './look-ahead-canary.js';

const DATES = ['2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05', '2024-01-08'];

function bar(date: string, index: number): DailyBar {
  const close = 100 + index;
  return { date, open: close, high: close, low: close, close, volume: 10, rawClose: close + 0.5 };
}

const SERIES: BarSeries = { symbol: 'UP', bars: DATES.map(bar) };
const source = { load: (symbol: string) => (symbol === 'UP' ? SERIES : undefined) };
const FX = parseBoeGbpUsdCsv('DATE,XUDLUSS\n29 Dec 2023,1.27\n');
const market = new BarsMarketData(source, FX);

describe('delayedBars', () => {
  it('gives each bar its successor date, so every read before a session ends one bar earlier', () => {
    const delayed = delayedBars(source).load('UP');
    expect(delayed?.symbol).toBe('UP');
    expect(delayed?.bars.map((row) => [row.date, row.close])).toEqual([
      ['2024-01-03', 100],
      ['2024-01-04', 101],
      ['2024-01-05', 102],
      ['2024-01-08', 103],
    ]);
  });

  it('builds a series once and passes a missing series and the window note through', () => {
    const noteWindow = vi.fn();
    const delayed = delayedBars({ ...source, noteWindow });
    expect(delayed.load('UP')).toBe(delayed.load('UP'));
    expect(delayed.load('NONE')).toBeUndefined();
    delayed.noteWindow?.('UP', 7);
    expect(noteWindow).toHaveBeenCalledWith('UP', 7);
    expect(() => delayedBars(source).noteWindow?.('UP', 7)).not.toThrow();
  });
});

describe('delayedMarket', () => {
  const lagged = delayedMarket(market);
  const overDelayedBars = new BarsMarketData(delayedBars(source), FX);

  it('reads what a market over the delayed bars reads', () => {
    for (const date of DATES) {
      for (const count of [0, 1, 2, 10]) {
        expect(lagged.barsBefore('UP', date, count)).toEqual(
          overDelayedBars.barsBefore('UP', date, count),
        );
      }
      expect(lagged.lastBarBefore('UP', date)).toEqual(overDelayedBars.lastBarBefore('UP', date));
    }
  });

  it('decides on a session from the bar of the session before, labelled with the decision day', () => {
    expect(lagged.lastBarBefore('UP', '2024-01-08')).toEqual({
      ...bar('2024-01-04', 2),
      date: '2024-01-05',
    });
    expect(lagged.barsBefore('UP', '2024-01-08', 2).map((row) => row.close)).toEqual([101, 102]);
    expect(lagged.lastBarBefore('NONE', '2024-01-08')).toBeUndefined();
  });

  it('leaves the year-start FX alone', () => {
    expect(lagged.gbpUsdAtYearStart(2024)).toBe(market.gbpUsdAtYearStart(2024));
    expect(lagged.gbpUsdYearStartFixDate?.(2024)).toBe(market.gbpUsdYearStartFixDate(2024));
    const bare: MarketData = {
      lastBarBefore: () => undefined,
      barsBefore: () => [],
      gbpUsdAtYearStart: () => 1.3,
    };
    expect(delayedMarket(bare).gbpUsdYearStartFixDate?.(2024)).toBeUndefined();
  });
});

const SPEC = {} as SleeveSpec;
const REFUSAL = { scope: 's', parameter: 'p', ticket: '#1', message: 'm' };
const CONTEXT: SleeveContext = { tradingDate: '2024-01-08', macroDay: false, dryRun: true };

function decision(overrides: Partial<SleeveDecision>): SleeveDecision {
  return {
    sleeve_id: 's',
    instrument: 'UP',
    venue: 'alpaca',
    direction: 'bullish',
    confidence: 1,
    action: 'enter_long',
    reason: 'r',
    price: 0,
    atr: 2,
    stop_price: undefined,
    inputs_hash: 'h',
    debate_id: undefined,
    payload: {},
    ...overrides,
  };
}

function trialFrom(decide: (seen: MarketData) => readonly SleeveDecision[]): BacktestTrial {
  return {
    config: { lookback: 3 },
    sleeve: (seen) => ({
      id: 's',
      spec: SPEC,
      universe: () => ({ instruments: ['UP'], refusals: [REFUSAL] }),
      decide: () => Promise.resolve({ decisions: decide(seen), refusals: [REFUSAL] }),
    }),
  };
}

describe('delayedTrial', () => {
  it('hands the sleeve the delayed market and keeps its config, id, spec and universe', () => {
    let seen: MarketData | undefined;
    const trial = trialFrom((view) => {
      seen = view;
      return [];
    });
    const delayed = delayedTrial(trial);
    const sleeve = delayed.sleeve(market);
    expect(delayed.config).toBe(trial.config);
    expect([sleeve.id, sleeve.spec]).toEqual(['s', SPEC]);
    expect(sleeve.universe(CONTEXT)).toEqual({ instruments: ['UP'], refusals: [REFUSAL] });
    return sleeve.decide(CONTEXT, ['UP']).then((output) => {
      expect(output).toEqual({ decisions: [], refusals: [REFUSAL] });
      expect(seen?.lastBarBefore('UP', CONTEXT.tradingDate)?.close).toBe(102);
    });
  });

  it('moves an entry to the quoted close with its levels, and leaves other decisions alone', async () => {
    const quote = market.lastBarBefore('UP', CONTEXT.tradingDate)?.rawClose as number;
    const trial = trialFrom((view) => {
      const price = view.lastBarBefore('UP', CONTEXT.tradingDate)?.rawClose as number;
      return [
        decision({
          action: 'enter_long',
          price,
          stop_price: price - 4,
          target_price: price + 8,
          entry_trigger: price + 1,
          entry_limit: price + 2,
        }),
        decision({ action: 'enter_short', price, stop_price: price + 4 }),
        decision({ action: 'exit', price }),
        decision({ action: 'enter_long', instrument: 'NONE', price: 7 }),
      ];
    });
    const { decisions } = await delayedTrial(trial).sleeve(market).decide(CONTEXT, ['UP']);
    expect(quote).toBe(103.5);
    expect(decisions[0]).toMatchObject({
      price: quote,
      stop_price: quote - 4,
      target_price: quote + 8,
      entry_trigger: quote + 1,
      entry_limit: quote + 2,
    });
    expect(decisions[1]).toMatchObject({ price: quote, stop_price: quote + 4 });
    expect(decisions[1]?.target_price).toBeUndefined();
    expect(decisions[2]).toEqual(decision({ action: 'exit', price: 102.5 }));
    expect(decisions[3]).toEqual(decision({ action: 'enter_long', instrument: 'NONE', price: 7 }));
  });
});
