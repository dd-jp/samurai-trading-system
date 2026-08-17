/**
 * `Logger` (#95) — see docs/specs/orchestrator-spec.md (Module: Structured
 * Logging & Audit Spine).
 *
 * One JSON line per call: timestamp, trace_id, stage, level, message, payload
 * (orchestrator-spec.md story 10).
 *
 * ## Sinks (#325)
 *
 * Stdout **and** an optional durable file — both, never either. Stdout keeps a
 * foreground run readable; the file is what makes a 14-day unattended soak
 * (#238) diagnosable after the fact, since the structured log is the only
 * surface carrying stage-level detail (`audit_log` persists digests, from
 * which no value can be reconstructed). Story 11's "stdout + rotated file" was
 * deferred by #95 and is closed here; the rotation itself lives in
 * `./rotating-file-sink.ts`.
 *
 * The file sink is an explicit constructor argument with no default —
 * `new JsonLogger()` is still stdout-only. That is deliberate: this class is
 * constructed by `production.ts`'s defaults and by a dozen test call sites,
 * and construction must not leave files on disk as a side effect. The
 * *deployment* decision to open a file belongs on the shipped entrypoint's
 * path, which is what `buildEntrypointLogger` below is for — the same
 * reasoning `alert-transport.ts` gives for building the Telegram client at the
 * entrypoint rather than in the composition root.
 *
 * ## What happens when a sink fails (#714)
 *
 * **One rule, symmetric in both directions: a failing sink is reported on the
 * other sink and then abandoned; when there is no other sink left that can
 * take that report, the failure propagates.**
 *
 * That is the whole decision, and the reasoning is:
 *
 * - *A soak must not die from a logging failure alone.* A logging call sits
 *   inside every tick, so a full disk or a closed terminal cannot be allowed
 *   to end a 14-day run (#238) that is otherwise healthy.
 * - *…but the failure itself must not be lost.* A logger that swallows and
 *   continues blind is indistinguishable from a quiet system: the operator
 *   learns nothing, and the durable trace the soak exists to produce stops
 *   without a mark. So a degradation is only ever swallowed once it has been
 *   *recorded somewhere that survives the sink that failed* — the file when
 *   stdout dies, stdout when the file dies.
 * - *When it cannot be recorded anywhere, the process must not continue.*
 *   Both sinks gone means this run can no longer produce evidence of what it
 *   did with real money. Propagating hands it to the composition root's fault
 *   handler (`index.ts`'s `installFaultHandlers`), which records what it can
 *   on stderr and exits deliberately, rather than trading on invisibly.
 *
 * Until #714 the primary `process.stdout.write` was unguarded. Chasing that
 * back: #95 (PR #124) neither asked about nor recorded any reasoning for it —
 * the original module doc justified only the *deferred file sink*. The
 * "deliberate" framing came from #325/#349, whose point was that changing this
 * must not ride an unrelated PR. It was measured, not undone by assumption:
 * see `watchStdoutErrors` for what a real EPIPE actually does.
 *
 * ### Three "report once" flags, and which one fires
 *
 * 1. `RotatingFileSink.failed` — the real degrade on the shipped path when the
 *    *file* fails. It reports through `onFailure` (`warnOnStdout`) and no-ops
 *    thereafter, and exposes itself as `degraded` so this class can tell a
 *    silent no-op from a durable write.
 * 2. `JsonLogger.fileSinkFailed` — the same degrade for a *foreign*
 *    `LogLineSink` someone injects, which has no `attempt` of its own. Never
 *    flips on `buildEntrypointLogger`'s path, because `RotatingFileSink.write`
 *    cannot throw.
 * 3. `JsonLogger.stdoutDegraded` — set when *stdout* fails, and only once the
 *    degradation has been durably recorded on the file sink. Stdout is then
 *    skipped for the life of the process; the file carries the run.
 */
import type { LogEntry } from '../../shared/index.js';
import {
  type FileSinkConfig,
  fileSinkConfigFromEnvironment,
  RotatingFileSink,
} from './rotating-file-sink.js';
import type { Logger } from './types.js';

/**
 * The byte sink a `JsonLogger` writes formatted lines to.
 *
 * `degraded` is optional and load-bearing when present: `RotatingFileSink`
 * swallows its own I/O failures, so a `write()` that returned normally is not
 * by itself proof anything reached the disk. This class must not claim a
 * degradation was durably recorded when it was written into a retired sink —
 * see `recordDurably`.
 */
export interface LogLineSink {
  write(line: string): void;
  /** True once this sink has retired and its `write` is a silent no-op. */
  readonly degraded?: boolean;
}

/**
 * The parts of `process.stdout` this module uses.
 *
 * Injectable for one reason that is not testing convenience: the `'error'`
 * subscription in `watchStdoutErrors` is the mechanism, and a mechanism only
 * reachable through the real `process.stdout` is one no test and no smoke gate
 * can exercise.
 */
export interface StdoutStream {
  write(line: string): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

/**
 * The wire format, in one place: used for the log lines themselves and for the
 * sink-failure warn, which has to be written straight to stdout without
 * re-entering the logger.
 */
export function formatLogLine(entry: LogEntry): string {
  return `${JSON.stringify({
    timestamp: new Date().toISOString(),
    trace_id: entry.trace_id,
    stage: entry.stage,
    level: entry.level,
    message: entry.message,
    payload: entry.payload,
  })}\n`;
}

/** A degradation notice in the same wire format as everything else. */
function degradationLine(message: string, payload: Record<string, unknown>): string {
  return formatLogLine({
    trace_id: 'startup',
    stage: 'orchestrator',
    level: 'warn',
    message,
    payload,
  });
}

/** Reports a file-sink failure on the one stream that may still work. */
function warnOnStdout(message: string, stdout: StdoutStream = process.stdout): void {
  stdout.write(degradationLine(message, { log_file_sink: 'degraded' }));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class JsonLogger implements Logger {
  private fileSinkFailed = false;
  private stdoutDegraded = false;

  constructor(
    private readonly fileSink?: LogLineSink,
    private readonly stdout: StdoutStream = process.stdout,
  ) {}

  /**
   * Writes one line to every sink that still works.
   *
   * **The guarantee, stated exactly, because the comment this replaces was
   * wrong to state it flatly (#714): a logging call cannot throw while at
   * least one sink can still record — and deliberately DOES throw when none
   * can.** So a tick is safe from a full disk and safe from a closed terminal,
   * and is not protected from "no destination at all", because that is not a
   * logging failure worth surviving. Callers inside a `catch` still route
   * through `shared/safe-log.ts` — a `Logger` there is injected and may be
   * anything.
   */
  log(entry: LogEntry): void {
    const line = formatLogLine(entry);
    const reachedStdout = this.writeToStdout(line);
    const reachedFile = this.writeToFileSink(line);
    if (reachedStdout || reachedFile) return;

    // Nowhere left. Not swallowed — see the module doc: a run that cannot
    // record what it did with real money must stop, not continue blind.
    throw new Error(
      'structured logging reached no sink: stdout and the log file are both unavailable, and ' +
        'the failure could not be recorded anywhere. A trading process that cannot log must ' +
        'not keep trading (#714).',
    );
  }

  /**
   * Writes to stdout, degrading rather than throwing **when the degradation
   * can be recorded durably**.
   *
   * This catch covers a *synchronous* stdio failure only — stdout attached to
   * a file or a TTY, where `write` is synchronous (`EBADF`, `ENOSPC`). The
   * realistic soak failure, a broken pipe, does NOT arrive here: measured on
   * this deployment target (macOS, Node 24, `spawn(..., stdio: 'inherit')`
   * through a pipe), 31 writes into a destroyed pipe produced 22 `'error'`
   * events and **zero** synchronous throws. `watchStdoutErrors` is what covers
   * that half; both halves apply the identical rule.
   */
  private writeToStdout(line: string): boolean {
    if (this.stdoutDegraded) return false;
    try {
      this.stdout.write(line);
      return true;
    } catch (error) {
      // Rethrow when nothing durable can hold the report: `log` would
      // otherwise return having written nowhere and said nothing.
      if (!this.degradeStdout(error)) throw error;
      return false;
    }
  }

  /**
   * Retires stdout for the life of the process, recording *why* on the file
   * sink first. Returns whether that record is durable — the caller decides
   * what to do when it is not, because the two callers differ: the
   * synchronous path rethrows, the `'error'`-event path escalates to the
   * fault handler.
   *
   * Idempotent: one degradation record per process, not one per line. A dead
   * pipe emits an `'error'` for every subsequent write (22 of them in the
   * measurement above), which is exactly the shape that would otherwise fill
   * the durable log with copies of its own failure.
   */
  degradeStdout(error: unknown): boolean {
    if (this.stdoutDegraded) return true;
    const recorded = this.recordDurably(
      degradationLine(
        `structured log stdout sink failed and is retired for the rest of this process: ${describe(error)}. ` +
          'Logging continues to the log file only. A soak does not stop for this (#714), but ' +
          'the console half of the trace ends here.',
        { log_stdout_sink: 'degraded' },
      ),
    );
    if (!recorded) return false;
    this.stdoutDegraded = true;
    return true;
  }

  /** Whether stdout has been retired — the enforcement surface for #714. */
  get stdoutRetired(): boolean {
    return this.stdoutDegraded;
  }

  /**
   * Writes one line to the file sink, reporting a failure once on stdout and
   * then abandoning the sink. Returns whether the line is durably recorded.
   *
   * The warn goes straight to stdout — routing it through `this.log` would put
   * the failing sink back in the path of the message about it failing.
   */
  private writeToFileSink(line: string): boolean {
    return this.recordDurably(line, (message) => {
      try {
        warnOnStdout(message, this.stdout);
      } catch {
        // Reporting the file failure on stdout failed too — both destinations
        // are broken. Nothing is silently continued on that account: `log`
        // sees `false` from both writes and throws.
      }
    });
  }

  /**
   * The single "did this actually land somewhere that survives" primitive.
   *
   * `degraded` is consulted after the write, not just the throw: on the
   * shipped path `RotatingFileSink.write` never throws, so a sink that retired
   * on an earlier line would otherwise report every subsequent write as a
   * durable success — the exact "swallow and continue blind" this ticket
   * forbids.
   */
  private recordDurably(line: string, onFailure?: (message: string) => void): boolean {
    if (this.fileSink === undefined || this.fileSinkFailed) return false;
    try {
      this.fileSink.write(line);
    } catch (error) {
      this.fileSinkFailed = true;
      onFailure?.(
        'structured log file sink threw and is being ignored for the rest of this process: ' +
          `${describe(error)}. Logging continues on stdout only.`,
      );
      return false;
    }
    return this.fileSink.degraded !== true;
  }
}

/**
 * Subscribes to stdout's `'error'` event so an asynchronous write failure
 * degrades the logger instead of killing the run.
 *
 * **This is the half that matters for the soak, and it is not a stylistic
 * variant of the try/catch in `writeToStdout`.** `process.stdout` is
 * synchronous only for files and TTYs; for a *pipe* it is asynchronous, so an
 * EPIPE never reaches the write call at all. Measured on the deployment
 * target before this was written (macOS, Node 24, parent destroys the read end
 * of a `spawn`ed child's stdout — which is `yarn serve`'s own
 * `stdio: 'inherit'` shape, and a detached tmux session's):
 *
 * - with no `'error'` listener: the first write after the pipe died raised
 *   `uncaughtException: EPIPE` and the process was gone;
 * - with a listener: 22 `'error'` events, zero throws, exit 0.
 *
 * So a `try/catch` alone would have satisfied nothing: EPIPE would still have
 * reached `uncaughtException`, and the fault handler there exits by design.
 * The listener is what converts the known, narrow, recoverable fault into the
 * degrade path — *at the stream that produced it, identified by where it came
 * from rather than by pattern-matching an error code*. That is deliberately
 * where the line between "recoverable" and "unknown" is drawn; see
 * `installFaultHandlers` for why it is not drawn inside the process handler.
 */
export function watchStdoutErrors(logger: JsonLogger, stdout: StdoutStream = process.stdout): void {
  stdout.on('error', (error: Error) => {
    // A `false` return means the degradation could not be recorded anywhere,
    // so throwing is the only remaining way to say so: it reaches
    // `uncaughtException`, whose handler writes to stderr and exits 1. That is
    // the same escalation the synchronous path takes, and the only case in
    // which a logging fault is allowed to end the run.
    if (!logger.degradeStdout(error)) {
      throw new Error(
        `structured log stdout sink failed (${describe(error)}) and the failure could not be ` +
          'recorded on any other sink (#714).',
      );
    }
  });
}

/**
 * The logger the shipped entrypoint runs on: stdout plus a rotating file, with
 * the path and rotation policy read from `SAMURAI_LOG_FILE` /
 * `SAMURAI_LOG_MAX_BYTES` / `SAMURAI_LOG_MAX_FILES` (all optional, all
 * defaulted — see `rotating-file-sink.ts` for why a default is right here and
 * wrong for `SAMURAI_ALERTS`).
 *
 * Exported and given an injectable config rather than inlined into index.ts's
 * `import.meta.url` guard for the same reason `buildShutdownHandler` is: that
 * guard is unreachable from any unit test, so wiring left inside it is wiring
 * nothing verifies. The stdout `'error'` subscription is attached **here**,
 * and not by the constructor, for the same reason in the other direction: the
 * dozen `new JsonLogger()` call sites must not each subscribe to the real
 * process stream, and the deployment logger — the one whose file sink makes
 * degrading survivable at all — must.
 *
 * Throws only on malformed configuration, and only when it reads it. An
 * unwritable path is not a configuration error — it degrades to stdout with a
 * warn, and the returned logger works.
 */
export function buildEntrypointLogger(
  config?: FileSinkConfig,
  stdout: StdoutStream = process.stdout,
): JsonLogger {
  const sink = new RotatingFileSink({
    ...(config ?? fileSinkConfigFromEnvironment()),
    onFailure: (message) => {
      warnOnStdout(message, stdout);
    },
  });
  const logger = new JsonLogger(sink, stdout);
  watchStdoutErrors(logger, stdout);
  return logger;
}
