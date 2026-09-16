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

/** The scheduler gates on `isOpen` only; session boundaries are not its concern */
const SESSION_BOUNDARY = new AlwaysOpenCalendar();

/** Open exactly on the instants listed; closed otherwise */
function calendarOpenAt(...openInstants: Date[]): TradingCalendar {
  const open = new Set(openInstants.map((instant) => instant.getTime()));
  return {
    isOpen: (instant) => open.has(instant.getTime()),
    isTradingDay: (instant) => open.has(instant.getTime()),
    sessionStart: (instant) => SESSION_BOUNDARY.sessionStart(instant),
    // #668 — this double predates `sessionEnd`; no test here asks about it
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
    // #738: crypto is out of Samurai's scope, and `DEFAULT_UNIVERSE` no
    // longer declares any crypto row — but the point of this test is the
    // GATE, not the universe: even a universe that DID carry a crypto
    // instrument would get no special treatment here (see the
    // 'gates a crypto instrument on the calendar like any other' test below)
    // ~orchestrator-spec.md:362 — "assert instead that no instrument ticks
    // into a closed market, with no always-open exception."
    const plan = makeScheduler().nextTick(clockAt(MARKET_CLOSED));

    expect(plan.instruments).toEqual([]);
    // #1499: no `postCloseFlattenWindow` configured here, so the empty plan
    // is not grace-admitted either — absent, never `false`
    expect(plan.grace_only).toBeUndefined();
  });

  it('fires the full universe when the market is open', () => {
    const plan = makeScheduler().nextTick(clockAt(MARKET_OPEN));

    // Pinned against `DEFAULT_UNIVERSE` itself rather than a transcribed copy:
    // the property is "the scheduler fires the WHOLE configured universe", and
    // a hardcoded list only re-asserts that someone edited two places
    expect(assets(plan.instruments)).toEqual(DEFAULT_UNIVERSE.map((row) => row.asset));
    expect(plan.instruments).toHaveLength(20);
    // #1499: a window tick is never grace-only, regardless of what a
    // `postCloseFlattenWindow` would separately answer for this instant
    expect(plan.grace_only).toBeUndefined();
  });

  it('never fires a stock instrument on a holiday', () => {
    const holiday = new Date('2026-07-03T14:00:00Z');
    const plan = makeScheduler({ calendar: calendarOpenAt() }).nextTick(clockAt(holiday));

    expect(plan.instruments).toEqual([]);
  });

  it('gates a crypto instrument on the calendar like any other — no bypass', () => {
    // The regression #738 exists to close: a universe that DOES carry a
    // crypto row (the smoke harness's `SMOKE_TEST_UNIVERSE` does) must not
    // get an always-open exception from this scheduler. Gated exactly like
    // the 'plans nothing when the market is closed' case above, just with a
    // crypto asset_class in the universe instead of stocks
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
    // Open right up to, but not including, the close instant
    const calendar: TradingCalendar = {
      isOpen: (instant) => instant.getTime() < close.getTime(),
      isTradingDay: () => true,
      sessionStart: (instant) => SESSION_BOUNDARY.sessionStart(instant),
      // #668 — this double predates `sessionEnd`; no test here asks about it
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
      // #668 — this double predates `sessionEnd`; no test here asks about it
      sessionEnd: () => null,
    };

    makeScheduler({ calendar }).nextTick(clockAt(MARKET_OPEN));

    // Four stocks in the default universe, but one instant: a plan gated
    // per-instrument could straddle a session boundary mid-iteration
    expect(calls).toBe(1);
  });

  /**
   * The overnight properties a 14-day unattended soak depends on (#381),
   * re-verified after #738 removed the always-open exception the soak used
   * to lean on for crypto. A closed session now produces an EMPTY plan for
   * the whole universe — see orchestrator-spec.md:346's amendment on why
   * that emptiness must still be distinguishable from a healthy no-trade
   * run (that observability lives in tick-loop.ts, not here — see
   * tick-loop.test.ts).
   */
  describe('a closed session over a 14-day soak', () => {
    it('produces an empty plan rather than a stale or crashed one', () => {
      const plan = makeScheduler().nextTick(clockAt(MARKET_CLOSED));

      expect(plan.instruments).toEqual([]);
      // tick_time is still reported — the loop can log/observe a genuinely
      // empty tick, which is what lets it be told apart from a hang
      expect(plan.tick_time).toEqual(MARKET_CLOSED);
    });

    it('emits nothing per skipped instrument — the filter is silent by construction', () => {
      // `SchedulerConfig` has no logger and `nextTick` takes none, so there is
      // no seam through which a per-instrument "market closed" line could be
      // emitted every 60s for 16 hours a day. Asserted structurally because
      // that is what actually holds: a future logger added here would fail
      // this test rather than quietly filling the soak's log file
      const scheduler = makeScheduler();
      const closedPlan = scheduler.nextTick(clockAt(MARKET_CLOSED));

      expect(Object.keys(scheduler)).not.toContain('logger');
      expect(closedPlan.instruments).toEqual([]);
    });

    it('re-admits the equities on the next open tick without any re-arming', () => {
      // Stateless, so a session reopening needs no reset call that an
      // unattended run has nobody to make
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

  /**
   * #1389. Before this, NO tick existed after the bell at all: `isOpen` gates
   * the whole plan and `stocksTradingWindow` can only narrow it further, so
   * ADR-0014's post-close grace had nothing to run on no matter what
   * `decide.ts` said about it. The grace enters as its own OR'd predicate.
   */
  describe('the post-close flatten grace (#1389)', () => {
    const AFTER_THE_BELL = new Date('2026-07-15T20:00:10Z');
    const PAST_THE_GRACE = new Date('2026-07-15T20:06:00Z');

    /** The real predicate's shape: inside the grace, and nowhere else */
    const graceWindow = (instant: Date): boolean => instant.getTime() === AFTER_THE_BELL.getTime();

    it('plans the universe after the bell when the grace says so', () => {
      const scheduler = makeScheduler({ postCloseFlattenWindow: graceWindow });

      // The calendar says SHUT at this instant — that is the point. This is the
      // one predicate here that can put an instrument in the plan on its own
      const plan = scheduler.nextTick(clockAt(AFTER_THE_BELL));
      expect(assets(plan.instruments)).toHaveLength(DEFAULT_UNIVERSE.length);
    });

    it('stamps grace_only when the plan is admitted ONLY by the grace (#1499)', () => {
      const scheduler = makeScheduler({ postCloseFlattenWindow: graceWindow });

      // `runTickPlan` reads this to skip the decision-gate claim entirely —
      // absent this flag, a grace tick pays a full Analysts + Debate pass
      // before the Trader ever gets to `skip('session_closing')`
      expect(scheduler.nextTick(clockAt(AFTER_THE_BELL)).grace_only).toBe(true);
    });

    it('plans nothing once the grace has expired', () => {
      const scheduler = makeScheduler({ postCloseFlattenWindow: graceWindow });

      const plan = scheduler.nextTick(clockAt(PAST_THE_GRACE));
      expect(assets(plan.instruments)).toEqual([]);
      expect(plan.grace_only).toBeUndefined();
    });

    it('leaves grace_only absent on a window tick even when the grace predicate ALSO answers true (#1499)', () => {
      // A window tick takes precedence over the grace when both would
      // technically admit — this pins that precedence directly, with a grace
      // predicate that (unrealistically) answers true at MARKET_OPEN too, so
      // the assertion cannot pass by the grace predicate simply never firing
      // during open hours. Mutation discriminator: deleting the `marketOpen ?
      // {} :` guard in `scheduler.ts` stamps `grace_only: true` here instead
      const scheduler = makeScheduler({ postCloseFlattenWindow: () => true });

      const plan = scheduler.nextTick(clockAt(MARKET_OPEN));
      expect(assets(plan.instruments)).toHaveLength(DEFAULT_UNIVERSE.length);
      expect(plan.grace_only).toBeUndefined();
    });

    it('does not widen an entry window that a profile deliberately narrowed', () => {
      // The grace is OR'd with the OPEN test, not with the narrowing: a run
      // that trades only the LSE/US overlap still gets its post-close ticks,
      // and a run inside the session still gets none it did not ask for
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
