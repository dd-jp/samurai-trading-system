/**
 * #1010 — "Debate never requests prompt caching". Scope item 1 was
 * "measure the stable-prefix size per persona call" before deciding whether
 * to wire up `cache_control`. This file IS that measurement, kept as a test
 * so the conclusion re-verifies itself rather than going stale in a comment.
 *
 * Method: character count / 4, the same convention
 * `analyst-prompt-cost.test.ts` (#745) uses and documents — there is no
 * tokenizer in this repo; `pricing.ts` only ever prices token counts a
 * provider hands back, it never counts them itself. IMPORTANT: `/4` is NOT a
 * conservative (upper-bound) estimate for a "this is below the minimum"
 * conclusion. Real BPE tokenizers land nearer 3.3-3.7 chars/token — a
 * *smaller* divisor than 4 — so dividing by 4 produces a token count that is
 * *lower* than what a real tokenizer would report, i.e. `/4` under-counts. A
 * genuinely conservative (upper-bound) estimate would divide by the low end
 * of that range (chars/3.3), which yields a HIGHER token count. Because `/4`
 * under-counts, an estimate that passes ("below the minimum") does NOT prove
 * the real, tokenizer-reported count also passes — the real count could be
 * higher, possibly even over the minimum. This WEAKENS a "below the minimum"
 * conclusion drawn from the chars/4 number alone; it does not strengthen it.
 * That is exactly why these synthetic measurements are corroborating, not
 * proof — see the production ground truth below, which is the figure this
 * file's conclusion actually rests on.
 *
 * Provider fact this file's assertions are measured against: Claude Haiku
 * 4.5 — the pinned debate model, `MODEL_RATES['anthropic/claude-haiku-4.5']`
 * in `pricing.ts` — will not cache anything under 4,096 input tokens.
 * (platform.claude.com/docs/en/build-with-claude/prompt-caching, fetched
 * 2026-09-02: "Shorter prompts cannot be cached, even if marked with
 * cache_control. Any requests to cache fewer than this number of tokens will
 * be processed without caching, and no error is returned.") Silent skip, not
 * an error — which is exactly why this needs measuring rather than assuming:
 * a `cache_control` breakpoint added under the minimum would look like it
 * shipped and never once fire.
 *
 * AUTHORITATIVE figure — the one this file's conclusion actually rests on,
 * not the chars/4 estimates above, which under-count and are corroborating
 * only: production ground truth from `data/samurai-paper.sqlite`'s
 * `llm_spend` table (stage='debate', n=383 rows across 49 debates,
 * 2026-09-02 sample), the provider's own reported token count, not a
 * character-count estimate. That measurement: bull/bear input averages
 * ~1,623 tokens (max 1,721); mediator input averages ~2,191 (max 2,360) —
 * the largest of the three debate-stage call shapes it distinguishes (a
 * fourth, `detectDisagreements`, averages ~1,088 and is smaller still). The
 * highest observed call (2,360) is ~58% of the 4,096 minimum: comfortably
 * under it, but with roughly 1.7x of headroom left rather than "half" — see
 * this file's `generousViews()` fixture below for a synthetic upper bound
 * sized to genuinely exceed that measured production max, not just
 * approximate it, and the `renderMessageContent` comment in
 * `anthropic-client.ts` for why the request has no content-block structure
 * a `cache_control` breakpoint could attach to even if the size gate above
 * didn't already make the question moot.
 */
import { describe, expect, it } from 'vitest';
import { type PersonaResponse, runBullPersona, runMediatorPersona } from '../personas.js';
import type { AnalystView } from '../types.js';
import { renderMessageContent } from './anthropic-client.js';
import { MockLlmClient } from './mock-client.js';

/** Anthropic's minimum cacheable prompt length for the pinned debate model. */
const HAIKU_4_5_CACHE_MINIMUM_TOKENS = 4096;

/**
 * Highest debate-stage input observed in production (`llm_spend`,
 * stage='debate', mediator shape, 2026-09-02 sample — see module doc
 * comment). `generousViews()` below must estimate above this: an assertion,
 * not just a comment, so shrinking the fixture later fails loudly instead of
 * silently stopping being an upper bound.
 */
const PRODUCTION_MAX_OBSERVED_TOKENS = 2360;

/** chars/4, per #745's documented convention (see file header). */
function estimatedTokens(text: string): number {
  return Math.round(text.length / 4);
}

/**
 * Reads `renderMessageContent(client.requests[0])`, NOT `client.requests[0].prompt`
 * — production sends the former (`anthropic-client.ts`'s `AnthropicLlmClient.attempt`
 * calls `callWithTimeout(renderMessageContent(request), ...)`), which appends the
 * serialized, `wrapUntrusted`-wrapped `analyst_views` context after `.prompt`. Reading
 * `.prompt` alone measured only part of what actually goes over the wire.
 */
async function bullPrompt(views: AnalystView[]): Promise<string> {
  const client = new MockLlmClient();
  client.enqueueText(JSON.stringify({ stance: 'bullish', rationale: 'r' }));
  await runBullPersona(client, { trace_id: 't', analyst_views: views });
  const request = client.requests[0];
  if (request === undefined) throw new Error('MockLlmClient recorded no request');
  return renderMessageContent(request);
}

async function mediatorPrompt(views: AnalystView[]): Promise<string> {
  const client = new MockLlmClient();
  client.enqueueText(JSON.stringify({ stance: 'bullish', rationale: 'r', converged: false }));
  const bullResponse: PersonaResponse = { stance: 'bullish', rationale: 'Momentum favors upside.' };
  const bearResponse: PersonaResponse = { stance: 'bearish', rationale: 'Volume is thinning out.' };
  await runMediatorPersona(client, {
    trace_id: 't',
    analyst_views: views,
    bullResponse,
    bearResponse,
  });
  const request = client.requests[0];
  if (request === undefined) throw new Error('MockLlmClient recorded no request');
  return renderMessageContent(request);
}

/**
 * A deliberately GENEROUS fixture — 6 analyst views (production runs 3:
 * technical, fundamental, sentiment) with verbose multi-line `key_points`,
 * well past what any analyst in this repo actually emits. Sized so its
 * measured token count genuinely EXCEEDS the production max (mediator,
 * 2,360 tokens, per the module doc comment) by a comfortable margin, not
 * just approximates it — a fixture that only matched or undershot the
 * production max would not actually bound what production could plausibly
 * send. The paper-soak store's own numbers (`llm_spend`, stage='debate')
 * remain the authoritative figure regardless, being real provider-reported
 * token counts rather than this file's chars/4 estimate. Both this fixture
 * and the production max stay under the cache minimum, but not by a huge
 * factor — the production max (2,360) is ~58% of the 4,096 minimum, not a
 * wide margin.
 */
function generousViews(): AnalystView[] {
  const analystTypes = [
    'technical',
    'fundamental',
    'sentiment',
    'technical',
    'fundamental',
    'sentiment',
  ];
  return analystTypes.map((analyst_type, i) => ({
    trace_id: 't',
    analyst_id: `${analyst_type}-${i}`,
    analyst_type,
    direction: i % 2 === 0 ? 'bullish' : 'bearish',
    confidence: 0.5 + i * 0.05,
    key_points: [
      `Trend (5m): bullish — close 121.3 above SMA(14) 118.9, ADX(14) 27.4 confirms directional strength`,
      `Momentum (5m): RSI(14) 61.2, MACD histogram positive and widening over the last 6 bars`,
      `Context (1h): higher-timeframe trend agrees, Donchian(20) upper band 124.1 not yet tested`,
      `MI context: no material headline risk in the last 24h window, sentiment score 0.42`,
      `Axis votes: trend=bullish momentum=bullish volatility=neutral volume=bullish structure=bullish`,
      `Squeeze: Bollinger/Keltner squeeze released 3 bars ago, expansion phase underway`,
      `Volume profile (1h): above-average participation on the breakout bar, no distribution seen yet`,
    ],
    timestamp: new Date('2026-09-01T12:00:00Z'),
  }));
}

describe('prompt-caching stable-prefix measurement (#1010)', () => {
  it('measures the cross-debate-constant prefix (persona instructions, before any analyst data)', async () => {
    const prompt = await bullPrompt([]);
    const openTag = '<untrusted_analyst_data>';
    const stablePrefix = prompt.slice(0, prompt.indexOf(openTag));

    const tokens = estimatedTokens(stablePrefix);

    // This is the part identical across EVERY debate, not just every round of
    // one debate — and it alone is nowhere close to any Anthropic model's
    // minimum (the lowest published minimum, Opus 5, is 512 tokens).
    expect(tokens).toBeLessThan(512);
  });

  it('measures a generously-sized full bull-persona request against the Haiku 4.5 cache minimum', async () => {
    const prompt = await bullPrompt(generousViews());
    const tokens = estimatedTokens(prompt);

    // Production (paper-soak store, llm_spend, stage='debate', n=383 rows
    // across 49 debates, 2026-09-02 sample) measures bull/bear input at
    // ~1,623 tokens average, 1,721 max — this fixture is intentionally
    // heavier than that and still falls well short of the minimum.
    expect(tokens).toBeLessThan(HAIKU_4_5_CACHE_MINIMUM_TOKENS);
  });

  it('measures a generously-sized full mediator request against the Haiku 4.5 cache minimum', async () => {
    const prompt = await mediatorPrompt(generousViews());
    const tokens = estimatedTokens(prompt);

    // Production measures mediator input at ~2,191 tokens average, 2,360
    // max — the highest of any debate-stage call shape measured, and the
    // figure closest to the minimum: ~58% of it, comfortably under but not
    // by a wide margin. This fixture's chars/4 estimate (see module doc
    // comment for why chars/4 is not itself a conservative bound) is sized
    // to genuinely exceed that 2,360 production max by a comfortable
    // margin, so this test guards a real upper bound rather than one that
    // production could already have drifted past. The production figure
    // (real provider-reported tokens, not a character-count estimate)
    // remains the authoritative one regardless — see the module doc
    // comment. Both this fixture and the production max still stay under
    // the 4,096-token minimum.
    expect(tokens).toBeGreaterThan(PRODUCTION_MAX_OBSERVED_TOKENS);
    expect(tokens).toBeLessThan(HAIKU_4_5_CACHE_MINIMUM_TOKENS);
  });
});
