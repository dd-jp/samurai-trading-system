# Coding Standards — Samurai

Read on every session before writing/editing code. Supplements CLAUDE.md; does not replace it.

## TypeScript: single source of export

- **One file owns each exported symbol.** A type, function, variable, or class is exported from exactly one file — the file that declares it. Do not `export type { X } from './types.js'` (or the value form) in a file that also does `import type { X } from './types.js'` — that's the same symbol both entering and leaving the file, which just adds an alternate import path for consumers with no benefit and a real cost: it's another route to the same code, and if the origin ever changes shape, the re-export is a second thing to keep in sync (a source of circular-import risk, not a guard against it).
- **Consumers import from the origin file, not through a re-export.** If `debate-engine/types.ts` declares `AnalystView`, everything outside `debate-engine` imports it from there — not from a downstream module that happens to import it too.
- **Module barrels (`index.ts`) are still fine for symbols the module itself declares.** `index.ts` aggregating a module's own `./foo.js`, `./bar.js` exports into one public entry point is a normal barrel, not a duplicate-export violation — nothing in the module both imports and re-exports the same symbol from the same file. The violation is specifically: file A imports X from file B, and file A also re-exports X from file B.

## Verification before removing an export

- Before deleting an `export`/`export type` line, grep the whole codebase for consumers importing that path. If none exist outside the file's own module, it's dead — remove it. If consumers exist, repoint them at the true origin file rather than leaving the re-export in place.
- After any export/import change, run `npx tsc --noEmit` — a removed re-export fails at compile time, not at runtime, so tsc is the check that actually catches it. Run the test suite too.

## When in doubt

Grep for existing patterns in sibling modules before introducing a new one. Match the file's existing style over a "better" abstraction.
