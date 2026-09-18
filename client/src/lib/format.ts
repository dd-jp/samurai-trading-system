
export const UNKNOWN = '—';
const MINUS = '−';

const USD = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const GBP_WHOLE = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export function formatStageDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return UNKNOWN;
  if (ms < 1_000) return `${Math.round(ms)}ms`;

  const tenths = Math.round(ms / 100);
  if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;

  const totalSeconds = Math.round(ms / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

export function formatClockUtc(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return UNKNOWN;
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}Z`;
}

export function formatSignedUsd(value: number): string {
  if (!Number.isFinite(value)) return UNKNOWN;
  const sign = value < 0 ? MINUS : '+';
  return `${sign}$${USD.format(Math.abs(value))}`;
}

export function formatSignedR(value: number): string {
  if (!Number.isFinite(value)) return UNKNOWN;
  const sign = value < 0 ? MINUS : '+';
  return `${sign}${Math.abs(value).toFixed(2)}R`;
}

export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return UNKNOWN;
  return `$${USD.format(value)}`;
}

export function formatSignedGbp(value: number): string {
  if (!Number.isFinite(value)) return UNKNOWN;
  const sign = value < 0 ? MINUS : '+';
  return `${sign}£${USD.format(Math.abs(value))}`;
}

export function formatGbpWhole(value: number): string {
  if (!Number.isFinite(value)) return UNKNOWN;
  return `£${GBP_WHOLE.format(value)}`;
}

export function formatFixed(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return UNKNOWN;
  return value.toFixed(digits);
}

export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return UNKNOWN;
  return Math.round(value).toLocaleString('en-US');
}

export function formatPercent(fraction: number, digits = 1): string {
  if (!Number.isFinite(fraction)) return UNKNOWN;
  return `${(fraction * 100).toFixed(digits)}%`;
}

export function formatPrice(value: number): string {
  if (!Number.isFinite(value)) return UNKNOWN;
  return USD.format(value);
}

export function barWidth(fraction: number): string | null {
  if (!Number.isFinite(fraction)) return null;
  return `${Math.min(100, Math.max(0, fraction * 100)).toFixed(1)}%`;
}

export function formatSignedPercent(fraction: number, digits = 2): string {
  if (!Number.isFinite(fraction)) return UNKNOWN;
  const sign = fraction < 0 ? MINUS : '+';
  return `${sign}${(Math.abs(fraction) * 100).toFixed(digits)}%`;
}

export function formatQty(value: number): string {
  if (!Number.isFinite(value)) return UNKNOWN;
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(4).replace(/\.?0+$/, '');
}

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

export function formatDateUtc(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return UNKNOWN;
  return new Date(ms).toISOString().slice(0, 10);
}

export function formatWhen(iso: string, todayIso: string): string {
  const day = formatDateUtc(iso);
  if (day === UNKNOWN) return UNKNOWN;
  return day === formatDateUtc(todayIso) ? formatClockUtc(iso) : day;
}
