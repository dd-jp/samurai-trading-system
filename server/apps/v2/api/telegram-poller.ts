import { type Logger, sanitizeLogText } from '../../../shared/index.js';
import type { TelegramBot } from './telegram-bot.js';
import type { CommandHandler, TelegramUpdate } from './telegram-commands.js';

export const RETRY_AFTER_FAILURE_MS = 5_000;

export interface PollerDeps {
  readonly bot: Pick<TelegramBot, 'getUpdates' | 'sendMessage'>;
  readonly handler: Pick<CommandHandler, 'handle'>;
  readonly ownerChatId: number;
  readonly logger: Logger;
  readonly replyPrefix: string;
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

function warn(logger: Logger, event: string, error: unknown): void {
  const cause = error instanceof Error ? error.message : String(error);
  logger.log({
    trace_id: 'v2-telegram',
    stage: 'v2',
    level: 'warn',
    event,
    message: sanitizeLogText(cause),
  });
}

async function handleOne(deps: PollerDeps, update: TelegramUpdate): Promise<void> {
  try {
    const reply = await deps.handler.handle(update);
    if (reply !== undefined) await deps.bot.sendMessage(deps.ownerChatId, deps.replyPrefix + reply);
  } catch (error) {
    warn(deps.logger, 'v2_telegram_command_failed', error);
  }
}

async function fetchUpdates(
  deps: PollerDeps,
  offset: number | undefined,
  shutdown: AbortSignal,
): Promise<TelegramUpdate[]> {
  try {
    return await deps.bot.getUpdates(offset, shutdown);
  } catch (error) {
    if (shutdown.aborted) return [];
    warn(deps.logger, 'v2_telegram_poll_failed', error);
    await deps.sleep(RETRY_AFTER_FAILURE_MS, shutdown);
    return [];
  }
}

export async function runPoller(deps: PollerDeps, shutdown: AbortSignal): Promise<void> {
  let offset: number | undefined;
  while (!shutdown.aborted) {
    const updates = await fetchUpdates(deps, offset, shutdown);
    // Telegram picks a random next update_id after a week of silence; a stale offset above it would silently drop halt/flatten
    offset = undefined;
    for (const update of updates) {
      offset = update.update_id + 1;
      await handleOne(deps, update);
    }
  }
}
