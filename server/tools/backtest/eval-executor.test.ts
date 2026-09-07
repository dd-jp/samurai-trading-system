import type { Scheduler, TickContext, TickRunner } from '../../apps/orchestrator/index.js';
import type { Signal } from '../../pipeline/analysts/index.js';
import type { ClosedTrade, Fill } from '../../shared/index.js';
import { type Clock, SimulatedClock } from '../../shared/index.js';
import { BacktestHarness } from './backtest.js';
import { EvalExecutorImpl } from './eval-executor.js';
import type { EvalOptions, ReplayTradeSource } from './eval-types.js';
import { computeMetrics } from './metrics.js';
import { generateSplits } from './splits.js';
import { toReturnSeries, toTradeSeries } from './trade-derivation.js';
import type { BacktestConfig, CostConfig, ReplayTimeline } from './types.js';
import type { InstrumentRegistry } from './universe.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const START = new Date('2024-01-01T00:00:00.000Z');
const CAPITAL = 100_000;

function day(n: number): Date {
  return new Date(START.getTime() + n * DAY_MS);
}

/**
 * 600 daily bars over a 600-day window — long enough that all five
 * walk-forward folds hold bars *and* trades. A short window makes the later
 * folds empty, and `computeMetrics` (rightly) refuses a zero-variance sample,
 * so the fixture has to be long enough for the splits to mean anything.
 */
const BARS = Array.from({ length: 600 }, (_, index) => day(index));
const WINDOW = { start: day(0), end: day(600) };

/**
 * Two trades in each of the six CPCV/walk-forward groups: +1,000 and −400,
 * each a 2,000-notional round trip held for one day. Placed at day 20 and 60
 * within their 100-day group so none lands on a group boundary, where the
 * inclusive range ends would put it in two samples at once.
 *
 * The numbers are chosen to be checkable by hand, per group and overall —
 * see the expectations below.
 */
const TRADES: ClosedTrade[] = Array.from({ length: 6 }, (_, group) => [
  tradeAt(`lot-${group}-win`, 100 * group + 20, 1000),
  tradeAt(`lot-${group}-loss`, 100 * group + 60, -400),
]).flat();

function tradeAt(idempotency_key: string, openDay: number, pnl: number): ClosedTrade {
  return {
    idempotency_key,
    debate_id: `debate-${idempotency_key}`,
    instrument: 'BTC-USD',
    asset_class: 'crypto',
    side: 'buy',
    entry: 100,
    stop: 90,
    filled_size: 10,
    realized_pnl_net: pnl,
    fees_total: 12,
    opened_at: day(openDay),
    closed_at: day(openDay + 1),
    close_reason: pnl > 0 ? 'target' : 'stop',
    modelled_cost_charged: true,
  };
}

/** Every fill priced by `CostModel.fill`, i.e. carrying its breakdown. */
function pricedFills(trade: ClosedTrade): Fill[] {
  return (['entry', 'exit'] as const).map((leg) => ({
    idempotency_key: trade.idempotency_key,
    broker_fill_id: `${trade.idempotency_key}-${leg}`,
    leg,
    price: trade.entry,
    qty: trade.filled_size,
    fee: 6,
    timestamp: leg === 'entry' ? trade.opened_at : trade.closed_at,
    cost_breakdown: { spread_cost: 0.01, commission: 6, slippage: 0.02, market_impact: 0.03 },
  }));
}

function sourceOf(
  trades: readonly ClosedTrade[],
  fillsFor: (trade: ClosedTrade) => Fill[] = pricedFills,
): ReplayTradeSource {
  return {
    closedTrades: async (window) =>
      trades.filter(
        (trade) =>
          trade.closed_at.getTime() >= window.start.getTime() &&
          trade.closed_at.getTime() <= window.end.getTime(),
      ),
    fills: async (idempotency_key) => {
      const trade = trades.find((candidate) => candidate.idempotency_key === idempotency_key);
      return trade === undefined ? [] : fillsFor(trade);
    },
  };
}

const TIMELINE: ReplayTimeline = { barTimestamps: async () => BARS };

const OPTIONS: EvalOptions = {
  window: WINDOW,
  averageCapital: CAPITAL,
  periodsPerYear: 365,
  scheme: 'walk_forward',
  embargo: 0,
  barMs: DAY_MS,
};

function executorOf(source: ReplayTradeSource = sourceOf(TRADES)): EvalExecutorImpl {
  return new EvalExecutorImpl({ source, timeline: TIMELINE });
}

describe("EvalExecutorImpl — acceptance criterion 1: our CostModel.fill, not pybroker's", () => {
  it("scores a run whose every fill carries the cost model's breakdown", async () => {
    await expect(executorOf().evaluate(OPTIONS)).resolves.toBeDefined();
  });

  it('refuses to score a run containing a fill no cost model priced', async () => {
    // An unmodeled fill means the sqrt-law market impact (Principle 2) was
    // never applied — the run's metrics would flatter the strategy. The
    // executor must fail rather than report them.
    const unpriced = sourceOf(TRADES, (trade) =>
      pricedFills(trade).map(({ cost_breakdown: _dropped, ...rest }) => rest),
    );

    await expect(executorOf(unpriced).evaluate(OPTIONS)).rejects.toThrow(
      /not priced by CostModel\.fill/,
    );
  });

  it('fails before producing any metrics, not after', async () => {
    const unpriced = sourceOf(TRADES, () => []);

    await expect(executorOf(unpriced).evaluate(OPTIONS)).rejects.toThrow(/has no fills/);
  });
});

describe('EvalExecutorImpl — acceptance criterion 2: split boundaries', () => {
  it('scores exactly the splits our own generator produces', async () => {
    const report = await executorOf().evaluate(OPTIONS);

    // A wiring guard, not an agreement between two derivations: the executor
    // calls `generateSplits` rather than mining a second copy of the boundary
    // arithmetic (see eval-executor.ts). What it catches is the executor
    // silently re-cutting, reordering or dropping the splits it was handed.
    expect(report.splits.map((evaluated) => evaluated.split)).toEqual(
      generateSplits(WINDOW, 'walk_forward', { embargo: 0, barMs: DAY_MS }),
    );
  });

  it('emits one scored suite per fold — a distribution, not one number', async () => {
    const report = await executorOf().evaluate(OPTIONS);

    expect(report.splits).toHaveLength(5);
  });

  it('scores each fold over its own test slice only', async () => {
    const report = await executorOf().evaluate(OPTIONS);

    // Each 100-day fold holds exactly the one +1,000 / −400 pair placed in it:
    // gross wins 1,000 / gross losses 400 = 2.5, mean PnL 300, 2 x 2,000
    // notional over 100k capital = 0.04, 2 days held over 100 = 0.02.
    for (const { metrics } of report.splits) {
      expect(metrics.profit_factor).toBeCloseTo(2.5, 12);
      expect(metrics.expectancy).toBeCloseTo(300, 12);
      expect(metrics.turnover).toBeCloseTo(0.04, 12);
      expect(metrics.exposure).toBeCloseTo(0.02, 12);
    }
  });

  it('refuses CPCV rather than under-reporting exposure across the group gap', async () => {
    await expect(executorOf().evaluate({ ...OPTIONS, scheme: 'cpcv' })).rejects.toThrow(
      /disjoint test ranges/,
    );
  });
});

describe('EvalExecutorImpl — acceptance criterion 3: matches the harness', () => {
  /**
   * The two sides of the comparison, stated plainly so the test is not read as
   * stronger than it is:
   *
   * - **Harness side.** `BacktestHarness.run` executes the replay that
   *   produces the realized record; that record is then scored by calling
   *   `computeMetrics` directly on series derived from it.
   * - **Executor side.** The mined eval executor scores the *same* record
   *   through its split-driving path.
   *
   * Both therefore share one metric implementation on purpose — the spec
   * requires it ("one implementation → live metrics == backtest metrics",
   * cross-spec §5). So the equality below guards the *plumbing* between the
   * replay and the metrics, not the metric math. The hand-computed values in
   * the third test are what keep the pair from being a tautology: they pin an
   * independently-derived reference that neither side can drift from.
   */
  /**
   * Replays the window through `BacktestHarness` and returns the record the
   * replay realized. The trades are recorded by the tick runner as the
   * simulated clock reaches each one's close, so the record is genuinely an
   * output of the replay rather than the fixture handed to both sides — which
   * is the only way "a backtest run through the harness" means anything here.
   */
  async function runHarness(): Promise<ClosedTrade[]> {
    const recorded: ClosedTrade[] = [];

    const config: BacktestConfig = {
      config_hash: 'cfg-eval-90',
      window: WINDOW,
      universe: ['BTC-USD'],
      cost_config: COST_CONFIG,
      seed: 42,
    };

    const tickRunner: TickRunner = {
      runInstrument: async (_signal, ctx) => {
        const now = ctx.clock.now().getTime();
        for (const trade of TRADES) {
          if (trade.closed_at.getTime() === now) {
            recorded.push(trade);
          }
        }
        return { trace_id: ctx.trace_id, final_stage: 'execution' };
      },
    };

    const harness = new BacktestHarness({
      scheduler: SCHEDULER,
      tickRunner,
      timeline: TIMELINE,
      registry: REGISTRY,
      newTickContext,
    });

    await harness.run(config, new SimulatedClock(WINDOW.start));

    return recorded;
  }

  function scoreDirectly(trades: readonly ClosedTrade[]) {
    const seriesOptions = { window: WINDOW, averageCapital: CAPITAL };
    return computeMetrics(
      toReturnSeries(trades, BARS, { ...seriesOptions, periodsPerYear: 365 }),
      toTradeSeries(trades, seriesOptions),
    );
  }

  it('replays every scripted round trip, so the two sides score one record', async () => {
    const recorded = await runHarness();

    expect(recorded).toHaveLength(TRADES.length);
  });

  it('produces the same MetricsSuite as scoring the harness run directly', async () => {
    const recorded = await runHarness();

    const report = await executorOf(sourceOf(recorded)).evaluate(OPTIONS);

    expect(report.window).toEqual(scoreDirectly(recorded));
  });

  it('matches on every field of the suite, not just the headline ratio', async () => {
    const recorded = await runHarness();
    const harnessMetrics = scoreDirectly(recorded);

    const report = await executorOf(sourceOf(recorded)).evaluate(OPTIONS);

    for (const field of Object.keys(harnessMetrics) as (keyof typeof harnessMetrics)[]) {
      expect(report.window[field]).toBeCloseTo(harnessMetrics[field], 12);
    }
  });

  it('agrees with hand-computed values, so neither side is the sole reference', async () => {
    const recorded = await runHarness();
    const report = await executorOf(sourceOf(recorded)).evaluate(OPTIONS);

    // 6 wins x 1,000 gross wins / 6 losses x 400 gross losses = 2.5.
    expect(report.window.profit_factor).toBeCloseTo(2.5, 12);
    // (6 x 1,000 − 6 x 400) / 12 trades = 300 per trade, net of costs.
    expect(report.window.expectancy).toBeCloseTo(300, 12);
    // 12 round trips x (100 x 10 x 2) = 24,000 traded over 100,000 capital.
    expect(report.window.turnover).toBeCloseTo(0.24, 12);
    // 12 trades held one day each, none overlapping, over a 600-day window.
    expect(report.window.exposure).toBeCloseTo(0.02, 12);
  });
});

const COST_CONFIG: CostConfig = {
  crypto: {
    spreadVolatilityCoefficient: 0.1,
    commissionRate: 0.001,
    slippageCoefficient: 0.05,
    impactK: 0.5,
  },
  stocks: {
    spreadVolatilityCoefficient: 0.05,
    commissionRate: 0.0005,
    slippageCoefficient: 0.02,
    impactK: 0.3,
  },
};

const REGISTRY: InstrumentRegistry = {
  membershipDuring: async () => [{ symbol: 'BTC-USD' }],
};

const SCHEDULER: Scheduler = {
  nextTick: (clock) => ({
    instruments: [{ asset: 'BTC-USD', asset_class: 'crypto' }],
    tick_time: clock.now(),
  }),
};

function newTickContext(signal: Signal, clock: Clock): TickContext {
  return {
    clock,
    trace_id: `${signal.asset}@${clock.now().toISOString()}`,
    logger: { log: () => {} },
    auditLog: { record: () => {} },
    // See backtest.test.ts: inert current-tick store, the harness has no
    // live tick to publish.
    currentTickStore: { upsert: () => {}, delete: () => {}, get: () => undefined },
  };
}
