/**
 * One taxonomy for "why did this call fail", and the one function that decides
 * it (#1394, successor to #1114).
 *
 * The problem it closes: every fail-open seam in this system caught `unknown`
 * and logged prose. A refusal, a truncation, a parse failure, a rate limit and
 * a dead socket all reached the operator as one indistinguishable warn line —
 * so "the model is declining our prompts" and "the network is down" were the
 * same observation, and neither could be counted.
 *
 * COUNTING RECIPE, for a session's log alone: group `event:
 * 'llm_call_failed'` by `payload.failure_cause`. That code is emitted once per
 * terminal failure of an `AnthropicLlmClient` call, and `production.ts` builds
 * exactly one client and shares it across debate personas, the disagreement
 * detector, the risk critic and MI scoring. The one dispatch outside the
 * total is `RateLimitedLlmClient` refusing an already-aborted call before it
 * calls `complete` (#347) — that costs nothing and reports nothing here.
 * Seam-specific codes (`risk_critic_verdict_unavailable`,
 * `mi_scoring_provider_failure`, `llm_attempt_retried`, `sentiment_refused`,
 * `grok_refresh_failed`, ...) carry the SAME `failure_cause` field so a count
 * can be narrowed to one stage, but `llm_call_failed` is the total and the
 * others are not summed beside it. The Grok/x-search transport
 * (`nous-responses.ts`) does not go through `AnthropicLlmClient` and so is
 * NOT in that total; it is counted by its own codes.
 *
 * Codes are stable string literals per #1115 and the field rides in the
 * payload — an interpolated `event:` would be unspellable there
 * (`log-event-code.test.ts`) and unmatchable by a scrape.
 */

import { NousApiError, NousRefusalError, NousTruncatedError } from '../../../shared/llm/index.js';
import {
  LlmCancelledError,
  LlmMalformedResponseError,
  LlmProviderError,
  LlmRateLimitError,
  LlmRefusalError,
  LlmTimeoutError,
  LlmTruncatedError,
} from './errors.js';

/**
 * `cancelled` is an eighth member beyond the seven #1394 lists, and it is
 * load-bearing rather than decorative: `errors.ts` gives `LlmCancelledError`
 * its own class precisely so a call this system tore down (a debate's latency
 * budget, a tick shutting down) never reads as a provider fault. Folding it
 * into `timeout` would put a deliberate cancellation into the one bucket whose
 * signal value this taxonomy exists to protect — and would train an operator
 * to ignore that bucket, which is #1394's own complaint one level down.
 *
 * `other` is not a dumping ground but a refusal to guess: an unrecognised
 * rejection is reported as unclassified rather than as a counterfeit
 * `transport`, which is the specific mislabelling this ticket was filed over
 * (`item-scorer.ts` called every non-parse failure `transport`, refusals
 * included).
 */
export type FailureCause =
  | 'refusal'
  | 'truncated'
  | 'unparseable'
  | 'timeout'
  | 'rate_limited'
  | 'cancelled'
  | 'transport'
  | 'other';

/**
 * NEVER throws and never widens a failure: a classifier that can fail is a
 * classifier that can take down the fail-open seam it was added to observe.
 * A hostile rejection value (a `Proxy` whose traps throw, a getter that
 * explodes) classifies as `other`.
 *
 * Observability only. Nothing here decides retryability, fail-open behaviour
 * or control flow anywhere — `isRetryable` (anthropic-client.ts) remains the
 * sole authority on what is retried, and it branches on classes, not on this.
 */
export function classifyFailureCause(error: unknown): FailureCause {
  try {
    return classify(error);
  } catch {
    return 'other';
  }
}

function classify(error: unknown): FailureCause {
  if (error instanceof LlmRefusalError || error instanceof NousRefusalError) return 'refusal';
  if (error instanceof LlmTruncatedError || error instanceof NousTruncatedError) return 'truncated';
  if (error instanceof LlmMalformedResponseError) return 'unparseable';
  if (error instanceof LlmCancelledError) return 'cancelled';
  if (error instanceof LlmTimeoutError) return 'timeout';
  if (error instanceof LlmRateLimitError) return 'rate_limited';

  // `NousApiError` carries the wire status and falls through to the duck-type
  // below, which is what maps its 429/408/504 rather than a second branch.
  const status = statusOf(error);
  if (status === 429) return 'rate_limited';
  if (status === 408 || status === 504) return 'timeout';
  if (status !== undefined) return 'transport';

  if (error instanceof LlmProviderError || error instanceof NousApiError) return 'transport';

  // `AbortSignal.timeout` and `fetch`'s own abort surface as a `DOMException`
  // with these names and no status, so an aborted socket reaching an outer
  // catch is attributable without importing anything.
  const name = error instanceof Error ? error.name : undefined;
  if (name === 'AbortError') return 'cancelled';
  if (name === 'TimeoutError') return 'timeout';

  return 'other';
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}
