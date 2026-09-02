/**
 * Credential redaction for `LogEntry.payload`, applied centrally in
 * `formatLogLine` (#1035).
 *
 * ## Why this is not `sanitizeLogText` over the serialized string
 *
 * The obvious one-line fix — `sanitizeLogText(JSON.stringify(payload))` —
 * **corrupts the log format**, and was rejected on a worked example rather
 * than on taste. `sanitize-log-text.ts`'s value class is
 * `[^\s,;"'}\]]+`: it excludes `"`, `}` and `]`, but NOT `{`. So the
 * serialized `{"auth":{"scheme":"basic"}}` matches `auth":{"scheme` as the
 * "value" and redacts to:
 *
 * ```
 * {"auth":[REDACTED]"scheme":"basic"}}
 * ```
 *
 * which is not parseable JSON. On a line-oriented log whose whole contract is
 * "one JSON object per line", an unparseable line is worse than the leak it
 * was trying to prevent: every downstream reader breaks, including the ones an
 * operator reaches for during the incident.
 *
 * Redacting the object GRAPH instead cannot produce that outcome. The
 * structure is rebuilt and re-serialized by `JSON.stringify`, so the output is
 * valid by construction whatever the key and value text happens to be.
 *
 * ## Two rules, and why the key rule exists at all
 *
 * 1. A value whose KEY names a credential is replaced wholesale, whatever its
 *    type. `{ api_key: 'x' }` is a secret in a way `sanitizeLogText` cannot
 *    see: as prose it is a bare token with no assignment syntax around it, so
 *    the pattern list — deliberately narrow, and correctly so — never matches.
 *    Structure is the only place that information exists.
 * 2. Every string LEAF is passed through `maskCredentials`, which catches the
 *    assignment syntaxes inside free text (an error body, a provider message,
 *    a rendered prompt) that rule 1 cannot see.
 *
 * Deliberately NOT a second length cap. The LLM capture path already caps
 * prompt and response at their own bounds (`maskAndCap`), and re-capping here
 * would re-truncate an already-truncated string mid-suffix — the exact hazard
 * `response-errors.ts`'s `MAX_ERROR_BODY_CHARS` doc warns about.
 *
 * ## Bounded, and it must never throw
 *
 * This runs on EVERY log line, and payloads on that path include open records
 * (`debate_state`) and whole stage outputs. Hence the depth and node bounds:
 * an unbounded walk over a pathological payload would put arbitrary work
 * inside every tick's logging call.
 *
 * **The throw guard is load-bearing for #714, not defensive habit.**
 * `formatLogLine` is also what `degradationLine` builds on, and
 * `degradationLine` runs on the both-sinks-dead path where the resulting
 * string is written straight to stderr as the run's last trace. A walker that
 * threw there would take out that last-resort write and turn a logging
 * degradation into silence — precisely the outcome #714's rule exists to
 * prevent. So the caller wraps this and substitutes `{ redaction_failed: true
 * }`, and `degradationLine`'s own in-repo literal payloads bypass the walker
 * entirely: they contain no credentials and there is nothing to gain by giving
 * the failure path more work to do.
 *
 * Note this also closes a latent hazard that predates it: `JSON.stringify`
 * throws on a cyclic payload, and before this the throw was uncaught.
 */
import { maskCredentials } from '../../shared/index.js';

/**
 * Keys whose value is replaced wholesale, matched case-insensitively against
 * the key with separators stripped (`api_key`, `api-key`, `apiKey` all
 * normalize to `apikey`).
 *
 * Kept in step with `sanitize-log-text.ts`'s pattern list — the same names,
 * read structurally rather than as assignment syntax. `authorization` and
 * `cookie` are here and not there for the reason the split exists: as a bare
 * header name in prose they are not evidence of a secret, but as an object KEY
 * the value beside them is one.
 */
const CREDENTIAL_KEYS: ReadonlySet<string> = new Set([
  'apikey',
  'apisecret',
  'apcaapikeyid',
  'apcaapisecretkey',
  'auth',
  'authorization',
  'cookie',
  'credential',
  'credentials',
  'passwd',
  'password',
  'privatekey',
  'pwd',
  'secret',
  'sessiontoken',
  'token',
]);

/** The placeholder, identical to the one `sanitize-log-text.ts` writes. */
const REDACTED = '[REDACTED]';

/**
 * How deep the walk goes before it stops descending.
 *
 * A payload nested past this is replaced with a marker rather than dropped
 * silently — a reader must be able to tell "there was more here" from "there
 * was nothing here".
 */
const MAX_DEPTH = 6;

/**
 * How many nodes the walk visits before it gives up on the rest.
 *
 * Sized well above any payload this system logs today (a stage output or a
 * debate state) and far below anything that would cost real time inside a
 * tick.
 */
const MAX_NODES = 2_000;

function isCredentialKey(key: string): boolean {
  return CREDENTIAL_KEYS.has(key.toLowerCase().replace(/[-_\s]/g, ''));
}

/**
 * Returns a redacted copy of `payload`, safe to `JSON.stringify`.
 *
 * Can throw only on something pathological the bounds do not cover; the caller
 * in `logger.ts` is required to treat that as `{ redaction_failed: true }`
 * rather than letting it escape. See this module's doc for why.
 */
export function redactPayload(payload: unknown): unknown {
  // One counter for the whole walk, not per level: the bound that matters is
  // total work done inside a logging call, and a wide-but-shallow payload
  // costs exactly as much as a narrow-but-deep one.
  let visited = 0;

  const walk = (value: unknown, depth: number): unknown => {
    if (visited >= MAX_NODES) return '[REDACTION_TRUNCATED]';
    visited += 1;

    if (typeof value === 'string') return maskCredentials(value);

    // Primitives carry no key context and no free text, so there is nothing to
    // mask; returned as-is to keep the payload's types intact for a reader.
    if (value === null || typeof value !== 'object') return value;

    if (depth >= MAX_DEPTH) return '[REDACTION_DEPTH_LIMIT]';

    if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1));

    // Anything with a custom prototype (Error, Date, Map, a class instance)
    // does not survive a key walk in a recognisable shape, so it is rendered
    // the way `JSON.stringify` would have rendered it and then masked as text.
    // Errors are the case that actually occurs here, and their `message` is
    // exactly the free text `maskCredentials` exists for.
    if (value instanceof Error) return maskCredentials(`${value.name}: ${value.message}`);
    if (value instanceof Date) return value.toISOString();

    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      // Rule 1 before the walk: a credential key's value is replaced whatever
      // it is, so a secret nested inside an object under `auth` cannot escape
      // by being structured rather than a string.
      out[key] = isCredentialKey(key) ? REDACTED : walk(item, depth + 1);
    }
    return out;
  };

  return walk(payload, 0);
}
