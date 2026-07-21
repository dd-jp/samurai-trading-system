import { describe, expect, it } from 'vitest';
import { InMemoryConfigTrialLog } from './config-trial-log.js';
import type { BacktestReport } from './types.js';

function report(config_hash: string, seed = 1): BacktestReport {
  return { config_hash, seed, tick_outcomes: [], lookahead_audit: 'passed' };
}

describe('InMemoryConfigTrialLog', () => {
  it('counts one trial per distinct config hash', () => {
    const log = new InMemoryConfigTrialLog();

    log.recordTrial('config-a', report('config-a'));
    log.recordTrial('config-b', report('config-b'));
    log.recordTrial('config-c', report('config-c'));

    expect(log.distinctTrialCount()).toBe(3);
  });

  it('starts at zero — an unsearched config space deflates by nothing', () => {
    expect(new InMemoryConfigTrialLog().distinctTrialCount()).toBe(0);
  });

  /**
   * The load-bearing rule (spec: "N = number of DISTINCT configs evaluated for
   * selection — not the number of runs"). If a re-run incremented N, N would
   * grow without bound and DSR/PBO/MinBTL would start failing healthy
   * strategies for reasons unrelated to overfitting.
   */
  it('does not increment N when the same config is re-run', () => {
    const log = new InMemoryConfigTrialLog();

    log.recordTrial('config-a', report('config-a'));
    expect(log.distinctTrialCount()).toBe(1);

    // Same config, evaluated again — a re-run, not a new selection search.
    log.recordTrial('config-a', report('config-a'));
    log.recordTrial('config-a', report('config-a'));

    expect(log.distinctTrialCount()).toBe(1);
  });

  it('does not increment N when a run differs only by seed', () => {
    const log = new InMemoryConfigTrialLog();

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
    const log = new InMemoryConfigTrialLog();
    log.recordTrial('config-a', report('config-a'));

    log.distinctTrialCount();
    log.distinctTrialCount();
    log.getTrial('config-a');

    expect(log.distinctTrialCount()).toBe(1);
  });

  it('keeps the latest report for a re-run config', () => {
    const log = new InMemoryConfigTrialLog();

    log.recordTrial('config-a', report('config-a', 1));
    log.recordTrial('config-a', report('config-a', 99));

    expect(log.getTrial('config-a')?.seed).toBe(99);
  });

  it('returns undefined for a config that was never evaluated', () => {
    expect(new InMemoryConfigTrialLog().getTrial('never-seen')).toBeUndefined();
  });

  describe('refuses to corrupt N', () => {
    it('throws when the report is logged under a mismatched key', () => {
      const log = new InMemoryConfigTrialLog();

      expect(() => log.recordTrial('config-a', report('config-b'))).toThrow(
        /does not match the key/,
      );
      expect(log.distinctTrialCount()).toBe(0);
    });

    it('throws on an empty config hash', () => {
      const log = new InMemoryConfigTrialLog();

      expect(() => log.recordTrial('', report(''))).toThrow(/must not be empty/);
      expect(log.distinctTrialCount()).toBe(0);
    });
  });
});
