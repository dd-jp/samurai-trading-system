import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import BetterSqlite3 from 'better-sqlite3';
import { MIGRATIONS_DIR, runMigrations } from './migrate.js';

/**
 * Closes #1251: `docs/specs/shared-sqlite-store-spec.md`'s consolidated DDL
 * claims to be every table folded to its CURRENT effective shape (every
 * later `ALTER TABLE` migration applied), not just its creating migration.
 * That claim was never mechanically checked — six already-declared tables
 * drifted silently behind later migrations before this test existed. This
 * builds BOTH sides for real (the spec's own fenced `CREATE TABLE`/`CREATE
 * INDEX` statements executed against a fresh `:memory:` DB; the actual
 * migration chain run against a second `:memory:` DB) and diffs them
 * column-by-column, index-by-index, and CHECK-by-CHECK — so a future
 * migration that adds a column/index/CHECK without updating the spec fails
 * HERE instead of silently reproducing #1251.
 *
 * `ALTER TABLE` statements in the spec are illustrative prose (e.g. the
 * `invalidation_log` section's walk-through of migration 0040) and are
 * deliberately excluded from the spec-side DB build — they document a step,
 * not the table's current shape, which the `CREATE TABLE` block alone must
 * carry.
 *
 * Every ```sql fence in the spec must be classifiable as CREATE TABLE, CREATE
 * INDEX, or ALTER TABLE — `buildDbFromSpec` throws on anything else (a
 * worked-example SELECT/INSERT/PRAGMA, say) rather than silently ignoring it,
 * because a silently-skipped fence is exactly the kind of drift this test
 * exists to catch. If the spec ever needs a non-DDL `sql` fence (e.g. to show
 * `recordTrial`'s upsert or `SqliteVerdictLogStore`'s `ON CONFLICT ... DO
 * NOTHING`), give it a different fence language (e.g. ```sql-example) so this
 * test's classifier never sees it — do not widen the classifier to swallow it.
 */

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

function stripLineComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('--');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

/**
 * Splits on top-level `;` only — a naive `split(';')` breaks on the `;`-free
 * but paren-nested CHECK/column lists every CREATE TABLE here has, and would
 * silently truncate or merge statements instead of erroring.
 */
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

/**
 * Normalizes a `CREATE TABLE ...` statement's raw SQL text for comparison,
 * collapsing differences that are real in `sqlite_master.sql` but not in the
 * schema the table actually enforces:
 *  - comments (already stripped upstream, stripped again here for safety)
 *  - whitespace
 *  - double-quoted identifiers (`_new`+RENAME rebuilds — 0017/0022/0028/
 *    0029/0031/0048 — leave the migrated table's name quoted; the spec's
 *    hand-written DDL never quotes it)
 *  - the redundant `NULL` nullability keyword (SQLite's default; some
 *    migrations spell it out, some don't — semantically identical)
 */
function normalizeCreateTableSql(sql: string): string {
  return stripLineComments(sql)
    .replace(/"([A-Za-z_][A-Za-z0-9_]*)"/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/\bNULL\b/gi, (match: string, offset: number, full: string) => {
      // Drop a standalone nullability `NULL` (not part of `NOT NULL`, `IS NULL`,
      // `CHECK(... IS NULL ...)`, or a `DEFAULT NULL`).
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
  const alterStmts = allStatements.filter((s) => /^ALTER TABLE/i.test(s));
  const other = allStatements.filter(
    (s) =>
      !/^CREATE TABLE/i.test(s) && !/^CREATE (UNIQUE )?INDEX/i.test(s) && !/^ALTER TABLE/i.test(s),
  );
  if (other.length > 0) {
    throw new Error(
      `spec-schema-drift: unrecognized SQL fence content (not CREATE TABLE/INDEX/ALTER TABLE): ${JSON.stringify(
        other.map((s) => s.slice(0, 80)),
      )}. Every \`\`\`sql block in the spec must be schema DDL this test can classify.`,
    );
  }
  // ALTER TABLE blocks are illustrative prose (see module doc) — deliberately unused.
  void alterStmts;

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
        // Same exclusions as `open-shared-store.test.ts`'s TABLES-completeness
        // check: `sqlite_sequence` is SQLite's own AUTOINCREMENT bookkeeping,
        // created implicitly and identically by both DB builds whenever either
        // side has an AUTOINCREMENT table, so it is excluded rather than
        // required to be declared.
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('schema_migrations', 'sqlite_sequence')",
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

      // Column tuples and index sets can't see a table-level CHECK or a
      // widened CHECK value list on an existing column (e.g. #1251's
      // closed_trades.close_reason, arm_comparison_samples' table CHECK) —
      // only the full normalized CREATE TABLE text catches those.
      expect(
        createTableSqlOf(specDb, table),
        `${table}: normalized CREATE TABLE text differs (likely a CHECK constraint)`,
      ).toEqual(createTableSqlOf(migratedDb, table));
    });
  }
});
