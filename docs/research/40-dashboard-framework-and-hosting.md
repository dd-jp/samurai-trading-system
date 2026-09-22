# Dashboard Framework and Hosting — Next.js, Vercel, and What the Store Actually Constrains (2026-08-06)

**Status:** Recorded 2026-08-06, commissioned by David: *"Should we use Next.js for this project given
that we have an orchestrator service and a dashboard? The dashboard plan will extend further and an
HTML-based solution would not be enough — I'm planning more animation and persona imagery for the
different stages and agents. Also once things start working we have to deploy this in cloud, so
should we consider Vercel or AWS to deploy this?"*

This resolves the open decision in [techstack.md](../techstack.md): *"Framework/library, if any, if the
dashboard ever grows past one static page"*. Per Standing Pipeline Rule 1 it locks nothing — it is
the evidence to grill against.

All prices and quoted clauses retrieved **2026-08-06** from the first-party pages cited inline.

---

## Headline

> **The premise is right, the diagnosis is off by one, and the hosting question is not a hosting
> question.**
>
> The current page does not break on animation — it already animates, with `@keyframes` and a
> `prefers-reduced-motion` branch. It breaks on two things the repo's own test file already
> confesses: **there is no route that can serve an image**, and the client is composed by
> `Function.prototype.toString()` against a hand-maintained list of 16 functions.
>
> **Vite + React, served by the existing `node:http` server, deletes both.** Next.js does not — it
> brings a second server runtime alongside the orchestrator, which is exactly the shape
> [#325](https://github.com/dd-jp/samurai-trading-system/issues/325) rejected.
>
> **Vercel is not on the table for this app, for a reason that survives every workaround:** the
> dashboard's data source is a SQLite file written by a long-lived orchestrator process, and Vercel
> Functions have a *read-only* filesystem and are *archived when not invoked*. Splitting the
> dashboard off is a store migration, not a deploy target. Keep them co-located; reach it remotely
> through a tunnel.

---

## 1. What the code actually is, as of 2026-08-06

The premise "an HTML-based solution would not be enough" deserves a precise reading rather than an
abstract yes/no. Here is where the 1,178 lines sit.

| file | lines | what it is |
|---|---|---|
| `src/dashboard/html.ts` | 635 | one exported template literal, `DASHBOARD_HTML` | <!-- cite-exempt: historical — measurement of the pre-#627 tree this doc was written against; the file was replaced by the client bundle -->
| — `<style>` (L28–242) | ~215 | hand-written CSS, incl. `@keyframes pulse`, `@keyframes pl-settle`, a `prefers-reduced-motion` branch |
| — markup (L243–294) | ~52 | tab shell + six empty panel `<div>`s |
| — `<script>` (L295–633) | ~339 | hand-written browser JS, **inside the string**, with `PIPELINE_VIEW_CLIENT_SOURCE` interpolated at L490 |
| `src/dashboard/pipeline-view.ts` | 543 | render logic written as *real TypeScript*, then serialised to browser source | <!-- cite-exempt: historical — same pre-#627 measurement; superseded by the Vite client -->

So it is already a single-page application: `fetch('/api/snapshot', {cache:'no-store'})` on a
3-second `setInterval`, tab state, click and keydown handlers, and incremental DOM patching in
`pipeline-view.ts` written specifically so CSS transitions are not restarted on every poll.

### The three break points, in order of hardness

**(1) There is no route that can serve a static file. This one is decisive.**
`server/apps/service-api/server.ts` (116 lines) has exactly three matches and a 404:

```
GET /            or /index.html  →  DASHBOARD_HTML
GET /api/snapshot               →  JSON
anything else                   →  404      (non-GET → 405)
```

Persona imagery — David's stated driver — **cannot be delivered by this architecture at all.** The
only way to get a PNG onto the page today is to base64-inline it into a 635-line template literal
that is re-serialised on every page load. This break point is independent of framework: even "stay
as-is" requires adding file serving. It is the first thing that must change, and it is the honest
core of the premise.

**(2) The client is composed by `Function.prototype.toString()`.**
`PIPELINE_VIEW_CLIENT_SOURCE` (`pipeline-view.ts` L523–543) is an array of three JSON-stringified
constants plus **16 hand-listed `fn.toString()` calls** — 19 array entries in total — `.join('\n')`.
`toString()` emits each function's source text verbatim, so any reference to an import or a closure
variable survives as *text* and fails as a `ReferenceError` in the browser at runtime. The file's own
comment concedes the other failure mode:

> *"a function added here but not to the list is a test failure rather than a page that silently
> stops rendering."*

The test is the guard rail because the mechanism has no other one. Add per-stage and per-agent
persona views and this list grows monotonically, with a manual edit required per function and no
compiler enforcing it. **This is the scaling wall, not the CSS.**

**(3) 339 lines of the page's JavaScript are outside the type checker, the linter, and the tests.**
`pipeline-view.test.ts` states it in the repo's own words:

> *"`html.ts` has no build step and no test of its own — a syntax error inside its template literal
> is a blank dashboard discovered by opening it."*

and

> *"Biome's a11y rules cannot see inside a template literal, so this is the only thing standing
> between a bare `<button>` and a submit-by-default."*

The strongest assertion available is `new Function(pageScript())` — **parse-only, no execution, no
types**. `pipeline-view.ts` exists precisely because someone already noticed this and pulled the
*newest* half of the render logic back into real TypeScript. That is a bundler-shaped move made
without a bundler.

**What is not a break point: animation.** The page already ships two `@keyframes`, a settle
animation, focus-visible outlines, and a reduced-motion branch. Nothing in the animation ambition
requires a framework — see §3. That half of the premise is the weaker half; the composition half is
correct.

---

## 2. The framework question

### 2.1 What Next.js actually provides, scored against *this* app

Next.js v16.3.0 docs. The app in question is a **single-operator console on localhost**: no SEO, no
public traffic, no multi-tenant auth, no user-generated content, and an existing JSON API.

| Next.js capability | need here? | why |
|---|---|---|
| App Router / file-system routing | **no** | The whole surface is one page and one JSON route. Routing is `if (path === '/')`. |
| React Server Components | **no** | The data is one bounded snapshot polled every 3s. There is no per-request server render to move off the client. |
| Server Actions / mutations | **no, actively unwanted** | dashboard-spec.md: *"Any write path … strictly read-only"*. `server.ts` returns 405 on every non-GET **by construction**. Server Actions exist to add write paths. |
| SSR / ISR / SSG | **no** | Nothing is cacheable across users; there is one user. ISR's whole apparatus (cache handlers, `revalidateTag`, multi-instance coordination) is documented for exactly the deployment shape we do not have. |
| Middleware / Proxy | **no** | No auth today (§4.3), and one route. |
| Bundling, HMR, TS→browser pipeline | **YES** | This is the one that fixes break points (2) and (3). |
| Static asset serving (`public/`) | **YES** | This is break point (1). |
| `next/image` | **marginal** — see below | |
| React component model | **YES** — but see §3 | |

**Two of the eight things Next.js is for are needed. Both are also what Vite gives you, without a
server.**

### 2.2 `next/image`, specifically, since persona imagery is the driver

From [the Image component reference](https://nextjs.org/docs/app/api-reference/components/image),
`next/image` provides: automatic `srcset`/`sizes` generation across `deviceSizes`
`[640, 750, 828, 1080, 1200, 1920, 2048, 3840]`; on-the-fly WebP/AVIF conversion (`formats`);
native `loading="lazy"` by default; and aspect-ratio reservation from `width`/`height` to avoid
layout shift.

Score that against **~10 local persona PNGs served over loopback to one operator on one Mac**:

- Responsive `srcset` across 8 device widths — **no value.** One viewer, one screen, and the assets
  are authored at known sizes.
- AVIF/WebP transcoding — **no value at localhost bandwidth.** The docs themselves note AVIF *"takes
  50% longer to encode"* and that caching each format separately *"means increased storage
  requirements."* That is a cost with no matching benefit here.
- Lazy loading — **`<img loading="lazy">` is a native HTML attribute.** Free without React.
- CLS prevention — **`width`/`height` attributes on `<img>`, or a CSS `aspect-ratio`.** Free.

The docs also note `unoptimized` is *automatic* when `src` ends in `.svg` — i.e. for the one asset
format most likely to be used for stage/agent iconography, `next/image` deliberately does nothing.

**Does it work self-hosted?** Yes.
[The self-hosting guide](https://nextjs.org/docs/app/guides/self-hosting) states plainly:

> *"Image Optimization through `next/image` works self-hosted with zero configuration when deploying
> using `next start`."*

Its only caveat is Linux-specific — *"On glibc-based Linux systems, Image Optimization may require
additional configuration to prevent excessive memory usage"*, linking to sharp's Linux
memory-allocator page. On macOS that caveat does not apply. **Whether `sharp` is installed
automatically is not stated on that page — unverified.** What *is* verified is that the
[standalone output docs](https://nextjs.org/docs/app/api-reference/config/next-config-js/output)
list `node_modules/sharp/**/*` as a canonical `outputFileTracingIncludes` pattern, i.e. sharp is a
real file-traced dependency of the image path, not a phantom.

So: `next/image` self-hosts fine, and buys this app essentially nothing that two HTML attributes
don't.

### 2.3 Choosing Next.js would NOT mean choosing Vercel

Worth establishing on its own, because the two questions arrive together and the conflation would
make §2.5 look like it leans on a hosting argument it does not need.

[`output: 'standalone'`](https://nextjs.org/docs/app/api-reference/config/next-config-js/output)
traces the dependency graph with `@vercel/nft` and produces `.next/standalone` plus *"a minimal
`server.js` file … which can then be deployed on its own without installing `node_modules`"* —
started with `node .next/standalone/server.js`. The
[self-hosting guide](https://nextjs.org/docs/app/guides/self-hosting) adds that caching and ISR
*"works automatically for a single self-hosted `next start` instance with persistent local disk"* —
which is exactly the Mac — and that image optimization works with zero configuration under
`next start`.

The degradations are cosmetic: standalone *"does not copy the `public` or `.next/static` folders by
default"*, fixed by one `cp -r public .next/standalone/ && cp -r .next/static .next/standalone/.next/`;
and the guide recommends *"a reverse proxy (like nginx) in front of your Next.js server rather than
exposing it directly to the internet"* — advice that applies to `node:http` equally. Every genuinely
painful part of self-hosting Next.js (multi-instance cache coordination, `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`,
`deploymentId` version skew) is documented for multi-instance deployments, which this is not.

**So: Next.js self-hosts on the Mac essentially without degradation. It is declined on the §2.5
delete-vs-wrap test, not on hosting.**

### 2.4 Vite + React

From [vite.dev/guide](https://vite.dev/guide/): Vite is a dev server with HMR plus a production
build. `vite build` *"bundles your code using Rolldown and generates optimized static assets"* into
`dist/`, which *"can be served by any standard static file server."* Requires Node 20.19+ / 22.12+
(we are on ≥24 — satisfied).

**The delta, honestly:**

*Added* — `vite`, `@vitejs/plugin-react`, `react`, `react-dom` as devDependencies (React and
ReactDOM end up compiled into `dist/`, so they add **zero runtime `node_modules` dependencies** —
the built artifact is bytes on disk). One new build step: `npm run build` gains a `vite build`
alongside `tsc`. `vitest` is already here and is Vite-native, so the test runner does not change.

*Deleted* —
- the `<script>` block of `html.ts` (~339 untyped lines) — becomes real `.tsx` modules;
- `PIPELINE_VIEW_CLIENT_SOURCE` and all 16 `.toString()` entries — the bundler does what
  `Function.prototype.toString()` was faking;
- the `pageScript()` / `new Function()` parse-only tests — replaced by the compiler;
- the `<style>` block moves to `.css` files the linter can see.

*Added to `server.ts`* — one static-file route serving `dist/`. That route is required by break
point (1) under **every** option including "stay as-is", so it is not a cost of choosing Vite.

*Kept unchanged* — `server.ts`'s process model, `/api/snapshot`, `buildSnapshot`, `SqliteQueryStore`,
the entire read path. The dashboard stays one command, one process.

### 2.5 Does the #325 / ADR-0001 "second abstraction" precedent apply?

**#325's actual test was: does the library *delete* code, or *wrap* code?** pino was rejected because
every stage already logs through the shared `Logger` interface, so pino would have arrived as a
second logging abstraction wrapped by the first. What was missing was one byte sink.

Run the same test:

- **Next.js — the precedent applies, squarely.** Next.js ships its own server runtime (`next start`,
  or the `standalone` `server.js`). It does not delete `node:http` + `server.ts`; the orchestrator's
  dashboard would either become a second process on a second port, or `server.ts` would be
  reimplemented as a Next route handler while `buildSnapshot` and the store stay put — a second HTTP
  abstraction over the same two endpoints. Plus a cache layer, a router, and an RSC boundary for an
  app with one page and no writes. **Wraps, does not delete.**
- **Vite — the precedent does not apply.** Vite ships **no server in production**. It emits
  `dist/`. It *deletes* the `.toString()` composition, the untyped script string, and the parse-only
  tests, and replaces them with a mechanism that has a compiler behind it. **Deletes.**

That asymmetry is the answer to the framework question.

---

## 3. The animation and persona question — two needs, two answers

These are separable, and conflating them is what makes "I want animation" sound like "I need React."

**Animation does not require React.**
[Motion](https://motion.dev/docs/quick-start) publishes one package, `motion`, and documents *"a mini
HTML/SVG version of the `animate()` function that's just **2.3kb**."* That is the vanilla build —
no React involved. (A size figure for the React binding is **not stated on that page — unverified**.)
Against that: the page already runs `@keyframes` for the live pulse and the P/L settle flash, and
CSS handles transitions, transforms, opacity and keyframes with zero bytes shipped. **CSS remains
the right default; Motion-vanilla is available as a drop-in for anything spring-, gesture-, or
sequence-shaped that CSS cannot express.** Neither answer moves the framework decision.

**Composition *is* the real need, and that is what React is for.**
[react.dev](https://react.dev/learn/thinking-in-react): *"you will first break it apart into pieces
called components. Then, you will describe the different visual states for each of your components.
Finally, you will connect your components together so that the data flows through them."*

Seven pipeline stages × N agents, each with a persona card, its own visual states (idle / running /
settled / errored), and a drawer — that is a component hierarchy with props and local state. Today
each of those is a function returning an HTML string, hand-registered in a `.toString()` array, with
no type contract between the string it emits and the DOM the sibling code queries.
`renderPipelineCell` already has to hand-roll incremental patching (`diffPipelineCells`,
`pipelineLaneSignature`) purely to stop CSS transitions restarting — **that is a reconciler, written
by hand, at 543 lines and growing.**

So: **React yes, for the component model. Next.js no, for the server runtime.**

---

## 4. The hosting question

The hosting question is largely decided by the store, so it splits cleanly.

### Fork A — dashboard stays co-located with the orchestrator

The dashboard reads a local SQLite file on the same filesystem the orchestrator writes
(`SqliteQueryStore`, `better-sqlite3` ^13.0.1). Today that is the Mac; later it could be one cloud
VM running both processes. **Nothing about the store changes.** Framework choice becomes completely
free and unrelated to any platform — Vite's `dist/` is served by the existing `node:http` server.

**Remote access without moving anything.**
[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/):
*"a lightweight daemon in your infrastructure (`cloudflared`) creates outbound-only connections to
Cloudflare's global network"*, so you can *"block all inbound traffic."* No port forwarding, no
public IP, nothing exposed on the home router — which matters given the deployment target is a
MacBook on a domestic UK connection.
[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) sits in front
of it and *"determines who can reach your application by applying the Access policies you
configure"*, with **One-time PIN** listed as a login method — i.e. email-code auth in front of the
dashboard **without writing any auth code**. (Zero Trust free-tier user count: **unverified** — the
plans landing page carries no numbers.)

[Tailscale](https://tailscale.com/pricing) is the alternative: Personal plan **$0, "free forever",
up to 6 users, unlimited user devices**. The page frames it as *"for individuals who want to use
Tailscale at home"* for non-commercial purposes like homelabs; whether a personal trading console
falls inside that framing is a judgement call, and the page states it as a "best for" rather than a
restriction — read it before relying on it.

Cloudflare Tunnel + Access is the stronger option here specifically because Access supplies the
authentication the app does not have (§4.3).

### Fork B — dashboard split off to a cloud platform, separately from the orchestrator

**This is an architecture change, not a deploy-target change,** and it costs two things before it
costs a penny:

1. **A network-reachable store.** The dashboard cannot read a SQLite file that lives on a different
   machine.
2. **Authentication.** See §4.3.

**Vercel is ruled out for the dashboard, on two independent grounds.**

From [vercel.com/docs/functions/runtimes](https://vercel.com/docs/functions/runtimes):

- *"Vercel functions have a **read-only filesystem** with writable `/tmp` scratch space up to
  500 MB."*
- Functions are *"archived when they are not invoked"* — within 2 weeks for production deployments —
  and unarchiving *"can make the initial cold start time at least 1 second longer than usual."*
- Max duration is capped: **Hobby default and maximum 300s**; Pro 800s, 1800s extended
  ([duration docs](https://vercel.com/docs/functions/configuring-functions/duration)).

Ground one: **there is no long-lived process.** The Samurai orchestrator is a continuously running
tick loop; Vercel's model is per-invocation compute with a hard ceiling. The orchestrator cannot
live there at all, so the file it writes cannot live there either.

Ground two: **no persistent local filesystem.** Even if only the *dashboard* went to Vercel, there is
no durable disk to hold the SQLite file, and `/tmp` is per-instance scratch. `better-sqlite3` is
additionally a native addon (its README: *"Prebuilt binaries are available for major
platforms/architectures"* — i.e. a compiled `.node` artifact, not portable JS). Ground two survives
even if someone solves the native-addon packaging; **the absence of a writer process is the deeper
blocker.**

**And the licence would bite anyway.** Verbatim, from
[Vercel's Fair Use Guidelines](https://vercel.com/docs/limits/fair-use-guidelines) (retrieved
2026-08-06):

> **"Hobby teams are restricted to non-commercial personal use only. All commercial usage of the
> platform requires either a Pro or Enterprise plan."**
>
> *"Commercial usage is defined as any Deployment that is used for the purpose of financial gain of
> **anyone** involved in **any part of the production** of the project…"*

A live-money trading system's operator console is a deployment used for the purpose of financial
gain. **Do not plan on "Vercel is free."** Pro is **$20/user/month**
([vercel.com/pricing](https://vercel.com/pricing), retrieved 2026-08-06) — $10 against every 14-day
ADR-0007/0008 budget window, for a page one person opens.

**AWS, if Fork B is ever forced.** The shape that matches today's model is a long-lived Node process
with a local disk — i.e. **Lightsail or EC2, not App Runner / ECS / Amplify**, all of which push
back toward the ephemeral-container model that broke Vercel. From
[aws.amazon.com/lightsail/pricing](https://aws.amazon.com/lightsail/pricing/) (retrieved 2026-08-06):

| bundle | spec | USD/month |
|---|---|---|
| smallest (IPv4) | 0.5 GB RAM, 2 vCPU, 20 GB SSD, 1 TB transfer | **$5** |
| IPv6-only | same spec | **$3.50** |
| next up | 1 GB RAM, 2 vCPU, 40 GB SSD, 2 TB transfer | **$7** |
| | 2 GB RAM, 2 vCPU, 60 GB SSD, 3 TB transfer | **$12** |

Note that a Lightsail instance running *both* processes is not Fork B at all — it is Fork A with the
Mac swapped for a VM, and it keeps local SQLite. **That is the only cloud move that costs nothing
architecturally.** (EC2 on-demand pricing for a comparable small instance: **unverified** — the EC2
pricing page did not render usable figures; Lightsail is the like-for-like number.)

### 4.3 Auth is a blocking precondition, not a footnote

**`server.ts` has no authentication or authorization of any kind.** Anyone who can reach the port
gets:

- `GET /` — the full operator console, and
- `GET /api/snapshot` — **open positions, daily P/L, `MetricsSuite`, verdict history, analyst
  weights, and locally-metered LLM spend, as raw JSON.**

Both routes. The JSON route is the more sensitive of the two and the easier to forget. Today this is
survivable only because the server binds a host/port on a machine on a home LAN. **The moment the
dashboard is reachable from the internet — Fork B, a tunnel, or a port forward — this is a live
disclosure of positions and P/L to anyone who finds the URL.** Nothing else in this document should
be actioned ahead of it.

Cheapest resolution, in order: **Cloudflare Access in front of a tunnel** (identity enforced before
the request reaches Node, zero application code); then **Tailscale** (network-level, no public
surface at all); then hand-rolled auth in `server.ts`, which is the option that adds attack surface
to a process that currently has none.

### 4.4 If Fork B were ever forced: what replaces local SQLite

Kept brief on purpose — this is the consequence, not the recommendation.

- **Turso / libSQL** is the least-diff option: SQLite-compatible, network-reachable over a URL +
  auth token, via `@libsql/client` or `@tursodatabase/serverless`
  ([docs.turso.tech](https://docs.turso.tech/sdk/ts/quickstart)). Schema and SQL largely survive.
- **Postgres (Neon / RDS)** is the conventional option and matches techstack.md's already-recorded
  *"SQLite (initial) → Postgres (scale)"* path, at the cost of a dialect migration.

**Either way, the same breaking change lands.** Every method on `DashboardQueryStore`
(`server/apps/service-api/types.ts` L320–349) is **synchronous** — all ten of them — because `better-sqlite3`
is synchronous. Both Turso clients are promise-based (*`await turso.execute(...)`*). So the port goes
async, `buildSnapshot` goes async, and `server.ts`'s handler goes async. Plus a second copy of the
data, a network hop on the 3-second poll, and a recurring bill. **This is why Fork B is a
non-recommendation, not a preference.**

---

## 5. Costs, side by side

All retrieved 2026-08-06. ADR-0008's cap is **$50 per 14 days**, verified by reading
`docs/adr/0008-llm-spend-cap.md` on branch `worktree-semi-auto-readiness` <!-- cite-exempt: historical — v1 record; the file was deleted per ruling G8 and is preserved at tag v1-final -->
([PR #428](https://github.com/dd-jp/samurai-trading-system/pull/428)) — David's words, quoted there:
*"for paper trading lets keep 50$ / 14 day budget."* Both ADR-0007 and ADR-0008 live on that branch
and were **not yet merged to `main`** when this was written, so `docs/adr/` on `main` still ended at
0006. That also meant **the ADR number proposed in §8 had to be re-checked before it was written**.

> **Resolved since.** #428 merged; `docs/adr/` now ends at 0011. The number 0009 was taken by
> `0009-single-provider-nous.md`, so the dashboard decision landed as
> [ADR-0010](../adr/0010-dashboard-vite-react-rewrite.md) — see the note at the end of §8.

| option | recurring cost | fits the $50/14d cap? |
|---|---|---|
| Fork A, Mac + Cloudflare Tunnel + Access | $0 (free-tier user count unverified) | yes, no line item |
| Fork A, Mac + Tailscale Personal | $0, up to 6 users | yes, no line item |
| Fork A, one Lightsail VM running both processes | $3.50–$12 / mo | yes — ~$1.60–$5.50 per window |
| Fork B on Vercel Pro | $20 / user / mo **+ a managed DB** | ~$10 per window before the DB, for one viewer |
| Fork B on AWS (dashboard split out) | Lightsail **+ RDS/Neon** | worst of both; buys nothing |

Vercel Hobby is not a row, because of the commercial-use clause quoted above.

---

## 6. Recommendation

**Adopt Vite + React for the dashboard client. Do not adopt Next.js. Stay on Fork A. Do not deploy
the dashboard to Vercel.**

Sequenced:

1. **Auth or a tunnel first** (§4.3). Nothing below should ship to a reachable address ahead of it.
   Cloudflare Tunnel + Access is the lowest-code path and the one that keeps `server.ts` free of an
   auth layer.
2. **Add a static-file route to `server.ts`.** Required by break point (1) under every option,
   including doing nothing else. This alone unblocks persona imagery.
3. **Introduce Vite + React** as devDependencies; `npm run build` gains `vite build`; `server.ts`
   serves `dist/`. Port `pipeline-view.ts` to components and **delete `PIPELINE_VIEW_CLIENT_SOURCE`,
   its 16 `.toString()` entries, and the `<script>` block of `html.ts`.** Runtime dependencies
   stay at one (`better-sqlite3`).
4. **Animation: keep CSS.** Reach for `motion` (vanilla, 2.3kb) only when a specific interaction
   needs springs or gesture-driven sequencing. Preserve the `prefers-reduced-motion` branch — it
   already exists and should survive the port.
5. **If the Mac becomes untenable, move *both* processes to one Lightsail instance.** That keeps
   local SQLite, keeps the synchronous store port, and costs $3.50–$12/month.

### What would have to be true for the other branch to win

- **Next.js wins if** the dashboard stops being a single-operator console — multiple authenticated
  users, public or semi-public pages, SEO, or server-rendered content per request. None of those are
  on the roadmap, and the read-only invariant in dashboard-spec.md argues against Server Actions ever
  being wanted.
- **Fork B / cloud-hosted dashboard wins if — and this is the one question that decides it —
  the dashboard must be reachable when the orchestrator is down or the Mac is off.** If yes, the
  store *must* become network-reachable and the async migration in §4.4 is mandatory, not optional.
  If no, Fork A holds and Vercel is out on the filesystem model alone. **This is the question to put
  to David first.**
- **Staying entirely as-is wins if** the persona/animation plan is dropped. It is not enough on its
  own — break point (3) means the page's script is already outside the type checker — but it would
  remove the urgency.

---

## 7. Proposed resolution of the techstack.md open decision

Replace the open-decision line
`- [ ] Framework/library, if any, if the dashboard ever grows past one static page (see Dashboard row above)`
with, under **Resolved (previously "Open Decisions")**:

> - **Dashboard framework: Vite + React for the client; no Next.js.** The page had already outgrown
>   "one static page" — 339 lines of browser JS live inside a template literal that neither `tsc` nor
>   Biome can see, and the client is assembled by `Function.prototype.toString()` over a
>   hand-maintained list of 16 functions. React earns its place on the **component model** (per-stage
>   / per-agent persona views with their own visual states), not on animation — CSS `@keyframes`
>   already ship, and Motion's vanilla `animate()` is 2.3kb if springs are ever needed. Next.js is
>   declined on the **#325 test — does it delete code or wrap code?** Vite emits `dist/` and ships no
>   server, so it deletes the `.toString()` composition and the untyped script string; Next.js brings
>   a second server runtime alongside `node:http` and the orchestrator, and its value propositions
>   (App Router, RSC, Server Actions, SSR/ISR, middleware, `next/image`) score no-need against a
>   single-operator localhost console that is read-only by construction. `server.ts` additionally
>   gains a static-file route — required for persona imagery under **every** option, since today no
>   route can serve a file at all. Runtime dependencies stay at one (`better-sqlite3`); React,
>   ReactDOM and Vite are devDependencies compiled into `dist/`.

And the Dashboard table's **Rendering** row becomes: *"React client bundled by Vite, served as static
`dist/` by the existing `node:http` server — one process, one command, still zero new runtime
dependencies."*

---

## 8. Does this warrant an ADR?

**Two decisions here, and only one is ADR-shaped.**

- **Framework choice — no ADR.** It is reversible (a Vite bundle can be thrown away; the server,
  store, and API are untouched), it adds no runtime dependency, and it is exactly the class of
  "implementation-detail open decision" techstack.md was created to hold. Record it in techstack.md
  per §7 and close it there, the same way #325 was recorded.
- **Hosting topology — yes, ADR-worthy, and it should be written before any cloud move rather than
  after.** It meets all three of CLAUDE.md's tests: (1) hard to reverse — splitting the dashboard
  from the orchestrator forces a store migration and turns a ten-method synchronous port async;
  (2) surprising without context — "why not Vercel?" will be asked again, and the answer is a
  filesystem and process-lifetime constraint, not a preference; (3) a real trade-off — remote
  reachability versus keeping one process and one local file.

Suggested title if David agrees: **Dashboard stays co-located with the orchestrator; remote
access by tunnel, not by splitting the store.** Its first consequence would be that authentication
(§4.3) becomes a hard precondition on exposure, tracked as its own issue.

> **Landed as [ADR-0010](../adr/0010-dashboard-vite-react-rewrite.md), not ADR-0009.** This section
> proposed the number 0009, which was taken by `0009-single-provider-nous.md` — the risk this doc
> flagged for itself in §5. **The authentication precondition remains open:** `GET /api/snapshot`
> still serves positions, P&L and LLM spend with zero auth, and nothing else here should be actioned
> ahead of it.

---

## Unverified

Stated here rather than asserted anywhere above:

- **Cloudflare Zero Trust free-tier user count and per-user paid price** — the plans landing page
  carries no figures; two fetch attempts, 2026-08-06.
- **Whether Next.js installs `sharp` automatically** — not stated on the self-hosting page. What is
  verified: image optimization works self-hosted with zero config under `next start`, and
  `node_modules/sharp/**/*` appears as a canonical file-tracing include.
- **Motion's React-binding bundle size** — the quick-start page states 2.3kb for the mini HTML/SVG
  `animate()` only.
- **EC2 on-demand pricing for a comparable small instance** — the EC2 pricing page did not render
  usable figures; the Lightsail table is the like-for-like number.

*(Resolved after first draft: ADR-0007/0008 do exist, on the unmerged branch
`worktree-semi-auto-readiness` / PR #428, and the $50/14-day figure has been read from
`0008-llm-spend-cap.md` there rather than remembered. See §5.)*
