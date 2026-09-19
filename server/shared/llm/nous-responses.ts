import { fetchWithTimeout } from '../http/fetch-with-timeout.js';
import {
  buildApiError,
  NousApiError,
  type NousGateOptions,
  NousTruncatedError,
  type NousWireUsage,
  normaliseUsage,
  parseNousJsonBody,
  resolveMeteredModel,
  truncateForError,
  withNousGateSlot,
} from './nous-wire.js';
import type { AnthropicUsage } from './pricing.js';

interface NousServerTool {
  type: string;
  [option: string]: unknown;
}

export interface NousResponsesRequest {
  model: string;
  input: string;
  instructions?: string;
  tools?: readonly NousServerTool[];
  max_output_tokens: number;
}

export interface NousCitation {
  url: string;
  title?: string | undefined;
}

export interface NousResponsesResult {
  text: string;
  usage: AnthropicUsage;
  model: string;
  citations: NousCitation[];
  server_tool_calls: number;
  finish_reason: string | null;
  created_at_ms: number | null;
  ttfb_ms: number;
}

export interface NousResponsesOptions extends NousGateOptions {
  apiKey: string;
  baseUrl: string;
  maxServerToolCalls?: number | undefined;
}

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

function isMessageItem(item: OutputItem): boolean {
  return item?.type === undefined || item.type === 'message';
}

function textOfOutputContent(content: OutputContent): string | null {
  if (content?.type !== undefined && content.type !== 'output_text') return null;
  return typeof content?.text === 'string' ? content.text : null;
}

function textPartsOf(item: OutputItem): string[] {
  if (!isMessageItem(item)) return [];
  if (!Array.isArray(item?.content)) return [];

  const parts: string[] = [];
  for (const content of item.content as OutputContent[]) {
    const text = textOfOutputContent(content);
    if (text !== null) parts.push(text);
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

function nestedUrlCitation(record: {
  url_citation?: unknown;
}): { url?: unknown; title?: unknown } | undefined {
  return typeof record.url_citation === 'object' && record.url_citation !== null
    ? (record.url_citation as { url?: unknown; title?: unknown })
    : undefined;
}

function preferString(nested: unknown, fallback: unknown): unknown {
  return typeof nested === 'string' ? nested : fallback;
}

function toCitation(annotation: unknown): NousCitation | null {
  if (typeof annotation !== 'object' || annotation === null) return null;
  const record = annotation as { url?: unknown; title?: unknown; url_citation?: unknown };
  const nested = nestedUrlCitation(record);

  const url = preferString(nested?.url, record.url);
  if (typeof url !== 'string' || url === '') return null;

  const title = preferString(nested?.title, record.title);
  return { url, ...(typeof title === 'string' ? { title } : {}) };
}

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

  if (Array.isArray(body.citations)) {
    for (const entry of body.citations) {
      push(typeof entry === 'string' ? { url: entry } : toCitation(entry));
    }
  }

  return citations;
}

function truncationReason(body: ResponsesBody): string | null {
  if (body.status !== 'incomplete') return null;
  const reason = body.incomplete_details?.reason;
  return typeof reason === 'string' ? reason : 'incomplete';
}

export async function nousResponses(
  options: NousResponsesOptions,
  request: NousResponsesRequest,
): Promise<NousResponsesResult> {
  return withNousGateSlot(options, (timeoutMs) => dispatchResponses(options, request, timeoutMs));
}

function buildResponsesRequestBody(request: NousResponsesRequest): Record<string, unknown> {
  return {
    model: request.model,
    input: request.input,
    ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
    ...(request.tools === undefined ? {} : { tools: request.tools }),
    max_output_tokens: request.max_output_tokens,
  };
}

function buildResponsesFetchInit(
  options: NousResponsesOptions,
  request: NousResponsesRequest,
): RequestInit {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify(buildResponsesRequestBody(request)),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

function estimateServerToolCalls(
  parsed: ResponsesBody,
  citations: readonly NousCitation[],
  maxServerToolCalls: number | undefined,
): number {
  const toolCalls = countServerToolCalls(parsed);
  const estimatedFromCitations =
    maxServerToolCalls === undefined
      ? citations.length
      : Math.min(citations.length, maxServerToolCalls);
  return Math.max(toolCalls, estimatedFromCitations);
}

function createdAtMsOf(parsed: ResponsesBody): number | null {
  return typeof parsed.created_at === 'number' && Number.isFinite(parsed.created_at)
    ? parsed.created_at * 1000
    : null;
}

function finishReasonOf(parsed: ResponsesBody): string | null {
  return typeof parsed.status === 'string' ? parsed.status : null;
}

async function dispatchResponses(
  options: NousResponsesOptions,
  request: NousResponsesRequest,
  timeoutMs: number,
): Promise<NousResponsesResult> {
  const dispatchedAt = Date.now();
  const response = await fetchWithTimeout(
    `${options.baseUrl}/responses`,
    buildResponsesFetchInit(options, request),
    timeoutMs,
  );
  const ttfb_ms = Date.now() - dispatchedAt;

  if (!response.ok) {
    throw await buildApiError(response);
  }

  const body = await parseNousJsonBody(response);

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

  return {
    text: extractText(parsed),
    usage,
    model: resolveMeteredModel(parsed.model, request.model),
    citations,
    server_tool_calls: estimateServerToolCalls(parsed, citations, options.maxServerToolCalls),
    finish_reason: finishReasonOf(parsed),
    created_at_ms: createdAtMsOf(parsed),
    ttfb_ms,
  };
}
