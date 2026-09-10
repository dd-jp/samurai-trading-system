/**
 * The sole-writer guard (#837 M9).
 *
 * `StoreHandle` is a bare alias to `BetterSqlite3.Database`, so
 * cross-spec-contracts.md §4's guarantee — "Execution is the SOLE writer of
 * `open_positions`/`fills`/`closed_trades`" — was held by convention and code
 * review and by nothing else. Any component holding the injected handle can
 * write any table, and the failure is silent: a second writer to
 * `open_positions` corrupts the crash-restart invariant CONTEXT.md calls
 * load-bearing, and nothing alerts.
 *
 * ## What this is, and what it deliberately is not
 *
 * A DEBUG-MODE ASSERTION (David's ruling, 2026-08-27), at PER-OWNING-STAGE
 * granularity. `guardedStore(db, stage)` returns a handle that asserts every
 * statement's write target against the tables that stage declares below.
 * Reads are never touched.
 *
 * Four properties are the whole design, and each is a deliberate limit:
 *
 * 1. **Default permissive.** An UNDECLARED handle — the raw `StoreHandle` —
 *    stays exactly as it is today. Wiring is therefore incremental and
 *    verifiable site by site, rather than an all-or-nothing change across
 *    every store construction in the tree. A missed site loses detection at
 *    that site; it does not break the site.
 * 2. **Off in production.** `isStoreWriteGuardEnabled` is a pure predicate
 *    (see its own doc) and it answers `false` for a live-money run, so the
 *    live path pays nothing and — more to the point — cannot be taken down by
 *    a parser this module got wrong.
 * 3. **Fails OPEN on anything it cannot parse.** The check runs at `prepare()`
 *    time and several stores prepare in their constructor, so a
 *    false-positive would be an orchestrator BOOT failure in dev, not a test
 *    failure. A statement whose write target cannot be read is allowed. The
 *    guard's job is catching a real cross-stage write in dev and CI, not
 *    proving the absence of one.
 * 4. **DML only — `INSERT`/`REPLACE`/`UPDATE`/`DELETE`.** `CREATE`, `DROP`
 *    and `ALTER` are NOT scanned, so a guarded handle — a declared-empty
 *    reader one included — can still change the schema through `exec()`
 *    without tripping anything. Deliberate (PR #1048 review): widening the
 *    scan widens the false-positive surface that limit 3 exists to contain,
 *    and DDL is out of scope by construction anyway, since migrations run on
 *    the RAW handle before any guarding. A stage issuing DDL at runtime would
 *    be a wild bug, and this is not the net for it. Stated here rather than
 *    left implicit because a guard that overstates its coverage is worse than
 *    one whose narrow scope is written down.
 *
 * No new abstraction over `StoreHandle` and no change to the `transaction()`
 * seam: the guarded handle is a `Proxy` whose methods delegate to the same
 * underlying connection, so a transaction still spans tables, still nests, and
 * a violation raised inside one propagates out of `better-sqlite3`'s own
 * wrapper and rolls the transaction back like any other throw.
 */
import type { StoreHandle } from './open-shared-store.js';

/**
 * The stages that own tables in the shared store. Named after the OWNING
 * DIRECTORY of the store class, not after whichever caller happens to invoke
 * it — one store instance can legitimately be handed to two stages
 * (`SqliteSetupStore` is constructed once and passed to both the Trader, which
 * writes setups, and Execution's trade-close hookup, which labels them), and
 * the guard keys on the handle, so the handle carries the owner's identity.
 */
export const STORE_OWNER_STAGES = [
  'backtest',
  'control-arm',
  'debate-engine',
  'execution',
  'feedback-loop',
  'market-data',
  'orchestrator',
  'risk',
  'service-api',
  'trader',
  'verdict',
] as const;

export type StoreOwnerStage = (typeof STORE_OWNER_STAGES)[number];

/**
 * Who may write what. The authority is cross-spec-contracts.md §4 for
 * Execution's three tables and shared-sqlite-store-spec.md's "Integration with
 * Pipeline" map for the rest; that map listed a subset, and #837 M9 extended
 * it to the full set below so the doc and this table cannot drift apart.
 *
 * `Record<StoreOwnerStage, …>` is the exhaustiveness check, and it is the
 * whole of it — both directions fail on THIS binding, measured rather than
 * assumed (#837 M9): deleting `verdict:` below gives
 * `TS2741: Property 'verdict' is missing … but required in type
 * Record<…>`, and adding a stage to `STORE_OWNER_STAGES` with no declaration
 * here gives the same error naming the new stage. An `AlertChannelSlots`-style
 * `Exclude<…>` mapped type was written first and then removed: `keyof typeof`
 * on an ANNOTATED const returns the annotation's keys, not the literal's, so
 * that check reduced to `Exclude<S, S>` = `never` and could never fail. The
 * runtime half lives in `write-guard.test.ts`, which asserts the declared keys
 * are exactly `STORE_OWNER_STAGES` and that every declared table exists in the
 * migrated schema.
 *
 * Tables NOT listed anywhere are unowned and therefore unguarded, which is the
 * permissive default working as intended: `schema_migrations` (written by the
 * migration runner before any handle is guarded) and `cii_snapshots` (a table
 * the schema carries and no code writes yet).
 */
export const STAGE_OWNED_TABLES: Record<StoreOwnerStage, readonly string[]> = {
  backtest: ['config_trials', 'stage2_selected_config'],
  // Reader only: the control arm's comparison source reads both arms' rows and
  // writes none — the samples it feeds are written by the Feedback Loop.
  'control-arm': [],
  'debate-engine': ['debate_log', 'llm_call_log', 'llm_spend'],
  // Cross-spec §4's three, plus the flatten write-ahead and the broker
  // reconciliation tables the same stage owns.
  execution: [
    'broker_brackets',
    'broker_unpriced_fills',
    'closed_trades',
    'fills',
    'flatten_submissions',
    'open_positions',
  ],
  'feedback-loop': [
    'analyst_weights',
    'arm_comparison_samples',
    'dial_adjustments',
    'feedback_cycle_schedule',
    'outside_benchmark_samples',
    'risk_thresholds',
    'strategy_params',
  ],
  'market-data': ['bars', 'latest_mark'],
  // `account_state`/`session_equity` are the Transport Layer's tables in the
  // spec's own map, but their stores live under `apps/orchestrator/` and are
  // constructed in the orchestrator's composition root, so the handle's
  // identity is the orchestrator's. Recorded that way in the spec too.
  orchestrator: [
    'account_state',
    'alert_delivery_failures',
    'audit_log',
    'current_tick',
    'daily_equity',
    // #1140: `SqliteLlmSpendCapStore` lives in `shared/store` because the
    // dashboard reads it, but the WRITE is a boot-time statement of the
    // config the composition root armed — the orchestrator's, by the same
    // handle-identity rule `account_state` above follows.
    'llm_spend_cap',
    'session_equity',
  ],
  risk: ['breaker_state', 'risk_critic_log', 'risk_log'],
  // Reader only — the dashboard's process must never write. Declaring it with
  // an empty set is the strongest statement available here, and doubles as
  // the standing proof that reads are not blocked.
  'service-api': [],
  trader: ['cosine_setups', 'trader_log'],
  verdict: ['verdict_log'],
};

/** What `isStoreWriteGuardEnabled` reads. Passed in, never sampled inside. */
export interface StoreWriteGuardEnvironment {
  readonly nodeEnv?: string | undefined;
  readonly samuraiMode?: string | undefined;
  readonly override?: string | undefined;
}

/**
 * Whether the guard runs — a PURE predicate, so the gating condition itself is
 * testable rather than an inline `process.env` read scattered through the
 * construction sites.
 *
 * On everywhere except a real production or live-money run. `yarn smoke` runs
 * with no `NODE_ENV` at all, which is why the unset case is ON rather than
 * off: the smoke gate driving the real composition root is where this earns
 * its keep. A PAPER run is also guarded on purpose — paper is the rehearsal,
 * and a cross-stage write found there is found before it can matter.
 *
 * `SAMURAI_STORE_GUARD=off` is the escape hatch if the guard ever misfires on
 * a paper soak, and `=on` forces it back on; anything else is ignored rather
 * than guessed at.
 *
 * **The two overrides are deliberately NOT symmetric, because their failure
 * modes are not** (PR #1048 review). `off` beats everything: disabling a dev
 * assertion can only ever cost detection. `on` beats a `NODE_ENV=production`
 * BUILD — the case the escape hatch exists for, a production build being
 * exercised somewhere that is not trading real money — but it does **not**
 * beat `SAMURAI_MODE=live`. A live-money run never enables the guard, full
 * stop: were `on` able to reach it, a stray variable in a live deployment
 * would put a parser this module might have got wrong on the order path, and
 * limit 2 above ("cannot be taken down by a parser this module got wrong")
 * would be a claim this predicate does not keep.
 */
export function isStoreWriteGuardEnabled(
  environment: StoreWriteGuardEnvironment = {
    nodeEnv: process.env.NODE_ENV,
    samuraiMode: process.env.SAMURAI_MODE,
    override: process.env.SAMURAI_STORE_GUARD,
  },
): boolean {
  if (environment.override === 'off') return false;
  // Ordered ABOVE `on` on purpose — see the doc comment's asymmetry note.
  if (environment.samuraiMode === 'live') return false;
  if (environment.override === 'on') return true;
  if (environment.nodeEnv === 'production') return false;
  return true;
}

/** `'…'` string literals and both comment forms, blanked before the scan. */
const SQL_NOISE = /'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\//g;

/** One identifier: bare, `"quoted"`, `` `backticked` `` or `[bracketed]`. */
const IDENTIFIER_PART = String.raw`(?:"[^"]+"|\x60[^\x60]+\x60|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_$]*)`;

/** A table reference, optionally schema-qualified (`main.audit_log`, `temp.t`). */
const IDENTIFIER = String.raw`(?:${IDENTIFIER_PART}\s*\.\s*)?${IDENTIFIER_PART}`;

/**
 * Every write target in a statement (or in a whole multi-statement `exec`).
 *
 * Scans globally rather than parsing one statement, which is what makes
 * multi-statement `exec` and a CTE prologue (`WITH … UPDATE t …`) fall out for
 * free instead of needing a splitter that would have to understand string
 * literals to be correct.
 *
 * The `DO\s+UPDATE` exclusion is load-bearing, not an edge case: nearly every
 * store in this repo upserts with `ON CONFLICT(...) DO UPDATE SET …`, and a
 * naive scan reads that tail's target as the literal `SET`.
 */
const WRITE_TARGET = new RegExp(
  String.raw`\b(?:insert|replace)\s+(?:or\s+\w+\s+)?into\s+(${IDENTIFIER})` +
    String.raw`|(\bdo\s+)?\bupdate\s+(?:or\s+\w+\s+)?(${IDENTIFIER})` +
    String.raw`|\bdelete\s+from\s+(${IDENTIFIER})`,
  'gi',
);

/**
 * Keywords that can only ever be a mis-read: if the "table name" is one of
 * these the statement was not understood, and an unparsed statement is allowed
 * (see this module's doc — the guard fails open).
 */
const NOT_A_TABLE = new Set(['set', 'from', 'where', 'values', 'select', 'into']);

function normalizeIdentifier(raw: string): string {
  const lastSegment = raw.slice(raw.lastIndexOf('.') + 1).trim();
  return lastSegment
    .replace(/^["`[]/, '')
    .replace(/["`\]]$/, '')
    .toLowerCase();
}

/**
 * The tables `sql` writes to, in order, lower-cased and unqualified. Empty for
 * a read, for a `PRAGMA`, and for anything this module cannot parse.
 *
 * Exported for its own tests: the parser is the risky half of the guard, and
 * it is worth testing directly rather than only through a database.
 */
export function writeTargetTables(sql: string): string[] {
  const scannable = sql.replace(SQL_NOISE, ' ');
  const tables: string[] = [];
  for (const match of scannable.matchAll(WRITE_TARGET)) {
    const [, insertTarget, upsertTail, updateTarget, deleteTarget] = match;
    if (upsertTail !== undefined) continue;
    const raw = insertTarget ?? updateTarget ?? deleteTarget;
    if (raw === undefined) continue;
    const table = normalizeIdentifier(raw);
    if (NOT_A_TABLE.has(table)) continue;
    tables.push(table);
  }
  return tables;
}

function assertOwnedTables(
  sql: string,
  stage: StoreOwnerStage,
  allowed: ReadonlySet<string>,
): void {
  for (const table of writeTargetTables(sql)) {
    if (allowed.has(table)) continue;
    throw new Error(
      `Sole-writer violation: the '${stage}' handle wrote to '${table}', which it does not own. ` +
        `'${stage}' may write ${allowed.size === 0 ? '(nothing — it is a reader)' : [...allowed].join(', ')}. ` +
        'Table ownership is cross-spec-contracts.md §4 and shared-sqlite-store-spec.md ' +
        '"Integration with Pipeline"; the guard is #837 M9 (server/shared/store/write-guard.ts). ' +
        'Route the write through the owning stage rather than widening the declaration.\n' +
        `Statement: ${sql.trim().slice(0, 300)}`,
    );
  }
}

/**
 * The declared handle. Returns `store` itself when the guard is off, so
 * production keeps the bare `better-sqlite3` connection with no proxy in the
 * call path at all.
 *
 * `enabled` is injectable so a test can pin the predicate rather than mutate
 * `process.env`.
 */
export function guardedStore(
  store: StoreHandle,
  stage: StoreOwnerStage,
  options: { readonly enabled?: boolean } = {},
): StoreHandle {
  if (!(options.enabled ?? isStoreWriteGuardEnabled())) return store;
  const allowed = new Set(STAGE_OWNED_TABLES[stage]);

  return new Proxy(store, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql: string, ...rest: unknown[]) => {
          assertOwnedTables(sql, stage, allowed);
          return (target.prepare as (...args: unknown[]) => unknown)(sql, ...rest);
        };
      }
      if (property === 'exec') {
        return (sql: string) => {
          assertOwnedTables(sql, stage, allowed);
          return target.exec(sql);
        };
      }
      // Everything else delegates to the real connection, bound to it:
      // better-sqlite3 is a native binding and its methods and getters
      // (`transaction`, `pragma`, `inTransaction`, `close`) must see the real
      // object as `this`, not the proxy.
      const value = Reflect.get(target, property) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
