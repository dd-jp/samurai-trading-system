/**
 * Canonical cross-spec types shared across >=2 components.
 * Source of truth: docs/specs/cross-spec-contracts.md — this file is the
 * TypeScript realization of that registry. Populated ticket-by-ticket
 * (starting with #24 Domain Types & Contracts); do not hand-roll competing
 * shapes in individual component files once a type is defined here.
 */
export type {
  ClosedTradeStore,
  DebateLogStore,
  SetupStore,
  TuningStore,
  VerdictLogStore,
} from './types/ports.js';
export type {
  AssetClass,
  InstrumentSubclass,
  LogEntry,
  Logger,
} from './types/primitives.js';
export type {
  ClosedTrade,
  DebateLog,
  Fill,
  OpenPosition,
  OrderIntent,
  OrderIntentMetadata,
  OrderState,
  SetupNeighbor,
  SetupVector,
  VerdictLog,
} from './types/records.js';
