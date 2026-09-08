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
 * Every quote, every backslash, and every `}` inside a character class,
 * below is a hex escape (`\x22`, `\x27`, `\x5c`, `\x7d`), never literal:
 * `server/apps/orchestrator/production.test.ts`'s `stripCommentsAndStrings
 * leaves braces balanced on every server source file it strips` fails on a
 * literal one — its hand-rolled stripper can't tell a regex literal from a
 * string, so a literal quote misreads as a string opener and swallows
 * everything up to its accidental "close", `}` characters included. The `}`
 * in a quantifier (`{0,60}`, `{20,}`, …) is exempt: it pairs with its own
 * `{` and never desyncs the stripper's brace count.
 *
 * A credential inside a JSON string that itself contains serialized JSON
 * arrives with its quotes backslash-escaped (`\"api_key\":\"skFAKE0000\"`).
 * Every key-to-value separator below admits ONE optional literal backslash
 * immediately before each quote — `(?:\x5c?[\x22\x27])?`, the backslash
 * inside the SAME optional group as its quote, never a bare `\x5c?` ahead
 * of an independently-optional quote (a lone backslash with no quote
 * following — a Windows path fragment after `token:` — must not read as
 * separator noise). Every value class stops one character before a
 * backslash THAT IS ITSELF immediately followed by a quote —
 * `(?:(?!\x5c[\x22\x27])[^…])+` — the shape an escaped-JSON credential's
 * own closing quote produces, rather than excluding `\x5c` outright: a
 * value containing an ordinary literal backslash NOT immediately followed
 * by a quote (a Windows path, a DSN password, a token body) is still
 * consumed and masked in full, matching main. Exception: a value consisting
 * of ONLY that `\"` boundary and nothing else (`api_key=\"`) fails to match
 * at all, since the value class requires at least one consumed character —
 * a degenerate empty-value case, never a real credential byte.
 *
 * Not reached, deliberately: a TWICE-escaped credential (`\\\"api_key\\\"`
 * — a JSON string containing a JSON string containing a JSON string),
 * since only one optional backslash is admitted per quote on the separator
 * side (the lookahead governs the value side only). Measured, not
 * inferred: `maskCredentials` on
 * `{"outer":"{\\\"api_key\\\":\\\"skFAKE0000\\\"}"}` returns it unchanged.
 *
 * Cost this DOES introduce, priced rather than hidden: the separator change
 * above means a widened set of escaped keys now matches — an escaped
 * benign field this module would leave alone unescaped (`{\"auth\":\"none
 * \"}"`, `{\"token\":\"MTY4OTAwMA\"}"`) now gets masked too, symmetric with
 * how main already treats those same field names unescaped. Reachable in
 * principle: `renderMessageContent` (anthropic-client.ts) serializes an
 * open `debate_state` record into the rendered prompt, so an arbitrary
 * field name chosen upstream can land in escaped form there. Accepted for
 * the same reason the bareword pattern's own doc comment (below) accepts
 * masking `"keyword"`-adjacent text: a masked benign field is a cosmetic
 * loss, not a leaked credential, and this module's stated non-goal is only
 * "never leak a real credential shape", not "never mask a false positive".
 *
 * The DSN pattern (below) carries neither change: its value class already
 * excludes quotes outright, so a literal backslash immediately before a
 * quote can never be part of a matched value regardless of a lookahead,
 * and its lookbehind is URL syntax (`://`, `@`), not a `[:=]` key-to-value
 * separator to widen. It reaches an escaped-JSON DSN unmodified from main.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  // Telegram bot token in a URL path: `/bot123456:AA...`
  /\bbot\d{4,}:[A-Za-z0-9_-]+/gi,
  // A bare Telegram-shaped token: long digit run, colon, long opaque suffix.
  /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g,
  // `Bearer <token>`. Value class's negative-lookahead terminator: see the
  // module doc comment above.
  /\bBearer\s+(?:(?!\x5c[\x22\x27])[^\s,;\x22\x27\x7d\]])+/gi,
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
  // The cost of that exclusion: a credential value that itself legitimately
  // contains `&` (`{"password":"p&ssw0rd"}`) is only masked up to the `&`,
  // leaking its tail (`{"[REDACTED]&ssw0rd"...}`) — accepted because a
  // query string is the far more common shape this module sees in
  // practice, and a partially-masked credential is still a shorter,
  // less-recoverable leak than the un-truncated version.
  // Separator and value-class treatment: see the module doc comment above.
  /\b(?:APCA-API-KEY-ID|APCA-API-SECRET-KEY|api[_-]?key|api[_-]?secret|secret|token|password|passwd|pwd|auth)\b(?:\x5c?[\x22\x27])?[ \t]*[:=][ \t]*(?:\x5c?[\x22\x27])?(?:(?!\x5c[\x22\x27])[^\s,;&\x22\x27\x7d\]])+/gi,
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
  // Separator and value-class treatment: see the module doc comment above.
  /(?<![A-Za-z0-9])(?:client[_-]?secret|access[_-]?token|refresh[_-]?token)(?:\x5c?[\x22\x27])?[ \t]*[:=][ \t]*(?:\x5c?[\x22\x27])?(?:(?!\x5c[\x22\x27])[^\s,;&\x22\x27\x7d\]])+/gi,
  // Underscore-joined ALL-CAPS env-var names (`ALPACA_API_SECRET`,
  // `SAXO_OPENAPI_TOKEN`, `TELEGRAM_BOT_TOKEN` — grepped from this repo's
  // real `process.env.*` reads, not just the one Alpaca name; `DB_PASSWORD`
  // is illustrative of the `_PASSWORD` suffix, not a name in this repo's
  // own `process.env.*` reads): the shape the bareword pattern above can't
  // reach even with `api[_-]?key`/`secret`/`token`/`password` in it, because
  // the credential word isn't the LAST segment. Case-SENSITIVE (no `i` flag) and requires
  // an all-caps prefix — this buys avoiding a mask on the LOWERCASE spelling
  // of a real field this codebase logs, `next_page_token` (a pagination
  // cursor); it does NOT avoid masking `NEXT_PAGE_TOKEN` — an all-caps
  // spelling of that same field would still match, because this input is
  // upstream-controlled text (see this module's doc comment), not a JSON
  // field name whose case this codebase controls. The lowercase-anchored
  // pattern below closes part of that gap for real credential shapes,
  // deliberately without reintroducing the `next_page_token` regression.
  // Separator and value-class treatment: see the module doc comment above.
  /\b[A-Z][A-Z0-9_]{0,60}_(?:SECRET_KEY|API_KEY|SECRET|TOKEN|PASSWORD|PASSWD)\b(?:\x5c?[\x22\x27])?[ \t]*[:=][ \t]*(?:\x5c?[\x22\x27])?(?:(?!\x5c[\x22\x27])[^\s,;&\x22\x27\x7d\]])+/g,
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
  // without the case signal. The gap is wider than just `_token`, though:
  // this pattern is anchored `[a-z][a-z0-9_]{0,60}` with no `i` flag, so
  // ANY mixed-case spelling of the three covered suffixes also falls
  // through both patterns (`Alpaca_Api_Key`, `my_API_KEY`,
  // `Polygon_Api_Secret` — all measured unmasked) — only all-lowercase and
  // all-caps are covered, the two shapes this codebase's own env-var
  // reads and pagination cursors actually use.
  // Separator and value-class treatment: see the module doc comment above.
  /\b[a-z][a-z0-9_]{0,60}_(?:secret_key|api_key|api_secret)\b(?:\x5c?[\x22\x27])?[ \t]*[:=][ \t]*(?:\x5c?[\x22\x27])?(?:(?!\x5c[\x22\x27])[^\s,;&\x22\x27\x7d\]])+/g,
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
  // still lose its first word to this pattern. The `Bearer <token>`
  // pattern above (line 44) has the identical scheme-to-value `\s+` and is
  // equally untouched, for the same out-of-scope reason: `Bearer` has no
  // key-to-value separator to begin with — the word itself is the anchor
  // — so neither F7 nor F8 named it, and it shares this pattern's newline
  // and `&` gaps unchanged.
  // Separator and value-class treatment: see the module doc comment above.
  /(?<=\bAuthorization(?:\x5c?[\x22\x27])?[ \t]*[:=][ \t]*(?:\x5c?[\x22\x27])?)(?:Basic|Token)\s+(?:(?!\x5c[\x22\x27])[^\s,;&\x22\x27\x7d\]])+/gi,
  // `scheme://user:PASSWORD@host` DSNs: matches only the password segment
  // (via look-around), so the scheme, username and host — the parts an
  // operator actually needs to identify which DB a connection error came
  // from — survive in the output. Username is `{0,100}` (not `{1,100}`) so
  // a password-only DSN (`redis://:pw@host`) still matches. The value class
  // excludes quotes, `,` and `;` on top of `@`/`/` — without that, a DSN
  // sitting next to other JSON fields (`{"dsn":"redis://h:6379","email":
  // "a@b.com"}`) over-matches through the closing quote and the next key,
  // deleting the port and merging into the following field's `@`. See the
  // module doc comment above for why this pattern's value class is
  // unmodified from main.
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
