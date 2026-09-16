/**
 * One function per wire enum that needs both a word and a colour, returning
 * the pair as a unit.
 *
 * Before this module, a word table (`vocabulary.ts`) and a tone table
 * (`StateWord.tsx`) were maintained in parallel and joined by hand at every
 * call site — and `cellStateWord(state, laneOutcome)` takes a different input
 * than `cellTone(state)`, so the two tables could not even be kept in sync by
 * construction. The dashboard's accessibility floor ("colour is never the
 * sole carrier of a signal", `dashboard-spec.md`) rested on getting that join
 * right nine times over. `StateWord` now takes a `Presented` value instead of
 * a bare tone, so supplying a colour without its word stops type-checking.
 * (Review 2026-09-04 F3, #1138.)
 */
import type {
  CloseReason,
  InvalidationConditionStateWire,
  PipelineCellState,
  PipelineOutcome,
  RiskCriticRow,
  VerdictRow,
} from '@contracts';
import { OUTCOME_WORD } from './vocabulary.ts';

/** The five visual families a state word can wear. Each is also a word. */
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

/**
 * The lane matrix / timeline cell for one stage. `not_reached` reads as
 * "wait" while the lane is still running — the stage is ahead of the tick —
 * and as "not reached" once it has settled, where nothing will ever reach it.
 * An idle lane has no trace at all, so every cell says so; only the word
 * changes, the tone still tracks the cell's own state.
 */
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

/** `null` is "no verdict recorded", which waits like an unevaluable condition */
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

/**
 * A stop is the trade's own failure; a target its success; everything else is
 * the system closing a position for a reason that is neither — the
 * flat-by-close rule most often
 */
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
