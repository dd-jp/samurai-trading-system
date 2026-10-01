import { isFiniteNumber } from '../is-finite-number.js';
import { readOhlcvBar } from '../ohlcv-bar.js';
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
  const aggregate = readOhlcvBar(raw, isFiniteNumber);
  if (aggregate !== undefined) return aggregate;
  throw new Error(
    `${errorPrefix}: malformed aggregate for ${symbol}: ${truncateForError(JSON.stringify(raw))}`,
  );
}

export function toPolygonDate(date: Date): string {
  return date.toISOString().split('T')[0] as string;
}
