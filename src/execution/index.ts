/**
 * Execution — see docs/specs/execution-spec.md, epic #57.
 * Implemented ticket-by-ticket starting with #82 (core `execute()`, bracket
 * expansion + idempotent submit, Simulated adapter), then #85 (the long-term
 * ccxt + IBKR adapters).
 */

export type {
  CcxtBrokerClient,
  CcxtOrder,
  CcxtOrderStatus,
} from './ccxt-adapter.js';
export { CcxtBrokerAdapter } from './ccxt-adapter.js';
export { ExecutionImpl } from './execute.js';
export type {
  IbkrBracketOrderIds,
  IbkrBracketRequest,
  IbkrBrokerClient,
  IbkrExecution,
} from './ibkr-adapter.js';
export { IbkrBrokerAdapter } from './ibkr-adapter.js';
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
