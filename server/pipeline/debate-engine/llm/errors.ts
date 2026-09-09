/**
 * Typed error hierarchy for `LlmClient` failures (ticket #31, debate-engine-
 * spec.md "LLM Selection & Prompt Engineering" out-of-scope note — this is
 * that implementation detail). Callers (#26 personas, #32 disagreement
 * detection) branch on error *type*, not on parsing provider-specific
 * messages, and `anthropic-client.ts`'s `isRetryable` (closed over the
 * shared `server/shared/http/retry.ts` loop, #271) uses these types to decide
 * what is worth retrying.
 */

export class LlmTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmTimeoutError';
  }
}

export class LlmRateLimitError extends Error {
  /** Provider-supplied hint for how long to wait, if one was given. */
  readonly retryAfterMs: number | undefined;

  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'LlmRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * The raw response didn't match what the caller's `parseResponse` expected
 * (debate-engine-spec.md story 11's semantic detection and the mediator's
 * synthesis both depend on structured output — a prose-only reply is a
 * malformed response for their purposes, not a client bug).
 */
export class LlmMalformedResponseError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`malformed LLM response: ${reason}`);
    this.name = 'LlmMalformedResponseError';
    this.reason = reason;
  }
}

/** Any other upstream failure (auth, bad request, 5xx, network) — not classified further. */
export class LlmProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmProviderError';
  }
}

/**
 * The caller cancelled the call via `LlmRequest.signal` (#347) — the debate's
 * latency budget fired and the in-flight request was aborted.
 *
 * Its own class rather than an `LlmProviderError`, for two reasons that both
 * bite over a 14-day unattended soak (#238):
 *
 *  1. A cancellation is NOT a fault. Folding it into `LlmProviderError` would
 *     make a deliberate act indistinguishable from a real provider failure in
 *     logs, and an operator who sees one per timed-out tick learns to ignore
 *     the class — training away the signal that a genuine LLM outage sends.
 *  2. It must never be retried. `isRetryable` (anthropic-client.ts) covers
 *     only timeout/rate-limit/malformed, so a distinct class is excluded by
 *     construction: retrying a call the caller just cancelled would spend
 *     exactly the money the cancellation exists to save.
 */
export class LlmCancelledError extends Error {
  /**
   * The error the transport actually raised, when the cancellation was
   * detected by inspecting the caller's signal rather than the error itself.
   * Kept because that detection is a race: an abort landing at the same moment
   * as a genuine 429 or 500 would otherwise DISCARD the real failure, and a
   * cost bug is a bad reason to lose the evidence of an unrelated outage.
   */
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'LlmCancelledError';
  }
}

/**
 * The provider DECLINED to answer, and signalled it on the wire (#1391) —
 * Anthropic's `stop_reason: "refusal"`, or the OpenAI-compatible
 * `finish_reason: "content_filter"` / `message.refusal` that `nous-chat.ts`
 * raises as `NousRefusalError` and `NousMessagesClient` translates to this.
 *
 * Its own class for the reason `LlmCancelledError` is: `isRetryable`
 * (anthropic-client.ts) covers only timeout/rate-limit/malformed, so a
 * distinct class is excluded by construction. Folded into
 * `LlmMalformedResponseError` — which is where an unsignalled refusal used to
 * land — it would be RETRIED, re-asking a model that has already declined this
 * prompt and paying for every attempt. Truncation's carve-out
 * (`NousTruncatedError`) settled the same argument for the same reason.
 *
 * A refusal still fails LOUDLY. Nothing here degrades it into a neutral or
 * fabricated position — see `json-response.ts`'s stated design.
 */
export class LlmRefusalError extends Error {
  /** The wire field that signalled the refusal, so the log names its evidence rather than a guess. */
  readonly signal: string;
  /**
   * Tokens the refused call billed, when the transport could see them. Absent
   * when it could not: a throw at the wire boundary skips `recordSpend`
   * entirely, so this is the only surface that carries the cost.
   */
  readonly usage: { input_tokens: number; output_tokens: number } | undefined;

  constructor(
    message: string,
    signal: string,
    usage?: { input_tokens: number; output_tokens: number },
  ) {
    super(message);
    this.name = 'LlmRefusalError';
    this.signal = signal;
    this.usage = usage;
  }
}

/**
 * The model ran out of `max_tokens` before it finished (#1394).
 *
 * Its own class for the reason `LlmRefusalError` and `LlmCancelledError` are:
 * a truncation was previously excluded from `isRetryable` only by the ABSENCE
 * of a `.status` field, which landed it on `LlmProviderError` and left it
 * indistinguishable in the log from a dead API key — the exact conflation
 * #1394 exists to remove. `NousMessagesClient` translates
 * `NousTruncatedError` into this, the same seam that translates a refusal.
 *
 * Still not retried: `isRetryable` admits only timeout/rate-limit/malformed,
 * so this class is excluded by construction rather than by an absent field.
 */
export class LlmTruncatedError extends Error {
  readonly model: string;
  readonly max_tokens: number;
  /** Tokens the provider billed for the truncated call, when the transport could see them. */
  readonly usage: { input_tokens: number; output_tokens: number } | undefined;

  constructor(
    message: string,
    model: string,
    max_tokens: number,
    usage?: { input_tokens: number; output_tokens: number },
  ) {
    super(message);
    this.name = 'LlmTruncatedError';
    this.model = model;
    this.max_tokens = max_tokens;
    this.usage = usage;
  }
}

export type LlmError =
  | LlmTimeoutError
  | LlmRateLimitError
  | LlmMalformedResponseError
  | LlmProviderError
  | LlmCancelledError
  | LlmRefusalError
  | LlmTruncatedError;
