/**
 * Wires the polling `TelegramClient` to `SignedApprovalChannel` (ticket #275)
 * — see docs/specs/transport-layer-spec.md ("Module: TelegramClient", inbound
 * flow step 3) and docs/specs/verdict-spec.md ("Module: Human-in-the-Loop").
 *
 * This is the `ApprovalChannel` a composition root hands to Verdict when the
 * live transport is Telegram. It owns nothing about approvals itself:
 * `SignedApprovalChannel` (#207) still holds the pending map and the
 * fail-safe timeout, and `TelegramBotApiClient` still owns the poll loop, the
 * `from.id` allowlist and the correlation tokens. This class only joins them:
 *
 * - **Outbound:** it is the channel's `ApprovalRequestSender`, formatting the
 *   request (format.ts, unchanged from #81) and asking the client for two
 *   inline buttons tagged with the request's `trace_id`/`idempotency_key` and
 *   its `timeout_ms` — so the client's correlation-token expiry and the
 *   channel's pending-entry expiry run on the same clock.
 * - **Inbound:** it registers the client's approval-callback handler,
 *   locally constructs and HMAC-signs the `ApprovalCallbackPayload`, and
 *   calls `SignedApprovalChannel.handleCallback`.
 *
 * **The HMAC step here is a dormant, transport-agnostic seam — not
 * defence-in-depth.** The same process signs and verifies with the same
 * secret, which proves nothing about the caller; the access-control decision
 * already happened in the client's `from.id` allowlist check. It is preserved
 * verbatim so a future webhook-based channel (where a signature *would* be
 * unforgeable evidence) plugs into an unchanged code path, and because
 * changing one side of the round trip mid-flight (secret rotation, payload
 * canonicalization drift) fails closed rather than open.
 *
 * Which is exactly why the secret is validated at construction: an empty key
 * signs and verifies consistently, so an empty secret would pass silently
 * today and be a real exposure the day a webhook transport ships
 * (verdict-spec.md, "HMAC secret boot-time validation"). The validation lives
 * here — the construction point — rather than inside
 * approval-callback-verifier.ts's free functions, which have none.
 */
import type { ApprovalChannel, ApprovalOutcome, ApprovalRequest } from '../../types.js';
import { signApprovalCallback } from '../approval-callback-verifier.js';
import { formatApprovalRequest } from '../format.js';
import type { ApprovalCallback, TelegramClient } from '../types.js';
import type { ApprovalRequestSender } from '../verified-approval-channel.js';
import { SignedApprovalChannel } from '../verified-approval-channel.js';

const SECRET_ENV_VAR = 'TELEGRAM_APPROVAL_HMAC_SECRET';

export interface TelegramApprovalGatewayOptions {
  /** The polling client — one per process (see telegram-bot-api-client.ts on `getUpdates` being single-consumer). */
  client: TelegramClient;
  /** The trade channel/group the approval request is posted to. */
  chatId: string;
  /** Defaults to `process.env.TELEGRAM_APPROVAL_HMAC_SECRET`. Rejected at construction when missing/empty. Never logged. */
  secret?: string;
  /** Seam for tests to observe the channel's `handleCallback`; defaults to `new SignedApprovalChannel(sender)`. */
  createChannel?: (sender: ApprovalRequestSender) => SignedApprovalChannel;
}

export class TelegramApprovalGateway implements ApprovalChannel {
  readonly #client: TelegramClient;
  readonly #chatId: string;
  readonly #secret: string;
  readonly #channel: SignedApprovalChannel;

  constructor(options: TelegramApprovalGatewayOptions) {
    const secret = options.secret ?? process.env[SECRET_ENV_VAR];
    if (secret === undefined || secret.trim() === '') {
      throw new Error(
        `TelegramApprovalGateway: ${SECRET_ENV_VAR} is not set (or is empty). An empty HMAC key ` +
          'signs and verifies consistently, so it would silently defeat the approval-callback ' +
          'seam instead of failing. Provide it via the environment (.env.local) or pass ' +
          '{ secret } explicitly.',
      );
    }

    this.#client = options.client;
    this.#chatId = options.chatId;
    this.#secret = secret;

    const sender: ApprovalRequestSender = { send: (request) => this.#send(request) };
    this.#channel = (options.createChannel ?? ((s) => new SignedApprovalChannel(s)))(sender);

    options.client.onApprovalCallback((callback) => this.#onApprovalCallback(callback));
  }

  /** Delegates to `SignedApprovalChannel` — the pending map and `timeout_ms` fail-safe are unchanged (#207). */
  async requestApproval(request: ApprovalRequest): Promise<ApprovalOutcome> {
    return this.#channel.requestApproval(request);
  }

  async #send(request: ApprovalRequest): Promise<void> {
    await this.#client.sendApprovalButtons(this.#chatId, formatApprovalRequest(request), {
      trace_id: request.trace_id,
      idempotency_key: request.order_intent.idempotency_key,
      timeout_ms: request.timeout_ms,
    });
  }

  #onApprovalCallback(callback: ApprovalCallback): void {
    // Canonicalization is `signApprovalCallback`'s own — deliberately not
    // reimplemented here, so a change to it can never drift between the two
    // sides of this same-process round trip.
    this.#channel.handleCallback(
      { ...callback, signature: signApprovalCallback(callback, this.#secret) },
      this.#secret,
    );
  }
}
