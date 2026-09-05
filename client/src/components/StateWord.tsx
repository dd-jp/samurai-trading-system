import type { Presented } from '../lib/state-presentation.ts';

/** The class a signed money figure wears. The sign in the text is the signal; this is its colour. */
export function pnlTone(value: number): 'gain' | 'loss' {
  return value >= 0 ? 'gain' : 'loss';
}

export interface StateWordProps {
  /**
   * The word and its tone, arriving together. A caller cannot supply a
   * colour without the word that carries the same information (#1138).
   */
  state: Presented;
  title?: string;
}

/** A bordered word. Colour follows the tone, but the word is the signal. */
export function StateWord({ state, title }: StateWordProps) {
  return (
    <span className={`state state-${state.tone}`} title={title}>
      {state.word}
    </span>
  );
}
