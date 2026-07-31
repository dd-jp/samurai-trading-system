import { detectDisagreements } from './disagreement-detector.js';
import { LlmMalformedResponseError, LlmTimeoutError } from './llm/errors.js';
import { MockLlmClient } from './llm/mock-client.js';
import type { AnalystView } from './types.js';

function makeView(overrides: Partial<AnalystView> = {}): AnalystView {
  return {
    trace_id: 'trace-1',
    analyst_id: 'analyst-technical-1',
    analyst_type: 'technical',
    direction: 'bullish',
    confidence: 0.8,
    key_points: ['Volume confirms breakout.'],
    timestamp: new Date('2026-07-14T09:00:00Z'),
    ...overrides,
  };
}

describe('detectDisagreements', () => {
  it('returns the LLM-detected semantic conflict between same-direction analysts', async () => {
    const mock = new MockLlmClient();
    mock.enqueueText(
      JSON.stringify({
        summary: 'Both analysts are bullish but disagree on the driver.',
        conflicts: [
          {
            analysts: ['a1', 'a2'],
            nature:
              'a1 cites momentum breakout; a2 cites short-term oversold bounce, not trend continuation.',
          },
        ],
      }),
    );
    const views = [
      makeView({ analyst_id: 'a1', key_points: ['Momentum breakout confirmed by volume.'] }),
      makeView({
        analyst_id: 'a2',
        analyst_type: 'sentiment',
        key_points: ['Oversold bounce likely, not a trend change.'],
      }),
    ];

    const result = await detectDisagreements(views, mock);

    expect(result.method).toBe('semantic');
    expect(result.conflicts).toEqual([
      {
        analysts: ['a1', 'a2'],
        nature:
          'a1 cites momentum breakout; a2 cites short-term oversold bounce, not trend continuation.',
      },
    ]);
    expect(result.summary).toBe('Both analysts are bullish but disagree on the driver.');
  });

  it('returns no conflicts when the LLM finds none', async () => {
    const mock = new MockLlmClient();
    mock.enqueueText(JSON.stringify({ summary: 'Analysts agree.', conflicts: [] }));
    const views = [makeView({ analyst_id: 'a1' }), makeView({ analyst_id: 'a2' })];

    const result = await detectDisagreements(views, mock);

    expect(result).toEqual({ summary: 'Analysts agree.', conflicts: [], method: 'semantic' });
  });

  it('sends the analyst views as context to the LLM', async () => {
    const mock = new MockLlmClient();
    mock.enqueueText(JSON.stringify({ summary: 'ok', conflicts: [] }));
    const views = [makeView({ analyst_id: 'a1' }), makeView({ analyst_id: 'a2' })];

    await detectDisagreements(views, mock);

    expect(mock.requests[0].context.analyst_views).toEqual(views);
  });

  it('falls back to directional comparison on LLM timeout', async () => {
    const mock = new MockLlmClient();
    mock.enqueueError(new LlmTimeoutError('timed out'));
    const views = [
      makeView({ analyst_id: 'a1', direction: 'bullish' }),
      makeView({ analyst_id: 'a2', direction: 'bearish' }),
    ];

    const result = await detectDisagreements(views, mock);

    expect(result.method).toBe('directional_fallback');
    expect(result.conflicts).toEqual([
      { analysts: ['a2'], nature: 'Directional disagreement: analysts hold a "bearish" view.' },
      { analysts: ['a1'], nature: 'Directional disagreement: analysts hold a "bullish" view.' },
    ]);
  });

  it('falls back to directional comparison on malformed LLM response', async () => {
    const mock = new MockLlmClient();
    mock.enqueueText('not json');
    const views = [
      makeView({ analyst_id: 'a1', direction: 'bullish' }),
      makeView({ analyst_id: 'a2', direction: 'bullish' }),
    ];

    const result = await detectDisagreements(views, mock);

    expect(result.method).toBe('directional_fallback');
    expect(result.summary).toBe('No directional disagreement among analysts.');
    expect(result.conflicts).toEqual([]);
  });

  it('falls back when the LLM response is well-formed JSON but the wrong shape', async () => {
    const mock = new MockLlmClient();
    mock.enqueueText(JSON.stringify({ oops: true }));
    const views = [
      makeView({ analyst_id: 'a1', direction: 'bullish' }),
      makeView({ analyst_id: 'a2', direction: 'neutral' }),
    ];

    const result = await detectDisagreements(views, mock);

    expect(result.method).toBe('directional_fallback');
  });

  it('propagates LlmMalformedResponseError from the client as a fallback trigger too', async () => {
    const mock = new MockLlmClient();
    mock.enqueueError(new LlmMalformedResponseError('bad shape'));
    const views = [makeView({ analyst_id: 'a1' }), makeView({ analyst_id: 'a2' })];

    const result = await detectDisagreements(views, mock);

    expect(result.method).toBe('directional_fallback');
  });

  it('skips the LLM call entirely for fewer than two views', async () => {
    const mock = new MockLlmClient();
    const views = [makeView({ analyst_id: 'a1' })];

    const result = await detectDisagreements(views, mock);

    expect(result.method).toBe('directional_fallback');
    expect(result.conflicts).toEqual([]);
    expect(mock.requests).toEqual([]);
  });

  it('reports no disagreement in the fallback when all analysts share a direction', async () => {
    const mock = new MockLlmClient();
    mock.enqueueError(new LlmTimeoutError('timed out'));
    const views = [
      makeView({ analyst_id: 'a1', direction: 'bullish' }),
      makeView({ analyst_id: 'a2', direction: 'bullish' }),
      makeView({ analyst_id: 'a3', direction: 'bullish' }),
    ];

    const result = await detectDisagreements(views, mock);

    expect(result.method).toBe('directional_fallback');
    expect(result.conflicts).toEqual([]);
    expect(result.summary).toBe('No directional disagreement among analysts.');
  });
});
