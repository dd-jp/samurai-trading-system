/**
 * Real `TelegramClient` over the Telegram Bot API (ticket #275) — see
 * docs/specs/transport-layer-spec.md ("Module: TelegramClient").
 *
 * Outbound only: `sendMessage`, which the heartbeat, the operator escalations
 * and the verdict notifier all post through. No inbound polling — there is no
 * human gate (ADR-0007, ADR-0013).
 *
 * ## Secret handling
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
 *
 * Exceeding it is a `400 Bad Request: message is too long`, which is
 * PERMANENT: `DEFAULT_RETRY` re-sends the same over-long body twice more and
 * the alert is then dropped, having never been delivered. Observed live on
 * 2026-09-04 — `control_arm_valuation_refused` for NFLX failed this way, and
 * the operator learned nothing.
 */
export const TELEGRAM_MAX_MESSAGE_CHARS = 4096;

/**
 * Bounds an outbound message so an over-long body degrades to a truncated
 * alert instead of no alert at all.
 *
 * Applied HERE, in the transport, rather than in each alert formatter, for
 * the reason `formatLogLine` gives about redaction: a guarantee that holds
 * only where a formatter remembered it is not a guarantee. Every alert
 * catalogue entry (orchestrator/alert-catalogue.ts) builds its own body and
 * any of them can interpolate an unbounded `detail` — the NFLX failure
 * came from `describeThrown` over a multi-member `AggregateError`, whose size
 * scales with the number of open positions.
 *
 * This bounds only what goes on the wire; `#capForWire` is the sole caller
 * and owns keeping the record. The suffix names the original length, so a
 * reader knows to go to the log rather than assuming the alert was all there
 * was.
 */
export function capOutboundText(text: string): string {
  if (text.length <= TELEGRAM_MAX_MESSAGE_CHARS) return text;
  // Slicing to the limit and appending after would still exceed it and still
  // 400. No guard is needed on `cut`: `suffix` is ~30 chars plus the digits
  // of `text.length`, and no JS string is long enough to make that 4,096.
  const suffix = `… (truncated, ${text.length} chars total)`;
  let cut = TELEGRAM_MAX_MESSAGE_CHARS - suffix.length;
  // A lone high surrogate is not valid UTF-8 on the wire. Telegram counts
  // UTF-16 code units, so `.length` is the right unit and a split pair is the
  // only slicing hazard it leaves.
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return `${text.slice(0, cut)}${suffix}`;
}

/** Sized for Telegram's ~30 messages/second ceiling; a send is not on the tick's critical path. */
const DEFAULT_RETRY: RetryConfig = { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 5_000 };

/**
 * Escalate on the Nth permanently-undeliverable alert send and every Nth
 * after (#1108) — a failed send is individually swallowed by the caller's own
 * `.catch`, so nothing else surfaces that a pattern is forming until an
 * operator goes looking. It posts over the transport it is reporting on, so
 * it arrives only if `#alertChatId` is reachable at some point inside this
 * send's OWN retry window — not at one instant: the escalation goes through
 * `#call`, so `DEFAULT_RETRY.maxAttempts` attempts of `DEFAULT_TIMEOUT_MS`
 * each, plus backoff, span up to tens of seconds — a bound, not an elapsed
 * time: a refused connection fast-fails and leaves only the backoffs. A
 * necessary condition about that
 * window, not a partition of failure classes, and NOT sufficient (this send
 * has its own `#call`, which can fail on its own). See `#recordDeliveryFailure`'s doc
 * (#1130), and `alert_delivery_failures` for the surface that answers
 * regardless.
 */
const DELIVERY_FAILURE_ALERT_EVERY = 3;

/** Log `stage` for this transport's own lines — the logger's `stage` is a free-form string. */
const LOG_STAGE = 'verdict.telegram';

/**
 * Write-only view of the orchestrator's `SqliteAlertDeliveryLog`
 * (alert-delivery-log.ts), declared here rather than imported so that
 * `verdict/` never depends on `orchestrator/` — the dependency runs the other
 * way everywhere else in this repo (e.g. orchestrator's `tradeChannelAlert`
 * imports `TelegramClient` from `verdict/index.js`). `SqliteAlertDeliveryLog`
 * satisfies this structurally, and a type-level test in
 * telegram-bot-api-client.test.ts pins that.
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
   * baked into an error message. Trimmed at construction (#355, same rule as
   * the chat ids and `SAMURAI_ALERTS` in #354): a trailing newline or space
   * out of an env file must not reach the request URL, where it fails every
   * send. Whitespace-only counts as not configured, same as unset.
   */
  botToken?: string;
  /** The escalation chat — where the repeated-delivery-failure notice posts. Omit to disable that notice. */
  alertChatId?: string;
  /**
   * Where a send that exhausted `retry` is durably recorded (#1108). Omit to
   * skip durable recording — the failure still logs loudly either way.
   */
  alertDeliveryLog?: AlertDeliveryFailureLog;
  /** Defaults to `https://api.telegram.org`. */
  baseUrl?: string;
  /** Per-request timeout. Default 10s. */
  timeoutMs?: number;
  retry?: RetryConfig;
  /** Structured logger; falls back to `console.error` for warn/error when omitted. */
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
   * prevent: the ten alert channels log only in their `.catch`, and a capped
   * send SUCCEEDS, so no other line would ever carry the dropped tail.
   *
   * The body goes in `payload`, not `message`: `redactPayload` walks every
   * string it reaches and runs `maskCredentials` over it, so a token
   * appearing in alert prose is masked by pattern rather than by the
   * accident that `text` does not carry one today. `formatLogLine` masks
   * `message` the same way now too (#1133), so this convention is no
   * longer the only thing standing between a stray token and the log — but
   * `redactPayload`'s KEY rule still redacts a value wholesale by field
   * name (`{ api_key: '<value>' }`, whatever the value looks like), which a
   * plain interpolated `message` string can never receive; that is what
   * payload still earns over message. Not a length-cap difference — neither
   * has one (`redact-payload.ts` is explicit about deliberately not adding
   * a second cap).
   *
   * Nothing bridges logger output into an alert channel, so this warn cannot
   * re-enter the transport that emitted it.
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
   * Durable record of a send that exhausted `#retry` (#1108) — `#call`
   * already gave it `#retry.maxAttempts` tries; by the time this runs the
   * alert is genuinely undelivered, not merely slow. Never throws past this
   * point: a broken durable write must not replace the original send
   * failure the caller is about to see.
   *
   * Passes `text`/`detail` through uncapped, not the wire-capped body —
   * `SqliteAlertDeliveryLog.recordFailure` owns masking-then-capping the
   * durable row (mask first, so a bot token cannot be bisected by a cap
   * applied ahead of it and left half-unmasked); capping here first would
   * just re-do that decision in the wrong order. The row ends up holding as
   * much of the original alert as that shared 500-char error-body cap
   * allows, independent of what Telegram's 4096-char limit happened to let
   * through.
   *
   * The repeated-failure escalation reuses `#call` directly rather than
   * `sendMessage`, deliberately: routing it back through `sendMessage` would
   * re-enter this method on a further failure, and an outage that never lets
   * up would recurse. `#call`'s own failure here is best-effort and logged,
   * never recorded as a second delivery failure.
   *
   * The escalation counter only advances for a failure on `#alertChatId`
   * itself — every real alert send targets that one chat. The heartbeat is the
   * deliberate exception (#342: a different chat, precisely so a dead
   * heartbeat destination cannot mute or drown the escalation channel); a
   * heartbeat failure is still durably recorded below, but must not count
   * toward — or itself trigger — a "the escalation channel is degraded"
   * alert posted to the very channel #342 protects.
   *
   * **What the "channel degraded" notice below is (and is not) for (#1130).**
   * It posts to `#alertChatId` over this same `#call`/`sendMessage` path —
   * the exact transport that just exhausted its retries. The guarantee that
   * buys is exactly one thing, and it is narrower than a statement about
   * failure classes: **the notice arrives only if this chat is reachable at
   * some point within the escalation send's own retry window.** Not at one
   * instant, and that distinction is this method's, not a quibble: the
   * escalation goes through `#call`, i.e. `withRetry(..., this.#retry,
   * isRetryableTelegramError)`, and `isRetryableTelegramError` accepts
   * exactly the errors a live outage throws (`TelegramNetworkError`,
   * `TelegramTimeoutError`, `TelegramRateLimitError`). So the escalation can
   * fire mid-outage, lose its first attempt, and land on a later one. With
   * this file's defaults — `DEFAULT_RETRY` (3 attempts, 500ms base, 5s cap)
   * over `DEFAULT_TIMEOUT_MS` (10s per attempt) — that window is up to
   * roughly 30 seconds, and longer if Telegram's own `retry_after` hints set
   * the backoffs; both are injectable (`options.retry`, `options.timeoutMs`),
   * so the window is a property of the configured client, not a constant.
   * It is a CEILING, not an elapsed time: a refused connection fails in
   * milliseconds, so the same three attempts can span under two seconds.
   * Necessary, not sufficient — the converse does not hold, because this
   * escalation's own `#call` can fail for reasons independent of the chat
   * (the misconfigured `baseUrl` this module's header names as the live
   * threat is exactly one), and its failure is swallowed into
   * `telegram_delivery_escalation_failed` below. So a chat that is up does
   * not guarantee the notice was sent, and a notice that arrived proves only
   * that the chat was up somewhere in that window.
   *
   * That partition does NOT line up with "content problem vs channel
   * problem", and earlier wording here claimed it did. Two corrections, both
   * measured against this file:
   *
   *  - Intermittent transport failure lands on BOTH sides. Three sends can
   *    exhaust `DEFAULT_RETRY` against a real outage that then lifts before
   *    the third failure's escalation fires, and the notice gets through —
   *    so an arriving notice is not evidence the channel was healthy. It is
   *    evidence about the escalation's own retry window only, and the outage
   *    need not even have lifted before that window opened: the escalation
   *    retries across it.
   *  - The oversized-body example this doc used to lead with cannot occur.
   *    `#capForWire` runs `capOutboundText` on every `sendMessage` body,
   *    and that function computes its cut as
   *    `TELEGRAM_MAX_MESSAGE_CHARS - suffix.length` *before* appending, so
   *    the wire body is always <= 4,096 — #1108's own fix. A rate limit is
   *    likewise not "content-specific": it is a property of the sender's
   *    traffic, and it was listed inside a set labelled content-specific.
   *
   * The other direction matters just as much for the operator: the notice's
   * ABSENCE is not diagnostic. Nobody can observe a message they never
   * received, so silence is indistinguishable from a healthy channel. That
   * is why the durable count, not this notice, is the surface. There is no
   * alternative transport to fail over to: every catalogue alert sends over
   * this one client (`tradeChannelAlert`, orchestrator/alert-catalogue.ts), and
   * the Discord seam that once existed as a type was deleted for never
   * having an implementation (#1154). Routing this notice to the heartbeat chat instead would
   * not help either: that chat is a different `chat_id` over the identical
   * bot/`#call` stack, so it fails identically when Telegram itself is down,
   * and posting an escalation there would violate #342's isolation invariant
   * in the other direction (an escalation sharing the beat's destination is
   * exactly what #342 forbids). The durable count this method writes below
   * — `alert_delivery_failures`, rendered on the dashboard Rail whenever
   * nonzero — is what actually answers "is the channel down": it is a
   * straight read of this table, so it survives regardless of whether any
   * Telegram send, including this escalation's own attempt, could get
   * through — subject to its own precondition, which `types.ts`'s
   * `getAlertDeliveryFailureCount` doc states in full: a service-api process
   * holding a *wrong* `TELEGRAM_CHAT_ID` counts zero and renders nothing.
   *
   * The two numbers have different denominators, and the sent text below
   * says so rather than leaving an operator to reconcile them. This
   * method's `#deliveryFailureCount` is in-process and resets with the
   * process; the tile counts rows in the TRAILING 24 HOURS
   * (`alert-delivery-log.ts`'s `countFailures`, windowed by #1131 — it used
   * to bound `timestamp` only above by `asOf`, so a nonzero tile could be a
   * transient failure from weeks ago that never cleared). The window means
   * the tile now self-clears once the channel has been quiet for a day, but
   * it still is not the same count as the one above: this run's total can
   * exceed the windowed tile (an earlier failure in this same run already
   * aged out), or fall short of it (a previous run's failures are still
   * inside the window).
   *
   * `error: detail` in the `#log` payload below is masked centrally by
   * `formatLogLine`'s `redactPayload` walk, and `message` is masked there
   * too now (#1133) via `maskCredentials` directly — a bot-token-shaped
   * `TypeError` message (a misconfigured `baseUrl`, say) no longer depends
   * on this call site to stay out of the log. `detail` is still run through
   * `sanitizeLogText` before interpolation below regardless: `formatLogLine`
   * masks but does not cap `message`, and `sanitizeLogText` still owns that
   * length bound.
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
        // Same reason `detail` below is wrapped: `sanitizeLogText` still owns
        // the length cap `formatLogLine`'s central message mask (#1133)
        // doesn't apply, for the same token-bearing-`TypeError` threat this
        // module's header documents — e.g. a misconfigured storage
        // `baseUrl`/driver whose thrown message happens to echo back the
        // failed insert's own token-bearing text (#1108 third review pass).
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
        // Same reason `detail` above is wrapped: this escalation send itself
        // reaches `#call`/`#request` and can fail against the very
        // misconfigured `baseUrl` this module's header names as the threat —
        // `redactPayload` never walks this plain string `message` (#1108
        // third review pass).
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

  /** Bot API call with the client's retry policy. */
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
