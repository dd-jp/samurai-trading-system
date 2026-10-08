import { describe, expect, it } from 'vitest';
import { SimulatedClock } from '../../shared/index.js';
import { migratedMemoryStore } from '../../shared/store/migrated-template.js';
import { CanaryLog } from './canary-log.js';
import { TrialLedger } from './trial-ledger.js';

const clock = new SimulatedClock(new Date('2026-10-07T09:00:00.000Z'));

describe('CanaryLog', () => {
  it('appends each run with its kind, seed and result, apart from the trial counter', () => {
    const db = migratedMemoryStore();
    try {
      const ledger = new TrialLedger(db, clock, { entries: [] });
      const log = new CanaryLog(db, clock);
      log.record({
        candidate: 'c',
        candidateHash: 'h1',
        kind: 'shift',
        seed: undefined,
        result: { survives: true },
      });
      log.record({
        candidate: 'c',
        candidateHash: 'h1',
        kind: 'random',
        seed: 7,
        result: { sharpe: 0.1 },
      });
      expect(log.list()).toEqual([
        {
          run_id: 1,
          candidate: 'c',
          candidate_hash: 'h1',
          kind: 'shift',
          seed: null,
          result: '{"survives":true}',
          recorded_at: '2026-10-07T09:00:00.000Z',
        },
        {
          run_id: 2,
          candidate: 'c',
          candidate_hash: 'h1',
          kind: 'random',
          seed: 7,
          result: '{"sharpe":0.1}',
          recorded_at: '2026-10-07T09:00:00.000Z',
        },
      ]);
      expect(ledger.count()).toBe(0);
    } finally {
      db.close();
    }
  });

  it('refuses a seed on a shift or band row, a random run without one, an unknown kind and any rewrite', () => {
    const db = migratedMemoryStore();
    try {
      const log = new CanaryLog(db, clock);
      const run = { candidate: 'c', candidateHash: 'h', result: {} };
      expect(() => log.record({ ...run, kind: 'shift', seed: 1 })).toThrow(/CHECK/);
      expect(() => log.record({ ...run, kind: 'random', seed: undefined })).toThrow(/CHECK/);
      expect(() => log.record({ ...run, kind: 'random_band', seed: 1 })).toThrow(/CHECK/);
      expect(() => log.record({ ...run, kind: 'other' as 'shift', seed: undefined })).toThrow(
        /CHECK/,
      );
      log.record({ ...run, kind: 'shift', seed: undefined });
      log.record({ ...run, kind: 'random_band', seed: undefined });
      expect(() => db.exec("UPDATE v2_canary_runs SET result = '{}'")).toThrow(/append-only/);
      expect(() => db.exec('DELETE FROM v2_canary_runs')).toThrow(/append-only/);
      expect(log.list().map((row) => [row.kind, row.seed])).toEqual([
        ['shift', null],
        ['random_band', null],
      ]);
    } finally {
      db.close();
    }
  });
});
