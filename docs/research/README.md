# Research index — Samurai

**Consolidated 2026-08-08.** 37 files became 20. Nothing was deleted — superseded work moved to [`archive/`](archive/) with a pointer back to its successor.

## Conventions

**Live docs are `NN-slug.md`** — no date suffix, unique number, banded by track:

| Band | Track |
|---|---|
| `00`–`02` | Foundations — **numbers frozen**, specs cite them as "docs 00/01/02" by number with no path |
| `10`–`19` | Strategy / edge |
| `20`–`29` | Market intelligence |
| `30`–`39` | Data vendors |
| `40`–`49` | Infra / tooling |

**Archived docs are `archive/YYYY-MM-DD-slug.md`** — date first, no number, because they are dated artifacts rather than index entries. Raw run logs live in [`archive/raw/`](archive/raw/).

Rules:

1. **Never delete.** Archived docs are the audit trail behind live-money decisions and are preserved byte-for-byte apart from a single successor pointer under the title.
2. **A doc is superseded only by a named successor, and the pointer lives in the doc** — not only here. An archived file must tell a reader who arrives via search or a stale link that it has been replaced.
3. **New research takes the next free number in its band.** Never reuse a number; never add a date suffix to a live doc.
4. **The Stage 2 proxy KILL does not apply to the hypothesis.** When a Stage 2 pass finally runs on the doc-10 strategy, it is a new doc in the `10`s, not an update to doc 13.

## Live frontier — read these first

> **The recorded Stage 0 thesis is no longer in this folder (2026-08-09).** [#632](https://github.com/dd-jp/samurai-trading-system/issues/632) recorded **`CONTEXT.md`'s debate-as-edge thesis at an intraday, flat-by-close horizon**, and superseded docs 10 and 12 **on horizon** — David requires intraday; both describe a weeks-to-months, monthly-rebalance strategy. Doc 12's gate 2 architecture ADR resolves to **"neither"**. Read `CONTEXT.md` for the claim; the docs below for the evidence that still stands.

| Topic | Doc | Status |
|---|---|---|
| **The hypothesis** | [`10-edge-hypothesis.md`](10-edge-hypothesis.md) | **SUPERSEDED ON HORIZON** (#632) — not on quality. Measurements, C1/C2/E2 eliminations and the "targets set from desire" forbid all still stand |
| **The measurement** | [`11-trend-signal-measurement.md`](11-trend-signal-measurement.md) | MEASURED — 10.0y, 16 pre-registered configs, trend vs always-long control. **Daily bars, monthly rebalance: does not transfer to intraday** |
| **The critique** | [`12-edge-hypothesis-critique.md`](12-edge-hypothesis-critique.md) | **Gate 2 resolved (#632) — "neither".** D1/D2/D4/D6 and the no-implementation finding transfer; the doc-10-vs-long-gamma dispute is moot |
| **Stage 2 proxy** | [`13-stage2-proxy-verdict.md`](13-stage2-proxy-verdict.md) | KILL, terminal — and it is about a proxy, not the hypothesis |
| **Crypto / LLM** | [`15-crypto-premia-and-llm-layer.md`](15-crypto-premia-and-llm-layer.md) | Carry rejected (FCA), momentum rejected (N=2), LLM shadow-mode only |
| **Market intelligence** | [`20-mi-decisions.md`](20-mi-decisions.md) | DECIDED — Alpaca News + GDELT + calendar spine; Massive and Guardian killed |
| **Data vendors** | [`30-data-vendor-decisions.md`](30-data-vendor-decisions.md) | SETTLED — the whole historical stack runs at £0 |
| **Stack register** | [`../techstack.md`](../techstack.md) | LIVING — moved out of `research/`; it is a register, not a dated artifact |

## The live set

**Foundations** — [`00-summary.md`](00-summary.md), [`01-full-report-with-sources.md`](01-full-report-with-sources.md), [`02-staged-deployment-plan.md`](02-staged-deployment-plan.md). Strategy-evaluation research and the stage-gated deployment plan. Doc 02 is the source of the kill line every Stage 2 verdict cites.

**Strategy / edge** — `10` hypothesis, `11` measurement (+ `11-trend-signal-measurement.py`), `12` critique, `13` Stage 2 proxy verdict, [`14-backtest-pitfalls.md`](14-backtest-pitfalls.md), `15` crypto/LLM, [`16-risk-debate-finding.md`](16-risk-debate-finding.md) (open finding, not a decision), [`17-universe-manipulation-guardrails.md`](17-universe-manipulation-guardrails.md).

**Market intelligence** — `20` decisions, [`21-mi-ingestion-architecture.md`](21-mi-ingestion-architecture.md), [`22-mi-source-licensing.md`](22-mi-source-licensing.md), [`23-polymarket-source.md`](23-polymarket-source.md).

**Data vendors** — `30` decisions, [`31-free-ohlcv-evidence.md`](31-free-ohlcv-evidence.md), [`32-vendor-api-reference.md`](32-vendor-api-reference.md).

**Infra** — [`40-dashboard-framework-and-hosting.md`](40-dashboard-framework-and-hosting.md). The paper-soak gate passed 2026-08-06 (typecheck/lint/build clean, 2282 tests, `yarn smoke` PASS, $50/14d budget, 15-min ticks) — record in [`archive/2026-08-06-soak-readiness.md`](archive/2026-08-06-soak-readiness.md). Three caveats stand: the mechanical layer has no demonstrated edge, two of three analysts run on an empty store, and three built learning layers are still unfed (#435, #465, #328).

## Open questions — unresolved, and someone has to decide

1. ~~**Tick cadence: daily or 15-minute?**~~ **Half-resolved 2026-08-09 (#632).** The daily-tick argument came from [`10-edge-hypothesis.md`](10-edge-hypothesis.md)'s weeks-to-months horizon, now superseded — the recorded thesis is **intraday**, so a daily tick is off the table and ADR-0008's 15 minutes is the floor, not a choice. What replaces the question is **catalyst-gating**: on the recorded £1,500 book (£750 equity / £750 crypto), running the debate on every 15-minute tick costs **~£862/yr** of LLM spend, while conservative catalyst-gating (~40 passes/day) costs **~£116/yr** — against a **projected** ~£1,226/yr gross, i.e. ~70% of gross versus ~9%. Both cost figures and the £1,226 come from [#660](https://github.com/dd-jp/samurai-trading-system/issues/660) (cadence/cost table in the body; the £1,500 split and its projected return in the resolution comment); the earlier ~£627/yr figure in [#658](https://github.com/dd-jp/samurai-trading-system/issues/658) is superseded — it was computed at £1,000 on trade counts #660 corrects. **The gross figure is a conditional projection, not a measurement.** It rests on an assumed 55% blended win rate that has never been observed — #625 measured the selector at 96 debates and 0 trades — and #660's own sensitivity shows the blended edge inverting below ~50%. Read it as "sufficient *if* the selector works", per doc 10's forbid on targets set from desire rather than measurement. **Now owned by #658 and [#657](https://github.com/dd-jp/samurai-trading-system/issues/657).**
2. **Is Samurai "commercial"?** Private, single-user, real money, for profit. Gates Alpaca's 30-day notice; blocks nothing in v1.
3. **Massive's derivative-works clause on OHLCV bars already in live use** — the only licensing finding that reaches shipped code.
4. **Dashboard authentication** — `GET /api/snapshot` serves positions, P&L and LLM spend with zero auth. Precondition on any exposure.
5. **PBO on the Result 5 config** — named the binding gate by three docs, still uncomputed.
6. **The measured strategy has no implementation in `src/`** — an architecture ADR sits upstream of every validation gate.
7. **The persistent-`dbPath` fix** — Polygon equities failover is wrong until it lands.

## Old → new map

Closed GitHub issues and merged PRs cite the old paths; this table is how you resolve them.

| Old | New |
|---|---|
| `03-historical-data-vendor-options.md` | `archive/2026-07-21-historical-data-vendor-options.md` |
| `04-worldmonitor-as-mi-source.md` | `archive/2026-07-22-worldmonitor-as-mi-source.md` |
| `05-tradingagents-risk-debate-finding.md` | `16-risk-debate-finding.md` |
| `06-stage2-overfitting-verdict.md` | `archive/2026-07-29-stage2-overfitting-verdict.md` |
| `07-stock-selection-manipulation-guardrails.md` | `17-universe-manipulation-guardrails.md` |
| `08-stage2-verdict-first-real-run-2026-08-05.md` | `archive/2026-08-05-stage2-verdict-first-real-run.md` |
| `09-stage2-cost-decomposition-2026-08-05.md` | `archive/2026-08-05-stage2-cost-decomposition.md` |
| `10-cost-model-calibration-2026-08-05.md` | `archive/2026-08-05-cost-model-calibration.md` |
| `11-pitfalls-and-improvements-2026-08-05.md` | `14-backtest-pitfalls.md` (lessons) + `archive/2026-08-05-pitfalls-and-improvements.md` |
| `11-stage2-verdict-post-405-2026-08-06.md` | `archive/2026-08-06-stage2-verdict-post-405.md` |
| `12-soak-readiness-2026-08-06.md` | `archive/2026-08-06-soak-readiness.md` |
| `12-stage2-pbo-dsr-first-computation-2026-08-05.md` | `archive/2026-08-05-stage2-pbo-dsr-first-computation.md` |
| `13-dashboard-framework-and-hosting-2026-08-06.md` | `40-dashboard-framework-and-hosting.md` |
| `13-live-news-sources-and-worldmonitor-value-2026-08-07.md` | `archive/2026-08-07-live-news-sources-and-worldmonitor-value.md` |
| `13-trend-signal-measurement-2026-08-07.md` | `11-trend-signal-measurement.md` |
| `14-mi-layer-alternatives-2026-08-07.md` | `21-mi-ingestion-architecture.md` |
| `14-stage0-edge-hypothesis-2026-08-07.md` | `10-edge-hypothesis.md` |
| `15-edge-hypothesis-evaluation-2026-08-07.md` | `12-edge-hypothesis-critique.md` (corrected) + `archive/2026-08-07-edge-hypothesis-evaluation.md` |
| `15-mi-source-licensing-2026-08-07.md` | `22-mi-source-licensing.md` |
| `15-stage2-verdict-free-stack-2026-08-07.md` | `archive/2026-08-07-stage2-verdict-free-stack.md` |
| `16-crypto-premia-llm-layer-2026-08-08.md` | `15-crypto-premia-and-llm-layer.md` |
| `alpaca-rest-api-surface-2026-07-29.md` | `32-vendor-api-reference.md` + `archive/2026-07-29-alpaca-rest-api-surface.md` |
| `polygon-aggregates-api-2026-07-31.md` | `32-vendor-api-reference.md` + `archive/2026-07-31-polygon-aggregates-api.md` |
| `free-crypto-ohlcv-2026-08-06.md` | `31-free-ohlcv-evidence.md` + `archive/2026-08-06-free-crypto-ohlcv.md` |
| `free-equities-ohlcv-2026-08-06.md` | `31-free-ohlcv-evidence.md` + `archive/2026-08-06-free-equities-ohlcv.md` |
| `free-ohlcv-fallback-sources-2026-08-06.md` | `31-free-ohlcv-evidence.md` + `archive/2026-08-06-free-ohlcv-fallback-sources.md` |
| `polymarket-mi-source-2026-08-06.md` | `23-polymarket-source.md` |
| `techstack.md` | `../techstack.md` |
| `trading-agent-handover.md` | `archive/2026-07-14-trading-agent-handover.md` |
| `*.txt` run logs (7) | `archive/raw/2026-08-05-*.txt` |
| `trend-signal-measurement-2026-08-07.py` | `11-trend-signal-measurement.py` |

The four `*-track-consolidated.md` drafts written earlier on 2026-08-08 were never committed; their content is now in docs `12`, `13`, `20`, `30` and in this index.

## Corrections applied during consolidation

Where two docs disagreed and one was clearly later, the later value was adopted:

- Crypto PBO **0.30** and DSR **0.255** (not 0.35 / 0.254 — those predate the #420 fix).
- Return target **0.04%/day**. Doc 11's 0.05%/day is superseded, and the "accepted number" it cites belongs to a −45.5% drawdown arm it declares not executable.
- WorldMonitor: **$49.99 Pro Business does carry a commercial grant** — what it lacks is REST/SDK access, which starts at $99.99. The earlier draft had this backwards, and the 2026-07-22 handoff omits the tier entirely and misprices the top tier at $249.99 (it is $299.99).
- Self-hosting WorldMonitor is **viable over REST**, contradicting the handoff's blanket prohibition.
- First bars are **2016-01-04** (equities) and **2016-05-18** (ETH) — the probed values.
- The dashboard landed as **ADR-0010**, not the ADR-0009 doc 40 proposed.
- `techstack.md`'s dashboard rows now reflect Vite + React, using the replacement text doc 40 wrote and nobody applied.
