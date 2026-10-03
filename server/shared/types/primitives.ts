export type { AssetClass } from '../../../contracts/index.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogEventCode = string;

interface LogEntryFields {
  trace_id: string;
  stage: string;
  message: string;
  payload?: unknown;
  started_at?: string;
  duration_ms?: number;
}

export type LogEntry = LogEntryFields &
  ({ level: 'debug' | 'info'; event?: LogEventCode } | { level: LogLevel; event: LogEventCode });

export type LogEntryTemplate<Deferred extends keyof LogEntryFields = 'payload'> =
  LogEntry extends infer Arm ? (Arm extends LogEntry ? Omit<Arm, Deferred> : never) : never;

export interface Logger {
  log(entry: LogEntry): void;
}
