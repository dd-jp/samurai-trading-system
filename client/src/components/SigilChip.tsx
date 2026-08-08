/**
 * One instrument's chip, standing in the room its trace last reached
 * (dashboard-spec.md, "Rooms hero"). A focusable control: selecting it opens
 * that instrument's drawer.
 *
 * The outcome ring is a colour, so the outcome is also a word — in the
 * accessible name (`"BTC-USD, crypto, stopped, in Risk"`) and, for the asset
 * class, as visually-hidden text. Nothing on this chip is carried by colour
 * alone (spec, Accessibility floor).
 */

import type { PipelineLane } from '@contracts';
import { assetGlyph, OUTCOME_WORD } from '../lib/vocabulary.ts';

export interface SigilChipProps {
  lane: PipelineLane;
  /** The room the chip stands in, in words — part of its accessible name. */
  roomName: string;
  selected: boolean;
  /** This lane holds `pipeline.live_trace_id`: shimmer, and say "live". */
  live: boolean;
  onSelect: (instrument: string) => void;
  /** Registers the element with the walk hook's ref map. */
  registerRef: (instrument: string, element: HTMLElement | null) => void;
}

export function SigilChip(props: SigilChipProps) {
  const { lane, roomName, selected, live, onSelect, registerRef } = props;
  const asset = assetGlyph(lane.asset_class);
  const outcome = OUTCOME_WORD[lane.outcome];
  const className = [
    'chip',
    `chip-${lane.outcome}`,
    selected ? 'chip-selected' : '',
    live ? 'chip-live' : '',
  ]
    .filter((part) => part !== '')
    .join(' ');

  return (
    <button
      type="button"
      className={className}
      data-instrument={lane.instrument}
      data-outcome={lane.outcome}
      // `aria-current`, not `aria-pressed`: the chips are a single-selection
      // set pointing at one drawer, not eight independent toggles — and
      // `aria-pressed` would announce "not pressed" on every chip a keyboard
      // user tabs past.
      aria-current={selected ? 'true' : undefined}
      aria-label={`${lane.instrument}, ${asset.word}, ${outcome}, in ${roomName}`}
      onClick={() => onSelect(lane.instrument)}
      ref={(element) => registerRef(lane.instrument, element)}
    >
      {/* Decoration only — the shimmer says "live" visually, the word says it
          to everyone else. */}
      {live && <span className="chip-shimmer" aria-hidden="true" />}
      <span className="chip-bob">
        <span className="chip-ring" aria-hidden="true" />
        <span className="chip-callsign">{lane.instrument}</span>
        <span className="chip-glyph" aria-hidden="true">
          {asset.glyph}
        </span>
      </span>
    </button>
  );
}
