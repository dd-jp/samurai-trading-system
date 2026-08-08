# Research Index — Samurai Trading System

**Maintained:** 2026-08-08 (consolidation pass). House convention: numbered research docs are append-only artifacts; this index is the navigation layer. Superseded verdicts are archived by pointer, never deleted.

## Live frontier (read these first)

| Topic | Current doc | Status |
|---|---|---|
| **Edge hypothesis (Stage 0)** | `14-stage0-edge-hypothesis-2026-08-07.md` | RECORDED — the stated, falsifiable hypothesis. C1/C2/E2/E1 defined here |
| **Trend measurement** | `13-trend-signal-measurement-2026-08-07.md` | MEASURED — 10.2yr, 16 pre-registered configs, trend vs always-long control |
| **Hypothesis evaluation** | `15-edge-hypothesis-evaluation-2026-08-07.md` + **`../reviews/edge-hypothesis-evaluation-audit-2026-08-08.md`** | REVIEWED — body preserved with errata banner; audit D1-D7 + omission is authoritative (code-verified); use audit's replacement gate order, not the doc's gate list verbatim |
| **Crypto/LLM opportunities** | `16-crypto-premia-llm-layer-2026-08-08.md` | REJECTED crypto carry (FCA) + momentum (N=2); LLM = shadow-mode only |
| **Stage 2 verdict chain** | `15-stage2-verdict-free-stack-2026-08-07.md` | KILL on proxy (10.2yr) — proxy ≠ hypothesis |
| **Market intelligence** | `14-mi-layer-alternatives-2026-08-07.md` + `15-mi-source-licensing-2026-08-07.md` | DECIDED direction: Alpaca News + GDELT + calendar spine; Massive/Guardian killed |
| **Data vendors** | `free-ohlcv-fallback-sources-2026-08-06.md` (+ `03`, `alpaca-*`, `polygon-*`, `free-*` as reference) | SETTLED: Alpaca SIP equities, Coinbase crypto, free stack |
| **Dashboard** | `13-dashboard-framework-and-hosting-2026-08-06.md` + `docs/adr/0010-dashboard-vite-react-rewrite.md` | DECIDED |
| **Stack** | `techstack.md` | LIVING |

## Strategy / edge track (decision chain)

| Doc | Date | What it is | Superseded by |
|---|---|---|---|
| `00-summary.md` | 2026-07 | Strategy eval summary | — (context) |
| `01-full-report-with-sources.md` | 2026-07 | Full strategy-eval research (edges, overfitting, metrics) | — (context) |
| `02-staged-deployment-plan.md` | 2026-07 | Stage 0-4 deployment plan, kill lines | — (living reference; Stage 0 gate closed by 14-) |
| `05-tradingagents-risk-debate-finding.md` | 2026-07-25 | TradingAgents 3-persona risk debate — grilling question | — (open finding) |
| `06-stage2-overfitting-verdict.md` | 2026-07-29 | Stage 2 "no verdict" — inputs didn't exist | `12-stage2-pbo-dsr-first-computation` |
| `07-stock-selection-manipulation-guardrails.md` | 2026-08-02 | Universe-selector manipulation guardrails | — (future Stage 0) |
| `08-stage2-verdict-first-real-run-2026-08-05.md` | 2026-08-05 | First live-data run; cost attribution focus | `11-stage2-verdict-post-405` |
| `09-stage2-cost-decomposition-2026-08-05.md` | 2026-08-05 | Gross vs net: 2/24 vs 16/24 pass — kill is cost-model artifact | `10-`/`11-` |
| `10-cost-model-calibration-2026-08-05.md` | 2026-08-05 | Calibrated costs, 14/24 pass | `11-stage2-verdict-post-405` |
| `11-pitfalls-and-improvements-2026-08-05.md` | 2026-08-05 | Pitfalls from runs (fixture-cost, zero-padding, etc.) | — (lessons) |
| `11-stage2-verdict-post-405-2026-08-06.md` | 2026-08-06 | KILL/INCOMPLETE on 1.99yr; sample-length = open lever | `15-stage2-verdict-free-stack` |
| `12-stage2-pbo-dsr-first-computation-2026-08-05.md` | 2026-08-05 | PBO 0.65/0.30, DSR 0.26/0.52 — both reject | `15-stage2-verdict-free-stack` |
| `13-trend-signal-measurement-2026-08-07.md` | 2026-08-07 | **The measurement** — trend vs control, t=0.15, Result 5 post-hoc | — (evidence base) |
| `14-stage0-edge-hypothesis-2026-08-07.md` | 2026-08-07 | **The hypothesis** — C1/C2/E2/E1, E1 adopted | — (living) |
| `15-edge-hypothesis-evaluation-2026-08-07.md` | 2026-08-07 | **The review** — gates, falsifiers, defects, omission | — (living) |
| `15-stage2-verdict-free-stack-2026-08-07.md` | 2026-08-07 | **KILL on proxy, 10.2yr** — proxy ≠ hypothesis; next = replace proxy with doc-14 strategy | — (terminal for proxy) |
| `16-crypto-premia-llm-layer-2026-08-08.md` | 2026-08-08 | Crypto carry rejected (FCA), momentum rejected (N=2), LLM shadow-mode | — (living) |

## Market-intelligence track

| Doc | What it is | Status |
|---|---|---|
| `04-worldmonitor-as-mi-source.md` | WorldMonitor adapter handoff (2026-07-22) | PARTIALLY FALSIFIED by 13-live-news (pricing) |
| `13-live-news-sources-and-worldmonitor-value-2026-08-07.md` | Alpaca News = biggest free win; WorldMonitor parked | ADOPT (fed into 14-) |
| `14-mi-layer-alternatives-2026-08-07.md` | Deterministic ingestion architecture: Alpaca News + GDELT raw + calendar spine + RSS; decouple retrieval from scoring | RECOMMENDED (needs ADR) |
| `15-mi-source-licensing-2026-08-07.md` | Primary-source licensing: Alpaca KEEP, GDELT KEEP, Massive KILL, Guardian KILL; commercial-use question for David | DECIDED (v1 viable) |
| `polymarket-mi-source-2026-08-06.md` | Polymarket read access, #481 adopted | ADOPTED |

## Data-vendor track

| Doc | What it is | Status |
|---|---|---|
| `03-historical-data-vendor-options.md` | Vendor depth/pricing survey; Polygon paid rec (superseded) | SUPERSEDED by free stack |
| `alpaca-rest-api-surface-2026-07-29.md` | Alpaca REST surface | REFERENCE |
| `polygon-aggregates-api-2026-07-31.md` | Polygon aggregates surface | REFERENCE |
| `free-crypto-ohlcv-2026-08-06.md` | Coinbase/Bitstamp free crypto history | ADOPTED |
| `free-equities-ohlcv-2026-08-06.md` | Alpaca free SIP equities history | ADOPTED |
| `free-ohlcv-fallback-sources-2026-08-06.md` | Free-stack fallback matrix | ADOPTED |

## Infra / ops track

| Doc | What it is | Status |
|---|---|---|
| `12-soak-readiness-2026-08-06.md` | Paper-soak gate: boots, transacts, ADR-0008 budget | GATE PASS |
| `13-dashboard-framework-and-hosting-2026-08-06.md` | Dashboard framework decision | DECIDED (ADR-0010) |
| `techstack.md` | Living stack reference | LIVING |
| `trading-agent-handover.md` | Scoping brief (2026-07) | HISTORICAL |

## Supersession rules

1. **Never delete** — numbered docs are audit artifacts, referenced by issues/PRs/specs.
2. A doc is superseded only by a named successor; the successor states what it replaces.
3. The index's "Live frontier" table is the canonical entry point for new readers.
4. When a new Stage 2 pass runs on the doc-14 strategy (premium harvest), add it to the strategy track and update the frontier table — the proxy KILL (`15-stage2-verdict-free-stack`) does NOT apply to the hypothesis.
