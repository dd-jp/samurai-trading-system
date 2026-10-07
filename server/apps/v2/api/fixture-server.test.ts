import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { openSharedStore } from '../../../shared/store/index.js';
import { BarsMarketData } from '../data/index.js';
import {
  createFixtureStore,
  FIXTURE_START,
  FixtureClock,
  type FixtureScenario,
  fixtureScenarioOf,
} from './fixture-server.js';
import { OverviewReader } from './overview.js';
import { PositionsPanel } from './positions.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function overviewOf(scenario?: FixtureScenario) {
  const { storePath, dir } = createFixtureStore(scenario);
  dirs.push(dir);
  const db = openSharedStore(storePath);
  try {
    return await new OverviewReader(
      db,
      { now: () => new Date('2026-10-06T21:40:00.000Z') },
      'paper',
      new PositionsPanel(
        { lastBarsBefore: () => Promise.resolve(new Map()) },
        new BarsMarketData({ load: () => undefined }, []),
      ),
    ).read();
  } finally {
    db.close();
  }
}

describe('createFixtureStore', () => {
  it('seeds a v2 store every Today panel reads as fed', async () => {
    const overview = await overviewOf();
    expect(overview.loss_budget).toMatchObject({
      status: 'fed',
      ytd_loss_gbp: 60,
      step_marks_gbp: [500, 1_000, 1_500],
    });
    expect(overview.positions).toMatchObject({ status: 'fed', total_gbp: null });
    expect(overview.decisions).toMatchObject({ status: 'fed', trading_date: '2026-10-05' });
    expect(overview.control.state).toBe('running');
  });

  it('seeds the primary book halted by the loss budget in that scenario', async () => {
    const overview = await overviewOf('loss-budget-halted');
    expect(overview.control).toMatchObject({
      state: 'halted-loss-budget',
      in_force: null,
      loss_budget_halted_books: ['debate/primary'],
    });
    expect(overview.loss_budget).toMatchObject({ status: 'fed', ytd_loss_gbp: 1_500 });
  });
});

describe('fixtureScenarioOf', () => {
  it('reads the default when unset, a named scenario, and refuses any other', () => {
    expect(fixtureScenarioOf(undefined)).toBe('default');
    expect(fixtureScenarioOf('loss-budget-halted')).toBe('loss-budget-halted');
    expect(() => fixtureScenarioOf('halted')).toThrow(
      'V2_FIXTURE_SCENARIO must be one of default, loss-budget-halted',
    );
  });
});

describe('FixtureClock', () => {
  it('starts on the fixture day whatever the wall clock reads, then advances with it', () => {
    let wall = Date.parse('2027-03-01T08:00:00.000Z');
    const clock = new FixtureClock(FIXTURE_START, () => wall);
    expect(clock.now().toISOString()).toBe('2026-10-05T21:45:00.000Z');
    wall += 12_000;
    expect(clock.now().toISOString()).toBe('2026-10-05T21:45:12.000Z');
  });

  it('defaults to the fixture start on the system wall clock', () => {
    const drift = new FixtureClock().now().getTime() - FIXTURE_START.getTime();
    expect(drift).toBeGreaterThanOrEqual(0);
    expect(drift).toBeLessThan(5_000);
  });
});
