import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { V2_CONTRACT_VERSION } from '../../../../contracts/index.js';
import { openSharedStore, type StoreHandle } from '../../../shared/store/index.js';
import { TrialLedger } from '../trial-ledger.js';
import { ResearchReader } from './research.js';

const clock = { now: () => new Date('2026-10-06T21:40:00.000Z') };
const SESSION_B = {
  entries: [
    { trial: 1, config_hash: 'b1', config: { venue: 'alpaca' } },
    { trial: 2, config_hash: 'b2', config: { venue: 'saxo' } },
  ],
};
const LOOP = { status: 'not-yet-fed', owner: 'G11 not ruled', ticket: '#1717' };
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function storePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'v2-research-'));
  dirs.push(dir);
  return join(dir, 'research.sqlite');
}

function seed(db: StoreHandle): void {
  const ledger = new TrialLedger(db, clock, SESSION_B);
  ledger.record('trend', { lookback: 50 });
  ledger.record('trend', { lookback: 100 });
  ledger.record('mean-reversion', { z: 2 });
}

function read(path: string) {
  return new ResearchReader(path, clock).read();
}

describe('ResearchReader (P10)', () => {
  it('counts trials per candidate and in total, with every ledger row', () => {
    const path = storePath();
    const db = openSharedStore(path);
    seed(db);
    db.close();
    const served = read(path);
    expect(served).toMatchObject({
      contract_version: V2_CONTRACT_VERSION,
      generated_at: '2026-10-06T21:40:00.000Z',
      proposals: LOOP,
      promotions: LOOP,
      demotions: LOOP,
      ledger: {
        status: 'fed',
        total_trials: 5,
        by_candidate: [
          { candidate: 'mean-reversion', trials: 1 },
          { candidate: 'momentum/alpaca', trials: 1 },
          { candidate: 'momentum/saxo', trials: 1 },
          { candidate: 'trend', trials: 2 },
        ],
      },
    });
    if (served.ledger.status !== 'fed') throw new Error('unfed');
    expect(served.ledger.trials[0]).toEqual({
      trial: 1,
      candidate: 'momentum/alpaca',
      config_hash: 'b1',
      source: 'session-b',
      recorded_at: '2026-10-06T21:40:00.000Z',
    });
    expect(served.ledger.trials.map((row) => row.trial)).toEqual([1, 2, 3, 4, 5]);
    expect(served.ledger.by_candidate.reduce((total, row) => total + row.trials, 0)).toBe(
      served.ledger.total_trials,
    );
  });

  it('sees rows a writer committed while it is still open, before any checkpoint', () => {
    const path = storePath();
    const writer = openSharedStore(path);
    try {
      writer.pragma('wal_autocheckpoint = 0');
      seed(writer);
      expect(existsSync(`${path}-wal`)).toBe(true);
      expect(read(path).ledger).toMatchObject({ status: 'fed', total_trials: 5 });
    } finally {
      writer.close();
    }
  });

  it('reads a WAL store whose writer has closed, without creating or changing it', () => {
    const path = storePath();
    const db = openSharedStore(path);
    seed(db);
    db.close();
    expect(read(path).ledger).toMatchObject({ status: 'fed', total_trials: 5 });
    const after = new BetterSqlite3(path, { readonly: true });
    expect(after.pragma('journal_mode', { simple: true })).toBe('wal');
    after.close();
  });

  it('is empty without creating the store when none exists yet', () => {
    const path = storePath();
    expect(read(path).ledger).toEqual({ status: 'empty' });
    expect(existsSync(path)).toBe(false);
  });

  it('is empty when the store has no ledger table, or an empty one', () => {
    const bare = storePath();
    new BetterSqlite3(bare).close();
    expect(read(bare).ledger).toEqual({ status: 'empty' });
    const migrated = storePath();
    openSharedStore(migrated).close();
    expect(read(migrated).ledger).toEqual({ status: 'empty' });
  });
});
