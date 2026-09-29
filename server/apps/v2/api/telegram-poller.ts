import { type Logger, sanitizeLogText } from '../../../shared/index.js';
import type { TelegramBot } from './telegram-bot.js';
import type { CommandHandler, TelegramUpdate } from './telegram-commands.js';

export const RETRY_AFTER_FAILURE_MS = 5_000;

export interface PollerDeps {
  readonly bot: Pick<TelegramBot, 'getUpdates' | 'sendMessage'>;
  readonly handler: Pick<CommandHandler, 'handle'>;
  readonly ownerChatId: number;
  readonly lastUpdateId: () => number | undefined;
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

export async function runPoller(deps: PollerDeps, shutdown: AbortSignal): Promise<void> {
  const last = deps.lastUpdateId();
  let offset = last === undefined ? undefined : last + 1;
  while (!shutdown.aborted) {
    let updates: TelegramUpdate[];
    try {
      updates = await deps.bot.getUpdates(offset, shutdown);
    } catch (error) {
      if (shutdown.aborted) return;
      warn(deps.logger, 'v2_telegram_poll_failed', error);
      await deps.sleep(RETRY_AFTER_FAILURE_MS, shutdown);
      continue;
    }
    for (const update of updates) {
      offset = update.update_id + 1;
      await handleOne(deps, update);
    }
  }
}
