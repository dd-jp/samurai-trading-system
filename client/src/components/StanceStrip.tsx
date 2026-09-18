
import type { DebateRow } from '@contracts';

type Direction = DebateRow['direction'];

export interface StanceStripProps {
  stances: readonly Direction[] | undefined;
  finalPosition: Direction;
}

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
        // biome-ignore lint/suspicious/noArrayIndexKey: round number is the row's identity
        <i key={round} className={directionClass(stance)} title={`round ${round + 1}: ${stance}`} />
      ))}
    </span>
  );
}
