/**
 * Debate Engine (Stage 2) — see docs/specs/debate-engine-spec.md, epic #40.
 * Implemented ticket-by-ticket starting with #24.
 */

export type { DebateRoundLogEntry } from '../../shared/index.js';
// Re-exported from `shared/llm` rather than owned here: the sentiment agent
// prices against the same table, and `shared/llm/nous-config.ts` reads it to
// refuse an unpriced model at startup. Kept on this barrel because the debate
// engine's spend meter is still its principal consumer
export type { AnalystRoundStance } from './analyst-contribution.js';
export { buildAnalystContributions, computeInfluenceScore } from './analyst-contribution.js';
export { computeConvictionScore, EVIDENCE_WEIGHT } from './conviction-score.js';
export { computeDebateId } from './debate-id.js';
export {
  buildDebateLog,
  buildDebateRoundLogRows,
  DEBATE_BAR_TIMEFRAME_MS,
  floorToBar,
  InMemoryDebateLogStore,
} from './debate-log-store.js';
export type { DebateLogger } from './debate-logger.js';
export { JsonDebateLogger } from './debate-logger.js';
export { detectDisagreements } from './disagreement-detector.js';
export type { PartialDebateState } from './latency-budget.js';
export {
  enforceLatencyBudget,
  LATENCY_BUDGET_MS,
  LLM_CALLS_PER_ROUND,
  llmCallsPerDebate,
  MAX_ROUNDS_BY_ASSET_CLASS,
} from './latency-budget.js';
export type {
  AnthropicLlmClientConfig,
  AnthropicMessageRequest,
  AnthropicMessagesClient,
} from './llm/anthropic-client.js';
export { AnthropicLlmClient, WIRE_ENVELOPE_TEMPLATE_HASH } from './llm/anthropic-client.js';
export {
  LlmAdmissionRefusedError,
  LlmCancelledError,
  LlmMalformedResponseError,
  LlmProviderError,
  LlmRefusalError,
  LlmTimeoutError,
} from './llm/errors.js';
export type { FailureCause } from './llm/failure-cause.js';
export { classifyFailureCause } from './llm/failure-cause.js';
// The prompt-plumbing three, on the barrel since #957 because the risk critic
// (`risk-manager/critic.ts`) is the first consumer OUTSIDE this module: it
// answers in JSON and shows a model book context, so it needs the same
// bare-JSON instruction, the same fence-tolerant unwrap, and the same
// untrusted-data wrapper the debate's own prompts use. Sharing them is the
// point — a second copy of any of the three would drift from the one the
// personas are tested against
export { BARE_JSON_INSTRUCTION, unwrapFencedJson } from './llm/json-response.js';
export { MockLlmClient } from './llm/mock-client.js';
export { NousMessagesClient } from './llm/nous-messages-client.js';
export { wrapUntrusted } from './llm/prompt-safety.js';
export type { PromptTierAlert, PromptTierAlertChannel } from './llm/prompt-tier-alert.js';
export { PromptTierCrossingThrottle } from './llm/prompt-tier-alert.js';
export type { SpendCap, SpendCapRefusalKind, SpendCapVerdict } from './llm/spend-cap.js';
export {
  BUDGET_REMEDY,
  CORRUPT_LEDGER_REMEDY,
  READ_FAULT_REMEDY,
  SqliteSpendCap,
  spendCapRefusalRemedy,
  UNCAPPED_SPEND,
} from './llm/spend-cap.js';
export type { LlmSpendSink } from './llm/spend-sink.js';
export { SqliteLlmSpendStore } from './llm/spend-sink.js';
export type {
  LlmClient,
  LlmRequest,
  LlmResponse,
} from './llm/types.js';
export type { PersonaResponse } from './personas.js';
export { runBearPersona, runBullPersona, runMediatorPersona } from './personas.js';
export type {
  AssetClass,
  RateLimitConfig,
  RateLimiterConfig,
  RateLimiterSnapshot,
} from './rate-limiter.js';
export { RateLimiter } from './rate-limiter.js';
export type {
  DebatePersonas,
  DebaterPersona,
  MediatorAssessment,
  MediatorPersona,
  RoundContext,
  RoundStance,
} from './round-orchestrator.js';
export { MAX_ROUNDS, runDebate } from './round-orchestrator.js';
export { SqliteDebateLogStore } from './sqlite-debate-log-store.js';
export type {
  AnalystContribution,
  AnalystView,
  DebateResult,
  Direction,
  RoundVerdict,
} from './types.js';
export { applyAnalystWeights } from './weighted-conviction.js';
