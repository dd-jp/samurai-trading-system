import { describe, expect, it } from 'vitest';
import type { StoreHandle } from '../../shared/store/index.js';
import { migratedMemoryStore } from '../../shared/store/migrated-template.js';
import { LESSON_BOOK_ID, LESSONS_PER_PROMPT } from './lesson-recipe.js';
import {
  latestLessonSource,
  lessonTags,
  pickLessons,
  pinnedLessonSource,
} from './lesson-select.js';

function candidate(bucket: string, meanExcess: number) {
  return { bucket, claim: `claim on ${bucket}`, mean_excess: meanExcess };
}

describe('lessonTags', () => {
  it('tags every routed venue, both directions and the news band', () => {
    expect([...lessonTags(['alpaca', 'saxo_cfd_usd'], 3)]).toEqual([
      'all',
      'venue=alpaca',
      'venue=saxo_cfd_usd',
      'direction=long',
      'direction=short',
      'news=1-4',
    ]);
    expect(lessonTags([], 0).has('news=0')).toBe(true);
    expect(lessonTags([], 5).has('news=5+')).toBe(true);
  });
});

describe('pickLessons', () => {
  const tags = lessonTags(['alpaca'], 0);

  it('drops buckets the name does not carry and the debate-only tags', () => {
    expect(
      pickLessons(
        [
          candidate('venue=saxo', -0.4),
          candidate('confidence=0.7', -0.5),
          candidate('news=0', 0.1),
        ],
        tags,
      ),
    ).toEqual(['news=0: claim on news=0']);
  });

  it('ranks specific buckets before all, then by the size of the mean excess', () => {
    expect(
      pickLessons(
        [
          candidate('all', -0.9),
          candidate('direction=long', 0.05),
          candidate('venue=alpaca', -0.3),
          candidate('direction=short', -0.3),
        ],
        tags,
      ),
    ).toEqual([
      'direction=short: claim on direction=short',
      'venue=alpaca: claim on venue=alpaca',
      'direction=long: claim on direction=long',
    ]);
  });

  it(`keeps at most ${LESSONS_PER_PROMPT}`, () => {
    const many = ['all', 'venue=alpaca', 'direction=long', 'direction=short', 'news=0'].map((b) =>
      candidate(b, -0.1),
    );
    expect(pickLessons(many, tags)).toHaveLength(LESSONS_PER_PROMPT);
  });
});

function addLesson(db: StoreHandle, asOf: string, bucket: string, meanExcess: number): void {
  db.prepare(
    `INSERT INTO v2_lesson_buckets (as_of, bucket, book_id, n, mean_excess, hit_rate, ci_low,
        ci_high, baseline_book_id, baseline_n, baseline_mean_excess, evidence, inputs_hash,
        schema_version)
      VALUES (?, ?, ?, 25, ?, 0.4, -0.3, -0.1, 'arm2/technical-only', 25, 0, '[]', 'h', 1)`,
  ).run(asOf, bucket, LESSON_BOOK_ID, meanExcess);
  db.prepare(
    `INSERT INTO v2_lessons (as_of, book_id, bucket, claim, model, prompt_hash, inputs_hash,
        trace_id, schema_version)
      VALUES (?, ?, ?, ?, 'm', 'p', 'h', 't', 1)`,
  ).run(asOf, LESSON_BOOK_ID, bucket, `claim ${asOf}`);
}

describe('lesson sources', () => {
  function store(): StoreHandle {
    const db = migratedMemoryStore();
    addLesson(db, '2026-11-10', 'all', -0.2);
    addLesson(db, '2026-11-20', 'direction=short', -0.3);
    return db;
  }

  it('reads the latest run strictly before the trading date', () => {
    const source = latestLessonSource(store());
    expect(source('2026-11-20', 'AAPL')).toEqual({
      asOf: '2026-11-10',
      candidates: [{ bucket: 'all', claim: 'claim 2026-11-10', mean_excess: -0.2 }],
    });
    expect(source('2026-11-21', 'AAPL')?.asOf).toBe('2026-11-20');
    expect(source('2026-11-10', 'AAPL')).toBeUndefined();
  });

  it('ignores another book', () => {
    expect(latestLessonSource(store(), 'arm2/technical-only')('2026-11-30', 'AAPL')).toBe(
      undefined,
    );
  });

  it('replays the run each name was journalled with, not the latest', () => {
    const source = pinnedLessonSource(store(), new Map([['AAPL', '2026-11-10']]));
    expect(source('2026-11-30', 'AAPL')?.asOf).toBe('2026-11-10');
    expect(source('2026-11-30', 'MSFT')).toBeUndefined();
  });
});
