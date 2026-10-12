import { parseArgs } from 'node:util';
import type { Clock } from '../../shared/index.js';
import { SystemClock } from '../../shared/index.js';
import { guardedStore, openSharedStore } from '../../shared/store/index.js';
import { runWhenInvoked } from '../../tools/cli-entrypoint.js';
import type { EodhdExchange } from './data/index.js';
import { V2_STORE_PATH } from './index.js';
import { SqliteSplitChecks } from './split-checks.js';

export const SPLIT_CLEAR_USAGE =
  'usage: split-clear --instrument SYMBOL --exchange US|LSE --reason TEXT [--store PATH]';

const EXCHANGES: ReadonlySet<string> = new Set<EodhdExchange>(['US', 'LSE']);

export interface SplitClear {
  readonly instrument: string;
  readonly exchange: EodhdExchange;
  readonly reason: string;
  readonly storePath: string;
}

function present(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === '') {
    throw new Error(`--${name} is required\n${SPLIT_CLEAR_USAGE}`);
  }
  return value.trim();
}

export function parseSplitClearArgs(argv: readonly string[]): SplitClear {
  let values: Record<string, string | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        instrument: { type: 'string' },
        exchange: { type: 'string' },
        reason: { type: 'string' },
        store: { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    throw new Error(SPLIT_CLEAR_USAGE);
  }
  const exchange = present(values.exchange, 'exchange');
  if (!EXCHANGES.has(exchange))
    throw new Error(`unknown exchange ${exchange}\n${SPLIT_CLEAR_USAGE}`);
  return {
    instrument: present(values.instrument, 'instrument'),
    exchange: exchange as EodhdExchange,
    reason: present(values.reason, 'reason'),
    storePath: values.store ?? V2_STORE_PATH,
  };
}

export function main(
  argv: readonly string[],
  clock: Clock = new SystemClock(),
): Omit<SplitClear, 'storePath'> & { readonly clearedAt: string } {
  const { storePath, ...clear } = parseSplitClearArgs(argv);
  const db = openSharedStore(storePath);
  try {
    new SqliteSplitChecks(guardedStore(db, 'v2'), clock).clear(
      clear.instrument,
      clear.exchange,
      clear.reason,
    );
  } finally {
    db.close();
  }
  return { ...clear, clearedAt: clock.now().toISOString() };
}

void runWhenInvoked(import.meta.url, () =>
  Promise.resolve().then(() => {
    process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)))}\n`);
  }),
);
