import type { LogEventCode, Logger, RetryConfig } from '../../../../shared/index.js';
import {
  currentTraceId,
  describeThrownSafely,
  fetchWithTimeout,
  sanitizeLogText,
  withRetry,
} from '../../../../shared/index.js';
import type { TelegramClient } from '../types.js';
import {
  classifyTelegramResponse,
  classifyTelegramThrown,
  isRetryableTelegramError,
  TelegramProviderError,
} from './telegram-errors.js';

const DEFAULT_BASE_URL = 'https://api.telegram.org';

const DEFAULT_TIMEOUT_MS = 10_000;

export const TELEGRAM_MAX_MESSAGE_CHARS = 4096;

export function capOutboundText(text: string): string {
  if (text.length <= TELEGRAM_MAX_MESSAGE_CHARS) return text;
  const suffix = `… (truncated, ${text.length} chars total)`;
  let cut = TELEGRAM_MAX_MESSAGE_CHARS - suffix.length;
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return `${text.slice(0, cut)}${suffix}`;
}

const DEFAULT_RETRY: RetryConfig = { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 5_000 };

const DELIVERY_FAILURE_ALERT_EVERY = 3;

const LOG_STAGE = 'verdict.telegram';

export interface AlertDeliveryFailureLog {
  recordFailure(entry: {
    chat_id: string;
    method: string;
    body: string;
    error: string;
    timestamp: Date;
  }): void;
}

export interface TelegramBotApiClientOptions {
  botToken?: string;
  alertChatId?: string;
  alertDeliveryLog?: AlertDeliveryFailureLog;
  baseUrl?: string;
  timeoutMs?: number;
  retry?: RetryConfig;
  logger?: Logger;
}

export class TelegramBotApiClient implements TelegramClient {
  readonly #botToken: string;
  readonly #alertChatId: string | undefined;
  readonly #alertDeliveryLog: AlertDeliveryFailureLog | undefined;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #retry: RetryConfig;
  readonly #logger: Logger | undefined;

  #deliveryFailureCount = 0;

  constructor(options: TelegramBotApiClientOptions) {
    const botToken = (options.botToken ?? process.env.TELEGRAM_BOT_TOKEN)?.trim();
    if (botToken === undefined || botToken === '') {
      throw new Error(
        'TelegramBotApiClient: TELEGRAM_BOT_TOKEN is not set. Provide it via the environment ' +
          '(.env.local) or pass { botToken } explicitly.',
      );
    }
    this.#botToken = botToken;
    this.#alertChatId = options.alertChatId;
    this.#alertDeliveryLog = options.alertDeliveryLog;
    this.#baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#retry = options.retry ?? DEFAULT_RETRY;
    this.#logger = options.logger;
  }

  #capForWire(text: string): string {
    const capped = capOutboundText(text);
    if (capped === text) return text;
    this.#log(
      'warn',
      'telegram_body_truncated',
      `telegram_body_truncated: outbound body is ${text.length} chars, over the ` +
        `${TELEGRAM_MAX_MESSAGE_CHARS}-char limit; the wire got a truncated alert and ` +
        'the full body is in the payload',
      { chars: text.length, body: text },
    );
    return capped;
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    try {
      await this.#call('sendMessage', { chat_id: chatId, text: this.#capForWire(text) });
    } catch (error) {
      this.#recordDeliveryFailure(chatId, 'sendMessage', text, error);
      throw error;
    }
  }

  #recordDeliveryFailure(chatId: string, method: string, text: string, error: unknown): void {
    const detail = describeThrownSafely(error);

    if (this.#alertDeliveryLog !== undefined) {
      try {
        this.#alertDeliveryLog.recordFailure({
          chat_id: chatId,
          method,
          body: text,
          error: detail,
          timestamp: new Date(),
        });
      } catch (recordError) {
        this.#log(
          'error',
          'telegram_delivery_record_failed',
          `failed to durably record an undelivered alert (chat_id=${chatId}): ${sanitizeLogText(
            describeThrownSafely(recordError),
          )}`,
        );
      }
    }

    this.#log(
      'error',
      'telegram_delivery_failed',
      `alert delivery to Telegram failed permanently after retries (chat_id=${chatId}, ` +
        `method=${method}): ${sanitizeLogText(detail)}`,
      { chat_id: chatId, method, error: detail },
    );

    if (this.#alertChatId === undefined || chatId !== this.#alertChatId) return;

    this.#deliveryFailureCount++;
    if (this.#deliveryFailureCount % DELIVERY_FAILURE_ALERT_EVERY === 0) {
      this.#call('sendMessage', {
        chat_id: this.#alertChatId,
        text:
          `Samurai alert channel degraded: ${this.#deliveryFailureCount} Telegram sends have ` +
          'failed permanently after retries so far this run, so recent escalations may not ' +
          'have reached you. That you are reading this proves only that this chat was ' +
          "reachable at some point inside this notice's own send-and-retry window — a window " +
          'that can run to tens of seconds, not a single instant, and it does not mean the failures were ' +
          'something other than a channel problem, and a notice you never receive tells you ' +
          'nothing either way. The alert_delivery_failures table is the durable record, and ' +
          'the dashboard alert-channel tile is a 24-hour view of it: the tile counts rows ' +
          'for this chat in the trailing 24 hours, so its number is a different denominator ' +
          'from the one above.',
      }).catch((escalationError: unknown) => {
        this.#log(
          'error',
          'telegram_delivery_escalation_failed',
          `failed to post the repeated-delivery-failure escalation: ${sanitizeLogText(
            describeThrownSafely(escalationError),
          )}`,
        );
      });
    }
  }

  async #call(method: string, body: Record<string, unknown>): Promise<unknown> {
    return withRetry(() => this.#request(method, body), this.#retry, isRetryableTelegramError);
  }

  async #request(method: string, body: Record<string, unknown>): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchWithTimeout(
        `${this.#baseUrl}/bot${this.#botToken}/${method}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
        this.#timeoutMs,
      );
    } catch (error) {
      throw classifyTelegramThrown(error, method);
    }

    if (!response.ok) {
      throw await classifyTelegramResponse(response, method);
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (error) {
      throw new TelegramProviderError(
        `Telegram Bot API error: 2xx response body could not be parsed as JSON (${describeThrownSafely(
          error,
        )}) (${method})`,
        response.status,
      );
    }

    const envelope = parsed as { ok?: unknown; result?: unknown; description?: unknown };
    if (envelope?.ok !== true) {
      const detail = typeof envelope?.description === 'string' ? envelope.description : 'ok=false';
      throw new TelegramProviderError(
        `Telegram Bot API error: ${detail} (${method})`,
        response.status,
      );
    }
    return envelope.result;
  }

  #log(
    level: 'info' | 'warn' | 'error',
    event: LogEventCode,
    message: string,
    payload?: unknown,
  ): void {
    if (this.#logger !== undefined) {
      this.#logger.log({
        trace_id: currentTraceId() ?? '',
        stage: LOG_STAGE,
        event,
        level,
        message,
        ...(payload === undefined ? {} : { payload }),
      });
      return;
    }
    if (level !== 'info') {
      console.error(`[telegram-client] ${message}`);
    }
  }
}
