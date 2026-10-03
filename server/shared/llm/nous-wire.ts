import { parseRetryAfterMs, truncateForError } from '../http/response-errors.js';
import type { LlmInFlightGate } from './in-flight-gate.js';
import { type AnthropicUsage, rateFor } from './pricing.js';

export { truncateForError };

const DEFAULT_NOUS_TIMEOUT_MS = 60_000;

export class NousApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly retryAfterMs: number | undefined;

  constructor(status: number, message: string, body?: unknown, retryAfterMs?: number) {
    super(message);
    this.name = 'NousApiError';
    this.status = status;
    this.body = body;
    this.retryAfterMs = retryAfterMs;
  }
}

export class NousTruncatedError extends Error {
  readonly model: string;
  readonly max_tokens: number;
  readonly usage: { input_tokens: number; output_tokens: number };

  constructor(
    model: string,
    max_tokens: number,
    usage: { input_tokens: number; output_tokens: number },
  ) {
    const output_tokens = usage.output_tokens;
    super(
      `Nous response truncated: ${model} hit finish_reason="length" after ${output_tokens} ` +
        `output tokens against max_tokens=${max_tokens}. Not retried — a retry at the same ` +
        'budget fails identically and bills again. Raise max_tokens or choose a model that ' +
        'does not spend the budget on hidden reasoning tokens.',
    );
    this.name = 'NousTruncatedError';
    this.model = model;
    this.max_tokens = max_tokens;
    this.usage = usage;
  }
}

export class NousRefusalError extends Error {
  readonly model: string;
  readonly signal: string;
  readonly usage: { input_tokens: number; output_tokens: number };

  constructor(
    model: string,
    signal: string,
    usage: { input_tokens: number; output_tokens: number },
    detail?: string,
  ) {
    super(
      `Nous response refused: ${model} signalled ${signal} after ${usage.output_tokens} ` +
        `output tokens${detail === undefined ? '' : ` (${truncateForError(detail)})`}. ` +
        'Not retried — the model declined this prompt, and every retry re-bills the same ' +
        'refusal. Change the prompt or the model.',
    );
    this.name = 'NousRefusalError';
    this.model = model;
    this.signal = signal;
    this.usage = usage;
  }
}

interface NousErrorBody {
  readonly error?: { readonly type?: unknown; readonly message?: unknown } | null;
}

function describeErrorBody(body: unknown): string | undefined {
  const detail = (body as NousErrorBody | null | undefined)?.error;
  const message = detail?.message;
  if (typeof message !== 'string') return undefined;
  return `${typeof detail?.type === 'string' ? detail.type : 'error'}: ${message}`;
}

const HTTP_DATE_PATTERN = /[a-z]/i;

function retryAfterMsOf(response: Response, nowMs: number): number | undefined {
  const header = response.headers.get('retry-after') ?? '';
  if (!HTTP_DATE_PATTERN.test(header)) return parseRetryAfterMs(response);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - nowMs);
}

export async function buildApiError(response: Response): Promise<NousApiError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const detail = truncateForError(describeErrorBody(body) ?? response.statusText);
  return new NousApiError(
    response.status,
    `Nous API error: ${response.status} ${detail}`,
    body,
    retryAfterMsOf(response, Date.now()),
  );
}

function toTokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function clampTimeoutToBudget(
  configuredTimeoutMs: number,
  gateBudgetMs: number | undefined,
  elapsedMs: number,
): number {
  if (gateBudgetMs === undefined) return configuredTimeoutMs;
  return Math.max(0, Math.min(configuredTimeoutMs, gateBudgetMs - elapsedMs));
}

export function resolveMeteredModel(echoed: unknown, requested: string): string {
  return typeof echoed === 'string' && rateFor(echoed) !== null ? echoed : requested;
}

export interface NousGateOptions {
  timeoutMs?: number;
  signal?: AbortSignal | undefined;
  gate: LlmInFlightGate;
  gateBudgetMs?: number | undefined;
  expectedCallMs?: number | undefined;
  llmStage?: string | undefined;
  clampCallToBudget?: boolean | undefined;
}

export async function withNousGateSlot<T>(
  options: NousGateOptions,
  dispatch: (timeoutMs: number) => Promise<T>,
): Promise<T> {
  const enteredAt = Date.now();
  const slot = await options.gate.acquire({
    budgetMs: options.gateBudgetMs,
    expectedCallMs: options.expectedCallMs,
    signal: options.signal,
    llmStage: options.llmStage,
  });
  try {
    const configuredTimeoutMs = options.timeoutMs ?? DEFAULT_NOUS_TIMEOUT_MS;
    const timeoutMs =
      options.clampCallToBudget === true
        ? clampTimeoutToBudget(configuredTimeoutMs, options.gateBudgetMs, Date.now() - enteredAt)
        : configuredTimeoutMs;
    return await dispatch(timeoutMs);
  } finally {
    slot.release();
  }
}

export async function parseNousJsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    throw new NousApiError(
      response.status,
      `Nous API error: response body could not be parsed as JSON (${
        cause instanceof Error ? cause.message : String(cause)
      })`,
    );
  }
}

export interface NousWireUsage {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  prompt_tokens_details?: { cached_tokens?: unknown } | undefined;
  input_tokens?: unknown;
  output_tokens?: unknown;
  input_tokens_details?: { cached_tokens?: unknown } | undefined;
}

export function normaliseUsage(usage: NousWireUsage | undefined): AnthropicUsage {
  const promptTokens = toTokenCount(usage?.prompt_tokens ?? usage?.input_tokens);
  const cachedTokens = toTokenCount(
    usage?.prompt_tokens_details?.cached_tokens ?? usage?.input_tokens_details?.cached_tokens,
  );
  const cacheRead = Math.min(cachedTokens, promptTokens);

  return {
    input_tokens: Math.max(0, promptTokens - cacheRead),
    output_tokens: toTokenCount(usage?.completion_tokens ?? usage?.output_tokens),
    cache_read_input_tokens: cacheRead,
  };
}
