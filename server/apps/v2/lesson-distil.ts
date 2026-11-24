import {
  AnthropicLlmClient,
  type AnthropicMessagesClient,
  type LlmClient,
  type LlmSpendSink,
  type SpendCap,
} from '../../shared/debate/index.js';
import { hashPromptTemplate } from '../../shared/llm/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { type LessonBucket, storedLessonBuckets } from './lesson-buckets.js';
import {
  LESSON_BOOK_ID,
  LESSON_PROMPT_TEMPLATE,
  LESSONS_SCHEMA_VERSION,
  MAX_CLAIM_CHARS,
} from './lesson-recipe.js';
import {
  LESSON_PIN,
  LESSONS_MAX_TOKENS,
  type LoggedCall,
  ReplayLog,
  ReplayTransport,
} from './signal/index.js';

// G11 ruling 2 (#1717): the first run at 25 closed debate trades, then every further 25
const LESSON_CADENCE_TRADES = 25;
const LLM_CALL_TIMEOUT_MS = 60_000;
const LLM_RETRY = { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 2_000 } as const;

export interface Lesson {
  readonly as_of: string;
  readonly book_id: string;
  readonly bucket: string;
  readonly claim: string;
  readonly model: string;
  readonly prompt_hash: string;
  readonly inputs_hash: string;
  readonly trace_id: string;
  readonly schema_version: number;
}

export interface LessonDistil {
  readonly lessons: readonly Lesson[];
  readonly written: number;
  readonly source: 'none' | 'not_due' | 'model' | 'replay';
}

export interface LessonDistilDeps {
  readonly db: StoreHandle;
  readonly spendCap: SpendCap;
  readonly live: () => LlmClient;
}

interface DraftLesson {
  readonly bucket: string;
  readonly claim: string;
}

const COLUMNS = [
  'as_of',
  'book_id',
  'bucket',
  'claim',
  'model',
  'prompt_hash',
  'inputs_hash',
  'trace_id',
  'schema_version',
] as const;

export function lessonClient(
  transport: AnthropicMessagesClient,
  spendSink?: LlmSpendSink,
): LlmClient {
  return new AnthropicLlmClient(
    transport,
    {
      model: LESSON_PIN.wire,
      pricedModel: LESSON_PIN.priced,
      max_tokens: LESSONS_MAX_TOKENS,
      timeoutMs: LLM_CALL_TIMEOUT_MS,
      retry: LLM_RETRY,
    },
    spendSink,
  );
}

export function lessonTraceId(asOf: string, bookId: string): string {
  return `v2-lessons-${asOf}-${bookId}`;
}

function promptOf(buckets: readonly LessonBucket[]): string {
  const summary = buckets.map((bucket) => ({
    bucket: bucket.bucket,
    n: bucket.n,
    mean_excess: bucket.mean_excess,
    ci: [bucket.ci_low, bucket.ci_high],
    hit_rate: bucket.hit_rate,
    arm2_n: bucket.baseline_n,
    arm2_mean_excess: bucket.baseline_mean_excess,
  }));
  return `${LESSON_PROMPT_TEMPLATE}${JSON.stringify(summary, null, 2)}`;
}

function jsonObjectIn(raw: string): unknown {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  return start < 0 || end < start ? undefined : JSON.parse(raw.slice(start, end + 1));
}

function draftProblem(entry: unknown, known: ReadonlySet<string>): string | undefined {
  const { bucket, claim } = (entry ?? {}) as { bucket?: unknown; claim?: unknown };
  if (typeof bucket !== 'string' || !known.has(bucket)) return `unknown bucket ${String(bucket)}`;
  if (typeof claim !== 'string' || claim.trim() === '') return `no claim for ${bucket}`;
  return claim.trim().length > MAX_CLAIM_CHARS ? `claim for ${bucket} is too long` : undefined;
}

export function parseLessons(
  raw: string,
  buckets: readonly LessonBucket[],
): { valid: true; data: DraftLesson[] } | { valid: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = jsonObjectIn(raw);
  } catch {
    return { valid: false, reason: 'answer is not JSON' };
  }
  const lessons = (parsed as { lessons?: unknown } | undefined)?.lessons;
  if (!Array.isArray(lessons)) return { valid: false, reason: 'no lessons array' };
  const known = new Set(buckets.map((bucket) => bucket.bucket));
  const problem = lessons.map((entry) => draftProblem(entry, known)).find(Boolean);
  if (problem !== undefined) return { valid: false, reason: problem };
  const drafts = lessons as DraftLesson[];
  if (new Set(drafts.map((draft) => draft.bucket)).size !== drafts.length) {
    return { valid: false, reason: 'a bucket has two lessons' };
  }
  return { valid: true, data: drafts };
}

async function draftLessons(
  client: LlmClient,
  buckets: readonly LessonBucket[],
  traceId: string,
): Promise<DraftLesson[]> {
  const response = await client.complete({
    prompt: promptOf(buckets),
    context: {
      analyst_views: [],
      attribution: {
        trace_id: traceId,
        stage: 'lessons',
        prompt_template_hash: hashPromptTemplate(LESSON_PROMPT_TEMPLATE),
      },
    },
    parseResponse: (raw) => parseLessons(raw, buckets),
  });
  return response.data;
}

function rowsOf(
  drafts: readonly DraftLesson[],
  buckets: readonly LessonBucket[],
  traceId: string,
): Lesson[] {
  const [first] = buckets;
  return [...drafts]
    .sort((a, b) => (a.bucket < b.bucket ? -1 : 1))
    .map((draft) => ({
      as_of: first?.as_of ?? '',
      book_id: first?.book_id ?? '',
      bucket: draft.bucket,
      claim: draft.claim.trim(),
      model: LESSON_PIN.wire,
      prompt_hash: hashPromptTemplate(LESSON_PROMPT_TEMPLATE),
      inputs_hash: first?.inputs_hash ?? '',
      trace_id: traceId,
      schema_version: LESSONS_SCHEMA_VERSION,
    }));
}

function storedLessons(db: StoreHandle, asOf: string, bookId: string): Lesson[] {
  return db
    .prepare(
      `SELECT ${COLUMNS.join(', ')} FROM v2_lessons WHERE as_of = ? AND book_id = ? ORDER BY bucket`,
    )
    .all(asOf, bookId) as Lesson[];
}

// The client journals a call before parsing its answer, so a malformed, refused or truncated answer
// is logged as a success; only an answer that parses settles a run, and a run without one calls
// again
function settledCall(
  db: StoreHandle,
  traceId: string,
  buckets: readonly LessonBucket[],
): LoggedCall | undefined {
  const calls = db
    .prepare(
      `SELECT id, trace_id AS traceId, model, prompt, response, stop_reason AS stopReason,
          error_class AS errorClass, error_message AS errorMessage
        FROM llm_call_log
        WHERE trace_id = ? AND prompt IS NOT NULL AND response IS NOT NULL
          AND error_class IS NULL
        ORDER BY id`,
    )
    .all(traceId) as LoggedCall[];
  return calls.find(
    (call) => call.stopReason !== 'refusal' && parseLessons(call.response ?? '', buckets).valid,
  );
}

function bandOf(buckets: readonly LessonBucket[]): number {
  const all = buckets.find((bucket) => bucket.bucket === 'all');
  return Math.floor((all?.n ?? 0) / LESSON_CADENCE_TRADES);
}

// Compared against every settled as_of, earlier or later, so running an older as_of after a newer
// one cannot pay twice for the same band
function due(db: StoreHandle, asOf: string, bookId: string, band: number): boolean {
  const others = db
    .prepare(
      `SELECT DISTINCT as_of FROM v2_lesson_buckets WHERE book_id = ? AND as_of <> ? ORDER BY as_of`,
    )
    .all(bookId, asOf) as { as_of: string }[];
  return others.every(({ as_of }) => {
    const buckets = storedLessonBuckets(db, as_of, bookId);
    return settledCall(db, lessonTraceId(as_of, bookId), buckets) === undefined
      ? true
      : bandOf(buckets) < band;
  });
}

function record(db: StoreHandle, lessons: readonly Lesson[]): void {
  const insert = db.prepare(
    `INSERT INTO v2_lessons (${COLUMNS.join(', ')})
      VALUES (${COLUMNS.map((column) => `@${column}`).join(', ')})`,
  );
  db.transaction(() => {
    for (const lesson of lessons) insert.run(lesson);
  })();
}

function settleAgainstStored(
  db: StoreHandle,
  lessons: readonly Lesson[],
  stored: readonly Lesson[],
): number {
  if (stored.length === 0) {
    record(db, lessons);
    return lessons.length;
  }
  if (JSON.stringify(stored) !== JSON.stringify(lessons)) {
    throw new Error('lessons replayed from llm_call_log differ from the stored lessons');
  }
  return 0;
}

// A run whose call is already logged replays it instead of calling again, so a rerun at the same
// as_of spends nothing and must reproduce the stored lessons
export async function distilLessons(
  deps: LessonDistilDeps,
  asOf: string,
  bookId = LESSON_BOOK_ID,
): Promise<LessonDistil> {
  const buckets = storedLessonBuckets(deps.db, asOf, bookId);
  if (buckets.length === 0) return { lessons: [], written: 0, source: 'none' };
  const traceId = lessonTraceId(asOf, bookId);
  const settled = settledCall(deps.db, traceId, buckets);
  const stored = storedLessons(deps.db, asOf, bookId);
  if (settled !== undefined) {
    const replay = lessonClient(new ReplayTransport(LESSON_PIN, new ReplayLog([settled])));
    const lessons = rowsOf(await draftLessons(replay, buckets, traceId), buckets, traceId);
    return { lessons, written: settleAgainstStored(deps.db, lessons, stored), source: 'replay' };
  }
  const band = bandOf(buckets);
  if (band === 0 || !due(deps.db, asOf, bookId, band))
    return { lessons: [], written: 0, source: 'not_due' };
  const cap = deps.spendCap.check();
  if (!cap.admitted)
    throw new Error(`LLM spend cap reached: ${cap.spent_usd} of ${cap.budget_usd} USD`);
  const lessons = rowsOf(await draftLessons(deps.live(), buckets, traceId), buckets, traceId);
  record(deps.db, lessons);
  return { lessons, written: lessons.length, source: 'model' };
}

export function formatLessonDistil(distil: LessonDistil): string {
  return [
    `lessons: ${distil.lessons.length} (${distil.source}), ${distil.written} written`,
    ...distil.lessons.map((lesson) => `  ${lesson.bucket}: ${lesson.claim}`),
  ].join('\n');
}
