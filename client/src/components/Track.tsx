import { barWidth } from '../lib/format.ts';

/** The colour families a meter fill can wear. `gain` / `loss` follow a signed figure's sign. */
export type MeterTone = 'cyan' | 'amber' | 'bad' | 'gain' | 'loss';

export interface TrackProps {
  /** 0..1 of the track to fill. A non-finite fraction draws nothing. */
  fraction: number;
  tone: MeterTone;
  /** The accessible name: what the fill measures, with its figure in words. */
  label: string;
  thick?: boolean;
}

/**
 * The one horizontal meter every surface draws — the rail's cap and drawdown
 * bars, Glance's stop→target progress, Review's analyst weights. Renders
 * nothing rather than a zero-width fill when the fraction is not a number,
 * so a missing figure never reads as an empty meter.
 */
export function Track({ fraction, tone, label, thick = false }: TrackProps) {
  const width = barWidth(fraction);
  if (width === null) return null;
  return (
    <span className={thick ? 'track track-thick' : 'track'} role="img" aria-label={label}>
      <i className={`track-fill track-${tone}`} style={{ width }} />
    </span>
  );
}
