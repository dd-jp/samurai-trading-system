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
   - **The `10`–`19` strategy band is FULL as of 2026-08-17, and rule 3 is already broken once.** [`18-entry-time-conditional-brackets.md`](18-entry-time-conditional-brackets.md) (#708) shares `18` with [`18-intraday-instrument-physics.md`](18-intraday-instrument-physics.md) because there was no free number and it extends that doc's Result 4. Flagged deliberately rather than shipped quietly. **David's ruling needed:** extend the band (e.g. `10`–`19` → `10`–`29`, renumbering MI), or archive docs 10 and 12 — both already **superseded on horizon** per #632 — and reuse the numbers under an explicit exception to "never reuse".
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
| **Crypto venue fees** | [`19-crypto-venue-fees.md`](19-crypto-venue-fees.md) | RESEARCHED (#671), corrected 2026-08-10 — Crypto.com **Exchange** + 5,000 CRO is the best branch (**+0.605%/trade** vs £0 at base) and the only one independent of volume tier and maker/taker fill. The **App is a different product** and negative-expectancy. Coinbase is a real fallback (+0.25–0.45%/trade). Recorded in ADR-0015; venue gated on #673, fee tier on #667 |
| **Intraday instrument physics** | [`18-intraday-instrument-physics.md`](18-intraday-instrument-physics.md) | MEASURED (#635) — a broad tracker reaches +1% on 9.8% of days; universe is **movers**, LSE leveraged ETPs. Rests on one 3USL spread quote (#666) |
| **Entry-time brackets under truncation** | [`18-entry-time-conditional-brackets.md`](18-entry-time-conditional-brackets.md) | MEASURED (#708) — **REJECT** the entry-time/range-conditional schedule: cells are not separable at ~300 trades. Flat-by-close is the large effect (index bracket resolves 19.4% at open entry, 4.7% by t0=60). #704's ladder does **not** beat the single bracket (t = −0.20, paired). #654's ≥8.00 pp bound measures 6.38 pp |
| **Tick latency economics** | [`41-tick-latency-economics.md`](41-tick-latency-economics.md) | MEASURED (#657/#670) — τ\* = 21.8 min; drift mean-reverts, tail diffuses. ADR-0008's $3.0/day was 3.4x high |
| **Market intelligence** | [`20-mi-decisions.md`](20-mi-decisions.md) | DECIDED — Alpaca News + GDELT + calendar spine; Massive and Guardian killed |
| **Data vendors** | [`30-data-vendor-decisions.md`](30-data-vendor-decisions.md) | SETTLED — the whole historical stack runs at £0 |
| **Stack register** | [`../techstack.md`](../techstack.md) | LIVING — moved out of `research/`; it is a register, not a dated artifact |

## The live set

**Foundations** — [`00-summary.md`](00-summary.md), [`01-full-report-with-sources.md`](01-full-report-with-sources.md), [`02-staged-deployment-plan.md`](02-staged-deployment-plan.md). Strategy-evaluation research and the stage-gated deployment plan. Doc 02 is the source of the kill line every Stage 2 verdict cites.

**Strategy / edge** — `10` hypothesis, `11` measurement (+ `11-trend-signal-measurement.py`), `12` critique, `13` Stage 2 proxy verdict, [`14-backtest-pitfalls.md`](14-backtest-pitfalls.md), `15` crypto/LLM, [`16-risk-debate-finding.md`](16-risk-debate-finding.md) (open finding, not a decision), [`17-universe-manipulation-guardrails.md`](17-universe-manipulation-guardrails.md), [`18-intraday-instrument-physics.md`](18-intraday-instrument-physics.md), [`18-entry-time-conditional-brackets.md`](18-entry-time-conditional-brackets.md) (second `18` — see rule 3), [`19-crypto-venue-fees.md`](19-crypto-venue-fees.md).

**Market intelligence** — `20` decisions, [`21-mi-ingestion-architecture.md`](21-mi-ingestion-architecture.md), [`22-mi-source-licensing.md`](22-mi-source-licensing.md), [`23-polymarket-source.md`](23-polymarket-source.md).

**Data vendors** — `30` decisions, [`31-free-ohlcv-evidence.md`](31-free-ohlcv-evidence.md), [`32-vendor-api-reference.md`](32-vendor-api-reference.md).

**Infra** — [`40-dashboard-framework-and-hosting.md`](40-dashboard-framework-and-hosting.md), [`41-tick-latency-economics.md`](41-tick-latency-economics.md). The paper-soak gate passed 2026-08-06 (typecheck/lint/build clean, 2282 tests, `yarn smoke` PASS, $50/14d budget, 15-min ticks) — record in [`archive/2026-08-06-soak-readiness.md`](archive/2026-08-06-soak-readiness.md). Three caveats stand: the mechanical layer has no demonstrated edge, two of three analysts run on an empty store, and three built learning layers are still unfed (#435, #465, #328).

## Open questions — unresolved, and someone has to decide

1. ~~**Tick cadence, and should the debate be catalyst-gated?**~~ **RESOLVED 2026-08-09** by [#657](https://github.com/dd-jp/samurai-trading-system/issues/657) and [#658](https://github.com/dd-jp/samurai-trading-system/issues/658); recorded in [ADR-0008](../adr/0008-llm-spend-cap.md) §2 (amended), [ADR-0016](../adr/0016-universe-leveraged-etps-ungated.md) and [`41-tick-latency-economics.md`](41-tick-latency-economics.md). **Every cost figure previously stated here was an estimate and was wrong.** Measured `llm_spend` gives **$0.878/day = £252/yr**, not the ~£862/yr quoted — ADR-0008 overestimated by 3.4x — falling to **£89/yr** once [#617](https://github.com/dd-jp/samurai-trading-system/issues/617) lands. **Cadence stays at 15 minutes**: the optimum is τ\* = 21.8 min, and the cap independently forbids anything under 3.69 min. **The debate is NOT catalyst-gated** — post-#617 crypto is 86% of the bill and has no catalyst calendar, so gating the equity leg to 3-of-5 days saves ~£5/yr (the leg is ~£12/yr in total) while removing ~£141/yr of gross. Gating is now an expectancy question owned by [#655](https://github.com/dd-jp/samurai-trading-system/issues/655) against a measured bar: **catalyst days must beat the all-day average by 60%**. The caution below still stands and is the reason none of this is a green light — **the gross figures remain a conditional projection on an unobserved 55% win rate**, and #625 measured the selector at 96 debates and 0 trades.
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
