/**
 * Domain types & contracts for the Analysts layer (Stage 1).
 * See docs/specs/analysts-spec.md ("Key Interfaces") and
 * docs/specs/cross-spec-contracts.md. Ticket #70 shipped one stateless
 * persona (Technical) end-to-end. Ticket #71 adds Fundamental/Sentiment and
 * the `AnalystOrchestrator` (applicability filtering + role-dependent
 * quorum). Ticket #431 implemented analysts-spec.md's "Module: Failure
 * Handling" — a persona failure is reported only after the bounded retry is
 * spent, and its `reason` says so. The spec's companion 2-consecutive-skip
 * alert sits in `orchestrator/production/analysts-adapter.ts`, which owns the
 * per-instrument cross-tick counter this stateless layer cannot hold.
 *
 * `AnalystView`/`Direction` are NOT redefined here: analysts-spec.md keeps
 * them in lockstep with the Debate Engine's copy (cross-spec-contracts.md
 * GAP-J), and this is the Debate Engine's upstream contract, so this module
 * imports rather than duplicates (mirrors trader/types.ts importing
 * `DebateResult` from debate-engine).
 */

import type { MarketDataService } from '../../providers/market-data-service/index.js';
import type { MarketIntelligenceStore } from '../../providers/market-intelligence/index.js';
import type { AssetClass, Clock } from '../../shared/index.js';
import type { AnalystView } from '../debate-engine/index.js';

export type { AssetClass };

/**
 * What the Analysts layer consumes to run a tick. Production (scanning /
 * scheduling the universe) is out of scope for this spec — see
 * analysts-spec.md "Out of Scope: Signal Production" — the Orchestrator is
 * the likely producer (cross-spec-contracts.md OPEN-GAP-D). Defined here
 * because no other module owns it yet.
 */
export interface Signal {
  asset: string;
  asset_class: AssetClass;
}

/**
 * The metric name behind every `AnalystTelemetry.indicatorUnavailable` call
 * (#745). A constant rather than a string literal at the emit site so the
 * production sink, the tests and any future scrape agree on one spelling.
 *
 * `{kind}` is the label: `technical_indicator_unavailable{kind="adx"}`.
 */
export const INDICATOR_UNAVAILABLE_COUNTER = 'technical_indicator_unavailable';

/** One indicator kind lost to a short window, with the arithmetic that lost it. */
export interface IndicatorUnavailableEvent {
  trace_id: string;
  analyst_type: string;
  instrument: string;
  /**
   * The axis this kind FEEDS — not, on its own, an axis that left the vote
   * denominator. Momentum reads two kinds and keeps voting on RSI when
   * `macd_histogram` is unreadable; the volatility gate never votes at all. An
   * axis leaves the denominator only when it has no readable input left, which
   * the view's `Axis votes: ... over N available axes` line is what reports.
   */
  axis: string;
  /** The counter's `kind` label — an `IndicatorKind`, or a derived feature name. */
  kind: string;
  /** Bars the kind needed. */
  required: number;
  /** Bars the window actually held. */
  received: number;
}

/**
 * Where an analyst's counters go (#745).
 *
 * A port rather than a module-level counter because analysts are stateless pure
 * functions by contract (analysts-spec.md "Module: State Management") and a
 * mutable module counter would be exactly the state that contract forbids —
 * and because a counter with no production sink is this repo's dominant defect
 * class. `production.ts` wires `LoggingAnalystTelemetry`; `production.test.ts`
 * asserts the composition root does so, not merely that the analyst would call
 * it if given one.
 *
 * Synchronous and returning `void`: a counter must never be able to fail a tick
 * or add latency to one.
 */
export interface AnalystTelemetry {
  /** Increments `technical_indicator_unavailable{kind}`. */
  indicatorUnavailable(event: IndicatorUnavailableEvent): void;
}

/**
 * What the orchestrator assembles for each analyst per tick (analysts-spec.md
 * "Key Interfaces"). No weight here — the analyst is weight-blind; weights
 * are applied downstream in the Debate Engine.
 */
export interface AnalystInput {
  /** Cross-cutting correlation ID, threaded from the Orchestrator's tick — not business data. */
  trace_id: string;
  signal: Signal;
  /** Wall-clock live, simulated T in replay. */
  clock: Clock;
  market_intelligence: MarketIntelligenceStore;
  market_data: MarketDataService;
  /**
   * Optional so a backtest or a focused unit test can run without a sink.
   * Optionality is also how a counter ends up dead in production, which is why
   * the composition root's wiring has its own test rather than resting on this
   * field being "usually" populated.
   */
  telemetry?: AnalystTelemetry;
}

/**
 * A single analyst persona: a pure function of its inputs. Stateless per
 * tick (analysts-spec.md "Module: State Management") — implementations must
 * hold no memory across `run` calls.
 */
export interface Analyst {
  analyst_type: string;
  applies_to(asset_class: AssetClass): boolean;
  role: 'mandatory' | 'optional';
  run(input: AnalystInput): Promise<AnalystView>;
}

/** One persona's failure this tick, reason-tagged (analysts-spec.md "Module: Failure Handling"). */
export interface AnalystFailure {
  analyst_type: string;
  role: 'mandatory' | 'optional';
  reason: string;
}

/**
 * What `AnalystOrchestrator.runAnalysts` returns (analysts-spec.md "Key
 * Interfaces"). No `weights` field here — the shared SQLite weight store is
 * owned by the Feedback Loop and not built yet; adding it is a follow-up,
 * not invented here.
 */
export interface AnalystRunResult {
  /** One per successful applicable analyst; empty if the tick was skipped. */
  views: AnalystView[];
  /**
   * The applicable count before failures — 3 on the equities path Samurai
   * runs. It varies by dropout and MI mute, not by asset class: crypto is out
   * of scope per ADR-0014's 2026-08-16 amendment.
   */
  analyst_count: number;
  /** True if a mandatory analyst failed, blocking the handoff downstream. */
  skipped: boolean;
  /** Every persona failure this tick, reason-tagged. */
  failures: AnalystFailure[];
}

/**
 * Prefixes the `key_points` entry an analyst emits when its intelligence
 * window is empty (#436).
 *
 * `MarketIntelligenceStore` has no writer in production, so `sentiment` and
 * `fundamental` see zero items on EVERY tick. The old wording — "0 social
 * items in window, net sentiment driving neutral" — is indistinguishable in a
 * debate transcript, or in a 14-day soak's own output, from "the analyst
 * looked and saw nothing bullish". It never looked.
 *
 * Greppable on purpose: a soak's transcripts should be filterable for "which
 * debates ran without this input at all" without parsing prose.
 */
export const NO_DATA_MARKER = 'NO DATA';
