/**
 * Mechanism only (#764) — no decision lives here.
 *
 * #714 fixed the unguarded-stdout class for the orchestrator, whose answer to
 * "does an arbitrary fault stop or continue the process" is *stop*, and whose
 * reasoning is specific to a process holding real positions. The service-api
 * (dashboard) and supervisor entrypoints carry the same stdout-write class but
 * are not trading processes, and #764 deliberately does not carry the
 * orchestrator's *stop* answer across by analogy — each entrypoint records its
 * own decision, in its own file, next to where these functions are called.
 * This module exposes the two mechanisms both decisions are built from and
 * classifies nothing.
 *
 * ## The measurement (#764, reproduced from #714 against `console.log`)
 *
 * Neither entrypoint writes to `process.stdout` directly — both go through
 * `console.log`/`console.error`/`console.warn`, which write through
 * `process.stdout.write` internally. Reproducing #714's methodology against
 * `console.log` specifically (parent spawns a child over a pipe, destroys the
 * read end mid-stream, child keeps calling `console.log` on an interval):
 *
 * - **No `'error'` listener on `process.stdout`:** the destroyed pipe surfaced
 *   as `uncaughtException: write EPIPE` after 5 of 40 writes, and the child
 *   died. Zero synchronous throws were observed — a `try/catch` around a
 *   `console.log` call would have caught nothing, same finding as #714.
 * - **With a listener:** 36 asynchronous `'error'` events across the
 *   remaining writes, zero throws, the child ran to completion.
 *
 * So `console.log` does not neutralise the async-event class #714 measured —
 * it inherits it unchanged, because it writes through the same stream. Both
 * entrypoints need the same subscription the orchestrator's logger needed.
 *
 * ## Where the recoverable/arbitrary line is drawn
 *
 * By origin, at the stream — not by error code, matching #714's rejection of
 * an `EPIPE` exemption in a process-level handler (a code is not a
 * provenance; `EPIPE` also arrives from a broker socket or, on the
 * supervisor, from a child's own pipe). `watchStdoutErrors` subscribes to
 * stdout's own `'error'` event, so what reaches its callback is a stdout
 * fault by construction. `installContinueOnFault` below classifies nothing
 * either: every arbitrary fault that reaches it is reported the same way.
 *
 * ## This module has no opinion on which stream — call it for both
 *
 * `watchStdoutErrors` is generic over anything shaped like `StdoutStream`, not
 * hard-wired to `process.stdout`. Both entrypoints call it a second time
 * against `process.stderr` with a no-op handler, because stderr is where this
 * module's own fault reports land, and on the failure this ticket targets
 * (closed terminal, torn-down detached tmux) stdout and stderr frequently
 * share the same underlying fd — see each entrypoint's `fault-guard.ts` for
 * the empirical confirmation. A no-op subscription is still the entire fix:
 * Node stops treating the event as uncaught the moment a listener exists,
 * regardless of what it does.
 */

/** The subset of `process.stdout` this module needs to subscribe to. */
export interface StdoutStream {
  on(event: 'error', listener: (error: Error) => void): unknown;
}

/** The subset of `process.stderr` a fault report is written to. */
export interface ErrorStream {
  write(line: string): unknown;
}

/**
 * Subscribes to `stdout`'s own `'error'` event so an asynchronous write
 * failure reaches `onFault` instead of Node's default `uncaughtException`
 * handling (which kills the process when nothing is listening — see the
 * module doc's measurement). Attaching a listener is the entire mechanism:
 * Node no longer treats the event as uncaught once one exists, regardless of
 * what the listener does with it.
 */
export function watchStdoutErrors(stdout: StdoutStream, onFault: (error: Error) => void): void {
  stdout.on('error', onFault);
}

/**
 * Writes `line` to `stream`, swallowing any failure.
 *
 * A fault report is itself a last resort — if writing it can also throw, it
 * is not one. Mirrors `JsonLogger.lastResort` (logger.ts, #714) for the same
 * reason, on a narrower stream.
 */
export function guardedWrite(stream: ErrorStream, line: string): void {
  try {
    stream.write(line);
  } catch {
    // Nothing left to try, and nothing to report it on.
  }
}

export type ProcessFault = 'uncaughtException' | 'unhandledRejection';

export interface ContinueOnFaultEffects {
  stderr: ErrorStream;
  on: (event: ProcessFault, handler: (error: unknown) => void) => void;
}

/**
 * Installs a process-level fault handler that reports loudly, on stderr, and
 * does **not** exit — the "continue" half of a per-entrypoint decision.
 * Structurally the mirror of `installFaultHandlers`
 * (`orchestrator/index.ts`, #714), which reports the same way and then always
 * exits; the difference is the one line this module does not contain. Which
 * posture is right for a given process is decided at the call site, not here.
 *
 * `describe` renders the report line; passed in rather than hard-coded so
 * each entrypoint's message names itself and its own reasoning, the way
 * `installFaultHandlers`'s message names the orchestrator's.
 */
export function installContinueOnFault(
  describe: (fault: ProcessFault, error: unknown) => string,
  effects: ContinueOnFaultEffects = {
    stderr: process.stderr,
    on: (event, handler) => {
      process.on(event, handler);
    },
  },
): void {
  const report = (fault: ProcessFault) => (error: unknown) => {
    guardedWrite(effects.stderr, `${describe(fault, error)}\n`);
  };
  effects.on('uncaughtException', report('uncaughtException'));
  effects.on('unhandledRejection', report('unhandledRejection'));
}
