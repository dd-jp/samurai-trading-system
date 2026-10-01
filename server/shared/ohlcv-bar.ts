import { isFiniteNumber } from './is-finite-number.js';

export interface OhlcvBar<T> {
  t: T;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export function readOhlcvBar<T>(
  raw: unknown,
  isTime: (value: unknown) => value is T,
): OhlcvBar<T> | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { t, o, h, l, c, v } = raw as Record<string, unknown>;
  return isTime(t) &&
    isFiniteNumber(o) &&
    isFiniteNumber(h) &&
    isFiniteNumber(l) &&
    isFiniteNumber(c) &&
    isFiniteNumber(v)
    ? { t, o, h, l, c, v }
    : undefined;
}

export function isString(value: unknown): value is string {
  return typeof value === 'string';
}
