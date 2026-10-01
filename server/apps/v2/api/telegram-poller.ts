import { type Logger, sanitizeLogText } from '../../../shared/index.js';
import type { Heartbeat } from '../heartbeat.js';
import { TelegramApiError, type TelegramBot } from './telegram-bot.js';
import type { CommandHandler, TelegramUpdate } from './telegram-commands.js';

export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_CAP_MS = 5 * 60_000;
export const ALERT_AFTER_FAILURES = 5;
export const HEARTBEAT_EVERY_MS = 5 * 60_000;
const CONFLICT_STATUS = 409;

export interface PollerDeps {
  readonly bot: Pick<TelegramBot, 'getUpdates' | 'sendMessage'>;
  readonly handler: Pick<CommandHandler, 'handle'>;
  readonly ownerChatId: number;
  readonly logger: Logger;
  readonly replyPrefix: string;
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly alert: (text: string) => Promise<void>;
  readonly heartbeat: Heartbeat;
  readonly nowMs: () => number;
}

interface PollState {
  failures: number;
  alerted: boolean;
  lastBeatMs: number | undefined;
}

function causeOf(error: unknown): string {
  return sanitizeLogText(error instanceof Error ? error.message : String(error));
}

function log(logger: Logger, level: 'warn' | 'error', event: string, message: string): void {
  logger.log({ trace_id: 'v2-telegram', stage: 'v2', level, event, message });
}

function isConflict(error: unknown): boolean {
  return error instanceof TelegramApiError && error.status === CONFLICT_STATUS;
}

export function backoffMs(failures: number, error: unknown): number {
  if (error instanceof TelegramApiError && error.retryAfterSeconds !== undefined) {
    return error.retryAfterSeconds * 1_000;
  }
  return Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_CAP_MS);
}

async function handleOne(deps: PollerDeps, update: TelegramUpdate): Promise<void> {
  try {
    const reply = await deps.handler.handle(update);
    if (reply !== undefined) await deps.bot.sendMessage(deps.ownerChatId, deps.replyPrefix + reply);
  } catch (error) {
    log(deps.logger, 'warn', 'v2_telegram_command_failed', causeOf(error));
  }
}

async function raiseAlert(
  deps: PollerDeps,
  failures: number,
  error: unknown,
  waitMs: number,
): Promise<void> {
  const polls = failures === 1 ? '1 poll' : `${failures} polls`;
  const conflict = isConflict(error)
    ? " Another poller or a webhook is taking this bot's updates."
    : '';
  const longWait = waitMs > BACKOFF_CAP_MS ? ` Telegram asked to wait ${waitMs / 1_000} s.` : '';
  const text = `Telegram command poller: ${polls} failed in a row, last: ${causeOf(error)}.${conflict}${longWait} Phone halt, resume and flatten may not reach Samurai.`;
  await Promise.allSettled([deps.alert(text), deps.heartbeat('fail')]);
}

async function onPollFailure(
  deps: PollerDeps,
  state: PollState,
  error: unknown,
  shutdown: AbortSignal,
): Promise<void> {
  state.failures += 1;
  if (isConflict(error)) {
    log(
      deps.logger,
      'error',
      'v2_telegram_poll_conflict',
      `${causeOf(error)}: another poller or a webhook is taking this bot's updates`,
    );
  } else {
    log(deps.logger, 'warn', 'v2_telegram_poll_failed', causeOf(error));
  }
  const waitMs = backoffMs(state.failures, error);
  if (!state.alerted && (state.failures >= ALERT_AFTER_FAILURES || waitMs > BACKOFF_CAP_MS)) {
    state.alerted = true;
    await raiseAlert(deps, state.failures, error, waitMs);
    state.lastBeatMs = undefined;
  }
  await deps.sleep(waitMs, shutdown);
}

async function fetchUpdates(
  deps: PollerDeps,
  state: PollState,
  offset: number | undefined,
  shutdown: AbortSignal,
): Promise<TelegramUpdate[] | undefined> {
  try {
    return await deps.bot.getUpdates(offset, shutdown);
  } catch (error) {
    if (!shutdown.aborted) await onPollFailure(deps, state, error, shutdown);
    return undefined;
  }
}

function beat(deps: PollerDeps, state: PollState): void {
  const now = deps.nowMs();
  if (state.lastBeatMs !== undefined && now - state.lastBeatMs < HEARTBEAT_EVERY_MS) return;
  state.lastBeatMs = now;
  void deps.heartbeat('success').catch(() => undefined);
}

export async function runPoller(deps: PollerDeps, shutdown: AbortSignal): Promise<void> {
  const state: PollState = { failures: 0, alerted: false, lastBeatMs: undefined };
  let offset: number | undefined;
  while (!shutdown.aborted) {
    const updates = await fetchUpdates(deps, state, offset, shutdown);
    // Telegram picks a random next update_id after a week of silence; a stale offset above it would silently drop halt/flatten
    offset = undefined;
    if (updates === undefined) continue;
    state.failures = 0;
    state.alerted = false;
    for (const update of updates) {
      offset = update.update_id + 1;
      await handleOne(deps, update);
    }
    beat(deps, state);
  }
}
