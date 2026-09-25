import type {
  AnthropicMessageRequest,
  AnthropicMessagesClient,
} from '../../pipeline/debate-engine/index.js';
import {
  LlmProviderError,
  LlmRateLimitError,
  LlmRefusalError,
  LlmTruncatedError,
} from '../../pipeline/debate-engine/index.js';
import type { Logger } from '../../shared/index.js';
import type { AnthropicUsage, LlmInFlightGate } from '../../shared/llm/index.js';
import type { ModelPin } from './models.js';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const DEFAULT_LLM_TIMEOUT_MS = 60_000;
const ERROR_BODY_PREVIEW_CHARS = 200;

export interface HttpTransportOptions {
  readonly apiKey: string;
  readonly pin: ModelPin;
  readonly gate: LlmInFlightGate;
  readonly logger?: Logger | undefined;
  readonly timeoutMs?: number | undefined;
  readonly url?: string | undefined;
  readonly fetchImpl?: FetchLike | undefined;
}

export interface WireReply {
  readonly text: string;
  readonly usage: AnthropicUsage;
  readonly finish: 'stop' | 'length' | 'refusal' | 'other';
  readonly upstreamModel: string | undefined;
}

export interface WireCodec {
  readonly url: string;
  headers(apiKey: string): Record<string, string>;
  body(request: AnthropicMessageRequest): unknown;
  decode(json: unknown): WireReply;
}

interface PostResult {
  readonly status: number;
  readonly json: unknown;
  readonly retryAfterMs: number | undefined;
  readonly ttfbMs: number;
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  fetchImpl: FetchLike,
): Promise<PostResult> {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal !== undefined) signals.push(signal);
  const startedAt = Date.now();
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.any(signals),
  });
  const ttfbMs = Date.now() - startedAt;
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, ERROR_BODY_PREVIEW_CHARS) };
  }
  const retryAfter = response.headers.get('retry-after');
  const retryAfterMs =
    retryAfter !== null && Number.isFinite(Number(retryAfter))
      ? Number(retryAfter) * 1000
      : undefined;
  return { status: response.status, json, retryAfterMs, ttfbMs };
}

function describeBody(json: unknown): string {
  return JSON.stringify(json).slice(0, ERROR_BODY_PREVIEW_CHARS);
}

function raiseForStatus(result: PostResult, pin: ModelPin): void {
  if (result.status >= 200 && result.status < 300) return;
  if (result.status === 429) {
    throw new LlmRateLimitError(
      `${pin.provider} rate limited ${pin.wire}: ${describeBody(result.json)}`,
      result.retryAfterMs,
    );
  }
  throw new LlmProviderError(
    `${pin.provider} HTTP ${result.status} for ${pin.wire}: ${describeBody(result.json)}`,
  );
}

function raiseForUpstreamModel(reply: WireReply, pin: ModelPin): void {
  if (reply.upstreamModel === undefined || reply.upstreamModel === pin.wire) return;
  throw new LlmProviderError(
    `${pin.provider} answered for ${pin.wire} with model ${reply.upstreamModel}: refused, the pin is a trial`,
  );
}

function raiseForFinish(reply: WireReply, request: AnthropicMessageRequest, pin: ModelPin): void {
  if (reply.finish === 'refusal') {
    throw new LlmRefusalError(`${pin.wire} refused the request`, 'refusal', reply.usage);
  }
  if (reply.finish === 'length') {
    throw new LlmTruncatedError(
      `${pin.wire} hit max_tokens=${request.max_tokens}`,
      pin.wire,
      request.max_tokens,
      reply.usage,
    );
  }
}

export class HttpMessagesTransport implements AnthropicMessagesClient {
  readonly #fetchImpl: FetchLike;
  readonly #timeoutMs: number;
  readonly #url: string;

  constructor(
    private readonly options: HttpTransportOptions,
    private readonly codec: WireCodec,
  ) {
    this.#fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
    this.#url = options.url ?? codec.url;
  }

  async createMessage(
    request: AnthropicMessageRequest,
    callOptions: { signal?: AbortSignal | undefined; stage?: string | undefined } = {},
  ) {
    const { pin } = this.options;
    if (request.model !== pin.wire) {
      throw new LlmProviderError(
        `transport for ${pin.wire} refused a request for model ${request.model}`,
      );
    }
    const slot = await this.options.gate.acquire({
      signal: callOptions.signal,
      llmStage: callOptions.stage,
      expectedCallMs: this.#timeoutMs,
    });
    try {
      const result = await postJson(
        this.#url,
        this.codec.headers(this.options.apiKey),
        this.codec.body(request),
        this.#timeoutMs,
        callOptions.signal,
        this.#fetchImpl,
      );
      raiseForStatus(result, pin);
      const reply = this.codec.decode(result.json);
      this.#logUpstreamModel(reply, callOptions.stage);
      raiseForUpstreamModel(reply, pin);
      raiseForFinish(reply, request, pin);
      return {
        content: [{ type: 'text', text: reply.text }],
        usage: reply.usage,
        stop_reason: reply.finish === 'stop' ? 'end_turn' : reply.finish,
        model: pin.priced,
        ttfb_ms: result.ttfbMs,
      };
    } finally {
      slot.release();
    }
  }

  #logUpstreamModel(reply: WireReply, stage: string | undefined): void {
    this.options.logger?.log({
      trace_id: 'v2-llm',
      stage: stage ?? 'v2',
      level: 'info',
      event: 'v2_llm_upstream_model',
      message: `${this.options.pin.wire} answered as ${reply.upstreamModel ?? 'unreported'}`,
      payload: {
        pinned: this.options.pin.wire,
        upstream: reply.upstreamModel,
        finish: reply.finish,
      },
    });
  }
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

export function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
