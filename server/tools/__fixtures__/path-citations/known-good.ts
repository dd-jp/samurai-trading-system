/**
 * Every citation in this file must pass. It is scanned only by
 * `check-path-citations.test.ts`, never by the repo-wide run — the walker skips
 * `__fixtures__` on purpose.
 */

// A resolving directory: `server/tools/`.

// A resolving file: `server/tools/check-path-citations.ts`.

// A resolving file with a line number well inside the file: `server/tools/check-path-citations.ts:1`.

// A foreign-repo citation, marked: pybroker's `src/eval.py` is another repository's tree. <!-- cite-exempt: foreign — pybroker's tree, mined not depended on -->

// A deliberately historical citation, marked: `src/cli/` was removed when the dashboard landed. <!-- cite-exempt: historical — statement about a removed tree -->

// A not-yet-built citation, marked: `server/pipeline/invalidation/skeptic-prompt.ts` is proposed. <!-- cite-exempt: planned — specced, not built -->

// An untracked artifact, marked: `docs/research/data/bars/` is gitignored. <!-- cite-exempt: untracked — gitignored cache, must not be in the tree -->

// Not citations, and so never checked: `application/json`, `req/min`, `src/`,
// `docs/specs/<stage>-spec.md`, `server/**/*.test.ts`, `https://example.com/a/b`,
// `./relative/thing.ts`, `server/tools/check-path-citations.ts:1-40`,
// `nosuchroot/nosuchfile.ts`.

// A backtick inside a string is not a citation — the whole thing is inert here.
export const inertString =
  '`server/pipeline/does-not-exist.ts` sits inside a string, not a comment';

// A template literal is inert the same way, string content is never scanned.
export const inertTemplate = `server/pipeline/also-does-not-exist.ts`;

/** A block comment carries a resolving citation too: `server/tools/check-path-citations.ts`. */
