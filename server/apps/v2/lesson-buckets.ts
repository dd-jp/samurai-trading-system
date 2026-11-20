import { digest } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { CLOSE_LEGS_SQL } from './entry-offset.js';
import { seededRandom } from './random-canary.js';

const LESSON_BUCKETS_SCHEMA_VERSION = 1;
// #2147: a bucket smaller than this is a handful of trades, the n = 1 noise the ticket rules out
export const LESSON_MIN_BUCKET_N = 10;
const LESSON_BOOTSTRAP_RESAMPLES = 2_000;
const LESSON_KILL_LINE_TRADES = 100;
export const LESSON_BOOK_ID = 'debate/primary';
export const LESSON_BASELINE_BOOK_ID = 'arm2/technical-only';

export interface LessonBucket {
  readonly as_of: string;
  readonly bucket: string;
  readonly book_id: string;
  readonly n: number;
  readonly mean_excess: number;
  readonly hit_rate: number;
  readonly ci_low: number;
  readonly ci_high: number;
  readonly baseline_book_id: string;
  readonly baseline_n: number;
  readonly baseline_mean_excess: number | null;
  readonly evidence: string;
  readonly inputs_hash: string;
  readonly schema_version: number;
}

export interface LessonRun {
  readonly asOf: string;
  readonly bookId: string;
  readonly closedTrades: number;
  readonly buckets: readonly LessonBucket[];
  readonly written: number;
  readonly killLine: boolean;
}

interface SettledOutcome {
  readonly decision_id: string;
  readonly book_id: string;
  readonly venue: string;
  readonly direction: string;
  readonly excess_return: number;
  readonly confidence: number;
  readonly payload: string;
}

const COLUMNS = [
  'as_of',
  'bucket',
  'book_id',
  'n',
  'mean_excess',
  'hit_rate',
  'ci_low',
  'ci_high',
  'baseline_book_id',
  'baseline_n',
  'baseline_mean_excess',
  'evidence',
  'inputs_hash',
  'schema_version',
] as const;

const SHARED_TAG_PREFIXES = ['all', 'venue=', 'direction='];

function newsBand(headlines: unknown): string {
  if (typeof headlines !== 'number' || headlines === 0) return '0';
  return headlines < 5 ? '1-4' : '5+';
}

function debateTags(payload: Record<string, unknown>, confidence: number): string[] {
  const disagreement =
    typeof payload.disagreement === 'string' ? payload.disagreement : 'unrecorded';
  return [
    `confidence=${(Math.floor(confidence * 10) / 10).toFixed(1)}`,
    `disagreement=${disagreement}`,
    `news=${newsBand(payload.headlines)}`,
  ];
}

function outcomeTags(outcome: SettledOutcome): string[] {
  const payload = JSON.parse(outcome.payload) as Record<string, unknown>;
  return [
    'all',
    `venue=${outcome.venue}`,
    `direction=${outcome.direction}`,
    ...debateTags(payload, outcome.confidence),
  ];
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function quantile(sorted: readonly number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number;
}

export function bootstrapMeanCi(values: readonly number[], seed: number): [number, number] {
  const random = seededRandom(seed);
  const means: number[] = [];
  for (let draw = 0; draw < LESSON_BOOTSTRAP_RESAMPLES; draw++) {
    let sum = 0;
    for (let pick = 0; pick < values.length; pick++) {
      sum += values[Math.floor(random() * values.length)] as number;
    }
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);
  return [quantile(means, 0.025), quantile(means, 0.975)];
}

// One trade per decision: a decision closed by several exit orders settles as one row per exit,
// which would count its parts as separate trades and narrow the interval
function readSettled(
  db: StoreHandle,
  asOf: string,
  bookId: string,
  baselineBookId: string,
): SettledOutcome[] {
  return db
    .prepare(
      `SELECT o.decision_id, o.book_id, o.venue, o.direction,
          SUM(o.excess_return * o.exit_qty) / SUM(o.exit_qty) AS excess_return, d.confidence,
          d.payload
        FROM v2_decision_outcomes o JOIN v2_decisions d ON d.decision_id = o.decision_id
        WHERE o.book_id IN (?, ?)
        GROUP BY o.decision_id
        HAVING MAX(o.settled_at) < ?
        ORDER BY MIN(o.outcome_id)`,
    )
    .all(bookId, baselineBookId, asOf) as SettledOutcome[];
}

function unsettledClosesBefore(
  db: StoreHandle,
  asOf: string,
  bookId: string,
  baselineBookId: string,
): number {
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT f.client_order_id) AS closes
        FROM v2_fills f
        WHERE f.${CLOSE_LEGS_SQL} AND f.book_id IN (?, ?) AND f.trading_date < ?
          AND NOT EXISTS (
            SELECT 1 FROM v2_decision_outcomes o
            WHERE o.book_id = f.book_id AND o.exit_client_order_id = f.client_order_id
          )`,
    )
    .get(bookId, baselineBookId, asOf) as { closes: number };
  return row.closes;
}

function groupByTag(outcomes: readonly SettledOutcome[]): Map<string, SettledOutcome[]> {
  const groups = new Map<string, SettledOutcome[]>();
  for (const outcome of outcomes) {
    for (const tag of outcomeTags(outcome)) {
      const members = groups.get(tag) ?? [];
      members.push(outcome);
      groups.set(tag, members);
    }
  }
  return groups;
}

function baselineFor(tag: string, baseline: Map<string, SettledOutcome[]>): SettledOutcome[] {
  const shared = SHARED_TAG_PREFIXES.some((prefix) => tag.startsWith(prefix));
  return baseline.get(shared ? tag : 'all') ?? [];
}

function bucketRow(
  run: { asOf: string; bookId: string; baselineBookId: string; inputsHash: string },
  tag: string,
  members: readonly SettledOutcome[],
  baseline: readonly SettledOutcome[],
): LessonBucket {
  const excess = members.map((member) => member.excess_return);
  // Seeded by the members, not the tag, so two tags holding the same trades get the same interval
  const evidence = [...new Set(members.map((member) => member.decision_id))].sort();
  const seed = Number.parseInt(digest({ inputs: run.inputsHash, evidence }).slice(0, 8), 16);
  const [ciLow, ciHigh] = bootstrapMeanCi(excess, seed);
  return {
    as_of: run.asOf,
    bucket: tag,
    book_id: run.bookId,
    n: members.length,
    mean_excess: mean(excess),
    hit_rate: excess.filter((value) => value > 0).length / excess.length,
    ci_low: ciLow,
    ci_high: ciHigh,
    baseline_book_id: run.baselineBookId,
    baseline_n: baseline.length,
    baseline_mean_excess:
      baseline.length > 0 ? mean(baseline.map((outcome) => outcome.excess_return)) : null,
    evidence: JSON.stringify(evidence),
    inputs_hash: run.inputsHash,
    schema_version: LESSON_BUCKETS_SCHEMA_VERSION,
  };
}

export function computeLessonBuckets(
  db: StoreHandle,
  asOf: string,
  bookId = LESSON_BOOK_ID,
  baselineBookId = LESSON_BASELINE_BOOK_ID,
): { closedTrades: number; buckets: LessonBucket[] } {
  const settled = readSettled(db, asOf, bookId, baselineBookId);
  const run = { asOf, bookId, baselineBookId, inputsHash: digest({ asOf, settled }) };
  const own = groupByTag(settled.filter((outcome) => outcome.book_id === bookId));
  const baseline = groupByTag(settled.filter((outcome) => outcome.book_id === baselineBookId));
  const buckets = [...own]
    .filter(([, members]) => members.length >= LESSON_MIN_BUCKET_N)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([tag, members]) => bucketRow(run, tag, members, baselineFor(tag, baseline)));
  return { closedTrades: own.get('all')?.length ?? 0, buckets };
}

function storedBuckets(db: StoreHandle, asOf: string, bookId: string): LessonBucket[] {
  return db
    .prepare(
      `SELECT ${COLUMNS.join(', ')} FROM v2_lesson_buckets WHERE as_of = ? AND book_id = ?
        ORDER BY bucket`,
    )
    .all(asOf, bookId) as LessonBucket[];
}

function excludesZero(bucket: LessonBucket): boolean {
  return bucket.ci_low > 0 || bucket.ci_high < 0;
}

export function writeLessonBuckets(
  db: StoreHandle,
  asOf: string,
  today: string,
  bookId = LESSON_BOOK_ID,
): LessonRun {
  if (asOf > today) throw new Error(`as_of ${asOf} is after today ${today}`);
  // An outcome row is dated by its close, not by when the ledger wrote it, so a close still waiting
  // on bars would land before this as_of later and the stored run could never be reproduced
  const unsettled = unsettledClosesBefore(db, asOf, bookId, LESSON_BASELINE_BOOK_ID);
  if (unsettled > 0) {
    throw new Error(
      `${unsettled} close(s) before as_of ${asOf} have no settled outcome yet; ` +
        'rerun after the outcome ledger settles them',
    );
  }
  const { closedTrades, buckets } = computeLessonBuckets(db, asOf, bookId);
  const stored = storedBuckets(db, asOf, bookId);
  let written = 0;
  if (stored.length === 0) {
    const insert = db.prepare(
      `INSERT INTO v2_lesson_buckets (${COLUMNS.join(', ')})
        VALUES (${COLUMNS.map((column) => `@${column}`).join(', ')})`,
    );
    db.transaction(() => {
      for (const bucket of buckets) insert.run(bucket);
    })();
    written = buckets.length;
  } else if (JSON.stringify(stored) !== JSON.stringify(buckets)) {
    throw new Error(`lesson buckets for ${bookId} at as_of ${asOf} differ from the stored run`);
  }
  return {
    asOf,
    bookId,
    closedTrades,
    buckets,
    written,
    killLine: closedTrades >= LESSON_KILL_LINE_TRADES && !buckets.some(excludesZero),
  };
}

function percent(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(2)}%`;
}

export function formatLessonRun(run: LessonRun): string {
  const lines = [
    `lesson buckets for ${run.bookId} at as_of ${run.asOf}: ${run.closedTrades} closed trades, ` +
      `${run.buckets.length} bucket(s) with n >= ${LESSON_MIN_BUCKET_N}, ${run.written} written`,
    ...run.buckets.map(
      (bucket) =>
        `  ${bucket.bucket}: n ${bucket.n}, mean excess ${percent(bucket.mean_excess)} ` +
        `[${percent(bucket.ci_low)}, ${percent(bucket.ci_high)}], hit ${percent(bucket.hit_rate)}, ` +
        `arm 2 ${percent(bucket.baseline_mean_excess)} (n ${bucket.baseline_n})` +
        (excludesZero(bucket) ? ' *' : ''),
    ),
  ];
  if (run.killLine) {
    lines.push(
      `kill line: ${run.closedTrades} closed trades and no bucket's interval excludes zero`,
    );
  }
  return lines.join('\n');
}
