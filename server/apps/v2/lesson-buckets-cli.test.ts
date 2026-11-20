import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migratedMemoryStore } from '../../shared/store/migrated-template.js';
import { main, nousLessonClient } from './lesson-buckets-cli.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function emptyStoreFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lesson-buckets-'));
  dirs.push(dir);
  const path = join(dir, 'store.sqlite');
  const db = migratedMemoryStore();
  writeFileSync(path, db.serialize());
  db.close();
  return path;
}

const TODAY = () => new Date('2026-11-20T15:00:00.000Z');

describe('lesson-buckets-cli', () => {
  it('reports a run on an empty ledger', async () => {
    const lines: string[] = [];
    const code = await main(['2026-11-20', emptyStoreFile()], (line) => lines.push(line), TODAY);
    expect(code).toBe(0);
    expect(lines).toEqual([
      'lesson buckets for debate/primary at as_of 2026-11-20: 0 closed trades, 0 bucket(s) with n >= 10, 0 written',
    ]);
  });

  it('refuses a missing or malformed as_of', async () => {
    for (const argv of [[], ['20-11-2026']]) {
      const lines: string[] = [];
      expect(await main(argv, (line) => lines.push(line), TODAY)).toBe(1);
      expect(lines[0]).toContain('usage: npm run v2:lessons');
    }
  });

  it('refuses an as_of after today', async () => {
    const lines: string[] = [];
    const code = await main(['2026-11-21', emptyStoreFile()], (line) => lines.push(line), TODAY);
    expect(code).toBe(1);
    expect(lines[0]).toContain('after today');
  });

  it('distils on request, and a ledger with no bucket calls no model', async () => {
    const lines: string[] = [];
    const never = () => {
      throw new Error('the model must not be called');
    };
    const code = await main(
      ['2026-11-20', emptyStoreFile(), '--distil'],
      (line) => lines.push(line),
      TODAY,
      never,
    );
    expect(code).toBe(0);
    expect(lines[0]?.split('\n')[1]).toBe('lessons: 0 (none), 0 written');
  });

  it('needs the Nous wiring in the environment to call the model', () => {
    const db = migratedMemoryStore();
    expect(() => nousLessonClient({})(db)).toThrow(/--distil needs NOUS_BASE_URL/);
    db.close();
  });
});
