# ADR-0012 — Client/server repo layout and a declared wire contract

**Status:** Accepted
**Date:** 2026-08-08
**Supersedes:** nothing. Amends the file-layout assumptions in [ADR-0010](0010-dashboard-vite-react-rewrite.md), which put the web app at `src/dashboard-web/`.

## Context

`src/` held sixteen sibling directories with nothing distinguishing four
different kinds of thing: seven pipeline stages, two data providers, four
runnable programs, a shared library, and two offline research trees. Nothing in
the layout said that `serve` was a process supervisor, `shared` was a library,
or `cost-model-backtest` was mostly offline tooling.

Four consequences were load-bearing rather than aesthetic:

1. **The browser app lived inside the backend's compilation unit** as
   `src/dashboard-web/src/…` — a `src` inside a `src`. Both root tsconfigs had
   to carry `exclude: ["src/dashboard-web"]`, duplicated because `extends`
   overrides `exclude` rather than merging it. Two files that had to stay in
   sync forever, or `yarn typecheck` would pull DOM and JSX sources into a
   Node-only project. `tsconfig.test.json` carried a six-line comment
   explaining why the entry could not simply be inherited.

2. **The client imported backend source by relative path** — nineteen files,
   twenty-two specifiers, up to `../../../../dashboard/types.ts`. All
   `import type`, so nothing shipped, but the client's TypeScript *program*
   included server modules its own config excluded. There was no declared
   contract between the halves; there was a path that happened to resolve.

3. **`CostModel` and `MetricsSuite` were declared in `cost-model-backtest/`**
   and imported by `execution/simulated-adapter.ts`, the Feedback Loop and the
   dashboard wire model. A folder named for an offline research harness owned
   types on the money path, so its name actively misled about blast radius.

4. **`src/scripts/` mixed the free-OHLCV stack with one-off research runners.**
   That had already cost something: `free-stack-aggregates-client.ts` carries a
   comment justifying why it does *not* reuse `scripts/coinbase-candles-client.ts`
   — a second Coinbase client exists because the first was filed where nobody
   looks for infrastructure.

## Decision

```
client/      the Vite app — Vite owns this folder end to end
server/      apps/ · pipeline/ · providers/ · shared/ · tools/
contracts/   the wire model, imported by both runtimes and importing neither
```

There is no root `src/`. **`client/` and `server/` never import each other;
both import `contracts/`.** That one sentence replaces five tsconfigs
cross-referencing each other by `exclude`.

### What belongs in `contracts/`

**JSON-serializable shapes only.** If a type carries a `Date`, a function, or a
class instance, it is pre-wire and belongs to the runtime that owns it. The rule
is mechanical rather than editorial, which is what makes it enforceable — it is
why `DashboardQueryStore` (methods), `PipelineActivity` / `PipelineStageEvent` /
`PipelineLiveTick` / `VerdictAuditEntry` (`Date` fields) and
`ProviderStatusReader` (behavior) stayed server-side while their serialized
projections moved.

The primitives the wire references — `AssetClass`, `Direction`, `StoreMode`,
`OrderState` — moved too. A contract that reaches into the server to learn what
an asset class is has not moved the boundary, only hidden it. Their previous
locations re-export, so no unrelated import site churned.

### Enforcement

`contracts/boundary.test.ts` asserts on source text that nothing in the
directory imports out of it, takes a runtime dependency, or declares a `Date`.
None of those are visible to `tsc`: an escaping `import type` compiles green and
silently restores defect (2) above. The test was verified to fail on an injected
violation, not merely to pass.

### Naming

Three renames, each retiring a word that named two different things:

| Was | Now | Why |
| --- | --- | --- |
| `src/dashboard/` | `server/apps/service-api/` | "dashboard" read as the UI; this is the Node HTTP backend |
| `src/dashboard-web/` | `client/` | the only browser code |
| `src/serve/` | `server/apps/supervisor/` | `serve` beside `service-api` would be two near-identical words for different things; the file inside was already `supervisor.ts` |

The seven pipeline-stage folders keep their names. Their suffixes are
inconsistent (`-engine`, `-manager`, `-loop`) and their plurality varies, but
renaming them would touch a large share of the tree and destroy `git blame`
across seven modules to fix something that is real and cosmetic.

## Alternatives considered

**A `packages/`-style monorepo (Turborepo/Nx), or Yarn 4 workspaces.** This is
the dominant JS convention and the repo's package manager supports it natively.
Rejected because that shape earns its cost when packages are reused across
several apps, and here they are not — `pipeline/` and `providers/` have exactly
one consumer. It would add seven `package.json` files, build ordering, and more
churn on `.yarn/install-state.gz`, which is committed and already conflicts
across parallel branches.

**Keeping the client inside `src/` with the nesting flattened** (`src/web/`,
app code directly beneath it). Viable — the doubled `src` is Vite scaffold
convention, not a requirement, since `vite.config.ts` sets `root` from
`import.meta.url`. Rejected because it keeps `exclude: ["src/web"]` in both root
tsconfigs, and no mainstream convention nests a browser app inside a backend's
source folder.

**Colocating as `dashboard/{server,web}/`.** Most intuitive to navigate, but it
reinstates the `src`-inside-`src` and the `exclude` pair this decision deletes.

## Consequences

**`dist/` mirrors the source**, so three sites that hard-coded the old shape had
to move together: `bundleRoot` (`../dashboard-web/` → `../../../client/`, in the
entry point and in `fixture-server.ts`), the supervisor's two literal spawn
paths, and Vite's `outDir`. `bundleDiagnostic` is non-fatal by design — a
missing UI build must not halt trading — so a wrong `bundleRoot` boots cleanly
and serves a broken page. That is checked by hand against a running server, not
by the type system.

**Script names changed**: `serve` → `start`, `dashboard` → `api`. Both old names
are kept as delegating aliases rather than deleted, because a dashboard was
running from the old path when this landed and the soak restart procedure is not
recorded in the repo.

**`vi.mock()` specifiers are invisible to automated rewrites.** One existed, and
a stale one fails OPEN — the mock stops applying and the real module runs — so
it surfaced as two unrelated assertion failures rather than a module-not-found.
Any future move must grep for `vi.mock`, `vi.doMock`, dynamic `import()` and
`require()` by hand.

**The knowledge graph must be rebuilt, not updated.** Every `source_file` in the
corpus changed, so `graphify update .` would treat the whole tree as new files
while the old paths linger as ghosts.

**Specs under `docs/specs/` were path-updated; `docs/research/`, `docs/adr/`,
`docs/reviews/` and `docs/wayfinder/` deliberately were not.** Those are dated
records, and rewriting a 2026-08-05 report to cite paths that did not exist on
2026-08-05 would falsify it.
