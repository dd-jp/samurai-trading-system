import type { StoreHandle } from './open-shared-store.js';

export const STORE_OWNER_STAGES = [
  'backtest',
  'control-arm',
  'dashboard',
  'debate-engine',
  'execution',
  'feedback-loop',
  'market-data',
  'orchestrator',
  'risk',
  'service-api',
  'telegram',
  'trader',
  'v2',
  'verdict',
] as const;

export type StoreOwnerStage = (typeof STORE_OWNER_STAGES)[number];

export const STAGE_OWNED_TABLES: Record<StoreOwnerStage, readonly string[]> = {
  backtest: ['config_trials', 'stage2_selected_config'],
  'control-arm': [],
  dashboard: ['v2_controls'],
  'debate-engine': [
    'debate_log',
    'debate_round_log',
    'llm_call_log',
    'llm_gate_refusals',
    'llm_spend',
  ],
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
  orchestrator: [
    'account_state',
    'alert_delivery_failures',
    'audit_log',
    'current_tick',
    'daily_equity',
    'llm_spend_cap',
    'session_equity',
  ],
  risk: ['breaker_state', 'risk_critic_log', 'risk_log'],
  'service-api': [],
  telegram: ['v2_commands'],
  trader: ['cosine_setups', 'trader_log'],
  v2: [
    'v2_books',
    'v2_book_days',
    'v2_positions',
    'v2_decisions',
    'v2_orders',
    'v2_fills',
    'v2_refusals',
    'v2_reconciles',
    'v2_capital_config',
    'v2_trials',
    'v2_news',
    'v2_signals',
    'v2_signal_events',
    'v2_run_lease',
    'v2_faults',
    'v2_heartbeat_pings',
    'v2_splits',
    'v2_input_digests',
  ],
  verdict: ['verdict_log'],
};

export interface StoreWriteGuardEnvironment {
  readonly nodeEnv?: string | undefined;
  readonly samuraiMode?: string | undefined;
  readonly override?: string | undefined;
}

export function isStoreWriteGuardEnabled(
  environment: StoreWriteGuardEnvironment = {
    nodeEnv: process.env.NODE_ENV,
    samuraiMode: process.env.SAMURAI_MODE,
    override: process.env.SAMURAI_STORE_GUARD,
  },
): boolean {
  if (environment.override === 'off') return false;
  if (environment.samuraiMode === 'live') return false;
  if (environment.override === 'on') return true;
  if (environment.nodeEnv === 'production') return false;
  return true;
}

const SQL_NOISE = /'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\//g;

const IDENTIFIER_PART = String.raw`(?:"[^"]+"|\x60[^\x60]+\x60|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_$]*)`;

const IDENTIFIER = String.raw`(?:${IDENTIFIER_PART}\s*\.\s*)?${IDENTIFIER_PART}`;

const WRITE_TARGET = new RegExp(
  String.raw`\b(?:insert|replace)\s+(?:or\s+\w+\s+)?into\s+(${IDENTIFIER})` +
    String.raw`|(\bdo\s+)?\bupdate\s+(?:or\s+\w+\s+)?(${IDENTIFIER})` +
    String.raw`|\bdelete\s+from\s+(${IDENTIFIER})`,
  'gi',
);

const NOT_A_TABLE = new Set(['set', 'from', 'where', 'values', 'select', 'into']);

function normalizeIdentifier(raw: string): string {
  const lastSegment = raw.slice(raw.lastIndexOf('.') + 1).trim();
  return lastSegment
    .replace(/^["`[]/, '')
    .replace(/["`\]]$/, '')
    .toLowerCase();
}

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
      const value = Reflect.get(target, property) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
