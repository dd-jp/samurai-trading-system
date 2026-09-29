import { randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_BAR_STORE_ROOT } from '../../../providers/bar-store/index.js';
import {
  type Clock,
  describeThrownSafely,
  type Logger,
  SystemClock,
  sanitizeLogText,
} from '../../../shared/index.js';
import { guardedStore, openMigratedStore, type StoreHandle } from '../../../shared/store/index.js';
import { BarsMarketData, ParquetMarkSource } from '../data/index.js';
import { FX_PATH, V2_DRY_RUN_STORE_PATH, V2_STORE_PATH } from '../index.js';
import { ControlStore } from '../risk/index.js';
import { CommandLog } from './command-log.js';
import { ControlWriter } from './control-writer.js';
import { readFxOrNone } from './main.js';
import { OverviewReader } from './overview.js';
import { PositionsPanel } from './positions.js';
import { type BotFetch, TelegramBot } from './telegram-bot.js';
import { CommandHandler } from './telegram-commands.js';
import { runPoller } from './telegram-poller.js';

export const COMMANDS_SCHEMA_VERSION = 74;
const CONFIRMATION_CODE_DIGITS = 4;

export interface TelegramArgs {
  readonly dryRun: boolean;
  readonly storePath: string;
  readonly barStoreRoot: string;
  readonly fxPath: string;
}

export function parseTelegramArgs(argv: readonly string[]): TelegramArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      'dry-run': { type: 'boolean', default: false },
      store: { type: 'string' },
      bars: { type: 'string', default: DEFAULT_BAR_STORE_ROOT },
      fx: { type: 'string', default: FX_PATH },
    },
    strict: true,
  });
  const dryRun = values['dry-run'];
  if (dryRun && values.store !== undefined) {
    throw new Error('--store and --dry-run are exclusive: --dry-run always uses the dry-run store');
  }
  return {
    dryRun,
    storePath: values.store ?? (dryRun ? V2_DRY_RUN_STORE_PATH : V2_STORE_PATH),
    barStoreRoot: values.bars,
    fxPath: values.fx,
  };
}

export function ownerChatIdFrom(env: NodeJS.ProcessEnv): number {
  const raw = env.TELEGRAM_CHAT_ID?.trim() ?? '';
  if (!/^[1-9]\d{0,15}$/.test(raw)) {
    throw new Error(
      'TELEGRAM_CHAT_ID must be the positive id of a private chat with the bot: a group or channel id would let its members command the system',
    );
  }
  return Number(raw);
}

export function botTokenFrom(env: NodeJS.ProcessEnv): string {
  const token = env.TELEGRAM_BOT_TOKEN?.trim() ?? '';
  if (token === '') throw new Error('TELEGRAM_BOT_TOKEN is not set');
  return token;
}

function confirmationCode(): string {
  return String(randomInt(10 ** (CONFIRMATION_CODE_DIGITS - 1), 10 ** CONFIRMATION_CODE_DIGITS));
}

export interface ComposedTelegram {
  readonly db: StoreHandle;
  run(shutdown: AbortSignal): Promise<void>;
}

export function composeTelegram(
  args: TelegramArgs,
  env: NodeJS.ProcessEnv,
  clock: Clock,
  fetchImpl: BotFetch,
  logger: Logger,
): ComposedTelegram {
  const ownerChatId = ownerChatIdFrom(env);
  const bot = new TelegramBot(botTokenFrom(env), fetchImpl);
  const db = openMigratedStore(args.storePath, COMMANDS_SCHEMA_VERSION);
  try {
    const store = guardedStore(db, 'dashboard', { enabled: true });
    const log = new CommandLog(guardedStore(db, 'telegram', { enabled: true }), clock);
    const positions = new PositionsPanel(
      new ParquetMarkSource(args.barStoreRoot),
      new BarsMarketData({ load: () => undefined }, readFxOrNone(args.fxPath)),
    );
    const overview = new OverviewReader(store, clock, args.dryRun ? 'dry-run' : 'paper', positions);
    const handler = new CommandHandler({
      ownerChatId,
      clock,
      controls: new ControlWriter(store, clock),
      current: () => new ControlStore(store).current(),
      overview: () => overview.read(),
      log,
      newCode: confirmationCode,
    });
    const replyPrefix = args.dryRun ? '[dry-run] ' : '';
    return {
      db,
      run: async (shutdown) => {
        await bot
          .sendMessage(
            ownerChatId,
            `${replyPrefix}Samurai v2 Telegram commands online. Send status, halt, resume or flatten.`,
          )
          .catch((error: unknown) => {
            logger.log({
              trace_id: 'v2-telegram',
              stage: 'v2',
              level: 'warn',
              event: 'v2_telegram_start_notice_failed',
              message: sanitizeLogText(describeThrownSafely(error)),
            });
          });
        await runPoller(
          {
            bot,
            handler,
            ownerChatId,
            logger,
            replyPrefix,
            sleep: (ms, signal) => delay(ms, undefined, { signal }).catch(() => undefined),
          },
          shutdown,
        );
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

const STDERR_LOGGER: Logger = {
  log: (entry) => {
    process.stderr.write(`${JSON.stringify(entry)}\n`);
  },
};

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
  const { db, run } = composeTelegram(
    parseTelegramArgs(argv),
    env,
    new SystemClock(),
    fetch,
    STDERR_LOGGER,
  );
  const shutdown = new AbortController();
  process.once('SIGINT', () => shutdown.abort());
  process.once('SIGTERM', () => shutdown.abort());
  try {
    await run(shutdown.signal);
  } finally {
    db.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), process.env).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
