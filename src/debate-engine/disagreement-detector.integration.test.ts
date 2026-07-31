/**
 * Integration test against the real Anthropic API (#32 AC: "Integration
 * test with real LLM (can be skipped in CI if no key available)"). Skipped
 * whenever ANTHROPIC_API_KEY is unset, which is the default in CI — run
 * locally with the key exported to exercise the real prompt/parse path.
 *
 * Talks to the Messages API directly via `fetch` rather than the
 * `@anthropic-ai/sdk` package, which isn't a project dependency —
 * `AnthropicMessagesClient` (llm/anthropic-client.ts) is deliberately a
 * narrow structural interface so any wire client satisfies it without one.
 */
import { detectDisagreements } from './disagreement-detector.js';
import type { AnthropicMessageRequest, AnthropicMessageResponse } from './llm/anthropic-client.js';
import { AnthropicLlmClient } from './llm/anthropic-client.js';
import type { AnalystView } from './types.js';

const apiKey = process.env.ANTHROPIC_API_KEY;

function makeView(overrides: Partial<AnalystView>): AnalystView {
  return {
    trace_id: 'integration-trace-1',
    analyst_id: 'analyst-1',
    analyst_type: 'technical',
    direction: 'bullish',
    confidence: 0.8,
    key_points: [],
    timestamp: new Date(),
    ...overrides,
  };
}

async function createMessage(request: AnthropicMessageRequest): Promise<AnthropicMessageResponse> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey as string,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const error = new Error(`Anthropic API error: ${response.status}`);
    (error as Error & { status: number }).status = response.status;
    throw error;
  }

  return (await response.json()) as AnthropicMessageResponse;
}

describe.skipIf(!apiKey)('detectDisagreements (real LLM integration)', () => {
  it('detects a semantic conflict between two bullish analysts with contradictory reasoning', async () => {
    const client = new AnthropicLlmClient(
      { createMessage },
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        timeoutMs: 30_000,
        retry: { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 2_000 },
      },
    );

    const views = [
      makeView({
        analyst_id: 'a1',
        analyst_type: 'technical',
        direction: 'bullish',
        key_points: [
          'Price broke above the 200-day moving average on strong volume, confirming a new uptrend.',
        ],
      }),
      makeView({
        analyst_id: 'a2',
        analyst_type: 'sentiment',
        direction: 'bullish',
        key_points: [
          'RSI is deeply oversold and social sentiment is capitulating; expect a short-lived relief bounce, not a trend change.',
        ],
      }),
    ];

    const result = await detectDisagreements(views, client);

    expect(result.method).toBe('semantic');
    expect(result.conflicts.length).toBeGreaterThan(0);
    expect(result.summary.length).toBeGreaterThan(0);
  }, 30_000);
});
