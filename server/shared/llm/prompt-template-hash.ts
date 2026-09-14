/**
 * Prompt-template version hashing (#1514).
 *
 * A stage's PROMPT TEMPLATE — the static instructional text a persona or
 * critic sends on every call, as distinct from the per-request dynamic block
 * (analyst views, book context) folded in beside it — has no version
 * identifier anywhere in the system. `llm_spend` already logs `model` for
 * every metered call; this hashes the template each call site sends and
 * attaches it alongside `model` via `LlmAttribution`, so a later edit to a
 * template is visible in the log the same way a model swap already is.
 *
 * SHA-256 over the exact template text, hex-encoded — collision-proof enough
 * for a diagnostic join key, and matches every other content hash in this
 * codebase.
 */
import { createHash } from 'node:crypto';

export function hashPromptTemplate(template: string): string {
  return createHash('sha256').update(template, 'utf8').digest('hex');
}
