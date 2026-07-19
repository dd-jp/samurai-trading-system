/**
 * Rate limit enforcement & guard — see docs/specs/debate-engine-spec.md
 * (story 21: "debates respect rate limits and return errors without
 * proceeding, so that I don't generate partial decisions under degraded
 * conditions"). Implementation ticket #39.
 *
 * Tracks LLM calls (disagreement detection + mediator synthesis) and debate
 * starts per configurable time window, and gates new debates on whether the
 * worst case (3 rounds + disagreement detection) still fits the remaining
 * budget. This module is intentionally independent of the LLM Integration
 * Layer (#31, not yet built) — it only counts calls the caller reports via
 * `recordCall`, it never invokes an LLM itself.
 */
import type { Clock } from '../shared/clock.js';

/**
 * Budget for a single time window. `windowMs` is the fixed window length;
 * counters reset once `windowMs` has elapsed since the window started
 * (fixed window, not sliding — matches the spec's "per time window" wording).
 */
export interface RateLimitConfig {
  windowMs: number;
  maxLlmCalls: number;
  maxDebates: number;
}

/** Asset classes recognized by `OrderIntent`/`OpenPosition` elsewhere in the codebase. */
export type AssetClass = 'crypto' | 'stocks';

/**
 * Per-asset-class configuration (story: "Supports different limits per
 * asset class (optional)"). A class with no entry falls back to `default`.
 */
export interface RateLimiterConfig {
  default: RateLimitConfig;
  perAssetClass?: Partial<Record<AssetClass, RateLimitConfig>>;
}

export type ReserveResult = { granted: true } | { granted: false; reason: string };

interface WindowState {
  windowStart: number;
  llmCallsUsed: number;
  debatesUsed: number;
}

/**
 * In-memory only — consistent with the Debate Engine's no-persistence
 * decision (docs/specs/debate-engine-spec.md, "Module: State Persistence").
 * Budget resets on process restart, same as the ephemeral round state.
 */
export class RateLimiter {
  private readonly clock: Clock;
  private readonly config: RateLimiterConfig;
  private readonly windows = new Map<AssetClass, WindowState>();

  constructor(clock: Clock, config: RateLimiterConfig) {
    this.clock = clock;
    this.config = config;
  }

  private configFor(assetClass: AssetClass): RateLimitConfig {
    return this.config.perAssetClass?.[assetClass] ?? this.config.default;
  }

  private currentWindow(assetClass: AssetClass): WindowState {
    const config = this.configFor(assetClass);
    const now = this.clock.now().getTime();
    const existing = this.windows.get(assetClass);

    if (existing && now - existing.windowStart < config.windowMs) {
      return existing;
    }

    const fresh: WindowState = { windowStart: now, llmCallsUsed: 0, debatesUsed: 0 };
    this.windows.set(assetClass, fresh);
    return fresh;
  }

  /**
   * Checks whether sufficient budget exists for a new debate's worst case
   * (caller supplies the worst-case LLM call count — spec: 3 rounds +
   * disagreement detection) before it starts. Returns a typed result rather
   * than throwing: an exhausted budget is an expected, recoverable
   * condition (spec: "return an error without proceeding"), not an
   * invariant violation. Grants no partial reservation on rejection.
   */
  reserve(assetClass: AssetClass, worstCaseLlmCalls: number): ReserveResult {
    const config = this.configFor(assetClass);
    const window = this.currentWindow(assetClass);

    if (window.debatesUsed + 1 > config.maxDebates) {
      return {
        granted: false,
        reason: `debate budget exhausted for ${assetClass}: ${window.debatesUsed}/${config.maxDebates} debates used this window`,
      };
    }

    if (window.llmCallsUsed + worstCaseLlmCalls > config.maxLlmCalls) {
      return {
        granted: false,
        reason: `LLM call budget insufficient for ${assetClass}: ${window.llmCallsUsed}/${config.maxLlmCalls} used, ${worstCaseLlmCalls} needed for worst case`,
      };
    }

    window.debatesUsed += 1;
    return { granted: true };
  }

  /** Decrements remaining LLM-call budget as an admitted debate actually makes calls. */
  recordCall(assetClass: AssetClass): void {
    const window = this.currentWindow(assetClass);
    window.llmCallsUsed += 1;
  }
}
