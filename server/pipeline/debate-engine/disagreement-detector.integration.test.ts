/**
 * Integration test against the real provider (#32 AC: "Integration test with
 * real LLM (can be skipped in CI if no key available)"). Skipped whenever Nous
 * is unconfigured, which is the default in CI — run locally with
 * `NOUS_BASE_URL` and a key exported to exercise the real prompt/parse path.
 *
 * Also the model bake-off seam (ADR-0009). It runs the real disagreement
 * prompt through the real wire, so pointing `NOUS_DEBATE_MODEL` at a candidate
 * and running this is how a model gets judged on evidence rather than on its
 * price: did the JSON parse, and did the answer arrive inside the latency the
 * debate budget allows.
 *
 * Talks to Nous via `fetch` rather than any vendor SDK, which isn't a project
 * dependency — `AnthropicMessagesClient` (llm/anthropic-client.ts) is
 * deliberately a narrow structural interface so any wire client satisfies it
 * without one.
 */
import { tryNousCredentials } from '../../shared/llm/index.js';
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
    // Non-null by construction: the suite is skipped when this is undefined.
    const { apiKey, baseUrl, model } = credentials as NonNullable<typeof credentials>;
    const client = new AnthropicLlmClient(new NousMessagesClient({ apiKey, baseUrl }), {
      model,
      max_tokens: 1024,
      timeoutMs: 28_000,
      retry: { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 2_000 },
    });

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

    // Logged, not asserted. The bake-off reads this to compare candidates
    // against the debate's own 15s crypto budget (latency-budget.ts) — one
    // sample is evidence for a human choosing a model, not a threshold worth
    // failing a suite over.
    console.log(
      `[bake-off] model=${model} elapsed_ms=${elapsedMs} conflicts=${result.conflicts.length}`,
    );

    expect(result.method).toBe('semantic');
    expect(result.conflicts.length).toBeGreaterThan(0);
    expect(result.summary.length).toBeGreaterThan(0);
  }, 30_000);
});
