/**
 * Broker-error sanitization (code-review 2026-08-01, H1). ccxt, Alpaca REST
 * and IBKR TWS error objects routinely embed the raw HTTP request — URL,
 * query string, auth headers, sometimes the signed body — in their message.
 * `execute()`/`reconcile()` surface `error.message` into
 * `ExecutionResult.reason`, which flows onward to audit_log, the dashboard
 * and notification channels, so anything credential-shaped must die here at
 * the adapter boundary. The raw error object itself never leaves the caller's
 * scope — only this sanitized string does.
 */

/** Header/param names that carry credentials across our three venues. */
const CREDENTIAL_FIELD =
  /\b(authorization|api[-_]?key|apca[-_]api[-_][a-z-]+|secret[-_ ]?key|access[-_ ]?token|token|signature|passphrase|nonce)\b\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/gi;

/**
 * Long unbroken base64/hex-ish runs — the shape of every API key/secret/HMAC
 * the venues issue. Idempotency keys are also hashes and get caught too;
 * that is accepted collateral, since the key travels separately on
 * `ExecutionResult.idempotency_key`.
 */
const TOKEN_BLOB =
  /\b(?=[A-Za-z0-9+/=_-]*[A-Za-z])(?=[A-Za-z0-9+/=_-]*[0-9])[A-Za-z0-9+/=_-]{20,}\b/g;

/** Query strings can carry signed params; nothing downstream needs them. */
const QUERY_STRING = /\?[^\s"']+/g;

const MAX_REASON_LENGTH = 300;

/**
 * A surfaceable one-line description of a broker error: name + message with
 * credential-shaped content masked and the whole string length-capped.
 */
export function describeBrokerError(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);

  const masked = raw
    .replace(CREDENTIAL_FIELD, '$1=[REDACTED]')
    .replace(QUERY_STRING, '?[REDACTED]')
    .replace(TOKEN_BLOB, '[REDACTED]');

  return masked.length > MAX_REASON_LENGTH ? `${masked.slice(0, MAX_REASON_LENGTH)}…` : masked;
}
