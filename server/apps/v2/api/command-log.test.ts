import { afterEach, describe, expect, it } from 'vitest';
import { guardedStore, openSharedStore, type StoreHandle } from '../../../shared/store/index.js';
import { CommandLog } from './command-log.js';

const HANDLED_AT = new Date('2026-09-29T10:00:05.000Z');
const SENT_AT = new Date('2026-09-29T10:00:00.000Z');

let db: StoreHandle;

afterEach(() => db?.close());

function log(): CommandLog {
  db = openSharedStore(':memory:');
  return new CommandLog(guardedStore(db, 'telegram', { enabled: true }), { now: () => HANDLED_AT });
}

const entry = {
  updateId: 41,
  chatId: '12345',
  command: 'halt',
  outcome: 'applied',
  detail: 'paused',
  sentAt: SENT_AT,
} as const;

describe('CommandLog', () => {
  it('stores the command with its outcome and both timestamps', () => {
    log().record(entry);
    expect(db.prepare('SELECT * FROM v2_commands').all()).toEqual([
      {
        command_id: 1,
        update_id: 41,
        chat_id: '12345',
        command: 'halt',
        outcome: 'applied',
        detail: 'paused',
        control_id: null,
        sent_at: '2026-09-29T10:00:00.000Z',
        handled_at: '2026-09-29T10:00:05.000Z',
      },
    ]);
  });

  it('caps the stored command text so a stranger cannot fill the journal', () => {
    log().record({ ...entry, command: 'x'.repeat(500) });
    const [row] = db.prepare('SELECT command FROM v2_commands').all() as { command: string }[];
    expect(row?.command).toHaveLength(32);
  });

  it('knows which updates it has seen', () => {
    const commands = log();
    expect(commands.has(41)).toBe(false);
    commands.record(entry);
    commands.record({ ...entry, updateId: 40 });
    expect(commands.has(41)).toBe(true);
    expect(commands.has(42)).toBe(false);
  });

  it('refuses a second row for the same update', () => {
    const commands = log();
    commands.record(entry);
    expect(() => commands.record(entry)).toThrow(/UNIQUE/);
  });

  it('is append-only', () => {
    log().record(entry);
    expect(() => db.prepare("UPDATE v2_commands SET outcome = 'noop'").run()).toThrow(
      /append-only/,
    );
    expect(() => db.prepare('DELETE FROM v2_commands').run()).toThrow(/append-only/);
  });

  it('rejects an outcome outside the vocabulary', () => {
    expect(() => log().record({ ...entry, outcome: 'sent' as never })).toThrow(/CHECK/);
  });

  it('links to the control row it wrote', () => {
    const commands = log();
    db.prepare(
      `INSERT INTO v2_controls (action, reason, source, idempotency_key, set_at)
       VALUES ('pause', 'r', 'telegram', 'telegram-41', '2026-09-29T10:00:00.000Z')`,
    ).run();
    commands.record({ ...entry, controlId: 1 });
    expect(db.prepare('SELECT control_id FROM v2_commands').get()).toEqual({ control_id: 1 });
  });
});
