import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SimulatedClock } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { migratedMemoryStore } from '../../shared/store/migrated-template.js';
import { main, researchStorePath, sessionBLedger, TrialLedger, trialHash } from './trial-ledger.js';

const clock = new SimulatedClock(new Date('2026-09-26T08:00:00.000Z'));
const SESSION_B = sessionBLedger();

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
    expect(trialHash('trend', { a: [1, 2] })).not.toBe(trialHash('trend', { a: { 0: 1, 1: 2 } }));
    expect(trialHash('trend', { a: 1, b: { c: [{ d: 2, e: 3 }, 1] } })).not.toBe(hash);
  });
});

describe('TrialLedger', () => {
  it("opens with Session B's eight committed trials", () => {
    const db = migratedMemoryStore();
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
    const db = migratedMemoryStore();
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

  it('lists the trials in order', () => {
    const ledger = new TrialLedger(migratedMemoryStore(), clock, SESSION_B);
    ledger.record('trend', { lookback: 60 });
    expect(ledger.list().map((row) => row.trial)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(ledger.list().at(-1)).toEqual({
      trial: 9,
      candidate: 'trend',
      config_hash: trialHash('trend', { lookback: 60 }),
      source: 'v2',
      recorded_at: '2026-09-26T08:00:00.000Z',
    });
  });

  it('reopens an existing ledger without reseeding', () => {
    const db = migratedMemoryStore();
    new TrialLedger(db, clock, SESSION_B).record('trend', { lookback: 60 });
    expect(new TrialLedger(db, clock, SESSION_B).count()).toBe(9);
  });

  it("refuses a ledger that does not open with Session B's trials", () => {
    const db = migratedMemoryStore();
    new TrialLedger(db, clock, { entries: [] }).record('trend', { lookback: 60 });
    expect(() => new TrialLedger(db, clock, SESSION_B)).toThrow(
      `TrialLedger: trial #1 is not Session B's ${SESSION_B.entries[0]?.config_hash}; the ledger must open with Session B's trials`,
    );
  });

  it('is append-only and contiguous at the database', () => {
    const db = migratedMemoryStore();
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

function links(db: StoreHandle) {
  return db.prepare('SELECT trial, link FROM v2_trial_chain ORDER BY trial').all() as {
    trial: number;
    link: string;
  }[];
}

function chained() {
  const db = migratedMemoryStore();
  const ledger = new TrialLedger(db, clock, SESSION_B);
  ledger.record('trend', { lookback: 60 });
  return { db, ledger };
}

describe('TrialLedger hash chain', () => {
  it('links every trial to the one before it', () => {
    const { db, ledger } = chained();
    const chain = links(db);
    expect(chain.map((row) => row.trial)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(chain.every((row) => /^[0-9a-f]{64}$/.test(row.link))).toBe(true);
    expect(new Set(chain.map((row) => row.link)).size).toBe(9);
    expect(ledger.chainHead()).toBe(chain.at(-1)?.link);
    expect(new TrialLedger(db, clock, SESSION_B).chainHead()).toBe(chain.at(-1)?.link);
  });

  it('starts an empty ledger at the genesis head', () => {
    expect(new TrialLedger(migratedMemoryStore(), clock, { entries: [] }).chainHead()).toBe('');
  });

  it('chains from the stored head when another ledger recorded in between', () => {
    const db = migratedMemoryStore();
    const first = new TrialLedger(db, clock, SESSION_B);
    const second = new TrialLedger(db, clock, SESSION_B);
    expect(first.record('trend', { lookback: 60 })).toBe(9);
    expect(second.record('trend', { lookback: 90 })).toBe(10);
    expect(new TrialLedger(db, clock, SESSION_B).count()).toBe(10);
  });

  it('refuses a ledger whose trial was edited outside it', () => {
    const { db } = chained();
    db.exec('DROP TRIGGER v2_trials_no_update');
    db.prepare("UPDATE v2_trials SET config = '{}' WHERE trial = 3").run();
    expect(() => new TrialLedger(db, clock, SESSION_B)).toThrow(
      'TrialLedger: trial #3 does not match its chain link; v2_trials was changed outside the ledger',
    );
  });

  it('refuses a trial inserted outside the ledger', () => {
    const { db } = chained();
    db.prepare(
      `INSERT INTO v2_trials (trial, candidate, config_hash, config, source, recorded_at)
       VALUES (10, 'trend', 'h', '{}', 'v2', 't')`,
    ).run();
    expect(() => new TrialLedger(db, clock, SESSION_B)).toThrow(
      'TrialLedger: trial #10 does not match its chain link',
    );
  });

  it('refuses a ledger with a trial removed from the middle', () => {
    const { db } = chained();
    db.pragma('foreign_keys = OFF');
    db.exec('DROP TRIGGER v2_trials_no_delete');
    db.prepare('DELETE FROM v2_trials WHERE trial = 4').run();
    expect(() => new TrialLedger(db, clock, SESSION_B)).toThrow(
      'TrialLedger: trial #5 does not match its chain link',
    );
  });

  it('refuses a ledger with its last trial removed but its link kept', () => {
    const { db } = chained();
    db.pragma('foreign_keys = OFF');
    db.exec('DROP TRIGGER v2_trials_no_delete');
    db.prepare('DELETE FROM v2_trials WHERE trial = 9').run();
    expect(() => new TrialLedger(db, clock, SESSION_B)).toThrow(
      'TrialLedger: v2_trial_chain holds 9 links for 8 trials',
    );
  });

  it('links a ledger recorded before the chain existed, once, as the ledger would have', () => {
    const { db: source, ledger } = chained();
    const legacy = migratedMemoryStore();
    const insert = legacy.prepare(
      `INSERT INTO v2_trials (trial, candidate, config_hash, config, source, recorded_at)
       VALUES (@trial, @candidate, @config_hash, @config, @source, @recorded_at)`,
    );
    for (const row of rows(source)) insert.run(row);
    expect(links(legacy)).toEqual([]);

    const reopened = new TrialLedger(legacy, clock, SESSION_B);
    expect(links(legacy)).toEqual(links(source));
    expect(reopened.chainHead()).toBe(ledger.chainHead());
    expect(reopened.record('trend', { lookback: 90 })).toBe(10);
    expect(new TrialLedger(legacy, clock, SESSION_B).count()).toBe(10);
  });
});

describe('main', () => {
  it('keeps one research ledger per machine outside the checkout unless overridden', () => {
    expect(researchStorePath({})).toBe(
      join(homedir(), 'samurai-research', 'samurai-v2-research.sqlite'),
    );
    expect(researchStorePath({ SAMURAI_RESEARCH_STORE: '/x/r.sqlite' })).toBe('/x/r.sqlite');
  });

  it('opens the research ledger file seeded with Session B and prints it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'v2-trials-'));
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      expect(main(join(directory, 'a', 'b', 'research.sqlite'))).toBe(0);
      const printed = JSON.parse(String(write.mock.calls[0]?.[0])) as {
        trials_counted: number;
        chain_head: string;
        trials: { trial: number; source: string }[];
      };
      expect(printed.trials_counted).toBe(8);
      expect(printed.chain_head).toMatch(/^[0-9a-f]{64}$/);
      expect(printed.trials.map((row) => row.source)).toEqual(
        Array.from({ length: 8 }, () => 'session-b'),
      );
    } finally {
      write.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
