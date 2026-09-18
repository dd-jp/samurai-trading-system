import type { ReactNode } from 'react';
import { UNKNOWN } from '../lib/format.ts';
import { type MeterTone, Track } from './Track.tsx';

export interface CapMeterProps {
  dataField: string;
  heading: string;
  value: number | undefined;
  cap: number | null;
  format: (n: number) => string;
  tone: Exclude<MeterTone, 'bad'>;
  emptyState: string;
  trackLabel: (fraction: number, value: number, cap: number) => string;
  footnote: (over: boolean) => ReactNode;
}

export function CapMeter({
  dataField,
  heading,
  value,
  cap,
  format,
  tone,
  emptyState,
  trackLabel,
  footnote,
}: CapMeterProps) {
  const fraction =
    value === undefined || cap === null || !Number.isFinite(cap) || cap <= 0
      ? Number.NaN
      : value / cap;
  const meter =
    Number.isFinite(fraction) && value !== undefined && cap !== null
      ? { fraction, value, cap }
      : null;
  const over = meter !== null && meter.fraction >= 1;
  return (
    <div className="rail-block" data-field={dataField}>
      <div className="rail-meter-head">
        <span className="muted">{heading}</span>
        <span className="mono">
          {value === undefined ? UNKNOWN : format(value)} / {cap === null ? UNKNOWN : format(cap)}
        </span>
      </div>
      {meter !== null ? (
        <Track
          fraction={meter.fraction}
          tone={over ? 'bad' : tone}
          label={trackLabel(meter.fraction, meter.value, meter.cap)}
        />
      ) : (
        <span className="rail-note">{emptyState}</span>
      )}
      {footnote(over)}
    </div>
  );
}
