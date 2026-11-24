import type { StoreHandle } from '../../shared/store/index.js';
import { LESSON_BOOK_ID, LESSONS_PER_PROMPT, newsBand } from './lesson-recipe.js';

export interface LessonCandidate {
  readonly bucket: string;
  readonly claim: string;
  readonly mean_excess: number;
}

export interface StoredLessons {
  readonly asOf: string;
  readonly candidates: readonly LessonCandidate[];
}

export type LessonSource = (tradingDate: string, instrument: string) => StoredLessons | undefined;

export function lessonTags(venues: readonly string[], headlines: number): ReadonlySet<string> {
  return new Set([
    'all',
    ...venues.map((venue) => `venue=${venue}`),
    'direction=long',
    'direction=short',
    `news=${newsBand(headlines)}`,
  ]);
}

function generality(bucket: string): number {
  return bucket === 'all' ? 1 : 0;
}

export function pickLessons(
  candidates: readonly LessonCandidate[],
  tags: ReadonlySet<string>,
): string[] {
  return candidates
    .filter((candidate) => tags.has(candidate.bucket))
    .sort(
      (a, b) =>
        generality(a.bucket) - generality(b.bucket) ||
        Math.abs(b.mean_excess) - Math.abs(a.mean_excess) ||
        (a.bucket < b.bucket ? -1 : 1),
    )
    .slice(0, LESSONS_PER_PROMPT)
    .map((candidate) => `${candidate.bucket}: ${candidate.claim}`);
}

function candidatesAt(db: StoreHandle, asOf: string, bookId: string): LessonCandidate[] {
  return db
    .prepare(
      `SELECT l.bucket, l.claim, b.mean_excess
         FROM v2_lessons l
         JOIN v2_lesson_buckets b
           ON b.as_of = l.as_of AND b.book_id = l.book_id AND b.bucket = l.bucket
        WHERE l.as_of = ? AND l.book_id = ?
        ORDER BY l.bucket`,
    )
    .all(asOf, bookId) as LessonCandidate[];
}

function lessonsAt(db: StoreHandle, asOf: string, bookId: string): StoredLessons | undefined {
  const candidates = candidatesAt(db, asOf, bookId);
  return candidates.length === 0 ? undefined : { asOf, candidates };
}

export function latestLessonSource(db: StoreHandle, bookId = LESSON_BOOK_ID): LessonSource {
  return (tradingDate) => {
    const row = db
      .prepare('SELECT MAX(as_of) AS as_of FROM v2_lessons WHERE book_id = ? AND as_of < ?')
      .get(bookId, tradingDate) as { as_of: string | null } | undefined;
    return row?.as_of == null ? undefined : lessonsAt(db, row.as_of, bookId);
  };
}

// v2_lessons carries no write time, so a run written after a cycle would be visible to its replay;
// replay reads back the as_of the cycle journalled instead of the latest one in the store
export function pinnedLessonSource(
  db: StoreHandle,
  asOfByInstrument: ReadonlyMap<string, string>,
  bookId = LESSON_BOOK_ID,
): LessonSource {
  return (_tradingDate, instrument) => {
    const asOf = asOfByInstrument.get(instrument);
    return asOf === undefined ? undefined : lessonsAt(db, asOf, bookId);
  };
}
