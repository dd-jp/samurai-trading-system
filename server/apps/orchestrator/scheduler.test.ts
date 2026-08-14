import {
  AlwaysOpenCalendar,
  type TradingCalendar,
} from '../../providers/market-data-service/index.js';
import type { Clock } from '../../shared/index.js';
import { DEFAULT_UNIVERSE, type SchedulerConfig, UniverseScheduler } from './scheduler.js';
import type { UniverseInstrument } from './types.js';

const MARKET_OPEN = new Date('2026-07-15T14:00:00Z'); // 10:00 ET, a Wednesday.
const MARKET_CLOSED = new Date('2026-07-15T02:00:00Z'); // 22:00 ET the prior evening.

function clockAt(instant: Date): Clock {
  return { now: () => instant };
}

/** The scheduler gates on `isOpen` only; session boundaries are not its concern. */
const SESSION_BOUNDARY = new AlwaysOpenCalendar();

/** Open exactly on the instants listed; closed otherwise. */
function calendarOpenAt(...openInstants: Date[]): TradingCalendar {
  const open = new Set(openInstants.map((instant) => instant.getTime()));
  return {
    isOpen: (instant) => open.has(instant.getTime()),
    isTradingDay: (instant) => open.has(instant.getTime()),
    sessionStart: (instant) => SESSION_BOUNDARY.sessionStart(instant),
    // #668 — this double predates `sessionEnd`; no test here asks about it.
    sessionEnd: () => null,
  };
}

function makeScheduler(overrides: Partial<SchedulerConfig> = {}): UniverseScheduler {
  return new UniverseScheduler({
    universe: DEFAULT_UNIVERSE,
    calendar: calendarOpenAt(MARKET_OPEN),
    ...overrides,
  });
}

function assets(instruments: readonly UniverseInstrument[]): string[] {
  return instruments.map((instrument) => instrument.asset);
}

describe('UniverseScheduler.nextTick', () => {
  it('fires crypto instruments when the stock market is closed', () => {
    const plan = makeScheduler().nextTick(clockAt(MARKET_CLOSED));

    expect(assets(plan.instruments)).toEqual(['BTC-USD', 'ETH-USD']);
  });

  it('fires the full universe when the stock market is open', () => {
    const plan = makeScheduler().nextTick(clockAt(MARKET_OPEN));

    expect(assets(plan.instruments)).toEqual(['SPY', 'QQQ', 'AAPL', 'TSLA', 'BTC-USD', 'ETH-USD']);
  });

  it('never fires a stock instrument on a holiday', () => {
    const holiday = new Date('2026-07-03T14:00:00Z');
    const plan = makeScheduler({ calendar: calendarOpenAt() }).nextTick(clockAt(holiday));

    expect(plan.instruments.every((instrument) => instrument.asset_class === 'crypto')).toBe(true);
  });

  it('fires crypto 24/7 across every hour of the day', () => {
    const scheduler = makeScheduler({ calendar: calendarOpenAt() });

    for (let hour = 0; hour < 24; hour++) {
      const instant = new Date(Date.UTC(2026, 6, 15, hour));
      expect(assets(scheduler.nextTick(clockAt(instant)).instruments)).toEqual([
        'BTC-USD',
        'ETH-USD',
      ]);
    }
  });

  it('excludes stocks at the session close instant (the calendar is half-open)', () => {
    const close = new Date('2026-07-15T20:00:00Z');
    // Open right up to, but not including, the close instant.
    const calendar: TradingCalendar = {
      isOpen: (instant) => instant.getTime() < close.getTime(),
      isTradingDay: () => true,
      sessionStart: (instant) => SESSION_BOUNDARY.sessionStart(instant),
      // #668 — this double predates `sessionEnd`; no test here asks about it.
      sessionEnd: () => null,
    };
    const scheduler = makeScheduler({ calendar });

    const justBefore = scheduler.nextTick(clockAt(new Date(close.getTime() - 1)));
    const atClose = scheduler.nextTick(clockAt(close));

    expect(assets(justBefore.instruments)).toContain('SPY');
    expect(assets(atClose.instruments)).not.toContain('SPY');
  });

  it('reports tick_time as clock.now()', () => {
    expect(makeScheduler().nextTick(clockAt(MARKET_OPEN)).tick_time).toEqual(MARKET_OPEN);
  });

  it('gates stocks on a single instant, consulting the calendar once per tick', () => {
    let calls = 0;
    const calendar: TradingCalendar = {
      isOpen: () => {
        calls++;
        return true;
      },
      isTradingDay: () => true,
      sessionStart: (instant) => SESSION_BOUNDARY.sessionStart(instant),
      // #668 — this double predates `sessionEnd`; no test here asks about it.
      sessionEnd: () => null,
    };

    makeScheduler({ calendar }).nextTick(clockAt(MARKET_OPEN));

    // Four stocks in the default universe, but one instant: a plan gated
    // per-instrument could straddle a session boundary mid-iteration.
    expect(calls).toBe(1);
  });

  /**
   * The overnight properties a 14-day unattended soak depends on (#381). The
   * calendar gate was inert while the universe was crypto-only; with four
   * equities in it, it runs for ~16 hours of every weekday, and two ways of
   * "working" would still ruin the soak.
   */
  describe('a closed session over a 14-day soak', () => {
    it('keeps ticking crypto rather than starving the loop', () => {
      // The gate FILTERS the plan; it does not skip the tick. If a closed
      // session produced an empty plan the loop would idle for 16h a day and
      // BTC-USD/ETH-USD would go untraded overnight, which is the half of the
      // universe that trades overnight at all.
      const plan = makeScheduler().nextTick(clockAt(MARKET_CLOSED));

      expect(plan.instruments).not.toHaveLength(0);
      expect(plan.instruments.every((i) => i.asset_class === 'crypto')).toBe(true);
    });

    it('emits nothing per skipped instrument — the filter is silent by construction', () => {
      // `SchedulerConfig` has no logger and `nextTick` takes none, so there is
      // no seam through which a per-instrument "market closed" line could be
      // emitted every 60s for 16 hours a day. Asserted structurally because
      // that is what actually holds: a future logger added here would fail
      // this test rather than quietly filling the soak's log file.
      const scheduler = makeScheduler();
      const closedPlan = scheduler.nextTick(clockAt(MARKET_CLOSED));

      expect(Object.keys(scheduler)).not.toContain('logger');
      expect(closedPlan.instruments).toHaveLength(2);
    });

    it('re-admits the equities on the next open tick without any re-arming', () => {
      // Stateless, so a session reopening needs no reset call that an
      // unattended run has nobody to make.
      const scheduler = makeScheduler();

      expect(assets(scheduler.nextTick(clockAt(MARKET_CLOSED)).instruments)).toHaveLength(2);
      expect(assets(scheduler.nextTick(clockAt(MARKET_OPEN)).instruments)).toHaveLength(6);
      expect(assets(scheduler.nextTick(clockAt(MARKET_CLOSED)).instruments)).toHaveLength(2);
    });
  });

  it('iterates the configured universe, not a hardcoded one', () => {
    const scheduler = makeScheduler({
      universe: [
        { asset: 'NVDA', asset_class: 'stocks' },
        { asset: 'SOL-USD', asset_class: 'crypto' },
      ],
    });

    expect(assets(scheduler.nextTick(clockAt(MARKET_OPEN)).instruments)).toEqual([
      'NVDA',
      'SOL-USD',
    ]);
  });
});
