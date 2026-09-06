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

import type {
  MarketDataService,
  TradingCalendar,
} from '../../providers/market-data-service/index.js';
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
 * The no-op default (#790). `AnalystInput.telemetry` used to be optional so a
 * backtest or a focused unit test could run without a sink — but "optional in
 * the type" is precisely this repo's dominant defect class: a mechanism fully
 * built, fully tested, and silently absent at the one composition site that
 * matters (the alert-transport version of this recurred eight times before
 * `AlertChannelSlots` made it a compiler error). #745 mitigated it for its own
 * scope with a composition-root test (`production.test.ts`'s
 * "technical_indicator_unavailable is wired by the composition root"), which
 * catches today's construction site going quiet but not the next one that
 * forgets to wire a sink at all.
 *
 * This constant is what makes the field itself non-optional without forcing
 * every caller that has no real sink to invent one: `telemetry:
 * NOOP_ANALYST_TELEMETRY` (or `input.telemetry ?? NOOP_ANALYST_TELEMETRY` at
 * a call site threading an optional dependency) is now the ONLY way to build
 * an `AnalystInput` without a real counter — never simply omitting the field,
 * which is a compile error. Measured at 8 construction sites repo-wide
 * (`orchestrator.ts`'s production wiring plus 7 test call sites); tractable,
 * so this is the non-optional form the ticket prefers over merely recording a
 * decision.
 */
export const NOOP_ANALYST_TELEMETRY: AnalystTelemetry = {
  indicatorUnavailable(): void {
    // Intentionally does nothing — the safe default is silence, not a throw:
    // a counter must never be able to fail a tick (see `AnalystTelemetry`'s
    // own doc comment).
  },
};

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
   * The instrument's trading calendar (#746), threaded explicitly rather than
   * resolved by an analyst itself. `technicalAnalyst`'s session VWAP
   * (`session-features.ts`) is the first consumer: it anchors to
   * `calendar.sessionStart` and reads `calendar.sessionEnd(asOf) === null` as
   * "no session to anchor to" (crypto's `AlwaysOpenCalendar`).
   *
   * REQUIRED, not optional — every `AnalystInput` the orchestrator builds
   * carries a real calendar (`AnalystOrchestratorDeps.sessionCalendars`
   * defaults to a pair of `AlwaysOpenCalendar`s when the composition root does
   * not override it, so this field is never undefined; the default merely
   * means "no session feature" rather than "no calendar"). A test that builds
   * `AnalystInput` directly (bypassing the orchestrator) must supply one
   * explicitly — never read from the ambient clock or a module-level default.
   */
  calendar: TradingCalendar;
  /**
   * The claimed decision bar's opening boundary (#811) — `TickContext.decision_bar.open_time`,
   * threaded down through `TickSteps.analysts` and `AnalystOrchestrator.runAnalysts` without a
   * second derivation anywhere in between. This is what `market_intelligence.getContext` must be
   * called with, so the MI window floors to the SAME bar the debate is keyed to, rather than
   * independently flooring whatever `clock.now()` reads when the analyst happens to run.
   *
   * Before #811, `MarketIntelligenceStore.getContext` floored a second, independent read of the
   * clock (#782) — the same two-derivations shape #687 fixed for the Trader one seam over. A pass
   * that straddles the hour boundary (claimed under bar N, reaching the analysts after the clock
   * has ticked into bar N+1) floored its MI window to N+1 while the debate stayed keyed to N, so
   * the analyst input and the debate record disagreed about which bar they belonged to.
   *
   * REQUIRED, not optional, for the same reason `telemetry` is (#790): a caller with no real
   * decision bar (a focused unit test that does not go through the orchestrator) must supply one
   * explicitly rather than have this field silently fall back to a fresh `floorToBar(clock.now())`
   * — a fallback here would just be the bug this ticket exists to close, reintroduced as a default.
   */
  bar: Date;
  /**
   * Where an analyst's counters go (#745). REQUIRED, not optional (#790) — see
   * `NOOP_ANALYST_TELEMETRY`. A caller with no real sink passes that constant
   * explicitly rather than omitting the field, so a construction site that
   * forgets to wire a real sink is a silent no-op counter by an EXPLICIT
   * choice visible in its own source, not an accident TypeScript cannot see.
   * `production.test.ts`'s composition-root test still exists on top of this
   * — it is the only check that the sink `production.ts` actually wires is
   * the LOGGING one, not merely that some sink (real or noop) was supplied.
   */
  telemetry: AnalystTelemetry;
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

/**
 * Why a persona failed, as a discriminator rather than as prose (#1080).
 *
 * The kind describes THE ATTEMPT THE STAGE GAVE UP ON, not all of them:
 * `'timeout'` means the final attempt hit `AnalystOrchestrator`'s per-attempt
 * deadline, `'error'` means it threw (a data gap, a provider fault, a malformed
 * response). A run that threw once and then timed out reports `'timeout'`.
 *
 * That is the terminal condition, and it is the one worth surfacing. The
 * alternative — `'timeout'` only when EVERY attempt hit the deadline — would
 * report a throw-then-timeout run as an upstream fault, which is exactly the
 * misattribution #1080 exists to remove: it hides a deadline that has become
 * unreachable behind a word an operator reads as someone else's outage. The
 * same preference decides a mixed set of personas one layer up (`skipKindOf`).
 *
 * The reason string already names both, but only by spelling — a reader
 * downstream had to match on the words `did not answer within` to tell them
 * apart, and the two are acted on differently.
 */
export type AnalystFailureKind = 'timeout' | 'error';

/** One persona's failure this tick, reason-tagged (analysts-spec.md "Module: Failure Handling"). */
export interface AnalystFailure {
  analyst_type: string;
  role: 'mandatory' | 'optional';
  reason: string;
  kind: AnalystFailureKind;
}

/**
 * What `AnalystOrchestrator.runAnalysts` returns (analysts-spec.md "Key
 * Interfaces"). No `weights` field here — `debate-adapter.ts` reads
 * `TuningStore.getAnalystWeights()` directly and applies them at the Debate
 * seam (#435), so this result type never needs to carry them.
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
