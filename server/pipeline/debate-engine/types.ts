
export type { Direction } from '../../../contracts/index.js';

import type { Direction } from '../../../contracts/index.js';
import type { DebateTerminationCause } from '../../shared/index.js';

export interface AnalystView {
  trace_id: string;
  analyst_id: string;
  analyst_type: string;
  direction: Direction;
  confidence: number;
  key_points: string[];
  timestamp: Date;
}

export interface AnalystContribution {
  analyst_id: string;
  analyst_type: string;
  stance_during_debate: Direction[];
  final_position: Direction;
  rationale: string;
  influence_score: number;
}

export interface RoundVerdict {
  round: number;
  direction: Direction;
  confidence: number;
}

export interface DebateResult {
  synthesis: string;
  position: string;
  confidence: number;
  contributions: AnalystContribution[];
  disagreement_summary: string;
  open_items: string[];
  converged: boolean;
  rounds_completed: number;
  latency_ms: number;
  direction: Direction;
  debate_id: string;
  bar_timestamp: Date;
  read: boolean;
  timed_out?: {
    budget_ms: number;
    elapsed_ms: number;
    cause?: DebateTerminationCause;
  };
  rate_limited?: {
    reason: string;
  };
  round_verdicts?: RoundVerdict[];
}
