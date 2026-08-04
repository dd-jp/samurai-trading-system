/**
 * Execution — see docs/specs/execution-spec.md, epic #57.
 * Implemented ticket-by-ticket starting with #82 (core `execute()`, bracket
 * expansion + idempotent submit, Simulated adapter), then #85 (the long-term
 * ccxt + IBKR adapters), then #84 (Alpaca adapter, MVP live path).
 */

export type { AlpacaBrokerAdapterInput } from './adapters/alpaca-adapter.js';
export { AlpacaBrokerAdapter } from './adapters/alpaca-adapter.js';
export {
  AlpacaBrokerProviderError,
  AlpacaBrokerRateLimitError,
  AlpacaBrokerTimeoutError,
} from './adapters/alpaca-broker-errors.js';
export type {
  AlpacaBracketOrderRequest,
  AlpacaClient,
  AlpacaOrder,
  AlpacaOrderLeg,
} from './adapters/alpaca-client.js';
export type { AlpacaHttpBrokerClientOptions } from './adapters/alpaca-http-client.js';
export { AlpacaHttpBrokerClient } from './adapters/alpaca-http-client.js';
export { BrokerError, sanitizeBrokerError } from './broker-error.js';
export type {
  BrokerBracketOrderIds,
  BrokerBracketPhase,
  BrokerBracketRecord,
  BrokerBracketRequestFields,
  BrokerStateStore,
  BrokerVenue,
} from './broker-state-store.js';
export { InMemoryBrokerStateStore } from './broker-state-store.js';
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
  IbkrOrderStatus,
} from './ibkr-adapter.js';
export { IbkrBrokerAdapter } from './ibkr-adapter.js';
export type { SimulatedBrokerAdapterInput } from './simulated-adapter.js';
export { SimulatedBrokerAdapter } from './simulated-adapter.js';
export { SqliteBrokerStateStore } from './sqlite-broker-state-store.js';
export { DuplicatePositionError, SqliteExecutionStore } from './sqlite-shared-store.js';
export type {
  BrokerAck,
  BrokerAdapter,
  Execution,
  ExecutionConfig,
  ExecutionInput,
  ExecutionResult,
  NativeBracketRequest,
  NormalizedFill,
  NormalizedOrder,
  ReconcileDivergence,
  ReconcileReport,
  SharedStore,
  SimulatedAdapterConfig,
} from './types.js';
