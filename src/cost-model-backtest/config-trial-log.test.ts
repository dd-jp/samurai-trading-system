import { describe, expect, it } from 'vitest';
import { openSharedStore } from '../shared/store/open-shared-store.js';
import type { ConfigTrialLog } from './config-trial-log.js';
import { InMemoryConfigTrialLog } from './config-trial-log.js';
import { SqliteConfigTrialLog } from './sqlite-config-trial-log.js';
import type { BacktestReport } from './types.js';

function report(config_hash: string, seed = 1): BacktestReport {
  return { config_hash, seed, tick_outcomes: [], lookahead_audit: 'passed' };
}

/**
 * The trial-count discipline is a property of the `ConfigTrialLog` port, so
 * every case runs against both implementations: the in-memory fixture and
 * the real SQLite-backed store over `config_trials` (#196).
 */
const LOG_IMPLEMENTATIONS: Array<[string, () => ConfigTrialLog]> = [
  ['InMemoryConfigTrialLog', () => new InMemoryConfigTrialLog()],
  ['SqliteConfigTrialLog', () => new SqliteConfigTrialLog(openSharedStore(':memory:'))],
];

describe.each(LOG_IMPLEMENTATIONS)('%s', (_name, makeLog) => {
  it('counts one trial per distinct config hash', () => {
    const log = makeLog();

    log.recordTrial('config-a', report('config-a'));
    log.recordTrial('config-b', report('config-b'));
    log.recordTrial('config-c', report('config-c'));

    expect(log.distinctTrialCount()).toBe(3);
  });

  it('starts at zero — an unsearched config space deflates by nothing', () => {
    expect(makeLog().distinctTrialCount()).toBe(0);
  });

  /**
   * The load-bearing rule (spec: "N = number of DISTINCT configs evaluated for
   * selection — not the number of runs"). If a re-run incremented N, N would
   * grow without bound and DSR/PBO/MinBTL would start failing healthy
   * strategies for reasons unrelated to overfitting.
   */
  it('does not increment N when the same config is re-run', () => {
    const log = makeLog();

    log.recordTrial('config-a', report('config-a'));
    expect(log.distinctTrialCount()).toBe(1);

    // Same config, evaluated again — a re-run, not a new selection search.
    log.recordTrial('config-a', report('config-a'));
    log.recordTrial('config-a', report('config-a'));

    expect(log.distinctTrialCount()).toBe(1);
  });

  it('does not increment N when a run differs only by seed', () => {
    const log = makeLog();

    log.recordTrial('config-a', report('config-a', 1));
    log.recordTrial('config-a', report('config-a', 2));

    // The seed is not part of the config identity — config_hash is.
    expect(log.distinctTrialCount()).toBe(1);
  });

  /**
   * FL's periodic revalidation monitors one frozen, already-selected config: it
   * *reads* the selection-N and never appends. From this log's side, the
   * property is that reading N is free of side effects.
   */
  it('does not increment N when N is read, however often', () => {
    const log = makeLog();
    log.recordTrial('config-a', report('config-a'));

    log.distinctTrialCount();
    log.distinctTrialCount();
    log.getTrial('config-a');

    expect(log.distinctTrialCount()).toBe(1);
  });

  it('keeps the latest report for a re-run config', () => {
    const log = makeLog();

    log.recordTrial('config-a', report('config-a', 1));
    log.recordTrial('config-a', report('config-a', 99));

    expect(log.getTrial('config-a')?.seed).toBe(99);
  });

  it('returns undefined for a config that was never evaluated', () => {
    expect(makeLog().getTrial('never-seen')).toBeUndefined();
  });

  describe('refuses to corrupt N', () => {
    it('throws when the report is logged under a mismatched key', () => {
      const log = makeLog();

      expect(() => log.recordTrial('config-a', report('config-b'))).toThrow(
        /does not match the key/,
      );
      expect(log.distinctTrialCount()).toBe(0);
    });

    it('throws on an empty config hash', () => {
      const log = makeLog();

      expect(() => log.recordTrial('', report(''))).toThrow(/must not be empty/);
      expect(log.distinctTrialCount()).toBe(0);
    });
  });
});

/**
 * FL's revalidation path (spec: "must read `config_trials` directly ... and
 * must never call `recordTrial`") needs to read a trial by hash without ever
 * having called `recordTrial` on that same log instance — i.e. against a
 * durable store, not just an in-process map. SQLite-only: this is exactly
 * what the in-memory implementation cannot demonstrate (a fresh instance has
 * no prior writes to read).
 */
describe('SqliteConfigTrialLog — reads survive a fresh handle to the same store', () => {
  it('can read a previously recorded trial by config_hash without calling recordTrial', () => {
    const db = openSharedStore(':memory:');
    new SqliteConfigTrialLog(db).recordTrial('config-a', report('config-a', 42));

    // A second log instance over the same underlying store — read-only from here.
    const reader = new SqliteConfigTrialLog(db);

    expect(reader.getTrial('config-a')).toEqual(report('config-a', 42));
    expect(reader.distinctTrialCount()).toBe(1);
  });
});

describe('SqliteConfigTrialLog', () => {
  it('overwrites result_json in place on a re-run — no new row', () => {
    const db = openSharedStore(':memory:');
    const log = new SqliteConfigTrialLog(db);

    log.recordTrial('config-a', report('config-a', 1));
    log.recordTrial('config-a', report('config-a', 2));

    expect(db.prepare('SELECT COUNT(*) AS count FROM config_trials').get()).toEqual({ count: 1 });
    expect(log.getTrial('config-a')?.seed).toBe(2);
  });

  it('distinctTrialCount() is a SELECT COUNT(*) FROM config_trials', () => {
    const db = openSharedStore(':memory:');
    const log = new SqliteConfigTrialLog(db);

    log.recordTrial('config-a', report('config-a'));
    log.recordTrial('config-b', report('config-b'));
    db.prepare(
      "INSERT INTO config_trials (config_hash, seed, config_json, result_json, recorded_at) VALUES ('config-c', 1, '{}', '{}', '2026-01-01T00:00:00.000Z')",
    ).run();

    expect(log.distinctTrialCount()).toBe(3);
    expect(
      (db.prepare('SELECT COUNT(*) AS count FROM config_trials').get() as { count: number }).count,
    ).toBe(3);
  });
});
