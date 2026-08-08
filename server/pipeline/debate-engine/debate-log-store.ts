/**
 * In-memory `DebateLogStore` for #63 — a concrete implementation of the
 * port (not a test-only mock), mirroring src/trader/fixture-setup-store.ts's
 * `FixtureSetupStore`. See docs/specs/debate-engine-spec.md
 * ("Debate log write"). The real SQLite-backed store is
 * `SqliteDebateLogStore` (#200, src/debate-engine/sqlite-debate-log-store.ts).
 */
import type { DebateLog, DebateLogStore } from '../../shared/index.js';
import type { DebateResult } from './types.js';

/**
 * Constructs the persisted `DebateLog` row from a resolved `DebateResult`.
 * `instrument`/`bar_timestamp` aren't carried on `DebateResult` (its shape is
 * the Trader-facing contract, not the log record), so the caller — the
 * component that ran the debate and knows the tick's instrument/bar —
 * supplies them.
 */
export function buildDebateLog(
  result: DebateResult,
  instrument: string,
  bar_timestamp: Date,
  created_at: Date,
  trace_id?: string,
): DebateLog {
  return {
    debate_id: result.debate_id,
    instrument,
    bar_timestamp,
    contributions: result.contributions,
    direction: result.direction,
    rounds: result.rounds_completed,
    created_at,
    // #426. Omitted rather than `undefined` so the row shape matches the
    // optional field exactly; a caller with no trace writes NULL.
    ...(trace_id === undefined ? {} : { trace_id }),
  };
}

/**
 * The bar coordinate a live tick belongs to (#393).
 *
 * ## The defect
 *
 * `debate_log.bar_timestamp` stored `clock.now()`, unfloored. A tick at
 * 14:32:07 wrote `bar_timestamp = 14:32:07` — which is what `created_at`
 * already means. The column is named for a bar coordinate and held the tick
 * time.
 *
 * That breaks replay-from-log, the determinism posture ADR-0003 §2 states for
 * every LLM pass ("replay the logged output instead of re-calling the LLM …
 * a live LLM call inside a replayed path is disqualified outright"). Under
 * `BacktestHarness` the clock is advanced TO a bar close, so a replay looks up
 * 14:30:00 and misses every live row. `debate_id` cannot bridge the two either
 * — it hashes the same unfloored instant plus the analyst views.
 *
 * ## The timeframe had to be introduced, and this is the one chosen
 *
 * #393 records the open question honestly: the debate step receives no
 * timeframe, and timeframe is a per-ANALYST constant today
 * (`INDICATOR_TIMEFRAME`, `CONTEXT_TIMEFRAME`) rather than a tick property.
 *
 * One hour, because it is the coordinate the rest of the system already
 * decides on: `DEFAULT_INDICATOR_TIMEFRAME` is `1h`, `DEFAULT_TRADER_CONFIG
 * .atr_timeframe` is `1h`, and the Trader's stop — the number a mis-floored
 * bar would actually corrupt — is priced off 1h bars. Choosing anything else
 * would introduce a second bar concept alongside the one every indicator
 * already uses.
 *
 * It is deliberately NOT the tick cadence (15 minutes, ADR-0008). Cadence is
 * how often the system looks; a bar is what it looks AT. Flooring to cadence
 * would make the coordinate change the day someone retunes the scheduler, and
 * every historical row would then refer to a grid nothing else shares.
 *
 * Consequence worth stating: at a 15-minute cadence, four consecutive ticks
 * share one bar. They do NOT thereby share a `debate_id` — the bar is only one
 * of three hash inputs, and the third is the analyst views, whose `key_points`
 * are raw model prose. Two ticks fifteen minutes apart collide only if the
 * analysts produced byte-identical output over the interval, which is the
 * retry case the write-once primary key is for, not a second debate. Flooring
 * therefore makes the log's duplicate guard REACHABLE where an unfloored
 * instant left it dead code; first-write-wins is the intended resolution.
 */
export const DEBATE_BAR_TIMEFRAME_MS = 60 * 60 * 1_000;

/**
 * Floors an instant to its bar's opening boundary, in UTC.
 *
 * Epoch-relative, not calendar-relative. The honest statement of the tradeoff:
 * epoch flooring produces a uniform grid with no local-time concept at all, so
 * it neither knows nor cares about DST — which is right here, because every
 * timestamp in this system is UTC (`bar_timestamp` is stored and compared as
 * an ISO instant) and UTC has no DST transitions to misalign against. A
 * calendar floor would be the one that needs a timezone argument to be
 * well-defined. If a local-session timeframe is ever introduced — a US equity
 * trading day, say — this function is NOT the right tool for it.
 */
export function floorToBar(at: Date, timeframeMs: number = DEBATE_BAR_TIMEFRAME_MS): Date {
  return new Date(Math.floor(at.getTime() / timeframeMs) * timeframeMs);
}

export class InMemoryDebateLogStore implements DebateLogStore {
  private readonly rows = new Map<string, DebateLog>();

  writeLog(entry: DebateLog): void {
    this.rows.set(entry.debate_id, entry);
  }

  getByDebateId(debate_id: string): DebateLog | undefined {
    return this.rows.get(debate_id);
  }
}
