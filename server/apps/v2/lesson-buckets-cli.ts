import type { LlmClient } from '../../shared/debate/index.js';
import { SystemClock } from '../../shared/index.js';
import { guardedStore, openSharedStore, type StoreHandle } from '../../shared/store/index.js';
import { setExitCodeWhenInvoked, writeOrFail } from '../../tools/cli-entrypoint.js';
import {
  guardedSpendSink,
  knownSecretsFrom,
  nousOptionsFrom,
  nousTransportFactory,
  STDERR_LOGGER,
  V2_STORE_PATH,
} from './index.js';
import { formatLessonRun, writeLessonBuckets } from './lesson-buckets.js';
import { distilLessons, formatLessonDistil, lessonClient } from './lesson-distil.js';
import { LESSON_PIN, SqliteMonthlySpendCap } from './signal/index.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const USAGE = 'usage: npm run v2:lessons -- <as_of YYYY-MM-DD> [store path] [--distil]';

export type LiveLessonClient = (db: StoreHandle) => LlmClient;

export function nousLessonClient(env: NodeJS.ProcessEnv): LiveLessonClient {
  return (db) => {
    const nous = { ...nousOptionsFrom(env), knownSecrets: knownSecretsFrom(env) };
    if (nous.nousApiKey === undefined || nous.nousBaseUrl === undefined) {
      throw new Error('--distil needs NOUS_BASE_URL and a Nous key in the environment');
    }
    const transport = nousTransportFactory(nous, STDERR_LOGGER)(LESSON_PIN);
    return lessonClient(transport, guardedSpendSink(db, nous, STDERR_LOGGER));
  };
}

function parseArgs(args: readonly string[]): { asOf: string; storePath: string; distil: boolean } {
  const positional = args.filter((arg) => arg !== '--distil');
  const [asOf = '', storePath = V2_STORE_PATH] = positional;
  const wellFormed =
    ISO_DATE.test(asOf) &&
    positional.length <= 2 &&
    positional.every((arg) => !arg.startsWith('--'));
  if (!wellFormed) throw new Error(USAGE);
  return { asOf, storePath, distil: positional.length < args.length };
}

async function run(
  args: readonly string[],
  today: string,
  live: LiveLessonClient,
): Promise<string> {
  const { asOf, storePath, distil } = parseArgs(args);
  const db = openSharedStore(storePath);
  try {
    const guarded = guardedStore(db, 'v2');
    const report = formatLessonRun(writeLessonBuckets(guarded, asOf, today));
    if (!distil) return report;
    const spendCap = new SqliteMonthlySpendCap(db, new SystemClock(), undefined, STDERR_LOGGER);
    const lessons = await distilLessons({ db: guarded, spendCap, live: () => live(db) }, asOf);
    return `${report}\n${formatLessonDistil(lessons)}`;
  } finally {
    db.close();
  }
}

export async function main(
  argv: readonly string[],
  write: (line: string) => void,
  now: () => Date = () => new Date(),
  live: LiveLessonClient = nousLessonClient(process.env),
): Promise<number> {
  return writeOrFail(write, () => run(argv, now().toISOString().slice(0, 10), live));
}

await setExitCodeWhenInvoked(import.meta.url, () => main(process.argv.slice(2), console.log));
