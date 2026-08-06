/**
 * Boot-time parser/validator for `TELEGRAM_ALLOWED_USER_IDS` (ticket #275) —
 * see docs/specs/transport-layer-spec.md ("Module: TelegramClient") and
 * docs/specs/verdict-spec.md ("Module: Human-in-the-Loop").
 *
 * Under the Telegram long-polling transport, `callback_query.from.id` checked
 * against this allowlist is the **sole working access control** over who may
 * approve a live-money trade — `SignedApprovalChannel`'s HMAC is a dormant,
 * transport-agnostic seam under this transport (the same process signs and
 * verifies), not a second gate. So a permissive or wrong allowlist is a
 * critical exposure, and an empty/unset one fails closed (nothing ever
 * matches, every approval times out to `no_go`) — an operational hazard the
 * system must not discover at runtime.
 *
 * **Two entry points as of #434.** `parseAllowedUserIds` is the strict one and
 * refuses an unset value; `parseOptionalAllowedUserIds` treats unset as an
 * empty (deny-everyone) set, which is what the client uses now that ADR-0007
 * has the approval gate off. The rejection list below applies to a value that
 * is PRESENT under either entry point — the dangerous case is not "absent" but
 * "present and wrong", and only the latter can smuggle in an approver.
 *
 * Hence: this parser throws rather than degrading. Every rejected shape is a
 * config the operator must fix before the gate is armed:
 * - unset / empty / whitespace-only — fails closed; an error under the strict
 *   entry point, an empty set under the optional one
 * - wildcards — `*`, `all`, `any`, `everyone`, `.*`, matched case-insensitively
 *   (the full set is `WILDCARDS` below; keep this list in sync with it). This
 *   is the one permissive shape a validator can actually catch; an over-broad
 *   *list* of real numeric ids cannot be distinguished from a correct one and
 *   is out of reach here
 * - non-numeric, fractional, or hex entries — a typo that would otherwise
 *   silently drop a legitimate approver
 * - empty entries (`123,,456`, a trailing comma) — rejected rather than
 *   skipped, because a lenient parse of a malformed list is exactly how a
 *   wrong allowlist survives review
 * - negative ids — a negative Telegram id is a *chat* id, and the spec is
 *   explicit that `chat.id` (shared by every group member) must never be used
 *   as a per-user identity check
 */

const ENV_VAR = 'TELEGRAM_ALLOWED_USER_IDS';

/** Values an operator might reasonably (and dangerously) expect to mean "everyone". */
const WILDCARDS = new Set(['*', 'all', 'any', 'everyone', '.*']);

/** Telegram user ids are positive integers; `Number` must round-trip the exact digits. */
const NUMERIC = /^[0-9]+$/;

function fail(detail: string): never {
  throw new Error(
    `${ENV_VAR} ${detail}. Fix the configured allowlist before arming the HITL gate.`,
  );
}

/**
 * Parses the comma-separated `TELEGRAM_ALLOWED_USER_IDS` value into a set of
 * numeric Telegram user ids. Throws (never returns an empty or permissive
 * set) on any invalid shape — see the module doc for the full rejection list.
 */
export function parseAllowedUserIds(raw: string | undefined): ReadonlySet<number> {
  if (raw === undefined || raw.trim() === '') {
    fail('is not set (or is empty). It is the sole access control on live-money approvals');
  }
  return parseNonEmptyAllowedUserIds(raw);
}

/**
 * Like `parseAllowedUserIds`, but treats an absent value as an EMPTY allowlist
 * rather than an error (#434).
 *
 * ADR-0007 turned the HITL approval gate off (`automation_level: 'auto'`), and
 * the inbound half of the Telegram round trip — the only consumer of this list
 * — is unreachable while it stays off. Demanding the variable at boot forces an
 * operator to invent a value for a dead seam, and an unexplained required
 * credential is how a startup failure becomes a twenty-minute puzzle.
 *
 * Empty is the SAFE default here, not a lenient one: the sole consumer is
 * `allowedUserIds.has(fromId)`, so an empty set denies every inbound callback.
 * "Not configured" therefore fails closed, exactly as an unset access control
 * should. A value that IS present is still validated in full — a typo'd or
 * wildcard allowlist is refused as loudly as before, because the dangerous case
 * was never "absent", it was "present and wrong".
 *
 * `requestApproval` refuses outright on an empty set rather than sending a
 * prompt nobody can answer — see `TelegramBotApiClient`.
 */
export function parseOptionalAllowedUserIds(raw: string | undefined): ReadonlySet<number> {
  if (raw === undefined || raw.trim() === '') return new Set();
  return parseNonEmptyAllowedUserIds(raw);
}

function parseNonEmptyAllowedUserIds(raw: string): ReadonlySet<number> {
  const ids = new Set<number>();
  for (const segment of raw.split(',')) {
    const entry = segment.trim();

    if (entry === '') {
      fail('contains an empty entry (a stray or trailing comma)');
    }
    if (WILDCARDS.has(entry.toLowerCase())) {
      fail(`contains a wildcard entry ("${entry}"); every approver must be listed by user id`);
    }
    if (entry.startsWith('-')) {
      fail(
        `contains "${entry}", which is a chat id, not a user id — chat.id is shared by every ` +
          'group member and cannot serve as a per-user identity check',
      );
    }
    if (!NUMERIC.test(entry)) {
      fail(`contains a non-numeric entry ("${entry}")`);
    }

    const id = Number(entry);
    if (!Number.isSafeInteger(id)) {
      fail(`contains "${entry}", which is outside the safe integer range`);
    }
    if (id <= 0) {
      fail(`contains "${entry}"; Telegram user ids are positive integers`);
    }
    ids.add(id);
  }

  return ids;
}
