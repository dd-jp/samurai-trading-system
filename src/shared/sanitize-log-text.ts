/**
 * Masks credential-carrying syntaxes out of upstream-controlled text before it
 * is logged, then caps its length.
 *
 * Extracted from `orchestrator/production/analysts-adapter.ts` (PR #360
 * review) when a second caller appeared — the debate adapter's
 * failed-debate line (#364), which logs an `LlmClient` error whose message
 * can carry the provider's raw response body
 * (`shared/llm/nous-chat.ts`'s `buildApiError`). Two adapters
 * hand-rolling the same pattern list is how one of them silently stops
 * matching a new credential shape.
 *
 * Deliberately narrow. Only well-known credential SYNTAXES are masked
 * (`bot<digits>:<token>`, `Bearer <token>`, `key/secret/token/password/auth =
 * <value>`), never anything that merely looks random. Over-masking would put
 * us back where #358 started — a failure whose stated cause says nothing — so
 * a real failure like `computeIndicator: sma(14) needs 14 bars but received
 * 13` must pass through verbatim, and a test pins exactly that.
 */
import { truncateForError } from './http/response-errors.js';

/**
 * Credential-carrying syntaxes, masked value-only so the surrounding message
 * still reads. Kept to shapes that are unambiguously a secret being assigned —
 * a bare high-entropy string is NOT matched, because legitimate failure reasons
 * are full of ids, hashes and ISO timestamps.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  // Telegram bot token in a URL path: `/bot123456:AA...`
  /\bbot\d{4,}:[A-Za-z0-9_-]+/gi,
  // A bare Telegram-shaped token: long digit run, colon, long opaque suffix.
  /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g,
  // `Bearer <token>`
  /\bBearer\s+[^\s,;"'}\]]+/gi,
  // `apiKey=x`, `"api_secret": "x"`, `token: x`, `password=x`, `auth: x`, and
  // Alpaca's own header names.
  /\b(?:APCA-API-KEY-ID|APCA-API-SECRET-KEY|api[_-]?key|api[_-]?secret|secret|token|password|passwd|pwd|auth)\b["']?\s*[:=]\s*["']?[^\s,;"'}\]]+/gi,
];

/** Masks known credential syntaxes, then caps length — mask first, so truncation cannot bisect a token and leave half of it. */
export function sanitizeLogText(text: string): string {
  let masked = text;
  for (const pattern of CREDENTIAL_PATTERNS) {
    masked = masked.replace(pattern, '[REDACTED]');
  }
  return truncateForError(masked);
}
