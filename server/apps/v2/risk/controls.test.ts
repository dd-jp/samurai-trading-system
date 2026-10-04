import { describe, expect, it } from 'vitest';
import { migratedMemoryStore } from '../../../shared/store/migrated-template.js';
import { ControlStore } from './controls.js';

function store() {
  const db = migratedMemoryStore();
  let key = 0;
  const insert = (action: string, reason = 'r', idempotencyKey?: string) => {
    key += 1;
    db.prepare(
      'INSERT INTO v2_controls (action, reason, source, idempotency_key, set_at) VALUES (?, ?, ?, ?, ?)',
    ).run(
      action,
      reason,
      'dashboard 127.0.0.1',
      idempotencyKey ?? `k${key}`,
      `2026-09-2${key}T10:00:00.000Z`,
    );
  };
  return { db, insert, controls: new ControlStore(db) };
}

describe('ControlStore', () => {
  it('reads running when no control was ever set', () => {
    expect(store().controls.current()).toEqual({ state: 'running' });
  });

  it('maps each action to its state, with the reason and the time it was set', () => {
    const { insert, controls } = store();
    insert('pause', 'checking fills');
    expect(controls.current()).toEqual({
      state: 'paused',
      reason: 'checking fills',
      setAt: '2026-09-21T10:00:00.000Z',
    });
    insert('halt', 'away');
    expect(controls.current()).toMatchObject({ state: 'halted', reason: 'away' });
    insert('resume', 'back');
    expect(controls.current()).toEqual({ state: 'running' });
  });

  it('the latest control wins even when a later one repeats an earlier action', () => {
    const { insert, controls } = store();
    insert('halt');
    insert('pause');
    insert('halt', 'again');
    expect(controls.current()).toMatchObject({ state: 'halted', reason: 'again' });
  });

  it('is append-only: updates and deletes are refused', () => {
    const { db, insert } = store();
    insert('pause');
    expect(() => db.prepare("UPDATE v2_controls SET action = 'resume'").run()).toThrow(
      /append-only/,
    );
    expect(() => db.prepare('DELETE FROM v2_controls').run()).toThrow(/append-only/);
  });

  it('refuses an unknown action, a blank reason and a repeated idempotency key', () => {
    const { insert } = store();
    expect(() => insert('flatten')).toThrow(/CHECK constraint/);
    expect(() => insert('pause', '   ')).toThrow(/CHECK constraint/);
    insert('pause', 'r', 'same');
    expect(() => insert('halt', 'r', 'same')).toThrow(/append-only/);
  });
});
