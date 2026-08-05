/**
 * Production Composition Root: Analysts adapter (ticket #235). See
 * ADR-0004 §3, docs/specs/orchestrator-spec.md ("Module: Production
 * Composition Root"), closed wayfinder map #224.
 *
 * `AnalystOrchestrator.runAnalysts(trace_id, signal, clock)` takes three
 * positional arguments and returns `AnalystRunResult` (`{ views,
 * analyst_count, skipped, failures }`); `TickSteps.analysts` takes one object
 * (`{ trace_id, signal, clock }`) and returns bare `AnalystView[]`. This
 * adapter only narrows the call/return shape — it does not change
 * `AnalystOrchestrator`'s applicability filtering or quorum logic (#235 AC).
 * An empty view array is exactly `runAnalysts`'s `skipped` case, preserving
 * the existing quorum-skip contract `SequentialTickRunner` short-circuits on.
 *
 * **Failures are logged here (issue #358 item 4).** Narrowing to `views` used
 * to drop `failures` on the floor, and that drop is why a total market-data
 * outage — every crypto request 404ing against a wrong API version — looked
 * like a quiet decision for a whole paper run. `SequentialTickRunner` sees only
 * the view array, so it logs `analysts: quorum_skip` at `info` with an empty
 * payload; the only place the reasons still exist is right here, between
 * `runAnalysts` returning and the narrowing throwing them away. So this is
 * where they get emitted, on the same `trace_id` the tick's own lines carry.
 *
 * Level splits on `role`, because the two cases are operationally different:
 * a mandatory persona failing HALTED trading for this instrument (`error`); an
 * optional one failing only shrank the debate panel and the tick continued
 * (`warn`). Both are logged even though only the first is a skip — an optional
 * analyst that has been failing silently for a week is worth seeing too.
 *
 * **`failure.reason` is upstream-controlled, so it is bounded and masked**
 * (PR #360 review). It is not a string this repo authors end to end:
 * `classifyAlpacaDataResponse` bakes the provider's response BODY into the
 * message, and `classifyAlpacaDataNetworkError` bakes an arbitrary
 * `error.message` in with no cap at all. No live path can put a credential
 * there today — Alpaca authenticates by header, never by URL, and the one
 * credential this system carries *in* a URL (the Telegram bot token,
 * `/bot<token>/<method>`) is unreachable from an analyst, which depends only on
 * `MarketDataService` and the in-memory `MarketIntelligenceStore`. But a log
 * line should not silently depend on that remaining true through the next
 * refactor, and bounding costs nothing operationally: the operator needs WHICH
 * analyst failed and WHY in short form, and both survive.
 *
 * Deliberately narrow. `sanitizeFailureReason` masks only well-known
 * credential-carrying SYNTAXES (`bot<digits>:<token>`, `Bearer <token>`,
 * `key/secret/token/password/auth = <value>`), never anything that merely looks
 * random. Over-masking would put us back where this ticket started — a quorum
 * skip whose stated cause says nothing — so a real failure like
 * `computeIndicator: sma(14) needs 14 bars but received 13` must pass through
 * verbatim, and a test pins exactly that.
 */
import type { AnalystFailure, AnalystOrchestrator } from '../../analysts/index.js';
import { type Logger, truncateForError } from '../../shared/index.js';
import type { TickSteps } from '../types.js';

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
function sanitizeFailureReason(reason: string): string {
  let masked = reason;
  for (const pattern of CREDENTIAL_PATTERNS) {
    masked = masked.replace(pattern, '[REDACTED]');
  }
  return truncateForError(masked);
}

export function buildAnalystsStep(
  orchestrator: AnalystOrchestrator,
  logger?: Logger,
): TickSteps['analysts'] {
  return async ({ trace_id, signal, clock }) => {
    const result = await orchestrator.runAnalysts(trace_id, signal, clock);

    if (logger !== undefined && result.failures.length > 0) {
      const mandatoryFailed = result.failures.some((failure) => failure.role === 'mandatory');
      // Sanitized once, used for both the message and the payload — the raw
      // `result.failures` array is never logged wholesale.
      const safe = result.failures.map((failure: AnalystFailure) => ({
        analyst_type: failure.analyst_type,
        role: failure.role,
        reason: sanitizeFailureReason(failure.reason),
      }));
      const detail = safe
        .map((failure) => `${failure.analyst_type} (${failure.role}): ${failure.reason}`)
        .join('; ');
      logger.log({
        trace_id,
        stage: 'analysts',
        level: mandatoryFailed ? 'error' : 'warn',
        message: mandatoryFailed
          ? `analysts: ${signal.asset} quorum NOT met — mandatory analyst failed, no trade is ` +
            `possible this tick: ${detail}`
          : `analysts: ${signal.asset} optional analyst failed, tick continues on a smaller ` +
            `panel: ${detail}`,
        payload: { instrument: signal.asset, failures: safe },
      });
    }

    return result.views;
  };
}
