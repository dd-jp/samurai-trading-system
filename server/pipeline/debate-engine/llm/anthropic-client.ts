/**
 * Concrete `LlmClient` (ticket #31 AC: "Concrete implementation using
 * configured LLM provider"). The wire client is injected rather than
 * constructed here, mirroring `AlpacaBrokerClient`/`CcxtBrokerClient` — connection
 * provisioning (API key, base URL) is an ops concern, and `AnthropicMessagesClient`
 * is deliberately the narrow slice of the Anthropic Messages API this file
 * uses, so any real SDK client (or a test double) satisfies it structurally
 * without a hard dependency on a specific SDK package.
 */

import { type RetryAttemptReport, withRetry } from '../../../shared/index.js';
import type { AnthropicUsage } from '../../../shared/llm/pricing.js';
import {
  LlmCancelledError,
  LlmMalformedResponseError,
  LlmProviderError,
  LlmRateLimitError,
  LlmRefusalError,
  LlmTimeoutError,
  LlmTruncatedError,
} from './errors.js';
import { classifyFailureCause, type FailureCause } from './failure-cause.js';
import { wrapUntrusted } from './prompt-safety.js';
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
 * Only failure modes the spec calls out as transient are retried (timeout,
 * rate limit, malformed response). Anything else (auth errors, bad requests,
 * unclassified `LlmProviderError`s) is assumed non-transient and rethrown
 * immediately. Closed over the generalized `withRetry` (issue #271).
 *
 * "Malformed responses are reparseable on a fresh sample" is TRUE OF THE
 * SAMPLE, not of every response that fails to parse, and there are two
 * carve-outs where the failure is deterministic in the request rather than in
 * the draw — retrying either one re-bills an identical failure:
 *
 *  - TRUNCATION (`LlmTruncatedError`, #1394). Excluded by ITS OWN CLASS. It
 *    was excluded by the ABSENCE of a `.status` field until #1394 — which
 *    rejected it correctly but left it reading as an unclassified
 *    `LlmProviderError` at every call site downstream.
 *  - REFUSAL (`LlmRefusalError`, #1391). Excluded by ITS OWN CLASS — the same
 *    construction `LlmCancelledError` uses — because a refusal must stay
 *    distinguishable in the log from an unclassified provider fault, and
 *    carries the `usage` of the call it burned.
 */
function isRetryable(error: unknown): boolean {
  return (
    error instanceof LlmTimeoutError ||
    error instanceof LlmRateLimitError ||
    error instanceof LlmMalformedResponseError
  );
}

export interface AnthropicMessageRequest {
  model: string;
  max_tokens: number;
  messages: Array<{ role: 'user'; content: string }>;
}

/** The subset of the Messages API response this client reads (text content blocks). */
export interface AnthropicMessageResponse {
  content: Array<{ type: string; text?: string }>;
  /**
   * Token counts, fed to the local spend meter (llm/spend-sink.ts). Optional
   * because `AnthropicMessagesClient` is a structural interface any wire
   * client may satisfy — the many test doubles in this suite return `content`
   * alone, and requiring `usage` would break every one of them for a field
   * nothing trading-critical reads.
   *
   * A real wire client passes the provider's block straight through, so it
   * arrives at runtime without extra parsing.
   */
  usage?: AnthropicUsage;
  /**
   * Set to `'refusal'` when the provider declined to answer (#1391). Read here
   * rather than left to `parseResponse` because `extractText` keeps only
   * `type: 'text'` blocks, so a refusal reaches the parse gate as empty text
   * and becomes a RETRYABLE `LlmMalformedResponseError` — three full-price
   * calls to a model that has already declined the prompt.
   *
   * DORMANT in this tree, and deliberately kept: `NousMessagesClient` is the
   * only implementation of this interface and speaks OpenAI-compatible
   * `chat/completions`, where the refusal is signalled on the wire and thrown
   * by `nous-chat.ts` before it ever reaches here. The field is Anthropic's own
   * spelling of the same signal, which is what any second wire client on this
   * structural interface would set.
   */
  stop_reason?: string;
  /**
   * The model that actually served the request, which is not always the model
   * requested — a server-side fallback can reroute a refused request to a
   * different (differently priced) model. Preferred over `config.model` when
   * pricing, so the meter bills what ran rather than what was asked for.
   */
  model?: string;
  /**
   * Time-to-first-byte (#1012), as measured by the wire client — see
   * `nous-chat.ts`'s `NousChatResult.ttfb_ms` doc comment for exactly what it
   * spans. Optional for the same reason `usage` is: `AnthropicMessagesClient`
   * is structural, and requiring this field would break every test double in
   * this suite that predates #1012 and returns bare `content`.
   */
  ttfb_ms?: number;
}

/**
 * Per-call transport options (#347). Separate from `AnthropicMessageRequest`,
 * which is the wire body — a signal is not something to serialize and send.
 */
export interface AnthropicMessageOptions {
  /** Aborts the underlying request. Wire clients that can honour it should. */
  signal?: AbortSignal | undefined;
}

export interface AnthropicMessagesClient {
  /**
   * `options` is a second, OPTIONAL parameter rather than a field on the
   * request body: TypeScript lets an implementation declare fewer parameters
   * than the interface, so every existing wire double in this suite
   * (`createMessage(request)`) still satisfies this interface unchanged. That
   * matters because `AnthropicMessagesClient` is deliberately structural — any
   * SDK client or fake can satisfy it — and a required parameter would have
   * broken all of them for a capability only the real HTTP client can honour.
   */
  createMessage(
    request: AnthropicMessageRequest,
    options?: AnthropicMessageOptions,
  ): Promise<AnthropicMessageResponse>;
}

/**
 * One retried attempt, as reported to `AnthropicLlmClientConfig.onRetryAttempt`
 * (#1080): the shared loop's report plus the identity fields only this client
 * holds, so a log line can name which model, which trace and which debate paid
 * for the attempt that vanished.
 */
export interface LlmRetryAttemptReport extends RetryAttemptReport {
  model: string;
  trace_id: string | undefined;
  stage: string | undefined;
  debate_id: string | undefined;
}

/**
 * One abandoned call, as reported to `AnthropicLlmClientConfig.onCallFailed`
 * (#1394). `failure_cause` is classified here rather than at each seam so
 * every caller reports the same word for the same fault.
 */
export interface LlmCallFailureReport {
  failure_cause: FailureCause;
  /** The thrown value itself, so the observer can render it as it sees fit. */
  error: unknown;
  model: string;
  trace_id: string | undefined;
  stage: string | undefined;
  debate_id: string | undefined;
}

export interface AnthropicLlmClientConfig {
  model: string;
  max_tokens: number;
  /** Per-attempt timeout; exceeding this raises `LlmTimeoutError` and may be retried. */
  timeoutMs: number;
  retry: LlmRetryConfig;
  /**
   * Observes every attempt this client retries (#1080). Optional, so the many
   * test and backtest construction sites are unchanged and simply report
   * nothing; the production composition root supplies one that logs at `warn`.
   *
   * A RETRIED ATTEMPT IS OTHERWISE INVISIBLE, and that is what this closes.
   * `attempt()` starts its own `latency_ms` clock and meters only through
   * `recordSpend`, which a failed attempt never reaches — so the attempt is
   * absent from `llm_spend`, absent from the `llm call:` log stream, and
   * absent from every derived figure. It still consumed real wall-clock time
   * inside whatever latency budget the caller was racing (`enforceLatencyBudget`
   * for a debate), and still billed the provider. #1080 had to infer those
   * attempts from >30s gaps between logged calls; with this wired they are
   * read off a line.
   */
  onRetryAttempt?: ((report: LlmRetryAttemptReport) => void) | undefined;
  /**
   * Observes every call this client gives up on (#1394), once, after the retry
   * budget is spent. Optional for the same reason `onRetryAttempt` is; the
   * production composition root supplies one that logs `llm_call_failed` at
   * `warn` with the classified cause.
   *
   * THIS IS THE ONE SEAM THAT SEES EVERY PRODUCTION LLM FAILURE.
   * `production.ts` builds a single client and shares it across the debate
   * personas, the disagreement detector, the risk critic and MI scoring — most
   * of which then swallow the error to fail open, so a per-caller line is
   * exactly what #1394 found missing. A count of failures by cause for a whole
   * session is `llm_call_failed` grouped by `payload.failure_cause`.
   */
  onCallFailed?: ((report: LlmCallFailureReport) => void) | undefined;
}

/**
 * `request.context.analyst_views` (and any `debate_state`) carries the same
 * ingested free text (`key_points`, persona rationale) as `request.prompt` —
 * some callers (e.g. `disagreement-detector.ts`) rely on it entirely rather
 * than interpolating free text into the prompt string. Wrapping it here
 * (#208, prompt-safety.ts) is what makes the mitigation hold on the actual
 * wire content sent to the provider, not just on `personas.ts`'s `prompt`.
 */
/**
 * The half of `LlmRequestContext` the model is allowed to see, selected by
 * READING `LLM_CONTEXT_FIELD_KIND` rather than by naming fields (PR #387
 * review).
 *
 * An allowlist derived from the classification map, not a denylist of
 * attribution names. The distinction is the whole point: a denylist is correct
 * only while someone remembers to extend it, and the field it forgets is
 * silently billed to the operator on every call. Here, a new context field is
 * unrepresentable until it is classified — the map's `satisfies Record<keyof
 * LlmRequestContext, ...>` refuses to compile otherwise — and only fields
 * classified `'prompt'` are ever serialized.
 *
 * Top-level keys only. `JSON.stringify`'s own replacer-array parameter would
 * do this in one argument but applies at EVERY level of nesting, which would
 * silently gut `debate_state` (an open `Record<string, unknown>` whose inner
 * keys this layer must not interpret).
 */
function promptContextOf(context: LlmRequestContext): Record<string, unknown> {
  const promptContext: Record<string, unknown> = {};
  for (const [field, kind] of Object.entries(LLM_CONTEXT_FIELD_KIND)) {
    if (kind !== 'prompt') {
      continue;
    }
    const value = context[field as keyof LlmRequestContext];
    // Absent optional fields stay absent rather than serializing as `null` —
    // `JSON.stringify` drops `undefined` values anyway, so this only keeps the
    // rendered prompt byte-identical to what it was before this indirection.
    if (value !== undefined) {
      promptContext[field] = value;
    }
  }
  return promptContext;
}

/**
 * THE debate request builder (#1010). Flattens `prompt` + the serialized
 * context into a single string with no content-block structure — there is
 * nowhere here a `cache_control: {type: 'ephemeral'}` breakpoint could be
 * attached even if one were wanted, since Anthropic's cache breakpoints are
 * a property of a content BLOCK, and this produces one opaque string that
 * `nous-messages-client.ts` wraps in a single `{role:'user', content}`
 * message.
 *
 * #1010 measured whether that gap is worth closing and found it moot on a
 * more basic ground: the pinned debate model (`anthropic/claude-haiku-4.5`)
 * requires 4,096 input tokens before Anthropic will cache anything at all,
 * and every debate-stage request this repo sends is measured well under
 * that minimum — including the full bull/bear request this function
 * renders, which is byte-identical across every round of one debate
 * (`personas.ts`'s `PersonaInput` has no field for
 * `RoundContext.priorArguments` at all as of #1010, so the round number
 * never reaches the rendered prompt) and would therefore be exactly the
 * shape caching helps most, if it were large enough to qualify. Full
 * figures, the provider docs citation, the production (`llm_spend`)
 * measurement this rests on, and why a naive chars/4 estimate is not itself
 * proof of "under the minimum" all live in `prompt-caching.test.ts` (same
 * directory) — that file is the canonical home for this finding, kept as a
 * test so it re-verifies rather than going stale. Below 4,096 tokens,
 * restructuring this into content blocks would buy nothing — Anthropic
 * silently skips caching rather than erroring, so it would look like it
 * worked and never fire.
 *
 * Separately (and this holds regardless of prompt size): `nous-chat.ts`'s
 * usage parsing reads only `prompt_tokens`/`completion_tokens` from the
 * proxy's response and drops everything else, so even a hit somewhere
 * upstream of Nous would currently be invisible here — see the comment on
 * that parsing and the characterization test next to it.
 *
 * Do not re-add `cache_control` here without first: (1) re-measuring this
 * average against the model's current minimum (Anthropic's per-model
 * minimums have moved before), (2) confirming Nous's proxy actually forwards
 * an Anthropic-specific `cache_control` field through its OpenAI-compatible
 * `chat/completions` shape (undocumented anywhere in this repo as of #1010 —
 * `docs/adr/0009-single-provider-nous.md` is the canonical document
 * distinguishing Nous from other providers/OpenRouter, and says nothing about
 * caching), and (3) giving `MODEL_RATES` a per-model `cache_read` column
 * first, per the existing deferral note on `CACHE_READ_MULTIPLIER` in
 * pricing.ts — a uniform multiplier mis-prices most of Nous's vendor lineup.
 */
export function renderMessageContent<T>(request: LlmRequest<T>): string {
  const contextJson = JSON.stringify(promptContextOf(request.context), null, 2);
  return `${request.prompt}\n\nContext:\n${wrapUntrusted(contextJson)}`;
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

/**
 * Duck-types the injected client's thrown errors into the typed hierarchy
 * (errors.ts) via the Anthropic SDK's conventional `status` field, rather
 * than importing the SDK's own error classes — keeping `AnthropicMessagesClient`
 * a structural interface any provider client can satisfy.
 */
function classifyProviderError(error: unknown): Error {
  if (
    error instanceof LlmTimeoutError ||
    error instanceof LlmRateLimitError ||
    error instanceof LlmMalformedResponseError ||
    error instanceof LlmProviderError ||
    // Passed through rather than duck-typed down to `LlmProviderError`: the
    // refusal's `signal` and `usage` are the only record of what the burned
    // call cost, and re-wrapping would discard both (#1391). A truncation
    // carries `max_tokens`/`usage` for the same reason (#1394).
    error instanceof LlmRefusalError ||
    error instanceof LlmTruncatedError
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
    return new LlmTimeoutError(message);
  }
  return new LlmProviderError(message);
}

export class AnthropicLlmClient implements LlmClient {
  constructor(
    private readonly client: AnthropicMessagesClient,
    private readonly config: AnthropicLlmClientConfig,
    /**
     * Where token usage is metered. Defaults to `NULL_SPEND_SINK` so every
     * existing construction site — tests, backtests, anything without a shared
     * store — keeps working unchanged and simply meters nothing.
     */
    private readonly spendSink: LlmSpendSink = NULL_SPEND_SINK,
  ) {}

  complete<T>(request: LlmRequest<T>): Promise<LlmResponse<T>> {
    // Checked before the retry loop, not inside it: a request whose signal is
    // already aborted must cost nothing at all. This is the guard that makes
    // "no further LLM calls after the budget fires" (#347) hold even for a
    // call the round loop had already begun to dispatch.
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
            // Read off the request's own attribution rather than threaded
            // separately: it is the SAME source `recordSpend` bills against,
            // so a retried attempt and the attempt that eventually succeeded
            // are joinable on `debate_id` without a second convention.
            const attribution = request.context.attribution;
            onRetryAttempt({
              ...report,
              model: this.config.model,
              trace_id: attribution?.trace_id,
              stage: attribution?.stage,
              debate_id: attribution?.debate_id,
            });
          },
      // The ONE place a production LLM failure is guaranteed to be named
      // (#1394). Every caller below this client either swallows the error to
      // fail open or re-renders it in its own words; this fires once, after
      // the retry budget, before either.
    ).catch((error: unknown) => {
      throw this.reportFailure(request, error);
    });
  }

  /**
   * Returns `error` unchanged — the observer is a side channel, and a throw
   * from a logger must not turn a classified failure into a different one.
   */
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
      // Same guard `withRetry` puts around `onRetry`: an observer that throws
      // loses its own line, never the call's real failure.
    }
    return error;
  }

  private async attempt<T>(request: LlmRequest<T>): Promise<LlmResponse<T>> {
    const start = Date.now();
    // Hoisted out of the call below so the capture path can persist the EXACT
    // string that went on the wire (#1035), rather than rebuilding it from
    // `request.prompt` and the context afterwards. A reconstruction is a
    // different artifact: it answers "what would we send now", not "what was
    // this call actually asked", and the second question is the one an
    // operator has on day six of a soak.
    const content = renderMessageContent(request);
    const response = await this.callWithTimeout(content, request.signal);
    const latency_ms = Date.now() - start;

    // `finally`, not a plain sequence: `extractText` reads `response.content`,
    // and a provider payload without that field throws a TypeError. Metering
    // was ABOVE this extraction before #1035, so ordering the two naively
    // would newly lose the `llm_spend` row for a billed call — and
    // `SqliteSpendCap` sums that table, so the cap would silently understate
    // by exactly the malformed responses. This restores the pre-#1035
    // guarantee while still letting the record carry whatever text existed.
    let rawText = '';
    try {
      rawText = extractText(response);
    } finally {
      // Metered BEFORE the parse gate below, because a malformed response was
      // still generated and still billed. Recording only well-formed responses
      // would make the meter understate spend by exactly the calls most likely
      // to be retried — i.e. it would be most wrong when it matters most.
      //
      // Moved BELOW `extractText` by #1035 so the same record can carry the
      // response text. The ordering argument is unchanged and now cuts twice: a
      // malformed response is exactly the case whose text an operator most
      // wants to read, so capturing it only for well-formed answers would
      // withhold the evidence precisely when it is needed.
      this.recordSpend(request, response, latency_ms, content, rawText);
    }

    // Below the metering `finally` for the reason the parse gate is: a refused
    // response was still generated and still billed. Above the parse gate
    // because a refusal is not a bad draw — it must not become the retryable
    // `LlmMalformedResponseError` its empty text would otherwise produce.
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
   * Note what is NOT metered: a call that times out or throws never reaches
   * here, so its tokens are missing from the total even though the provider
   * may have generated (and billed) them. There is no usage block to read on a
   * failed call — the information does not exist client-side — so this is a
   * known floor on the figure, not an oversight. Retries are each counted
   * separately, which is correct: each attempt is separately billed.
   *
   * #1080 MEASURED THAT FLOOR for the first time, and the number is not
   * negligible. In the 2026-09-03 paper session, at least nine of the 26
   * timed-out debates contained a full 30s attempt that timed out and was
   * retried — provably, because a single attempt is bounded by
   * `config.timeoutMs`, so any interval between one logged call and the next
   * that exceeds it must contain one. One debate (`9d9e505f3493`) burned its
   * entire 60s budget with ZERO rows in `llm_spend` at all. At the session's
   * mean metered debate-call cost of $0.002332, those nine attempts are a
   * floor of ~$0.021 the cap could not see — small against ADR-0008's $50, but
   * unbounded in principle, since nothing counted them.
   *
   * They are counted now: `AnthropicLlmClientConfig.onRetryAttempt` logs each
   * retried attempt with its elapsed time, so the gap between billed and
   * metered is readable from the log rather than inferable from timestamps.
   * The rows are still not written — there is still no usage block on a failed
   * call — so this remains a floor, but a floor whose size can be checked.
   *
   * `latency_ms` (#326) is the SAME number returned to the caller on
   * `LlmResponse` — measured once, around `callWithTimeout`, and passed in
   * rather than re-measured here, so the persisted figure and the logged one
   * can never disagree. It is recorded even for a response that goes on to
   * fail the parse gate below, for the same reason the tokens are: the call
   * took that long and cost that much whether or not the answer was usable.
   */
  private recordSpend<T>(
    request: LlmRequest<T>,
    response: AnthropicMessageResponse,
    latency_ms: number,
    prompt: string,
    responseText: string,
  ): void {
    // The capture inherits this early return, and that coupling is worth
    // stating rather than discovering: text is recorded only for METERED
    // calls. On the production path Nous always returns a usage block, so the
    // two coincide; in tests, the many doubles that return a bare `content`
    // capture nothing. Combined with the floor named above — a call that times
    // out or throws never reaches here — the capture's coverage is "every call
    // that completed and reported usage", which is narrower than "every call".
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
      });
    } catch {
      // The sink contract says `record` must not throw, and the SQLite
      // implementation honours it — but `LlmSpendSink` is a public interface
      // any caller may implement, so trusting that contract per-implementation
      // leaves the guarantee one bad sink away from failing a trading call.
      // Enforced here, at the boundary, where it actually holds.
      //
      // Silent by necessity: this class has no logger, and adding one to carry
      // a metering failure would widen a hot constructor for a message the
      // SQLite sink already logs for itself. The observable symptom — a spend
      // total that stops rising — is on the dashboard either way.
    }
  }

  /**
   * Races the wire call against `config.timeoutMs` — and, since #347, CANCELS
   * the loser instead of abandoning it. Three things changed here, all of them
   * live on the production path (this timeout fires on every slow call, not
   * only on a timed-out debate):
   *
   *  - The per-call timeout now aborts its own in-flight request. Before, a
   *    timed-out call kept running and was RETRIED underneath itself
   *    (`LlmTimeoutError` is retryable), so one slow call could hold two or
   *    three concurrent requests open against the provider's rate limit and
   *    bill for all of them while at most one answer was ever read.
   *  - `callerSignal` (the debate's latency budget) is combined with that
   *    timeout via `AbortSignal.any`, so either can cancel the request.
   *  - The timer is cleared once the race settles. It used to leak one
   *    unfired timer per LLM call, forever — a real leak at soak scale.
   */
  private async callWithTimeout(
    content: string,
    callerSignal?: AbortSignal,
  ): Promise<AnthropicMessageResponse> {
    const timeoutController = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const expired = new LlmTimeoutError(`LLM call exceeded ${this.config.timeoutMs}ms`);
        // Abort first, reject second: the point of the ticket is that the
        // request stops, not merely that the caller stops waiting. The same
        // error object is the abort reason, so a wire client that surfaces
        // `signal.reason` and this race report the identical failure.
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
        { signal },
      )
      .catch((error) => {
        throw classifyProviderError(error);
      });

    // No `call.catch(() => {})` guard here, deliberately: the losing side now
    // REJECTS (aborted) instead of hanging, but `Promise.race` attaches its
    // own handlers to `call`, so that late rejection is handled-and-ignored,
    // not unhandled. Same finding as `latency-budget.ts` — see the note there.
    try {
      return await Promise.race([call, timeout]);
    } catch (error) {
      // A caller-initiated abort surfaces from `fetch` as a generic
      // `AbortError`, which `classifyProviderError` can only call an
      // `LlmProviderError` — i.e. a counterfeit provider fault. Attributed
      // here instead, where the caller's signal is in scope.
      if (callerSignal?.aborted === true) {
        // `cause` carries the original: this branch fires on ANY failure that
        // surfaces once the signal is aborted, so a real 429 or 500 racing the
        // abort would otherwise be silently relabelled and lost.
        throw new LlmCancelledError('LLM call cancelled by caller while in flight', error);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
