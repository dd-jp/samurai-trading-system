/**
 * Real `TelegramClient` over the Telegram Bot API.
 *
 * Outbound only: `sendMessage`, which the heartbeat, the operator escalations
 * and the verdict notifier all post through. No inbound polling — there is no
 * human gate.
 *
 * The bot token is embedded in every request path (`/bot<token>/<method>`),
 * so no URL is ever logged or baked into an error message — see
 * telegram-errors.ts.
 */
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

/**
 * Telegram's hard `sendMessage` limit, counted in UTF-16 code units.
 * Exceeding it is a `400 Bad Request: message is too long`, which is
 * PERMANENT — retrying re-sends the same over-long body and the alert is
 * dropped, having never been delivered.
 */
export const TELEGRAM_MAX_MESSAGE_CHARS = 4096;

/**
 * Bounds an outbound message so an over-long body degrades to a truncated
 * alert instead of no alert at all.
 *
 * Applied HERE, in the transport, rather than in each alert formatter: a
 * guarantee that holds only where a formatter remembered it isn't a
 * guarantee, and any catalogue entry can interpolate an unbounded `detail`.
 * This bounds only what goes on the wire; `#capForWire` is the sole caller
 * and owns keeping the untruncated record in the log.
 */
export function capOutboundText(text: string): string {
  if (text.length <= TELEGRAM_MAX_MESSAGE_CHARS) return text;
  // Slicing to the limit and appending the suffix after would still exceed it.
  const suffix = `… (truncated, ${text.length} chars total)`;
  let cut = TELEGRAM_MAX_MESSAGE_CHARS - suffix.length;
  // A lone high surrogate is not valid UTF-8 on the wire; Telegram counts
  // UTF-16 code units, so a split surrogate pair is the only slicing hazard.
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return `${text.slice(0, cut)}${suffix}`;
}

/** Sized for Telegram's ~30 messages/second ceiling; a send is not on the tick's critical path */
const DEFAULT_RETRY: RetryConfig = { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 5_000 };

/**
 * Escalate on the Nth permanently-undeliverable alert send and every Nth
 * after: a failed send is individually swallowed by the caller's own
 * `.catch`, so nothing else surfaces that a pattern is forming until an
 * operator goes looking. See `#recordDeliveryFailure`'s doc for why this
 * escalation's own delivery is not guaranteed either.
 */
const DELIVERY_FAILURE_ALERT_EVERY = 3;

/** Log `stage` for this transport's own lines — the logger's `stage` is a free-form string */
const LOG_STAGE = 'verdict.telegram';

/**
 * Write-only view of the orchestrator's `SqliteAlertDeliveryLog`, declared
 * here rather than imported so that `verdict/` never depends on
 * `orchestrator/` — the dependency runs the other way everywhere else in
 * this repo. `SqliteAlertDeliveryLog` satisfies this structurally.
 */
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
  /**
   * Defaults to `process.env.TELEGRAM_BOT_TOKEN`. Never logged, and never
   * baked into an error message. Trimmed at construction: a trailing newline
   * or space out of an env file must not reach the request URL, where it
   * fails every send. Whitespace-only counts as not configured, same as unset.
   */
  botToken?: string;
  /** The escalation chat — where the repeated-delivery-failure notice posts. Omit to disable that notice. */
  alertChatId?: string;
  /** Where a send that exhausted `retry` is durably recorded. Omit to skip durable recording — the failure still logs loudly either way. */
  alertDeliveryLog?: AlertDeliveryFailureLog;
  /** Defaults to `https://api.telegram.org` */
  baseUrl?: string;
  /** Per-request timeout. Default 10s. */
  timeoutMs?: number;
  retry?: RetryConfig;
  /** Structured logger; falls back to `console.error` for warn/error when omitted */
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
    // Trimmed at the read point: whitespace-only counts as unset, and the
    // normalized value is what's handed onward so a trailing newline out of
    // an env file never reaches the request URL below.
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

  /**
   * The wire bound and its record, together. Capping without logging the
   * original would make the truncation the very data loss it exists to
   * prevent: a capped send SUCCEEDS, so no other line would ever carry the
   * dropped tail.
   *
   * The body goes in `payload`, not `message`: `redactPayload` masks a
   * value wholesale by field name, which a plain interpolated `message`
   * string can never receive.
   */
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

  /**
   * Durable record of a send that exhausted `#retry` — by the time this runs
   * the alert is genuinely undelivered, not merely slow. Never throws past
   * this point: a broken durable write must not replace the original send
   * failure the caller is about to see.
   *
   * Passes `text`/`detail` through uncapped, not the wire-capped body:
   * `SqliteAlertDeliveryLog.recordFailure` owns masking-then-capping the
   * durable row (mask first, so a bot token can't be bisected by an
   * earlier cap and left half-unmasked).
   *
   * Reuses `#call` directly rather than `sendMessage` for the escalation
   * send: routing it back through `sendMessage` would re-enter this method
   * on a further failure, and a sustained outage would recurse.
   *
   * The escalation counter only advances for a failure on `#alertChatId`
   * itself. The heartbeat posts to a separate chat by design, so a dead
   * heartbeat destination must not count toward or trigger a "channel
   * degraded" alert on the escalation channel it's isolated from.
   *
   * The "channel degraded" notice below posts over this same transport, so
   * its arrival only proves `#alertChatId` was reachable somewhere inside
   * this escalation's own retry window (up to ~30s with default config) —
   * not that the channel is healthy, and not that earlier sends' failures
   * were the same kind of problem. Its ABSENCE is equally undiagnostic:
   * nobody can observe a message they never received. The durable
   * `alert_delivery_failures` count — not this notice — is the surface that
   * answers "is the channel down", since it survives regardless of whether
   * any Telegram send can get through.
   *
   * That count and the dashboard's 24h tile have different denominators
   * (this field is in-process and resets with the process; the tile windows
   * by timestamp), so the sent text below states both rather than leaving
   * the operator to reconcile them.
   */
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
        // sanitizeLogText guards against a thrown message that happens to
        // echo back token-bearing text (e.g. from a misconfigured storage driver).
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
        // The escalation send itself can fail (e.g. a misconfigured baseUrl);
        // sanitize since redactPayload never walks this plain string message.
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

  /** Bot API call with the client's retry policy */
  async #call(method: string, body: Record<string, unknown>): Promise<unknown> {
    return withRetry(() => this.#request(method, body), this.#retry, isRetryableTelegramError);
  }

  /** One Bot API request. The bot token is in the URL, so the URL never reaches an error or a log. */
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

    // Telegram can answer 200 with `{ok: false}` — treat it as a failure, not
    // a silently empty result
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
