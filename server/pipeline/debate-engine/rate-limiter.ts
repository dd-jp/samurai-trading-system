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
import type { Clock } from '../../shared/index.js';

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

/** Asset classes recognized by `OrderIntent`/`OpenPosition` elsewhere in the codebase */
import type { AssetClass } from '../../shared/index.js';

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
 * One budget's shape, checked at construction. `where` names the field so a
 * misconfigured `perAssetClass.stocks` does not report as a bad `default`.
 *
 * `windowMs` must be strictly positive: at zero, `currentWindow`'s
 * `now - windowStart < config.windowMs` is never true, so every call mints a
 * fresh window and the limiter silently enforces NOTHING — a budget that reads
 * as configured while permitting unlimited spend, which is worse than an
 * obviously absent one. The two counters may be zero (a deliberate "admit
 * nothing" setting) but not negative or fractional.
 */
function assertBudget(budget: RateLimitConfig | undefined, where: string): void {
  if (budget === null || budget === undefined) {
    throw new Error(
      `RateLimiter: config.${where} is required — a limiter with no budget for an asset class ` +
        'would throw on the first debate of that class rather than at startup.',
    );
  }
  /**
   * `bound: 'positive'` means strictly greater than zero; `'non-negative'`
   * allows zero.
   *
   * Spelled as a named bound rather than as `value < Number.MIN_VALUE` for
   * strictness, which is what this did first. That expression is CORRECT — 0 is
   * less than 5e-324, so zero was always rejected — but a reviewer read it as
   * admitting zero and filed it as a bug (PR #390). Code whose correctness
   * hinges on recognising the smallest denormal double is code that will be
   * misread again, so the intent is now stated instead of encoded.
   */
  const check = (name: keyof RateLimitConfig, bound: 'positive' | 'non-negative') => {
    const value = budget[name];
    const belowBound = bound === 'positive' ? !(value > 0) : !(value >= 0);
    if (typeof value !== 'number' || !Number.isFinite(value) || belowBound) {
      throw new Error(
        `RateLimiter: config.${where}.${name} must be a finite ${bound} number; got ${String(value)}.`,
      );
    }
  };
  // Strictly positive — see the doc above for why 0 disables enforcement
  check('windowMs', 'positive');
  // Zero is a legitimate "admit nothing" setting for both counters
  check('maxLlmCalls', 'non-negative');
  check('maxDebates', 'non-negative');
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

  /**
   * Validates its own preconditions at CONSTRUCTION (PR #390 review), which is
   * what turns `reserve`'s "cannot throw" from a documented assumption into an
   * enforced one.
   *
   * `reserve` is relied on to be total over `AssetClass` — `buildDebateStep`
   * calls it outside its try/catch precisely because of that, and
   * `SequentialTickRunner` does not catch a stage throw. But that totality only
   * held as long as the config shape was well formed, and the shape was
   * guaranteed by TypeScript alone. Probing the throw surface for an earlier
   * review found exactly three ways to break it, all of them requiring a cast
   * or a JS caller: a null config, a config with no `default`, and a `Clock`
   * that does not return a `Date`. All three are checked here.
   *
   * **Construction, not per debate, and the distinction is the whole point.**
   * Each of these is a total, permanent misconfiguration — a null clock is
   * broken for every instrument on every tick for the life of the process. A
   * check at the debate stage would convert "this process is misconfigured"
   * into "this instrument silently never trades", which across a 14-day
   * unattended soak is indistinguishable from a quiet market: the heartbeat
   * keeps beating and nothing trades. Failing at boot fails loudly, before any
   * timer exists and before any capital is at risk — the same posture as
   * `paperStartingProfile('live')` throwing, and as #376 moving seeding ahead
   * of the tick loops so a throw cannot leave live timers behind.
   */
  constructor(clock: Clock, config: RateLimiterConfig) {
    if (clock === null || clock === undefined || typeof clock.now !== 'function') {
      throw new Error('RateLimiter: clock is required and must implement now(): Date.');
    }
    // Called once, here, rather than trusted: `currentWindow` does
    // `this.clock.now().getTime()` on every reserve/recordCall, so a clock that
    // returns anything else throws on the FIRST debate rather than at startup
    // Both in-repo implementations are pure, so calling it costs nothing
    if (!(clock.now() instanceof Date)) {
      throw new Error('RateLimiter: clock.now() must return a Date.');
    }
    if (config === null || config === undefined) {
      throw new Error('RateLimiter: config is required.');
    }
    assertBudget(config.default, 'default');
    for (const [assetClass, budget] of Object.entries(config.perAssetClass ?? {})) {
      // `?? {}` covers an absent map; an entry explicitly present but undefined
      // would fall back to `default` at read time, so it is not an error here
      if (budget !== undefined) assertBudget(budget, `perAssetClass.${assetClass}`);
    }

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

  /** Decrements remaining LLM-call budget as an admitted debate actually makes calls */
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
   * test passed while nothing constructed it. It is `npm run smoke`'s gate, which
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
