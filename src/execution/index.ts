/**
 * Execution — see docs/specs/execution-spec.md, epic #57.
 * Implemented ticket-by-ticket starting with #82 (core `execute()`, bracket
 * expansion + idempotent submit, Simulated adapter).
 */

export { ExecutionImpl } from './execute.js';
export type { SimulatedBrokerAdapterInput } from './simulated-adapter.js';
export { SimulatedBrokerAdapter } from './simulated-adapter.js';
export type {
  BrokerAck,
  BrokerAdapter,
  Execution,
  ExecutionConfig,
  ExecutionInput,
  ExecutionResult,
  NativeBracketRequest,
  NormalizedFill,
  SharedStore,
  SimulatedAdapterConfig,
} from './types.js';
