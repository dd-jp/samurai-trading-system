/**
 * `input_digest`/`output_digest` for `AuditLogEntry` (#95) — see
 * docs/specs/orchestrator-spec.md (Module: Structured Logging & Audit Spine).
 *
 * A compact, stable fingerprint of a stage's input/output, not a reversible
 * serialization — the audit row records that a given input produced a given
 * output, not the full payload (that lives in the structured log line).
 */
import { createHash } from 'node:crypto';

/** Stable stringify: object keys sorted recursively so digests don't depend on key insertion order. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const entries = keys.map(
      (key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
    );
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function digest(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}
