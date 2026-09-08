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
 * Every quote and `}` below is a hex escape (`\x22`, `\x27`, `\x7d`), never
 * literal: `server/apps/orchestrator/production.test.ts`'s
 * `stripCommentsAndStrings leaves braces balanced on every server source
 * file it strips` fails on a literal one — its hand-rolled stripper can't
 * tell a regex literal from a string, so a literal quote misreads as a
 * string opener and swallows everything up to its accidental "close",
 * `}` characters included.
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
  // `refreshToken`/`refresh_token`, and an underscore-PREFIXED compound
  // (`X_CLIENT_SECRET`): the bareword pattern above requires a `\b` before
  // the credential word, which a camelCase or underscore join never
  // produces (`accessToken`'s "Token" sits mid-word; `_` is a word char, so
  // `X_CLIENT_SECRET` has no boundary before "CLIENT" either) — the
  // lookbehind here excludes only alnum, not `\b`, so a leading `_`
  // doesn't block the match the way it would with `\b`. Named explicitly
  // rather than as a `*Token`/`*Key` suffix rule: this codebase logs
  // `pageToken`/`next_page_token` (pagination cursors,
  // `alpaca-http-client.ts`) and `maxTokens`/`max_tokens` (an LLM request
  // budget — `max_tokens` in `orchestrator/production/defaults.ts`,
  // `maxTokens` in `market-intelligence/grok/x-search-client.ts`) — a
  // suffix rule would mask both.
  /(?<![A-Za-z0-9])(?:client[_-]?secret|access[_-]?token|refresh[_-]?token)[\x22\x27]?\s*[:=]\s*[\x22\x27]?[^\s,;\x22\x27\x7d\]]+/gi,
  // Underscore-joined ALL-CAPS env-var names (`ALPACA_API_SECRET`,
  // `SAXO_OPENAPI_TOKEN`, `TELEGRAM_BOT_TOKEN` — grepped from this repo's
  // real `process.env.*` reads, not just the one Alpaca name): the shape
  // the bareword pattern above can't reach even with `api[_-]?key`/
  // `secret`/`token` in it, because the credential word isn't the LAST
  // segment. Case-SENSITIVE (no `i` flag) and requires an all-caps prefix —
  // a case-insensitive version would also mask `next_page_token`
  // (lowercase, a pagination cursor, not a credential) since it too ends
  // in `_token`.
  /\b[A-Z][A-Z0-9_]{0,60}_(?:SECRET_KEY|API_KEY|SECRET|TOKEN)\b[\x22\x27]?\s*[:=]\s*[\x22\x27]?[^\s,;\x22\x27\x7d\]]+/g,
  // `Authorization: Basic <base64>` / `Authorization: Token <key>`
  // (`tools/backtest/http-tiingo-client.ts` sends the latter). Anchored to
  // a preceding `Authorization` key — lookbehind, so it's not consumed and
  // stays in the output — rather than matching either scheme word bare the
  // way the Bearer pattern matches bare `Bearer <word>`: "Basic" alone is
  // ordinary English in this repo's own comments (Alpaca's Basic free-tier
  // subscription), so an unanchored version would mask prose, not
  // credentials. The lookbehind allows an optional quote and `:`/`=` (with
  // optional surrounding space and a trailing quote) between the key and
  // the scheme word, so it reaches the JSON-quoted and single-quoted forms
  // a bare `Authorization:\s*` lookbehind cannot.
  /(?<=\bAuthorization[\x22\x27]?\s*[:=]\s*[\x22\x27]?)(?:Basic|Token)\s+[^\s,;\x22\x27\x7d\]]+/gi,
  // `scheme://user:PASSWORD@host` DSNs: matches only the password segment
  // (via look-around), so the scheme, username and host — the parts an
  // operator actually needs to identify which DB a connection error came
  // from — survive in the output. Username is `{0,100}` (not `{1,100}`) so
  // a password-only DSN (`redis://:pw@host`) still matches. The value class
  // excludes quotes, `,` and `;` on top of `@`/`/` — without that, a DSN
  // sitting next to other JSON fields (`{"dsn":"redis://h:6379","email":
  // "a@b.com"}`) over-matches through the closing quote and the next key,
  // deleting the port and merging into the following field's `@`.
  /(?<=:\/\/[^\s:@/]{0,100}:)[^\s@/\x22\x27,;]{1,200}(?=@)/g,
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
