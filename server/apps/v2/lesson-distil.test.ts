import { describe, expect, it, vi } from 'vitest';
import {
  type AnthropicMessageRequest,
  type AnthropicMessagesClient,
  type SpendCap,
  SqliteLlmSpendStore,
  UNCAPPED_SPEND,
} from '../../shared/debate/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { migratedMemoryStore } from '../../shared/store/migrated-template.js';
import { LESSON_BOOK_ID } from './lesson-buckets.js';
import {
  distilLessons,
  formatLessonDistil,
  LESSON_PROMPT_TEMPLATE,
  lessonClient,
  lessonTraceId,
  parseLessons,
} from './lesson-distil.js';
import { LESSON_PIN } from './signal/index.js';

const AS_OF = '2026-11-20';

function bucketRow(bucket: string, n: number, asOf = AS_OF) {
  return {
    as_of: asOf,
    bucket,
    book_id: LESSON_BOOK_ID,
    n,
    mean_excess: -0.2,
    hit_rate: 0.1,
    ci_low: -0.27,
    ci_high: -0.15,
    baseline_book_id: 'arm2/technical-only',
    baseline_n: 6,
    baseline_mean_excess: -0.21,
    evidence: '[]',
    inputs_hash: 'inputs',
    schema_version: 1,
  };
}

function addBuckets(db: StoreHandle, asOf: string, closedTrades: number): void {
  const insert = db.prepare(
    `INSERT INTO v2_lesson_buckets (as_of, bucket, book_id, n, mean_excess, hit_rate, ci_low,
        ci_high, baseline_book_id, baseline_n, baseline_mean_excess, evidence, inputs_hash,
        schema_version)
      VALUES (@as_of, @bucket, @book_id, @n, @mean_excess, @hit_rate, @ci_low, @ci_high,
        @baseline_book_id, @baseline_n, @baseline_mean_excess, @evidence, @inputs_hash,
        @schema_version)`,
  );
  insert.run(bucketRow('all', closedTrades, asOf));
  insert.run(bucketRow('direction=short', 13, asOf));
}

function store(closedTrades = 25): StoreHandle {
  const db = migratedMemoryStore();
  if (closedTrades > 0) addBuckets(db, AS_OF, closedTrades);
  return db;
}

const ANSWER = JSON.stringify({
  lessons: [{ bucket: 'direction=short', claim: ' Shorts lost to the index, as arm 2 did. ' }],
});

class AnsweringTransport implements AnthropicMessagesClient {
  readonly requests: AnthropicMessageRequest[] = [];
  constructor(
    private readonly text = ANSWER,
    private readonly stopReason = 'end_turn',
  ) {}
  createMessage(request: AnthropicMessageRequest) {
    this.requests.push(request);
    return Promise.resolve({
      content: [{ type: 'text' as const, text: this.text }],
      usage: { input_tokens: 900, output_tokens: 60 },
      stop_reason: this.stopReason,
      model: LESSON_PIN.priced,
    });
  }
}

function deps(
  db: StoreHandle,
  transport: AnthropicMessagesClient,
  spendCap: SpendCap = UNCAPPED_SPEND,
) {
  return {
    db,
    spendCap,
    live: () => lessonClient(transport, new SqliteLlmSpendStore(db, undefined, true)),
  };
}

const NEVER = {
  db: undefined as unknown as StoreHandle,
  spendCap: UNCAPPED_SPEND,
  live: () => {
    throw new Error('the model must not be called');
  },
};

describe('distilLessons', () => {
  it('calls nothing when the as_of has no qualifying bucket', async () => {
    const db = store(0);
    expect(await distilLessons({ ...NEVER, db }, AS_OF)).toEqual({
      lessons: [],
      written: 0,
      source: 'none',
    });
  });

  it('asks the pinned model once over the bucket statistics and stores its claims', async () => {
    const db = store();
    const transport = new AnsweringTransport();
    const distil = await distilLessons(deps(db, transport), AS_OF);
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]?.model).toBe(LESSON_PIN.wire);
    const content = transport.requests[0]?.messages[0]?.content ?? '';
    expect(content.startsWith(LESSON_PROMPT_TEMPLATE)).toBe(true);
    expect(content).toContain('"bucket": "direction=short"');
    expect(content).not.toContain('evidence');
    expect(distil).toMatchObject({ source: 'model', written: 1 });
    expect(db.prepare('SELECT bucket, claim, model, trace_id FROM v2_lessons').all()).toEqual([
      {
        bucket: 'direction=short',
        claim: 'Shorts lost to the index, as arm 2 did.',
        model: LESSON_PIN.wire,
        trace_id: lessonTraceId(AS_OF, LESSON_BOOK_ID),
      },
    ]);
    expect(
      db.prepare('SELECT trace_id, model FROM llm_call_log WHERE response IS NOT NULL').all(),
    ).toEqual([{ trace_id: lessonTraceId(AS_OF, LESSON_BOOK_ID), model: LESSON_PIN.priced }]);
  });

  it('replays a rerun at the same as_of from llm_call_log, calling and writing nothing', async () => {
    const db = store();
    const first = await distilLessons(deps(db, new AnsweringTransport()), AS_OF);
    const rerun = await distilLessons({ ...NEVER, db }, AS_OF);
    expect(rerun).toEqual({ lessons: first.lessons, written: 0, source: 'replay' });
  });

  it('writes the replayed lessons when the logged call never reached the table', async () => {
    const db = store();
    const failing = vi.spyOn(db, 'transaction').mockImplementationOnce(() => {
      throw new Error('crash before the write');
    });
    await expect(distilLessons(deps(db, new AnsweringTransport()), AS_OF)).rejects.toThrow(
      'crash before the write',
    );
    failing.mockRestore();
    const replayed = await distilLessons({ ...NEVER, db }, AS_OF);
    expect(replayed).toMatchObject({ source: 'replay', written: 1 });
  });

  it('refuses a stored run that the logged answer no longer reproduces', async () => {
    const db = store();
    await distilLessons(deps(db, new AnsweringTransport()), AS_OF);
    db.prepare('UPDATE llm_call_log SET response = ? WHERE response IS NOT NULL').run(
      JSON.stringify({ lessons: [{ bucket: 'all', claim: 'Something else.' }] }),
    );
    await expect(distilLessons({ ...NEVER, db }, AS_OF)).rejects.toThrow(
      /differ from the stored lessons/,
    );
  });

  it('calls again after a logged failure, which settles nothing', async () => {
    const db = store();
    db.prepare(
      `INSERT INTO llm_call_log (trace_id, stage, model, timestamp, prompt, response, error_class,
          error_message)
        VALUES (?, 'lessons', ?, 't', 'p', NULL, 'LlmTimeoutError', 'timed out')`,
    ).run(lessonTraceId(AS_OF, LESSON_BOOK_ID), LESSON_PIN.priced);
    const transport = new AnsweringTransport();
    expect(await distilLessons(deps(db, transport), AS_OF)).toMatchObject({ source: 'model' });
    expect(transport.requests).toHaveLength(1);
  });

  it('waits for 25 closed trades before the first call', async () => {
    const db = store(24);
    expect(await distilLessons({ ...NEVER, db }, AS_OF)).toMatchObject({ source: 'not_due' });
  });

  it('calls again only once a further 25 trades have closed since the last answered call', async () => {
    const db = store(25);
    await distilLessons(deps(db, new AnsweringTransport()), AS_OF);
    addBuckets(db, '2026-11-27', 49);
    expect(await distilLessons({ ...NEVER, db }, '2026-11-27')).toMatchObject({
      source: 'not_due',
    });
    addBuckets(db, '2026-12-04', 50);
    const transport = new AnsweringTransport();
    expect(await distilLessons(deps(db, transport), '2026-12-04')).toMatchObject({
      source: 'model',
      written: 1,
    });
    expect(transport.requests).toHaveLength(1);
  });

  it.each([
    ['a malformed answer', new AnsweringTransport('sorry, cannot')],
    ['a refused answer', new AnsweringTransport(ANSWER, 'refusal')],
    ['a truncated answer', new AnsweringTransport(ANSWER.slice(0, 40), 'max_tokens')],
  ])('leaves the run unsettled after %s, so the next run calls again', async (_, failing) => {
    const db = store();
    await expect(distilLessons(deps(db, failing), AS_OF)).rejects.toThrow();
    const transport = new AnsweringTransport();
    expect(await distilLessons(deps(db, transport), AS_OF)).toMatchObject({
      source: 'model',
      written: 1,
    });
    expect(transport.requests).toHaveLength(1);
  });

  it('does not pay again for a band already distilled at a later as_of', async () => {
    const db = store(25);
    addBuckets(db, '2026-12-04', 30);
    await distilLessons(deps(db, new AnsweringTransport()), '2026-12-04');
    expect(await distilLessons({ ...NEVER, db }, AS_OF)).toMatchObject({ source: 'not_due' });
  });

  it('refuses before calling when the monthly spend cap is reached', async () => {
    const db = store();
    const capped: SpendCap = {
      check: () => ({ admitted: false, spent_usd: 30, budget_usd: 30, kind: 'budget' }),
    };
    const transport = new AnsweringTransport();
    await expect(distilLessons(deps(db, transport, capped), AS_OF)).rejects.toThrow(
      'LLM spend cap reached: 30 of 30 USD',
    );
    expect(transport.requests).toHaveLength(0);
  });
});

describe('parseLessons', () => {
  const buckets = [bucketRow('all', 25), bucketRow('direction=short', 13)];

  it('reads a fenced JSON answer and an empty list', () => {
    expect(
      parseLessons('```json\n{"lessons":[{"bucket":"all","claim":"c"}]}\n```', buckets),
    ).toEqual({
      valid: true,
      data: [{ bucket: 'all', claim: 'c' }],
    });
    expect(parseLessons('{"lessons":[]}', buckets)).toEqual({ valid: true, data: [] });
  });

  it.each([
    ['not json', 'answer is not JSON'],
    ['{"lessons": "x"}', 'no lessons array'],
    ['no braces at all', 'no lessons array'],
    ['{"lessons":[{"bucket":"news=0","claim":"c"}]}', 'unknown bucket news=0'],
    ['{"lessons":[{"bucket":"all","claim":"  "}]}', 'no claim for all'],
    [`{"lessons":[{"bucket":"all","claim":"${'x'.repeat(281)}"}]}`, 'claim for all is too long'],
    [
      '{"lessons":[{"bucket":"all","claim":"a"},{"bucket":"all","claim":"b"}]}',
      'a bucket has two lessons',
    ],
  ])('refuses %s', (raw, reason) => {
    expect(parseLessons(raw.replace('not json', '{not json}'), buckets)).toEqual({
      valid: false,
      reason,
    });
  });
});

describe('formatLessonDistil', () => {
  it('lists each claim under its bucket', () => {
    expect(
      formatLessonDistil({
        lessons: [
          { ...bucketRow('all', 1), claim: 'c', model: 'm', prompt_hash: 'p', trace_id: 't' },
        ],
        written: 1,
        source: 'model',
      }),
    ).toBe('lessons: 1 (model), 1 written\n  all: c');
  });
});
