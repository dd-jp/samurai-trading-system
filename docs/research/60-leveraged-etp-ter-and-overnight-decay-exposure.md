# 60 — Leveraged-ETP TER and the daily-reset-decay dismissal's edge cases

**Status:** MEASURED ([#1434](https://github.com/dd-jp/samurai-trading-system/issues/1434)) — **RECORD, do not model.** Both the total-expense-ratio-and-financing holding cost and the daily-reset-decay term sit below the round-trip noise floor for all five rows of `tradeableUniverse()`. ADR-0016's decay dismissal is **amended, not withdrawn**: its stated premise ("a flat-by-close strategy never holds one overnight") is empirically false — [#1389](https://github.com/dd-jp/samurai-trading-system/issues/1389) measured 7 of 9 control lots carried overnight on 2026-09-08 — but its conclusion survives, because the real edge-case hazard is unbracketed **overnight gap risk** on the position's 3x notional, not the decay term the ADR was dismissing.

**Label convention.** Every quantitative claim below is marked **[verified]** (read directly out of a repo artifact or a cited external page), **[derived]** (arithmetic on verified inputs, shown), **[inferred]** (a reading not stated in those words by any artifact), or **[assumed]** (a modelling choice, named as such). Unlabelled prose is argument, not evidence.

---

## 1. Question and scope

[#1434](https://github.com/dd-jp/samurai-trading-system/issues/1434) asks two things: quantify TER (total expense ratio) per ADR-0016 instrument and its per-trade cost at ADR-0018 D5 sizes, and quantify the decay exposure the daily-reset-decay dismissal's edge cases actually produce. The premise, verified against the tree before any of this was measured: `server/tools/backtest/types.ts`'s `CostModel` interface has no accrual/holding-cost method **[verified]**, and `docs/specs/cost-model-backtest-spec.md`'s User Story 4 already carries a 2026-08-XX amendment (from #1178) stating TER is "genuinely unaddressed anywhere in this repo" and that the daily-reset-decay dismissal's edge cases are "unmeasured rather than unspecced" — both deferred here rather than folded into that spec **[verified]**. The premise holds; nothing in this doc found the ticket's description of the tree to be wrong.

**Scope: `tradeableUniverse()`, not the 31-row checked-in pool.** `server/providers/universe-pool/lse-etp-pool.ts`'s `tradeableUniverse()` filters `LSE_ETP_POOL` down to rows that are both Saxo-tradeable and sterling-quoted — the set doc 59 and the #1220 ruling already established as **five rows** **[verified]**, reproduced here directly from the function:

| `lse_ticker` | ISIN | Issuer | Underlying | `subclass` | D5 size |
|---|---|---|---|---|---|
| `3LUS` | IE00B7Y34M31 | WisdomTree | S&P 500 | `index_etp_3x` | £350 |
| `LQQ3` | IE00BLRPRL42 | WisdomTree | Nasdaq 100 | `index_etp_3x` | £350 |
| `LCO3` | XS2575914176 | GraniteShares | Coinbase Global Inc | `single_stock_etp_3x` | £250 |
| `3KOR` | XS2472196257 | Leverage Shares | iShares MSCI South Korea ETF | `index_etp_3x` | £350 |
| `3KWE` | XS2800709128 | Leverage Shares | KraneShares CSI China Internet ETF | `index_etp_3x` | £350 |

Every figure below is fetched **per row**, against the row's own ISIN — not inferred from a same-issuer sibling. The pool file's own discipline (`lse-etp-pool.ts`'s `provenance` field: a URL actually fetched, not a search-result title) is followed here for the same reason it's followed there.

---

## 2. TER is the wrong name for the cost that matters

The issue's framing ("TER... accrues into the published price continuously") undersells the size of the real cost. A leveraged ETP's published all-in holding cost has up to three layers, and the aggregator-reported "TER" usually only names the first:

1. **Management/arranger fee** — the issuer's own charge, ~0.75%/yr across all three issuers here.
2. **Swap spread / index license fee** — for a swap-based (synthetic) structure, the counterparty's charge for providing the daily 3x return, which embeds that counterparty's own cost of financing the leveraged notional.
3. **Margin financing** — for a physically-replicated structure (buy the underlying, borrow the leveraged portion), the actual interest paid on the borrowed 2x notional. This is not a "TER" line at all on an aggregator page, but it is the largest of the three and is exactly what people mean when they say leveraged ETPs bleed.

Which layers apply depends on the row's replication method, which is **not the same across issuers even within this five-row universe**:

- **WisdomTree** (`3LUS`, `LQQ3`) — Fully Collateralised Swap. The published "Daily Swap Rate" already prices the counterparty's financing of the leverage; nothing further is embedded elsewhere.
- **GraniteShares** (`LCO3`) — swap-based, via Natixis. The factsheet's own "Total Ongoing Costs" line is explicitly `Arranger fee + Swap spread + Index license fee` — already all-in.
- **Leverage Shares** (`3KOR`, `3KWE`) — **physical replication with margin** ("It invests directly in the underlying... and uses margin (borrowing) to purchase additional shares"). The 0.75% "Annual Management Fee" the factsheet headlines is *not* all-in here — the margin financing on the borrowed 2x notional is a separate, uncapped, reconstructible-but-not-headlined cost.

## 3. Measured figures, per row

All fetched from the issuer's own factsheet/KID PDF for that row's ISIN (WebFetch's markdown conversion could not parse these PDFs' embedded tables; each was re-read directly as a PDF via the Read tool, which parses PDFs multimodally):

| Row | Mgmt/arranger fee | Financing layer | Source |
|---|---|---|---|
| `3LUS` | 0.75%/yr | Daily Swap Rate **0.00136%/day** | WisdomTree factsheet, doc date 31/08/2026 — `dataspanapi.wisdomtree.com/pdr/documents/FACTSHEET/WTMA/EU/EN-GB/IE00B7Y34M31/` **[verified]** |
| `LQQ3` | 0.75%/yr | Daily Swap Rate **0.0065%/day** | WisdomTree factsheet, doc date 31/08/2026 — `dataspanapi.wisdomtree.com/pdr/documents/FACTSHEET/WTMA/EU/EN-GB/IE00BLRPRL42/` **[verified]** |
| `LCO3` | n/a (folded into the line below) | Total Ongoing Costs **0.0519%/day** (all-in) | GraniteShares factsheet, issued December 2024 — `graniteshares.com/media/aesjxflo/factsheet_graniteshares-3x-long-coinbase-daily-etp_en.pdf` **[verified]** |
| `3KOR` | 0.75%/yr | Margin Rate = **Fed Funds Effective (Overnight Rate) + 2%** | Leverage Shares factsheet — `leverageshares.com/documents/factsheet/3x_ewy_factsheet.pdf` **[verified]** |
| `3KWE` | 0.75%/yr | Margin Rate = **Fed Funds Effective (Overnight Rate) + 2%** | Leverage Shares factsheet — `leverageshares.com/documents/factsheet/3x_kweb_factsheet.pdf` **[verified]** |

**EFFR input for the two Leverage Shares rows:** 3.63%, 2026-09-08 through 2026-09-11 (most recent print) — fetched directly from FRED's own CSV series, `fred.stlouisfed.org/graph/fredgraph.csv?id=EFFR` **[verified]**. So the margin rate on `3KOR`/`3KWE` is **5.63%/yr**, charged on the borrowed leg.

**Reconstructing `3KOR`/`3KWE`'s all-in daily rate [derived]:** physical replication to 3x exposure from 1x investor capital borrows 2x notional. Financing cost as a fraction of the ETP's own NAV = margin rate × 2 = 5.63% × 2 = **11.26%/yr**, i.e. 0.03085%/day. Adding the 0.75%/yr management fee (0.00205%/day): **all-in ≈ 0.0329%/day ≈ 12.0%/yr.**

**All-in daily rate, all five rows [derived where noted]:**

| Row | All-in daily rate | All-in, annualised |
|---|---|---|
| `3LUS` | 0.00341%/day | ≈1.25%/yr |
| `LQQ3` | 0.00855%/day | ≈3.12%/yr |
| `LCO3` | 0.0519%/day **[verified]** | ≈18.9%/yr |
| `3KOR` | 0.0329%/day **[derived]** | ≈12.0%/yr |
| `3KWE` | 0.0329%/day **[derived]** | ≈12.0%/yr |

These annualised-equivalent figures are considerably larger than the aggregator "TER" figures (0.75%–0.99%) that a justETF-style search alone would have surfaced for these same ISINs — confirming the issue's premise that TER under-names the real cost, and confirming advice received mid-task that the physical-margin layer had to be reconstructed from the factsheet's own Margin Rate line rather than left at the headlined management fee.

## 4. Per-trade cost against the round-trip noise floor

Two bounds, because how much of a day's accrual a same-day round trip actually bears is genuinely ambiguous without each issuer's swap-valuation methodology (continuous embedding in the published price vs. a single end-of-day reset): a **pessimistic, no-proration bound** (the full published daily rate charged once, regardless of hold length) and an **optimistic, prorated bound** (a ~5.5-hour hold — roughly mid-session entry to the 16:25 London flatten — as a fraction of a 24-hour accrual day, ×0.229). Both are shown; the conclusion below states which bound it needs.

| Row | D5 size | Pessimistic (full day) | Prorated (~5.5h) |
|---|---|---|---|
| `3LUS` | £350 | £0.012 (0.34 bps) | £0.0027 (0.08 bps) |
| `LQQ3` | £350 | £0.030 (0.86 bps) | £0.0069 (0.20 bps) |
| `LCO3` | £250 | £0.130 (5.19 bps) | £0.0297 (1.19 bps) |
| `3KOR` | £350 | £0.115 (3.29 bps) | £0.0264 (0.75 bps) |
| `3KWE` | £350 | £0.115 (3.29 bps) | £0.0264 (0.75 bps) |

**Against Saxo's own 16 bps round-trip commission** (ADR-0018's 2026-09-14 amendment, 0.08%/side flat, no minimum) — the cost term that already dominated the 2026-09-14 restatement of every break-even accuracy bar in this repo — even the pessimistic, no-proration bound is at most **~32% of the commission alone** (`LCO3`, single-stock) and the prorated bound is **~5–7% of it**. Against the fuller round-trip figure doc 54 uses (spread **and** commission — 34 bps index / 57 bps single-stock), the pessimistic bound is **1.0–9.6%** of round trip and the prorated bound **0.2–2.1%**.

**Converted to accuracy-bar terms** (doc 59 §3's own conversion: 4.16 bps costs 1.00 pp of required accuracy on the index bracket, 12.25 bps on the single-stock bracket) — the closest-to-material row is `3KOR`/`3KWE`, the two Leverage Shares index products, where the pessimistic no-proration bound (3.29 bps) converts to **≈0.79 pp** of index-bracket accuracy and the prorated bound to **≈0.18 pp**. This is the one figure in this table that is not obviously negligible on its own — it is roughly a third to a half the size of the ~1.58 pp equities-only LLM-bill figure CLAUDE.md already treats as "not second order" on the index bracket. Two things keep it below the noise floor rather than promoting it to a modelled term: it is a **holding-duration cost, not a per-trade fixed cost** — it scales with how long a position is actually held, and this pipeline's D3 exit geometry truncates every position at the scheduled flatten regardless of TP/stop resolution (§5.1), so the realized hold is bounded well under a full day on every non-carried trade; and even its pessimistic, non-prorated reading is a fifth of Saxo's commission alone, which the 2026-09-14 amendment already absorbed into the accuracy bar without triggering a `CostModel` change. If Leverage Shares' margin spread or the EFFR level rises materially from today's 3.63%, this is the row to re-measure first.

**Conclusion: below the noise floor for all five rows, with `3KOR`/`3KWE` the nearest exception and named as the re-measurement trigger.** No `CostModel` seam is warranted.

## 5. Decay exposure: the ADR-0016 premise is wrong, the conclusion is not

### 5.1 The decay term itself is second-order over a single reset

ADR-0016:37 dismisses daily-reset decay on the premise that "a flat-by-close strategy never holds one overnight." For a 3x daily-reset product, one day's return relative to 3× the underlying's return is, to leading order:

```
ETP day return ≈ 3r − 3σ²
```

where `r` is the underlying's day return and `σ` its intraday realised volatility **[derived, standard leveraged-ETP decomposition]** — the decay term is quadratic in volatility, the directional term is linear. For a volatile single name at `σ ≈ 1–2%` intraday, the decay term is `3σ² ≈ 3–12 bps`; the directional term `3r` for even a modest 1% day is `300 bps`, one to two orders of magnitude larger. **Decay compounds materially only over many resets** — it is not what a position exposed to *one* unintended overnight reset actually suffers.

`docs/research/52-exit-geometry-and-subclass-odds.md`'s regime note confirms the mechanism that would otherwise produce that unintended reset does not fire from a stop/target miss alone: the bar-by-bar simulation is "truncated at the 16:25 London flatten" **[verified]** regardless of whether TP or stop resolved first — a miss changes which exit produced the flatten, not whether one did. Of the three edge cases #1434 names, only a **failure of the flatten mechanism itself** — not a stop/target miss on its own — produces a real overnight hold.

### 5.2 The mechanism failures, and what they actually produce

**#1389 (flatten-window shortfall) — falsifies the premise, does not revive the decay dismissal.** The 2026-09-08 incident measured **7 of 9 named control-arm lots (77.8%) carried overnight** with no flatten intent ever produced, the forward-only `sessionEnd` bug in `withinFlattenWindow` — worst-case late arrival 2:02 after the scheduled close **[verified, issue #1389 body]**. This is a direct empirical falsification of ADR-0016:37's stated premise: a flat-by-close strategy *did* hold overnight, repeatedly, on real control-arm lots.

The fix has since landed on `main` (`server/pipeline/trader/decide.ts`, `server/pipeline/trader/types.ts`): the flatten key coordinates on session close rather than lot anchor, a 5-minute `flatten_after_close_ms` grace window applies, an instrument-scoped in-flight guard prevents duplicate flattens, and a lot still open after the grace window raises the alert-only `lot_carried_past_session_close` diagnostic rather than silently vanishing **[verified]**. All 6 of the incident's late-but-reachable lots (worst case 2:02 after close) would have flattened inside the shipped 5-minute grace. Residual exposure is real but narrower: a lot beyond the grace window is **alerted, not automatically pre-open-flattened** — "the pre-open flatten is a follow-up ticket" per #1389's own resolution comment **[verified]** — so a lot that clears the grace window still carries for real. No incident has been recorded against the shipped fix; the soak has run since 2026-09-14, too short a window to say the residual rate is zero rather than unobserved.

**#1215 (Saxo GTC leg vs. DayOrder expiry) — genuinely unmeasured, not estimated here.** Whether Saxo auto-cancels a `GoodTillCancel` protective leg when its `DayOrder` master expires unfilled is unverified; the probe needs a real overnight SIM session boundary and `SAXO_OPENAPI_TOKEN` has been empty in dev. A partial defense shipped in #1425 (the adapter no longer misreads a dormant leg as a phantom fill), but the core question — does the leg itself survive past the close — remains open, tracked separately, with no incident data either way **[verified, issue #1215]**. Per #1434's own instruction, this is reported as unmeasured rather than assigned a fabricated frequency.

### 5.3 What the edge cases actually expose is gap risk, not decay

Putting 5.1 and 5.2 together: the edge cases are real (a lot can and does carry past a scheduled flatten), but what a carried lot is exposed to overnight is **the underlying's overnight gap, levered 3x** — a first-order term — not the decay term ADR-0016 was dismissing, which stays second-order and immaterial over the one or two sessions any carry-so-far has lasted. Illustratively, **not measured** — no carried lot in the #1389 record has a realized overnight fill logged against it — a 3x levered overnight gap of 0.5%–3% on the underlying (a plausible range for a volatile single name or sector ETF, not a fitted or fetched figure) is **£4–£32 on a £250–£350 D5 position**, an order of magnitude above the TER figures in §4 and the actual hazard a carried lot bears. This hazard is already owned by #1389 (shipped, residual bounded to beyond-grace carries) and #1215 (open, unmeasured) — it does not need a new `CostModel` holding-cost term; it needs the flatten mechanism to keep working, which is what those two tickets are for.

## 6. Decision

**Do not model TER or decay in `CostModel`.** Every row's all-in holding-cost bound sits below Saxo's own 16 bps round-trip commission — the cost term the repo already absorbed into its accuracy bars without a `CostModel` change — and the decay term proper is second-order over the one-or-two-session carries the mechanism failures actually produce. `docs/specs/cost-model-backtest-spec.md` is not touched: its existing #1178 amendment already correctly named both gaps as deferred to this ticket, and no seam is being added for it to describe.

**ADR-0016 is amended, narrowly:** its stated premise ("a flat-by-close strategy never holds one overnight") is corrected to reflect #1389's measured falsification, while its operative conclusion (decay does not need modelling) is preserved and now explicitly covers the edge cases, with the real hazard renamed to overnight gap risk and pointed at #1389/#1215 rather than left implying a `CostModel` gap. See the ADR's 2026-09-15 amendment.

No follow-up implementation issue is filed — nothing here is being built. The one open thread is #1215, already tracked, already open, and not reopened or refiled by this doc.

---

## 7. Sources

- WisdomTree S&P 500 3x Daily Leveraged (`3LUS`/`3USL`, IE00B7Y34M31) factsheet, doc date 31/08/2026: `https://dataspanapi.wisdomtree.com/pdr/documents/FACTSHEET/WTMA/EU/EN-GB/IE00B7Y34M31/` — Management Fee 0.75%, Daily Swap Rate 0.00136%
- WisdomTree NASDAQ 100 3x Daily Leveraged (`LQQ3`/`QQQ3`, IE00BLRPRL42) factsheet, doc date 31/08/2026: `https://dataspanapi.wisdomtree.com/pdr/documents/FACTSHEET/WTMA/EU/EN-GB/IE00BLRPRL42/` — Management Fee 0.75%, Daily Swap Rate 0.0065%
- GraniteShares 3x Long Coinbase Daily ETP (`LCO3`/`3LCO`, XS2575914176) factsheet, issued December 2024: `https://graniteshares.com/media/aesjxflo/factsheet_graniteshares-3x-long-coinbase-daily-etp_en.pdf` — Total Ongoing Costs 0.0519% per day
- Leverage Shares 3x Long South Korea ETP Securities (`3KOR`/`KOR3`, XS2472196257) factsheet: `https://leverageshares.com/documents/factsheet/3x_ewy_factsheet.pdf` — Annual Management Fee 0.75%, Margin Rate Fed Funds Effective (Overnight Rate) + 2%
- Leverage Shares 3x Long China Tech ETP Securities (`3KWE`/`KWE3`, XS2800709128) factsheet: `https://leverageshares.com/documents/factsheet/3x_kweb_factsheet.pdf` — Annual Management Fee 0.75%, Margin Rate Fed Funds Effective (Overnight Rate) + 2%
- Federal Reserve Bank of St. Louis, Effective Federal Funds Rate (EFFR) series, fetched as CSV: `https://fred.stlouisfed.org/graph/fredgraph.csv?id=EFFR` — 3.63%, 2026-09-08 through 2026-09-11 (most recent print at fetch time)
- GitHub issue [#1389](https://github.com/dd-jp/samurai-trading-system/issues/1389) (CLOSED) — 2026-09-08 flatten-window incident, 7/9 control lots carried overnight, worst-case late arrival 2:02 after close
- GitHub issue [#1215](https://github.com/dd-jp/samurai-trading-system/issues/1215) (OPEN) — Saxo GTC leg vs. DayOrder expiry, unverified, `SAXO_OPENAPI_TOKEN` unavailable in dev
- `server/pipeline/trader/decide.ts`, `server/pipeline/trader/types.ts` — shipped #1389 fix: session-close-keyed flatten, `flatten_after_close_ms` grace (default 5 min), `lot_carried_past_session_close` alert diagnostic
- `docs/research/52-exit-geometry-and-subclass-odds.md` — exit-geometry regime note, truncation at the 16:25 London flatten regardless of TP/stop resolution
- `docs/research/59-universe-tradeability-screen.md` §3 — accuracy-bar conversion (4.16 bps/pp index, 12.25 bps/pp single-stock)
- `docs/specs/cost-model-backtest-spec.md` User Story 4, #1178 amendment — TER and the edge cases deferred to #1434
