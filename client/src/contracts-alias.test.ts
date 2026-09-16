/**
 * The `@contracts` alias, exercised as a VALUE import.
 *
 * Every other `@contracts` import in this app is `import type`. That is
 * correct — the client consumes wire shapes, not wire code — but it means the
 * alias is erased before any bundler or test runner ever resolves it. The
 * alias is declared in three places that must agree (`client/vite.config.ts`,
 * `client/tsconfig.json`'s `paths`, and `vitest.config.ts`), and with only
 * type-only imports the first and third are never exercised at all: a wrong
 * or missing entry in either one type-checks green and ships.
 *
 * This test is the one value import in the app, and it exists solely to make
 * that seam fail loudly. `PIPELINE_STAGES` and `STORE_MODES` are const arrays
 * — real emitted values — so resolving them proves the runtime alias resolves,
 * not merely that the compiler's `paths` entry does.
 */

import { PIPELINE_STAGES, STORE_MODES } from '@contracts';
import { expect, it } from 'vitest';

it('resolves a value import through the @contracts alias', () => {
  // Asserting on content rather than mere truthiness: an alias pointed at the
  // wrong module could still yield *something* importable
  expect(PIPELINE_STAGES).toContain('analysts');
  expect(PIPELINE_STAGES).toContain('execution');
  expect(STORE_MODES).toContain('paper');
});
