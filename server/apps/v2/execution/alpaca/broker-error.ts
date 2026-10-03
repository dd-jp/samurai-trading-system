import { MAX_ERROR_BODY_CHARS } from '../../../../shared/index.js';

export class BrokerError extends Error {
  readonly venue: string;
  readonly operation: string;
  readonly statusCode: number | undefined;
  readonly venueCode: string | undefined;
  readonly venueMessage: string | undefined;

  constructor(
    venue: string,
    operation: string,
    statusCode: number | undefined,
    venueCode: string | undefined,
    venueMessage: string | undefined,
  ) {
    super(
      `${venue} ${operation} failed (status ${statusCode ?? 'unknown'}` +
        `${venueCode === undefined ? '' : `, code ${venueCode}`})` +
        `${venueMessage === undefined ? '' : `: ${venueMessage}`}`,
    );
    this.name = 'BrokerError';
    this.venue = venue;
    this.operation = operation;
    this.statusCode = statusCode;
    this.venueCode = venueCode;
    this.venueMessage = venueMessage;
  }
}

export function sanitizeBrokerError(venue: string, operation: string, cause: unknown): BrokerError {
  return new BrokerError(
    venue,
    operation,
    readStatusCode(cause),
    readVenueCode(cause),
    readVenueMessage(cause),
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function readStatusCode(cause: unknown): number | undefined {
  const record = asRecord(cause);
  if (record === undefined) return undefined;

  for (const candidate of [record.status, record.statusCode, asRecord(record.response)?.status]) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
  }
  return undefined;
}

function readVenueCode(cause: unknown): string | undefined {
  const code = asRecord(cause)?.code;
  if (typeof code === 'string' && code.length > 0) return code;
  if (typeof code === 'number' && Number.isFinite(code)) return String(code);
  return undefined;
}

const MAX_VENUE_MESSAGE_CHARS = MAX_ERROR_BODY_CHARS + 100;

const LAST_C0_CONTROL_CODE = 31;
const DEL_CODE = 127;

function stripControlChars(text: string): string {
  let result = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code > LAST_C0_CONTROL_CODE && code !== DEL_CODE) result += char;
  }
  return result;
}

function readVenueMessage(cause: unknown): string | undefined {
  const raw = asRecord(cause)?.venueMessage;
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  const venueMessage = stripControlChars(raw);
  if (venueMessage.length === 0) return undefined;
  return venueMessage.length > MAX_VENUE_MESSAGE_CHARS
    ? `${venueMessage.slice(0, MAX_VENUE_MESSAGE_CHARS)}… (truncated, ${venueMessage.length} chars total)`
    : venueMessage;
}
