import { pathToFileURL } from 'node:url';
import type { Venue } from '../../../contracts/index.js';
import type { Clock } from '../../shared/index.js';
import { SystemClock } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { guardedStore, openSharedStore } from '../../shared/store/index.js';
import { type CashAnchor, type CashMove, SqliteCashAnchors } from './cash-anchor.js';
import { V2_STORE_PATH } from './index.js';

export const CASH_MOVE_USAGE =
  'usage: cash-move deposit|withdrawal --venue VENUE --amount QUOTE --reference REF --date YYYY-MM-DD [--store PATH]';

const VENUES: ReadonlySet<string> = new Set<Venue>([
  'alpaca',
  'saxo',
  'saxo_cfd_gbp',
  'saxo_cfd_usd',
]);
const KINDS: ReadonlySet<string> = new Set<CashMove['kind']>(['deposit', 'withdrawal']);

function flags(argv: readonly string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index] as string;
    const value = argv[index + 1];
    if (!name.startsWith('--') || value === undefined) throw new Error(CASH_MOVE_USAGE);
    parsed.set(name.slice(2), value);
  }
  return parsed;
}

function required(parsed: ReadonlyMap<string, string>, name: string): string {
  const value = parsed.get(name);
  if (value === undefined) throw new Error(`--${name} is required\n${CASH_MOVE_USAGE}`);
  return value;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isoDate(value: string): string {
  if (!ISO_DATE.test(value))
    throw new Error(`--date ${value} is not YYYY-MM-DD\n${CASH_MOVE_USAGE}`);
  return value;
}

function oneOf(allowed: ReadonlySet<string>, value: string, what: string): string {
  if (!allowed.has(value)) throw new Error(`unknown ${what} ${value}\n${CASH_MOVE_USAGE}`);
  return value;
}

export function parseCashMoveArgs(argv: readonly string[]): {
  move: CashMove;
  storePath: string;
} {
  const [kind = '', ...rest] = argv;
  const parsed = flags(rest);
  return {
    move: {
      kind: oneOf(KINDS, kind, 'move') as CashMove['kind'],
      venue: oneOf(VENUES, required(parsed, 'venue'), 'venue') as Venue,
      amountQuote: Number(required(parsed, 'amount')),
      reference: required(parsed, 'reference'),
      tradingDate: isoDate(required(parsed, 'date')),
    },
    storePath: parsed.get('store') ?? V2_STORE_PATH,
  };
}

export function recordCashMove(move: CashMove, db: StoreHandle, clock: Clock): CashAnchor {
  return new SqliteCashAnchors(guardedStore(db, 'v2'), clock).recordMove(move);
}

export function main(argv: readonly string[], clock: Clock = new SystemClock()): CashAnchor {
  const { move, storePath } = parseCashMoveArgs(argv);
  const db = openSharedStore(storePath);
  try {
    return recordCashMove(move, db, clock);
  } finally {
    db.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
