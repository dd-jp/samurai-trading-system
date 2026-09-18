import {
  collectAnalystViews,
  type ExpectedAnalyst,
  validateAnalystView,
} from './analyst-response-collector.js';
import type { AnalystView } from './types.js';

const TIMEOUT_MS = 15_000;

function makeView(overrides: Partial<AnalystView> = {}): AnalystView {
  return {
    trace_id: 'trace-1',
    analyst_id: 'analyst-technical-1',
    analyst_type: 'technical',
    direction: 'bullish',
    confidence: 0.8,
    key_points: ['RSI oversold bounce'],
    timestamp: new Date('2026-07-19T09:00:00Z'),
    ...overrides,
  };
}

function neverResolves(): Promise<AnalystView> {
  return new Promise(() => {});
}

function resolvesAfter(ms: number, view: AnalystView): Promise<AnalystView> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(view), ms);
  });
}

describe('validateAnalystView', () => {
  it('accepts a well-formed AnalystView', () => {
    const result = validateAnalystView(makeView());
    expect(result).toEqual({ valid: true, view: makeView() });
  });

  it('rejects a non-object', () => {
    const result = validateAnalystView(null);
    expect(result).toEqual({ valid: false, reason: expect.stringContaining('not an object') });
  });

  it('rejects a missing analyst_id', () => {
    const { analyst_id: _analyst_id, ...rest } = makeView();
    const result = validateAnalystView(rest);
    expect(result.valid).toBe(false);
  });

  it('rejects an invalid direction', () => {
    const result = validateAnalystView({ ...makeView(), direction: 'sideways' });
    expect(result.valid).toBe(false);
  });

  it('rejects an out-of-range confidence', () => {
    const result = validateAnalystView({ ...makeView(), confidence: 1.5 });
    expect(result.valid).toBe(false);
  });

  it('rejects a non-array key_points', () => {
    const result = validateAnalystView({ ...makeView(), key_points: 'not an array' });
    expect(result.valid).toBe(false);
  });

  it('rejects a missing timestamp', () => {
    const result = validateAnalystView({ ...makeView(), timestamp: 'not a date' });
    expect(result.valid).toBe(false);
  });
});

describe('collectAnalystViews', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns all views when every analyst responds in time', async () => {
    const expected: ExpectedAnalyst[] = [
      {
        analyst_id: 'analyst-technical-1',
        analyst_type: 'technical',
        response: Promise.resolve(makeView({ analyst_id: 'analyst-technical-1' })),
      },
      {
        analyst_id: 'analyst-sentiment-1',
        analyst_type: 'sentiment',
        response: Promise.resolve(makeView({ analyst_id: 'analyst-sentiment-1' })),
      },
    ];

    const resultPromise = collectAnalystViews(expected, TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;

    expect(result.quorum_met).toBe(true);
    expect(result.views).toHaveLength(2);
    expect(result.failures).toHaveLength(0);
    expect(result.expected_count).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('proceeds with responders when quorum is met after a straggler times out', async () => {
    const expected: ExpectedAnalyst[] = [
      {
        analyst_id: 'analyst-technical-1',
        analyst_type: 'technical',
        response: Promise.resolve(makeView({ analyst_id: 'analyst-technical-1' })),
      },
      {
        analyst_id: 'analyst-sentiment-1',
        analyst_type: 'sentiment',
        response: Promise.resolve(makeView({ analyst_id: 'analyst-sentiment-1' })),
      },
      {
        analyst_id: 'analyst-fundamental-1',
        analyst_type: 'fundamental',
        response: neverResolves(),
      },
    ];

    const resultPromise = collectAnalystViews(expected, TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    const result = await resultPromise;

    expect(result.quorum_met).toBe(true);
    expect(result.views.map((v) => v.analyst_id).sort()).toEqual([
      'analyst-sentiment-1',
      'analyst-technical-1',
    ]);
    expect(result.failures).toEqual([
      {
        analyst_id: 'analyst-fundamental-1',
        analyst_type: 'fundamental',
        reason: `timeout: no response within ${TIMEOUT_MS}ms`,
      },
    ]);
  });

  it('aborts (empty views) when quorum is not met after timeout', async () => {
    const expected: ExpectedAnalyst[] = [
      {
        analyst_id: 'analyst-technical-1',
        analyst_type: 'technical',
        response: Promise.resolve(makeView({ analyst_id: 'analyst-technical-1' })),
      },
      { analyst_id: 'analyst-sentiment-1', analyst_type: 'sentiment', response: neverResolves() },
      {
        analyst_id: 'analyst-fundamental-1',
        analyst_type: 'fundamental',
        response: neverResolves(),
      },
    ];

    const resultPromise = collectAnalystViews(expected, TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    const result = await resultPromise;

    expect(result.quorum_met).toBe(false);
    expect(result.views).toEqual([]);
    expect(result.failures).toHaveLength(2);
    expect(result.expected_count).toBe(3);
  });

  it('aborts when no analyst responds', async () => {
    const expected: ExpectedAnalyst[] = [
      { analyst_id: 'analyst-technical-1', analyst_type: 'technical', response: neverResolves() },
      { analyst_id: 'analyst-sentiment-1', analyst_type: 'sentiment', response: neverResolves() },
    ];

    const resultPromise = collectAnalystViews(expected, TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    const result = await resultPromise;

    expect(result.quorum_met).toBe(false);
    expect(result.views).toEqual([]);
    expect(result.failures).toEqual([
      {
        analyst_id: 'analyst-technical-1',
        analyst_type: 'technical',
        reason: `timeout: no response within ${TIMEOUT_MS}ms`,
      },
      {
        analyst_id: 'analyst-sentiment-1',
        analyst_type: 'sentiment',
        reason: `timeout: no response within ${TIMEOUT_MS}ms`,
      },
    ]);
  });

  it('treats a settled-but-malformed response as a validation failure, not a view', async () => {
    const expected: ExpectedAnalyst[] = [
      {
        analyst_id: 'analyst-technical-1',
        analyst_type: 'technical',
        response: Promise.resolve(makeView({ analyst_id: 'analyst-technical-1' })),
      },
      {
        analyst_id: 'analyst-sentiment-1',
        analyst_type: 'sentiment',
        response: Promise.resolve({
          analyst_id: 'analyst-sentiment-1',
        } as unknown as AnalystView),
      },
    ];

    const resultPromise = collectAnalystViews(expected, TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;

    expect(result.quorum_met).toBe(true);
    expect(result.views).toHaveLength(1);
    expect(result.failures).toEqual([
      {
        analyst_id: 'analyst-sentiment-1',
        analyst_type: 'sentiment',
        reason: expect.stringContaining('malformed output'),
      },
    ]);
  });

  it('categorizes a rejected response as an error, not a timeout', async () => {
    const expected: ExpectedAnalyst[] = [
      {
        analyst_id: 'analyst-technical-1',
        analyst_type: 'technical',
        response: Promise.reject(new Error('upstream 500')),
      },
      {
        analyst_id: 'analyst-sentiment-1',
        analyst_type: 'sentiment',
        response: Promise.resolve(makeView({ analyst_id: 'analyst-sentiment-1' })),
      },
    ];

    const resultPromise = collectAnalystViews(expected, TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;

    expect(result.quorum_met).toBe(true);
    expect(result.failures).toEqual([
      {
        analyst_id: 'analyst-technical-1',
        analyst_type: 'technical',
        reason: 'upstream 500',
      },
    ]);
  });

  it('records a hostile rejection as an error outcome instead of rejecting the whole collection (#1262)', async () => {
    const hostile: Record<string, unknown> = {
      [Symbol.toPrimitive]: () => {
        throw new Error('render boom');
      },
    };
    hostile.self = hostile;

    const expected: ExpectedAnalyst[] = [
      {
        analyst_id: 'analyst-technical-1',
        analyst_type: 'technical',
        response: Promise.reject(hostile),
      },
      {
        analyst_id: 'analyst-sentiment-1',
        analyst_type: 'sentiment',
        response: Promise.resolve(makeView({ analyst_id: 'analyst-sentiment-1' })),
      },
    ];

    const resultPromise = collectAnalystViews(expected, TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;

    expect(result.views.map((view) => view.analyst_id)).toEqual(['analyst-sentiment-1']);
    expect(result.quorum_met).toBe(true);
    expect(result.failures).toEqual([
      {
        analyst_id: 'analyst-technical-1',
        analyst_type: 'technical',
        reason: '[unrenderable error]',
      },
    ]);
  });

  it('resolves at the exact 50% quorum boundary (2 of 4)', async () => {
    const expected: ExpectedAnalyst[] = [
      {
        analyst_id: 'a1',
        analyst_type: 'technical',
        response: Promise.resolve(makeView({ analyst_id: 'a1' })),
      },
      {
        analyst_id: 'a2',
        analyst_type: 'sentiment',
        response: Promise.resolve(makeView({ analyst_id: 'a2' })),
      },
      { analyst_id: 'a3', analyst_type: 'fundamental', response: neverResolves() },
      { analyst_id: 'a4', analyst_type: 'fundamental', response: neverResolves() },
    ];

    const resultPromise = collectAnalystViews(expected, TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    const result = await resultPromise;

    expect(result.quorum_met).toBe(true);
    expect(result.views).toHaveLength(2);
  });

  it('does not resolve before the timeout while a straggler is still pending', async () => {
    const expected: ExpectedAnalyst[] = [
      {
        analyst_id: 'analyst-technical-1',
        analyst_type: 'technical',
        response: resolvesAfter(TIMEOUT_MS - 1, makeView({ analyst_id: 'analyst-technical-1' })),
      },
    ];

    let resolved = false;
    const resultPromise = collectAnalystViews(expected, TIMEOUT_MS).then((r) => {
      resolved = true;
      return r;
    });

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 2);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(2);
    const result = await resultPromise;

    expect(resolved).toBe(true);
    expect(result.quorum_met).toBe(true);
    expect(result.views).toHaveLength(1);
  });
});
