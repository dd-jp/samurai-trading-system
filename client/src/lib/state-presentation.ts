import type {
  CloseReason,
  InvalidationConditionStateWire,
  PipelineCellState,
  PipelineOutcome,
  RiskCriticRow,
  VerdictRow,
} from '@contracts';
import { OUTCOME_WORD } from './vocabulary.ts';

type StateTone = 'done' | 'live' | 'stop' | 'skip' | 'wait';

export interface Presented {
  word: string;
  tone: StateTone;
}

const CELL_STATE_WORD: Readonly<Record<PipelineCellState, string>> = {
  done: 'done',
  live: 'live',
  stopped: 'stopped',
  skipped: 'skipped',
  not_reached: 'not reached',
};

const CELL_TONE: Readonly<Record<PipelineCellState, StateTone>> = {
  done: 'done',
  live: 'live',
  stopped: 'stop',
  skipped: 'skip',
  not_reached: 'wait',
};

export function presentCell(state: PipelineCellState, laneOutcome: PipelineOutcome): Presented {
  const tone = CELL_TONE[state];
  if (laneOutcome === 'idle') return { word: 'idle', tone };
  if (state === 'not_reached' && laneOutcome === 'in_flight') return { word: 'wait', tone };
  return { word: CELL_STATE_WORD[state], tone };
}

const CONDITION_STATE_WORD: Readonly<Record<InvalidationConditionStateWire, string>> = {
  breached: 'breached',
  not_breached: 'holds',
  unevaluable: 'unevaluable',
};

const CONDITION_TONE: Readonly<Record<InvalidationConditionStateWire, StateTone>> = {
  breached: 'stop',
  not_breached: 'done',
  unevaluable: 'wait',
};

export function presentCondition(state: InvalidationConditionStateWire): Presented {
  return { word: CONDITION_STATE_WORD[state], tone: CONDITION_TONE[state] };
}

const CRITIC_VERDICT_WORD: Readonly<Record<NonNullable<RiskCriticRow['critic_verdict']>, string>> =
  {
    pass: 'pass',
    trim: 'trim',
    reject: 'reject',
    unavailable: 'unavailable',
  };

const CRITIC_TONE: Readonly<Record<NonNullable<RiskCriticRow['critic_verdict']>, StateTone>> = {
  pass: 'done',
  trim: 'live',
  reject: 'stop',
  unavailable: 'wait',
};

export function presentCriticVerdict(verdict: RiskCriticRow['critic_verdict']): Presented {
  if (verdict === null) return { word: 'no verdict', tone: 'wait' };
  return { word: CRITIC_VERDICT_WORD[verdict], tone: CRITIC_TONE[verdict] };
}

const VERDICT_STATUS_TONE: Readonly<Record<VerdictRow['status'], StateTone>> = {
  go: 'done',
  no_go: 'stop',
};

export function presentVerdictStatus(status: VerdictRow['status']): Presented {
  return { word: OUTCOME_WORD[status], tone: VERDICT_STATUS_TONE[status] };
}

const CLOSE_REASON_WORD: Readonly<Record<CloseReason, string>> = {
  stop: 'stop hit',
  target: 'target hit',
  exit: 'exit',
  flatten: 'flattened',
  signal_decay: 'signal decay',
  direction_flip: 'direction flip',
};

const CLOSE_REASON_TONE: Readonly<Record<CloseReason, StateTone>> = {
  stop: 'stop',
  target: 'done',
  exit: 'skip',
  flatten: 'skip',
  signal_decay: 'skip',
  direction_flip: 'skip',
};

export function presentCloseReason(reason: CloseReason): Presented {
  return { word: CLOSE_REASON_WORD[reason], tone: CLOSE_REASON_TONE[reason] };
}
