import type { Bar } from '../../providers/market-data-service/index.js';
import { AlwaysOpenCalendar } from '../../providers/market-data-service/index.js';
import type { Fill } from '../../shared/index.js';
import { SimulatedClock, toBrokerFillId } from '../../shared/index.js';
import {
  attributeRunCosts,
  attributeTradeCost,
  GrossOfCostsTradeSource,
} from './cost-attribution.js';
import { CostModelImpl } from './cost-model.js';
import { EvalExecutorImpl } from './eval-executor.js';
import type { ReplayTradeSource } from './eval-types.js';
import type { ProxyStrategyConfig } from './proxy-strategy.js';
import {
  type ReplayBarSource,
  ReplayDriver,
  type ReplayInstrument,
  type ReplayRunResult,
} from './replay-driver.js';
import type { CostConfig, CostModel, CostModelResult, FillRequest, MarketState } from './types.js';
import type { DateRange, InstrumentListing, InstrumentRegistry } from './universe.js';

const CONFIG: ProxyStrategyConfig = {
  fastWindow: 3,
  slowWindow: 6,
  atrWindow: 4,
  atrStopMult: 2,
  atrTargetMult: 3,
  allowShort: true,
};

const INSTRUMENT = 'BTC-USD';
const UNIVERSE: ReplayInstrument[] = [{ symbol: INSTRUMENT, asset_class: 'crypto' }];

const COST_CONFIG: CostConfig = {
  crypto: {
    spreadVolatilityCoefficient: 0.5,
    commissionRate: 0.001,
    slippageCoefficient: 0.2,
    impactK: 0.1,
  },
  stocks: {
    spreadVolatilityCoefficient: 0.1,
    commissionRate: 0.0005,
    slippageCoefficient: 0.05,
    impactK: 0.05,
  },
};

function day(i: number): Date {
  return new Date(Date.UTC(2024, 0, i + 1));
}

function buildBars(closes: readonly number[]): Bar[] {
  return closes.map((close, i) => ({
    instrument: INSTRUMENT,
    timeframe: '1d',
    open_time: day(i),
    close_time: day(i + 1),
    open: i === 0 ? close : (closes[i - 1] as number),
    high: Math.max(close, i === 0 ? close : (closes[i - 1] as number)) + 1,
    low: Math.min(close, i === 0 ? close : (closes[i - 1] as number)) - 1,
    close,
    volume: 1_000,
    source: 'fixture',
  }));
}

class FixtureBarSource implements ReplayBarSource {
  constructor(private readonly all: readonly Bar[]) {}
  bars(_symbol: string, window: DateRange): Bar[] {
    return this.all.filter(
      (bar) =>
        bar.close_time.getTime() >= window.start.getTime() &&
        bar.close_time.getTime() <= window.end.getTime(),
    );
  }
}

class FixtureRegistry implements InstrumentRegistry {
  async membershipDuring(_window: DateRange): Promise<InstrumentListing[]> {
    return [];
  }
}

class ZeroCostModel implements CostModel {
  fill(request: FillRequest, marketState: MarketState): CostModelResult {
    return {
      fill_price: marketState.mid,
      filled_size: request.size,
      cost_breakdown: { spread_cost: 0, commission: 0, slippage: 0, market_impact: 0 },
    };
  }
}

const CYCLE = [
  100, 101, 103, 106, 110, 115, 121, 128, 130, 129, 125, 120, 114, 108, 103, 99, 96, 94, 93, 95, 98,
  102, 107, 113, 120, 128, 133, 136, 138, 137, 133, 128, 122, 116, 111, 107, 104, 102, 101, 103,
];

const CLOSES = [...CYCLE, ...CYCLE];

const WINDOW: DateRange = { start: day(0), end: day(CLOSES.length) };

function runReplay(costModel: CostModel): Promise<ReplayRunResult> {
  return new ReplayDriver({
    barSource: new FixtureBarSource(buildBars(CLOSES)),
    timeline: {
      barTimestamps: async (window: DateRange) =>
        buildBars(CLOSES)
          .map((bar) => bar.close_time)
          .filter(
            (at) => at.getTime() >= window.start.getTime() && at.getTime() <= window.end.getTime(),
          ),
    },
    registry: new FixtureRegistry(),
    costModel,
    clock: new SimulatedClock(WINDOW.start),
    universe: UNIVERSE,
    capitalPerTrade: 10_000,
    timeframe: '1d',
    sessionCalendar: new AlwaysOpenCalendar(),
  }).run(CONFIG, WINDOW);
}

function fill(leg: Fill['leg'], qty: number, breakdown: Fill['cost_breakdown']): Fill {
  return {
    idempotency_key: 'lot-1',
    broker_fill_id: toBrokerFillId(`lot-1:${leg}`),
    leg,
    price: 100,
    qty,
    fee: breakdown?.commission ?? 0,
    timestamp: day(1),
    ...(breakdown === undefined ? {} : { cost_breakdown: breakdown }),
  };
}

describe('attributeTradeCost', () => {
  it('multiplies the per-unit components by qty and sums commission as-is', () => {
    const attribution = attributeTradeCost(
      [
        fill('entry', 10, {
          spread_cost: 0.5,
          commission: 1.25,
          slippage: 0.25,
          market_impact: 0.125,
        }),
        fill('target', 10, {
          spread_cost: 0.4,
          commission: 1.0,
          slippage: 0.2,
          market_impact: 0.1,
        }),
      ],
      'lot-1',
    );

    expect(attribution.spread).toBeCloseTo(9, 10);
    expect(attribution.slippage).toBeCloseTo(4.5, 10);
    expect(attribution.market_impact).toBeCloseTo(2.25, 10);
    expect(attribution.commission).toBeCloseTo(2.25, 10);
    expect(attribution.total).toBeCloseTo(18, 10);
  });

  it('refuses an unpriced fill rather than counting it as free', () => {
    expect(() => attributeTradeCost([fill('entry', 10, undefined)], 'lot-1')).toThrow(
      /no cost_breakdown/,
    );
  });
});

describe('the gross reconstruction', () => {
  it('equals a genuinely zero-cost replay, trade for trade', async () => {
    const priced = await runReplay(new CostModelImpl(COST_CONFIG));
    const free = await runReplay(new ZeroCostModel());

    const reconstructed = await new GrossOfCostsTradeSource(priced.trades).closedTrades(WINDOW);
    const actual = await free.trades.closedTrades(WINDOW);

    expect(actual.length).toBeGreaterThan(2);
    expect(reconstructed.map((t) => t.idempotency_key)).toEqual(
      actual.map((t) => t.idempotency_key),
    );

    expect(actual.some((t) => t.side === 'buy')).toBe(true);
    expect(actual.some((t) => t.side === 'sell')).toBe(true);

    for (const [i, trade] of reconstructed.entries()) {
      expect(trade.realized_pnl_net).toBeCloseTo(
        (actual[i] as (typeof actual)[number]).realized_pnl_net,
        8,
      );
    }
  });

  it('is not satisfied by an add-back that omits commission', async () => {
    const priced = await runReplay(new CostModelImpl(COST_CONFIG));
    const free = await runReplay(new ZeroCostModel());

    const net = await priced.trades.closedTrades(WINDOW);
    const actual = await free.trades.closedTrades(WINDOW);

    const withoutCommission = await Promise.all(
      net.map(async (trade) => {
        const cost = attributeTradeCost(
          await priced.trades.fills(trade.idempotency_key),
          trade.idempotency_key,
        );
        return trade.realized_pnl_net + cost.total - cost.commission;
      }),
    );

    expect(
      withoutCommission.some(
        (pnl, i) => Math.abs(pnl - (actual[i] as (typeof actual)[number]).realized_pnl_net) > 1e-6,
      ),
    ).toBe(true);
  });

  it('zeroes fees_total, so the record does not report fees a gross PnL ignores', async () => {
    const priced = await runReplay(new CostModelImpl(COST_CONFIG));
    const gross = await new GrossOfCostsTradeSource(priced.trades).closedTrades(WINDOW);

    expect(gross.every((trade) => trade.fees_total === 0)).toBe(true);
  });

  it('scores through the unmodified EvalExecutorImpl', async () => {
    const priced = await runReplay(new CostModelImpl(COST_CONFIG));
    const source: ReplayTradeSource = new GrossOfCostsTradeSource(priced.trades);

    const report = await new EvalExecutorImpl({ source, timeline: priced.timeline }).evaluate({
      window: WINDOW,
      averageCapital: 10_000,
      periodsPerYear: 365,
      scheme: 'walk_forward',
      embargo: 1,
      barMs: 86_400_000,
    });

    expect(Number.isFinite(report.window.sharpe)).toBe(true);
  });
});

describe('attributeRunCosts', () => {
  it('totals costs and expresses them against traded notional', async () => {
    const priced = await runReplay(new CostModelImpl(COST_CONFIG));
    const attribution = await attributeRunCosts(priced.trades, WINDOW);

    expect(attribution.trades).toBeGreaterThan(2);
    expect(attribution.total).toBeGreaterThan(0);
    expect(attribution.notional).toBeGreaterThan(0);
    expect(attribution.bps_of_notional).toBeCloseTo(
      (attribution.total / attribution.notional) * 10_000,
      10,
    );
    expect(attribution.mean_adverse_move_in_atr).toBeUndefined();
  });

  it('recovers the adverse move in ATR units from the slippage coefficient', async () => {
    const priced = await runReplay(new CostModelImpl(COST_CONFIG));
    const attribution = await attributeRunCosts(
      priced.trades,
      WINDOW,
      COST_CONFIG.crypto.slippageCoefficient,
    );

    expect(attribution.mean_adverse_move_in_atr).toBeGreaterThan(0.4);
    expect(attribution.mean_adverse_move_in_atr).toBeLessThan(0.6);
  });
});
