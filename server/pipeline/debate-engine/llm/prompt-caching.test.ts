import { describe, expect, it } from 'vitest';
import { type PersonaResponse, runBullPersona, runMediatorPersona } from '../personas.js';
import type { AnalystView } from '../types.js';
import { renderMessageContent } from './anthropic-client.js';
import { MockLlmClient } from './mock-client.js';

const HAIKU_4_5_CACHE_MINIMUM_TOKENS = 4096;

const PRODUCTION_MAX_OBSERVED_TOKENS = 2360;

function estimatedTokens(text: string): number {
  return Math.round(text.length / 4);
}

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

    expect(tokens).toBeLessThan(512);
  });

  it('measures a generously-sized full bull-persona request against the Haiku 4.5 cache minimum', async () => {
    const prompt = await bullPrompt(generousViews());
    const tokens = estimatedTokens(prompt);

    expect(tokens).toBeLessThan(HAIKU_4_5_CACHE_MINIMUM_TOKENS);
  });

  it('measures a generously-sized full mediator request against the Haiku 4.5 cache minimum', async () => {
    const prompt = await mediatorPrompt(generousViews());
    const tokens = estimatedTokens(prompt);

    expect(tokens).toBeGreaterThan(PRODUCTION_MAX_OBSERVED_TOKENS);
    expect(tokens).toBeLessThan(HAIKU_4_5_CACHE_MINIMUM_TOKENS);
  });
});
