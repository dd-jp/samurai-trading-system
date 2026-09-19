import { isFiniteNumber } from '../is-finite-number.js';
import { truncateForError } from './response-errors.js';

export interface RawPolygonAggregate {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export function validateRawPolygonAggregate(
  raw: unknown,
  symbol: string,
  errorPrefix: string,
): RawPolygonAggregate {
  if (typeof raw === 'object' && raw !== null) {
    const { t, o, h, l, c, v } = raw as Record<string, unknown>;
    if (
      isFiniteNumber(t) &&
      isFiniteNumber(o) &&
      isFiniteNumber(h) &&
      isFiniteNumber(l) &&
      isFiniteNumber(c) &&
      isFiniteNumber(v)
    ) {
      return { t, o, h, l, c, v };
    }
  }
  throw new Error(
    `${errorPrefix}: malformed aggregate for ${symbol}: ${truncateForError(JSON.stringify(raw))}`,
  );
}

export function toPolygonDate(date: Date): string {
  return date.toISOString().split('T')[0] as string;
}
