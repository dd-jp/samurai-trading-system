import { digest } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { CLOSE_LEGS_SQL } from './entry-offset.js';
import { LESSON_BOOK_ID, newsBand } from './lesson-recipe.js';
import { seededRandom } from './random-canary.js';

const LESSON_BUCKETS_SCHEMA_VERSION = 1;
// #2147: a bucket smaller than this is a handful of trades, the n = 1 noise the ticket rules out
export const LESSON_MIN_BUCKET_N = 10;
const LESSON_BOOTSTRAP_RESAMPLES = 2_000;
const LESSON_KILL_LINE_TRADES = 100;

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
  readonly supported: readonly string[];
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

function bootstrapMeans(values: readonly number[], seed: number): number[] {
  const random = seededRandom(seed);
  const means: number[] = [];
  for (let draw = 0; draw < LESSON_BOOTSTRAP_RESAMPLES; draw++) {
    let sum = 0;
    for (let pick = 0; pick < values.length; pick++) {
      sum += values[Math.floor(random() * values.length)] as number;
    }
    means.push(sum / values.length);
  }
  return means.sort((a, b) => a - b);
}

export function bootstrapMeanCi(values: readonly number[], seed: number): [number, number] {
  const means = bootstrapMeans(values, seed);
  return [quantile(means, 0.025), quantile(means, 0.975)];
}

// #2147 kill-line ruling (David, 2026-11-24): the run tests every bucket at once, so each two-sided
// interval is widened to 95% family-wise over the buckets tested
export function bonferroniLow(sortedMeans: readonly number[], tested: number): number {
  return quantile(sortedMeans, 0.025 / tested);
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
): { bucket: LessonBucket; means: number[] } {
  const excess = members.map((member) => member.excess_return);
  // Seeded by the members, not the tag, so two tags holding the same trades get the same interval
  const evidence = [...new Set(members.map((member) => member.decision_id))].sort();
  const seed = Number.parseInt(digest({ inputs: run.inputsHash, evidence }).slice(0, 8), 16);
  const means = bootstrapMeans(excess, seed);
  const bucket = {
    as_of: run.asOf,
    bucket: tag,
    book_id: run.bookId,
    n: members.length,
    mean_excess: mean(excess),
    hit_rate: excess.filter((value) => value > 0).length / excess.length,
    ci_low: quantile(means, 0.025),
    ci_high: quantile(means, 0.975),
    baseline_book_id: run.baselineBookId,
    baseline_n: baseline.length,
    baseline_mean_excess:
      baseline.length > 0 ? mean(baseline.map((outcome) => outcome.excess_return)) : null,
    evidence: JSON.stringify(evidence),
    inputs_hash: run.inputsHash,
    schema_version: LESSON_BUCKETS_SCHEMA_VERSION,
  };
  return { bucket, means };
}

export function computeLessonBuckets(
  db: StoreHandle,
  asOf: string,
  bookId = LESSON_BOOK_ID,
  baselineBookId = LESSON_BASELINE_BOOK_ID,
): { closedTrades: number; buckets: LessonBucket[]; supported: string[] } {
  const settled = readSettled(db, asOf, bookId, baselineBookId);
  const run = { asOf, bookId, baselineBookId, inputsHash: digest({ asOf, settled }) };
  const own = groupByTag(settled.filter((outcome) => outcome.book_id === bookId));
  const baseline = groupByTag(settled.filter((outcome) => outcome.book_id === baselineBookId));
  const rows = [...own]
    .filter(([, members]) => members.length >= LESSON_MIN_BUCKET_N)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([tag, members]) => bucketRow(run, tag, members, baselineFor(tag, baseline)));
  return {
    closedTrades: own.get('all')?.length ?? 0,
    buckets: rows.map((row) => row.bucket),
    supported: rows
      .filter((row) => bonferroniLow(row.means, rows.length) > 0)
      .map((row) => row.bucket.bucket),
  };
}

export function storedLessonBuckets(db: StoreHandle, asOf: string, bookId: string): LessonBucket[] {
  return db
    .prepare(
      `SELECT ${COLUMNS.join(', ')} FROM v2_lesson_buckets WHERE as_of = ? AND book_id = ?
        ORDER BY bucket`,
    )
    .all(asOf, bookId) as LessonBucket[];
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
  const { closedTrades, buckets, supported } = computeLessonBuckets(db, asOf, bookId);
  const stored = storedLessonBuckets(db, asOf, bookId);
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
    supported,
    killLine: closedTrades >= LESSON_KILL_LINE_TRADES && supported.length === 0,
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
        (run.supported.includes(bucket.bucket) ? ' *' : ''),
    ),
  ];
  if (run.killLine) {
    lines.push(
      `kill line: ${run.closedTrades} closed trades and no bucket's Bonferroni interval sits above zero`,
    );
  }
  return lines.join('\n');
}
