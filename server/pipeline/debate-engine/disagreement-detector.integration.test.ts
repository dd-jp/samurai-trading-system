import { tryNousCredentials, UNGATED_LLM_IN_FLIGHT } from '../../shared/llm/index.js';
import { detectDisagreements } from './disagreement-detector.js';
import { AnthropicLlmClient } from './llm/anthropic-client.js';
import { NousMessagesClient } from './llm/nous-messages-client.js';
import type { AnalystView } from './types.js';

const credentials = tryNousCredentials('debate');

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

describe.skipIf(credentials === undefined)('detectDisagreements (real LLM integration)', () => {
  it('detects a semantic conflict between two bullish analysts with contradictory reasoning', async () => {
    const { apiKey, baseUrl, model } = credentials as NonNullable<typeof credentials>;
    const client = new AnthropicLlmClient(
      new NousMessagesClient({ apiKey, baseUrl, gate: UNGATED_LLM_IN_FLIGHT }),
      {
        model,
        max_tokens: 1024,
        timeoutMs: 28_000,
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

    const started = Date.now();
    const result = await detectDisagreements(views, client);
    const elapsedMs = Date.now() - started;

    console.log(
      `[bake-off] model=${model} elapsed_ms=${elapsedMs} conflicts=${result.conflicts.length}`,
    );

    expect(result.method).toBe('semantic');
    expect(result.conflicts.length).toBeGreaterThan(0);
    expect(result.summary.length).toBeGreaterThan(0);
  }, 30_000);
});
