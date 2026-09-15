/**
 * Credential-safe broker error wrapper.
 *
 * Every broker client this repo injects (Alpaca's REST client, Saxo's OpenAPI
 * client) builds its errors from the failed HTTP exchange — and
 * that exchange carries the API key, in a header, a signed URL or the request
 * body it echoes back. Those errors currently travel unmodified out of an
 * adapter and into `execute()`, which copies `error.message` into
 * `ExecutionResult.reason`, which is logged and rendered on the dashboard. One
 * throttled order is enough to write a trading key into a log file.
 *
 * The fix is a hard boundary, not redaction: an adapter converts whatever the
 * client threw into a `BrokerError` built ONLY from fields this module chose,
 * and the original is dropped on the floor. There is deliberately no `cause`,
 * no `raw`, no audit field — a curated wrapper that still carries the raw
 * error just moves the credential from the message into whatever reads
 * `cause`, and "we only log the curated part" is a promise no future caller is
 * bound by. What is not retained cannot leak.
 *
 * The cost is real and accepted: debugging a venue failure means reading the
 * venue's own dashboard, unless the client's own error class exposes a
 * further curated, allowlisted field — `venueCode` (#953) and `venueMessage`
 * (#1003) are the two this module currently knows how to read. Both are
 * duck-typed off dedicated, non-standard property names (never off `.message`
 * or `.code`'s siblings on the raw `Error` prototype), so a client that has
 * not been taught to expose one degrades silently to "unknown" rather than
 * leaking whatever its own `.message` happened to contain.
 *
 * `venueMessage` is where this boundary's guarantee narrows from
 * architectural to empirical: it is free text the venue controls, allowlisted
 * to a single JSON string field but not otherwise validated. `readVenueMessage`
 * strips ASCII control characters (escape sequences, embedded newlines that
 * could forge a second log line) before this text reaches `BrokerError.message`
 * or `.venueMessage` — both durable (audit_log) and both forwarded to alert
 * transports (`flatten-reconcile-alert.ts`). That the *content* itself carries
 * no credentials is verified once, empirically, against Alpaca's current error
 * shape (#1003); it is not guaranteed by this module's own design the way the
 * exclusion of `cause`/`.message` is, and must be re-verified if Alpaca's
 * error shape changes or a new venue's `venueMessage` is wired up.
 */

import { MAX_ERROR_BODY_CHARS } from '../../shared/index.js';

export class BrokerError extends Error {
  /** Which adapter failed — 'alpaca' | 'saxo' */
  readonly venue: string;
  /** Which adapter operation failed, e.g. 'submitBracket', 'fetchNewFills'. */
  readonly operation: string;
  /** HTTP status, when the client exposed one on a recognized shape */
  readonly statusCode: number | undefined;
  /** The venue's own error code, when the client exposed one */
  readonly venueCode: string | undefined;
  /**
   * The venue's own diagnostic message text (#1003), when the client exposed
   * one on the dedicated `venueMessage` property — e.g. Alpaca's
   * `AlpacaBrokerProviderError.venueMessage`, itself the allowlisted `message`
   * field of a parsed `{code, message}` error body (`readErrorBody`,
   * shared/http/response-errors.ts). Never the client's own `.message`: that
   * field is exactly the credential-carrying text this module's whole
   * boundary exists to keep out (see the module doc's H1 history).
   */
  readonly venueMessage: string | undefined;

  constructor(
    venue: string,
    operation: string,
    statusCode: number | undefined,
    venueCode: string | undefined,
    venueMessage: string | undefined,
  ) {
    // The message is composed from the curated fields alone. Interpolating any
    // part of the original — even a "safe-looking" prefix — is what reopens
    // the leak, since the client chooses that text, not us
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

/**
 * Converts anything a broker client threw into a `BrokerError`, keeping only
 * a status code, a venue error code and a venue diagnostic message.
 *
 * Duck-typed across the shapes the three clients actually use (`status`,
 * `statusCode`, `response.status`, `code`, `venueMessage`) rather than tied to
 * any client's error classes — those are third-party types this repo
 * deliberately does not depend on, and a client that changes its hierarchy
 * must degrade to "unknown status" rather than crash the adapter.
 *
 * `cause` is read and discarded. It is never returned, attached or re-thrown.
 */
export function sanitizeBrokerError(venue: string, operation: string, cause: unknown): BrokerError {
  return new BrokerError(
    venue,
    operation,
    readStatusCode(cause),
    readVenueCode(cause),
    readVenueMessage(cause),
  );
}

/** Any object; `unknown` prop reads are type-guarded at each use site */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function readStatusCode(cause: unknown): number | undefined {
  const record = asRecord(cause);
  if (record === undefined) return undefined;

  for (const candidate of [record.status, record.statusCode, asRecord(record.response)?.status]) {
    // Finite-number guard, not just `typeof`: a client that reports `NaN` for
    // a transport failure must read as "unknown", not as a status
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
  }
  return undefined;
}

/**
 * `code` is stringified because clients disagree on its type (ccxt throws
 * string codes, Node's fetch layer surfaces numeric `errno`-style ones), and
 * the field is only ever displayed
 */
function readVenueCode(cause: unknown): string | undefined {
  const code = asRecord(cause)?.code;
  if (typeof code === 'string' && code.length > 0) return code;
  if (typeof code === 'number' && Number.isFinite(code)) return String(code);
  return undefined;
}

/**
 * Set comfortably above `MAX_ERROR_BODY_CHARS` (shared/http/response-errors.ts),
 * not equal to it — this is defense-in-depth on top of `readErrorBody`'s own
 * `truncateForError` call, not a duplicate of its bound. A `venueMessage`
 * that already passed through that upstream truncation arrives here still
 * carrying its own "… (truncated, N chars total)" suffix, ~30-40 chars past
 * `MAX_ERROR_BODY_CHARS`. A cap at or below `MAX_ERROR_BODY_CHARS` re-slices
 * that string mid-suffix, producing a garbled nested truncation marker that
 * also misreports the original length. The +100 margin covers that suffix
 * (and its length digits) for any realistic body size.
 */
const MAX_VENUE_MESSAGE_CHARS = MAX_ERROR_BODY_CHARS + 100;

/**
 * ASCII control characters (0x00-0x1F, 0x7F) — terminal/log-viewer escape
 * sequences, embedded newlines that could forge a second log line — stripped
 * from venue-controlled free text before it reaches anything durable. This
 * text is a single log/alert line; a venue's `message` string does not get
 * to inject line breaks or escape sequences into it.
 */
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

/**
 * Reads a dedicated `venueMessage` property (#1003) — deliberately NOT
 * `cause.message`, which is exactly the field this whole module exists to
 * keep out of anything durable. Only a client that has been taught to expose
 * a curated, allowlisted `venueMessage` (currently `AlpacaBrokerProviderError`
 * alone, via `readErrorBody`'s parsed-and-bounded `message` field) surfaces
 * anything here; every other cause — a bare `Error`, a ccxt/IBKR error with
 * no such property — degrades to `undefined`.
 *
 * Control characters are stripped first (see `stripControlChars`), then the
 * result is bounded again on top of `readErrorBody`'s own truncation, as
 * defense-in-depth: this function's contract is "safe to persist", and that
 * contract must hold even if a future caller populates `venueMessage` from
 * somewhere that skipped the upstream bound. A message that strips down to
 * nothing degrades to `undefined`, same as an originally-empty one.
 */
function readVenueMessage(cause: unknown): string | undefined {
  const raw = asRecord(cause)?.venueMessage;
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  const venueMessage = stripControlChars(raw);
  if (venueMessage.length === 0) return undefined;
  return venueMessage.length > MAX_VENUE_MESSAGE_CHARS
    ? `${venueMessage.slice(0, MAX_VENUE_MESSAGE_CHARS)}… (truncated, ${venueMessage.length} chars total)`
    : venueMessage;
}
