
export interface PromptTierAlert {
  model: string;
  trace_id: string;
  stage: string;
  debate_id?: string | undefined;
  prompt_tokens: number;
  above_prompt_tokens: number;
  consecutive_crossings: number;
  reported_at: Date;
}

export interface PromptTierAlertChannel {
  postPromptTierAlert(alert: PromptTierAlert): void;
}

import { escalatesAt } from '../../../shared/index.js';

const ALERT_AFTER_CONSECUTIVE_PROMPT_TIER_CROSSINGS = 1;

export const ALERT_REPEAT_EVERY_PROMPT_TIER_CROSSINGS = 8;

const PROMPT_TIER_CADENCE = {
  after: ALERT_AFTER_CONSECUTIVE_PROMPT_TIER_CROSSINGS,
  every: ALERT_REPEAT_EVERY_PROMPT_TIER_CROSSINGS,
};

function shouldAlertAt(consecutive: number): boolean {
  return escalatesAt(consecutive, PROMPT_TIER_CADENCE);
}

export class PromptTierCrossingThrottle {
  private readonly consecutiveByModel = new Map<string, number>();

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
