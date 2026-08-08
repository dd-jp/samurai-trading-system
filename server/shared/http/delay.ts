/**
 * One `delay`, instead of the three identical copies the code-quality audit
 * found (M4): `shared/http/retry.ts`, `shared/http/token-bucket.ts` and
 * `orchestrator/smoke-run.ts`.
 *
 * Deliberately un-cancellable and un-mocked: every caller is a backoff or a
 * pacing wait that vitest drives with fake timers, so an `AbortSignal`
 * parameter would be plumbing nothing currently asks for.
 */

/** Resolves after `ms` milliseconds. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
