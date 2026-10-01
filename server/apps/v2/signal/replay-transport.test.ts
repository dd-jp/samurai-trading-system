import { describe, expect, it } from 'vitest';
import { wrapUntrusted } from '../../../pipeline/debate-engine/index.js';
import { JUDGE_PIN } from './models.js';
import {
  commonPrefixLength,
  isTruncatedResponse,
  type LoggedCall,
  loggedHeadlines,
  loggedNewsSource,
  loggedPromptOf,
  promptIdentity,
  ReplayLog,
  ReplayTransport,
} from './replay-transport.js';

const MODEL = JUDGE_PIN.priced;

function call(id: number, prompt: string, response: string | null = `r${id}`): LoggedCall {
  return { id, traceId: 'v2-2026-09-30-UP', model: MODEL, prompt, response };
}

function debatePrompt(views: unknown): string {
  return `You are the Bull persona.\n\nContext:\n${wrapUntrusted(JSON.stringify(views, null, 2))}`;
}

describe('promptIdentity', () => {
  it('normalises view timestamps and nothing else', () => {
    expect(promptIdentity('"timestamp": "2026-09-30T07:30:01.123Z", "x": "2026-09-30"')).toBe(
      '"timestamp": "<view clock>", "x": "2026-09-30"',
    );
  });
});

describe('loggedPromptOf', () => {
  it('masks and caps as the spend sink does', () => {
    const prompt = loggedPromptOf('y'.repeat(20_000));
    expect(prompt.startsWith('y'.repeat(16_384))).toBe(true);
    expect(prompt.endsWith('(truncated, 20000 chars total)')).toBe(true);
  });
});

describe('isTruncatedResponse', () => {
  it('needs both the cap length and the suffix', () => {
    expect(isTruncatedResponse(`${'x'.repeat(4_096)}… (truncated, 5000 chars total)`)).toBe(true);
    expect(isTruncatedResponse('short… (truncated, 5000 chars total)')).toBe(false);
    expect(isTruncatedResponse('x'.repeat(5_000))).toBe(false);
  });
});

describe('commonPrefixLength', () => {
  it('counts the shared leading characters', () => {
    expect(commonPrefixLength('abcd', 'abxd')).toBe(2);
    expect(commonPrefixLength('ab', 'abc')).toBe(2);
  });
});

describe('ReplayLog', () => {
  it('serves repeated requests in logged order and keeps what was not asked for', () => {
    const log = new ReplayLog([call(3, 'p', 'second'), call(1, 'p', 'first'), call(2, 'q')]);
    expect(log.serve(MODEL, 'p')).toBe('first');
    expect(log.serve(MODEL, 'p')).toBe('second');
    expect(log.unserved().map((entry) => entry.id)).toEqual([2]);
    expect(log.misses).toEqual([]);
  });

  it('matches a prompt whose view timestamps differ from the logged ones', () => {
    const log = new ReplayLog([call(1, '"timestamp": "2026-09-30T07:30:00.000Z"')]);
    expect(log.serve(MODEL, '"timestamp": "2026-09-30T00:00:00.000Z"')).toBe('r1');
  });

  it('refuses an unlogged request and names the nearest logged prompt of that model', () => {
    const log = new ReplayLog([
      call(1, 'abcdef'),
      call(2, 'abxxxx'),
      { ...call(3, 'abcdeX'), model: 'other' },
    ]);
    expect(() => log.serve(MODEL, 'abcdeZ')).toThrow(
      `replay: request_not_logged for ${MODEL}; no model is called in a replay`,
    );
    expect(log.misses).toEqual([
      expect.objectContaining({ kind: 'request_not_logged', offset: 5, prompt: 'abcdeZ' }),
    ]);
    expect(log.misses[0]?.nearest?.id).toBe(1);
    expect(log.unserved()).toHaveLength(3);
  });

  it('refuses a request when no logged call of that model remains', () => {
    const log = new ReplayLog([]);
    expect(() => log.serve(MODEL, 'p')).toThrow('request_not_logged');
    expect(log.misses[0]).toMatchObject({ nearest: undefined, offset: 0 });
  });

  it('refuses a logged call whose response text was not captured', () => {
    const log = new ReplayLog([call(1, 'p', null)]);
    expect(() => log.serve(MODEL, 'p')).toThrow('response_not_logged');
    expect(log.misses[0]).toMatchObject({ kind: 'response_not_logged', offset: 1 });
  });
});

describe('ReplayTransport', () => {
  it('answers with the logged text as the pin priced model', async () => {
    const transport = new ReplayTransport(JUDGE_PIN, new ReplayLog([call(1, 'p', 'logged')]));
    await expect(
      transport.createMessage({
        model: JUDGE_PIN.wire,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'p' }],
      }),
    ).resolves.toEqual({
      content: [{ type: 'text', text: 'logged' }],
      usage: { input_tokens: 0, output_tokens: 0 },
      stop_reason: 'end_turn',
      model: MODEL,
    });
  });

  it('rejects instead of calling a model when the request is not logged', async () => {
    const transport = new ReplayTransport(JUDGE_PIN, new ReplayLog([]));
    await expect(
      transport.createMessage({ model: JUDGE_PIN.wire, max_tokens: 1, messages: [] }),
    ).rejects.toThrow('request_not_logged');
  });
});

describe('loggedHeadlines', () => {
  const views = (keyPoints: unknown) => ({
    analyst_views: [
      { analyst_id: 'technical', key_points: ['close'] },
      { analyst_id: 'news', key_points: keyPoints },
    ],
  });

  it('reads the news view back from the first logged prompt of the trace', () => {
    const calls = [call(1, debatePrompt(views(['A beats', 'B misses'])))];
    expect(loggedHeadlines(calls, 'v2-2026-09-30-UP')).toEqual(['A beats', 'B misses']);
  });

  it('reads the no-headlines key point back as no headlines', () => {
    const calls = [call(1, debatePrompt(views(['no per-name headlines in the window'])))];
    expect(loggedHeadlines(calls, 'v2-2026-09-30-UP')).toEqual([]);
  });

  it('finds nothing for another trace, a capped prompt, bad JSON or a malformed view', () => {
    const good = debatePrompt(views(['A']));
    expect(loggedHeadlines([call(1, good)], 'v2-2026-09-30-DOWN')).toBeUndefined();
    expect(loggedHeadlines([call(1, `${good}… (truncated)`)], 'v2-2026-09-30-UP')).toBeUndefined();
    expect(loggedHeadlines([call(1, 'no context')], 'v2-2026-09-30-UP')).toBeUndefined();
    const broken = good.replace('"analyst_views"', 'analyst_views');
    expect(loggedHeadlines([call(1, broken)], 'v2-2026-09-30-UP')).toBeUndefined();
    const numeric = debatePrompt(views([1]));
    expect(loggedHeadlines([call(1, numeric)], 'v2-2026-09-30-UP')).toBeUndefined();
  });
});

describe('loggedNewsSource', () => {
  it('serves recovered headlines and rejects a name with no logged prompt', async () => {
    const news = loggedNewsSource([call(1, debatePrompt({ analyst_views: [] }))]);
    await expect(news.headlines('UP', '2026-09-30', new Date())).rejects.toThrow(
      'replay: no logged prompt carries the headlines for UP',
    );
    const served = loggedNewsSource([
      call(1, debatePrompt({ analyst_views: [{ analyst_id: 'news', key_points: ['A'] }] })),
    ]);
    await expect(served.headlines('UP', '2026-09-30', new Date())).resolves.toEqual(['A']);
  });
});
