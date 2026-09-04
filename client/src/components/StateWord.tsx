import type {
  CloseReason,
  EvaluatedConditionWire,
  PipelineCellState,
  RiskCriticRow,
} from '@contracts';

/**
 * The five visual families a state word can wear. Each is also a word.
 * Every mapping from a wire state to a tone lives in this file, so adding a
 * family is one edit.
 */
export type StateTone = 'done' | 'live' | 'stop' | 'skip' | 'wait';

const CELL_TONE: Readonly<Record<PipelineCellState, StateTone>> = {
  done: 'done',
  live: 'live',
  stopped: 'stop',
  skipped: 'skip',
  not_reached: 'wait',
};

export function cellTone(state: PipelineCellState): StateTone {
  return CELL_TONE[state];
}

const CONDITION_TONE: Readonly<Record<EvaluatedConditionWire['state'], StateTone>> = {
  breached: 'stop',
  not_breached: 'done',
  unevaluable: 'wait',
};

export function conditionTone(state: EvaluatedConditionWire['state']): StateTone {
  return CONDITION_TONE[state];
}

const CRITIC_TONE: Readonly<Record<NonNullable<RiskCriticRow['critic_verdict']>, StateTone>> = {
  pass: 'done',
  trim: 'live',
  reject: 'stop',
  unavailable: 'wait',
};

/** `null` is "no verdict recorded", which waits like an unevaluable condition. */
export function criticTone(verdict: RiskCriticRow['critic_verdict']): StateTone {
  return verdict === null ? 'wait' : CRITIC_TONE[verdict];
}

/**
 * A stop is the trade's own failure; a target its success; everything else is
 * the system closing a position for a reason that is neither — the
 * flat-by-close rule most often.
 */
export function closeReasonTone(reason: CloseReason): StateTone {
  if (reason === 'stop') return 'stop';
  if (reason === 'target') return 'done';
  return 'skip';
}

/** The class a signed money figure wears. The sign in the text is the signal; this is its colour. */
export function pnlTone(value: number): 'gain' | 'loss' {
  return value >= 0 ? 'gain' : 'loss';
}

export interface StateWordProps {
  tone: StateTone;
  children: string;
  title?: string;
}

/** A bordered word. Colour follows the tone, but the word is the signal. */
export function StateWord({ tone, children, title }: StateWordProps) {
  return (
    <span className={`state state-${tone}`} title={title}>
      {children}
    </span>
  );
}
