# ADR-0010 — Dashboard v2: a built Vite+React client, replacing the hand-rolled HTML

- **Status:** Accepted
- **Date:** 2026-08-07
- **Decided by:** David — the dashboard v2 brief ("improvise the UX to a higher level"), resolved in session on 2026-08-07
- **Related:** [Wayfinder: dashboard v2 — mission-control rewrite (Vite+React) + rooms pipeline theater](https://github.com/dd-jp/samurai-trading-system/issues/533) (decisions 1, 2, 9), [dashboard-spec.md](../specs/dashboard-spec.md) (v2), [ADR-0001](0001-technical-foundation-hybrid.md) (the dependency-light TS core this is measured against), [ADR-0011](0011-pipeline-theater-replay-motion.md) (the motion reversal that rides with it), [#534](https://github.com/dd-jp/samurai-trading-system/issues/534) (this rewrite's spec ticket)

## Context

The dashboard shipped as one `node:http` server serving a single HTML string
built by template literals in `src/dashboard/html.ts`, with client behaviour
inlined by calling `fn.toString()` on server-side functions and pasting the
result into a `<script>` tag. That was a deliberate decision, recorded in the
original dashboard map and in this spec's own words: *"no separate frontend
build/serve step, no framework SPA — a static page and one endpoint."* The
justification was real — for four tables and a poll, a build toolchain is
overhead, and it kept the runtime dependency list at one entry.

Three things changed.

1. **The surface grew past what a template literal can hold honestly.** `html.ts`
   plus `pipeline-view.ts` had become well over a thousand lines of string
   concatenation producing markup, CSS and client JavaScript with no type
   checking across the seam. `fn.toString()` inlining in particular is a
   construction where a refactor that renames a variable in a server module can
   silently change the meaning of client code, and no compiler will say so.
2. **The brief changed from "let me read the state" to "let me watch the
   machine."** A rooms grid with per-instrument personas that animate along
   recorded transitions, a ledger that stamps entries as they settle, and a
   drawer that must keep focus across a 3-second repaint is stateful view code.
   Hand-rolling incremental DOM updates for that — while keeping keyboard focus
   stable across polls — is reimplementing a reconciler, badly.
3. **The cost of the toolchain fell to zero at runtime.** Vite builds to static
   assets. React is a devDependency that never appears in `dependencies`; what
   ships to the server is bytes on disk.

## Decision

**Rewrite the dashboard UI as a Vite + React application at
`src/dashboard-web/`, built to static assets and served from disk by the
existing `node:http` server. The v1 vanilla UI is deleted, not ported.**

This explicitly reverses the "no framework SPA / no build step / zero new
dependencies" decision in the original dashboard map and the v1 spec.

Four constraints make the reversal narrow rather than a licence:

1. **Runtime dependencies are unchanged.** `react`, `react-dom`, `vite`,
   `@vitejs/plugin-react`, the `@fontsource` packages and the test tooling are
   **devDependencies**. `dependencies` remains exactly `better-sqlite3`. ADR-0001's
   dependency-light posture was about what runs in production; that is intact.
   The claim that changes is "no build step", not "no runtime dependencies" —
   the build becomes `tsc && vite build`.
2. **The backend does not move.** `GET /api/snapshot`, `buildSnapshot`,
   `SqliteQueryStore`, `pipeline-query.ts` and the provider poller are untouched
   except for two additive wire fields (`PipelineCell.recorded_at`, [#535](https://github.com/dd-jp/samurai-trading-system/issues/535);
   and `mode`). The rewrite is confined to presentation.
3. **The GET-only posture survives intact.** The server gains a static-file
   handler for `dist/dashboard-web/`, not a write path. Non-`GET` still answers
   `405`; the bundle is served only after the resolved path is proved to be
   **inside** the bundle root, so a request cannot escape it. Serving files from
   disk is the one genuinely new attack surface v2 introduces, and the guard is
   the thing that closes it, so it is specified rather than left to the
   implementer:

   > **A raw `resolved.startsWith(root)` is not the guard.** String-prefix
   > matching accepts any sibling whose name merely begins with the root's —
   > a `dist/dashboard-web-evil/` next to `dist/dashboard-web/` passes it and
   > escapes the bundle without ever using a `..` segment. Require
   > `!path.relative(root, resolved).startsWith('..')` (equivalently, a prefix
   > check against `root + path.sep`), which is a check about directory
   > containment rather than about characters.

   Both escapes are **required test cases**: the `..`/encoded-`..` traversal,
   and the sibling-directory-sharing-a-prefix case. The second is the one a
   naive implementation passes the first test while remaining open to.
4. **Zero external requests.** Fonts are self-hosted through `@fontsource` and
   bundled. Nothing in the built page reaches any host but its own origin — an
   operator watching live money must not have a page that a dead CDN can blank.

**Old UI dropped, not ported.** `html.ts`, `pipeline-view.ts`,
`pipeline-view.test.ts` and `pipeline-prototype.html` are deleted. Porting would
mean carrying a string-concatenation idiom into a component tree that has no use
for it. What carries forward is not code but the **information inventory** —
every datum the old UI displayed has a named home in the v2 spec, and that table
is the acceptance instrument for the rewrite. This is also where the stale
`Anthropic · spend 24h` label dies, since the module that rendered it ceases to
exist.

## Consequences

- **New build output and a new failure mode.** `yarn dashboard` now depends on
  `dist/dashboard-web/` existing. A server started against an unbuilt bundle
  serves a 404 at `/` while `/api/snapshot` still answers — which is confusing
  unless the build is folded into the same `build` script. It is.
- **A second test environment.** The client needs jsdom + React Testing Library
  alongside the existing node-environment vitest suite. Mitigated by keeping the
  client's real logic (room layout, walk plan, ledger) in a **pure, React-free
  `lib/`** that tests as ordinary functions; component tests then cover only what
  a DOM is genuinely needed for — accessible names, focus, rendered escaping.
- **Dependency surface at build time is real even if it is not at runtime.** A
  compromised devDependency can write into the bundle. Accepted: the same is
  already true of `typescript`, `vitest` and `biome`, and the bundle is served to
  one operator on one loopback interface.
- **Reversibility is poor and that is understood.** Deleting the v1 UI means
  going back means rewriting it. The decision is deliberate rather than
  incremental for exactly the reason the old code is being removed: keeping two
  UIs alive is how one of them silently rots.

## Alternatives considered

- **Keep vanilla, add discipline** — split `html.ts` into modules, drop
  `fn.toString()` inlining in favour of a separate hand-written client script
  served as its own asset. Cheapest option, and it fixes the type-safety seam.
  Rejected: it still leaves the reconciliation problem — the rooms/persona/ledger
  screen needs stable identity across polls with focus preserved, which is the
  problem a view library exists to solve.
- **A smaller view library** (Preact, Lit, Alpine) — smaller bundle, same build
  step. The build step is the thing being conceded here, so the saving is in
  bytes, on a page served from localhost. Rejected as optimising the axis that
  does not bind, against an ecosystem the project has no other experience with.
- **Server-rendered HTML with fine-grained polling fragments** — keeps the
  no-client-framework posture. Rejected: replay animation is client state by
  nature (it depends on what *this* browser last observed and whether its tab was
  hidden), and the server has no way to know that.
- **Skip the rewrite; keep v1 and add rooms to it.** Rejected by the brief — the
  point of v2 is the screen, and the v1 substrate is why the screen was not built
  sooner.
