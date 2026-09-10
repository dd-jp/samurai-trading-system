/**
 * The `debate_id`-keyed critic log (#957) — the persistence half of ADR-0003
 * §2's replay-from-log determinism shape.
 *
 * Two implementations, and the split is not a convenience:
 *
 * - `SqliteRiskCriticStore` over `risk_critic_log` (migration 0032) is the one
 *   the composition root wires in every mode. It has to be durable and
 *   cross-process, because the whole point is that a `backtest` run months
 *   later reads what a `live`/`paper` run wrote — an in-memory map cannot
 *   satisfy that, and `risk-manager-spec.md`'s "in-memory implementation,
 *   SQLite deferred" line predates the store existing at all.
 * - `InMemoryRiskCriticStore` is for tests and for a programmatic root with no
 *   shared store, matching the optional-store posture the rest of this stage
 *   takes.
 *
 * Writes are idempotent on `debate_id` (`DO NOTHING`), like every other
 * decision-record store here: a re-run of the same decision must not
 * accumulate a second, possibly different verdict for one debate. The FIRST
 * verdict is the one the replay will see, so it is the one that must stand.
 */

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
  /** NULL on every row written before the invalidation fold (migration 0040, #994). */
  conditions_json: string | null;
  dropped_conditions_json: string | null;
}

/**
 * Generic JSON-list reader, used below only for `dropped_conditions_json`
 * (audit-only, zero enforcement effect). NULL, unreadable JSON, a non-array
 * payload, AND a payload whose elements do not have the persisted shape all
 * collapse to `undefined` — this column's rule is still all-or-nothing
 * (#997 Q3 / Q2a), unlike `conditions_json`'s element-wise rule below (#1068).
 *
 * The element check is what makes this safe, not decoration. A cast would let
 * a malformed reason code reach a reason line unvalidated. `invalidation.ts`
 * owns that check, because it owns the shape.
 *
 * A pre-fold row and a corrupted column are the same fact — "nothing checkable
 * came out" — and neither may throw on the replay path, because a backtest
 * spanning the fold date must keep running and reach the decision the live run
 * reached.
 */
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

/**
 * `conditions_json` specifically, so a malformed row can be LOGGED (#1068).
 *
 * `readPersistedConditions` is a pure function on purpose — it stays a plain
 * shape-check callable from a unit test with no `Logger` in scope — so it
 * reports nothing about drops itself. This wrapper detects "the row was
 * malformed" independently at each stage (unparseable JSON, a non-array
 * payload, or — by diffing the raw parsed array length against the survivor
 * count `readPersistedConditions` returns — a partially-corrupt array) and
 * logs one WARN per malformed row through the store's own logger seam,
 * naming a reason and the debate id but never the row's raw content.
 * `stored === null` is not malformed — it is the ordinary "nothing was ever
 * emitted" case a pre-fold row also produces — so it never logs.
 */
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
    logger?.log({
      trace_id: currentTraceId() ?? debate_id,
      stage: 'risk',
      event: 'risk_critic_conditions_unparseable',
      level: 'warn',
      message:
        'risk_critic_log: conditions_json is not valid JSON; the row replays as no_conditions (#1068)',
      payload: { debate_id, reason: 'unparseable_json' },
    });
    return undefined;
  }

  if (!Array.isArray(parsed)) {
    logger?.log({
      trace_id: currentTraceId() ?? debate_id,
      stage: 'risk',
      event: 'risk_critic_conditions_not_array',
      level: 'warn',
      message:
        'risk_critic_log: conditions_json is not a JSON array; the row replays as no_conditions (#1068)',
      payload: { debate_id, reason: 'not_an_array' },
    });
    return undefined;
  }

  const conditions = readPersistedConditions(parsed);
  const survived = conditions?.length ?? 0;
  const dropped = parsed.length - survived;
  if (dropped > 0) {
    logger?.log({
      trace_id: currentTraceId() ?? debate_id,
      stage: 'risk',
      event: 'risk_critic_conditions_dropped_on_read',
      level: 'warn',
      message:
        'risk_critic_log: persisted invalidation condition(s) failed the tightened shape ' +
        'check on read and were dropped from replay; surviving conditions (if any) replay ' +
        'unaffected, and the row falls back to no_conditions only if nothing survived (#1068)',
      payload: { debate_id, emitted: parsed.length, survived, dropped },
    });
  }
  return conditions;
}

/** Absent stays absent: an empty list is written as `[]`, so "never emitted" and "all dropped" stay distinguishable in the row. */
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
