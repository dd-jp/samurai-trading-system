import type {
  ClosedTrade,
  DebateLog,
  DebateRoundLogEntry,
  SetupNeighbor,
  SetupVector,
  VerdictLog,
} from './records.js';

export interface SetupStore {
  findNeighbors(vector: SetupVector, asOf: Date): SetupNeighbor[];
  writeSetup(debateId: string, vector: SetupVector, decidedAt: Date): void;
  labelSetup(debate_id: string, r_multiple: number, closed_at: Date): void;
}

export interface DebateLogStore {
  writeLog(entry: DebateLog): void;
  getByDebateId(debate_id: string): DebateLog | undefined;
  writeLogWithRounds(entry: DebateLog, rounds: DebateRoundLogEntry[]): void;
}

export interface VerdictLogStore {
  writeLog(entry: VerdictLog): void;
}

export interface ClosedTradeStore {
  getClosedTradesBetween(from: Date, to: Date): ClosedTrade[];
}

export interface TuningStore {
  getAnalystWeights(): Record<string, number>;
  setAnalystWeight(analyst_id: string, weight: number): void;
  seedAnalystWeight(analyst_id: string, weight: number): boolean;
  getStrategyParams(): Record<string, number>;
  setStrategyParam(name: string, value: number): void;
  getRiskThresholds(): Record<string, number>;
  setRiskThreshold(name: string, value: number): void;
  seedRiskThreshold(name: string, value: number): boolean;
}
