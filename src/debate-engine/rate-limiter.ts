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
import type { Clock } from '../shared/index.js';

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
import type { AssetClass } from '../shared/index.js';

export type { AssetClass };

/**
 * Per-asset-class configuration (story: "Supports different limits per
 * asset class (optional)"). A class with no entry falls back to `default`.
 */
export interface RateLimiterConfig {
  default: RateLimitConfig;
  perAssetClass?: Partial<Record<AssetClass, RateLimitConfig>>;
}

export type ReserveResult = { granted: true } | { granted: false; reason: string };

/**
 * What `RateLimiter.snapshot()` returns. Named rather than spelled inline at
 * each site: `smoke-run.ts`'s gate option declares the same shape, and a
 * hand-copied structural type across a module boundary diverges silently the
 * first time `WindowState` is renamed.
 */
export type RateLimiterSnapshot = Partial<
  Record<AssetClass, { llmCallsUsed: number; debatesUsed: number }>
>;

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
   *
   * **TOTAL over `AssetClass`, and callers depend on it.** Every value the
   * type admits yields a `ReserveResult`; none throws. A class with no
   * `perAssetClass` entry falls back to `default` (`configFor`). This is load
   * bearing rather than incidental: `buildDebateStep` calls this outside its
   * try/catch, and `SequentialTickRunner` does not catch a stage throw — so a
   * throw here would discard the whole tick pass instead of one instrument.
   * Pinned by "RateLimiter.reserve is total over AssetClass" in the tests.
   * Keep it that way: signal an unsatisfiable budget with `granted: false`,
   * never by throwing.
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

  /**
   * What this limiter has actually seen, per asset class, in the window each
   * class is currently in. Read-only; it opens no way to grant or spend
   * budget.
   *
   * Added by #388 for one reason worth naming, because "expose internals for a
   * test" would be a bad one. #388 IS this class having no production caller,
   * and the check that would have caught that is not a unit test — every unit
   * test passed while nothing constructed it. It is `yarn smoke`'s gate, which
   * asserts on observable effects of a real process (see #364's `debate_log`
   * assertion, whose mutation was invisible to all 1600+ unit tests). A
   * counter that stays at zero after a run that debated is the only cheap,
   * direct evidence that the limiter is in the LLM path rather than merely
   * constructed beside it.
   *
   * Deliberately NOT `currentWindow`-driven: reading must not roll a window
   * over or create one for a class that has never been used, or the observer
   * would change what it observes.
   */
  snapshot(): RateLimiterSnapshot {
    const result: RateLimiterSnapshot = {};
    for (const [assetClass, window] of this.windows) {
      result[assetClass] = {
        llmCallsUsed: window.llmCallsUsed,
        debatesUsed: window.debatesUsed,
      };
    }
    return result;
  }
}
