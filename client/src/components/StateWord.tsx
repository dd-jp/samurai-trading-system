import type { Presented } from '../lib/state-presentation.ts';

export function pnlTone(value: number): 'gain' | 'loss' {
  return value >= 0 ? 'gain' : 'loss';
}

export interface StateWordProps {
  state: Presented;
  title?: string;
}

export function StateWord({ state, title }: StateWordProps) {
  return (
    <span className={`state state-${state.tone}`} title={title}>
      {state.word}
    </span>
  );
}
