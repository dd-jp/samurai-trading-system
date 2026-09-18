import type { RetryConfig } from '../../../shared/index.js';
import type { AnalystView } from '../types.js';

export interface LlmRequestContext {
  analyst_views: AnalystView[];
  debate_state?: Record<string, unknown>;
  attribution?: LlmAttribution;
}

interface LlmAttribution {
  trace_id?: string | undefined;
  stage?: string | undefined;
  debate_id?: string | undefined;
  prompt_template_hash?: string | undefined;
  gate_stage?: string | undefined;
}

export const LLM_CONTEXT_FIELD_KIND = {
  analyst_views: 'prompt',
  debate_state: 'prompt',
  attribution: 'meter',
} satisfies Record<keyof LlmRequestContext, 'prompt' | 'meter'>;

export interface LlmRequest<T> {
  prompt: string;
  context: LlmRequestContext;
  parseResponse: (rawText: string) => { valid: true; data: T } | { valid: false; reason: string };
  signal?: AbortSignal | undefined;
}

export interface LlmResponse<T> {
  data: T;
  raw_text: string;
  latency_ms: number;
}

export interface LlmClient {
  complete<T>(request: LlmRequest<T>): Promise<LlmResponse<T>>;
}

export type LlmRetryConfig = RetryConfig;
