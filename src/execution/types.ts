/**
 * Domain types & contracts for Execution — see docs/specs/execution-spec.md
 * ("Key Interfaces", "Module: Broker Abstraction") and
 * docs/specs/cross-spec-contracts.md §4/§5.
 *
 * Implementation ticket #82 — `execute()` on the entry/scale_in bracket path
 * plus the Simulated adapter. The interfaces here are deliberately narrower
 * than the spec's full shapes, in the same staged style as `TraderInput`
 * (#73) and `CostModel` (#87): fill ingestion / reconciliation (#83, #86)
 * and the real Alpaca adapter (#84) add their surfaces additively rather than
 * being declared here unimplemented.
 *
 * #85 added the ccxt + IBKR adapters against these shapes without widening
 * them: each exposes its fill feed (`fetchNewFills`) and, for ccxt, its OCO
 * emulation (`syncBrackets`) as adapter-local methods, exactly as the
 * Simulated adapter does. `BrokerAdapter` stays the one method `execute()`
 * calls until the ticket that drives the rest of the lifecycle (#83) arrives.
 *
 * #86 adds `getOrder` (the reconciliation lookup) and `reconcile()`, in the
 * same additive style. `submitFlatten`/`cancel`/`getOpenPositions` still
 * wait for their callers: Execution is the store's sole writer and the
 * write-ahead precedes the broker call, so no broker order can exist without
 * a store record preceding it — the only reachable divergence direction is
 * store→broker, which `getOrder` alone answers. A broker-side order with no
 * store record implies an order placed outside this system, which is out of
 * scope.
 *
 * `OpenPosition` / `OrderState` are NOT redefined here — they are cross-spec
 * types owned by src/shared/types.ts (registry §4).
 */
export type {
  BrokerAck,
  BrokerAdapter,
  NativeBracketRequest,
  NormalizedFill,
  NormalizedOrder,
  NormalizedPosition,
} from './types/broker.js';
export type {
  Execution,
  ExecutionConfig,
  ExecutionInput,
  ExecutionResult,
  ReconcileDivergence,
  ReconcileReport,
  SimulatedAdapterConfig,
} from './types/execution.js';
export type { LotAdvance, SharedStore } from './types/store.js';
