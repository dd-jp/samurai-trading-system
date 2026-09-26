export const UNKNOWN = '—';
const MINUS = '−';

const MONEY = new Intl.NumberFormat('en-GB', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function signed(value: number, symbol: string): string {
  if (!Number.isFinite(value)) return UNKNOWN;
  const sign = value < 0 ? MINUS : '';
  return `${sign}${symbol}${MONEY.format(Math.abs(value))}`;
}

export function gbp(value: number | null): string {
  return value === null ? UNKNOWN : signed(value, '£');
}

function usd(value: number | null): string {
  return value === null ? UNKNOWN : signed(value, '$');
}

export function quote(value: number, currency: 'USD' | 'GBP'): string {
  return currency === 'USD' ? usd(value) : gbp(value);
}

export function percent(fraction: number | null, digits = 1): string {
  if (fraction === null || !Number.isFinite(fraction)) return UNKNOWN;
  const sign = fraction < 0 ? MINUS : '';
  return `${sign}${(Math.abs(fraction) * 100).toFixed(digits)}%`;
}

export function fixed(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) return UNKNOWN;
  const sign = value < 0 ? MINUS : '';
  return `${sign}${Math.abs(value).toFixed(digits)}`;
}

export function utcMinute(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return UNKNOWN;
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')}Z`;
}

const SIZE_STEPS: ReadonlyMap<number, string> = new Map([
  [1, '1'],
  [0.5, '½'],
  [0.25, '¼'],
  [0, 'halted'],
]);

export function sizeStep(multiplier: number): string {
  return SIZE_STEPS.get(multiplier) ?? fixed(multiplier);
}
