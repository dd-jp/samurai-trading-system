import type { ReactNode } from 'react';
import { UNKNOWN } from '../lib/format.ts';
import { type MeterTone, Track } from './Track.tsx';

export interface CapMeterProps {
  dataField: string;
  heading: string;
  value: number | undefined;
  cap: number | null;
  format: (n: number) => string;
  /** Tone below the cap; at or above it the meter always reads `bad`. */
  tone: Exclude<MeterTone, 'bad'>;
  /** What the note says when the meter cannot be drawn — the caller's own reason. */
  emptyState: string;
  trackLabel: (fraction: number, value: number, cap: number) => string;
  footnote: (over: boolean) => ReactNode;
}

/**
 * The one capped-meter shape both the rail's LLM-spend and drawdown blocks
 * draw from: a value against a cap, a fill fraction, and a tone that turns
 * `bad` once the fraction reaches 1. Callers own everything domain-specific
 * — the empty-state wording, the accessible label, the footnote — so two
 * meters can read differently without recomputing the threshold twice.
 */
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
