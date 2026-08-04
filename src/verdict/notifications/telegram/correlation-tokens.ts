/**
 * Correlation-token map for Telegram inline approve/reject buttons (ticket
 * #275) — see docs/specs/transport-layer-spec.md ("Module: TelegramClient",
 * Correlation bullet).
 *
 * The Bot API caps `callback_data` at 64 bytes, and this system's raw payload
 * (`trace_id:idempotency_key:outcome`) is already ~80+ bytes before any
 * signature — so the button carries an **opaque token** instead, and this
 * store is the local `token -> {trace_id, idempotency_key, outcome}` map that
 * resolves it back.
 *
 * **128 bits (32 hex chars) from a CSPRNG is a floor, not a preference.** The
 * token is a bearer capability on a live-money approval: anyone who learns it
 * can resolve that request (subject to the `from.id` allowlist), so its
 * unguessability has to hold on its own rather than leaning on the expiry
 * window to shrink an attacker's guess budget. The expiry is a bonus.
 *
 * **Pair lifecycle.** One entry per button, both minted before the message is
 * sent, both expiring on the same `timeout_ms` the caller passes — which is
 * `SignedApprovalChannel`'s own pending-entry `timeout_ms`, so the two maps
 * stay in lockstep. Consuming either button drops both, so a double-press (or
 * a Telegram redelivery of an already-actioned update after a restart) can
 * never resolve the same request twice.
 *
 * Timers are plain `setTimeout`s rather than the injected `Clock`, matching
 * `SignedApprovalChannel`'s own precedent — the two expiries must fire on the
 * same timebase, and that class uses real timers.
 *
 * Process restart drops this map entirely, exactly as it drops
 * `SignedApprovalChannel`'s `#pending` — the same fail-safe-to-timeout
 * (`no_go_reason: 'timeout'`) the rest of the system already assumes for
 * crash-restart. No new failure mode.
 */
import { randomBytes } from 'node:crypto';

/** 16 bytes -> 32 hex chars -> 128 bits. See module doc on why this is a floor. */
const TOKEN_BYTES = 16;

/** How much of a token may ever appear in a log or audit entry. */
const TOKEN_LOG_PREFIX_CHARS = 8;

/** The pending approval (and which button) a correlation token resolves to. */
export interface CorrelationTarget {
  trace_id: string;
  idempotency_key: string;
  outcome: 'approved' | 'rejected';
}

/** The pair of tokens minted for one approval request's two inline buttons. */
export interface CorrelationTokenPair {
  approved: string;
  rejected: string;
}

interface Entry extends CorrelationTarget {
  /** The other button's token — consumed/expired together with this one. */
  sibling: string;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * The only sanctioned way a correlation token reaches a log line. The full
 * token is a live bearer capability until the request times out; persisting
 * it would let anyone with log access resolve the approval, undercutting the
 * 128-bit unguessability argument entirely (verdict-spec.md, "Observability —
 * allowlist failure").
 */
export function tokenLogPrefix(token: string): string {
  return token.slice(0, TOKEN_LOG_PREFIX_CHARS);
}

export class CorrelationTokenStore {
  readonly #entries = new Map<string, Entry>();

  /** Live token count (both buttons of every un-resolved, un-expired request). */
  get size(): number {
    return this.#entries.size;
  }

  /**
   * Mints one token per outcome for a single approval request. Both expire
   * after `timeoutMs` — pass `ApprovalRequest.timeout_ms` so this map and
   * `SignedApprovalChannel`'s pending entry expire together.
   */
  mintPair(
    target: Pick<CorrelationTarget, 'trace_id' | 'idempotency_key'>,
    timeoutMs: number,
  ): CorrelationTokenPair {
    const approved = this.#mintToken();
    const rejected = this.#mintToken();

    this.#register(approved, { ...target, outcome: 'approved' }, rejected, timeoutMs);
    this.#register(rejected, { ...target, outcome: 'rejected' }, approved, timeoutMs);

    return { approved, rejected };
  }

  /**
   * Read-only lookup — never resolves, consumes, or expires anything.
   *
   * Exists for the allowlist-rejection logging path: the `from.id` check runs
   * *before* token recovery, so populating the audit entry's `trace_id`
   * requires a best-effort peek that must leave the pending entry untouched
   * (transport-layer-spec.md; verdict-spec.md "Observability — allowlist
   * failure").
   */
  peek(token: string): CorrelationTarget | undefined {
    const entry = this.#entries.get(token);
    if (entry === undefined) return undefined;
    return {
      trace_id: entry.trace_id,
      idempotency_key: entry.idempotency_key,
      outcome: entry.outcome,
    };
  }

  /**
   * Resolves a pressed button and retires **both** of its request's tokens.
   * Returns `undefined` for an unknown/already-consumed/expired token — the
   * no-op that makes a Telegram redelivery harmless.
   */
  consume(token: string): CorrelationTarget | undefined {
    const entry = this.#entries.get(token);
    if (entry === undefined) return undefined;

    this.#drop(token);
    this.#drop(entry.sibling);

    return {
      trace_id: entry.trace_id,
      idempotency_key: entry.idempotency_key,
      outcome: entry.outcome,
    };
  }

  /** Drops every entry and cancels its timer — used on client shutdown. */
  clear(): void {
    for (const entry of this.#entries.values()) {
      clearTimeout(entry.timer);
    }
    this.#entries.clear();
  }

  #mintToken(): string {
    // Collision at 128 bits is not a practical concern, but a mint that
    // silently overwrote a live entry would resolve the wrong request, so the
    // loop is cheap insurance rather than defensive noise.
    let token = randomBytes(TOKEN_BYTES).toString('hex');
    while (this.#entries.has(token)) {
      token = randomBytes(TOKEN_BYTES).toString('hex');
    }
    return token;
  }

  #register(token: string, target: CorrelationTarget, sibling: string, timeoutMs: number): void {
    const timer = setTimeout(() => {
      this.#drop(token);
      this.#drop(sibling);
    }, timeoutMs);
    this.#entries.set(token, { ...target, sibling, timer });
  }

  #drop(token: string): void {
    const entry = this.#entries.get(token);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    this.#entries.delete(token);
  }
}
