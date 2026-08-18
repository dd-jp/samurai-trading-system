/**
 * Intraday replay and flat-by-close (#664).
 *
 * The harness could only replay daily bars: `REPLAY_TIMEFRAME = '1d'` in
 * `proxy-strategy.ts`, `timeframe: '1Day'` in the aggregates client, a `'1d'`
 * literal in the driver's `marketState`, and a `TIMEFRAME` constant in the
 * store. ADR-0014 moved the product to an **intraday, flat-by-close** horizon,
 * so every one of those became a wrong answer rather than a simplification.
 *
 * These tests cover the behaviour that is new rather than merely parameterised:
 * a replay that steps minute bars across a session boundary, is flat by every
 * close, opens nothing inside the flatten window, and REFUSES to carry a
 * position into a later session. The parameterisation itself is covered where
 * it lives — `stage2-historical-store.test.ts` for the store's timeframe
 * scoping, `free-stack-aggregates-client.test.ts` for the vendor request,
 * `trial-execution.test.ts` for the annualization base.
 */
import type { Bar, TradingCalendar } from '../../providers/market-data-service/index.js';
import {
  AlwaysOpenCalendar,
  UsEquityRegularHoursCalendar,
} from '../../providers/market-data-service/index.js';
import { SimulatedClock } from '../../shared/index.js';
import type { ProxyStrategyConfig } from './proxy-strategy.js';
import {
  type ReplayBarSource,
  ReplayDriver,
  type ReplayDriverDeps,
  type ReplayInstrument,
} from './replay-driver.js';
import type { CostModel, CostModelResult, FillRequest } from './types.js';
import type { DateRange, InstrumentListing, InstrumentRegistry } from './universe.js';

const MINUTE_MS = 60_000;

/** Friday and the following Monday — the boundary crossed includes a weekend. */
const FRIDAY_CLOSE = new Date('2026-08-14T20:00:00.000Z');
const MONDAY_CLOSE = new Date('2026-08-17T20:00:00.000Z');

const SYMBOL = 'SPY';
const UNIVERSE: ReplayInstrument[] = [{ symbol: SYMBOL, asset_class: 'stocks' }];

/**
 * Stops and targets a mile away, so the ONLY exit these fixtures can produce is
 * the flat-by-close one. A bracket hit would be a different test.
 */
const CONFIG: ProxyStrategyConfig = {
  fastWindow: 3,
  slowWindow: 6,
  atrWindow: 4,
  atrStopMult: 500,
  atrTargetMult: 500,
  allowShort: false,
};

/**
 * `count` one-minute bars ending exactly at `sessionClose`, on a steady uptrend
 * so the dual-SMA signal opens long after warm-up and never turns.
 */
function barsOfTimeframe(
  sessionClose: Date,
  count: number,
  barMinutes: number,
  timeframe: string,
  basePrice = 100,
): Bar[] {
  const bars: Bar[] = [];
  const barMs = barMinutes * MINUTE_MS;
  for (let i = 0; i < count; i++) {
    const openTime = new Date(sessionClose.getTime() - (count - i) * barMs);
    const open = basePrice + i * 0.1;
    const close = open + 0.1;
    bars.push({
      instrument: SYMBOL,
      timeframe,
      open_time: openTime,
      close_time: new Date(openTime.getTime() + barMs),
      open,
      high: close + 0.01,
      low: open - 0.01,
      close,
      volume: 5_000,
      source: 'fixture',
    });
  }
  return bars;
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

/** Fills at the requested reference — the replay's own prices stay legible. */
class PassThroughCostModel implements CostModel {
  fill(request: FillRequest, marketState: { mid: number }): CostModelResult {
    return {
      fill_price: marketState.mid,
      filled_size: request.size,
      cost_breakdown: { spread_cost: 0, commission: 0, slippage: 0, market_impact: 0 },
    };
  }
}

function driverOver(
  bars: readonly Bar[],
  overrides: Partial<ReplayDriverDeps> = {},
): { driver: ReplayDriver; window: DateRange } {
  const timestamps = bars.map((bar) => bar.close_time);
  const window: DateRange = {
    start: (bars[0] as Bar).close_time,
    end: (bars[bars.length - 1] as Bar).close_time,
  };

  const deps: ReplayDriverDeps = {
    barSource: new FixtureBarSource(bars),
    timeline: {
      barTimestamps: async (asked: DateRange) =>
        timestamps.filter(
          (at) => at.getTime() >= asked.start.getTime() && at.getTime() <= asked.end.getTime(),
        ),
    },
    registry: new FixtureRegistry(),
    costModel: new PassThroughCostModel(),
    clock: new SimulatedClock(window.start),
    universe: UNIVERSE,
    capitalPerTrade: 10_000,
    timeframe: '1m',
    sessionCalendar: new UsEquityRegularHoursCalendar(),
    ...overrides,
  };

  return { driver: new ReplayDriver(deps), window };
}

const TWO_SESSIONS = [
  ...barsOfTimeframe(FRIDAY_CLOSE, 20, 1, '1m'),
  ...barsOfTimeframe(MONDAY_CLOSE, 20, 1, '1m', 110),
];

describe('intraday replay across a session boundary (#664)', () => {
  it('is flat by every close — no position survives a session, weekend included', async () => {
    const { driver, window } = driverOver(TWO_SESSIONS);

    const result = await driver.run(CONFIG, window);
    const trades = await result.trades.closedTrades(window);

    // The run really did step both sessions, or "flat by close" is vacuous.
    const stepped = await result.timeline.barTimestamps(window);
    expect(stepped.some((at) => at.getTime() <= FRIDAY_CLOSE.getTime())).toBe(true);
    expect(stepped.some((at) => at.getTime() > FRIDAY_CLOSE.getTime())).toBe(true);

    expect(trades.length).toBeGreaterThan(0);
    for (const trade of trades) {
      const sessionEnd = new UsEquityRegularHoursCalendar().sessionEnd(trade.opened_at);
      if (sessionEnd === null) throw new Error('the equity calendar must report a close');
      expect(trade.closed_at.getTime()).toBeLessThanOrEqual(sessionEnd.getTime());
    }

    // And the exit that produced that is the flatten, not a bracket or a signal
    // turn — the fixture's stop/target are 500 ATRs away and the trend never
    // reverses, so a non-flatten close reason here means the flat-by-close rule
    // did not fire and something else closed the lot by accident.
    expect(trades.map((trade) => trade.close_reason)).toEqual(trades.map(() => 'flatten'));
    expect(trades.length).toBe(2);
  });

  it('flattens on the last bar of the session, keyed on the bar OPEN not its close', async () => {
    const { driver, window } = driverOver(TWO_SESSIONS);

    const trades = await (await driver.run(CONFIG, window)).trades.closedTrades(window);
    const first = trades[0];
    if (first === undefined) throw new Error('expected a Friday trade');

    // The flatten window is [close − 5min, close). The first bar whose OPEN
    // falls inside it opens at 15:55 and closes at 15:56 ET.
    expect(first.closed_at.toISOString()).toBe(
      new Date(FRIDAY_CLOSE.getTime() - 4 * MINUTE_MS).toISOString(),
    );

    // Every lot both opens AND closes inside one session. This is the
    // assertion that actually discriminates the two keyings: asked by close
    // time, the 15:59-open bar (close == 16:00) reports MONDAY's close, so it
    // sits outside every flatten window, an entry opens on it, and that lot is
    // only flattened the next session — while the trade COUNT stays 2, so the
    // count assertion above misses it entirely.
    for (const trade of trades) {
      expect(trade.closed_at.toISOString().slice(0, 10)).toBe(
        trade.opened_at.toISOString().slice(0, 10),
      );
    }

    // Asked by CLOSE time instead, the 15:59-open bar would report tomorrow's
    // close (`sessionEnd` is strictly-after), so the last bar of the session —
    // the one a flat-by-close thesis cares most about — would never be inside
    // any flatten window at all. Guard the boundary case explicitly.
    const askedByCloseTime = new UsEquityRegularHoursCalendar().sessionEnd(FRIDAY_CLOSE);
    expect(askedByCloseTime?.toISOString()).toBe(MONDAY_CLOSE.toISOString());
  });

  it('opens nothing inside the flatten window', async () => {
    const { driver, window } = driverOver(TWO_SESSIONS);

    const trades = await (await driver.run(CONFIG, window)).trades.closedTrades(window);

    for (const trade of trades) {
      const sessionEnd = new UsEquityRegularHoursCalendar().sessionEnd(trade.opened_at);
      if (sessionEnd === null) throw new Error('the equity calendar must report a close');
      // `opened_at` is the entry bar's CLOSE time; its open is one minute
      // earlier, and that is what the window is measured against.
      const openedAtBarOpen = trade.opened_at.getTime() - MINUTE_MS;
      expect(sessionEnd.getTime() - openedAtBarOpen).toBeGreaterThan(5 * MINUTE_MS);
    }
  });

  it('refuses to carry a position into a later session rather than booking one', async () => {
    // A calendar that reports a close nobody's bars ever reach — the shape a
    // real unmodelled early close takes (the hand-entered US tables cover
    // 2026-2027 only; #684). The flatten window never opens, so the lot is
    // still held when Monday's bars arrive.
    const blindCalendar: TradingCalendar = {
      isOpen: () => true,
      isTradingDay: () => true,
      sessionStart: (instant) => instant,
      sessionEnd: (instant) =>
        new Date(
          instant.getTime() <= FRIDAY_CLOSE.getTime()
            ? FRIDAY_CLOSE.getTime() + 60 * MINUTE_MS
            : MONDAY_CLOSE.getTime() + 60 * MINUTE_MS,
        ),
    };

    const { driver, window } = driverOver(TWO_SESSIONS, { sessionCalendar: blindCalendar });

    await expect(driver.run(CONFIG, window)).rejects.toThrow(/carried a position from the session/);
  });

  it('leaves a 24/7 venue alone — no flatten, and no session assertion', async () => {
    // `AlwaysOpenCalendar.sessionEnd` is `null`, the documented "this venue has
    // no close" answer. Crypto left Samurai's scope (ADR-0015, 2026-08-16), so
    // #664 must not invent a boundary for it.
    const { driver, window } = driverOver(TWO_SESSIONS, {
      sessionCalendar: new AlwaysOpenCalendar(),
      universe: [{ symbol: SYMBOL, asset_class: 'crypto' }],
    });

    const trades = await (await driver.run(CONFIG, window)).trades.closedTrades(window);

    // The lot opens on Friday and is still open at the last Monday bar, so it
    // never becomes a ClosedTrade — which is exactly the pre-#664 behaviour.
    expect(trades).toEqual([]);
  });

  /**
   * A bar coarser than the flatten window (#664).
   *
   * The live rule is WALL-CLOCK: flatten in the last five minutes before the
   * close. A replay cannot act inside a bar, so on a `'15m'` grid — the cadence
   * ADR-0008 §2 records, and so the likeliest intraday invocation after `'1m'`
   * — no bar's OPEN ever falls within five minutes of the close: the last one
   * opens at CLOSE-15m. Taken literally the window would never open, the lot
   * would be held, and the carry assertion would abort the run on the first
   * session boundary, blaming the calendar for what is really an arithmetic
   * mismatch between the window and the bar.
   */
  it('flattens on the last bar even when the bar is coarser than the flatten window', async () => {
    const bars = [
      ...barsOfTimeframe(FRIDAY_CLOSE, 20, 15, '15m'),
      ...barsOfTimeframe(MONDAY_CLOSE, 20, 15, '15m', 110),
    ];
    const { driver, window } = driverOver(bars, { timeframe: '15m' });

    const trades = await (await driver.run(CONFIG, window)).trades.closedTrades(window);

    expect(trades.length).toBe(2);
    expect(trades.map((trade) => trade.close_reason)).toEqual(trades.map(() => 'flatten'));
    // The last bar of each session — the one closing AT the close.
    expect(trades.map((trade) => trade.closed_at.toISOString())).toEqual([
      FRIDAY_CLOSE.toISOString(),
      MONDAY_CLOSE.toISOString(),
    ]);
  });

  it('refuses a bar series whose resolution is not the one it was configured for', async () => {
    const { driver, window } = driverOver(TWO_SESSIONS, { timeframe: '5m' });

    await expect(driver.run(CONFIG, window)).rejects.toThrow(
      /served SPY at '1m' but the driver is configured for '5m'/,
    );
  });
});

describe('daily replay is untouched by the session-boundary path (#664)', () => {
  /**
   * Daily bars on a sine path — it has to REVERSE, or the dual-SMA rule never
   * turns, no lot ever closes, and comparing two empty trade lists would pass
   * whatever the session-boundary code did.
   */
  function dailyBars(count: number): Bar[] {
    const bars: Bar[] = [];
    for (let i = 0; i < count; i++) {
      const openTime = new Date(Date.UTC(2026, 6, 1 + i));
      const open = 100 + 10 * Math.sin((2 * Math.PI * i) / 12);
      const close = 100 + 10 * Math.sin((2 * Math.PI * (i + 1)) / 12);
      bars.push({
        instrument: SYMBOL,
        timeframe: '1d',
        open_time: openTime,
        close_time: new Date(openTime.getTime() + 86_400_000),
        open,
        high: close + 0.5,
        low: open - 0.5,
        close,
        volume: 5_000,
        source: 'fixture',
      });
    }
    return bars;
  }

  it('produces identical trades under an equity calendar and a 24/7 one', async () => {
    const bars = dailyBars(30);

    const withEquityCalendar = driverOver(bars, {
      timeframe: '1d',
      sessionCalendar: new UsEquityRegularHoursCalendar(),
    });
    const withAlwaysOpen = driverOver(bars, {
      timeframe: '1d',
      sessionCalendar: new AlwaysOpenCalendar(),
    });

    const a = await (
      await withEquityCalendar.driver.run(CONFIG, withEquityCalendar.window)
    ).trades.closedTrades(withEquityCalendar.window);
    const b = await (
      await withAlwaysOpen.driver.run(CONFIG, withAlwaysOpen.window)
    ).trades.closedTrades(withAlwaysOpen.window);

    // A daily bar spans the whole session, so "flatten five minutes before the
    // close" is not a question a daily replay can answer — and answering it
    // anyway would reprice every Stage 2 verdict this repo has recorded. The
    // guard is structural (`isDailyTimeframe` in `flattenBoundary`), and this
    // is the test that goes red if it is removed.
    expect(a.length).toBeGreaterThan(0);
    expect(a).toEqual(b);
    expect(a.every((trade) => trade.close_reason !== 'flatten')).toBe(true);
  });
});
