/**
 * Real `TelegramClient` over the Telegram Bot API (ticket #275) — see
 * docs/specs/transport-layer-spec.md ("Module: TelegramClient"), Wayfinder map
 * "Live Transport Layer" #259 (closed), decision #262, and
 * docs/specs/verdict-spec.md ("Module: Human-in-the-Loop", as amended by #272).
 *
 * Three capabilities, replacing the interface's retired `sendApprovalRequest`
 * (which baked in a synchronous round trip a polling transport cannot offer):
 * `sendMessage` (unchanged — heartbeat/notify), `sendApprovalButtons`
 * (non-blocking; mints a correlation token per button), and
 * `onApprovalCallback` (handler registration, invoked only *after* the
 * `from.id` allowlist check).
 *
 * ## Transport: long polling, not webhook
 *
 * `getUpdates`, because there is no inbound HTTP server anywhere in this
 * codebase and the MacBook host has no public DNS/TLS story. `getUpdates` is
 * **single-consumer per bot token** — a second concurrent poller gets HTTP
 * 409 — so exactly one process (the Orchestrator) may call `start()`;
 * Stage 2/backtest processes must never poll. A 409 is logged loudly and
 * backed off hard rather than retried tightly, since retrying only fights the
 * other consumer.
 *
 * `start()` is a thin loop over `pollOnce()`; the offset arithmetic and
 * dispatch live in `pollOnce()` so both are testable against a stubbed
 * `fetch` without an infinite loop.
 *
 * ## Offset handling
 *
 * The client tracks the highest `update_id` it has seen and passes
 * `offset = last_update_id + 1` on every subsequent poll — Telegram's own
 * redelivery contract, without which every unacknowledged update comes back
 * on each poll. The offset is **in-memory only**: a restart may see one batch
 * redelivered, but each redelivered callback is independently a no-op, since
 * its correlation token was consumed (or died with the process) — see
 * correlation-tokens.ts.
 *
 * ## Authenticator (the load-bearing security decision)
 *
 * `callback_query.from.id` against `TELEGRAM_ALLOWED_USER_IDS` is the **sole
 * working access control** on live-money trade approvals under this
 * transport, **not** `chat.id` (shared by every member of the trade group).
 * `SignedApprovalChannel`'s HMAC stays in the code path as a dormant,
 * transport-agnostic seam (see telegram-approval-gateway.ts), but a
 * same-process construct-and-verify round trip proves nothing about the
 * caller. The allowlist is validated at construction (allowlist.ts) rather
 * than discovered wrong at runtime.
 *
 * Inbound flow per `callback_query`:
 *   1. `from.id` allowlist check — log to the audit log and discard on any
 *      mismatch, including a callback with no `from` at all.
 *   2. Recover the pending request + outcome via the correlation token.
 *   3. Invoke the registered handler(s) (the gateway signs and calls
 *      `SignedApprovalChannel.handleCallback` from there).
 *   4. **Always** `answerCallbackQuery` — including on an allowlist rejection
 *      and on an unknown/expired token. The AC is unconditional, and
 *      Telegram spins the *presser's* client regardless of who pressed;
 *      "log and discard" in the spec's step 1 governs *resolution*, not the
 *      UI acknowledgement.
 *
 * ## Secret handling
 *
 * The bot token is embedded in every request path (`/bot<token>/<method>`),
 * so no URL is ever logged or baked into an error message — see
 * telegram-errors.ts. Correlation tokens are live bearer capabilities and
 * only ever reach a log through `tokenLogPrefix` (first 8 hex chars). Raw
 * update objects are never logged for the same reason.
 */
import type { Logger, RetryConfig } from '../../../shared/index.js';
import { fetchWithTimeout, withRetry } from '../../../shared/index.js';
import type { ApprovalButtonTarget, ApprovalCallback, TelegramClient } from '../types.js';
import { parseAllowedUserIds } from './allowlist.js';
import { CorrelationTokenStore, tokenLogPrefix } from './correlation-tokens.js';
import {
  classifyTelegramResponse,
  classifyTelegramThrown,
  isRetryableTelegramError,
  TelegramProviderError,
} from './telegram-errors.js';

const DEFAULT_BASE_URL = 'https://api.telegram.org';

/**
 * How long Telegram holds a `getUpdates` request open waiting for an update.
 * Paired with `POLL_HTTP_TIMEOUT_MS` below — the HTTP timeout MUST exceed
 * this window with margin, or every poll aborts before Telegram ever answers
 * and no update is ever observed. Change these two together.
 */
const POLL_TIMEOUT_SECONDS = 25;
/** Long-poll window (seconds -> ms) plus 10s of slack. See POLL_TIMEOUT_SECONDS. */
const POLL_HTTP_TIMEOUT_MS = (POLL_TIMEOUT_SECONDS + 10) * 1000;

/** Ordinary (non-polling) request timeout — `sendMessage`, `answerCallbackQuery`. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Sized for Telegram's ~30 messages/second ceiling; a send is not on the tick's critical path. */
const DEFAULT_RETRY: RetryConfig = { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 5_000 };

/** Backoff after a failed poll, and the much longer one after a 409 (another poller holds the token). */
const POLL_ERROR_BACKOFF_MS = 5_000;
const POLL_CONFLICT_BACKOFF_MS = 60_000;

/**
 * Alert on the Nth allowlist rejection and every Nth after — repeated
 * rejections are a plausible probing signal and must not sit silently in the
 * audit log (transport-layer-spec.md leaves the exact threshold to
 * implementation).
 */
const REJECTION_ALERT_EVERY = 3;

/** Audit `stage` for an inbound HITL callback — the audit log's `stage` is a free-form string. */
const AUDIT_STAGE = 'verdict.hitl.telegram_callback';
/** Recorded when the rejected token matches nothing, so the trace is genuinely unknown. */
const UNKNOWN_TRACE_ID = 'unknown';

/**
 * Write-only view of the orchestrator's `AuditLog` (orchestrator/types.ts),
 * declared here rather than imported so that `verdict/` never depends on
 * `orchestrator/` — the dependency runs the other way everywhere else in this
 * repo (e.g. orchestrator's `TradeChannelHeartbeat` imports `TelegramClient`
 * from `verdict/index.js`). `SqliteAuditLog` satisfies this structurally, and
 * a type-level test in telegram-bot-api-client.test.ts pins that.
 */
export interface CallbackAuditLog {
  record(entry: {
    trace_id: string;
    stage: string;
    decision: string;
    input_digest: string;
    output_digest: string;
    timestamp: Date;
  }): void;
}

export interface TelegramBotApiClientOptions {
  /**
   * Defaults to `process.env.TELEGRAM_BOT_TOKEN`. Never logged, and never
   * baked into an error message. Trimmed at construction (#355, same rule as
   * the chat ids and `SAMURAI_ALERTS` in #354): a trailing newline or space
   * out of an env file must not reach the request URL, where it fails every
   * send. Whitespace-only counts as not configured, same as unset.
   */
  botToken?: string;
  /** Raw comma-separated allowlist; defaults to `process.env.TELEGRAM_ALLOWED_USER_IDS`. Validated at construction. */
  allowedUserIds?: string;
  /** Where rejected `from.id` callbacks are recorded. Required — a silent rejection is the failure mode this closes. */
  auditLog: CallbackAuditLog;
  /** Chat for repeated-rejection security alerts (the existing heartbeat/notify channel). Omit to disable alerting. */
  alertChatId?: string;
  /** Defaults to `https://api.telegram.org`. */
  baseUrl?: string;
  /** Per-request timeout for non-polling calls. Default 10s. The poll has its own, wider, budget. */
  timeoutMs?: number;
  /** Retry policy for non-polling calls. The poll loop uses its own backoff instead. */
  retry?: RetryConfig;
  /** Structured logger; falls back to `console.error` for warn/error when omitted. */
  logger?: Logger;
}

/** Only the fields this client reads — Telegram sends a great deal more. */
interface TelegramCallbackQuery {
  id?: unknown;
  from?: { id?: unknown };
  message?: { chat?: { id?: unknown } };
  data?: unknown;
}

interface TelegramUpdate {
  update_id?: unknown;
  callback_query?: TelegramCallbackQuery;
}

export class TelegramBotApiClient implements TelegramClient {
  readonly #botToken: string;
  readonly #allowedUserIds: ReadonlySet<number>;
  readonly #auditLog: CallbackAuditLog;
  readonly #alertChatId: string | undefined;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #retry: RetryConfig;
  readonly #logger: Logger | undefined;

  readonly #tokens = new CorrelationTokenStore();
  readonly #handlers: ((callback: ApprovalCallback) => void)[] = [];

  #offset: number | undefined;
  #rejectionCount = 0;
  #running = false;
  #loop: Promise<void> | undefined;
  #pollAbort: AbortController | undefined;
  /** Cuts an in-progress backoff sleep short on `stop()`. */
  #wake: (() => void) | undefined;

  constructor(options: TelegramBotApiClientOptions) {
    // Trimmed at the read point, not just validated — same rule #354 applied
    // to the chat ids and SAMURAI_ALERTS: whitespace-only counts as unset,
    // and the *normalized* value is what's handed onward, so a trailing
    // newline out of an env file never reaches the request URL below.
    const botToken = (options.botToken ?? process.env.TELEGRAM_BOT_TOKEN)?.trim();
    if (botToken === undefined || botToken === '') {
      throw new Error(
        'TelegramBotApiClient: TELEGRAM_BOT_TOKEN is not set. Provide it via the environment ' +
          '(.env.local) or pass { botToken } explicitly.',
      );
    }
    // Boot-time validation, not a runtime discovery: an unset/wildcard/typo'd
    // allowlist is either a fail-closed gate nobody notices or a critical
    // exposure. See allowlist.ts.
    this.#allowedUserIds = parseAllowedUserIds(
      options.allowedUserIds ?? process.env.TELEGRAM_ALLOWED_USER_IDS,
    );

    this.#botToken = botToken;
    this.#auditLog = options.auditLog;
    this.#alertChatId = options.alertChatId;
    this.#baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#retry = options.retry ?? DEFAULT_RETRY;
    this.#logger = options.logger;
  }

  /** Live correlation tokens (two per un-resolved approval request). Diagnostic/test surface. */
  get pendingTokenCount(): number {
    return this.#tokens.size;
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    await this.#call('sendMessage', { chat_id: chatId, text });
  }

  /**
   * Posts an approval request with approve/reject inline buttons and returns
   * immediately — the human's answer arrives later on the poll loop, not as
   * this call's return value.
   *
   * Both correlation tokens are minted *before* the send so a callback that
   * somehow beats the HTTP response still resolves; if the send fails, both
   * are dropped (the buttons were never delivered) and the error is rethrown
   * for the caller's own fail-safe — `SignedApprovalChannel` swallows it and
   * falls through to `timeout_ms`.
   */
  async sendApprovalButtons(
    chatId: string,
    text: string,
    target: ApprovalButtonTarget,
  ): Promise<void> {
    const pair = this.#tokens.mintPair(
      { trace_id: target.trace_id, idempotency_key: target.idempotency_key },
      target.timeout_ms,
    );

    try {
      await this.#call('sendMessage', {
        chat_id: chatId,
        text,
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Approve', callback_data: pair.approved },
              { text: '❌ Reject', callback_data: pair.rejected },
            ],
          ],
        },
      });
    } catch (error) {
      this.#tokens.consume(pair.approved);
      throw error;
    }
  }

  /** Registers a handler invoked only for callbacks that passed the allowlist check and matched a live token. */
  onApprovalCallback(handler: (callback: ApprovalCallback) => void): void {
    this.#handlers.push(handler);
  }

  /**
   * Starts the single long-poll loop. Idempotent; exactly one process may
   * hold a given bot token (see module doc on 409).
   */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#loop = this.#runLoop();
  }

  /** Stops the loop, aborts any in-flight poll, and drops every live correlation token. */
  async stop(): Promise<void> {
    this.#running = false;
    this.#pollAbort?.abort();
    this.#wake?.();
    const loop = this.#loop;
    this.#loop = undefined;
    if (loop !== undefined) await loop;
    this.#tokens.clear();
  }

  /**
   * One `getUpdates` round trip: fetch, advance the offset past everything
   * received, and dispatch each `callback_query`. Advancing the offset is not
   * conditional on a callback being handled successfully — otherwise a single
   * poison update would be redelivered forever.
   */
  async pollOnce(): Promise<void> {
    const updates = await this.#getUpdates();

    for (const update of updates) {
      const updateId = typeof update.update_id === 'number' ? update.update_id : undefined;
      if (updateId !== undefined && (this.#offset === undefined || updateId >= this.#offset)) {
        this.#offset = updateId + 1;
      }
      if (update.callback_query !== undefined) {
        await this.#handleCallbackQuery(update.callback_query);
      }
    }
  }

  async #runLoop(): Promise<void> {
    while (this.#running) {
      try {
        await this.pollOnce();
      } catch (error) {
        if (!this.#running) return;
        const conflict = error instanceof TelegramProviderError && error.status === 409;
        this.#log(
          'error',
          conflict
            ? 'getUpdates returned 409 Conflict — another process is polling this bot token. ' +
                'Exactly one process may poll; inbound approvals are NOT being observed here.'
            : `getUpdates failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        await this.#sleep(conflict ? POLL_CONFLICT_BACKOFF_MS : POLL_ERROR_BACKOFF_MS);
      }
    }
  }

  async #getUpdates(): Promise<TelegramUpdate[]> {
    this.#pollAbort = new AbortController();
    const result = await this.#request(
      'getUpdates',
      {
        ...(this.#offset === undefined ? {} : { offset: this.#offset }),
        timeout: POLL_TIMEOUT_SECONDS,
        allowed_updates: ['callback_query'],
      },
      { timeoutMs: POLL_HTTP_TIMEOUT_MS, signal: this.#pollAbort.signal },
    );
    return Array.isArray(result) ? (result as TelegramUpdate[]) : [];
  }

  /**
   * Steps 1-4 of the inbound flow (see module doc). Never throws: a failure
   * anywhere here must not kill the poll loop, and step 4 must run either way.
   */
  async #handleCallbackQuery(query: TelegramCallbackQuery): Promise<void> {
    const callbackQueryId = typeof query.id === 'string' ? query.id : undefined;
    const token = typeof query.data === 'string' ? query.data : '';
    const fromId = typeof query.from?.id === 'number' ? query.from.id : undefined;
    const chatId = typeof query.message?.chat?.id === 'number' ? query.message.chat.id : undefined;

    let answerText = 'This approval is no longer pending.';

    try {
      // (1) Allowlist check — before token recovery, before any payload construction.
      if (fromId === undefined || !this.#allowedUserIds.has(fromId)) {
        await this.#recordAllowlistRejection(fromId, chatId, token);
        answerText = 'Not authorised.';
        return;
      }

      // (2) Correlation-token recovery. An unknown/expired/already-consumed
      // token is a no-op — the pending approval falls through to its own
      // timeout, and a Telegram redelivery resolves nothing twice.
      const target = this.#tokens.consume(token);
      if (target === undefined) {
        this.#log(
          'info',
          `callback_query carried an unknown or expired correlation token (${tokenLogPrefix(token)}…)`,
        );
        return;
      }

      // (3) Hand off — the gateway signs and calls SignedApprovalChannel.
      answerText = target.outcome === 'approved' ? 'Approved.' : 'Rejected.';
      for (const handler of this.#handlers) {
        try {
          handler(target);
        } catch (error) {
          this.#log(
            'error',
            `approval callback handler threw: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    } finally {
      // (4) Always answer, or the presser's Telegram client spins on the button.
      if (callbackQueryId !== undefined) {
        try {
          await this.#call('answerCallbackQuery', {
            callback_query_id: callbackQueryId,
            text: answerText,
          });
        } catch (error) {
          this.#log(
            'error',
            `answerCallbackQuery failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  }

  /**
   * Audit-logs a failed allowlist check with the field set verdict-spec.md's
   * "Observability — allowlist failure" bullet requires: channel, reason, the
   * offending `from.id` (the field ops needs to attribute and block a repeat
   * prober), `chat.id`, a truncated token prefix — never the full token — and
   * the `trace_id` when known.
   *
   * The `trace_id` comes from a **read-only** peek: the allowlist check runs
   * before token recovery, so this lookup must never resolve, consume, or
   * expire the pending entry. A legitimate press after a rejected one still
   * works.
   */
  async #recordAllowlistRejection(
    fromId: number | undefined,
    chatId: number | undefined,
    token: string,
  ): Promise<void> {
    const known = token === '' ? undefined : this.#tokens.peek(token);

    try {
      this.#auditLog.record({
        trace_id: known?.trace_id ?? UNKNOWN_TRACE_ID,
        stage: AUDIT_STAGE,
        decision: 'allowlist_rejected',
        input_digest: JSON.stringify({
          channel: 'telegram',
          reason: 'from_id_not_allowlisted',
          from_id: fromId ?? null,
          chat_id: chatId ?? null,
          correlation_token_prefix: tokenLogPrefix(token),
        }),
        output_digest: 'discarded',
        timestamp: new Date(),
      });
    } catch (error) {
      // A broken audit write must not take the poll loop down with it, but it
      // must be loud — this is the only record of a security signal.
      this.#log(
        'error',
        `failed to audit-log an allowlist rejection (from_id=${fromId ?? 'absent'}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    this.#rejectionCount++;
    this.#log(
      'warn',
      `rejected a callback_query from a non-allowlisted user (from_id=${fromId ?? 'absent'}, ` +
        `chat_id=${chatId ?? 'absent'}, token=${tokenLogPrefix(token)}…)`,
    );

    if (this.#alertChatId !== undefined && this.#rejectionCount % REJECTION_ALERT_EVERY === 0) {
      try {
        await this.sendMessage(
          this.#alertChatId,
          `Samurai security alert: ${this.#rejectionCount} unauthorised Telegram approval ` +
            `attempts so far this run (most recent from user id ${fromId ?? 'absent'}). ` +
            'Check TELEGRAM_ALLOWED_USER_IDS and who has access to the trade channel.',
        );
      } catch (error) {
        this.#log(
          'error',
          `failed to post the repeated-rejection alert: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  /** Non-polling Bot API call with the client's retry policy. */
  async #call(method: string, body: Record<string, unknown>): Promise<unknown> {
    return withRetry(
      () => this.#request(method, body, { timeoutMs: this.#timeoutMs }),
      this.#retry,
      isRetryableTelegramError,
    );
  }

  /** One Bot API request. The bot token is in the URL, so the URL never reaches an error or a log. */
  async #request(
    method: string,
    body: Record<string, unknown>,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchWithTimeout(
        `${this.#baseUrl}/bot${this.#botToken}/${method}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
        options.timeoutMs,
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
        `Telegram Bot API error: 2xx response body could not be parsed as JSON (${
          error instanceof Error ? error.message : String(error)
        }) (${method})`,
        response.status,
      );
    }

    // Telegram can answer 200 with `{ok: false}` — treat it as a failure, not
    // a silently empty result.
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

  /**
   * Backoff sleep that `stop()` can cut short. Without the wake hook a
   * shutdown during the 60s post-409 backoff would block `stop()` for a
   * minute — long enough that an operator (or a test) reasonably concludes
   * the process has hung.
   */
  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        this.#wake = undefined;
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this.#wake = finish;
    });
  }

  #log(level: 'info' | 'warn' | 'error', message: string): void {
    if (this.#logger !== undefined) {
      this.#logger.log({ trace_id: '', stage: AUDIT_STAGE, level, message });
      return;
    }
    if (level !== 'info') {
      console.error(`[telegram-client] ${message}`);
    }
  }
}
