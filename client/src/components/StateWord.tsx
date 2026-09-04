import type { EvaluatedConditionWire, PipelineCellState } from '@contracts';

/** The five visual families a state word can wear. Each is also a word. */
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
