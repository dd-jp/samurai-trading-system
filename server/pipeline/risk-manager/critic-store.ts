import { currentTraceId, type Logger } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { fromStoredTimestamp, toStoredTimestamp } from '../../shared/store/index.js';
import { readPersistedConditions, readPersistedDroppedConditions } from './invalidation.js';
import type {
  EvaluatedCondition,
  RiskCriticLog,
  RiskCriticStore,
  RiskCriticVerdict,
} from './types.js';

export class InMemoryRiskCriticStore implements RiskCriticStore {
  readonly #rows = new Map<string, RiskCriticLog>();

  writeVerdict(entry: RiskCriticLog): void {
    if (this.#rows.has(entry.debate_id)) return;
    this.#rows.set(entry.debate_id, entry);
  }

  getByDebateId(debate_id: string): RiskCriticLog | undefined {
    return this.#rows.get(debate_id);
  }
}

interface RiskCriticRow {
  debate_id: string;
  verdict: RiskCriticVerdict['verdict'];
  max_notional: number | null;
  reasoning: string;
  created_at: string;
  conditions_json: string | null;
  dropped_conditions_json: string | null;
}

function readJsonList<T>(
  stored: string | null,
  read: (parsed: unknown) => T[] | undefined,
): T[] | undefined {
  if (stored === null) return undefined;
  try {
    return read(JSON.parse(stored));
  } catch {
    return undefined;
  }
}

function logConditionsUnparseable(logger: Logger | undefined, debate_id: string): void {
  logger?.log({
    trace_id: currentTraceId() ?? debate_id,
    stage: 'risk',
    event: 'risk_critic_conditions_unparseable',
    level: 'warn',
    message:
      'risk_critic_log: conditions_json is not valid JSON; the row replays as no_conditions (#1068)',
    payload: { debate_id, reason: 'unparseable_json' },
  });
}

function logConditionsNotArray(logger: Logger | undefined, debate_id: string): void {
  logger?.log({
    trace_id: currentTraceId() ?? debate_id,
    stage: 'risk',
    event: 'risk_critic_conditions_not_array',
    level: 'warn',
    message:
      'risk_critic_log: conditions_json is not a JSON array; the row replays as no_conditions (#1068)',
    payload: { debate_id, reason: 'not_an_array' },
  });
}

function logConditionsDropped(
  logger: Logger | undefined,
  debate_id: string,
  emitted: number,
  survived: number,
  dropped: number,
): void {
  logger?.log({
    trace_id: currentTraceId() ?? debate_id,
    stage: 'risk',
    event: 'risk_critic_conditions_dropped_on_read',
    level: 'warn',
    message:
      'risk_critic_log: persisted invalidation condition(s) failed the tightened shape ' +
      'check on read and were dropped from replay; surviving conditions (if any) replay ' +
      'unaffected, and the row falls back to no_conditions only if nothing survived (#1068)',
    payload: { debate_id, emitted, survived, dropped },
  });
}

function readConditionsJson(
  stored: string | null,
  debate_id: string,
  logger: Logger | undefined,
): EvaluatedCondition[] | undefined {
  if (stored === null) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    logConditionsUnparseable(logger, debate_id);
    return undefined;
  }

  if (!Array.isArray(parsed)) {
    logConditionsNotArray(logger, debate_id);
    return undefined;
  }

  const conditions = readPersistedConditions(parsed);
  const survived = conditions?.length ?? 0;
  const dropped = parsed.length - survived;
  if (dropped > 0) {
    logConditionsDropped(logger, debate_id, parsed.length, survived, dropped);
  }
  return conditions;
}

function writeJsonList(list: readonly unknown[] | undefined): string | null {
  return list === undefined ? null : JSON.stringify(list);
}

export class SqliteRiskCriticStore implements RiskCriticStore {
  constructor(
    private readonly db: StoreHandle,
    private readonly logger?: Logger,
  ) {}

  writeVerdict(entry: RiskCriticLog): void {
    this.db
      .prepare(
        `INSERT INTO risk_critic_log
           (debate_id, verdict, max_notional, reasoning, created_at,
            conditions_json, dropped_conditions_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(debate_id) DO NOTHING`,
      )
      .run(
        entry.debate_id,
        entry.verdict.verdict,
        entry.verdict.max_notional,
        entry.verdict.reasoning,
        toStoredTimestamp(entry.created_at),
        writeJsonList(entry.verdict.conditions),
        writeJsonList(entry.verdict.dropped_conditions),
      );
  }

  getByDebateId(debate_id: string): RiskCriticLog | undefined {
    const row = this.db
      .prepare(
        `SELECT debate_id, verdict, max_notional, reasoning, created_at,
                conditions_json, dropped_conditions_json
         FROM risk_critic_log WHERE debate_id = ?`,
      )
      .get(debate_id) as RiskCriticRow | undefined;
    if (row === undefined) return undefined;

    const conditions = readConditionsJson(row.conditions_json, row.debate_id, this.logger);
    const dropped = readJsonList(row.dropped_conditions_json, readPersistedDroppedConditions);
    return {
      debate_id: row.debate_id,
      verdict: {
        verdict: row.verdict,
        max_notional: row.max_notional,
        reasoning: row.reasoning,
        ...(conditions === undefined ? {} : { conditions }),
        ...(dropped === undefined ? {} : { dropped_conditions: dropped }),
      },
      created_at: fromStoredTimestamp(row.created_at),
    };
  }
}
