# Live News Sources, WorldMonitor Pricing, and Self-Hosting — Evaluation

**Date:** 2026-08-07
**Question (David):** What other live-news sources can we use instead of the WorldMonitor dashboard? Is WorldMonitor worth $49/mo? If it beats the alternatives, should we self-host — and what does self-hosting require?
**Status:** Research finding. Falsifies premises in [ADR-0002](../adr/0002-worldmonitor-mi-source.md) §1/§2/§4 and in `docs/research/04-worldmonitor-as-mi-source.md`. Adopting anything here needs a new ADR — this document does not change a decision.
**Method:** WorldMonitor pricing/docs pages, plus direct reads of the AGPL platform source at `koala73/worldmonitor` (read for evaluation only, nothing copied).

---

## 0. Verdict

1. **Most "news API" alternatives are not WorldMonitor substitutes.** WorldMonitor occupies the *macro/geopolitical* layer. The financial-news APIs replace or feed the *DeepResearch* agent instead. Two different holes.
2. **Alpaca News API is the biggest free win available and it is on keys we already hold** — Benzinga feed, stocks *and* crypto, history to 2015, WebSocket streaming, included in Alpaca's free Basic plan. This is a DeepResearch upgrade, not a WorldMonitor replacement.
3. **$49.99 does not buy what ADR-0002 designed against.** $49.99 (Pro Business) is *MCP-only, 50→250 calls/day*. The SDK/REST access ADR-0002 §5 prototyped against starts at **$99.99/mo** (API Starter). The ADR's cited "$39.99 Pro" is a *Personal* tier with no commercial-use grant — arguably never valid for a live-money system.
4. **The paid product's core value for us — CII — is self-declared editorial, not empirical.** WorldMonitor's own methodology note says the weights are "authored by the WorldMonitor intelligence team… not derived from a published academic index" and "Treat the scores as opinionated, not empirical." Eight methodology versions since May 2026, each able to shift score values. ADR-0002 §6 already made CII warning-only *because it can't be validated*; the price is being paid for an unvalidated, version-unstable opinion.
5. **Self-hosting is technically viable and legally clean under our posture — but only over REST, not MCP.** Verified in source: the `wm_`-key REST gateway path *fails open* when the entitlement backend is unconfigured (as it is self-hosted); the MCP gate *fails closed*. So self-host substitutes for the **$99.99 REST tier**, not the $49.99 MCP tier.
6. **Recommendation: stay parked.** Nothing found makes CII newly necessary, and the second leg of the 2026-07-28 parking decision (CII is v1 warning-only, non-blocking, paper trading doesn't need it) is untouched. Self-host is the *plan for when we need it*, not work for this week. Meanwhile take the free Alpaca News + GDELT wins, which stand on their own merits.

---

## 1. What WorldMonitor actually is in our architecture

Per `04-worldmonitor-as-mi-source.md` §1.3, WorldMonitor is explicitly **not**:

- ticker-specific financial news (no SEC filings, earnings, company PR),
- per-item sentiment scoring,
- retail social sentiment.

It is the **macro/geopolitical/infrastructure layer** plus the Country Instability Index. So the question "what else gives us live news" has to be answered per layer, because nothing in the financial-news market competes with WorldMonitor and nothing in the geopolitical market competes with Benzinga.

---

## 2. Alternatives by layer

### Layer A — Company/ticker news (the DeepResearch agent's job)

| Source | Cost | Coverage | Why it matters here |
|---|---|---|---|
| **Alpaca News API** | **Free** with existing account (Basic plan, paper included) | Benzinga; stocks **and** crypto; history back to **2015**; REST + WebSocket (`wss://stream.data.alpaca.markets/v1beta1/news`) | Keys already provisioned. History to 2015 directly feeds the MI spec's backtest-replay/no-lookahead sidecar requirement. Highest value-per-effort item in this document. |
| Finnhub | Free tier, 60 calls/min | Company news + news-sentiment (US companies only); free WebSocket | Already a WorldMonitor self-host dependency; one key serves both if we self-host. |
| Alpha Vantage `NEWS_SENTIMENT` | Free, 25 req/day | Broad ticker universe with AI sentiment | Free quota too thin for a 15-min cadence; fallback only. |
| Marketaux | Free, 100 req/day | 200k+ entities, 80+ markets | Same quota problem; useful for breadth spot-checks. |
| Polygon/Massive (Benzinga) | Paid | Same Benzinga wire, ~25 ms WebSocket | Redundant with Alpaca News unless we need sub-second latency, which our 15-min cadence does not. |

**Read:** Alpaca News makes the paid options in this layer hard to justify at our cadence.

### Layer B — Macro/geopolitical (WorldMonitor's actual layer)

| Source | Cost | What it gives | Gap vs WorldMonitor |
|---|---|---|---|
| **GDELT 2.0** (Events + GKG) | Free, no key | Global event coding, 300+ categories, 100+ languages, **15-min update cadence**, tone scoring, DOC/GEO query APIs | Raw event stream — no country roll-up score, no convergence detection. We'd build the aggregation WorldMonitor sells. Cadence matches ours exactly. |
| **ACLED** | Free registration | Conflict/protest/riot events with fatalities | This *is* a primary CII input (Unrest 25% + Conflict 30%). Direct access to over half the CII's evidence base. |
| **UCDP** | Free/open | Organised-violence events | Also a direct CII input. |
| **Polymarket** (macro/event markets) | Free | Forward-looking event pricing | **Already adopted** per #481 — overlaps WorldMonitor's prediction-market tracking. We are not starting from zero on this layer. |
| USGS / NASA FIRMS / State Dept advisories / UNHCR | Free | Earthquakes, fires, advisories, displacement | All are named CII boost inputs; all free-tier. |
| Reuters/AP/Bloomberg wires | £££ | Editorial wire | Out of budget scope (ADR-0008: $50/14d). |

**Read:** the inputs WorldMonitor's CII is built from are almost entirely free and directly accessible. What WorldMonitor sells is the *aggregation, geo-attribution and weighting* on top — see §3.

### Layer C — Sentiment
Unchanged. Grok/nous remains the sentiment source; WorldMonitor never scored per-item sentiment (`sentiment` defaults to `0` per ADR-0002 §5).

---

## 3. Is WorldMonitor worth $49/mo?

### 3.1 The tier table (verified 2026-08-07)

| Tier | Price | Access shape | Limit |
|---|---|---|---|
| Free | $0 | Dashboard only | — |
| Pro (Personal) | $39.99/mo | MCP | 50 calls/day |
| **Pro Business** | **$49.99/mo** | MCP + **commercial-use license** | 250 calls/day |
| API Starter | $99.99/mo | **REST + official SDKs**, real-time streams | 60/min, 1,000/day |
| API Business | $299.99/mo | REST + redistribution rights | 300/min, 10,000/day |

### 3.2 Three ways $49.99 collides with our design

1. **Access shape.** ADR-0002 §5 validated normalization against the **npm SDK**. SDK/REST is API Starter, **$99.99**. At $49.99 we get MCP only — the adapter would have to be rewritten against an MCP client.
2. **Commercial use.** Commercial licensing attaches at Business ($49.99), not at the $39.99 Personal tier ADR-0002 §2 selected. For a live-money system, $39.99 was likely never the right tier.
3. **Quota vs cadence.** ADR-0008's 15-min cadence = 96 calls/day. Fits inside 250/day (Business), does **not** fit inside 50/day (Personal). A 5-min cadence (288/day) breaks Business too. So $49.99 works *only* at 15-min or slower, and *only* over MCP.

### 3.3 What we'd actually be buying

The one thing we cannot get free is CII — and WorldMonitor's own methodology doc undercuts it:

- Weights are **editorial**, authored in-house, "not derived from a published academic index, a peer-reviewed paper, or a third-party risk product."
- "Treat the scores as opinionated, not empirical."
- **v8 in ~3 months** (since May 2026), with the changelog warning that "score or movement semantics may shift between deploys."
- No backtesting or validation methodology disclosed.

ADR-0002 §6 already conceded CII is unvalidatable with existing data (no historical series at any tier). Combined with the above, the $49.99 buys an opinion index whose version churn can silently move our macro risk flag between deploys — for a signal that is warning-only and non-blocking by design (#174).

**Verdict on $49:** not worth it *today*. It fails on fit (MCP-only vs the SDK design), and the signal it uniquely provides is self-declared non-empirical and version-unstable, gating nothing in our pipeline.

---

## 4. Self-hosting

### 4.1 Licensing

WorldMonitor's platform is **AGPL-3.0-only** (`LICENSE`: "Copyright (C) 2024-2026 Elie Habib"). ADR-0002 §1 banned self-hosting to avoid copyleft contamination. That concern is over-broad for the posture we'd actually take:

- Running AGPL software **unmodified for our own use is exactly what the licence permits** — self-hosting is documented and supported by the maintainer.
- Samurai talking to a self-hosted WorldMonitor **over HTTP as a separate process** does not make Samurai a derivative work. Separate programs communicating over a network interface are an aggregate, not a combined work.
- AGPL §13 obliges offering **WorldMonitor's** source to remote users of WorldMonitor — and that source is already public and would be unmodified.
- The maintainer's "separate commercial licensing" alternative exists for people who want to avoid copyleft obligations we would not trigger.

**What would change this:** modifying WorldMonitor's source *and* exposing that modified instance to other users over a network. Under a single-operator, unmodified, localhost deployment, neither applies.

*This is reasoning, not legal advice.* It is exactly the kind of hard-to-reverse call CLAUDE.md says warrants an ADR — David's call, not this document's.

### 4.2 What self-hosting actually delivers — verified in source

| Path | Self-hosted behaviour | Evidence |
|---|---|---|
| **REST** (`wm_` API key) | **Works.** With the entitlement backend unconfigured (no Convex), `server/gateway.ts` logs `entitlement backend unconfigured … serving wm_-key request fail-open` and falls through — the request proceeds. | `server/gateway.ts` ~L1356–1400 |
| **MCP** | **Blocked.** `checkProMcpAccess` returns a `billing_verification` denial when `backendConfigured === false`. Fails closed. | `server/_shared/pro-mcp-gate.ts` ~L95–110 |
| **CII scoring** | **Runs locally.** The scorer, weights and risk config are all in the open repo and read from local Redis cache keys populated by the seeders. | `server/worldmonitor/intelligence/v1/get-risk-scores.ts`, `shared/cii-weights.ts`, `_risk-config.ts` |

**Two consequences:**

- Self-host substitutes for the **$99.99 REST tier**, not the $49.99 MCP tier. That improves the economics of self-hosting considerably versus the naive "saves $49/mo" framing.
- The REST path works via a **fail-open branch of someone else's billing code**, explicitly documented as deploy-defect tolerance (it was flipped once already, per the `#4770` reference in the comment). This is not an entitlement we hold; it is a behaviour that could change in any upstream release. Pinning an image tag is mandatory if we go this way.

### 4.3 Is self-hosted CII faithful?

CII inputs, from the published methodology, against self-host key availability:

| Component | Weight | Inputs | Self-host availability |
|---|---|---|---|
| Unrest | 25% | ACLED protests/riots/fatalities; internet & power outages | ACLED free ✅ / **Cloudflare Radar outages = paid** ⚠️ |
| Conflict | 30% | ACLED battles/explosions/violence-vs-civilians; UCDP; Iran strikes; OREF | Free ✅ |
| Security | 20% | Military flights, military vessels, aviation disruption, GPS jamming | OpenSky / AISSTREAM / AviationStack / gpsjam — all free-tier ✅ |
| Information | 25% | Classified news headlines geo-attributed to country | WorldMonitor's own RSS fleet + LLM classification via free GROQ/OpenRouter keys ✅ |
| Boosts | ≤ caps | Climate, cyber, fire, advisories, displacement, earthquakes, sanctions, AIS | Free ✅ |

All eighteen Redis cache keys the scorer reads map to seeder scripts shipped in the repo (`seed-ucdp-events`, `seed-internet-outages`, `seed-military-cii`, `seed-security-advisories`, `seed-sanctions-pressure`, `seed-infra`, `seed-insights`, …), and `run-seeders.sh` runs the whole `seed-*.mjs` fleet.

**One genuine degradation:** Cloudflare Radar (internet-outage data) is the only paid input, feeding part of the 25%-weight Unrest component. A self-hosted CII would be *slightly thinner* than the hosted one — bounded and identifiable, not a different index.

**This corrects the record.** The parked-decision memory claims reproducing CII would need "60+ data subscriptions." It would not: the self-host dependency list is ~10 providers, all free-registration except Cloudflare Radar.

### 4.4 Self-hosting requirements

**Stack** (4 containers, docker compose):
- `worldmonitor` — nginx + Node.js API under supervisord
- `worldmonitor-redis` — data store
- `worldmonitor-redis-rest` — Upstash-compatible REST proxy
- `worldmonitor-ais-relay` — vessel-tracking WebSocket

**Runtime:** Node.js 22+, Docker or Podman.

**Secrets** (no safe defaults, `openssl rand -hex 32` each): `RELAY_SHARED_SECRET`, `REDIS_PASSWORD`, `REDIS_TOKEN`.

**API keys:**
- *None needed:* earthquakes, weather, natural events, displacement, prediction markets, crypto, climate anomalies, cyber threats, submarine cables.
- *Free signup:* GROQ (14.4k req/day), FRED, EIA, NASA FIRMS, AISSTREAM, Finnhub, AviationStack, ACLED, OpenRouter.
- *Free with account for higher limits:* OpenSky.
- *Paid:* Cloudflare Radar only.

**Setup:** clone → generate 3 secrets into `.env` → `docker compose up -d` → `./scripts/run-seeders.sh` → dashboard on `localhost:3000`.

**Ongoing:** seeders must run on cron **every ~30 min**. Redis persists across restarts but is destroyed by `docker compose down -v`.

**Unquantified cost — the real one.** No hardware spec is published. This adds 4 containers + Redis + a persistent AIS WebSocket relay + a 30-min cron to **the same always-on MacBook that runs live money** (CLAUDE.md deployment target, whose stated risks are already crash/power/restart). "£0" is true in cash only. Before adopting: measure with `docker stats` through a full seeder cycle, and treat resource contention with the trading host as an open risk. A separate box removes the contention but re-introduces a cash cost that changes the comparison again.

---

## 5. Recommendation

**Now — take the free wins, stay parked on WorldMonitor.**

1. **Wire Alpaca News into the DeepResearch path.** Free, keys held, stocks+crypto, 2015 history for replay. Stands alone on merit regardless of the WorldMonitor decision.
2. **Consider GDELT 2.0 as the macro layer stopgap** if a geopolitical signal is wanted before live money — free, no key, 15-min cadence matching ours. Raw events, no roll-up score.
3. **Do not subscribe at $49.99.** Wrong access shape for the ADR-0002 design, and the unique signal is self-declared non-empirical.
4. **Keep the WorldMonitor adapter parked.** The cost leg of the 2026-07-28 decision is now disproven, but the other leg stands: CII is warning-only, non-blocking, and paper trading does not need it.

**Later — if live-money results show we want the macro/geopolitical layer:**

Self-host over **REST**, pinned to a specific image tag, on a box whose resource contention with the trading host has been measured. That substitutes for the $99.99 tier, not the $49.99 one — and it makes the buy-vs-host comparison materially different from the one ADR-0002 recorded.

---

## 6. Follow-ups this document creates

- **Correct `worldmonitor-adapter-parked` memory** — its "60+ data subscriptions" rationale is false (done alongside this doc).
- **ADR-0002 needs revisiting** if self-hosting is ever adopted: §1 (never self-hosted), §2 (tier/price — both the price and the access shape are wrong), §4 (single-maintainer risk is stale: the repo has multiple active contributors and was pushed to on 2026-08-07). Offer an ADR; do not edit the accepted record.
- **`04-worldmonitor-as-mi-source.md`** states "$39.99/mo Pro or $99.99/mo API Starter" and "do NOT self-host." Both premises are superseded by this document; leave the file as the historical record and cite this one.
