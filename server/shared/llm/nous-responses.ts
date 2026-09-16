/**
 * The second Nous endpoint: `POST {baseUrl}/responses`, which is where
 * SERVER-SIDE TOOLS live.
 *
 * ## Why this exists at all — the correction
 *
 * ADR-0009 recorded that "Nous proxies `chat/completions` only", and every
 * downstream comment in this repo inherited that: `pricing.ts` called its
 * server-tool arithmetic inert "because ADR-0009", `nous-sentiment-client.ts`
 * hard-coded `retrievalEvidence: false`, and #485/#969 were both framed as
 * needing a second vendor to get retrieval back.
 *
 * The premise was false. Probed live on 2026-09-03 with the credential this
 * system already holds:
 *
 *   - `POST {baseUrl}/responses` returns 200. Nous serves the Responses API.
 *   - `tools: [{ type: 'x_search' }]` 400s on the PINNED `x-ai/grok-4.5`:
 *     "Server-side search tools are not available for model 'x-ai/grok-4.5'.
 *     They are supported only on OpenRouter-routed models."
 *   - The same call on the routed alias `~x-ai/grok-latest` returns 200 with
 *     live X retrieval — post text, handles, timestamps, a top-level
 *     `citations` array and per-content `annotations[].url_citation`.
 *
 * Retrieval verified GENUINE offline, not merely claimed: snowflake-decoding
 * the cited status ids (`(id >> 22n) + 1288834974657n` ms) put the posts 40-80
 * seconds before the response's own `created_at`. No training corpus contains
 * a post from forty seconds ago.
 *
 * So this runs INSIDE ADR-0009's single-provider rule. Same vendor, same key,
 * same spend meter — a second endpoint, not a second provider.
 *
 * ## What this module deliberately does NOT do
 *
 * It does not know about X, sentiment, or market intelligence. It is a
 * transport: request in, text + usage + citations out.
 * `market-intelligence/grok/x-search-client.ts` owns the X semantics
 * (recency filtering, evidence matching, scoring). Keeping that split is what
 * lets a future server-side tool reuse this without inheriting X's rules.
 *
 * Everything endpoint-agnostic — the error envelope, token coercion, the
 * meter's model resolution, the truncation refusal — comes from
 * `nous-wire.ts` rather than being reimplemented here. `nous-chat.ts` warned
 * that its `finish_reason` handling "is a money bug if it is implemented once
 * and forgotten once"; this module is the case that warning anticipated.
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
export interface NousServerTool {
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
   * Server-side tool invocations to BILL for (#476, `pricing.ts`).
   *
   * COUNTED, NOT REPORTED — and that distinction is the point. Nous's `usage`
   * block carries tokens only; there is no search-invocation counter on the
   * wire. So this is derived from the number of distinct citations, capped at
   * the `max_search_results` the caller asked for, which is a deliberate
   * conservative UPPER BOUND: it cannot exceed what the caller authorised, and
   * where it is wrong it is wrong in the over-charging direction. A meter that
   * guesses low spends past ADR-0008's ceiling; one that guesses high stops
   * trading early and gets noticed.
   *
   * The V3 reconciliation against the portal invoice is what replaces this
   * estimate with a measurement. If that shows the fee is already folded into
   * the token charge, `SERVER_TOOL_USD_PER_CALL` goes to zero and this count
   * stays as a diagnostic.
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
   * The account-wide in-flight cap (#1080) — REQUIRED for the reason
   * `NousChatOptions.gate` is. This endpoint's retrieval calls are the
   * HEAVIEST things this process puts in that queue (5–26 s measured on
   * 2026-09-14), so leaving them outside the cap would leave the cap
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
   * Ceiling on the CITATION-DERIVED ESTIMATE of `server_tool_calls` — not a
   * limit on tool calls, and not a cap on the reported count.
   *
   * Pass the caller's own `max_search_results`. The estimate exists because a
   * provider that reports no call items would otherwise bill zero, and it
   * needs this bound because one call returns up to `max_search_results`
   * citations — unclamped, N results would read as N calls.
   *
   * It does NOT bound what the provider says it did. If the response reports
   * more `*_call` items than this, that is a fact about what will be billed
   * and the higher number is used (review round 2, #1055 — an earlier version
   * of this comment called it a plain ceiling while the code let reported
   * calls exceed it, which was the docs being wrong rather than the code).
   * Nothing here limits the provider; only `max_search_results` on the request
   * does that.
   *
   * Omitted means the estimate is unbounded, which is only correct for a tool
   * with no result cap.
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
function extractText(body: ResponsesBody): string {
  if (typeof body.output_text === 'string') return body.output_text;
  if (!Array.isArray(body.output)) return '';

  const parts: string[] = [];
  for (const item of body.output as OutputItem[]) {
    if (item?.type !== undefined && item.type !== 'message') continue;
    if (!Array.isArray(item?.content)) continue;
    for (const content of item.content as OutputContent[]) {
      // `output_text` is the content-part type name; a `refusal` part is not
      // answer text and must not be parsed as though it were
      if (content?.type !== undefined && content.type !== 'output_text') continue;
      if (typeof content?.text === 'string') parts.push(content.text);
    }
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
 * Every citation on the response, from both places the provider puts them,
 * deduplicated by URL and in first-seen order.
 *
 * Order matters downstream: `x-search-client.ts` matches the Nth item to the
 * Nth citation when the model does not label them, so a set that reordered on
 * every call would scramble the pairing.
 */
/**
 * How many server-side tool calls the provider reported making.
 *
 * The Responses API reports each one as its own `output` item whose `type`
 * names the tool and ends in `_call` — `x_search_call`, `web_search_call`.
 * Matching the SUFFIX rather than an allowlist of tool names is deliberate:
 * this number feeds the spend cap, and a tool added upstream that this repo
 * has never heard of should bill as a call rather than silently as zero. The
 * cost of the loose match is over-charging for a hypothetical `_call` item
 * that is free, which is the safe direction.
 *
 * Returns 0 when `output` is absent or carries no such item — the provider may
 * simply not report them, which is why the caller treats this as a FLOOR under
 * the citation count rather than as the answer.
 */
function countServerToolCalls(body: ResponsesBody): number {
  if (!Array.isArray(body.output)) return 0;
  let calls = 0;
  for (const item of body.output as OutputItem[]) {
    if (typeof item?.type === 'string' && item.type.endsWith('_call')) calls += 1;
  }
  return calls;
}

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
      if (!Array.isArray(item?.content)) continue;
      for (const content of item.content as OutputContent[]) {
        if (!Array.isArray(content?.annotations)) continue;
        for (const annotation of content.annotations) push(toCitation(annotation));
      }
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
 * behind the account-wide in-flight gate (#1080) — same slot discipline as
 * `nousChat`, and the same account queue
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

  // Nous's `usage` block carries TOKENS ONLY — no search count — so part of
  // this is an estimate, and the direction it errs in is the whole point: a
  // spend cap fed an under-count is not a cap
  //
  // Two sources, and they are NOT the same kind of thing (review round 2,
  // #1055 — the earlier code blurred them and its clamp contradicted its own
  // docs):
  //
  // - `countServerToolCalls` is a REPORTED FACT. The provider says it made
  //   these calls, so it will bill for them, and `maxServerToolCalls` cannot
  //   make that untrue. It is never clamped.
  // - `citations.length` is an ESTIMATE, used because a provider that does not
  //   report call items would otherwise bill zero — including for the case
  //   that matters most, a search that RAN and returned nothing. This one IS
  //   clamped by `maxServerToolCalls`, which is what that option was always
  //   for: one call returns up to `max_search_results` citations, so an
  //   unclamped citation count reads N results as N calls
  //
  // Taking the max keeps the deliberate over-charge when many citations come
  // back from one call, and keeps the floor when few or none do
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
