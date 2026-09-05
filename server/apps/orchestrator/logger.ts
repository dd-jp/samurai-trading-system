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
 * surface carrying a stage's full payload — `audit_log` holds a cleartext
 * `decision` per stage, but its inputs and outputs are digests from which no
 * value can be reconstructed. Story 11's "stdout + rotated file" was
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
 *   did with real money, so `log` writes a last-resort notice on stderr and
 *   then throws.
 *
 * ### Where that throw actually lands, stated honestly (#714)
 *
 * It depends on which sink died first, and only one of the two orderings
 * reaches the composition root's fault handler:
 *
 * - **File first, then stdout.** The `'error'` listener in `watchStdoutErrors`
 *   finds nothing durable to record on and throws *from inside an event
 *   listener*, which is a genuine `uncaughtException`:
 *   `installFaultHandlers` records what it can and exits 1.
 * - **Stdout first, then the file.** Every later `log` reaches no sink and
 *   throws *from inside a tick*, where `tick-loop.ts` catches everything a
 *   tick throws and `shared/safe-log.ts` swallows a throwing logger by
 *   deliberate design (#573). The throw does **not** end the run.
 *
 * The second ordering is the likelier one for a soak (the terminal closes on
 * day three; the disk fills on day nine), so the throw alone would leave the
 * run trading with no trace anywhere — the outcome this whole decision exists
 * to prevent. Hence the stderr write, which is attempted *before* the throw
 * and is what actually holds the evidence: stderr is a genuinely separate
 * destination under `yarn orchestrator > log.txt`, under `| tee`, and under a
 * supervisor that splits the two streams.
 *
 * It is a last resort and not a third managed sink, and the run is **not**
 * declared healthy because stderr accepted the line: stderr most often shares
 * the very pipe or terminal that stdout just lost, so a write that "succeeded"
 * there is weak evidence of anything. `log` therefore still throws. Whether
 * that throw stops the process is the caller's decision — #573's swallow is
 * intentional and is not overridden from inside a logger.
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
import { redactPayload } from './redact-payload.js';
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
 * The last-resort stream, used only when neither sink can take a line.
 *
 * Deliberately narrower than `StdoutStream`: no `'error'` subscription, because
 * this is not a managed sink and nothing degrades on its behalf. Every write to
 * it is wrapped — see `lastResort`.
 */
export interface ErrorStream {
  write(line: string): unknown;
}

/**
 * Redacts a payload for the wire and returns it already serialized, and
 * CANNOT throw (#1035).
 *
 * The guard is not defensive habit — it is what keeps `redact-payload.ts` off
 * #714's critical path. `formatLogLine` is what `degradationLine` builds on,
 * and `degradationLine` runs when both sinks are gone, producing the string
 * that goes straight to stderr as the run's last trace. A throw from the
 * walker there would destroy that write and convert a logging degradation into
 * silence. So a redaction failure degrades the PAYLOAD and never the line.
 *
 * `JSON.stringify` runs inside the guard for the same reason it always did: a
 * payload that cannot be serialized at all (a cycle — an uncaught throw here
 * before this existed) must be discovered HERE, where it can be turned into
 * `{ redaction_failed: true }`, rather than from a second `JSON.stringify`
 * call the caller makes while it is partway through building the log line.
 *
 * Unlike before #1061, this serialization is not a discarded probe — it is
 * the payload's actual on-the-wire representation, which `formatLogLine`
 * splices in as raw JSON rather than handing the object back for the caller
 * to serialize a second time. A payload is therefore serialized exactly once
 * per log line, whether or not it turns out to be redactable at all.
 */
function redactedPayloadJson(payload: unknown): string | undefined {
  if (payload === undefined) return undefined;
  try {
    const redacted = redactPayload(payload);
    return JSON.stringify(redacted);
  } catch {
    return JSON.stringify({ redaction_failed: true });
  }
}

/**
 * The wire format, in one place: used for the log lines themselves and for the
 * sink-failure warn, which has to be written straight to stdout without
 * re-entering the logger.
 *
 * `payload` is redacted centrally here rather than at call sites (#1035).
 * Before this, `sanitizeLogText` was applied only where a caller remembered
 * to — ten sites out of every logging call in the system — so the guarantee
 * was "redacted where someone thought about it", which is not a guarantee.
 *
 * Built field-by-field rather than through one outer `JSON.stringify` call,
 * so `redactedPayloadJson`'s already-serialized string can be spliced in as
 * raw JSON instead of being handed back as an object and re-serialized here
 * (#1061). Every other field is a primitive, so serializing each
 * independently costs nothing extra; a key is omitted exactly where
 * `JSON.stringify` would have dropped it (an `undefined` value), so the
 * output is unchanged from before.
 */
export function formatLogLine(entry: LogEntry): string {
  const payloadJson = redactedPayloadJson(entry.payload);

  const segments: string[] = [];
  const field = (key: string, value: unknown): void => {
    if (value === undefined) return;
    segments.push(`${JSON.stringify(key)}:${JSON.stringify(value)}`);
  };

  field('timestamp', new Date().toISOString());
  field('trace_id', entry.trace_id);
  field('stage', entry.stage);
  field('level', entry.level);
  field('message', entry.message);
  if (payloadJson !== undefined) segments.push(`"payload":${payloadJson}`);
  field('started_at', entry.started_at);
  field('duration_ms', entry.duration_ms);

  return `{${segments.join(',')}}\n`;
}

/**
 * A degradation notice in the same wire format as everything else.
 *
 * Builds the line directly rather than through `formatLogLine`, so the
 * redaction walker is bypassed on this path entirely. Its payloads are in-repo
 * literals (`{ log_file_sink: 'degraded' }`) with no credential in them and
 * nothing to mask, and this is the path that runs when the sinks are failing —
 * the one place in the system where doing less work is the whole point.
 */
function degradationLine(message: string, payload: Record<string, unknown>): string {
  return `${JSON.stringify({
    timestamp: new Date().toISOString(),
    trace_id: 'startup',
    stage: 'orchestrator',
    level: 'warn',
    message,
    payload,
    started_at: undefined,
    duration_ms: undefined,
  })}\n`;
}

/** Reports a file-sink failure on the one stream that may still work. */
function warnOnStdout(message: string, stdout: StdoutStream = process.stdout): void {
  stdout.write(degradationLine(message, { log_file_sink: 'degraded' }));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether `debug` lines are written, read from `SAMURAI_LOG_LEVEL` (#1035).
 *
 * Exactly one threshold and exactly one filterable level, rather than the
 * usual ordered ladder. The reason is #714: `warn` and `error` carry the
 * sink-degradation notices, and the run's last trace before the logger throws
 * is a `warn`. A conventional `LOG_LEVEL=error` would suppress those, letting
 * an operator configure the process into the silence that rule exists to
 * forbid. So the setting answers one question — are debug lines on? — and
 * every other level is structurally unfilterable.
 *
 * Default `info`: `debug` is opt-in, because the lines it gates are the
 * verbose ones and a soak's default posture should not be the loud one.
 */
export function debugEnabledFromEnvironment(
  value: string | undefined = process.env.SAMURAI_LOG_LEVEL,
): boolean {
  return value?.trim().toLowerCase() === 'debug';
}

export class JsonLogger implements Logger {
  private fileSinkFailed = false;
  private stdoutDegraded = false;
  private noSinkReported = false;

  constructor(
    private readonly fileSink?: LogLineSink,
    private readonly stdout: StdoutStream = process.stdout,
    private readonly stderr: ErrorStream = process.stderr,
    /**
     * Whether `debug` entries are written. Constructor argument rather than an
     * environment read inside the class, for the reason
     * `buildEntrypointLogger` gives about the file sink: the deployment
     * decision belongs on the entrypoint's path, and the dozen `new
     * JsonLogger()` call sites in tests must not each inherit an ambient one.
     */
    private readonly debugEnabled = false,
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
   *
   * **And the throw is not assumed to be fatal.** On the stdout-first ordering
   * it is raised inside a tick, where #573's `safeLog` swallows it on purpose;
   * that is why the line and the notice go to stderr *first*. See the module
   * doc's "where that throw actually lands".
   */
  log(entry: LogEntry): void {
    // BEFORE the sinks, and this ordering is load-bearing rather than an
    // efficiency: a suppressed line that fell through to the write path would
    // reach `if (reachedStdout || reachedFile)` with neither true and throw
    // the no-sink error — turning a verbosity SETTING into a fabricated #714
    // fault on a perfectly healthy run. A dropped debug line is not a logging
    // failure, so it must never be able to reach that branch.
    if (entry.level === 'debug' && !this.debugEnabled) return;

    const line = formatLogLine(entry);
    const reachedStdout = this.writeToStdout(line);
    const reachedFile = this.writeToFileSink(line);
    if (reachedStdout || reachedFile) return;

    // Nowhere left. Not swallowed — see the module doc: a run that cannot
    // record what it did with real money must not carry on unremarked.
    this.reportNoSink();
    this.lastResort(line);
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
      // otherwise return having written nowhere and said nothing. Same
      // last-resort trace as `log`'s own escalation, for the same reason — a
      // caller that swallows this throw must still leave the operator
      // something.
      if (!this.degradeStdout(error)) {
        this.reportNoSink();
        this.lastResort(line);
        throw error;
      }
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

  /**
   * Says once, on stderr, that structured logging has run out of sinks.
   *
   * Once per process and not once per line: the condition is permanent, and a
   * per-line copy would bury the lines themselves — which are the point, and
   * which follow it.
   */
  private reportNoSink(): void {
    if (this.noSinkReported) return;
    this.noSinkReported = true;
    this.lastResort(
      degradationLine(
        'structured logging has no sink left: stdout is unavailable and the log file is not ' +
          'recording. Subsequent log lines are written here, on stderr, and are the only trace ' +
          'this run still produces (#714).',
        { log_stdout_sink: 'degraded', log_file_sink: 'degraded' },
      ),
    );
  }

  /**
   * Writes to stderr, ignoring any failure.
   *
   * The swallow is correct exactly here and nowhere else: this is already the
   * both-sinks-gone path, the caller throws immediately afterwards regardless,
   * and stderr on a host whose stdout just died is a coin toss. A last resort
   * that can itself throw is not a last resort —
   * `tools/backfill-market-data.ts` guards its `console.error` for the same
   * reason.
   */
  private lastResort(line: string): void {
    try {
      this.stderr.write(line);
    } catch {
      // Nothing left to try, and nothing to report it on.
    }
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
  stderr: ErrorStream = process.stderr,
): JsonLogger {
  const sink = new RotatingFileSink({
    ...(config ?? fileSinkConfigFromEnvironment()),
    onFailure: (message) => {
      warnOnStdout(message, stdout);
    },
  });
  const logger = new JsonLogger(sink, stdout, stderr, debugEnabledFromEnvironment());
  watchStdoutErrors(logger, stdout);
  return logger;
}
