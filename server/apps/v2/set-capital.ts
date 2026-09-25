import { pathToFileURL } from 'node:url';
import type { CapitalYear } from '../../../contracts/index.js';
import type { Clock } from '../../shared/index.js';
import { SystemClock } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { guardedStore, openSharedStore } from '../../shared/store/index.js';
import { V2_STORE_PATH } from './index.js';
import { Journal } from './journal/index.js';
import { CapitalConfigError, CapitalConfigStore } from './risk/index.js';

export type CapitalCommand =
  | {
      readonly kind: 'set';
      readonly year: number;
      readonly startGbp: number;
      readonly capGbp: number;
    }
  | { readonly kind: 'tighten'; readonly from: string; readonly capGbp: number }
  | { readonly kind: 'show'; readonly date: string };

export const CAPITAL_USAGE = [
  'usage: set-capital set --year YYYY --start GBP --cap GBP [--store PATH]',
  '       set-capital tighten --from YYYY-MM-DD --cap GBP [--store PATH]',
  '       set-capital show --date YYYY-MM-DD [--store PATH]',
].join('\n');

function flags(argv: readonly string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (name === undefined || !name.startsWith('--') || value === undefined) {
      throw new Error(CAPITAL_USAGE);
    }
    parsed.set(name.slice(2), value);
  }
  return parsed;
}

function required(parsed: Map<string, string>, name: string): string {
  const value = parsed.get(name);
  if (value === undefined) throw new Error(`--${name} is required\n${CAPITAL_USAGE}`);
  return value;
}

export function parseCapitalArgs(argv: readonly string[]): {
  command: CapitalCommand;
  storePath: string;
} {
  const [kind, ...rest] = argv;
  const parsed = flags(rest);
  const storePath = parsed.get('store') ?? V2_STORE_PATH;
  if (kind === 'set') {
    return {
      command: {
        kind,
        year: Number(required(parsed, 'year')),
        startGbp: Number(required(parsed, 'start')),
        capGbp: Number(required(parsed, 'cap')),
      },
      storePath,
    };
  }
  if (kind === 'tighten') {
    return {
      command: { kind, from: required(parsed, 'from'), capGbp: Number(required(parsed, 'cap')) },
      storePath,
    };
  }
  if (kind === 'show') return { command: { kind, date: required(parsed, 'date') }, storePath };
  throw new Error(CAPITAL_USAGE);
}

export function applyCapitalCommand(
  command: CapitalCommand,
  db: StoreHandle,
  clock: Clock,
): CapitalYear | undefined {
  const store = guardedStore(db, 'v2');
  try {
    return runCapitalCommand(command, new CapitalConfigStore(store, clock));
  } catch (error) {
    if (error instanceof CapitalConfigError) {
      new Journal(store, clock).recordRefusal({
        trading_date: clock.now().toISOString().slice(0, 10),
        scope: 'capital',
        parameter: `CAPITAL_CONFIG:${command.kind}`,
        ticket: 'docs/research/66-v2-grill-decisions.md D8',
        message: error.message,
      });
    }
    throw error;
  }
}

function runCapitalCommand(
  command: CapitalCommand,
  capital: CapitalConfigStore,
): CapitalYear | undefined {
  if (command.kind === 'set')
    return capital.setYear(command.year, command.startGbp, command.capGbp);
  if (command.kind === 'tighten') return capital.tighten(command.from, command.capGbp);
  return capital.inForce(command.date);
}

export function main(argv: readonly string[]): number {
  const { command, storePath } = parseCapitalArgs(argv);
  const db = openSharedStore(storePath);
  try {
    const result = applyCapitalCommand(command, db, new SystemClock());
    process.stdout.write(`${JSON.stringify(result ?? null)}\n`);
    return result === undefined ? 1 : 0;
  } finally {
    db.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
