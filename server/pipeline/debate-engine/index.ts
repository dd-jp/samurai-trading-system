/**
 * Debate Engine (Stage 2) — see docs/specs/debate-engine-spec.md, epic #40.
 * Implemented ticket-by-ticket starting with #24.
 */

// Re-exported from `shared/llm` rather than owned here: the sentiment agent
// prices against the same table, and `shared/llm/nous-config.ts` reads it to
// refuse an unpriced model at startup. Kept on this barrel because the debate
// engine's spend meter is still its principal consumer.
export type { AnthropicUsage, ModelRate } from '../../shared/llm/pricing.js';
export {
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  MODEL_RATES,
  pricedModels,
  priceUsage,
  rateFor,
} from '../../shared/llm/pricing.js';
export type { DebateLog, DebateLogStore, DebateTermination } from '../../shared/types.js';
export type { AnalystRoundStance } from './analyst-contribution.js';
export { buildAnalystContributions } from './analyst-contribution.js';
export type { AnalystCollectionResult, ExpectedAnalyst } from './analyst-response-collector.js';
export { collectAnalystViews, validateAnalystView } from './analyst-response-collector.js';
export { computeConvictionScore } from './conviction-score.js';
export { computeDebateId } from './debate-id.js';
export {
  buildDebateLog,
  DEBATE_BAR_TIMEFRAME_MS,
  floorToBar,
  InMemoryDebateLogStore,
} from './debate-log-store.js';
export type {
  DebateAnalystFailure,
  DebateLogger,
  DebatePersona,
  LogSink,
} from './debate-logger.js';
export { JsonDebateLogger } from './debate-logger.js';
export type { DisagreementAnalysis, DisagreementConflict } from './disagreement-detector.js';
export { detectDisagreements } from './disagreement-detector.js';
export type { PartialDebateState } from './latency-budget.js';
export {
  DebateBudgetExceededError,
  enforceLatencyBudget,
  LATENCY_BUDGET_MS,
  MAX_ROUNDS_BY_ASSET_CLASS,
} from './latency-budget.js';
export type {
  AnthropicLlmClientConfig,
  AnthropicMessageOptions,
  AnthropicMessageRequest,
  AnthropicMessageResponse,
  AnthropicMessagesClient,
} from './llm/anthropic-client.js';
export { AnthropicLlmClient } from './llm/anthropic-client.js';
export type { LlmError } from './llm/errors.js';
export {
  LlmCancelledError,
  LlmMalformedResponseError,
  LlmProviderError,
  LlmRateLimitError,
  LlmTimeoutError,
} from './llm/errors.js';
// The prompt-plumbing three, on the barrel since #957 because the risk critic
// (`risk-manager/critic.ts`) is the first consumer OUTSIDE this module: it
// answers in JSON and shows a model book context, so it needs the same
// bare-JSON instruction, the same fence-tolerant unwrap, and the same
// untrusted-data wrapper the debate's own prompts use. Sharing them is the
// point — a second copy of any of the three would drift from the one the
// personas are tested against.
export { BARE_JSON_INSTRUCTION, unwrapFencedJson } from './llm/json-response.js';
export { MockLlmClient } from './llm/mock-client.js';
export type { NousMessagesClientOptions } from './llm/nous-messages-client.js';
export { NousMessagesClient } from './llm/nous-messages-client.js';
export { wrapUntrusted } from './llm/prompt-safety.js';
export type { PromptTierAlert, PromptTierAlertChannel } from './llm/prompt-tier-alert.js';
export {
  ALERT_AFTER_CONSECUTIVE_PROMPT_TIER_CROSSINGS,
  ALERT_REPEAT_EVERY_PROMPT_TIER_CROSSINGS,
  PromptTierCrossingThrottle,
} from './llm/prompt-tier-alert.js';
export type { SpendCap, SpendCapVerdict } from './llm/spend-cap.js';
export { SqliteSpendCap, UNCAPPED_SPEND } from './llm/spend-cap.js';
export type { LlmSpendRecord, LlmSpendSink } from './llm/spend-sink.js';
export { NULL_SPEND_SINK, SqliteLlmSpendStore } from './llm/spend-sink.js';
export type {
  LlmAttribution,
  LlmClient,
  LlmRequest,
  LlmRequestContext,
  LlmResponse,
  LlmRetryConfig,
} from './llm/types.js';
export { LLM_CONTEXT_FIELD_KIND } from './llm/types.js';
export type { MediatorInput, MediatorResponse, PersonaInput, PersonaResponse } from './personas.js';
export { runBearPersona, runBullPersona, runMediatorPersona } from './personas.js';
export type {
  AssetClass,
  RateLimitConfig,
  RateLimiterConfig,
  RateLimiterSnapshot,
  ReserveResult,
} from './rate-limiter.js';
export { RateLimiter } from './rate-limiter.js';
export type {
  DebateArgument,
  DebateInput,
  DebatePersonas,
  DebaterPersona,
  MediatorAssessment,
  MediatorPersona,
  MediatorSynthesis,
  RoundContext,
  RoundStance,
  RunDebateOptions,
} from './round-orchestrator.js';
export { MAX_ROUNDS, runDebate } from './round-orchestrator.js';
export { SqliteDebateLogStore } from './sqlite-debate-log-store.js';
export type { AnalystContribution, AnalystView, DebateResult, Direction } from './types.js';
export { applyAnalystWeights, weightedConvictionFactor } from './weighted-conviction.js';
