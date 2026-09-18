import type { LogEntry, LogEventCode } from '../../shared/index.js';
import { maskCredentials } from '../../shared/index.js';
import { redactPayload } from './redact-payload.js';
import {
  type FileSinkConfig,
  fileSinkConfigFromEnvironment,
  RotatingFileSink,
} from './rotating-file-sink.js';
import type { Logger } from './types.js';

export interface LogLineSink {
  write(line: string): void;
  readonly degraded?: boolean;
}

export interface StdoutStream {
  write(line: string): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export interface ErrorStream {
  write(line: string): unknown;
}

function redactedPayloadJson(payload: unknown): string | undefined {
  if (payload === undefined) return undefined;
  try {
    const redacted = redactPayload(payload);
    return JSON.stringify(redacted);
  } catch {
    return JSON.stringify({ redaction_failed: true });
  }
}

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

function warnOnStdout(message: string, stdout: StdoutStream = process.stdout): void {
  stdout.write(degradationLine('log_file_sink_degraded', message, { log_file_sink: 'degraded' }));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
    private readonly debugEnabled = false,
  ) {}

  log(entry: LogEntry): void {
    if (entry.level === 'debug' && !this.debugEnabled) return;

    const line = formatLogLine(entry);
    const reachedStdout = this.writeToStdout(line);
    const reachedFile = this.writeToFileSink(line);
    if (reachedStdout || reachedFile) return;

    this.reportNoSink();
    this.lastResort(line);
    throw new Error(
      'structured logging reached no sink: stdout and the log file are both unavailable, and ' +
        'the failure could not be recorded anywhere. A trading process that cannot log must ' +
        'not keep trading (#714).',
    );
  }

  private writeToStdout(line: string): boolean {
    if (this.stdoutDegraded) return false;
    try {
      this.stdout.write(line);
      return true;
    } catch (error) {
      if (!this.degradeStdout(error)) {
        this.reportNoSink();
        this.lastResort(line);
        throw error;
      }
      return false;
    }
  }

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

  private lastResort(line: string): void {
    try {
      this.stderr.write(line);
    } catch {
    }
  }

  get stdoutRetired(): boolean {
    return this.stdoutDegraded;
  }

  private writeToFileSink(line: string): boolean {
    return this.recordDurably(line, (message) => {
      try {
        warnOnStdout(message, this.stdout);
      } catch {
      }
    });
  }

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

export function watchStdoutErrors(logger: JsonLogger, stdout: StdoutStream = process.stdout): void {
  stdout.on('error', (error: Error) => {
    if (!logger.degradeStdout(error)) {
      throw new Error(
        `structured log stdout sink failed (${describe(error)}) and the failure could not be ` +
          'recorded on any other sink (#714).',
      );
    }
  });
}

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
