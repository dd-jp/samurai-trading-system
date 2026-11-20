import {
  AnthropicLlmClient,
  type AnthropicMessagesClient,
  type LlmClient,
  type LlmSpendSink,
  type SpendCap,
} from '../../shared/debate/index.js';
import { hashPromptTemplate } from '../../shared/llm/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { LESSON_BOOK_ID, type LessonBucket, storedLessonBuckets } from './lesson-buckets.js';
import {
  LESSON_PIN,
  LESSONS_MAX_TOKENS,
  type LoggedCall,
  ReplayLog,
  ReplayTransport,
} from './signal/index.js';

const LESSONS_SCHEMA_VERSION = 1;
const MAX_CLAIM_CHARS = 280;
// G11 ruling 2 (#1717): the first run at 25 closed debate trades, then every further 25
const LESSON_CADENCE_TRADES = 25;
const LLM_CALL_TIMEOUT_MS = 60_000;
const LLM_RETRY = { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 2_000 } as const;

export const LESSON_PROMPT_TEMPLATE = `You write short lessons for a daily swing-trading debate from statistics over its settled trades. Each bucket groups the trades that share one tag. mean_excess is the mean return against the venue's index, net of the trade's direction; ci is a bootstrap 95% interval on that mean; hit_rate is the share of trades that beat the index; arm2_mean_excess is the no-LLM control's mean on the same tag, or on all its trades for a tag it does not have.

Write at most one lesson per bucket, and only for a bucket whose interval excludes zero or whose mean differs clearly from arm 2's. Each claim is one plain sentence of at most ${MAX_CLAIM_CHARS} characters that states only what the numbers show and quotes no number that is not in its bucket. Answer with JSON only, in the form {"lessons":[{"bucket":"<the bucket exactly as given>","claim":"<sentence>"}]}. An empty list is a valid answer.

Buckets:
`;

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
  return claim.length > MAX_CLAIM_CHARS ? `claim for ${bucket} is too long` : undefined;
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

// Only an answered call settles a run: a logged failure leaves the next run free to call again
function answeredCalls(db: StoreHandle, traceId: string): LoggedCall[] {
  return db
    .prepare(
      `SELECT id, trace_id AS traceId, model, prompt, response, stop_reason AS stopReason,
          error_class AS errorClass, error_message AS errorMessage
        FROM llm_call_log
        WHERE trace_id = ? AND prompt IS NOT NULL AND response IS NOT NULL
          AND error_class IS NULL
        ORDER BY id`,
    )
    .all(traceId) as LoggedCall[];
}

function closedTradesAt(db: StoreHandle, asOf: string, bookId: string): number {
  const row = db
    .prepare(`SELECT n FROM v2_lesson_buckets WHERE as_of = ? AND book_id = ? AND bucket = 'all'`)
    .get(asOf, bookId) as { n: number } | undefined;
  return row?.n ?? 0;
}

function lastDistilledAsOf(db: StoreHandle, asOf: string, bookId: string): string | undefined {
  const row = db
    .prepare(
      `SELECT MAX(l.as_of) AS as_of FROM llm_call_log c
        JOIN v2_lesson_buckets l ON c.trace_id = 'v2-lessons-' || l.as_of || '-' || l.book_id
        WHERE l.book_id = ? AND l.as_of < ? AND c.response IS NOT NULL AND c.error_class IS NULL`,
    )
    .get(bookId, asOf) as { as_of: string | null };
  return row.as_of ?? undefined;
}

function due(db: StoreHandle, asOf: string, bookId: string): boolean {
  const cadence = (asOfDate: string | undefined) =>
    asOfDate === undefined
      ? 0
      : Math.floor(closedTradesAt(db, asOfDate, bookId) / LESSON_CADENCE_TRADES);
  return cadence(asOf) > cadence(lastDistilledAsOf(db, asOf, bookId));
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
  const logged = answeredCalls(deps.db, traceId);
  const stored = storedLessons(deps.db, asOf, bookId);
  if (logged.length > 0) {
    const replay = lessonClient(new ReplayTransport(LESSON_PIN, new ReplayLog(logged)));
    const lessons = rowsOf(await draftLessons(replay, buckets, traceId), buckets, traceId);
    return { lessons, written: settleAgainstStored(deps.db, lessons, stored), source: 'replay' };
  }
  if (!due(deps.db, asOf, bookId)) return { lessons: [], written: 0, source: 'not_due' };
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
