/**
 * The composition root's capture default (#1035).
 *
 * This file exists because of what the offline smoke run CANNOT prove.
 * `npm run smoke` drives a mock LLM client that returns no `usage` block, so
 * `recordSpend` returns early, nothing is metered and no `llm_call_log` row is
 * written — a green smoke gate says nothing about whether capture is reached
 * on the shipped path. That is exactly this repo's dominant defect shape: a
 * mechanism that is built, tested, and called by nothing in production.
 *
 * So the default is pinned here, at the one place that decides it, and the
 * capture behaviour itself is pinned in `debate-engine/llm/llm-call-log.test.ts`
 * against a real SQLite instance. Between them: the switch resolves ON unless
 * an operator says otherwise, and a sink handed `true` writes rows.
 */
import { captureLlmTextFromEnvironment } from './production/environment.js';

describe('captureLlmTextFromEnvironment', () => {
  it('is ON when the variable is unset', () => {
    // The load-bearing case. Default-off would mean the 14-day soak this
    // capture exists to make diagnosable runs without it, and the absence is
    // only discovered when someone needs the data months later.
    expect(captureLlmTextFromEnvironment(undefined)).toBe(true);
  });

  it('is OFF only when explicitly switched off', () => {
    expect(captureLlmTextFromEnvironment('off')).toBe(false);
    expect(captureLlmTextFromEnvironment('OFF')).toBe(false);
    expect(captureLlmTextFromEnvironment('  off  ')).toBe(false);
  });

  it('stays ON for any other value, including an empty string', () => {
    // A typo must not silently disable an observability feature: the only
    // value that turns capture off is the one that says so.
    expect(captureLlmTextFromEnvironment('')).toBe(true);
    expect(captureLlmTextFromEnvironment('on')).toBe(true);
    expect(captureLlmTextFromEnvironment('true')).toBe(true);
    expect(captureLlmTextFromEnvironment('offf')).toBe(true);
    expect(captureLlmTextFromEnvironment('disabled')).toBe(true);
  });
});
