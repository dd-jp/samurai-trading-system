import type { Clock } from '../../shared/index.js';

export interface RateLimitConfig {
  windowMs: number;
  maxLlmCalls: number;
  maxDebates: number;
}

import type { AssetClass } from '../../shared/index.js';

export type { AssetClass };

export interface RateLimiterConfig {
  default: RateLimitConfig;
  perAssetClass?: Partial<Record<AssetClass, RateLimitConfig>>;
}

export type ReserveResult = { granted: true } | { granted: false; reason: string };

export type RateLimiterSnapshot = Partial<
  Record<AssetClass, { llmCallsUsed: number; debatesUsed: number }>
>;

interface WindowState {
  windowStart: number;
  llmCallsUsed: number;
  debatesUsed: number;
}

function assertBudget(budget: RateLimitConfig | undefined, where: string): void {
  if (budget === null || budget === undefined) {
    throw new Error(
      `RateLimiter: config.${where} is required — a limiter with no budget for an asset class ` +
        'would throw on the first debate of that class rather than at startup.',
    );
  }
  const check = (name: keyof RateLimitConfig, bound: 'positive' | 'non-negative') => {
    const value = budget[name];
    const belowBound = bound === 'positive' ? !(value > 0) : !(value >= 0);
    if (typeof value !== 'number' || !Number.isFinite(value) || belowBound) {
      throw new Error(
        `RateLimiter: config.${where}.${name} must be a finite ${bound} number; got ${String(value)}.`,
      );
    }
  };
  check('windowMs', 'positive');
  check('maxLlmCalls', 'non-negative');
  check('maxDebates', 'non-negative');
}

export class RateLimiter {
  private readonly clock: Clock;
  private readonly config: RateLimiterConfig;
  private readonly windows = new Map<AssetClass, WindowState>();

  constructor(clock: Clock, config: RateLimiterConfig) {
    if (clock === null || clock === undefined || typeof clock.now !== 'function') {
      throw new Error('RateLimiter: clock is required and must implement now(): Date.');
    }
    if (!(clock.now() instanceof Date)) {
      throw new Error('RateLimiter: clock.now() must return a Date.');
    }
    if (config === null || config === undefined) {
      throw new Error('RateLimiter: config is required.');
    }
    assertBudget(config.default, 'default');
    for (const [assetClass, budget] of Object.entries(config.perAssetClass ?? {})) {
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

  recordCall(assetClass: AssetClass): void {
    const window = this.currentWindow(assetClass);
    window.llmCallsUsed += 1;
  }

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
