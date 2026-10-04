import { describe, expect, it } from 'vitest';
import { listMigrations, MIGRATIONS_DIR } from './migrate.js';
import { migratedMemoryStore, migratedTemplate } from './migrated-template.js';

function appliedVersions(db: ReturnType<typeof migratedTemplate>): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n;
}

describe('migrated template', () => {
  it('migrates once and hands out the same template', () => {
    expect(migratedTemplate()).toBe(migratedTemplate());
    expect(appliedVersions(migratedTemplate())).toBe(listMigrations(MIGRATIONS_DIR).length);
  });

  it('gives each caller its own fully migrated copy, isolated from the template and each other', () => {
    const first = migratedMemoryStore();
    const second = migratedMemoryStore();
    expect(appliedVersions(first)).toBe(listMigrations(MIGRATIONS_DIR).length);
    expect(first.pragma('foreign_keys', { simple: true })).toBe(1);
    first.exec('CREATE TABLE scratch (x INTEGER)');
    const tableCount = (db: typeof first) =>
      db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'scratch'").get();
    expect(tableCount(first)).toEqual({ n: 1 });
    expect(tableCount(second)).toEqual({ n: 0 });
    expect(tableCount(migratedTemplate())).toEqual({ n: 0 });
    first.close();
    second.close();
  });
});
