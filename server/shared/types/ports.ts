import type { DebateLog, DebateRoundLogEntry } from './records.js';

export interface DebateLogStore {
  writeLog(entry: DebateLog): void;
  getByDebateId(debate_id: string): DebateLog | undefined;
  writeLogWithRounds(entry: DebateLog, rounds: DebateRoundLogEntry[]): void;
}
