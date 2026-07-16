/**
 * `Logger` (#95) — see docs/specs/orchestrator-spec.md (Module: Structured
 * Logging & Audit Spine).
 *
 * One JSON line per call: timestamp, trace_id, stage, level, message, payload
 * (orchestrator-spec.md story 10). Sink is stdout only — the spec's
 * "stdout + rotated file" sink configuration has no file-rotation dependency
 * in the codebase yet and is not required by #95's acceptance criteria;
 * deferred rather than invented here.
 */
import type { Logger } from './types.js';

export class JsonLogger implements Logger {
  log(entry: {
    trace_id: string;
    stage: string;
    level: 'info' | 'warn' | 'error';
    message: string;
    payload?: unknown;
  }): void {
    process.stdout.write(
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        trace_id: entry.trace_id,
        stage: entry.stage,
        level: entry.level,
        message: entry.message,
        payload: entry.payload,
      })}\n`,
    );
  }
}
