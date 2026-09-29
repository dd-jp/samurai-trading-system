import { maskAndCap } from '../../../shared/index.js';
import type { TelegramUpdate } from './telegram-commands.js';

export const LONG_POLL_SECONDS = 30;
const POLL_SLACK_MS = 15_000;
const SEND_TIMEOUT_MS = 10_000;
const REPLY_MAX_CHARS = 4_000;

export interface BotResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type BotFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<BotResponse>;

export class TelegramApiError extends Error {}

function isUpdate(candidate: unknown): candidate is TelegramUpdate {
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    Number.isInteger((candidate as { update_id?: unknown }).update_id)
  );
}

export class TelegramBot {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: BotFetch,
  ) {}

  async getUpdates(offset: number | undefined, shutdown: AbortSignal): Promise<TelegramUpdate[]> {
    const body = await this.call(
      'getUpdates',
      {
        timeout: LONG_POLL_SECONDS,
        allowed_updates: ['message'],
        ...(offset === undefined ? {} : { offset }),
      },
      AbortSignal.any([shutdown, AbortSignal.timeout(LONG_POLL_SECONDS * 1_000 + POLL_SLACK_MS)]),
    );
    const { result } = body as { result?: unknown };
    if (!Array.isArray(result))
      throw new TelegramApiError('Telegram getUpdates returned no result list');
    return result.filter(isUpdate);
  }

  async sendMessage(chatId: number, text: string): Promise<void> {
    await this.call(
      'sendMessage',
      { chat_id: chatId, text: maskAndCap(text, REPLY_MAX_CHARS) },
      AbortSignal.timeout(SEND_TIMEOUT_MS),
    );
  }

  // A fetch error's own text can carry the request URL, which holds the bot token
  private async call(method: string, payload: object, signal: AbortSignal): Promise<unknown> {
    let response: BotResponse;
    try {
      response = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      });
    } catch {
      throw new TelegramApiError(`Telegram ${method} did not complete`);
    }
    if (!response.ok) throw new TelegramApiError(`Telegram ${method} answered ${response.status}`);
    return response.json();
  }
}
