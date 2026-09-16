/** Concrete `LlmClient` (#31): the wire client is injected, mirroring `AlpacaBrokerClient`/`CcxtBrokerClient` — connection provisioning is an ops concern, not this file's. */

import { type RetryAttemptReport, withRetry } from '../../../shared/index.js';
import type { AnthropicUsage } from '../../../shared/llm/index.js';
import { hashPromptTemplate } from '../../../shared/llm/index.js';
import {
  LlmAdmissionRefusedError,
  LlmCancelledError,
  LlmMalformedResponseError,
  LlmProviderError,
  LlmRateLimitError,
  LlmRefusalError,
  LlmTimeoutError,
  LlmTruncatedError,
} from './errors.js';
import { classifyFailureCause, type FailureCause } from './failure-cause.js';
import { UNTRUSTED_WRAPPER_TEMPLATE, wrapUntrusted } from './prompt-safety.js';
import { type LlmSpendSink, NULL_SPEND_SINK } from './spend-sink.js';
import {
  LLM_CONTEXT_FIELD_KIND,
  type LlmClient,
  type LlmRequest,
  type LlmRequestContext,
  type LlmResponse,
  type LlmRetryConfig,
} from './types.js';

/**
 * Only transient failures retry (rate limit, malformed response, `status`-source timeout); a `deadline` timeout
 * does not (#1080) — it already spent its full per-attempt budget, so retrying spends a second one.
 * TRUNCATION (#1394) and REFUSAL (#1391) are excluded by their own error class, not by this check.
 */
function isRetryable(error: unknown): boolean {
  if (error instanceof LlmTimeoutError) {
    return error.source === 'status';
  }
  return error instanceof LlmRateLimitError || error instanceof LlmMalformedResponseError;
}

export interface AnthropicMessageRequest {
  model: string;
  max_tokens: number;
  messages: Array<{ role: 'user'; content: string }>;
}

/** The subset of the Messages API response this client reads (text content blocks) */
export interface AnthropicMessageResponse {
  content: Array<{ type: string; text?: string }>;
  /** Token counts for the spend meter. Optional — `AnthropicMessagesClient` is structural and many test doubles return bare `content`. */
  usage?: AnthropicUsage;
  /**
   * Set to `'refusal'` when the provider declined (#1391) — read here so a refusal doesn't fall through
   * to `parseResponse` as empty text and become a retryable `LlmMalformedResponseError`.
   */
  stop_reason?: string;
  /** Model that actually served the request (may differ from `config.model` via server-side fallback) — preferred for pricing so the meter bills what ran. */
  model?: string;
  /** Time-to-first-byte (#1012), optional for the same structural-interface reason as `usage`. */
  ttfb_ms?: number;
}

/** Per-call transport options (#347), separate from the wire body `AnthropicMessageRequest` — a signal isn't serialized. */
export interface AnthropicMessageOptions {
  /** Aborts the underlying request. Wire clients that can honour it should. */
  signal?: AbortSignal | undefined;
  /** Names this call on the in-flight gate's log lines (#1533); a client that ignores it just labels every call `'debate'`. */
  stage?: string | undefined;
}

export interface AnthropicMessagesClient {
  /**
   * Second, OPTIONAL parameter rather than a request-body field: TS lets an implementation take fewer
   * params, so existing structural doubles (`createMessage(request)`) still satisfy the interface unchanged.
   */
  createMessage(
    request: AnthropicMessageRequest,
    options?: AnthropicMessageOptions,
  ): Promise<AnthropicMessageResponse>;
}

/** One retried attempt, reported to `onRetryAttempt` (#1080), with the identity fields only this client holds. */
interface LlmRetryAttemptReport extends RetryAttemptReport {
  model: string;
  trace_id: string | undefined;
  stage: string | undefined;
  debate_id: string | undefined;
}

/** One abandoned call, reported to `onCallFailed` (#1394); `failure_cause` classified here so every caller reports the same word. */
export interface LlmCallFailureReport {
  failure_cause: FailureCause;
  /** The thrown value itself, so the observer can render it as it sees fit */
  error: unknown;
  model: string;
  trace_id: string | undefined;
  stage: string | undefined;
  debate_id: string | undefined;
}

export interface AnthropicLlmClientConfig {
  model: string;
  max_tokens: number;
  /** Per-attempt timeout; exceeding this raises `LlmTimeoutError` and may be retried */
  timeoutMs: number;
  retry: LlmRetryConfig;
  /**
   * Observes every retried attempt (#1080) — optional, defaulting to a no-op. A retried attempt is otherwise
   * invisible: it bills the provider and spends wall-clock time but never reaches `llm_spend` or the log stream.
   */
  onRetryAttempt?: ((report: LlmRetryAttemptReport) => void) | undefined;
  /**
   * Observes every call this client gives up on (#1394), once, after retry budget is spent. One dispatch
   * never reaches here: `RateLimitedLlmClient` throws `LlmCancelledError` on an already-aborted signal
   * without calling `complete` (#347) — that path costs nothing and reports nothing.
   */
  onCallFailed?: ((report: LlmCallFailureReport) => void) | undefined;
}

/**
 * `request.context.analyst_views` carries the same ingested free text as `request.prompt` — wrapping it
 * here (#208, prompt-safety.ts) makes the mitigation hold on the actual wire content, not just `personas.ts`'s prompt.
 */
/**
 * The half of `LlmRequestContext` the model may see, selected by reading `LLM_CONTEXT_FIELD_KIND` (PR #387) —
 * an allowlist the classification map enforces at compile time, not a denylist someone must remember to extend.
 * Top-level keys only: a replacer array would recurse into `debate_state`'s own unrelated keys.
 */
function promptContextOf(context: LlmRequestContext): Record<string, unknown> {
  const promptContext: Record<string, unknown> = {};
  for (const [field, kind] of Object.entries(LLM_CONTEXT_FIELD_KIND)) {
    if (kind !== 'prompt') {
      continue;
    }
    const value = context[field as keyof LlmRequestContext];
    // Absent optional fields stay absent rather than `null` — keeps the rendered prompt byte-identical to before this indirection
    if (value !== undefined) {
      promptContext[field] = value;
    }
  }
  return promptContext;
}

/**
 * THE debate request builder (#1010): flattens to one opaque string, so no `cache_control` breakpoint applies —
 * moot since debate requests run well under the pinned model's 4,096-token cache minimum (see `prompt-caching.test.ts`).
 * Do not re-add caching without re-measuring that minimum and confirming Nous's proxy forwards the field at all.
 */
export function renderMessageContent<T>(request: LlmRequest<T>): string {
  const contextJson = JSON.stringify(promptContextOf(request.context), null, 2);
  return `${request.prompt}\n\nContext:\n${wrapUntrusted(contextJson)}`;
}

/**
 * Fixed scaffold `renderMessageContent` wraps every prompt in, outside `request.prompt` (#1514). Folded into
 * the persisted template hash below since it's a property of the wire client's rendering, shared by every call.
 */
const WIRE_ENVELOPE_TEMPLATE = `\n\nContext:\n${UNTRUSTED_WRAPPER_TEMPLATE}`;
export const WIRE_ENVELOPE_TEMPLATE_HASH = hashPromptTemplate(WIRE_ENVELOPE_TEMPLATE);

/**
 * Combines a call site's template hash with `WIRE_ENVELOPE_TEMPLATE_HASH` so a change to either changes the
 * stored value. `undefined` in, `undefined` out — no fabricated value for an unwired call site.
 */
function withWireEnvelope(callTemplateHash: string | undefined): string | undefined {
  return callTemplateHash === undefined
    ? undefined
    : hashPromptTemplate(`${callTemplateHash}:${WIRE_ENVELOPE_TEMPLATE_HASH}`);
}

function extractText(response: AnthropicMessageResponse): string {
  return response.content
    .filter(
      (block): block is { type: string; text: string } =>
        block.type === 'text' && typeof block.text === 'string',
    )
    .map((block) => block.text)
    .join('');
}

/** Duck-types the injected client's thrown errors via the SDK's conventional `status` field rather than importing its error classes, keeping `AnthropicMessagesClient` structural. */
function classifyProviderError(error: unknown): Error {
  if (
    error instanceof LlmTimeoutError ||
    error instanceof LlmRateLimitError ||
    error instanceof LlmMalformedResponseError ||
    error instanceof LlmProviderError ||
    // Passed through rather than duck-typed to `LlmProviderError`: refusal's `signal`/`usage` (#1391) and
    // truncation's `max_tokens`/`usage` (#1394) are the only record of what the burned call cost
    error instanceof LlmRefusalError ||
    error instanceof LlmTruncatedError ||
    // #1080: an in-flight refusal names a call that was never sent; duck-typed to `LlmProviderError` it
    // would be miscounted as `transport`, a counterfeit gateway fault
    error instanceof LlmAdmissionRefusedError
  ) {
    return error;
  }

  const status =
    typeof error === 'object' && error !== null
      ? (error as { status?: unknown }).status
      : undefined;
  const message = error instanceof Error ? error.message : String(error);

  if (status === 429) {
    return new LlmRateLimitError(message);
  }
  if (status === 408 || status === 504) {
    return new LlmTimeoutError(message, 'status');
  }
  return new LlmProviderError(message);
}

export class AnthropicLlmClient implements LlmClient {
  constructor(
    private readonly client: AnthropicMessagesClient,
    private readonly config: AnthropicLlmClientConfig,
    /** Where token usage is metered. Defaults to `NULL_SPEND_SINK` so tests/backtests keep working unmetered. */
    private readonly spendSink: LlmSpendSink = NULL_SPEND_SINK,
  ) {}

  complete<T>(request: LlmRequest<T>): Promise<LlmResponse<T>> {
    // Checked before the retry loop: an already-aborted signal must cost nothing at all, making
    // "no further LLM calls after the budget fires" (#347) hold even mid-dispatch
    if (request.signal?.aborted === true) {
      return Promise.reject(
        this.reportFailure(
          request,
          new LlmCancelledError(
            'LLM call cancelled before dispatch: caller signal already aborted',
          ),
        ),
      );
    }
    const onRetryAttempt = this.config.onRetryAttempt;
    return withRetry(
      () => this.attempt(request),
      this.config.retry,
      isRetryable,
      onRetryAttempt === undefined
        ? undefined
        : (report) => {
            // Read off the request's own attribution, not threaded separately — it's the same source
            // `recordSpend` bills against, so retried and successful attempts join on `debate_id`
            const attribution = request.context.attribution;
            onRetryAttempt({
              ...report,
              model: this.config.model,
              trace_id: attribution?.trace_id,
              stage: attribution?.stage,
              debate_id: attribution?.debate_id,
            });
          },
      // The one place a production LLM failure is guaranteed to be named (#1394) — every caller below
      // either swallows it to fail open or re-renders it in its own words
    ).catch((error: unknown) => {
      throw this.reportFailure(request, error);
    });
  }

  /** Returns `error` unchanged — the observer is a side channel; a throw from a logger must not reclassify the failure. */
  private reportFailure<T>(request: LlmRequest<T>, error: unknown): unknown {
    const onCallFailed = this.config.onCallFailed;
    if (onCallFailed === undefined) return error;
    try {
      const attribution = request.context.attribution;
      onCallFailed({
        failure_cause: classifyFailureCause(error),
        error,
        model: this.config.model,
        trace_id: attribution?.trace_id,
        stage: attribution?.stage,
        debate_id: attribution?.debate_id,
      });
    } catch {
      // Same guard `withRetry` puts around `onRetry`: an observer that throws loses its own line, not the call's real failure
    }
    return error;
  }

  private async attempt<T>(request: LlmRequest<T>): Promise<LlmResponse<T>> {
    const start = Date.now();
    // Hoisted out so the capture path persists the EXACT string sent on the wire (#1035), not a
    // reconstruction from `request.prompt` + context afterwards
    const content = renderMessageContent(request);
    const attribution = request.context.attribution;
    const gateStage = attribution?.gate_stage ?? attribution?.stage;
    const response = await this.callWithTimeout(content, request.signal, gateStage);
    const latency_ms = Date.now() - start;

    // `finally`, not a plain sequence: `extractText` can throw on a malformed payload, and metering must
    // still record the row (#1035) or `SqliteSpendCap`'s sum would understate by exactly those calls
    let rawText = '';
    try {
      rawText = extractText(response);
    } finally {
      // Metered BEFORE the parse gate: a malformed response was still generated and billed, and moved
      // below `extractText` (#1035) so the same record can also carry the response text
      this.recordSpend(request, response, latency_ms, content, rawText);
    }

    // Below the metering `finally` (billed either way) but above the parse gate — a refusal is not a bad
    // draw and must not become the retryable `LlmMalformedResponseError` its empty text would produce
    if (response.stop_reason === 'refusal') {
      throw new LlmRefusalError(
        `LLM refused to answer: ${this.config.model} returned stop_reason="refusal"`,
        'stop_reason="refusal"',
        response.usage,
      );
    }

    const parsed = request.parseResponse(rawText);
    if (!parsed.valid) {
      throw new LlmMalformedResponseError(parsed.reason);
    }

    return { data: parsed.data, raw_text: rawText, latency_ms };
  }

  /**
   * A call that times out or throws never reaches here, so its tokens are missing from the total even
   * though the provider may have billed them — a known floor, not an oversight (#1080 measured it at
   * ~$0.090 of $0.2595 metered spend across two soak sessions; ADR-0008 carries the working).
   */
  private recordSpend<T>(
    request: LlmRequest<T>,
    response: AnthropicMessageResponse,
    latency_ms: number,
    prompt: string,
    responseText: string,
  ): void {
    // Text is captured only for METERED calls (the production path always returns a usage block; test
    // doubles with bare `content` capture nothing) — narrower coverage than "every call"
    if (response.usage === undefined) return;
    try {
      this.spendSink.record({
        trace_id: request.context.attribution?.trace_id ?? 'unattributed',
        stage: request.context.attribution?.stage ?? 'debate',
        debate_id: request.context.attribution?.debate_id,
        model: response.model ?? this.config.model,
        usage: response.usage,
        latency_ms,
        ttfb_ms: response.ttfb_ms,
        timestamp: new Date(),
        prompt,
        response: responseText,
        prompt_template_hash: withWireEnvelope(request.context.attribution?.prompt_template_hash),
      });
    } catch {
      // `LlmSpendSink` is a public interface any caller may implement, so the "must not throw" contract
      // is enforced here at the boundary rather than trusted per-implementation. Silent by necessity —
      // this class has no logger; the SQLite sink already logs failures for itself
    }
  }

  /**
   * Races the wire call against `config.timeoutMs` and, since #347, CANCELS the loser rather than
   * abandoning it — a timed-out call used to keep running and get retried underneath itself, holding
   * multiple concurrent requests open and billing for all of them.
   */
  private async callWithTimeout(
    content: string,
    callerSignal?: AbortSignal,
    llmStage?: string,
  ): Promise<AnthropicMessageResponse> {
    const timeoutController = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const expired = new LlmTimeoutError(`LLM call exceeded ${this.config.timeoutMs}ms`);
        // Abort first, reject second: the point of #347 is that the request stops, not merely that the
        // caller stops waiting — the abort reason is the same error object the race reports
        timeoutController.abort(expired);
        reject(expired);
      }, this.config.timeoutMs);
    });

    const signal =
      callerSignal === undefined
        ? timeoutController.signal
        : AbortSignal.any([callerSignal, timeoutController.signal]);

    const call = this.client
      .createMessage(
        {
          model: this.config.model,
          max_tokens: this.config.max_tokens,
          messages: [{ role: 'user', content }],
        },
        { signal, stage: llmStage },
      )
      .catch((error) => {
        throw classifyProviderError(error);
      });

    // No `call.catch(() => {})` guard here: the losing side now REJECTS instead of hanging, but
    // `Promise.race` already attaches its own handler, so the late rejection is handled, not unhandled
    try {
      return await Promise.race([call, timeout]);
    } catch (error) {
      // A caller-initiated abort surfaces from `fetch` as generic `AbortError`; attributed here, where
      // the caller's signal is in scope, rather than miscounted as a provider fault
      if (callerSignal?.aborted === true) {
        // `cause` carries the original: this branch fires on ANY failure once the signal is aborted, so
        // a real 429/500 racing the abort isn't silently relabelled
        throw new LlmCancelledError('LLM call cancelled by caller while in flight', error);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
