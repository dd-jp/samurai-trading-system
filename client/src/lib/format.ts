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

/** The string every formatter here renders for a value it cannot display. */
export const UNKNOWN = '—';
const MINUS = '−';

const USD = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const GBP_WHOLE = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/**
 * A stage duration, from `duration_ms`. `null` renders as an em dash — an
 * unknown duration must never read as zero.
 */
export function formatStageDuration(ms: number | null): string {
  // Non-finite input is guarded up front rather than left to the branches
  // below, because EVERY comparison against NaN is false: `NaN` fell through
  // all of them into the minutes branch and rendered `NaNm NaNs`, and
  // `Infinity` rendered `Infinitym NaNs` (PR #582 review round 3). Same
  // unknown-value contract the signed formatters keep.
  if (ms === null || !Number.isFinite(ms)) return UNKNOWN;
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
  if (Number.isNaN(ms)) return UNKNOWN;
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
  if (!Number.isFinite(value)) return UNKNOWN;
  const sign = value < 0 ? MINUS : '+';
  return `${sign}$${USD.format(Math.abs(value))}`;
}

/** Signed R multiple: `+1.25R` / `−0.40R`. Zero is `+0.00R`; non-finite is an em dash. */
export function formatSignedR(value: number): string {
  if (!Number.isFinite(value)) return UNKNOWN;
  const sign = value < 0 ? MINUS : '+';
  return `${sign}${Math.abs(value).toFixed(2)}R`;
}

/*
 * ---------------------------------------------------------------------------
 * Display formatters added for the components (issue #538).
 *
 * They live here rather than in a sibling module so there is exactly one
 * `UNKNOWN` and exactly one unknown-value contract on this client: every
 * function below renders the same em dash for a value it cannot honestly
 * display, and none of them can emit `NaN` into visible text or — worse — into
 * a CSS length (see `barWidth`).
 * ---------------------------------------------------------------------------
 */

/** Unsigned, grouped USD: `$1,234.56`. Non-finite renders as an em dash. */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return UNKNOWN;
  return `$${USD.format(value)}`;
}

/**
 * Signed, grouped GBP: `+£1,234.56` / `−£0.50`. Same grammar as
 * `formatSignedUsd` — grouping and decimal rules don't differ between the two
 * locales, so this reuses `USD`'s formatter rather than a second
 * `Intl.NumberFormat` instance carrying the same options.
 */
export function formatSignedGbp(value: number): string {
  if (!Number.isFinite(value)) return UNKNOWN;
  const sign = value < 0 ? MINUS : '+';
  return `${sign}£${USD.format(Math.abs(value))}`;
}

/**
 * Unsigned GBP with no decimal places: `£1,000`. For a whole-pound reference
 * figure (the declared book), not a signed cash movement — `formatSignedGbp`
 * covers those. Non-finite renders as an em dash.
 */
export function formatGbpWhole(value: number): string {
  if (!Number.isFinite(value)) return UNKNOWN;
  return `£${GBP_WHOLE.format(value)}`;
}

/** A fixed-precision figure (Sharpe, profit factor, …). Non-finite is an em dash. */
export function formatFixed(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return UNKNOWN;
  return value.toFixed(digits);
}

/** An integer count with grouping. Non-finite (or fractional garbage) is an em dash. */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return UNKNOWN;
  return Math.round(value).toLocaleString('en-US');
}

/** A `0…1` fraction as a percentage: `42.0%`. Non-finite is an em dash. */
export function formatPercent(fraction: number, digits = 1): string {
  if (!Number.isFinite(fraction)) return UNKNOWN;
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** A price, grouped to 2dp. Non-finite is an em dash — never a blank cell. */
export function formatPrice(value: number): string {
  if (!Number.isFinite(value)) return UNKNOWN;
  return USD.format(value);
}

/**
 * A CSS width for a meter, from a `0…1` fraction — or `null` when the fraction
 * is not a number this can honestly draw.
 *
 * `null` rather than `'0%'` deliberately: a zero-width bar is a legitimate
 * reading (nothing spent, no weight), so an unknown value must be
 * distinguishable from it and the caller renders a named degenerate state
 * instead. Values above 1 clamp to `100%` — a 300%-wide bar would paint over
 * its neighbours, and the over-cap fact is carried by a word beside the meter.
 */
export function barWidth(fraction: number): string | null {
  if (!Number.isFinite(fraction)) return null;
  return `${Math.min(100, Math.max(0, fraction * 100)).toFixed(1)}%`;
}

/** `+1.87%` / `−0.40%`, sign always explicit — colour is never the only carrier. */
export function formatSignedPercent(fraction: number, digits = 2): string {
  if (!Number.isFinite(fraction)) return UNKNOWN;
  const sign = fraction < 0 ? MINUS : '+';
  return `${sign}${(Math.abs(fraction) * 100).toFixed(digits)}%`;
}

/**
 * A quantity of an instrument. Whole units print as an integer; a fractional
 * fill keeps up to four decimals, which is the precision the store carries.
 */
export function formatQty(value: number): string {
  if (!Number.isFinite(value)) return UNKNOWN;
  if (Number.isInteger(value)) return String(value);
  // `\.?` so a value that rounds to a whole number at four decimals without
  // being one (1.00001 -> "1.0000") does not print as "1." — the integer
  // branch above cannot catch it.
  return value.toFixed(4).replace(/\.?0+$/, '');
}

/** How long a trade was held: `41m`, `1h 12m`, `2d 3h`. */
export function formatHeld(fromIso: string, toIso: string): string {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return UNKNOWN;
  const minutes = Math.round((to - from) / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** The UTC calendar date of an ISO timestamp, `YYYY-MM-DD`; `—` if unparseable. */
export function formatDateUtc(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return UNKNOWN;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * A timestamp for a list that spans days: the clock alone when it falls on
 * `todayIso`'s UTC date, the date otherwise. Saves the operator reading a
 * date on every row of a list that is mostly today.
 */
export function formatWhen(iso: string, todayIso: string): string {
  const day = formatDateUtc(iso);
  if (day === UNKNOWN) return UNKNOWN;
  return day === formatDateUtc(todayIso) ? formatClockUtc(iso) : day;
}
