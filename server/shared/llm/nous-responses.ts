/**
 * The second Nous endpoint: `POST {baseUrl}/responses`, where server-side
 * tools (e.g. X search) live.
 *
 * ADR-0009 says Nous proxies `chat/completions` only; that premise is false
 * for this endpoint — verified against `~x-ai/grok-latest`, which returns
 * genuine live X retrieval (cited post ids decode to timestamps seconds
 * before the response itself, too recent to be training data). This still
 * runs inside ADR-0009's single-provider rule: same vendor, same key, same
 * spend meter, just a second endpoint.
 *
 * Transport only — no X/sentiment semantics here; those live in
 * `market-intelligence/grok/x-search-client.ts`. Endpoint-agnostic wire
 * handling (errors, token coercion, truncation) comes from `nous-wire.ts`
 * rather than being reimplemented here.
 */

import { fetchWithTimeout } from '../http/fetch-with-timeout.js';
import type { LlmInFlightGate } from './in-flight-gate.js';
import {
  buildApiError,
  clampTimeoutToBudget,
  DEFAULT_NOUS_TIMEOUT_MS,
  NousApiError,
  NousTruncatedError,
  type NousWireUsage,
  normaliseUsage,
  resolveMeteredModel,
  truncateForError,
} from './nous-wire.js';
import type { AnthropicUsage } from './pricing.js';

/**
 * A server-side tool declaration, passed through to the provider verbatim.
 *
 * Loosely typed on purpose: the tool vocabulary is the provider's and changes
 * without this repo's involvement. Narrowing it here would mean editing this
 * file to use a tool it has no other opinion about. The CALLER states the
 * shape it needs — see `x-search-client.ts`'s `XSearchTool`.
 */
interface NousServerTool {
  type: string;
  [option: string]: unknown;
}

export interface NousResponsesRequest {
  model: string;
  /** The prompt. A plain string is the Responses API's own shorthand for a single user turn. */
  input: string;
  /** Prepended as the model's instructions — the Responses API's system-turn equivalent */
  instructions?: string;
  tools?: readonly NousServerTool[];
  max_output_tokens: number;
}

/** One citation the provider attached to its answer */
export interface NousCitation {
  url: string;
  title?: string | undefined;
}

export interface NousResponsesResult {
  /** The assistant's text, concatenated across output items. Never `undefined`. */
  text: string;
  /** Normalised the same way `nousChat` does — cache-exclusive `input_tokens` */
  usage: AnthropicUsage;
  /** The model id to METER against — see `resolveMeteredModel` */
  model: string;
  /**
   * Every citation the response carried, deduplicated by URL, from BOTH the
   * top-level `citations` array and the per-content `annotations`. Both are
   * read because the provider populates them independently and neither is
   * documented as authoritative; a citation in either place is evidence the
   * tool ran.
   */
  citations: NousCitation[];
  /**
   * Server-side tool invocations to bill for (#476, `pricing.ts`).
   *
   * Nous's `usage` block has no search-invocation counter, so this is
   * estimated from distinct citations capped at the caller's
   * `max_search_results` — deliberately biased to over-count rather than
   * silently under-charge against ADR-0008's spend ceiling.
   */
  server_tool_calls: number;
  /** As reported by the provider. A truncating status throws before this returns. */
  finish_reason: string | null;
  /**
   * The provider's own timestamp for the response, in ms since epoch, when it
   * reports one.
   *
   * Load-bearing rather than decorative: it is the clock the retrieval-recency
   * check compares cited posts against (`x-search-client.ts`). Using local
   * time there would fold this machine's clock skew into a freshness
   * assertion. Null when the provider omits it — the caller must then fall
   * back explicitly rather than get a silent local-clock substitute.
   */
  created_at_ms: number | null;
  /** Time-to-first-byte, measured before the body is read — same convention as `NousChatResult` */
  ttfb_ms: number;
}

export interface NousResponsesOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs?: number;
  signal?: AbortSignal | undefined;
  /**
   * The account-wide in-flight cap (#1080) — required for the same reason
   * `NousChatOptions.gate` is. This endpoint's retrieval calls are the
   * heaviest requests in that queue, so excluding them would leave the cap
   * measuring the wrong population.
   */
  gate: LlmInFlightGate;
  /** The caller's remaining deadline for the whole call, gate wait included */
  gateBudgetMs?: number | undefined;
  /**
   * What this caller's own call is expected to take, for the gate's estimate —
   * see `LlmInFlightRequest.expectedCallMs`. Omitted means "a debate-sized
   * call", which is wrong for anything materially slower.
   */
  expectedCallMs?: number | undefined;
  /** Names this call's stage on the gate's own log lines */
  llmStage?: string | undefined;
  /**
   * Ceiling on the citation-derived ESTIMATE of `server_tool_calls` — not a
   * limit on tool calls, and not a cap on the reported count.
   *
   * Pass the caller's own `max_search_results`: one call can return up to
   * that many citations, so an unclamped count would read N results as N
   * calls. Does not bound what the provider reports — a higher `*_call` count
   * is a real billing fact and is used as-is. Omitted means unbounded.
   */
  maxServerToolCalls?: number | undefined;
  /**
   * Shrinks the network timeout by however long the gate wait already took,
   * so `gateBudgetMs` bounds wait + call rather than just the wait (#1533).
   * See `clampTimeoutToBudget`'s doc for why this is opt-in.
   */
  clampCallToBudget?: boolean | undefined;
}

/** The subset of the Responses body this reads. Everything is `unknown` — wire data, coerced not trusted. */
interface ResponsesBody {
  model?: unknown;
  created_at?: unknown;
  status?: unknown;
  incomplete_details?: { reason?: unknown } | undefined;
  usage?: NousWireUsage;
  citations?: unknown;
  output_text?: unknown;
  output?: unknown;
}

interface OutputContent {
  type?: unknown;
  text?: unknown;
  annotations?: unknown;
}

interface OutputItem {
  type?: unknown;
  content?: unknown;
}

/**
 * Pulls the assistant text out of the `output` array.
 *
 * Handles `output_text` (the SDK's flattened convenience field) and the
 * canonical `output[].content[].text` shape, because Nous has been seen to
 * send the second and the first is cheap to honour if it appears. Non-message
 * output items — reasoning summaries, tool-call records — are skipped rather
 * than concatenated: they are not the answer, and folding a reasoning summary
 * into the JSON the caller is about to parse would break it.
 */
function textPartsOf(item: OutputItem): string[] {
  if (item?.type !== undefined && item.type !== 'message') return [];
  if (!Array.isArray(item?.content)) return [];

  const parts: string[] = [];
  for (const content of item.content as OutputContent[]) {
    // `output_text` is the content-part type name; a `refusal` part is not
    // answer text and must not be parsed as though it were
    if (content?.type !== undefined && content.type !== 'output_text') continue;
    if (typeof content?.text === 'string') parts.push(content.text);
  }
  return parts;
}

function extractText(body: ResponsesBody): string {
  if (typeof body.output_text === 'string') return body.output_text;
  if (!Array.isArray(body.output)) return '';

  const parts: string[] = [];
  for (const item of body.output as OutputItem[]) {
    parts.push(...textPartsOf(item));
  }
  return parts.join('');
}

/** Reads one annotation into a citation, tolerating both the nested and flattened shapes */
function toCitation(annotation: unknown): NousCitation | null {
  if (typeof annotation !== 'object' || annotation === null) return null;
  const record = annotation as { url?: unknown; title?: unknown; url_citation?: unknown };
  const nested =
    typeof record.url_citation === 'object' && record.url_citation !== null
      ? (record.url_citation as { url?: unknown; title?: unknown })
      : undefined;

  const url = typeof nested?.url === 'string' ? nested.url : record.url;
  if (typeof url !== 'string' || url === '') return null;

  const title = typeof nested?.title === 'string' ? nested.title : record.title;
  return { url, ...(typeof title === 'string' ? { title } : {}) };
}

/**
 * How many server-side tool calls the provider reported making.
 *
 * Matches any `output` item whose `type` ends in `_call`, rather than an
 * allowlist of known tool names, so a tool added upstream that this repo has
 * never heard of still bills as a call instead of silently as zero. Returns 0
 * when the provider reports none — the caller then treats this as a floor
 * under the citation count, not the answer.
 */
function countServerToolCalls(body: ResponsesBody): number {
  if (!Array.isArray(body.output)) return 0;
  let calls = 0;
  for (const item of body.output as OutputItem[]) {
    if (typeof item?.type === 'string' && item.type.endsWith('_call')) calls += 1;
  }
  return calls;
}

function citationsFromItem(item: OutputItem): NousCitation[] {
  if (!Array.isArray(item?.content)) return [];
  const citations: NousCitation[] = [];
  for (const content of item.content as OutputContent[]) {
    if (!Array.isArray(content?.annotations)) continue;
    for (const annotation of content.annotations) {
      const citation = toCitation(annotation);
      if (citation !== null) citations.push(citation);
    }
  }
  return citations;
}

/**
 * Every citation on the response, from both places the provider puts them,
 * deduplicated by URL and in first-seen order.
 *
 * Order matters downstream: `x-search-client.ts` matches the Nth item to the
 * Nth citation when the model does not label them, so a set that reordered on
 * every call would scramble the pairing.
 */
function extractCitations(body: ResponsesBody): NousCitation[] {
  const seen = new Set<string>();
  const citations: NousCitation[] = [];

  const push = (candidate: NousCitation | null): void => {
    if (candidate === null || seen.has(candidate.url)) return;
    seen.add(candidate.url);
    citations.push(candidate);
  };

  if (Array.isArray(body.output)) {
    for (const item of body.output as OutputItem[]) {
      for (const candidate of citationsFromItem(item)) push(candidate);
    }
  }

  // Top-level `citations` is a bare string array on the observed responses
  if (Array.isArray(body.citations)) {
    for (const entry of body.citations) {
      push(typeof entry === 'string' ? { url: entry } : toCitation(entry));
    }
  }

  return citations;
}

/**
 * The Responses API's truncation signal.
 *
 * `chat/completions` says `finish_reason: 'length'`; this endpoint says
 * `status: 'incomplete'` with `incomplete_details.reason` naming the budget it
 * hit. Both mean the same expensive thing — a partial answer that must not be
 * retried at the same budget (`NousTruncatedError`). Translating here is what
 * keeps that one decision in one place.
 */
function truncationReason(body: ResponsesBody): string | null {
  if (body.status !== 'incomplete') return null;
  const reason = body.incomplete_details?.reason;
  return typeof reason === 'string' ? reason : 'incomplete';
}

/**
 * POSTs one non-streaming Responses call to Nous and normalises the reply,
 * behind the account-wide in-flight gate (#1080) — same slot discipline and
 * account queue as `nousChat`.
 */
export async function nousResponses(
  options: NousResponsesOptions,
  request: NousResponsesRequest,
): Promise<NousResponsesResult> {
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
    return await dispatchResponses(options, request, timeoutMs);
  } finally {
    slot.release();
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: a flat sequence of independent response-shape guards translating one wire failure (bad JSON, missing body, missing output, truncation) at a time into a typed error; splitting the checks apart would scatter this one wire contract across several functions.
async function dispatchResponses(
  options: NousResponsesOptions,
  request: NousResponsesRequest,
  timeoutMs: number,
): Promise<NousResponsesResult> {
  const dispatchedAt = Date.now();
  const response = await fetchWithTimeout(
    `${options.baseUrl}/responses`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify({
        model: request.model,
        input: request.input,
        ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
        ...(request.tools === undefined ? {} : { tools: request.tools }),
        max_output_tokens: request.max_output_tokens,
      }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
    timeoutMs,
  );
  // Measured before the body read, matching `nousChat` — see `ttfb_ms`
  const ttfb_ms = Date.now() - dispatchedAt;

  if (!response.ok) {
    throw await buildApiError(response);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw new NousApiError(
      response.status,
      `Nous API error: response body could not be parsed as JSON (${
        cause instanceof Error ? cause.message : String(cause)
      })`,
    );
  }

  // A 200 whose body is `null` or a primitive would otherwise reach the
  // `parsed.output` read below and throw a TypeError, which is neither of this
  // function's two documented outcomes (a result, or a `NousApiError` naming
  // what came back). Refused here so the failure is classified.
  if (typeof body !== 'object' || body === null) {
    throw new NousApiError(
      response.status,
      `Nous API error: response body was not a JSON object (${truncateForError(
        JSON.stringify(body) ?? String(body),
      )})`,
      body,
    );
  }

  const parsed = body as ResponsesBody;

  // A body with neither output nor an `output_text` field is not an empty
  // answer, it is an unreadable one — the `choices`-missing case from
  // `nousChat`, in this endpoint's vocabulary. Distinguished from a genuinely
  // empty answer (present-but-empty `output`) so a shape change surfaces as an
  // error rather than as silent NO_DATA for the rest of the soak
  if (parsed.output === undefined && parsed.output_text === undefined) {
    throw new NousApiError(
      response.status,
      `Nous API error: response body missing expected "output" (${truncateForError(
        JSON.stringify(body),
      )})`,
      body,
    );
  }

  const usage = normaliseUsage(parsed.usage);
  const truncated = truncationReason(parsed);
  if (truncated !== null) {
    throw new NousTruncatedError(request.model, request.max_output_tokens, usage);
  }

  const citations = extractCitations(parsed);

  // Nous's `usage` block carries tokens only, no search count, so part of
  // this is an estimate — deliberately biased high, since a spend cap fed an
  // under-count is not a cap.
  //
  // `countServerToolCalls` is a REPORTED FACT and is never clamped: the
  // provider will bill for what it says it did regardless of
  // `maxServerToolCalls`. `citations.length` is an ESTIMATE, needed because a
  // provider that omits call items would otherwise bill zero even for a
  // search that ran and found nothing; it IS clamped by `maxServerToolCalls`,
  // since one call can return up to that many citations. Taking the max of
  // the two keeps both properties.
  const toolCalls = countServerToolCalls(parsed);
  const ceiling = options.maxServerToolCalls;
  const estimatedFromCitations =
    ceiling === undefined ? citations.length : Math.min(citations.length, ceiling);
  const server_tool_calls = Math.max(toolCalls, estimatedFromCitations);

  return {
    text: extractText(parsed),
    usage,
    model: resolveMeteredModel(parsed.model, request.model),
    citations,
    server_tool_calls,
    finish_reason: typeof parsed.status === 'string' ? parsed.status : null,
    // The Responses API reports SECONDS since epoch; every other clock in
    // this repo is milliseconds. Converting at the boundary keeps the
    // 1000x mistake from reaching the recency comparison, where it would
    // read as a 1970 timestamp and silently fail every post
    created_at_ms:
      typeof parsed.created_at === 'number' && Number.isFinite(parsed.created_at)
        ? parsed.created_at * 1000
        : null,
    ttfb_ms,
  };
}
