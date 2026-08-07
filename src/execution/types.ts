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
 * same additive style. `cancel`/`getOpenPositions` still wait for a caller
 * of their own. `submitFlatten` got its caller in #508 — `execute()`'s
 * `exit` branch — and PR #516's review sharpened it further: `cancel` is
 * now called too (ahead of `submitFlatten`, to clear the held lot's own
 * bracket legs before the position goes flat — see execute.ts for why an
 * uncancelled leg is a live-money hazard, not a backstop), and the flatten
 * itself is write-ahead journalled to `flatten_submissions`
 * (`SharedStore.writeAheadFlatten`) rather than `open_positions` — an exit
 * closes an existing lot rather than opening one, so it has no bracket and
 * no `OpenPosition` to write ahead, but it still needs SOME durable row for
 * `findByKey`'s dedup gate and #86's reconcile to resolve against. The "no
 * broker order without a store record preceding it" claim below therefore
 * still holds for every path, exit included — only WHICH table the record
 * lives in differs. A broker-side order with no store record in either
 * table implies an order placed outside this system, which is out of scope.
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
export type { FlattenSubmissionWriteAhead, LotAdvance, SharedStore } from './types/store.js';
