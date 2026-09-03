/**
 * #837 M9 — the sole-writer guard. Tests written before the implementation
 * (the parser is the risky half: a false positive here is an orchestrator boot
 * failure in dev, not a test failure, so the hostile cases are the point).
 */
import { openSharedStore, type SharedStore } from './open-shared-store.js';
import {
  guardedStore,
  isStoreWriteGuardEnabled,
  STAGE_OWNED_TABLES,
  STORE_OWNER_STAGES,
  writeTargetTables,
} from './write-guard.js';

describe('isStoreWriteGuardEnabled', () => {
  it('is on for an unset NODE_ENV — `yarn smoke` runs with none', () => {
    expect(isStoreWriteGuardEnabled({})).toBe(true);
  });

  it('is on under test and development', () => {
    expect(isStoreWriteGuardEnabled({ nodeEnv: 'test' })).toBe(true);
    expect(isStoreWriteGuardEnabled({ nodeEnv: 'development' })).toBe(true);
  });

  it('is off in production and off for a live-money run', () => {
    expect(isStoreWriteGuardEnabled({ nodeEnv: 'production' })).toBe(false);
    expect(isStoreWriteGuardEnabled({ samuraiMode: 'live' })).toBe(false);
    expect(isStoreWriteGuardEnabled({ nodeEnv: 'development', samuraiMode: 'live' })).toBe(false);
  });

  it('is on for a paper run — paper is where a violation should surface', () => {
    expect(isStoreWriteGuardEnabled({ samuraiMode: 'paper' })).toBe(true);
  });

  it('lets an explicit override win in both directions', () => {
    expect(isStoreWriteGuardEnabled({ nodeEnv: 'test', override: 'off' })).toBe(false);
    expect(isStoreWriteGuardEnabled({ nodeEnv: 'production', override: 'on' })).toBe(true);
    expect(isStoreWriteGuardEnabled({ samuraiMode: 'live', override: 'on' })).toBe(true);
  });

  it('ignores an unrecognised override rather than guessing', () => {
    expect(isStoreWriteGuardEnabled({ nodeEnv: 'production', override: 'yes' })).toBe(false);
    expect(isStoreWriteGuardEnabled({ nodeEnv: 'test', override: '' })).toBe(true);
  });
});

describe('writeTargetTables', () => {
  it('reads every INSERT form', () => {
    expect(writeTargetTables('INSERT INTO fills (a) VALUES (?)')).toEqual(['fills']);
    expect(
      writeTargetTables('INSERT OR REPLACE INTO arm_comparison_samples (a) VALUES (?)'),
    ).toEqual(['arm_comparison_samples']);
    expect(writeTargetTables('INSERT OR IGNORE INTO bars (a) VALUES (?)')).toEqual(['bars']);
    expect(writeTargetTables('REPLACE INTO latest_mark (a) VALUES (?)')).toEqual(['latest_mark']);
  });

  it('reads UPDATE and DELETE', () => {
    expect(writeTargetTables('UPDATE open_positions SET qty = ? WHERE id = ?')).toEqual([
      'open_positions',
    ]);
    expect(writeTargetTables('UPDATE OR ROLLBACK cosine_setups SET r_multiple = ?')).toEqual([
      'cosine_setups',
    ]);
    expect(writeTargetTables('DELETE FROM current_tick')).toEqual(['current_tick']);
  });

  it('reads UPDATE ... FROM, whose target is the table after UPDATE', () => {
    expect(
      writeTargetTables('UPDATE fills SET price = other.price FROM staging AS other WHERE 1'),
    ).toEqual(['fills']);
  });

  it('normalizes quoted, bracketed and schema-qualified names', () => {
    expect(writeTargetTables('INSERT INTO "closed_trades" (a) VALUES (?)')).toEqual([
      'closed_trades',
    ]);
    expect(writeTargetTables('INSERT INTO `closed_trades` (a) VALUES (?)')).toEqual([
      'closed_trades',
    ]);
    expect(writeTargetTables('INSERT INTO [closed_trades] (a) VALUES (?)')).toEqual([
      'closed_trades',
    ]);
    expect(writeTargetTables('DELETE FROM main.audit_log')).toEqual(['audit_log']);
    expect(writeTargetTables('UPDATE Open_Positions SET a = 1')).toEqual(['open_positions']);
  });

  // The upsert tail is the single most common shape in this repo's stores, and
  // a naive `\bUPDATE\s+(\w+)` reads its target as the literal `SET`.
  it('does not read the upsert tail as a second target', () => {
    expect(
      writeTargetTables(
        `INSERT INTO analyst_weights (analyst_id, weight, updated_at)
           VALUES (?, ?, ?)
         ON CONFLICT(analyst_id) DO UPDATE
           SET weight = excluded.weight, updated_at = excluded.updated_at`,
      ),
    ).toEqual(['analyst_weights']);
    expect(
      writeTargetTables(
        `INSERT INTO risk_thresholds (name, value, updated_at)
           VALUES (?, ?, ?)
         ON CONFLICT(name) DO NOTHING`,
      ),
    ).toEqual(['risk_thresholds']);
  });

  it('reads every statement of a multi-statement exec', () => {
    expect(
      writeTargetTables(
        'DELETE FROM broker_observed_fills; INSERT INTO broker_brackets VALUES (?)',
      ),
    ).toEqual(['broker_observed_fills', 'broker_brackets']);
  });

  it('reads through a CTE prologue', () => {
    expect(
      writeTargetTables('WITH recent AS (SELECT id FROM fills) UPDATE open_positions SET a = 1'),
    ).toEqual(['open_positions']);
    expect(
      writeTargetTables(
        'WITH recent AS (SELECT id FROM fills) INSERT INTO closed_trades VALUES (?)',
      ),
    ).toEqual(['closed_trades']);
  });

  it('never reads a target out of a pure read', () => {
    expect(writeTargetTables('SELECT * FROM open_positions')).toEqual([]);
    expect(writeTargetTables('SELECT updated_at FROM analyst_weights ORDER BY updated_at')).toEqual(
      [],
    );
    expect(writeTargetTables('SELECT MAX(updated_at) FROM bars WHERE instrument = ?')).toEqual([]);
    expect(writeTargetTables('PRAGMA journal_mode = WAL')).toEqual([]);
  });

  it('ignores write verbs inside string literals and comments', () => {
    expect(writeTargetTables("SELECT 'DELETE FROM ghost' AS note FROM bars")).toEqual([]);
    expect(writeTargetTables('SELECT 1 -- DELETE FROM ghost')).toEqual([]);
    expect(writeTargetTables('SELECT 1 /* INSERT INTO ghost VALUES (1) */ FROM bars')).toEqual([]);
    expect(writeTargetTables("INSERT INTO fills (note) VALUES ('UPDATE ghost SET a = 1')")).toEqual(
      ['fills'],
    );
  });

  // Fail OPEN, not closed: the guard runs at prepare() time and some stores
  // prepare in their constructor, so an unparseable statement must not turn
  // into a boot failure over a shape the parser did not anticipate.
  it('yields nothing when a write verb has no parseable target', () => {
    expect(writeTargetTables('UPDATE')).toEqual([]);
    expect(writeTargetTables('INSERT INTO (a) VALUES (1)')).toEqual([]);
    expect(writeTargetTables('UPDATE SET a = 1')).toEqual([]);
    expect(writeTargetTables('DELETE FROM WHERE a = 1')).toEqual([]);
  });
});

describe('STAGE_OWNED_TABLES', () => {
  it('declares exactly the stages on STORE_OWNER_STAGES', () => {
    // The runtime half. The compile-time half is the
    // `Record<StoreOwnerStage, …>` annotation on the declaration itself, which
    // fails `yarn typecheck` in BOTH directions (verified by experiment — see
    // that binding's doc comment).
    expect(Object.keys(STAGE_OWNED_TABLES).sort()).toEqual([...STORE_OWNER_STAGES].sort());
  });

  it('gives every table exactly one owning stage', () => {
    const owners = new Map<string, string>();
    for (const [stage, tables] of Object.entries(STAGE_OWNED_TABLES)) {
      for (const table of tables) {
        expect(owners.get(table)).toBeUndefined();
        owners.set(table, stage);
      }
    }
  });

  it('names only lower-case tables that actually exist in the migrated schema', () => {
    const db = openSharedStore(':memory:');
    try {
      const existing = new Set(
        (
          db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as {
            name: string;
          }[]
        ).map((row) => row.name),
      );
      for (const tables of Object.values(STAGE_OWNED_TABLES)) {
        for (const table of tables) {
          expect(table).toBe(table.toLowerCase());
          expect([table, existing.has(table)]).toEqual([table, true]);
        }
      }
    } finally {
      db.close();
    }
  });
});

describe('guardedStore', () => {
  /** A minimal write to a table Execution owns, used by the transaction tests. */
  function insertObservedFill(store: SharedStore, fillId: string): void {
    store
      .prepare(
        `INSERT INTO broker_observed_fills
           (venue, client_order_id, broker_fill_id, leg, price, qty, fee, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('alpaca', 'c1', fillId, 'entry', 10, 1, 0, '2026-09-03T00:00:00.000Z');
  }

  function openGuarded(stage: Parameters<typeof guardedStore>[1]) {
    const db = openSharedStore(':memory:');
    return { db, guarded: guardedStore(db, stage, { enabled: true }) };
  }

  it('allows a write to a table the stage owns', () => {
    const { db, guarded } = openGuarded('orchestrator');
    try {
      expect(() =>
        guarded
          .prepare(
            `INSERT INTO audit_log (trace_id, stage, decision, input_digest, output_digest, timestamp)
               VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run('t1', 'tick', 'started', 'in', 'out', '2026-09-03T00:00:00.000Z'),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('refuses a write to a table another stage owns, naming both', () => {
    const { db, guarded } = openGuarded('feedback-loop');
    try {
      expect(() => guarded.prepare('UPDATE open_positions SET filled_size = 1')).toThrow(
        /open_positions/,
      );
      expect(() => guarded.prepare('UPDATE open_positions SET filled_size = 1')).toThrow(
        /feedback-loop/,
      );
    } finally {
      db.close();
    }
  });

  it('never blocks a read, whoever owns the table', () => {
    const { db, guarded } = openGuarded('service-api');
    try {
      expect(() => guarded.prepare('SELECT * FROM open_positions').all()).not.toThrow();
      expect(() => guarded.prepare('SELECT * FROM closed_trades').all()).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('guards exec(), including every statement of a multi-statement one', () => {
    const { db, guarded } = openGuarded('orchestrator');
    try {
      expect(() => guarded.exec('DELETE FROM current_tick')).not.toThrow();
      expect(() => guarded.exec('DELETE FROM current_tick; DELETE FROM fills')).toThrow(/fills/);
    } finally {
      db.close();
    }
  });

  it('leaves the transaction() seam working — a transaction spans tables it owns', () => {
    const { db, guarded } = openGuarded('execution');
    try {
      guarded.transaction(() => {
        insertObservedFill(guarded, 'f1');
        guarded.prepare('DELETE FROM broker_unpriced_fills WHERE venue = ?').run('alpaca');
      })();
      expect(
        (db.prepare('SELECT COUNT(*) AS n FROM broker_observed_fills').get() as { n: number }).n,
      ).toBe(1);
    } finally {
      db.close();
    }
  });

  it('rolls the transaction back when a violation throws inside it', () => {
    const { db, guarded } = openGuarded('execution');
    try {
      const run = guarded.transaction(() => {
        insertObservedFill(guarded, 'f1');
        guarded.prepare('DELETE FROM audit_log').run();
      });
      expect(() => run()).toThrow(/audit_log/);
      expect(
        (db.prepare('SELECT COUNT(*) AS n FROM broker_observed_fills').get() as { n: number }).n,
      ).toBe(0);
      expect(db.inTransaction).toBe(false);
    } finally {
      db.close();
    }
  });

  it('returns the handle untouched when the guard is disabled', () => {
    const db = openSharedStore(':memory:');
    try {
      const passthrough = guardedStore(db, 'feedback-loop', { enabled: false });
      expect(passthrough).toBe(db);
      expect(() => passthrough.prepare('UPDATE open_positions SET filled_size = 1')).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('leaves non-statement surface (pragma, properties) reachable', () => {
    const { db, guarded } = openGuarded('market-data');
    try {
      expect(() => guarded.pragma('journal_mode')).not.toThrow();
      expect(guarded.open).toBe(true);
      expect(guarded.inTransaction).toBe(false);
    } finally {
      db.close();
    }
  });
});
