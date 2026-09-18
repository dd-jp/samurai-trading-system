import { sanitizeLogText } from './sanitize-log-text.js';
import type { LogEntry, LogEntryTemplate, Logger } from './types.js';

export function describeThrown(error: unknown): string {
  const value = error instanceof Error ? error.message : error;
  if (typeof value === 'string') return value;
  try {
    const rendered = JSON.stringify(value);
    if (typeof rendered === 'string') return rendered;
  } catch {
  }
  return String(value);
}

export function describeThrownSafely(error: unknown): string {
  try {
    return describeThrown(error);
  } catch {
    return '[unrenderable error]';
  }
}

export function safeLog(logger: Logger, entry: LogEntry): void {
  try {
    logger.log(entry);
  } catch {
  }
}

export type CaughtFailureLogTemplate = LogEntryTemplate;

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
