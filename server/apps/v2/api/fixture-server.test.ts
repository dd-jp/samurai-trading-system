import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { openSharedStore } from '../../../shared/store/index.js';
import { BarsMarketData } from '../data/index.js';
import { createFixtureStore } from './fixture-server.js';
import { OverviewReader } from './overview.js';
import { PositionsPanel } from './positions.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('createFixtureStore', () => {
  it('seeds a v2 store every Today panel reads as fed', async () => {
    const { storePath, dir } = createFixtureStore();
    dirs.push(dir);
    const db = openSharedStore(storePath);
    try {
      const overview = await new OverviewReader(
        db,
        { now: () => new Date('2026-10-06T21:40:00.000Z') },
        'paper',
        new PositionsPanel(
          { lastBarsBefore: () => Promise.resolve(new Map()) },
          new BarsMarketData({ load: () => undefined }, []),
        ),
      ).read();
      expect(overview.loss_budget).toMatchObject({
        status: 'fed',
        ytd_loss_gbp: 60,
        step_marks_gbp: [500, 1_000, 1_500],
      });
      expect(overview.positions).toMatchObject({ status: 'fed', total_gbp: null });
      expect(overview.decisions).toMatchObject({ status: 'fed', trading_date: '2026-10-05' });
      expect(overview.control.state).toBe('running');
    } finally {
      db.close();
    }
  });
});
