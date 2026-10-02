import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { cacheStatements } from './statement-cache.js';

const handles: BetterSqlite3.Database[] = [];

afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});

function cachedHandle(): BetterSqlite3.Database {
  const db = cacheStatements(new BetterSqlite3(':memory:'));
  handles.push(db);
  db.exec('CREATE TABLE t (a INTEGER, b TEXT)');
  db.prepare('INSERT INTO t (a, b) VALUES (?, ?)').run(1, 'x');
  db.prepare('INSERT INTO t (a, b) VALUES (?, ?)').run(2, 'y');
  return db;
}

describe('cacheStatements', () => {
  it('returns one statement per SQL text, so the handle holds a bounded set however often it prepares', () => {
    const db = cachedHandle();
    const seen = new Set<unknown>();
    for (let i = 0; i < 1_000; i++) {
      seen.add(db.prepare('SELECT b FROM t WHERE a = ?'));
      seen.add(db.prepare('SELECT COUNT(*) AS n FROM t'));
    }
    expect(seen.size).toBe(2);
    expect(db.prepare('SELECT b FROM t WHERE a = ?').get(2)).toEqual({ b: 'y' });
  });

  it('keeps handles apart', () => {
    const sql = 'SELECT COUNT(*) AS n FROM t';
    expect(cachedHandle().prepare(sql)).not.toBe(cachedHandle().prepare(sql));
  });

  it('hands a fresh statement to a caller while the cached one is mid-iteration', () => {
    const db = cachedHandle();
    const sql = 'SELECT a FROM t ORDER BY a';
    const outer = db.prepare(sql).iterate() as IterableIterator<{ a: number }>;
    expect(outer.next().value).toEqual({ a: 1 });

    const inner = db.prepare(sql);

    expect(inner.all()).toEqual([{ a: 1 }, { a: 2 }]);
    expect(outer.next().value).toEqual({ a: 2 });
    outer.return?.();
    expect(db.prepare(sql)).not.toBe(inner);
  });

  it('clears a previous caller’s pluck, raw or expand mode before reuse', () => {
    const db = cachedHandle();
    const sql = 'SELECT a, b FROM t WHERE a = 1';
    db.prepare(sql).pluck();
    expect(db.prepare(sql).get()).toEqual({ a: 1, b: 'x' });
    db.prepare(sql).raw();
    expect(db.prepare(sql).get()).toEqual({ a: 1, b: 'x' });
    db.prepare(sql).expand();
    expect(db.prepare(sql).get()).toEqual({ a: 1, b: 'x' });
  });

  it('reuses writers too, and a statement that fails to prepare is not cached', () => {
    const db = cachedHandle();
    const insert = 'INSERT INTO t (a, b) VALUES (?, ?)';
    expect(db.prepare(insert)).toBe(db.prepare(insert));
    expect(() => db.prepare('SELECT nope FROM missing')).toThrow(/no such table/);
    db.exec('CREATE TABLE missing (nope INTEGER)');
    expect(db.prepare('SELECT nope FROM missing').all()).toEqual([]);
  });

  it('sees schema changes made after a statement was cached', () => {
    const db = cachedHandle();
    const sql = 'SELECT * FROM t WHERE a = 1';
    expect(db.prepare(sql).get()).toEqual({ a: 1, b: 'x' });
    db.exec('ALTER TABLE t ADD COLUMN c INTEGER DEFAULT 7');
    expect(db.prepare(sql).get()).toEqual({ a: 1, b: 'x', c: 7 });
  });
});
