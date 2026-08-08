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
 * A sink that fails is logged about, once, on stdout, and then ignored: a
 * logging call sits inside every tick, and a full disk must not end the run.
 */
import type { LogEntry } from '../../shared/index.js';
import {
  type FileSinkConfig,
  fileSinkConfigFromEnvironment,
  RotatingFileSink,
} from './rotating-file-sink.js';
import type { Logger } from './types.js';

/** The byte sink a `JsonLogger` writes formatted lines to. */
export interface LogLineSink {
  write(line: string): void;
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

/** Reports a sink failure on the one stream known to still work. */
function warnOnStdout(message: string): void {
  process.stdout.write(
    formatLogLine({
      trace_id: 'startup',
      stage: 'orchestrator',
      level: 'warn',
      message,
      payload: { log_file_sink: 'degraded' },
    }),
  );
}

export class JsonLogger implements Logger {
  private sinkFailureReported = false;

  constructor(private readonly fileSink?: LogLineSink) {}

  log(entry: LogEntry): void {
    const line = formatLogLine(entry);
    process.stdout.write(line);
    this.writeToFileSink(line);
  }

  /**
   * A defensive backstop for a *foreign* sink, with no caller on the shipped
   * path — say so plainly, because there are otherwise two "report once"
   * flags in this feature and a reader has to know which one runs.
   *
   * `RotatingFileSink.write` cannot reach this catch: it wraps everything in
   * `attempt`, which owns the real degrade (set `failed`, report once through
   * `onFailure`, no-op thereafter). So on `buildEntrypointLogger`'s path
   * `sinkFailureReported` never flips. It exists for a `LogLineSink` someone
   * else injects, costs one try block per line, and keeps the guarantee a
   * property of `JsonLogger` rather than of one particular sink — the
   * requirement is that a logging call inside a tick never throws, whoever
   * wrote the sink.
   *
   * The warn goes straight to stdout — routing it through `this.log` would put
   * the failing sink back in the path of the message about it failing.
   */
  private writeToFileSink(line: string): void {
    if (this.fileSink === undefined) return;
    try {
      this.fileSink.write(line);
    } catch (error) {
      if (this.sinkFailureReported) return;
      this.sinkFailureReported = true;
      try {
        warnOnStdout(
          'structured log file sink threw and is being ignored for the rest of this process: ' +
            `${error instanceof Error ? error.message : String(error)}. Logging continues on ` +
            'stdout only.',
        );
      } catch {
        // Reporting the sink failure failed too — `process.stdout.write` throws
        // EPIPE once the far end of the pipe is gone. Raised in review on #349
        // against `RotatingFileSink`; the same hole existed here. With both
        // destinations broken there is nowhere left to escalate, and losing the
        // message is strictly better than throwing into a tick.
        //
        // Note the deliberate asymmetry with `log`'s own unguarded
        // `process.stdout.write` above: a *sink* failure must never propagate,
        // which is this ticket's requirement, but stdout failing on the primary
        // write is #95's behaviour and the posture the rest of the composition
        // root already takes (`buildShutdownHandler` writes to stderr
        // unguarded). Changing that is a separate decision, not a side effect
        // of adding a file sink.
      }
    }
  }
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
 * nothing verifies.
 *
 * Throws only on malformed configuration, and only when it reads it. An
 * unwritable path is not a configuration error — it degrades to stdout with a
 * warn, and the returned logger works.
 */
export function buildEntrypointLogger(config?: FileSinkConfig): JsonLogger {
  const sink = new RotatingFileSink({
    ...(config ?? fileSinkConfigFromEnvironment()),
    onFailure: warnOnStdout,
  });
  return new JsonLogger(sink);
}
