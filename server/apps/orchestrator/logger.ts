/**
 * JSON-line logger: writes to stdout and an optional durable file sink.
 *
 * Sink failure (#714): a failing sink reports on the other sink then is
 * abandoned; when neither sink can take a line, `log` writes stderr and throws.
 */
import type { LogEntry, LogEventCode } from '../../shared/index.js';
import { maskCredentials } from '../../shared/index.js';
import { redactPayload } from './redact-payload.js';
import {
  type FileSinkConfig,
  fileSinkConfigFromEnvironment,
  RotatingFileSink,
} from './rotating-file-sink.js';
import type { Logger } from './types.js';

/**
 * Byte sink a `JsonLogger` writes formatted lines to. `degraded` matters: a
 * successful `write()` doesn't prove durability once a sink has retired.
 */
export interface LogLineSink {
  write(line: string): void;
  /** True once this sink has retired and its `write` is a silent no-op */
  readonly degraded?: boolean;
}

/**
 * Parts of `process.stdout` this module uses. Injectable so
 * `watchStdoutErrors`'s `'error'` subscription is testable without the real stream.
 */
export interface StdoutStream {
  write(line: string): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

/** Last-resort stream, used only when neither sink can take a line. */
export interface ErrorStream {
  write(line: string): unknown;
}

/**
 * Redacts a payload and serializes it; cannot throw (#1035) — a redaction
 * failure degrades to `{ redaction_failed: true }` instead of destroying the
 * last-resort write on `log`'s no-sink path.
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
 * Wire format for a log line, also used for the sink-failure warn line.
 *
 * `payload` is redacted centrally (#1035) and `message` is masked (#1133) here
 * rather than at call sites. Built field-by-field so `redactedPayloadJson`'s
 * already-serialized string can be spliced in raw instead of re-serialized (#1061).
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
  field('event', entry.event);
  field('level', entry.level);
  field('message', maskCredentials(entry.message));
  if (payloadJson !== undefined) segments.push(`"payload":${payloadJson}`);
  field('started_at', entry.started_at);
  field('duration_ms', entry.duration_ms);

  return `{${segments.join(',')}}\n`;
}

/**
 * A degradation notice in the same wire format as `formatLogLine`, built
 * directly so the redaction walker is bypassed on this failure path.
 */
function degradationLine(
  event: LogEventCode,
  message: string,
  payload: Record<string, unknown>,
): string {
  return `${JSON.stringify({
    timestamp: new Date().toISOString(),
    trace_id: 'startup',
    stage: 'orchestrator',
    event,
    level: 'warn',
    message,
    payload,
    started_at: undefined,
    duration_ms: undefined,
  })}\n`;
}

/** Reports a file-sink failure on the one stream that may still work */
function warnOnStdout(message: string, stdout: StdoutStream = process.stdout): void {
  stdout.write(degradationLine('log_file_sink_degraded', message, { log_file_sink: 'degraded' }));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether `debug` lines are written (`SAMURAI_LOG_LEVEL`, default `info`).
 *
 * Only `debug` is filterable — not a full level ladder — because `warn`/`error`
 * carry the #714 sink-degradation notices that must never be suppressible.
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
     * Constructor argument, not an environment read, so the dozen `new
     * JsonLogger()` test call sites don't inherit an ambient setting.
     */
    private readonly debugEnabled = false,
  ) {}

  /**
   * Writes one line to every sink that still works; throws only when none can
   * record it (#714). The throw is not assumed fatal — see `watchStdoutErrors`.
   */
  log(entry: LogEntry): void {
    // Checked before the sinks: a suppressed debug line must not fall through
    // to the no-sink throw below on an otherwise healthy run.
    if (entry.level === 'debug' && !this.debugEnabled) return;

    const line = formatLogLine(entry);
    const reachedStdout = this.writeToStdout(line);
    const reachedFile = this.writeToFileSink(line);
    if (reachedStdout || reachedFile) return;

    // Not swallowed: a run that can't record what it did with real money
    // must not carry on unremarked (#714).
    this.reportNoSink();
    this.lastResort(line);
    throw new Error(
      'structured logging reached no sink: stdout and the log file are both unavailable, and ' +
        'the failure could not be recorded anywhere. A trading process that cannot log must ' +
        'not keep trading (#714).',
    );
  }

  /**
   * Writes to stdout, degrading rather than throwing when the degradation can
   * be recorded durably. Covers only synchronous stdio failure; a broken pipe
   * is async and is handled by `watchStdoutErrors` instead (measured: zero
   * synchronous throws on a destroyed pipe).
   */
  private writeToStdout(line: string): boolean {
    if (this.stdoutDegraded) return false;
    try {
      this.stdout.write(line);
      return true;
    } catch (error) {
      // Rethrow when nothing durable can hold the report — same last-resort
      // trace as `log`'s own escalation.
      if (!this.degradeStdout(error)) {
        this.reportNoSink();
        this.lastResort(line);
        throw error;
      }
      return false;
    }
  }

  /**
   * Retires stdout for the process, recording why on the file sink first.
   * Returns whether that record is durable. Idempotent: a dead pipe emits an
   * `'error'` per write, and only the first should produce a record.
   */
  degradeStdout(error: unknown): boolean {
    if (this.stdoutDegraded) return true;
    const recorded = this.recordDurably(
      degradationLine(
        'log_stdout_sink_degraded',
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

  /** Reports sink exhaustion on stderr once per process, not once per line. */
  private reportNoSink(): void {
    if (this.noSinkReported) return;
    this.noSinkReported = true;
    this.lastResort(
      degradationLine(
        'log_sinks_exhausted',
        'structured logging has no sink left: stdout is unavailable and the log file is not ' +
          'recording. Subsequent log lines are written here, on stderr, and are the only trace ' +
          'this run still produces (#714).',
        { log_stdout_sink: 'degraded', log_file_sink: 'degraded' },
      ),
    );
  }

  /**
   * Writes to stderr, ignoring any failure — this is already the
   * both-sinks-gone path and the caller throws regardless.
   */
  private lastResort(line: string): void {
    try {
      this.stderr.write(line);
    } catch {
      /* nothing left to try */
    }
  }

  /** Whether stdout has been retired (#714). */
  get stdoutRetired(): boolean {
    return this.stdoutDegraded;
  }

  /**
   * Writes one line to the file sink, reporting failure once on stdout, then
   * abandoning the sink. The warn bypasses `this.log` to avoid re-entering the
   * failing sink's path.
   */
  private writeToFileSink(line: string): boolean {
    return this.recordDurably(line, (message) => {
      try {
        warnOnStdout(message, this.stdout);
      } catch {
        // both destinations are broken; `log` sees `false` from both writes and throws
      }
    });
  }

  /**
   * The single "did this land somewhere durable" check. `degraded` is checked
   * after a successful write too, since `RotatingFileSink.write` never throws
   * once retired — it would otherwise report every later write as durable.
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
 * Subscribes to stdout's `'error'` event so an async write failure (a broken
 * pipe, which never reaches `writeToStdout`'s synchronous catch) degrades the
 * logger instead of raising an uncaught EPIPE.
 */
export function watchStdoutErrors(logger: JsonLogger, stdout: StdoutStream = process.stdout): void {
  stdout.on('error', (error: Error) => {
    // No durable sink left to record on: throw so it reaches
    // `uncaughtException`, the only case a logging fault may end the run.
    if (!logger.degradeStdout(error)) {
      throw new Error(
        `structured log stdout sink failed (${describe(error)}) and the failure could not be ` +
          'recorded on any other sink (#714).',
      );
    }
  });
}

/**
 * The logger the shipped entrypoint runs on: stdout plus a rotating file
 * (`SAMURAI_LOG_FILE`/`SAMURAI_LOG_MAX_BYTES`/`SAMURAI_LOG_MAX_FILES`).
 *
 * The stdout `'error'` subscription is attached here, not in the constructor,
 * so the dozen test call sites for `new JsonLogger()` don't subscribe to the
 * real process stream.
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
