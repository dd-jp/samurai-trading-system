import type { DebateLog, DebateLogStore, DebateRoundLogEntry } from '../../shared/index.js';
import type { DebateResult } from './types.js';

export function buildDebateLog(
  result: DebateResult,
  instrument: string,
  created_at: Date,
  trace_id?: string,
): DebateLog {
  return {
    debate_id: result.debate_id,
    instrument,
    bar_timestamp: result.bar_timestamp,
    contributions: result.contributions,
    direction: result.direction,
    rounds: result.rounds_completed,
    created_at,
    ...(trace_id === undefined ? {} : { trace_id }),
    confidence: result.confidence,
    synthesis: result.synthesis,
    position: result.position,
    disagreement_summary: result.disagreement_summary,
    open_items: result.open_items,
    converged: result.converged,
    termination:
      result.timed_out !== undefined
        ? 'latency_truncated'
        : result.converged
          ? 'converged'
          : 'non_converged',
    ...(result.timed_out?.cause === undefined ? {} : { termination_cause: result.timed_out.cause }),
  };
}

export function buildDebateRoundLogRows(
  result: DebateResult,
  created_at: Date,
): DebateRoundLogEntry[] {
  return (result.round_verdicts ?? []).map((verdict) => ({
    debate_id: result.debate_id,
    round: verdict.round,
    direction: verdict.direction,
    confidence: verdict.confidence,
    created_at,
  }));
}

export const DEBATE_BAR_TIMEFRAME_MS = 60 * 60 * 1_000;

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

  writeLogWithRounds(entry: DebateLog, _rounds: DebateRoundLogEntry[]): void {
    this.writeLog(entry);
  }
}
