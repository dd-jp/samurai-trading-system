import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SimulatedClock } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import {
  SESSION_B_TRIALS_PATH,
  type SessionBLedger,
  TrialLedger,
  trialHash,
} from './trial-ledger.js';

const clock = new SimulatedClock(new Date('2026-09-26T08:00:00.000Z'));
const SESSION_B = JSON.parse(readFileSync(SESSION_B_TRIALS_PATH, 'utf8')) as SessionBLedger;

function rows(db: StoreHandle) {
  return db
    .prepare('SELECT trial, candidate, config_hash, config, source, recorded_at FROM v2_trials')
    .all() as {
    trial: number;
    candidate: string;
    config_hash: string;
    config: string;
    source: string;
    recorded_at: string;
  }[];
}

describe('trialHash', () => {
  it('ignores key order at every depth and separates candidates', () => {
    const hash = trialHash('trend', { a: 1, b: { c: [1, { d: 2, e: 3 }] } });
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(trialHash('trend', { b: { c: [1, { e: 3, d: 2 }] }, a: 1 })).toBe(hash);
    expect(trialHash('pead', { a: 1, b: { c: [1, { d: 2, e: 3 }] } })).not.toBe(hash);
    expect(trialHash('trend', { a: 1, b: { c: [{ d: 2, e: 3 }, 1] } })).not.toBe(hash);
  });
});

describe('TrialLedger', () => {
  it("opens with Session B's eight committed trials", () => {
    const db = openSharedStore(':memory:');
    const ledger = new TrialLedger(db, clock, SESSION_B);
    expect(SESSION_B.entries).toHaveLength(8);
    expect(ledger.count()).toBe(8);
    const seeded = rows(db);
    expect(seeded.map((row) => [row.trial, row.candidate, row.config_hash, row.source])).toEqual(
      SESSION_B.entries.map((entry) => [
        entry.trial,
        `momentum/${entry.config.venue}`,
        entry.config_hash,
        'session-b',
      ]),
    );
    expect(seeded[0]?.recorded_at).toBe('2026-09-26T08:00:00.000Z');
  });

  it('numbers new trials after Session B and returns the same number for a repeated configuration', () => {
    const db = openSharedStore(':memory:');
    const ledger = new TrialLedger(db, clock, SESSION_B);
    expect(ledger.record('trend', { lookback: 60, stop: true })).toBe(9);
    expect(ledger.record('trend', { stop: true, lookback: 60 })).toBe(9);
    expect(ledger.record('trend', { lookback: 60, stop: false })).toBe(10);
    expect(ledger.count()).toBe(10);
    const last = rows(db).at(-1);
    expect(last).toMatchObject({
      trial: 10,
      candidate: 'trend',
      config_hash: trialHash('trend', { lookback: 60, stop: false }),
      config: '{"lookback":60,"stop":false}',
      source: 'v2',
    });
  });

  it('reopens an existing ledger without reseeding', () => {
    const db = openSharedStore(':memory:');
    new TrialLedger(db, clock, SESSION_B).record('trend', { lookback: 60 });
    expect(new TrialLedger(db, clock, SESSION_B).count()).toBe(9);
  });

  it("refuses a ledger that does not open with Session B's trials", () => {
    const db = openSharedStore(':memory:');
    new TrialLedger(db, clock, { entries: [] }).record('trend', { lookback: 60 });
    expect(() => new TrialLedger(db, clock, SESSION_B)).toThrow(
      `TrialLedger: trial #1 is not Session B's ${SESSION_B.entries[0]?.config_hash}; the ledger must open with Session B's trials`,
    );
  });

  it('is append-only and contiguous at the database', () => {
    const db = openSharedStore(':memory:');
    new TrialLedger(db, clock, SESSION_B);
    expect(() => db.prepare('UPDATE v2_trials SET candidate = ?').run('x')).toThrow(
      'v2_trials is append-only',
    );
    expect(() => db.prepare('DELETE FROM v2_trials').run()).toThrow('v2_trials is append-only');
    expect(() =>
      db
        .prepare(
          `INSERT INTO v2_trials (trial, candidate, config_hash, config, source, recorded_at)
           VALUES (11, 'x', 'h', '{}', 'v2', 't')`,
        )
        .run(),
    ).toThrow('v2_trials: trial numbers are contiguous from 1');
  });
});
