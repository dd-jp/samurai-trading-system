# Coding Standards — Samurai

Read on every session before writing/editing code. Supplements CLAUDE.md; does not replace it.

## TypeScript

- **Barrel re-export types at module boundary.** Each module's public entry file (e.g. `critic-store.ts`) should `export type { ... } from './types.js'` for the types it exposes, even though `types.ts` already exports them directly. Consumers import from the module's own entry point, not by reaching into its internal `types.ts`. Do not remove a re-export just because no current importer uses it — it's the module's public surface, and removing it risks forcing future imports to reach past the boundary, which is how circular imports creep in.
- **`import type` / `export type` split.** Use `import type { X } from './types.js'` for local use (implements/params/fields). Use a separate `export type { X } from './types.js'` line to re-export for consumers. Keep them as two distinct statements, not combined — makes local-use vs re-export intent explicit at a glance.
- Module internals (`types.ts`, helpers) are implementation detail. Nothing outside the module should import directly from another module's `types.ts` — go through its entry file.

## Verification before removing "unused" code

- No-importers-found via grep is not sufficient justification to delete a re-export or public surface. Check the module's role (entry point vs internal) first. Ask before removing anything that looks like a deliberate boundary/barrel export.

## When in doubt

Grep for existing patterns in sibling modules before introducing a new one. Match the file's existing style over a "better" abstraction.
