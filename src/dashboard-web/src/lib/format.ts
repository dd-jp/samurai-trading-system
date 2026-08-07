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

  // Branch on the ROUNDED value, not the raw one, and round exactly once per
  // branch. Rounding after choosing the branch is what produced two carry
  // bugs (PR #582 review): `59_950ms` rendered `60.0s` because `toFixed(1)`
  // rounded up inside the seconds branch, and `3_599_500ms` rendered
  // `59m 60s` because the minutes were floored off the raw value while the
  // seconds were rounded up independently of them.
  const tenths = Math.round(ms / 100);
  if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;

  const totalSeconds = Math.round(ms / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
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

/**
 * Signed, grouped USD: `+$1,234.56` / `−$0.50`. Zero (and −0) is `+$0.00`.
 * A non-finite figure renders as an em dash, matching the unknown-value
 * contract the duration and clock formatters already keep — `+$NaN` on a
 * live-money surface reads as a rendering bug rather than as missing data.
 */
export function formatSignedUsd(value: number): string {
  if (!Number.isFinite(value)) return EM_DASH;
  const sign = value < 0 ? MINUS : '+';
  return `${sign}$${USD.format(Math.abs(value))}`;
}

/** Signed R multiple: `+1.25R` / `−0.40R`. Zero is `+0.00R`; non-finite is an em dash. */
export function formatSignedR(value: number): string {
  if (!Number.isFinite(value)) return EM_DASH;
  const sign = value < 0 ? MINUS : '+';
  return `${sign}${Math.abs(value).toFixed(2)}R`;
}
