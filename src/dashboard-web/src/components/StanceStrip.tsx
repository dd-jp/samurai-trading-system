/**
 * One analyst's position round by round (#427; dashboard-spec.md story 4d).
 * An analyst that was talked around must read differently from one that never
 * moved, which is the whole reason `stance_during_debate` was projected onto
 * the wire.
 *
 * **An absent `stance_during_debate` renders as an empty strip with its reason,
 * never as a fabricated flat line.** A row written before the field was
 * projected, or by a debate that recorded no per-round stance, genuinely has
 * none — and drawing three neutral squares would invent a debate in which
 * nobody moved.
 *
 * The squares are colour; the accessible name is the same information in
 * words, so the strip is never read by colour alone.
 */

import type { DebateRow } from '../../../dashboard/types.ts';

type Direction = DebateRow['direction'];

export interface StanceStripProps {
  /** Per-round positions, oldest first. `undefined` when the debate recorded none. */
  stances: readonly Direction[] | undefined;
  /** Where the analyst ended up — rendered beside the strip by the caller. */
  finalPosition: Direction;
}

/**
 * `Direction`, not `string` (#606 item 6): the only callers pass a wire
 * direction, and the wider type invited a `stance-<garbage>` class that no
 * stylesheet rule matches — a mark rendered with no colour and no meaning.
 */
function directionClass(direction: Direction): string {
  return `stance-mark stance-${direction}`;
}

export function StanceStrip({ stances, finalPosition }: StanceStripProps) {
  if (stances === undefined || stances.length === 0) {
    return (
      <span className="stance-empty">
        no per-round stance recorded — final position {finalPosition}
      </span>
    );
  }
  const spoken = stances.map((stance, round) => `round ${round + 1} ${stance}`).join(', ');
  return (
    <span className="stance-strip" role="img" aria-label={`stance by round: ${spoken}`}>
      {stances.map((stance, round) => (
        // The round index is the identity here: a stance list is a fixed
        // sequence of rounds, so position IS the key, and two rounds with the
        // same direction are legitimately identical values.
        // biome-ignore lint/suspicious/noArrayIndexKey: round number is the row's identity
        <i key={round} className={directionClass(stance)} title={`round ${round + 1}: ${stance}`} />
      ))}
    </span>
  );
}
