import type BetterSqlite3 from 'better-sqlite3';

type Statement = BetterSqlite3.Statement<unknown[], unknown>;

function cleared(statement: Statement): Statement {
  if (statement.reader) statement.pluck(false).raw(false).expand(false);
  return statement;
}

// better-sqlite3 13 keeps every prepared statement alive until its Database closes, unreferenced
// or not (#2012: ~3.7 KB each, never reclaimed by gc), so a long-lived handle that prepares per
// call grows without bound. A cached statement is shared by every caller of the same SQL text:
// bind() or safeIntegers() on one would leak into the others, so nothing on a store handle calls
// either
export function cacheStatements(db: BetterSqlite3.Database): BetterSqlite3.Database {
  const prepare = db.prepare.bind(db) as (source: string) => Statement;
  const cache = new Map<string, Statement>();
  db.prepare = ((source: string): Statement => {
    const cached = cache.get(source);
    if (cached !== undefined && !cached.busy) return cleared(cached);
    const statement = prepare(source);
    if (cached === undefined) cache.set(source, statement);
    return statement;
  }) as BetterSqlite3.Database['prepare'];
  return db;
}
