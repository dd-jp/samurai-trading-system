/**
 * #1010 — "Debate never requests prompt caching". Scope item 1 was
 * "measure the stable-prefix size per persona call" before deciding whether
 * to wire up `cache_control`. This file IS that measurement, kept as a test
 * so the conclusion re-verifies itself rather than going stale in a comment.
 *
 * Method: character count / 4, the same convention
 * `analyst-prompt-cost.test.ts` (#745) uses and documents — there is no
 * tokenizer in this repo; `pricing.ts` only ever prices token counts a
 * provider hands back, it never counts them itself. `/4` under-counts
 * slightly for English prose (real BPE tokenizers usually land nearer 3.3-3.7
 * chars/token), which only strengthens a "this is below the minimum"
 * conclusion, never weakens it.
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
 */
import { describe, expect, it } from 'vitest';
import { type PersonaResponse, runBullPersona, runMediatorPersona } from '../personas.js';
import type { AnalystView } from '../types.js';
import { MockLlmClient } from './mock-client.js';

/** Anthropic's minimum cacheable prompt length for the pinned debate model. */
const HAIKU_4_5_CACHE_MINIMUM_TOKENS = 4096;

/** chars/4, per #745's documented convention (see file header). */
function estimatedTokens(text: string): number {
  return Math.round(text.length / 4);
}

async function bullPrompt(views: AnalystView[]): Promise<string> {
  const client = new MockLlmClient();
  client.enqueueText(JSON.stringify({ stance: 'bullish', rationale: 'r' }));
  await runBullPersona(client, { trace_id: 't', analyst_views: views });
  return client.requests[0]?.prompt as string;
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
  return client.requests[0]?.prompt as string;
}

/**
 * A deliberately GENEROUS fixture — 5 analyst views (production runs 3:
 * technical, fundamental, sentiment) with verbose multi-line `key_points`,
 * well past what any analyst in this repo actually emits. If even this
 * pessimistic shape stays under the cache minimum, the real production
 * shape — measured directly below via the paper-soak store's own numbers —
 * is not a borderline case.
 */
function generousViews(): AnalystView[] {
  const analystTypes = ['technical', 'fundamental', 'sentiment', 'technical', 'fundamental'];
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
    // eslint-disable-next-line no-console
    console.log(
      `#1010: cross-debate-constant prefix (persona instructions + wrapUntrusted preamble): ` +
        `${stablePrefix.length} chars, ~${tokens} tokens`,
    );

    // This is the part identical across EVERY debate, not just every round of
    // one debate — and it alone is nowhere close to any Anthropic model's
    // minimum (the lowest published minimum, Opus 5, is 512 tokens).
    expect(tokens).toBeLessThan(512);
  });

  it('measures a generously-sized full bull-persona request against the Haiku 4.5 cache minimum', async () => {
    const prompt = await bullPrompt(generousViews());
    const tokens = estimatedTokens(prompt);
    // eslint-disable-next-line no-console
    console.log(
      `#1010: generous bull/bear-shaped request: ${prompt.length} chars, ~${tokens} tokens`,
    );

    // Production (paper-soak store, llm_spend, stage='debate', 2026-09-02
    // sample) measures bull/bear input at ~1,575-1,576 tokens — this fixture
    // is intentionally heavier than that and still falls well short.
    expect(tokens).toBeLessThan(HAIKU_4_5_CACHE_MINIMUM_TOKENS);
  });

  it('measures a generously-sized full mediator request against the Haiku 4.5 cache minimum', async () => {
    const prompt = await mediatorPrompt(generousViews());
    const tokens = estimatedTokens(prompt);
    // eslint-disable-next-line no-console
    console.log(
      `#1010: generous mediator-shaped request: ${prompt.length} chars, ~${tokens} tokens`,
    );

    // Production measures mediator input at ~2,100-2,150 tokens — again below
    // this fixture, and still well under the 4,096-token minimum.
    expect(tokens).toBeLessThan(HAIKU_4_5_CACHE_MINIMUM_TOKENS);
  });
});
