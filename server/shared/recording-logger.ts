import type { LogEntry, Logger } from './types.js';

export function recordingLogger(): Logger & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return {
    entries,
    log(entry: LogEntry): void {
      entries.push(entry);
    },
  };
}
