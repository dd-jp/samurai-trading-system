import type { ConfigTrialLog } from './config-trial-log.js';
import { InMemoryConfigTrialLog } from './config-trial-log.js';
import type { BacktestReport } from './types.js';

function report(config_hash: string, seed = 1): BacktestReport {
  return { config_hash, seed, tick_outcomes: [], lookahead_audit: 'passed' };
}

const LOG_IMPLEMENTATIONS: Array<[string, () => ConfigTrialLog]> = [
  ['InMemoryConfigTrialLog', () => new InMemoryConfigTrialLog()],
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

  it('does not increment N when the same config is re-run', () => {
    const log = makeLog();

    log.recordTrial('config-a', report('config-a'));
    expect(log.distinctTrialCount()).toBe(1);

    log.recordTrial('config-a', report('config-a'));
    log.recordTrial('config-a', report('config-a'));

    expect(log.distinctTrialCount()).toBe(1);
  });

  it('does not increment N when a run differs only by seed', () => {
    const log = makeLog();

    log.recordTrial('config-a', report('config-a', 1));
    log.recordTrial('config-a', report('config-a', 2));

    expect(log.distinctTrialCount()).toBe(1);
  });

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
