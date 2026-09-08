# Coding Standards — Samurai

Read on every session before writing/editing code. Supplements CLAUDE.md; does not replace it.

## TypeScript: single source of declaration, barrel-only cross-module imports

- **One file declares each symbol.** A type, function, variable, or class is declared in exactly one file — its origin (e.g. `RiskConfig` is declared in `risk-manager/types.ts`, nowhere else).
- **Cross-module imports go through the target module's barrel, never its internal files.** A file in one top-level `server/` module importing something from a *different* module must import from that module's `index.ts` — `from '../risk-manager/index.js'`, never `from '../risk-manager/types.js'`. This holds even for `shared/`: cross-module consumers import `from '../shared/index.js'` (or `'../shared/store/index.js'` for the persistence helpers, which has its own barrel), never `shared/clock.js` / `shared/types.js` directly. Imports within the same module (a file importing a sibling in the same folder) are internal structure, not a barrel violation, and should import the origin file directly rather than round-tripping through the module's own `index.ts`.
- **A barrel importing-and-exporting the same symbol from the same file is expected, not a duplicate.** When `index.ts` needs a symbol for its own local implementation *and* that symbol has real external consumers, it will legitimately have both `import { X } from './x.js'` (for local use) and `export { X } from './x.js'` (for the module's public surface) — e.g. `risk-manager/index.ts` imports `countryForInstrument` from `./cii-mapping.js` for its own `ciiWarnings()` helper, and separately re-exports it because `orchestrator/production/direct-bind.ts` needs it too. That's different from the anti-pattern below: the re-export here has a real consumer and is the module's only public surface for that symbol.
- **Don't add an import+re-export pair with no consumer.** Outside of a module's `index.ts` barrel, a file that both `import`s a symbol from a path and separately `export`s that same symbol from the same path is dead weight — it's an alternate route to the same code that nothing uses, and a second place to keep in sync if the origin changes shape. Before adding one, grep for a consumer of that exact re-export path; if none exists, don't add it. Before deleting one, grep the same way — if a consumer exists, repoint it at the true barrel first.

### NodeNext resolution nuances

- **`.js` extensions in relative imports are mandatory, not stylistic.** `tsconfig.build.json` sets `"module"`/`"moduleResolution": "NodeNext"`, and `package.json` has `"type": "module"` — Node's native ESM resolver is in play, and it needs the extension exactly as it will exist in the emitted output (`.js`, even though the source is `.ts`). Dropping it breaks the build.
- **A barrel import still needs the explicit `/index.js`.** NodeNext does not auto-resolve a bare directory specifier the way CommonJS did — `from '../market-data-service/'` does not resolve; it must be `from '../market-data-service/index.js'`.

## Vitest: test utilities are global in `server/` and `contracts/` — don't import them there

`globals: true` is set in `vitest.config.ts`, and `tsconfig.test.json`'s `types` includes `vitest/globals`, so `describe`, `it`, `expect`, `vi`, `beforeEach`/`afterEach`/`beforeAll`/`afterAll`, and `expectTypeOf` are ambient — under `tsc` as well as at runtime — in every `server/**/*.test.ts` and `contracts/**/*.test.ts` file. Don't add `import { describe, it, expect, ... } from 'vitest'` for these — they're already in scope.

**`client/` is the exception**: `client/tsconfig.json`'s `types` lists only `vite/client`, and `client/tsconfig.test.json` extends it without adding `vitest/globals`, so those names are never declared ambient for `tsc -p client/tsconfig.test.json` — `globals: true` still makes them work at runtime, but any `client/**/*.test.ts(x)` file that uses them must import them explicitly to type-check. All seventeen client test files do, and that import is required there, not a violation.

## Async test assertions: gate concurrency, don't race wall-clock timers

A test that proves an ordering property by racing real `setTimeout` delays
against each other (`setTimeout(resolve, 0)` finishing before
`setTimeout(resolve, 20)`) is asserting that the event loop is not starved —
true on a quiet machine, false under load. It reads as a concurrency
assertion but is actually a wall-clock bet, and it gets more likely to fail
exactly when the suite is run under the contention a CI merge gate or a
parallel sweep creates (#528, `tick-loop.test.ts`).

Fix by gating, not by widening the delay: have the slow side `await` a
promise that the fast side resolves once it has done the observable thing
under test (e.g. pushed to a shared array). That asserts the real
happens-before relationship with no dependence on timer precision. It also
changes the failure mode at a cap that should serialize the workers: the
sleep-based version still fails there (the completion order comes out
wrong, a legible assertion diff), but the gated version DEADLOCKS instead —
a stronger guarantee against a future cap change reading as passing. Note
the deliberate deadlock in a comment so a future reader doesn't "fix" it
back to a sleep. Raising the delay (20ms → 200ms) is explicitly the wrong
fix: it makes the race rarer without removing it, converting a flake
everyone sees into one nobody trusts a diagnosis for.

## Fake-timer advances: walk only what the test needs, don't raise the ceiling

`vi.advanceTimersByTimeAsync(duration)` is CPU-bound in `duration`, not free:
it has to walk every timer scheduled inside the window, including ones the
test isn't asserting on. Two independent costs hide in a long advance, and a
given test may have either or both:

- **The cadence under test is itself long** (e.g. a 24h default). If that
  cadence can be set explicitly in the test config, shrink it and advance
  just past the short value instead — the assertion is about the behaviour
  at that cadence, not about 24h specifically.
- **An unrelated timer the test doesn't exercise is left at its short
  production default** (e.g. a 15s poll) inside a config built for a
  day-plus advance. Every one of those fires gets walked too, even though
  nothing in the test asserts on it. Park that timer's interval well outside
  the advanced window instead — it costs nothing to leave un-fired.

Either way, prefer shrinking the work over raising the ceiling. Reach for a
per-test `testTimeout` bump only when the slow cadence itself is the thing
under test, and say why in a comment — a raised global timeout hides the
next slow test instead of fixing this one.

**Watch the 32-bit `setTimeout` ceiling when "parking" a timer far out.** A
delay above `2^31 - 1` ms (~24.8 days) overflows Node's signed 32-bit timer
delay and gets clamped to fire on the next tick instead of being deferred —
"parking" a poll at 365 days turns it into a near-0ms self-rescheduling loop
that hangs the advance instead of skipping it. Pick a value comfortably
under that cap (and comfortably past the longest advance the file uses).

## Verification before removing or adding an export

- Before deleting an `export`/`export type` line, grep the whole codebase for consumers importing that path. If none exist outside the file's own module, it's dead — remove it. If consumers exist, repoint them at the module's barrel rather than leaving a stray re-export in place.
- After any export/import change, run `npx tsc --noEmit` — a removed or misrouted export fails at compile time, not at runtime, so tsc is the check that actually catches it. Run the test suite too (`npm test`).

## Wiring a mechanism means adding its enforcement assertion to `yarn smoke` (#430)

This repo's dominant defect class is **a complete, tested mechanism with no production caller**. It has recurred at least nine times — #327, #364, #366, #371, #374, #379, #388, #432, #433 — and per-ticket fixes have not stopped it, because every instance is individually correct code. The gap is always at the composition root, and unit tests cannot see it by construction: all 1,800+ passed throughout each one.

So the rule is structural rather than a reminder to be careful:

- **When you wire a new mechanism into `buildProductionComponents`, add an assertion for it to `evaluateSmokeGate`** (`server/apps/orchestrator/smoke-run.ts`). `yarn smoke` drives the real composition root, and it is the only automated check that has ever caught this class.
- **Aim the assertion at the ENFORCEMENT, not the construction.** Assert the mechanism's own durable effect — a row only it writes, a counter only it increments. A check on "was it constructed" passes for a component nothing calls, which is the defect itself.
- **Prove the assertion can fail.** Delete the effect from an otherwise-healthy observation set and confirm the gate goes red. PR #390 shipped three checks in one branch that all read as correct and enforced nothing (a config never read, a gate assertion made vacuous by a dropped argument, and `windowMs: 0` at which the limiter enforced nothing) — none was caught by review, all three by mutation.
- **Prefer a required argument to an optional one.** `evaluateSmokeGate`'s `llmRateLimiterSnapshot` is required precisely because, while optional, deleting the one line that passed it left the check vacuously true and the whole suite green.

## Comments state invariants, not changelogs

Comments here carry *reasons* — that is an asset (ruled in `docs/reviews/code-quality-2026-08-05.md`) and must stay. But keep the invariant sentence and drop the how-it-got-here essay: ticket archaeology ("#322 changed X, then #342 …" — 144 issue refs in `production.ts` alone as of 2026-08-06) belongs to git and GitHub. Cite a ticket when it names *why the invariant holds*, not to narrate history. Test: if deleting the sentence loses no constraint on future edits, delete it.

## A section-header comment is an unextracted function

`// Step 3: per-asset exposure cap.` or `// --- Dial 2 ---` over a block — especially a bare `{ }` scope introduced just to contain locals — is a function that wasn't extracted. Extract it; the function name replaces the comment, and the numbering becomes call order. (Origin: `risk-manager/index.ts` `evaluate`, 8 numbered steps in 192 lines.)

## Repeated classifications belong in types, not prose

If comments apply the same taxonomy to many values (e.g. `paper-profile.ts`'s SPEC/DERIVED/UNSOURCED provenance labels), make it a typed field. Typed classification is greppable and assertable in a test ("no UNSOURCED value ships to live"); prose is neither.

## Paired presentation values are returned together, never joined at the call site

Where a wire enum needs more than one display value — a word and a colour, a label and an icon — one function returns them as a unit; callers never look up the halves from separate tables. The client's accessibility floor ("colour is never the sole carrier of a signal", `dashboard-spec.md`) currently rests on 9 call sites each pairing `conditionTone(x)` with `CONDITION_STATE_WORD[x]` correctly by hand, out of two tables that take different inputs and so cannot be kept in sync by construction (`cellStateWord(state, laneOutcome)` vs `cellTone(state)`). A `present*(x): {word, tone}` interface makes the invariant structural: a caller cannot supply the colour without the word. (Review 2026-09-04 F3.)

## One display of a wire row, one module

Two renderers of the same wire structure re-derive its display rules independently and drift. The lane matrix and the drawer timeline both walk `PIPELINE_STAGES` over a lane's cells; only the drawer glossed degraded decisions, so #1080's starved-debate legibility never reached the surface an operator scans first, and no test could catch it because only one renderer set the `data-degraded` hook. Resolve the row once into a display shape (`resolveLaneCells(lane): readonly ResolvedCell[]`) and let each renderer choose how much of it to paint. (Review 2026-09-04 F1.)

## Test stubs must type-check without casts

No `as SomeType` / `as unknown as` / `@ts-expect-error` on fixtures. A wrong-shaped stub behind a cast silently disables the very check the test exists for — a mis-shaped `VolatilityReading` stub meant the volatility breaker never evaluated in the composed-tick test while the suite stayed green. Use `satisfies`, real builders, or shared fixtures.

## Speculative implementations live in git history, not `server/`

No unconstructed adapter/client/store ships. Corollary of the smoke-assertion rule above: code with no path from a composition root reads as capability and is this repo's dominant defect class. Wire it or delete it; restore from history when the real consumer arrives.

## Multi-write store mutations are transactional

Any store operation making more than one dependent write wraps them in a single `better-sqlite3` transaction. A crash between un-transacted writes can be unrepairable when a dedup guard makes the retry path skip the work (fill-ingest, review 2026-08-06: `writeFill` → `updatePositionFill` → `writeClosedTrade` with `hasFill()` dedup).

## Typed errors only where a caller branches

296 generic `new Error`s vs 17 typed error classes is the current ratio, and it is mostly right: typed errors live at wire boundaries where retry classification needs them. Introduce a typed error class only when a caller actually discriminates on it (`instanceof` for dedup/retry/state-machine decisions — `DuplicatePositionError` is the model); never as blanket policy, and never make a message string load-bearing where a caller branches.

## Environment variables: an option with an env default, never a mid-wiring read

Every env-derived value is an explicit option/config field whose default reads `process.env` at the option site — `options.apiKey ?? process.env.ALPACA_API_KEY` — documented in that option's doc comment. Entry points (`orchestrator/index.ts`, `dashboard/index.ts`, scripts) are the only places that do raw multi-variable env parsing. Composition and stage code never reach for `process.env` mid-wiring: a build function that needs an env decision takes a config field carrying the env default instead, so tests and programmatic callers can decide without touching the process environment. (Review 2026-08-06 D2 — `sentimentEnabled` is the worked example.)

## When in doubt

Grep for existing patterns in sibling modules before introducing a new one. Match the file's existing style over a "better" abstraction.
