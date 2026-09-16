/**
 * Logging helpers for a call site that must never throw — a `catch` block, a
 * fallback alert path — regardless of what the injected `Logger` does.
 *
 * Extracted from orchestrator/tick-loop.ts (#573) once a second caller
 * (execution/ingest-fills.ts, execution/reconcile.ts) needed the identical
 * guarantee: a `Logger.log` call reached from inside error-handling code can
 * itself throw. #714 narrowed *when* that happens for `JsonLogger` — a broken
 * stdout pipe now degrades to the file sink instead of propagating — but did
 * not remove it, deliberately: when NO sink is left that could record the
 * failure, `JsonLogger` throws rather than continue blind, and every `Logger`
 * these call sites actually receive is injected and may throw for reasons this
 * module does not control. Three consumers reusing one implementation is what keeps
 * "a log call inside a catch must not itself throw" one property to audit
 * instead of three copies that can silently drift apart.
 */
import { sanitizeLogText } from './sanitize-log-text.js';
import type { LogEntry, LogEntryTemplate, Logger } from './types.js';

/**
 * Renders a thrown value into a log-safe string.
 *
 * `String(error)` alone degrades a plain-object throw to `"[object Object]"`
 * — technically not swallowed, but not preserved either. Every throw this
 * repo's own non-test code produces is an `Error` (grepped: zero `throw {…}`
 * literals in `server/` outside `.test.ts` files — those construct hostile
 * non-`Error` throws deliberately, to exercise this exact function), so this
 * mainly guards a third-party dependency that rejects with something else.
 * `JSON.stringify` can itself throw on a circular
 * structure, which is exactly the kind of value most likely to reach this
 * fallback — so it degrades one step further to `String(error)` rather than
 * letting a formatting failure inside error handling replace the original
 * failure. `String(error)` itself can still throw for a hostile value with a
 * throwing `toString`/`Symbol.toPrimitive` — `logCaughtFailure` below is what
 * guards THAT, since this function alone cannot.
 *
 * `error.message` is read into `value` rather than returned directly: a
 * spec-conforming `Error` always has a string `message`, but nothing stops a
 * hostile subclass or a `message` getter from returning something else, and
 * this function's declared `: string` return type must hold for whatever
 * comes back. Folding that case into the same `value`/ladder the non-`Error`
 * branch already uses — rather than a second copy — is what makes a
 * non-string `message` degrade through `JSON.stringify`/`String` instead of
 * silently violating the return type.
 *
 * The ladder checks `typeof rendered === 'string'` rather than trusting
 * `JSON.stringify`'s declared `: string` return type: for `undefined`, a
 * function, or a top-level `Symbol`, `JSON.stringify` does not throw — it
 * returns `undefined` itself (`lib.es5`'s signature is unsound for exactly
 * these inputs). A `message` getter returning any of those would otherwise
 * hand this function's own caller `undefined` in a `: string` slot without
 * ever reaching the `catch`.
 */
export function describeThrown(error: unknown): string {
  const value = error instanceof Error ? error.message : error;
  if (typeof value === 'string') return value;
  try {
    const rendered = JSON.stringify(value);
    if (typeof rendered === 'string') return rendered;
  } catch {
    // Falls through to String() below
  }
  return String(value);
}

/**
 * `describeThrown` with the guard its own doc comment says it cannot provide.
 *
 * The residual hole `describeThrown` names above: `String(value)` can throw
 * for a value with a hostile `toString`/`Symbol.toPrimitive`, a `message`
 * getter can throw before the ladder is reached at all, and a `Proxy` whose
 * `getPrototypeOf` trap throws fails at the `error instanceof Error` check on
 * the very first line. Any of those throwing inside a `catch` whose job is to
 * HANDLE a failure turns a handled failure into an unhandled one, usually
 * before the handler has recorded anything about the original.
 *
 * Extracted for #1262 rather than left as the hand-written try/catch #1199
 * put at one call site: the hand-rolled
 * `instanceof Error ? .message : String(...)` conditional appears 79 times
 * in this repo's non-test code, and the ones that matter are inside
 * `catch` blocks in execution, the tick loop and the spend cap. Repeating a
 * five-line guard at each of those churns the files where a reviewable diff
 * matters most; one named call says the same thing.
 *
 * What this does NOT do, so no caller mistakes its scope:
 *
 * - It does not sanitize. `logCaughtFailure` runs `sanitizeLogText` over the
 *   rendered text; this function does not, because its callers put the result
 *   in places (an `ExecutionResult.reason`, a divergence row, an alert body)
 *   whose existing sanitization posture is the call site's own decision, not
 *   this helper's to change.
 * - It does not make the surrounding handler safe. Only the render is
 *   guarded; every other statement in the `catch` can still throw on its own.
 */
export function describeThrownSafely(error: unknown): string {
  try {
    return describeThrown(error);
  } catch {
    // Same placeholder `logCaughtFailure` below uses for the identical case —
    // one spelling for "the value could not be rendered at all", so a log
    // line, a divergence reason and an alert body all read the same
    return '[unrenderable error]';
  }
}

/**
 * Calls `logger.log`, swallowing any throw from the logger itself.
 *
 * Only ever meant to be called from inside a failure path whose entire job
 * is to guarantee nothing escapes — an EPIPE on a broken pipe, or any
 * injected `Logger` this module doesn't control, must not turn a handled
 * failure into an unhandled one. There is nowhere further to escalate a
 * logging failure without risking regress (logging that the log call
 * failed, which can itself fail), so this mirrors `JsonLogger`'s own posture
 * on a sink it cannot recover: losing one message is strictly better than
 * throwing out of error-handling code.
 */
export function safeLog(logger: Logger, entry: LogEntry): void {
  try {
    logger.log(entry);
  } catch {
    // Nothing left to do — see doc comment above
  }
}

/** The parts of a `LogEntry` fixed at the call site — everything but the payload */
export type CaughtFailureLogTemplate = LogEntryTemplate;

/**
 * Logs a caught failure whose OWN text is the diagnostic payload — a store or
 * transport error whose message explains what actually went wrong, as
 * opposed to a downstream alert channel's error (execution's
 * `ResidualExposureAlert`/`FlattenOverfillWarning`/`FlattenReconcileAlert`
 * channels all carry a CREDENTIALS note: a Telegram transport failure
 * quotes the request it failed on, which can carry a bot token — that shape
 * gets a fixed, self-authored message via `safeLog` instead, never this
 * function).
 *
 * `error instanceof Error` messages from THIS codebase are safe to surface
 * (#297's H1 — every broker adapter converts what its client threw into a
 * curated, credential-free error before it is visible here, the same
 * precedent `reconcileLot`'s own `getOrder` catch cites), but `sanitizeLogText`
 * still runs over the rendered text regardless of source, matching the
 * posture the debate/analysts adapters already take on upstream-controlled
 * error text (sanitize-log-text.ts) — belt and suspenders costs nothing here.
 *
 * Guards the render step (`describeThrown`, `sanitizeLogText`) with its own
 * try/catch, not just the `logger.log` call `safeLog` already guards: a
 * hostile thrown value's `toString`/`Symbol.toPrimitive` can itself throw,
 * and that has to be caught BEFORE it reaches `safeLog`, not by it — see
 * `describeThrown`'s own doc for why it alone cannot close that hole.
 */
export function logCaughtFailure(
  logger: Logger,
  template: CaughtFailureLogTemplate,
  error: unknown,
  extraPayload?: Record<string, unknown>,
): void {
  let errorText: string;
  try {
    errorText = sanitizeLogText(describeThrown(error));
  } catch {
    errorText = '[unrenderable error]';
  }
  safeLog(logger, { ...template, payload: { ...extraPayload, error: errorText } });
}
