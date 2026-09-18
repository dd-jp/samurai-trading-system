
import {
  classifyStatus,
  isServerErrorStatus,
  parseRetryAfterMs,
  truncateForError,
} from '../../../../shared/index.js';

export class TelegramTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelegramTimeoutError';
  }
}

export class TelegramRateLimitError extends Error {
  readonly retryAfterMs: number | undefined;

  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'TelegramRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class TelegramProviderError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'TelegramProviderError';
    this.status = status;
  }
}

export class TelegramNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelegramNetworkError';
  }
}

export type TelegramError =
  | TelegramTimeoutError
  | TelegramRateLimitError
  | TelegramProviderError
  | TelegramNetworkError;

export function isRetryableTelegramError(error: unknown): boolean {
  if (
    error instanceof TelegramTimeoutError ||
    error instanceof TelegramRateLimitError ||
    error instanceof TelegramNetworkError
  ) {
    return true;
  }
  if (error instanceof TelegramProviderError) {
    return isServerErrorStatus(error.status);
  }
  return false;
}

function retryAfterMsFromBody(bodyText: string): number | undefined {
  try {
    const body = JSON.parse(bodyText) as { parameters?: { retry_after?: unknown } };
    const seconds = body.parameters?.retry_after;
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return undefined;
    return seconds * 1000;
  } catch {
    return undefined;
  }
}

function describe(bodyText: string, response: Response): string {
  if (bodyText.length === 0) return response.statusText;
  try {
    const body = JSON.parse(bodyText) as { description?: unknown };
    if (typeof body.description === 'string' && body.description.length > 0) {
      return body.description;
    }
  } catch {
  }
  return truncateForError(bodyText);
}

export async function classifyTelegramResponse(
  response: Response,
  context: string,
): Promise<TelegramError> {
  let bodyText: string;
  try {
    bodyText = await response.text();
  } catch {
    bodyText = '';
  }

  const message = `Telegram Bot API error: ${response.status} ${describe(bodyText, response)} (${context})`;

  switch (classifyStatus(response.status)) {
    case 'rate-limit':
      return new TelegramRateLimitError(
        message,
        retryAfterMsFromBody(bodyText) ?? parseRetryAfterMs(response),
      );
    case 'timeout':
      return new TelegramTimeoutError(message);
    default:
      return new TelegramProviderError(message, response.status);
  }
}

export function classifyTelegramThrown(error: unknown, context: string): TelegramError {
  if (
    error instanceof TelegramTimeoutError ||
    error instanceof TelegramRateLimitError ||
    error instanceof TelegramNetworkError
  ) {
    return error;
  }
  if (error instanceof TelegramProviderError) {
    return error;
  }
  const name = (error as { name?: unknown } | null)?.name;
  const detail = error instanceof Error ? error.message : String(error);
  if (name === 'TimeoutError') {
    return new TelegramTimeoutError(`Telegram Bot API timeout: ${detail} (${context})`);
  }
  if (name === 'AbortError') {
    return new TelegramProviderError(`Telegram Bot API transport failure: ${detail} (${context})`);
  }
  if (error instanceof TypeError && error.cause instanceof Error) {
    return new TelegramNetworkError(`Telegram Bot API transport failure: ${detail} (${context})`);
  }
  return new TelegramProviderError(`Telegram Bot API transport failure: ${detail} (${context})`);
}
