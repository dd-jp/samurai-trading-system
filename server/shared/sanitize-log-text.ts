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
 * Every quote, and every `}` inside a character class, below is a hex escape
 * (`\x22`, `\x27`, `\x7d`), never literal:
 * `server/apps/orchestrator/production.test.ts`'s `stripCommentsAndStrings
 * leaves braces balanced on every server source file it strips` fails on a
 * literal one — its hand-rolled stripper can't tell a regex literal from a
 * string, so a literal quote misreads as a string opener and swallows
 * everything up to its accidental "close", `}` characters included. The `}`
 * in a quantifier (`{0,60}`, `{20,}`, …) is exempt: it pairs with its own
 * `{` and never desyncs the stripper's brace count.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  // Telegram bot token in a URL path: `/bot123456:AA...`
  /\bbot\d{4,}:[A-Za-z0-9_-]+/gi,
  // A bare Telegram-shaped token: long digit run, colon, long opaque suffix.
  /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g,
  // `Bearer <token>`
  /\bBearer\s+[^\s,;\x22\x27\x7d\]]+/gi,
  // `apiKey=x`, `api_secret: x`, `token: x`, `password=x`, `auth: x`, and
  // Alpaca's own header names. `[ \t]*` (not `\s*`) around the operator:
  // `\s` admits a newline, so `token:\n<stack trace line>` would consume the
  // newline and then greedily eat the first word of the following line as
  // the "value" — a real shape (a caught error's `message` embeds a stack
  // trace) that has nothing to do with credentials. The value class already
  // excludes `\s`, so this only tightens the key-to-value separator, not
  // what counts as a value. `&` is excluded from the value class for the
  // same reason a query-string credential shouldn't swallow its own
  // trailing params (`?apiKey=x&adjusted=true` must keep `&adjusted=true`).
  /\b(?:APCA-API-KEY-ID|APCA-API-SECRET-KEY|api[_-]?key|api[_-]?secret|secret|token|password|passwd|pwd|auth)\b[\x22\x27]?[ \t]*[:=][ \t]*[\x22\x27]?[^\s,;&\x22\x27\x7d\]]+/gi,
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
  // suffix rule would mask both. `[ \t]*`/`&` reasoning: see the bareword
  // pattern above.
  /(?<![A-Za-z0-9])(?:client[_-]?secret|access[_-]?token|refresh[_-]?token)[\x22\x27]?[ \t]*[:=][ \t]*[\x22\x27]?[^\s,;&\x22\x27\x7d\]]+/gi,
  // Underscore-joined ALL-CAPS env-var names (`ALPACA_API_SECRET`,
  // `SAXO_OPENAPI_TOKEN`, `TELEGRAM_BOT_TOKEN`, `DB_PASSWORD` — grepped from
  // this repo's real `process.env.*` reads, not just the one Alpaca name):
  // the shape the bareword pattern above can't reach even with
  // `api[_-]?key`/`secret`/`token`/`password` in it, because the credential
  // word isn't the LAST segment. Case-SENSITIVE (no `i` flag) and requires
  // an all-caps prefix — this buys avoiding a mask on the LOWERCASE spelling
  // of a real field this codebase logs, `next_page_token` (a pagination
  // cursor); it does NOT avoid masking `NEXT_PAGE_TOKEN` — an all-caps
  // spelling of that same field would still match, because this input is
  // upstream-controlled text (see this module's doc comment), not a JSON
  // field name whose case this codebase controls. The lowercase-anchored
  // pattern below closes part of that gap for real credential shapes,
  // deliberately without reintroducing the `next_page_token` regression.
  /\b[A-Z][A-Z0-9_]{0,60}_(?:SECRET_KEY|API_KEY|SECRET|TOKEN|PASSWORD|PASSWD)\b[\x22\x27]?[ \t]*[:=][ \t]*[\x22\x27]?[^\s,;&\x22\x27\x7d\]]+/g,
  // The lowercase/mixed-case counterpart to the all-caps pattern above, for
  // exactly three suffixes: `_secret_key`, `_api_key`, `_api_secret`
  // (`polygon_api_key`, `alpaca_api_secret_key`, `apca_api_secret_key`,
  // `api_secret_key`, `alpaca_api_secret` — all real shapes measured
  // unmasked before this pattern existed). Deliberately NOT a bare
  // `_secret` or `_token` suffix here: that would re-catch
  // `next_page_token`/`page_token`, the exact regression the all-caps-only
  // design above exists to avoid. The result is an intentional residual
  // gap: a lowercase or mixed-case name ending only in `_token` (e.g.
  // `saxo_openapi_token`, `Saxo_Openapi_Token`) is still not masked by
  // either pattern — narrower coverage than the all-caps branch, on
  // purpose, because `_token` alone can't tell a credential from a cursor
  // without the case signal.
  /\b[a-z][a-z0-9_]{0,60}_(?:secret_key|api_key|api_secret)\b[\x22\x27]?[ \t]*[:=][ \t]*[\x22\x27]?[^\s,;&\x22\x27\x7d\]]+/g,
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
  // a bare `Authorization:\s*` lookbehind cannot. The lookbehind's own
  // key-to-value separator got the same `[ \t]*`/`&` treatment as the
  // bareword pattern above, for the same reason. The `\s+` AFTER the scheme
  // word (`Basic`/`Token`) is untouched by that fix and still spans a
  // newline — out of scope for round-2's F7, which named the four
  // key-to-value separators, not this scheme-to-value one; a stack trace
  // straight after `Authorization: Basic` (no value on that line) would
  // still lose its first word to this pattern.
  /(?<=\bAuthorization[\x22\x27]?[ \t]*[:=][ \t]*[\x22\x27]?)(?:Basic|Token)\s+[^\s,;&\x22\x27\x7d\]]+/gi,
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
