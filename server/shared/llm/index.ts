/**
 * The provider-facing half of the LLM stack, shared because both callers need
 * it: the debate engine (`debate-engine/llm/nous-messages-client.ts`) and the
 * market-intelligence sentiment agent
 * (`market-intelligence/grok/nous-sentiment-client.ts`).
 *
 * `pricing.ts` lives here rather than under `debate-engine/` for the same
 * reason — the spend cap is cross-surface, and `nous-config.ts` reads the rate
 * table at startup to refuse a model this system cannot price.
 */

export type {
  LlmInFlightGate,
  LlmInFlightRefusalReason,
  LlmInFlightRequest,
  LlmInFlightSlot,
  NousAccountInFlightGateOptions,
} from './in-flight-gate.js';
export {
  LlmInFlightRefusedError,
  NousAccountInFlightGate,
  UNGATED_LLM_IN_FLIGHT,
} from './in-flight-gate.js';
export type {
  NousChatMessage,
  NousChatOptions,
  NousChatRequest,
  NousChatResult,
} from './nous-chat.js';
export {
  DEFAULT_NOUS_TIMEOUT_MS,
  NousApiError,
  NousRefusalError,
  NousTruncatedError,
  nousChat,
} from './nous-chat.js';
export type { NousCredentials, NousRole } from './nous-config.js';
export {
  DEFAULT_NOUS_MODELS,
  NOUS_API_KEY_ENV_VAR,
  NOUS_BASE_URL_ENV_VAR,
  NOUS_MODEL_ENV_VAR,
  NOUS_ROLES,
  nousCredentials,
  nousEnvVars,
  tryNousCredentials,
} from './nous-config.js';
export type { AnthropicUsage, ModelRate } from './pricing.js';
export {
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  MODEL_RATES,
  pricedModels,
  priceUsage,
  rateFor,
} from './pricing.js';
