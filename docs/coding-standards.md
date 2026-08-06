# Coding Standards — Samurai

Read on every session before writing/editing code. Supplements CLAUDE.md; does not replace it.

## TypeScript: single source of declaration, barrel-only cross-module imports

- **One file declares each symbol.** A type, function, variable, or class is declared in exactly one file — its origin (e.g. `RiskConfig` is declared in `risk-manager/types.ts`, nowhere else).
- **Cross-module imports go through the target module's barrel, never its internal files.** A file in one top-level `src/` module importing something from a *different* module must import from that module's `index.ts` — `from '../risk-manager/index.js'`, never `from '../risk-manager/types.js'`. This holds even for `shared/`: cross-module consumers import `from '../shared/index.js'` (or `'../shared/store/index.js'` for the persistence helpers, which has its own barrel), never `shared/clock.js` / `shared/types.js` directly. Imports within the same module (a file importing a sibling in the same folder) are internal structure, not a barrel violation, and should import the origin file directly rather than round-tripping through the module's own `index.ts`.
- **A barrel importing-and-exporting the same symbol from the same file is expected, not a duplicate.** When `index.ts` needs a symbol for its own local implementation *and* that symbol has real external consumers, it will legitimately have both `import { X } from './x.js'` (for local use) and `export { X } from './x.js'` (for the module's public surface) — e.g. `risk-manager/index.ts` imports `countryForInstrument` from `./cii-mapping.js` for its own `ciiWarnings()` helper, and separately re-exports it because `orchestrator/production/direct-bind.ts` needs it too. That's different from the anti-pattern below: the re-export here has a real consumer and is the module's only public surface for that symbol.
- **Don't add an import+re-export pair with no consumer.** Outside of a module's `index.ts` barrel, a file that both `import`s a symbol from a path and separately `export`s that same symbol from the same path is dead weight — it's an alternate route to the same code that nothing uses, and a second place to keep in sync if the origin changes shape. Before adding one, grep for a consumer of that exact re-export path; if none exists, don't add it. Before deleting one, grep the same way — if a consumer exists, repoint it at the true barrel first.

### NodeNext resolution nuances

- **`.js` extensions in relative imports are mandatory, not stylistic.** `tsconfig.build.json` sets `"module"`/`"moduleResolution": "NodeNext"`, and `package.json` has `"type": "module"` — Node's native ESM resolver is in play, and it needs the extension exactly as it will exist in the emitted output (`.js`, even though the source is `.ts`). Dropping it breaks the build.
- **A barrel import still needs the explicit `/index.js`.** NodeNext does not auto-resolve a bare directory specifier the way CommonJS did — `from '../market-data-service/'` does not resolve; it must be `from '../market-data-service/index.js'`.

## Vitest: test utilities are global — don't import them

`globals: true` is set in `vitest.config.ts`, so `describe`, `it`, `expect`, `vi`, `beforeEach`/`afterEach`/`beforeAll`/`afterAll`, and `expectTypeOf` are ambient in every `*.test.ts` file. Don't add `import { describe, it, expect, ... } from 'vitest'` for these — they're already in scope.

## Verification before removing or adding an export

- Before deleting an `export`/`export type` line, grep the whole codebase for consumers importing that path. If none exist outside the file's own module, it's dead — remove it. If consumers exist, repoint them at the module's barrel rather than leaving a stray re-export in place.
- After any export/import change, run `npx tsc --noEmit` — a removed or misrouted export fails at compile time, not at runtime, so tsc is the check that actually catches it. Run the test suite too (`npm test`).

## Wiring a mechanism means adding its enforcement assertion to `yarn smoke` (#430)

This repo's dominant defect class is **a complete, tested mechanism with no production caller**. It has recurred at least nine times — #327, #364, #366, #371, #374, #379, #388, #432, #433 — and per-ticket fixes have not stopped it, because every instance is individually correct code. The gap is always at the composition root, and unit tests cannot see it by construction: all 1,800+ passed throughout each one.

So the rule is structural rather than a reminder to be careful:

- **When you wire a new mechanism into `buildProductionComponents`, add an assertion for it to `evaluateSmokeGate`** (`src/orchestrator/smoke-run.ts`). `yarn smoke` drives the real composition root, and it is the only automated check that has ever caught this class.
- **Aim the assertion at the ENFORCEMENT, not the construction.** Assert the mechanism's own durable effect — a row only it writes, a counter only it increments. A check on "was it constructed" passes for a component nothing calls, which is the defect itself.
- **Prove the assertion can fail.** Delete the effect from an otherwise-healthy observation set and confirm the gate goes red. PR #390 shipped three checks in one branch that all read as correct and enforced nothing (a config never read, a gate assertion made vacuous by a dropped argument, and `windowMs: 0` at which the limiter enforced nothing) — none was caught by review, all three by mutation.
- **Prefer a required argument to an optional one.** `evaluateSmokeGate`'s `llmRateLimiterSnapshot` is required precisely because, while optional, deleting the one line that passed it left the check vacuously true and the whole suite green.

## When in doubt

Grep for existing patterns in sibling modules before introducing a new one. Match the file's existing style over a "better" abstraction.
