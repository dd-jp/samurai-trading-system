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
 * same additive style. `cancel`/`getOpenPositions` still wait for their
 * callers. `submitFlatten` got its caller in #508 — `execute()`'s `exit`
 * branch — which is also where the "no broker order without a store record
 * preceding it" claim below stops being universal: a flatten reaches the
 * broker with no write-ahead behind it, because an exit closes an existing
 * lot rather than opening one (see execute.ts's `intent_type === 'exit'`
 * branch for why). For every OTHER path the claim still holds: Execution is
 * the store's sole writer and the write-ahead precedes the broker call, so
 * the only reachable divergence direction there is store→broker, which
 * `getOrder` alone answers. A broker-side order with no store record and no
 * exit behind it implies an order placed outside this system, which is out
 * of scope.
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
