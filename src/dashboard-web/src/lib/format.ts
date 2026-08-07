/**
 * Display formatting (issue #537; dashboard-spec.md "format.ts — durations,
 * HH:MM:SSZ clocks, signed money and R"). Pure string functions — no locale
 * surprises (fixed en-US grouping, fixed UTC), no clock reads.
 *
 * Signs are explicit because colour is never the sole carrier of a signal
 * (spec, accessibility floor): every money/R figure carries `+` or `−`.
 * The minus is U+2212 (true minus, same width as `+` in the mono face), not
 * the ASCII hyphen — matching the spec's own glyph.
 */

const EM_DASH = '—';
const MINUS = '−';

const USD = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * A stage duration, from `duration_ms`. `null` renders as an em dash — an
 * unknown duration must never read as zero.
 */
export function formatStageDuration(ms: number | null): string {
  if (ms === null) return EM_DASH;
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/**
 * An ISO timestamp as a `HH:MM:SSZ` UTC clock (spec, telemetry strip /
 * staleness label). Unparseable input renders as an em dash, never `NaN`.
 */
export function formatClockUtc(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return EM_DASH;
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}Z`;
}

/** Signed, grouped USD: `+$1,234.56` / `−$0.50`. Zero (and −0) is `+$0.00`. */
export function formatSignedUsd(value: number): string {
  const sign = value < 0 ? MINUS : '+';
  return `${sign}$${USD.format(Math.abs(value))}`;
}

/** Signed R multiple: `+1.25R` / `−0.40R`. Zero is `+0.00R`. */
export function formatSignedR(value: number): string {
  const sign = value < 0 ? MINUS : '+';
  return `${sign}${Math.abs(value).toFixed(2)}R`;
}
