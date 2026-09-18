import {
  AlwaysOpenCalendar,
  type TradingCalendar,
} from '../../providers/market-data-service/index.js';
import type { Clock } from '../../shared/index.js';
import { DEFAULT_UNIVERSE, type SchedulerConfig, UniverseScheduler } from './scheduler.js';
import type { UniverseInstrument } from './types.js';

const MARKET_OPEN = new Date('2026-07-15T14:00:00Z');
const MARKET_CLOSED = new Date('2026-07-15T02:00:00Z');

function clockAt(instant: Date): Clock {
  return { now: () => instant };
}

const SESSION_BOUNDARY = new AlwaysOpenCalendar();

function calendarOpenAt(...openInstants: Date[]): TradingCalendar {
  const open = new Set(openInstants.map((instant) => instant.getTime()));
  return {
    isOpen: (instant) => open.has(instant.getTime()),
    isTradingDay: (instant) => open.has(instant.getTime()),
    sessionStart: (instant) => SESSION_BOUNDARY.sessionStart(instant),
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
  it('plans nothing when the market is closed — no always-open exception for any asset_class', () => {
    const plan = makeScheduler().nextTick(clockAt(MARKET_CLOSED));

    expect(plan.instruments).toEqual([]);
    expect(plan.grace_only).toBeUndefined();
  });

  it('fires the full universe when the market is open', () => {
    const plan = makeScheduler().nextTick(clockAt(MARKET_OPEN));

    expect(assets(plan.instruments)).toEqual(DEFAULT_UNIVERSE.map((row) => row.asset));
    expect(plan.instruments).toHaveLength(20);
    expect(plan.grace_only).toBeUndefined();
  });

  it('never fires a stock instrument on a holiday', () => {
    const holiday = new Date('2026-07-03T14:00:00Z');
    const plan = makeScheduler({ calendar: calendarOpenAt() }).nextTick(clockAt(holiday));

    expect(plan.instruments).toEqual([]);
  });

  it('gates a crypto instrument on the calendar like any other — no bypass', () => {
    const cryptoUniverse: readonly UniverseInstrument[] = [
      { asset: 'BTC-USD', asset_class: 'crypto' },
    ];

    const closedPlan = makeScheduler({ universe: cryptoUniverse }).nextTick(clockAt(MARKET_CLOSED));
    const openPlan = makeScheduler({ universe: cryptoUniverse }).nextTick(clockAt(MARKET_OPEN));

    expect(closedPlan.instruments).toEqual([]);
    expect(assets(openPlan.instruments)).toEqual(['BTC-USD']);
  });

  it('excludes stocks at the session close instant (the calendar is half-open)', () => {
    const close = new Date('2026-07-15T20:00:00Z');
    const calendar: TradingCalendar = {
      isOpen: (instant) => instant.getTime() < close.getTime(),
      isTradingDay: () => true,
      sessionStart: (instant) => SESSION_BOUNDARY.sessionStart(instant),
      sessionEnd: () => null,
    };
    const scheduler = makeScheduler({ calendar });

    const justBefore = scheduler.nextTick(clockAt(new Date(close.getTime() - 1)));
    const atClose = scheduler.nextTick(clockAt(close));

    expect(assets(justBefore.instruments)).toContain('QQQ');
    expect(assets(atClose.instruments)).not.toContain('QQQ');
  });

  it('reports tick_time as clock.now()', () => {
    expect(makeScheduler().nextTick(clockAt(MARKET_OPEN)).tick_time).toEqual(MARKET_OPEN);
  });

  it('gates the universe on a single instant, consulting the calendar once per tick', () => {
    let calls = 0;
    const calendar: TradingCalendar = {
      isOpen: () => {
        calls++;
        return true;
      },
      isTradingDay: () => true,
      sessionStart: (instant) => SESSION_BOUNDARY.sessionStart(instant),
      sessionEnd: () => null,
    };

    makeScheduler({ calendar }).nextTick(clockAt(MARKET_OPEN));

    expect(calls).toBe(1);
  });

  describe('a closed session over a 14-day soak', () => {
    it('produces an empty plan rather than a stale or crashed one', () => {
      const plan = makeScheduler().nextTick(clockAt(MARKET_CLOSED));

      expect(plan.instruments).toEqual([]);
      expect(plan.tick_time).toEqual(MARKET_CLOSED);
    });

    it('emits nothing per skipped instrument — the filter is silent by construction', () => {
      const scheduler = makeScheduler();
      const closedPlan = scheduler.nextTick(clockAt(MARKET_CLOSED));

      expect(Object.keys(scheduler)).not.toContain('logger');
      expect(closedPlan.instruments).toEqual([]);
    });

    it('re-admits the equities on the next open tick without any re-arming', () => {
      const scheduler = makeScheduler();

      expect(assets(scheduler.nextTick(clockAt(MARKET_CLOSED)).instruments)).toEqual([]);
      expect(assets(scheduler.nextTick(clockAt(MARKET_OPEN)).instruments)).toHaveLength(
        DEFAULT_UNIVERSE.length,
      );
      expect(assets(scheduler.nextTick(clockAt(MARKET_CLOSED)).instruments)).toEqual([]);
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

  it('DEFAULT_UNIVERSE carries no crypto row (#738 — crypto out of the production schedule)', () => {
    expect(DEFAULT_UNIVERSE.every((instrument) => instrument.asset_class !== 'crypto')).toBe(true);
  });

  describe('the post-close flatten grace (#1389)', () => {
    const AFTER_THE_BELL = new Date('2026-07-15T20:00:10Z');
    const PAST_THE_GRACE = new Date('2026-07-15T20:06:00Z');

    const graceWindow = (instant: Date): boolean => instant.getTime() === AFTER_THE_BELL.getTime();

    it('plans the universe after the bell when the grace says so', () => {
      const scheduler = makeScheduler({ postCloseFlattenWindow: graceWindow });

      const plan = scheduler.nextTick(clockAt(AFTER_THE_BELL));
      expect(assets(plan.instruments)).toHaveLength(DEFAULT_UNIVERSE.length);
    });

    it('stamps grace_only when the plan is admitted ONLY by the grace (#1499)', () => {
      const scheduler = makeScheduler({ postCloseFlattenWindow: graceWindow });

      expect(scheduler.nextTick(clockAt(AFTER_THE_BELL)).grace_only).toBe(true);
    });

    it('plans nothing once the grace has expired', () => {
      const scheduler = makeScheduler({ postCloseFlattenWindow: graceWindow });

      const plan = scheduler.nextTick(clockAt(PAST_THE_GRACE));
      expect(assets(plan.instruments)).toEqual([]);
      expect(plan.grace_only).toBeUndefined();
    });

    it('leaves grace_only absent on a window tick even when the grace predicate ALSO answers true (#1499)', () => {
      const scheduler = makeScheduler({ postCloseFlattenWindow: () => true });

      const plan = scheduler.nextTick(clockAt(MARKET_OPEN));
      expect(assets(plan.instruments)).toHaveLength(DEFAULT_UNIVERSE.length);
      expect(plan.grace_only).toBeUndefined();
    });

    it('does not widen an entry window that a profile deliberately narrowed', () => {
      const scheduler = makeScheduler({
        postCloseFlattenWindow: graceWindow,
        stocksTradingWindow: () => false,
      });

      expect(assets(scheduler.nextTick(clockAt(MARKET_OPEN)).instruments)).toEqual([]);
      expect(assets(scheduler.nextTick(clockAt(AFTER_THE_BELL)).instruments)).toHaveLength(
        DEFAULT_UNIVERSE.length,
      );
    });

    it('is absent by default — the backtest harness gets no post-close ticks', () => {
      const scheduler = makeScheduler();

      expect(assets(scheduler.nextTick(clockAt(AFTER_THE_BELL)).instruments)).toEqual([]);
    });
  });
});
