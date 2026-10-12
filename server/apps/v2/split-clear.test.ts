import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SimulatedClock } from '../../shared/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import { V2_STORE_PATH } from './index.js';
import { SqliteSplitChecks } from './split-checks.js';
import { main, parseSplitClearArgs, SPLIT_CLEAR_USAGE } from './split-clear.js';

const FLAGS = ['--instrument', 'AAPL', '--exchange', 'US', '--reason', 'checked the 8-K'];

describe('parseSplitClearArgs', () => {
  it('parses a clear, the v2 store by default', () => {
    expect(parseSplitClearArgs(FLAGS)).toEqual({
      instrument: 'AAPL',
      exchange: 'US',
      reason: 'checked the 8-K',
      storePath: V2_STORE_PATH,
    });
    expect(
      parseSplitClearArgs([
        ...FLAGS.slice(0, 2),
        '--exchange',
        'LSE',
        ...FLAGS.slice(4),
        '--store',
        'x.sqlite',
      ]),
    ).toMatchObject({ exchange: 'LSE', storePath: 'x.sqlite' });
  });

  it('refuses an unknown exchange, a missing or blank flag, an unknown flag and a stray value', () => {
    expect(() =>
      parseSplitClearArgs([...FLAGS.slice(0, 2), '--exchange', 'XETRA', ...FLAGS.slice(4)]),
    ).toThrow(`unknown exchange XETRA\n${SPLIT_CLEAR_USAGE}`);
    expect(() => parseSplitClearArgs(FLAGS.slice(0, 4))).toThrow(
      `--reason is required\n${SPLIT_CLEAR_USAGE}`,
    );
    expect(() => parseSplitClearArgs(FLAGS.slice(2))).toThrow(/--instrument is required/);
    expect(() => parseSplitClearArgs([...FLAGS.slice(0, 2), ...FLAGS.slice(4)])).toThrow(
      /--exchange is required/,
    );
    expect(() => parseSplitClearArgs([...FLAGS.slice(0, 4), '--reason', '  '])).toThrow(
      /--reason is required/,
    );
    expect(() => parseSplitClearArgs([...FLAGS, '--force', 'yes'])).toThrow(SPLIT_CLEAR_USAGE);
    expect(() => parseSplitClearArgs([...FLAGS, 'stray'])).toThrow(SPLIT_CLEAR_USAGE);
  });
});

describe('split-clear main', () => {
  it('journals the clear and lifts an open block', () => {
    const directory = mkdtempSync(join(tmpdir(), 'v2-split-clear-'));
    const storePath = join(directory, 'v2.sqlite');
    const clock = new SimulatedClock(new Date('2026-10-12T07:00:00.000Z'));
    try {
      const db = openSharedStore(storePath);
      const checks = new SqliteSplitChecks(db, clock);
      checks.record({
        tradingDate: '2026-10-12',
        instrument: 'AAPL',
        exchange: 'US',
        window: { after: '2026-10-01', through: '2026-10-09' },
        verdict: 'block',
        reason: 'sources_disagree',
        ratio: 1,
      });
      expect(checks.block('AAPL', 'US', '2026-10-12')).toBeDefined();
      db.close();
      clock.advanceTo(new Date('2026-10-12T09:00:00.000Z'));
      expect(main([...FLAGS, '--store', storePath], clock)).toEqual({
        instrument: 'AAPL',
        exchange: 'US',
        reason: 'checked the 8-K',
        clearedAt: '2026-10-12T09:00:00.000Z',
      });
      const reopened = openSharedStore(storePath);
      expect(
        new SqliteSplitChecks(reopened, clock).block('AAPL', 'US', '2026-10-12'),
      ).toBeUndefined();
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
