import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import BetterSqlite3 from 'better-sqlite3';
import { stripLineComments } from '../strip-comments.js';
import { MIGRATIONS_DIR, runMigrations } from './migrate.js';

const SPEC_PATH = fileURLToPath(
  new URL('../../../docs/specs/shared-sqlite-store-spec.md', import.meta.url),
);

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

interface IndexInfo {
  name: string;
  sql: string;
}

function extractSqlBlocks(specText: string): string[] {
  const blockRe = /```sql\n([\s\S]*?)```/g;
  return Array.from(specText.matchAll(blockRe), (m) => m[1]);
}

function splitStatements(sql: string): string[] {
  const stmts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of sql) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    current += ch;
    if (ch === ';' && depth === 0) {
      stmts.push(current.trim());
      current = '';
    }
  }
  if (current.trim()) stmts.push(current.trim());
  return stmts.filter(Boolean);
}

function normalizeCreateTableSql(sql: string): string {
  return stripLineComments(sql)
    .replace(/"([A-Za-z_][A-Za-z0-9_]*)"/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/\bNULL\b/gi, (match: string, offset: number, full: string) => {
      const before = full.slice(0, offset);
      if (/\bNOT\s*$/i.test(before) || /\bIS\s*$/i.test(before) || /\bDEFAULT\s*$/i.test(before)) {
        return match;
      }
      return '';
    })
    .replace(/\s+/g, ' ')
    .replace(/\s+([,)])/g, '$1')
    .trim();
}

function buildDbFromSpec(specText: string): BetterSqlite3.Database {
  const blocks = extractSqlBlocks(specText);
  const allStatements: string[] = [];
  for (const block of blocks) {
    for (const s of splitStatements(stripLineComments(block))) allStatements.push(s);
  }

  const createTableStmts = allStatements.filter((s) => /^CREATE TABLE/i.test(s));
  const createIndexStmts = allStatements.filter((s) => /^CREATE (UNIQUE )?INDEX/i.test(s));
  const other = allStatements.filter(
    (s) =>
      !/^CREATE TABLE/i.test(s) && !/^CREATE (UNIQUE )?INDEX/i.test(s) && !/^ALTER TABLE/i.test(s),
  );
  if (other.length > 0) {
    throw new Error(
      `spec-schema-drift: unrecognized SQL fence content (not CREATE TABLE/INDEX/ALTER TABLE): ${JSON.stringify(
        other.map((s) => s.slice(0, 80)),
      )}. Every \`\`\`sql block in the spec must be schema DDL this test can classify — if this is a non-DDL worked example (e.g. an upsert or a SELECT), give it a \`\`\`sql-example fence instead of \`\`\`sql so this test skips it, rather than widening this classifier.`,
    );
  }

  const db = new BetterSqlite3(':memory:');
  for (const s of createTableStmts) db.exec(s);
  for (const s of createIndexStmts) db.exec(s);
  return db;
}

function buildMigratedDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  runMigrations(db, MIGRATIONS_DIR);
  return db;
}

function tablesOf(db: BetterSqlite3.Database): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('sqlite_sequence')",
      )
      .all() as { name: string }[]
  )
    .map((r) => r.name)
    .sort();
}

function columnsOf(db: BetterSqlite3.Database, table: string): ColumnInfo[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[];
}

function indexesOf(db: BetterSqlite3.Database, table: string): IndexInfo[] {
  return (
    db
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name",
      )
      .all(table) as IndexInfo[]
  ).map((r) => ({ name: r.name, sql: normalizeCreateTableSql(r.sql) }));
}

function createTableSqlOf(db: BetterSqlite3.Database, table: string): string {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { sql: string };
  return normalizeCreateTableSql(row.sql);
}

describe('spec vs migrated DB — shared-sqlite-store-spec.md column/index/CHECK currency (#1251)', () => {
  const specText = readFileSync(SPEC_PATH, 'utf8');
  const specDb = buildDbFromSpec(specText);
  const migratedDb = buildMigratedDb();

  it('declares exactly the tables the migrated DB has', () => {
    const migratedTables = tablesOf(migratedDb);
    const specTables = tablesOf(specDb);
    const missingInSpec = migratedTables.filter((t) => !specTables.includes(t));
    const extraInSpec = specTables.filter((t) => !migratedTables.includes(t));
    expect(
      missingInSpec,
      `tables in the migrated DB but not declared in the spec: ${missingInSpec}`,
    ).toEqual([]);
    expect(
      extraInSpec,
      `tables declared in the spec but not in the migrated DB: ${extraInSpec}`,
    ).toEqual([]);
  });

  const migratedTables = tablesOf(migratedDb);
  for (const table of migratedTables) {
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one table's full schema-parity assertion — columns, then indexes, then the normalized CREATE TABLE text for CHECKs — is one coherent check against both DBs; splitting it into helpers would scatter a single test's assertions with no gain in readability.
    it(`${table}: spec DDL matches the migrated DB's columns, indexes, and CHECKs`, () => {
      const specTables = tablesOf(specDb);
      expect(specTables, `${table} is missing from the spec entirely`).toContain(table);

      const mCols = columnsOf(migratedDb, table);
      const sCols = columnsOf(specDb, table);
      const mNames = mCols.map((c) => c.name);
      const sNames = sCols.map((c) => c.name);

      expect(
        mNames.filter((n) => !sNames.includes(n)),
        `${table}: columns in DB missing from spec`,
      ).toEqual([]);
      expect(
        sNames.filter((n) => !mNames.includes(n)),
        `${table}: columns in spec not in DB`,
      ).toEqual([]);

      for (const mc of mCols) {
        const sc = sCols.find((c) => c.name === mc.name);
        if (!sc) continue;
        expect(
          { type: sc.type, notnull: sc.notnull, dflt_value: String(sc.dflt_value), pk: sc.pk },
          `${table}.${mc.name}: spec column definition`,
        ).toEqual({
          type: mc.type,
          notnull: mc.notnull,
          dflt_value: String(mc.dflt_value),
          pk: mc.pk,
        });
      }

      const mIdx = indexesOf(migratedDb, table);
      const sIdx = indexesOf(specDb, table);
      const mIdxNames = mIdx.map((i) => i.name);
      const sIdxNames = sIdx.map((i) => i.name);
      expect(
        mIdxNames.filter((n) => !sIdxNames.includes(n)),
        `${table}: indexes in DB missing from spec`,
      ).toEqual([]);
      expect(
        sIdxNames.filter((n) => !mIdxNames.includes(n)),
        `${table}: indexes in spec not in DB`,
      ).toEqual([]);
      for (const mi of mIdx) {
        const si = sIdx.find((i) => i.name === mi.name);
        if (!si) continue;
        expect(si.sql, `${table} index ${mi.name}: spec SQL differs from migrated DB`).toEqual(
          mi.sql,
        );
      }

      expect(
        createTableSqlOf(specDb, table),
        `${table}: normalized CREATE TABLE text differs (likely a CHECK constraint)`,
      ).toEqual(createTableSqlOf(migratedDb, table));
    });
  }
});
