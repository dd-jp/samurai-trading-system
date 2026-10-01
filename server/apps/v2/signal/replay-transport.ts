import type {
  AnthropicMessageRequest,
  AnthropicMessageResponse,
  AnthropicMessagesClient,
} from '../../../pipeline/debate-engine/index.js';
import {
  LlmMalformedResponseError,
  LlmProviderError,
  LlmRateLimitError,
  LlmRefusalError,
  LlmTimeoutError,
  LlmTruncatedError,
  MAX_CAPTURED_PROMPT_CHARS,
  MAX_CAPTURED_RESPONSE_CHARS,
  wrapUntrusted,
} from '../../../pipeline/debate-engine/index.js';
import { maskAndCap } from '../../../shared/index.js';
import type { NewsSource } from '../data/index.js';
import { NO_HEADLINES_KEY_POINT } from './debate-sleeve.js';
import type { ModelPin } from './models.js';

export interface LoggedCall {
  readonly id: number;
  readonly traceId: string;
  readonly model: string;
  readonly prompt: string;
  readonly response: string | null;
  readonly stopReason: string | null;
  readonly errorClass: string | null;
  readonly errorMessage: string | null;
}

export type ReplayMissKind = 'request_not_logged' | 'response_not_logged' | 'response_truncated';

export interface ReplayMiss {
  readonly kind: ReplayMissKind;
  readonly model: string;
  readonly prompt: string;
  readonly nearest: LoggedCall | undefined;
  readonly offset: number;
}

// The view timestamps are wall-clock reads at decision time; inputs_hash leaves them out too
const VIEW_TIMESTAMP = /"timestamp": "\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"/g;
const TRUNCATION_SUFFIX = /… \(truncated, \d+ chars total\)$/;

export function promptIdentity(prompt: string): string {
  return prompt.replace(VIEW_TIMESTAMP, '"timestamp": "<view clock>"');
}

export function loggedPromptOf(content: string): string {
  return maskAndCap(content, MAX_CAPTURED_PROMPT_CHARS);
}

export function isTruncatedResponse(response: string): boolean {
  return response.length > MAX_CAPTURED_RESPONSE_CHARS && TRUNCATION_SUFFIX.test(response);
}

export function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

function missKindOf(call: LoggedCall | undefined): ReplayMissKind | undefined {
  if (call === undefined) return 'request_not_logged';
  if (call.errorClass !== null) return undefined;
  if (call.response === null) return 'response_not_logged';
  return isTruncatedResponse(call.response) ? 'response_truncated' : undefined;
}

export class ReplayLog {
  readonly misses: ReplayMiss[] = [];
  readonly #unserved: LoggedCall[];

  constructor(calls: readonly LoggedCall[]) {
    this.#unserved = [...calls].sort((left, right) => left.id - right.id);
  }

  unserved(): readonly LoggedCall[] {
    return this.#unserved;
  }

  serve(model: string, content: string): LoggedCall {
    const identity = promptIdentity(loggedPromptOf(content));
    const index = this.#unserved.findIndex(
      (call) => call.model === model && promptIdentity(call.prompt) === identity,
    );
    const call = this.#unserved[index];
    const kind = missKindOf(call);
    if (kind !== undefined) throw this.#miss(kind, model, identity, call);
    const [served] = this.#unserved.splice(index, 1) as [LoggedCall];
    return served;
  }

  #miss(
    kind: ReplayMissKind,
    model: string,
    identity: string,
    matched: LoggedCall | undefined,
  ): LlmProviderError {
    const nearest = matched ?? this.#nearest(model, identity);
    const offset =
      nearest === undefined ? 0 : commonPrefixLength(identity, promptIdentity(nearest.prompt));
    this.misses.push({ kind, model, prompt: identity, nearest, offset });
    return new LlmProviderError(`replay: ${kind} for ${model}; no model is called in a replay`);
  }

  #nearest(model: string, identity: string): LoggedCall | undefined {
    let best: LoggedCall | undefined;
    let bestLength = -1;
    for (const call of this.#unserved) {
      if (call.model !== model) continue;
      const length = commonPrefixLength(identity, promptIdentity(call.prompt));
      if (length > bestLength) [best, bestLength] = [call, length];
    }
    return best;
  }
}

type FailureFactory = (message: string, detail: string | undefined) => Error;

// Rebuilt by class because retries and the latency budget branch on it; the decision reason
// carries only the message
const REPLAYED_FAILURES: Readonly<Record<string, FailureFactory>> = {
  LlmTimeoutError: (message, source) =>
    new LlmTimeoutError(message, source === 'status' ? 'status' : 'deadline'),
  LlmRateLimitError: (message) => new LlmRateLimitError(message),
  LlmMalformedResponseError: (message) =>
    Object.assign(new LlmMalformedResponseError(''), { message }),
  LlmRefusalError: (message) => new LlmRefusalError(message, 'replayed'),
  LlmTruncatedError: (message) => new LlmTruncatedError(message, 'replayed', 0),
};

function replayedFailure(errorClass: string, message: string): Error {
  const [name = '', detail] = errorClass.split(':');
  const factory = REPLAYED_FAILURES[name];
  return factory === undefined ? new LlmProviderError(message) : factory(message, detail);
}

export class ReplayTransport implements AnthropicMessagesClient {
  constructor(
    private readonly pin: ModelPin,
    private readonly log: ReplayLog,
  ) {}

  createMessage(request: AnthropicMessageRequest): Promise<AnthropicMessageResponse> {
    try {
      const call = this.log.serve(this.pin.priced, request.messages[0]?.content ?? '');
      if (call.errorClass !== null) {
        return Promise.reject(replayedFailure(call.errorClass, call.errorMessage ?? ''));
      }
      return Promise.resolve({
        content: [{ type: 'text', text: call.response ?? '' }],
        usage: { input_tokens: 0, output_tokens: 0 },
        stop_reason: call.stopReason ?? 'end_turn',
        model: this.pin.priced,
      });
    } catch (error) {
      return Promise.reject(error);
    }
  }
}

const [CONTEXT_OPEN = '', CONTEXT_CLOSE = ''] = wrapUntrusted('\u0000').split('\u0000');
const CONTEXT_MARKER = `\n\nContext:\n${CONTEXT_OPEN}`;

interface PromptContext {
  readonly analyst_views?: readonly { analyst_id?: unknown; key_points?: unknown }[];
}

function contextOf(prompt: string): PromptContext | undefined {
  const start = prompt.lastIndexOf(CONTEXT_MARKER);
  if (start < 0 || !prompt.endsWith(CONTEXT_CLOSE)) return undefined;
  const json = prompt.slice(start + CONTEXT_MARKER.length, prompt.length - CONTEXT_CLOSE.length);
  try {
    return JSON.parse(json) as PromptContext;
  } catch {
    return undefined;
  }
}

function newsKeyPoints(prompt: string): readonly string[] | undefined {
  const view = contextOf(prompt)?.analyst_views?.find((entry) => entry.analyst_id === 'news');
  const points = view?.key_points;
  return Array.isArray(points) && points.every((point) => typeof point === 'string')
    ? points
    : undefined;
}

export function loggedHeadlines(
  calls: readonly LoggedCall[],
  traceId: string,
): readonly string[] | undefined {
  const call = calls.find((candidate) => candidate.traceId === traceId);
  const points = call === undefined ? undefined : newsKeyPoints(call.prompt);
  if (points === undefined) return undefined;
  return points.length === 1 && points[0] === NO_HEADLINES_KEY_POINT ? [] : points;
}

// US headlines are journalled only inside the debate prompts that carried them, so a replay
// reads them back from there; a name with no recoverable prompt replays as a news failure
export function loggedNewsSource(calls: readonly LoggedCall[]): NewsSource {
  return {
    headlines: (symbol, tradingDate) => {
      const headlines = loggedHeadlines(calls, `v2-${tradingDate}-${symbol}`);
      return headlines === undefined
        ? Promise.reject(new Error(`replay: no logged prompt carries the headlines for ${symbol}`))
        : Promise.resolve(headlines);
    },
  };
}
