/**
 * Execution — see docs/specs/execution-spec.md, epic #57.
 * Implemented ticket-by-ticket starting with #82 (core `execute()`, bracket
 * expansion + idempotent submit, Simulated adapter), then #85 (the long-term
 * ccxt + IBKR adapters), then #84 (Alpaca adapter, MVP live path).
 */

export type { AlpacaBrokerAdapterInput } from './adapters/alpaca-adapter.js';
export {
  AlpacaBrokerAdapter,
  DEFAULT_UNPRICED_FILL_AGE_OUT_MS,
} from './adapters/alpaca-adapter.js';
export {
  AlpacaBrokerProviderError,
  AlpacaBrokerRateLimitError,
  AlpacaBrokerTimeoutError,
} from './adapters/alpaca-broker-errors.js';
export type {
  AlpacaAccount,
  AlpacaBracketOrderRequest,
  AlpacaBrokerClient,
  AlpacaLimitOrderRequest,
  AlpacaOcoOrderRequest,
  AlpacaOrder,
  AlpacaOrderLeg,
  AlpacaStopLimitOrderRequest,
} from './adapters/alpaca-client.js';
export type {
  AlpacaHttpBrokerClientOptions,
  AlpacaTradingEnvironment,
} from './adapters/alpaca-http-client.js';
export {
  ALPACA_CREDENTIAL_ENV_VARS,
  AlpacaHttpBrokerClient,
  classifyAlpacaTradingHost,
} from './adapters/alpaca-http-client.js';
export { BrokerError, sanitizeBrokerError } from './broker-error.js';
export type {
  BrokerBracketOrderIds,
  BrokerBracketPhase,
  BrokerBracketRecord,
  BrokerBracketRequestFields,
  BrokerStateStore,
  BrokerVenue,
  UnpricedFillObservation,
  UnpricedFillRecord,
} from './broker-state-store.js';
export { InMemoryBrokerStateStore } from './broker-state-store.js';
export { ExecutionImpl } from './execute.js';
export {
  ALERT_AFTER_CONSECUTIVE_ZERO_SIZE,
  ALERT_REPEAT_EVERY_ZERO_SIZE,
  FilledZeroSizeThrottle,
} from './filled-zero-size-throttle.js';
export type {
  FlattenOverfillAlertChannel,
  FlattenOverfillWarning,
} from './flatten-overfill-alert.js';
export type {
  FlattenReconcileAlert,
  FlattenReconcileAlertChannel,
} from './flatten-reconcile-alert.js';
export type { OcoDoubleFillAlert, OcoDoubleFillAlertChannel } from './oco-double-fill-alert.js';
export type {
  ResidualExposureAlert,
  ResidualExposureAlertChannel,
} from './residual-exposure-alert.js';
export { sweepResidualProtection } from './residual-protection-sweep.js';
export type { SimulatedBrokerAdapterInput } from './simulated-adapter.js';
export { SimulatedBrokerAdapter } from './simulated-adapter.js';
export { SqliteBrokerStateStore } from './sqlite-broker-state-store.js';
export {
  DuplicateFlattenSubmissionError,
  DuplicatePositionError,
  SqliteExecutionStore,
} from './sqlite-shared-store.js';
export type {
  BrokerAck,
  BrokerAdapter,
  Execution,
  ExecutionConfig,
  ExecutionInput,
  ExecutionResult,
  FlattenAttribution,
  FlattenSubmissionWriteAhead,
  LotAdvance,
  NativeBracketRequest,
  NormalizedFill,
  NormalizedOrder,
  ReconcileDivergence,
  ReconcileReport,
  ResidualProtectionSweepResult,
  SharedStore,
  SimulatedAdapterConfig,
  UnprotectedResidualLot,
  UnresolvedFlattenSubmission,
} from './types.js';
export type { UnpricedFillAlert, UnpricedFillAlertChannel } from './unpriced-fill-alert.js';
