import { guardedStore, openSharedStore } from '../../shared/store/index.js';
import { setExitCodeWhenInvoked, writeOrFail } from '../../tools/cli-entrypoint.js';
import { V2_STORE_PATH } from './index.js';
import { formatLessonRun, writeLessonBuckets } from './lesson-buckets.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function main(
  argv: readonly string[],
  write: (line: string) => void,
  now: () => Date = () => new Date(),
): Promise<number> {
  const [asOf, storePath = V2_STORE_PATH] = argv;
  return writeOrFail(write, async () => {
    if (asOf === undefined || !ISO_DATE.test(asOf)) {
      throw new Error('usage: npm run v2:lessons -- <as_of YYYY-MM-DD> [store path]');
    }
    const db = openSharedStore(storePath);
    try {
      const today = now().toISOString().slice(0, 10);
      return formatLessonRun(writeLessonBuckets(guardedStore(db, 'v2'), asOf, today));
    } finally {
      db.close();
    }
  });
}

await setExitCodeWhenInvoked(import.meta.url, () => main(process.argv.slice(2), console.log));
