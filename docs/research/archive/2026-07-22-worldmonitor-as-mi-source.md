# WorldMonitor as a Market Intelligence Data Source — Research Handoff

> **ARCHIVED — both top-line decisions reversed.** Superseded by [`20-mi-decisions.md`](../20-mi-decisions.md): WorldMonitor is parked, and self-hosting is viable over REST (this doc forbids it). Pricing here is wrong — it omits the $49.99 tier and lists $249.99 where the top tier is $299.99. The convergence algorithm and CII formula are still the fullest record and are why this is kept.

**For:** Implementation agent (Samurai project)
**From:** Einstein (researcher profile), 2026-07-22
**Parent research:** `~/Documents/Obsidian/research/worldmonitor-2026-07-22-report.md` (full deep analysis, 13 sections)
**Repo under evaluation:** https://github.com/koala73/worldmonitor
**Recommendation:** Integrate WorldMonitor's MCP/API as a third upstream Market Intelligence source (alongside DeepResearch + Grok), plus reimplement its cross-source convergence algorithm and consume its CII scores. Do NOT self-host the platform. Use the MIT-licensed npm SDK.

---

## 0. TL;DR for the implementer

- **What to build:** A new WorldMonitor adapter inside `src/market-intelligence/` that pulls macro/geopolitical/economic convergence signals + Country Instability Index (CII) scores from the public WorldMonitor API, normalizes them into Samurai's `IntelligenceItem` schema, and delivers them to analysts + the Risk Manager.
- **How to access it:** MIT-licensed npm SDK (`worldmonitor`, alias `wm`), or MCP server (`worldmonitor.app/mcp`), or REST API (`api.worldmonitor.app`, OpenAPI spec). No API key needed for `tools/list`; paid tier ($39.99/mo Pro or $99.99/mo API Starter) for `tools/call` beyond free quota.
- **License:** SDKs (npm/Python/Ruby/Go) are **MIT** — safe to embed in Samurai (Apache/proprietary-friendly). The WorldMonitor **platform/server/dashboard** is **AGPL-3.0-only** — do NOT self-host it or copy server-side code; only use the client SDK + public API.
- **Don't copy source code from the repo** into Samurai (AGPL). **Do** reimplement the convergence-detection *algorithm* from the spec in §2 below — the algorithm is not copyrightable, the implementation is.
- **Sizing:** One wayfinder map → one adapter module + tests. Treat as a Stage 0 Market Intelligence enhancement, not a new pipeline stage.

---

## 1. Why WorldMonitor fits Samurai's Market Intelligence layer

### 1.1 What Samurai's MI spec needs (from `docs/specs/market-intelligence-spec.md`)

- Aggregate professional news + social sentiment across multiple sources (stories 6-10)
- Normalize all sources to UTC, tag by asset class (crypto/stocks), extract entities (stories 8-10)
- Detect cross-source conflicts and resolve by priority rules (stories 11-14)
- Deliver structured `IntelligenceItem`s to analysts via pull/push (stories 15-18)
- Operate within latency budgets: 5s crypto, 30s stocks (story 19)
- Support backtest replay via a sidecar SQLite store with no-lookahead cursor (stories 26-34)
- DeepResearch agent (Bloomberg/Reuters/SEC/earnings) + Grok agent (Twitter/Reddit) with DeepResearch priority on conflicts

### 1.2 What WorldMonitor already provides that overlaps Samurai's needs

| Samurai MI need | WorldMonitor coverage | Source |
|---|---|---|
| Multi-source professional news aggregation | 500+ curated feeds across 15 categories, 65+ external providers, 35 freshness-tracked source groups | README, AGENTS.md, `docs/data-sources.mdx` |
| Cross-source conflict detection | `detectConvergence` (≥3 source types in 60min), `detectTriangulation` (wire+gov+intel), `prediction_leads_news`, `silent_divergence` | `src/services/analysis-core.ts` (verified by source-code read) |
| Normalized structured output | Proto-defined API contracts (281 protos, 35 services), OpenAPI spec, MCP tools catalog | `proto/`, `public/openapi.yaml` |
| Real-time continuous operation | Background ingestion loops, 4-layer caching, freshness monitor | ARCHITECTURE.md |
| Agent-addressable access (for the MCP-native world) | MCP server (`worldmonitor.app/mcp`, Streamable HTTP), `llms.txt`, agent-skills manifest | README, CONCEPTS.md §MCP |
| Macro/geopolitical tail risk (Samurai doesn't have) | Country Instability Index (CII v8) for 31 Tier-1 countries, strategic risk scores, escalation signals | `shared/cii-weights.ts`, `server/worldmonitor/intelligence/v1/_risk-config.ts` |

### 1.3 Where WorldMonitor does NOT cover Samurai's needs (gaps to keep separate)

- **Ticker-specific financial news:** WorldMonitor is geopolitics/macro/infrastructure-focused. It does NOT cover SEC filings, earnings reports, or company-specific press releases the way Samurai's DeepResearch agent must. WorldMonitor's finance radar covers *price* data (29+ stock exchanges, commodities, crypto), not company-level fundamentals.
- **Per-item sentiment scoring:** WorldMonitor aggregates and detects convergence but its AI "synthesis" produces briefs, not structured bullish/neutral/bearish per-item sentiment scores that Samurai's `IntelligenceItem.sentiment` field requires. Sentiment classification stays Samurai's job (Grok agent).
- **Retail trading social sentiment:** WorldMonitor's social tier is geopolitical Twitter/Telegram, not r/wallstreetbets or r/cryptocurrency. Different community, different signal.
- **Self-hosted feed infrastructure:** WorldMonitor's RSS/feed layer is tightly coupled to Vercel Edge + Upstash Redis. Samurai is Node.js on a Mac. Reimplement, don't reuse the feed pipeline.

**Implication:** WorldMonitor is a *third* MI source — the macro/geopolitical layer — sitting alongside DeepResearch (company/ticker news) and Grok (retail social sentiment). It does not replace either.

---

## 2. The convergence algorithm to reimplement (the real prize)

WorldMonitor's `src/services/analysis-core.ts` (752 lines, verified by source-code read) implements cross-stream joint detection that is **strictly more sophisticated** than Samurai's current 2-agent priority-rule Conflict Resolution Engine. Reimplement this algorithm in Samurai. **Do not copy the code** (AGPL); reimplement from this spec.

### 2.1 Core data structures

```typescript
// A snapshot of all streams at a moment in time, diffed against the previous cycle
interface StreamSnapshot {
  newsVelocity: Map<string, number>;        // topic -> items-per-window
  marketChanges: Map<string, number>;       // symbol -> price change %
  predictionChanges: Map<string, number>;    // prediction-market title -> yesPrice
  topicVelocityHistory: Map<string, TopicVelocityPoint[]>;
  timestamp: number;
}
```

### 2.2 Signal types (typed outputs)

| Signal type | Trigger | Confidence |
|---|---|---|
| `convergence` | ≥3 distinct `SourceType`s report the same clustered event within 60-min window | `min(0.95, 0.6 + sourceTypes × 0.1)` |
| `triangulation` | wire + gov + intel **all three** align on one event | fixed 0.9 |
| `prediction_leads_news` | Prediction-market shift ≥ threshold **with no corresponding news velocity** on related topics (the absence is the signal) | per-shift |
| `silent_divergence` | Market moves without any news | per-shift |
| `flow_price_divergence` | Market move cross-referenced against news + prediction snapshots, diverging | per-shift |
| `explained_market_move` | Market move cross-referenced and explained by news + predictions | per-shift |

### 2.3 Source type taxonomy (WorldMonitor's, adopt or adapt)

`wire | gov | intel | social | regional | other`

Map Samurai's sources onto this taxonomy:
- DeepResearch (Bloomberg/Reuters/SEC) → `wire` + `gov`
- Grok (Twitter/Reddit) → `social`
- WorldMonitor adapter (geopolitical feeds) → `intel` + `regional`

### 2.4 Spatial clustering (for geo-tagged signals)

WorldMonitor uses **grid-indexed union-find** for O(n·k) proximity clustering (`clusterByProximity`), with haversine distance and a configurable radius. For each cluster:
- Aggregate max severity per signal type
- Weighted sum of per-type maxima
- Capped diversity bonus: `min(30, max(0, (uniqueTypes - 2)) × 12)`
- Final score: `min(100, weightedSum + diversityBonus)`

### 2.5 Trend detection (across cycles)

Keep previous cycle's clusters; match by country, entityKey, or centroid-within-half-radius; compute score delta; classify `escalating` (delta > 5), `de-escalating` (delta < -5), or `stable`.

### 2.6 Why this is an upgrade over Samurai's current spec

Samurai's MI spec resolves DeepResearch vs Grok conflicts with static priority rules (high-impact → DeepResearch wins; viral → Grok wins). WorldMonitor's approach:
1. Detects **n-source convergence** (not just 2-agent conflict) — more sources agreeing = higher confidence, monotonically.
2. Detects **absence signals** (`prediction_leads_news`, `silent_divergence`) — the market/prediction moving *without* news is itself a signal Samurai's current design cannot express.
3. Produces **trend direction** across cycles (escalating/de-escalating), which Samurai's analysts can consume as conviction modifiers.

**Recommendation:** Replace Samurai's Conflict Resolution Engine with a generalized multi-source convergence engine modeled on this algorithm. DeepResearch and Grok become two of N sources; WorldMonitor becomes a third.

---

## 3. The CII as a Risk Manager soft signal

### 3.1 What it is

WorldMonitor's Country Instability Index (CII v8) is a per-country composite score (0-100) for 31 Tier-1 countries, refreshed continuously. Formula (verified against `shared/cii-weights.ts` + `server/worldmonitor/intelligence/v1/_risk-config.ts`):

```
composite = baselineRisk × 0.40 + eventScore × 0.60
```

Where:
- `baselineRisk` is a hand-set editorial constant per country (e.g., US=5, RU=35, UA=50, IR=40, IL=45, KP=45)
- `eventScore` is driven by 4 signal families (Unrest 25% / Conflict 30% / Security 20% / Information 25%) plus 11 optional capped boosts and 4 score floors (UCDP/State-Dept)
- `methodology_version` is emitted on every score so API clients can detect drift

### 3.2 Critical caveat — READ THIS BEFORE USING

The CII is **editorial, not empirical**. The source file opens with this disclaimer, verbatim:

> *"These constants drive the published Composite Instability Index (CII)... They are EDITORIAL WEIGHTS authored by the WorldMonitor intelligence team — NOT derived from a published academic index, peer-reviewed paper, or external risk product. Treat them as opinionated, not empirical."*

**No backtest has ever been published** across 8 formula versions. The honesty is test-enforced (CI asserts the public doc lists every coefficient + a per-version SHA-256 hash), but the *correctness* of the weights is unfalsifiable.

**Implication for Samurai:** Use CII as a **soft macro signal** in the Risk Manager — e.g., reduce position sizing on assets in high-CII countries, or surface a "macro risk elevated" warning to the Verdict stage. **Do NOT** use it as a hard circuit-breaker or as a primary trading signal. It is one opinionated composite, not a validated risk model.

### 3.3 Specific Risk Manager integration points (from `docs/specs/risk-manager-spec.md`)

- Feed CII into the **correlation check**: if Samurai holds positions in assets tied to high-CII countries (e.g., Russian ADRs, Middle East energy), flag elevated systemic risk.
- Surface CII spikes as a **soft input to position-size caps**: e.g., scale max position size by `(1 - ciiDelta × k)` when a country's CII jumps > 10 points in a cycle.
- **Never** let CII override a hard circuit-breaker (max drawdown, max daily loss). It's context, not a gate.

---

## 4. Integration design for Samurai

### 4.1 New module: WorldMonitor Adapter

Location: `src/market-intelligence/worldmonitor-adapter/` (new)

```
src/market-intelligence/
├── worldmonitor-adapter/
│   ├── client.ts          # thin wrapper over `worldmonitor` npm SDK or REST API
│   ├── normalizer.ts       # WorldMonitor items -> Samurai IntelligenceItem
│   ├── adapter.ts          # implements the same Agent interface as DeepResearch/Grok
│   ├── cii-consumer.ts     # pulls CII scores, emits to Risk Manager bus
│   ├── client.test.ts
│   ├── normalizer.test.ts
│   └── adapter.test.ts
```

### 4.2 Access strategy

**Primary: npm SDK (`worldmonitor`, MIT).** Install via `npm i worldmonitor`. Zero license risk, TypeScript-native, mirrors the MCP tool catalog.

```typescript
// Pseudocode — verify against the live SDK before implementing
import { WorldMonitor } from 'worldmonitor';
const wm = new WorldMonitor({ apiKey: process.env.WORLDMONITOR_API_KEY });

// List available tools (no key needed)
const tools = await wm.tools.list();

// Pull macro convergence signals
const signals = await wm.risk('IR');          // Iran CII + context
const news = await wm.news({ region: 'MENA', window: '1h' });
```

**Fallback: REST API.** Base `https://api.worldmonitor.app`, OpenAPI spec at `worldmonitor.app/openapi.yaml`. Use if the SDK lacks a needed endpoint.

**Do NOT use MCP transport directly** for the MVP — the MCP server (`worldmonitor.app/mcp`, Streamable HTTP) is designed for agent-to-tool discovery, and Samurai's MI layer is a deterministic pipeline, not an agent. The SDK/REST path is simpler. (MCP can be revisited if Samurai later wants agent-driven ad-hoc queries.)

### 4.3 Normalization into Samurai's schema

WorldMonitor items must map to Samurai's `IntelligenceItem`:

```typescript
interface IntelligenceItem {
  id: string;            // 'wm:' + worldmonitor-item-id
  source: string;        // 'worldmonitor:' + feed-name
  type: 'news' | 'sentiment';  // WorldMonitor is 'news' (not per-item sentiment)
  timestamp: Date;       // WorldMonitor pubDate (already UTC)
  entity: string;        // country code, ticker, or topic
  headline: string;
  sentiment: 1 | 0 | -1; // WorldMonitor does NOT classify this — default 0 (neutral) and let Grok overlay sentiment
  confidence: number;    // use WorldMonitor convergence confidence if available, else 0.5
  summary?: string;
  url?: string;
}
```

**Sentiment gap:** WorldMonitor does not produce per-item sentiment. Set `sentiment = 0` (neutral) for WorldMonitor items and let the Grok agent (or a downstream sentiment pass) overlay bullish/bearish classification. WorldMonitor's value is the *convergence* and *entity extraction*, not sentiment.

### 4.4 Conflict resolution interaction

WorldMonitor items enter Samurai's convergence engine as a third source type (`intel` / `regional`). The existing DeepResearch-vs-Grok priority rules generalize to:
- High-impact geopolitical event + WorldMonitor `triangulation` (wire+gov+intel align) → high confidence, DeepResearch priority on company-specific follow-through
- WorldMonitor `silent_divergence` (market moves without news) → flag to Risk Manager as "unexplained move" warning
- WorldMonitor `prediction_leads_news` → surface to analysts as "prediction market leading the news"

### 4.5 Backtest replay (from MI spec stories 26-34)

WorldMonitor items must flow through the same sidecar SQLite capture as DeepResearch and Grok outputs. The adapter's normalized `IntelligenceItem`s are pushed to the replay store on emit. The no-lookahead invariant (`timestamp <= clock.now()`) is enforced at the cursor, same as other sources.

**Caveat:** WorldMonitor's free API rate limits and 90-day replay window (Samurai's spec) mean backtest history of WorldMonitor signals accumulates only from the moment Samurai starts capturing. Older market regimes are not covered. This is acceptable per the MI spec's retention section.

### 4.6 Failure handling (graceful degradation)

Per MI spec story 21: if the WorldMonitor adapter fails (API down, rate-limited, key expired), it emits empty intelligence and the pipeline continues with DeepResearch + Grok only. Treat WorldMonitor as supplementary macro context, never as a blocking dependency. Log failures, alert on sustained outage (> 5 min), but do not block the tick loop.

---

## 5. Architecture patterns to steal from WorldMonitor's CONCEPTS.md

WorldMonitor's internal engineering glossary (`CONCEPTS.md`, verified by source-code read) documents caching/egress patterns directly relevant to Samurai's Orchestrator + Market Data Service. Adopt these as design constraints, not code.

### 5.1 One-Shot Hydration ⚠️ directly relevant to Samurai's stateless-analyst design

> A hydrated value can be read exactly once, and reading it consumes it. Any *recurring* reader (a periodic refresh tick, a retry) is guaranteed to miss hydration and fall through to whatever fallback path exists. When that fallback is not CDN-shielded, one-shot hydration plus a refresh timer silently manufactures origin traffic.

**Samurai implication:** If the Market Data Service or MI layer uses one-shot boot hydration for the first tick's data, every subsequent tick's refresh will miss and hit the origin (Alpaca/Polygon/WorldMonitor API). For a stateless-per-tick analyst design with a fast crypto cadence (5s), this can rate-limit or cost-blow. **Design the data layer for repeatable reads** (cached, TTL'd), not one-shot hydration.

### 5.2 The Lever Test

> Egress ≈ origin-miss count × transferred payload size. A proposed optimization reduces egress only if it reduces the miss rate or the bytes per miss.

**Samurai implication:** When sizing Samurai's cache tier (the spec mentions SQLite for state, Redis not yet decided), evaluate any caching optimization against this formula. Deduplicating stored bytes while both read paths survive nets zero. Use this test before scoping any bandwidth work.

### 5.3 Shadow Measurement

> Run a candidate read path against real production traffic while continuing to serve from the incumbent — the candidate's result is timed and discarded, never delivered.

**Samurai implication:** For the paper→live cutover (and for the broker abstraction switch from Alpaca to ccxt/IBKR), use shadow measurement: run the new path alongside the old on live ticks, compare latency/fills, cut over only when the candidate clears its gate on Samurai's own traffic — not on vendor benchmarks.

### 5.4 Deferred-Shell Contract

> A footprint-matched placeholder shell must occupy a panel's exact grid slot from the first synchronous layout pass.

**Samurai implication:** Only relevant if Samurai's CLI dashboard (`src/cli/`) renders a live-updating table/grid. Reserve the slot before async data arrives to avoid layout shift. Minor, but documented here for completeness.

---

## 6. Risks and open questions for the wayfinder map

These must be resolved as wayfinder tickets before implementation. Do not skip.

1. **API key tier decision.** Free tier allows `tools/list` (discovery) but `tools/call` is gated behind Pro ($39.99/mo, 50 calls/day) or API Starter ($99.99/mo, higher quota). **Decision needed:** which tier covers Samurai's per-tick query cadence (5s crypto / 30s stocks)? At 30s stock cadence over 6.5h market hours = 780 calls/day — exceeds Pro's 50/day. API Starter's daily quota (check `worldmonitor.app/docs/pricing`) is the floor. Cost-benefit vs building the feed aggregation ourselves must be explicit in the ADR.
2. **Data-licensing provenance.** WorldMonitor aggregates ACLED, UCDP, and other providers whose commercial-redistribution terms are not publicly verified (see research report §10 gap 3). Samurai is *consuming* via API, not redistributing — likely fine — but confirm WorldMonitor's ToS permits API consumption for a commercial trading system before depending on it.
3. **Single-maintainer dependency.** WorldMonitor is effectively one person (Elie Habib). If the API changes or the project goes dormant, Samurai's MI layer degrades. Mitigation: keep WorldMonitor as one of three MI sources so degradation is graceful, and wrap the adapter behind Samurai's existing `BrokerAdapter`-style abstraction so it can be swapped.
4. **CII backtest absence.** No CII backtest exists (research report §6, §13.2). Before using CII in the Risk Manager, decide: (a) treat as soft signal only (recommended), or (b) run Samurai's own historical correlation of CII spikes vs asset drawdowns before trusting it. Option (b) is a separate research ticket.
5. **AGPL boundary.** Reaffirm in the ADR: Samurai embeds the MIT npm SDK only. No WorldMonitor server code is copied or self-hosted. If a contributor ever copies WorldMonitor source into Samurai, AGPL contamination is a risk. Add a lint rule or CONTRIBUTING note.
6. **Latency.** WorldMonitor's API latency for `tools/call` is not published. Measure it in the spike before committing to the 5s crypto cadence — if p99 > 2s, it can't serve the crypto tick loop and must be used for the 30s stock path only.
7. **Rate-limit backoff.** WorldMonitor uses Upstash rate-limiting on its side (verified in `api/_rate-limit.js`). Samurai's adapter must respect 429s with exponential backoff and degrade to empty intelligence (not block the tick), per MI spec story 20.

---

## 7. Recommended implementation sequence

Per CLAUDE.md Standing Pipeline Rule 1: wayfinder map before implementation.

1. **Wayfinder map** (GitHub issue, label `wayfinder-map`): "Integrate WorldMonitor as Market Intelligence source" with child tickets:
   - `wayfinder:research` — API quota + latency spike (hit `tools/list`, measure `tools/call` p99, confirm tier needed)
   - `wayfinder:research` — ToS review for commercial API consumption
   - `wayfinder:prototype` — npm SDK install + minimal adapter emitting one normalized `IntelligenceItem` from a `news` call
   - `wayfinder:grilling` — CII soft-signal policy (how Risk Manager consumes it, what overrides what)
   - `wayfinder:task` — Reimplement convergence algorithm from §2 above (no code copy)
2. **Spec update** (`docs/specs/market-intelligence-spec.md`): add WorldMonitor as a third MI agent, generalize Conflict Resolution Engine to N-source convergence.
3. **ADR** (`docs/adr/`): "WorldMonitor as MI source — MIT SDK, no self-host, soft-signal CII" — record the AGPL boundary, tier decision, and single-maintainer mitigation.
4. **Tickets** (`/to-tickets`): implementation issues for the adapter module, normalizer, CII consumer, convergence-engine upgrade, tests.
5. **Implementation** via `/implement` + `/code-review` per CLAUDE.md Rule 3, fable-mode discipline (Rule 4).

---

## 8. Source verification

All claims in this handoff are backed by direct source-code read (`git clone --depth 1` of WorldMonitor HEAD, 2026-07-22) or primary documentation. Key files verified:

- `shared/cii-weights.ts` — 31-entry hand-tuned CII country weights (confirms editorial nature)
- `server/worldmonitor/intelligence/v1/_risk-config.ts` — CII formula + editorial disclaimer (verbatim)
- `src/services/analysis-core.ts` (752 lines) — convergence/triangulation/prediction-leads-news algorithm
- `src/services/correlation-engine/engine.ts` (471 lines) — clustering + scoring + LLM assessment
- `tests/cii-scoring.test.mts` + `tests/cii-docs-drift.test.mjs` — CI-enforced methodology honesty
- `CONCEPTS.md` — engineering vocabulary (The Lever Test, One-Shot Hydration, Shadow Measurement)
- `package.json` — 6 variants via `VITE_VARIANT`, MIT SDK confirmation
- `AGENTS.md` — 163 components, 80+ edge endpoints, 35 freshness groups
- `proto/` — 281 proto files, 35 services (filesystem count)
- `docs/data-sources.mdx` — 25 provider-category headings (disambiguates "65+ providers")
- `docs/license.mdx` + `LICENSE` — AGPL-3.0-only platform, MIT client SDKs

Full deep-analysis report with confidence scores, gap analysis, and further reading:
`~/Documents/Obsidian/research/worldmonitor-2026-07-22-report.md` (44 KB, 13 sections)

---

## 9. Quick reference — WorldMonitor access surface

| Surface | URL / package | Auth | License | Use for |
|---|---|---|---|---|
| npm SDK | `npm i worldmonitor` (alias `wm`) | API key for `tools/call` | **MIT** | Primary integration path |
| Python SDK | `pip install worldmonitor-sdk` | API key | **MIT** | (not needed for TypeScript Samurai) |
| REST API | `https://api.worldmonitor.app` | `X-WorldMonitor-Key` header | OpenAPI spec (consumable) | Fallback if SDK lacks endpoint |
| MCP server | `https://worldmonitor.app/mcp` | OAuth or `X-WorldMonitor-Key` | Streamable HTTP | Agent-driven ad-hoc (not MVP) |
| OpenAPI spec | `https://worldmonitor.app/openapi.yaml` | none | — | Contract reference |
| Agent discovery | `https://worldmonitor.app/llms.txt` | none | — | Tool catalog discovery |
| Pricing | `https://www.worldmonitor.app/docs/pricing` | — | — | Free / Pro $39.99 / API Starter $99.99 / API Business $249.99 / Enterprise |
| Platform source | `https://github.com/koala73/worldmonitor` | — | **AGPL-3.0-only** | DO NOT self-host or copy server code |

**Key reminder:** MIT covers the SDK client packages only (`cli/`, `sdk/python/`, `sdk/ruby/`, `sdk/go/`). The platform/server/dashboard stays AGPL. Samurai embeds the client, consumes the API, and never touches the server. This is the license split explicitly decided by the WorldMonitor owner on 2026-07-05 (PR #4882).
