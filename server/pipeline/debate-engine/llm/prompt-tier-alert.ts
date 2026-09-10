/**
 * The operator-escalation port for a prompt-tier crossing (#1155).
 *
 * `crossesPromptTier` (shared/llm/pricing.ts) had no caller: the 2.5x
 * unit-cost step it exists to warn on happened silently inside the meter.
 * `SqliteLlmSpendStore.record` (spend-sink.ts) is the wiring — every metered
 * call already passes through it, so it is the one place that can compare a
 * call's usage against the model's tier before the row is written.
 *
 * Declared here, at the point of need — the same convention
 * `UnpricedFillAlertChannel` takes beside `execute.ts`
 * (execution/unpriced-fill-alert.ts): the debate engine gains a dependency on
 * something that can be told, not on a transport.
 *
 * `void`-returning, unlike most of this repo's alert ports: `record()` is
 * `LlmSpendSink`'s SYNCHRONOUS contract ("RECORDING MUST NEVER FAIL A CALL",
 * spend-sink.ts's file doc), so nothing in its call stack can `await`.
 * `ThresholdClampAlertChannel` (orchestrator/production/threshold-clamp-
 * alert.ts) is the precedent for that shape: a fire-and-forget post, with the
 * transport responsible for its own delivery and failure logging.
 */

/** One prompt-tier crossing, as `SqliteLlmSpendStore.record` observes it. */
export interface PromptTierAlert {
  model: string;
  trace_id: string;
  stage: string;
  debate_id?: string | undefined;
  /** `promptTokensOf`'s answer for this call — the same sum `priceUsage` tiers against. */
  prompt_tokens: number;
  /** The tier's own threshold (`ModelRate.tier.above_prompt_tokens`), so the alert states what it crossed without a reader looking the model up. */
  above_prompt_tokens: number;
  /** How many consecutive metered calls, including this one, this model has crossed the tier on — `PromptTierCrossingThrottle`'s own count. */
  consecutive_crossings: number;
  reported_at: Date;
}

export interface PromptTierAlertChannel {
  postPromptTierAlert(alert: PromptTierAlert): void;
}

import { escalatesAt } from '../../../shared/index.js';

/**
 * Alert on the FIRST crossing, unlike the analyst-skip channel's threshold of
 * two (#431): a 2.5x unit-cost step against ADR-0008's $50/14d cap should
 * never wait out a second occurrence before it is reported, the same
 * reasoning `ALERT_AFTER_CONSECUTIVE_DEGRADED_TICKS` (tick-skip-alert.ts)
 * draws for a materially degraded pass.
 */
export const ALERT_AFTER_CONSECUTIVE_PROMPT_TIER_CROSSINGS = 1;

/**
 * How often the alert repeats while the SAME model keeps crossing on
 * consecutive calls, counted in further crossings after the first alert.
 *
 * Retrieval-heavy calls on a tiered model recur — that is #969's whole
 * reason the tier exists — so an unthrottled repeat would page on every
 * single one. 8 matches every other bounded-repeat constant in this repo
 * (`ALERT_REPEAT_EVERY_SKIPS`, `ALERT_REPEAT_EVERY_DEGRADED_TICKS`,
 * `ALERT_REPEAT_EVERY_NO_DATA`/`ALERT_REPEAT_EVERY_DIAGNOSTICS`): frequent
 * enough that a persistent tier stays noticed, rare enough that the shared
 * escalation chat stays readable.
 */
export const ALERT_REPEAT_EVERY_PROMPT_TIER_CROSSINGS = 8;

const PROMPT_TIER_CADENCE = {
  after: ALERT_AFTER_CONSECUTIVE_PROMPT_TIER_CROSSINGS,
  every: ALERT_REPEAT_EVERY_PROMPT_TIER_CROSSINGS,
};

function shouldAlertAt(consecutive: number): boolean {
  return escalatesAt(consecutive, PROMPT_TIER_CADENCE);
}

/**
 * Consecutive-crossing counter, keyed by model, for one running
 * `SqliteLlmSpendStore` — the same shape `consecutiveSkips`
 * (analysts-adapter.ts) takes keyed by instrument: several models can be in
 * flight on the same store (the debate stage and the sentiment agent bill
 * through separate stores, but a single store still meters every model the
 * stage it belongs to uses), so the throttle needs one counter per model, not
 * one for the whole store.
 *
 * In memory and restart-clean: the counter distinguishes an isolated
 * retrieval spike from a persistent one, and a freshly restarted process has
 * no evidence about the previous process's calls.
 */
export class PromptTierCrossingThrottle {
  private readonly consecutiveByModel = new Map<string, number>();

  /**
   * Records this call's crossing/not-crossing verdict for `model` and
   * returns whether this call is due to alert.
   *
   * Called on EVERY metered call for the model, not only crossing ones — a
   * call back under the tier has to clear the run, the same rule
   * `consecutiveSkips.delete` (analysts-adapter.ts) and `TickSkipThrottle`
   * both follow: the alert is about a CONSECUTIVE run of crossings, so an
   * intermittent one must not accumulate its way to an alert over a day of
   * otherwise-ordinary calls.
   */
  observe(model: string, crossed: boolean): { alert: boolean; consecutive: number } {
    if (!crossed) {
      this.consecutiveByModel.delete(model);
      return { alert: false, consecutive: 0 };
    }
    const consecutive = (this.consecutiveByModel.get(model) ?? 0) + 1;
    this.consecutiveByModel.set(model, consecutive);
    return { alert: shouldAlertAt(consecutive), consecutive };
  }
}
