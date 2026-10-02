import type BetterSqlite3 from 'better-sqlite3';

type Statement = BetterSqlite3.Statement<unknown[], unknown>;

function refuseBind(): never {
  throw new Error(
    'bind() is refused on a store statement: it is shared by every caller of the same SQL (#2012); pass the parameters to run(), get() or all() instead',
  );
}

function sealed(statement: Statement): Statement {
  statement.bind = refuseBind;
  return statement;
}

function cleared(statement: Statement): Statement {
  if (statement.reader) statement.pluck(false).raw(false).expand(false);
  return statement.safeIntegers(false);
}

// better-sqlite3 13 keeps every prepared statement alive until its Database closes, unreferenced
// or not (#2012: ~3.7 KB each, never reclaimed by gc), so a long-lived handle that prepares per
// call grows without bound. A busy statement (mid-iteration, or an iterator dropped without
// return()) is replaced rather than reused, which costs one statement per such event
export function cacheStatements(db: BetterSqlite3.Database): BetterSqlite3.Database {
  const prepare = db.prepare.bind(db) as (source: string) => Statement;
  const cache = new Map<string, Statement>();
  db.prepare = ((source: string): Statement => {
    const cached = cache.get(source);
    if (cached !== undefined && !cached.busy) return cleared(cached);
    const statement = sealed(prepare(source));
    cache.set(source, statement);
    return statement;
  }) as BetterSqlite3.Database['prepare'];
  return db;
}
