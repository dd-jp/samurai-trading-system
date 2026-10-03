import {
  ALERT_REPEAT_EVERY_PROMPT_TIER_CROSSINGS,
  PromptTierCrossingThrottle,
} from './prompt-tier-alert.js';

describe('PromptTierCrossingThrottle', () => {
  it('alerts on the first crossing', () => {
    const throttle = new PromptTierCrossingThrottle();
    expect(throttle.observe('x-ai/grok-4.5', true)).toEqual({ alert: true, consecutive: 1 });
  });

  it('suppresses every crossing between the first and the next repeat boundary', () => {
    const throttle = new PromptTierCrossingThrottle();
    throttle.observe('x-ai/grok-4.5', true);

    for (let i = 2; i < ALERT_REPEAT_EVERY_PROMPT_TIER_CROSSINGS + 1; i++) {
      expect(throttle.observe('x-ai/grok-4.5', true)).toEqual({ alert: false, consecutive: i });
    }
  });

  it('alerts again exactly at the repeat boundary while the crossing persists', () => {
    const throttle = new PromptTierCrossingThrottle();
    let last: { alert: boolean; consecutive: number } = { alert: false, consecutive: 0 };
    for (let i = 0; i < ALERT_REPEAT_EVERY_PROMPT_TIER_CROSSINGS + 1; i++) {
      last = throttle.observe('x-ai/grok-4.5', true);
    }
    expect(last).toEqual({
      alert: true,
      consecutive: ALERT_REPEAT_EVERY_PROMPT_TIER_CROSSINGS + 1,
    });
  });

  it('resets the run — and alerts again on the next crossing — once a call does not cross', () => {
    const throttle = new PromptTierCrossingThrottle();
    throttle.observe('x-ai/grok-4.5', true);
    expect(throttle.observe('x-ai/grok-4.5', false)).toEqual({ alert: false, consecutive: 0 });
    expect(throttle.observe('x-ai/grok-4.5', true)).toEqual({ alert: true, consecutive: 1 });
  });

  it('tracks each model independently', () => {
    const throttle = new PromptTierCrossingThrottle();
    throttle.observe('x-ai/grok-4.5', true);
    expect(throttle.observe('~x-ai/grok-latest', true)).toEqual({ alert: true, consecutive: 1 });
  });
});
