export const SIGNAL_TARGETS_MAX = 12;
export const SIGNAL_SOURCE_MAX_CHARS = 64;
export const SIGNAL_SIZE_MAX = 1;

const SYMBOL = /^[A-Z]{1,5}(?:\.[A-Z]{1,2})?$/;
const SOURCE = /^[A-Za-z0-9 _.:@/-]+$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const KEYS: ReadonlySet<string> = new Set([
  'symbol',
  'entry',
  'targets',
  'stop',
  'size',
  'trail_after',
  'source',
  'received_at',
]);

export interface SignalPayload {
  readonly symbol: string;
  readonly entryLow: number;
  readonly entryHigh: number;
  readonly entryIsZone: boolean;
  readonly targets: readonly number[];
  readonly stop: number;
  readonly size: number | undefined;
  readonly trailAfter: number | undefined;
  readonly source: string | undefined;
  readonly sentAt: string | undefined;
}

export type SignalParse =
  | { readonly ok: true; readonly payload: SignalPayload }
  | { readonly ok: false; readonly reason: string };

class SignalPayloadError extends Error {}

function fail(reason: string): never {
  throw new SignalPayloadError(reason);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positive(name: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    fail(`${name} must be a finite positive number`);
  }
  return value;
}

function optionalPositive(name: string, value: unknown): number | undefined {
  return value === undefined ? undefined : positive(name, value);
}

function parseSymbol(value: unknown): string {
  if (typeof value !== 'string' || !SYMBOL.test(value)) {
    fail('symbol must be an upper-case US ticker such as AAPL or BRK.B');
  }
  return value;
}

function parseEntry(value: unknown): { low: number; high: number; zone: boolean } {
  if (!Array.isArray(value)) {
    const price = positive('entry', value);
    return { low: price, high: price, zone: false };
  }
  if (value.length !== 2) fail('an entry zone must be [low, high]');
  const low = positive('entry low', value[0]);
  const high = positive('entry high', value[1]);
  if (low >= high) fail('an entry zone must have low < high');
  return { low, high, zone: true };
}

function parseTargets(value: unknown, entryHigh: number): number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > SIGNAL_TARGETS_MAX) {
    fail(`targets must be an array of 1 to ${SIGNAL_TARGETS_MAX} prices`);
  }
  const targets = value.map((target: unknown) => positive('each target', target));
  if (targets.some((target, index) => index > 0 && target <= (targets[index - 1] as number))) {
    fail('targets must be strictly ascending');
  }
  if ((targets[0] as number) <= entryHigh) fail('every target must be above the entry');
  return targets;
}

function parseStop(value: unknown, entryLow: number): number {
  const stop = positive('stop', value);
  if (stop >= entryLow) fail('stop must be below the entry: signals are US longs only');
  return stop;
}

function parseSize(value: unknown): number | undefined {
  const size = optionalPositive('size', value);
  if (size !== undefined && size > SIGNAL_SIZE_MAX) fail(`size must be at most ${SIGNAL_SIZE_MAX}`);
  return size;
}

function parseSource(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > SIGNAL_SOURCE_MAX_CHARS || !SOURCE.test(value)) {
    fail(`source must be 1 to ${SIGNAL_SOURCE_MAX_CHARS} letters, digits, spaces or _ . : @ / -`);
  }
  return value;
}

function isCalendarDate(text: string): boolean {
  const day = text.slice(0, 10);
  const midnight = new Date(`${day}T00:00:00.000Z`);
  return !Number.isNaN(midnight.getTime()) && midnight.toISOString().slice(0, 10) === day;
}

function parseSentAt(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const valid = typeof value === 'string' && ISO_INSTANT.test(value) && isCalendarDate(value);
  const parsed = valid ? Date.parse(value) : NaN;
  if (Number.isNaN(parsed)) fail('received_at must be an ISO 8601 instant with a zone');
  return new Date(parsed).toISOString();
}

function rejectUnknownKeys(value: Record<string, unknown>): void {
  const unknown = Object.keys(value).filter((key) => !KEYS.has(key));
  if (unknown.length > 0) fail(`unknown field: ${unknown.sort().join(', ')}`);
}

function parseRecord(value: Record<string, unknown>): SignalPayload {
  rejectUnknownKeys(value);
  const symbol = parseSymbol(value.symbol);
  const entry = parseEntry(value.entry);
  return {
    symbol,
    entryLow: entry.low,
    entryHigh: entry.high,
    entryIsZone: entry.zone,
    targets: parseTargets(value.targets, entry.high),
    stop: parseStop(value.stop, entry.low),
    size: parseSize(value.size),
    trailAfter: optionalPositive('trail_after', value.trail_after),
    source: parseSource(value.source),
    sentAt: parseSentAt(value.received_at),
  };
}

export function parseSignalPayload(value: unknown): SignalParse {
  if (!isRecord(value)) return { ok: false, reason: 'body must be a JSON object' };
  try {
    return { ok: true, payload: parseRecord(value) };
  } catch (error) {
    if (!(error instanceof SignalPayloadError)) throw error;
    return { ok: false, reason: error.message };
  }
}
