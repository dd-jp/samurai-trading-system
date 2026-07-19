/**
 * Debate Engine (Stage 2) — see docs/specs/debate-engine-spec.md, epic #40.
 * Implemented ticket-by-ticket starting with #24.
 */

export type { DebateLog, DebateLogStore } from '../shared/types.js';
export type { AnalystCollectionResult, ExpectedAnalyst } from './analyst-response-collector.js';
export { collectAnalystViews, validateAnalystView } from './analyst-response-collector.js';
export { computeDebateId } from './debate-id.js';
export { buildDebateLog, InMemoryDebateLogStore } from './debate-log-store.js';
export type {
  DebateAnalystFailure,
  DebateLogger,
  DebatePersona,
  LogSink,
} from './debate-logger.js';
export { JsonDebateLogger } from './debate-logger.js';
export type {
  AnthropicLlmClientConfig,
  AnthropicMessageRequest,
  AnthropicMessageResponse,
  AnthropicMessagesClient,
} from './llm/anthropic-client.js';
export { AnthropicLlmClient } from './llm/anthropic-client.js';
export type { LlmError } from './llm/errors.js';
export {
  LlmMalformedResponseError,
  LlmProviderError,
  LlmRateLimitError,
  LlmTimeoutError,
} from './llm/errors.js';
export { MockLlmClient } from './llm/mock-client.js';
export type {
  LlmClient,
  LlmRequest,
  LlmRequestContext,
  LlmResponse,
  LlmRetryConfig,
} from './llm/types.js';
export type { AnalystContribution, AnalystView, DebateResult, Direction } from './types.js';
