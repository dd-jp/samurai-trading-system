import { barWidth } from '../lib/format.ts';

export type MeterTone = 'cyan' | 'amber' | 'bad' | 'gain' | 'loss';

export interface TrackProps {
  fraction: number;
  tone: MeterTone;
  label: string;
  thick?: boolean;
}

export function Track({ fraction, tone, label, thick = false }: TrackProps) {
  const width = barWidth(fraction);
  if (width === null) return null;
  return (
    <span className={thick ? 'track track-thick' : 'track'} role="img" aria-label={label}>
      <i className={`track-fill track-${tone}`} style={{ width }} />
    </span>
  );
}
