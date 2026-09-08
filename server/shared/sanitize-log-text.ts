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
 *
 * Quote and `}` chars in every pattern below are hex escapes (`\x22`, `\x27`,
 * `\x7d`), never literal: this repo's `production.test.ts` walks every server
 * source file through a hand-rolled comment/string stripper (no real lexer
 * available post TypeScript v7) that can't tell a regex literal from a
 * string, and separately just counts raw `{`/`}` characters to catch a
 * desync — so a literal quote inside a regex literal misreads as a string
 * opener, and a literal `}` inside a character class (excluding it from a
 * matched value, not delimiting anything) reads as an unmatched brace either
 * way. `KNOWN_STRIPPER_DESYNCS` there routes two known files around the
 * first failure mode; one literal quote already in this array (on the
 * `Bearer` pattern, pre-#1367) was enough to trip it, invisibly, because it
 * also happened to swallow the `}` below into the same misread string. Fixed
 * here by keeping the whole array free of both literal quotes and literal
 * `}`, rather than adding a third routed-around file.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  // Telegram bot token in a URL path: `/bot123456:AA...`
  /\bbot\d{4,}:[A-Za-z0-9_-]+/gi,
  // A bare Telegram-shaped token: long digit run, colon, long opaque suffix.
  /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g,
  // `Bearer <token>`
  /\bBearer\s+[^\s,;\x22\x27\x7d\]]+/gi,
  // `apiKey=x`, `api_secret: x`, `token: x`, `password=x`, `auth: x`, and
  // Alpaca's own header names.
  /\b(?:APCA-API-KEY-ID|APCA-API-SECRET-KEY|api[_-]?key|api[_-]?secret|secret|token|password|passwd|pwd|auth)\b[\x22\x27]?\s*[:=]\s*[\x22\x27]?[^\s,;\x22\x27\x7d\]]+/gi,
  // `clientSecret`/`client_secret`, `accessToken`/`access_token`,
  // `refreshToken`/`refresh_token`: the bareword pattern above requires a
  // `\b` before the credential word, which a camelCase or underscore join
  // never produces (`accessToken`'s "Token" sits mid-word, not at a
  // boundary). Named explicitly rather than as a `*Token`/`*Key` suffix
  // rule: this codebase logs `pageToken`/`next_page_token` (pagination
  // cursors, `alpaca-http-client.ts`) and `maxTokens`/`max_tokens` (an LLM
  // request budget, `spend-sink.ts`) — a suffix rule would mask both.
  /\b(?:client[_-]?secret|access[_-]?token|refresh[_-]?token)[\x22\x27]?\s*[:=]\s*[\x22\x27]?[^\s,;\x22\x27\x7d\]]+/gi,
  // `*_SECRET_KEY` / `*_API_KEY` env-var names (`APCA_API_SECRET_KEY`):
  // underscore-joined uppercase is the one shape the bareword pattern above
  // can't reach even with `api[_-]?key` in it, because the credential word
  // isn't the LAST segment.
  /\b[A-Za-z][A-Za-z0-9_]*_(?:SECRET_KEY|API_KEY)\b[\x22\x27]?\s*[:=]\s*[\x22\x27]?[^\s,;\x22\x27\x7d\]]+/gi,
  // `Authorization: Basic <base64>`. Anchored to a preceding `Authorization:`
  // (via lookbehind, so it's not consumed and stays in the output) rather
  // than matching bare `Basic <word>` the way the Bearer pattern matches
  // bare `Bearer <word>` — "Basic" alone is ordinary English in this repo's
  // own comments (Alpaca's Basic free-tier subscription), so an unanchored
  // version would mask prose, not credentials.
  /(?<=\bAuthorization:\s*)Basic\s+[^\s,;\x22\x27\x7d\]]+/gi,
  // `scheme://user:PASSWORD@host` DSNs: matches only the password segment
  // (via look-around), so the scheme, username and host — the parts an
  // operator actually needs to identify which DB a connection error came
  // from — survive in the output.
  /(?<=:\/\/[^\s:@/]{1,100}:)[^\s@/]{1,200}(?=@)/g,
];

/**
 * Masks known credential syntaxes and does NOT cap length.
 *
 * Split out of `sanitizeLogText` (#1035) because that function's cap is
 * `MAX_ERROR_BODY_CHARS` — 500 chars, sized for an HTTP error body — and the
 * LLM capture path masks a ~6.8 KB rendered prompt that a 500-char cap would
 * destroy. Masking and capping are two decisions with two different right
 * answers per caller, so the caller now picks the cap and never the masking:
 * every path through this module masks with the same pattern list, which is
 * the property the module exists to guarantee.
 *
 * Callers that cap MUST mask first, for the reason `sanitizeLogText` has
 * always given: truncating first can bisect a token and leave half of it.
 */
export function maskCredentials(text: string): string {
  let masked = text;
  for (const pattern of CREDENTIAL_PATTERNS) {
    masked = masked.replace(pattern, '[REDACTED]');
  }
  return masked;
}

/** Masks known credential syntaxes, then caps length — mask first, so truncation cannot bisect a token and leave half of it. */
export function sanitizeLogText(text: string): string {
  return truncateForError(maskCredentials(text));
}

/**
 * Masks, then caps at a caller-chosen bound — the LLM capture path's entry
 * point (#1035), where the bound is sized off the prompt and response shapes
 * rather than off an HTTP error body.
 *
 * The suffix matches `truncateForError`'s exactly, so a truncated capture
 * reads the same as every other truncated string in the logs and is never
 * mistaken for a short prompt.
 */
export function maskAndCap(text: string, maxChars: number): string {
  const masked = maskCredentials(text);
  return masked.length > maxChars
    ? `${masked.slice(0, maxChars)}… (truncated, ${masked.length} chars total)`
    : masked;
}
