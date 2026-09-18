# 60 — Leveraged-ETP TER and the daily-reset-decay dismissal's edge cases

**Status:** MEASURED ([#1434](https://github.com/dd-jp/samurai-trading-system/issues/1434)) — **RECORD, do not model.** The total-expense-ratio-and-financing holding cost is small relative to Saxo's 16 bps round-trip commission for the three `tradeableUniverse()` rows ADR-0018 can currently size live (`3LUS`, `LQQ3`, `LCO3`); the other two rows in `tradeableUniverse()`'s output (`3KOR`, `3KWE`) are structurally excluded from live sizing today by ADR-0018's #903 amendment, independent of this cost question — their holding-cost figure below is contingent, not a live-materiality finding. ADR-0016's decay dismissal is **amended, not withdrawn**: its stated premise ("a flat-by-close strategy never holds one overnight") is empirically false — [#1389](https://github.com/dd-jp/samurai-trading-system/issues/1389) measured 6 of 9 control lots carried overnight on 2026-09-08 with no flatten intent ever produced (a 7th, `AMZN`, had an intent produced but refused downstream, #1388) — but its conclusion survives, because the real edge-case hazard is unbracketed **overnight gap risk** on the position's 3x notional, not the decay term the ADR was dismissing.

**Label convention.** Every quantitative claim below is marked **[verified]** (read directly out of a repo artifact or a cited external page), **[derived]** (arithmetic on verified inputs, shown), **[inferred]** (a reading not stated in those words by any artifact), or **[assumed]** (a modelling choice, named as such). Unlabelled prose is argument, not evidence.

---

## 1. Question and scope

[#1434](https://github.com/dd-jp/samurai-trading-system/issues/1434) asks two things: quantify TER (total expense ratio) per ADR-0016 instrument and its per-trade cost at ADR-0018 D5 sizes, and quantify the decay exposure the daily-reset-decay dismissal's edge cases actually produce. The premise, verified against the tree before any of this was measured: `server/tools/backtest/types.ts`'s `CostModel` interface has no accrual/holding-cost method **[verified]**, and `docs/specs/cost-model-backtest-spec.md`'s User Story 4 already carries a 2026-09-09 amendment (from #1178, closed that date) stating TER is "genuinely unaddressed anywhere in this repo" and that the daily-reset-decay dismissal's edge cases are "unmeasured rather than unspecced" — both deferred here rather than folded into that spec **[verified]**. That spec text is itself corrected by this ticket's landing — see the amendment recorded in `docs/specs/cost-model-backtest-spec.md` — but the premise this doc worked from holds; nothing in this doc found the ticket's description of the tree, as it stood before #1434, to be wrong.

**Scope: `tradeableUniverse()`, not the 31-row checked-in pool.** `server/providers/universe-pool/lse-etp-pool.ts`'s `tradeableUniverse()` filters `LSE_ETP_POOL` down to rows that are both Saxo-tradeable and sterling-quoted, which today resolves to **five rows [verified]**, reproduced here directly from the function. **This is a different set from doc 59's own five-row tradeability-screen survivors** (`LQQ3`, `LCO3`, `3AMZ`, `3FB`, `3ARM` — a history-and-currency screen over the whole 30-row pool, doc 59 §5.2 **[verified]**): the two counts coincide at five by chance, not membership. `3LUS`, `3KOR` and `3KWE` are all sterling-declared in the pool file today (`currency: 'GBX'`, confirmed by direct read) — none fails doc 59's currency criterion (e). What doc 59's screen actually does to each differs: its usable-history criterion (d) passes exactly ten named rows (§5.1) — `3USL`, `LQQ3`, `NVD3`, `3LNV`, `MST3`, `PLT3`, `LCO3`, `3AMZ`, `3FB`, `3ARM` — and `3KOR`/`3KWE` are not among them, for reasons doc 59 does not state; they simply fail (d). `3LUS` itself is not literally in that list either, but for a documented reason: doc 59's (d) data (recorded 2026-09-02) was measured against `3USL`, the USD-declared row `3LUS` split from after that measurement under #1220 (`lse-etp-pool.ts`'s own comment: "the slot moved, the line was not deleted") — `3USL` is one of the five F3 passers doc 59 records as USD-declared and falling to (e), and `3LUS` inherits its (d) pass by product identity, not by its own line having been independently measured. `tradeableUniverse()`'s screen would separately exclude `3AMZ`, `3FB` and `3ARM` (not in its own Saxo-tradeable/sterling output). Neither document's five rows supersede the other's — they answer different questions (live tradeability-by-currency-and-venue vs. a history-and-currency tradeability screen over the wider pool).

| `lse_ticker` | ISIN | Issuer | Underlying | `subclass` | D5 size (nominal) |
|---|---|---|---|---|---|
| `3LUS` | IE00B7Y34M31 | WisdomTree | S&P 500 | `index_etp_3x` | £350 |
| `LQQ3` | IE00BLRPRL42 | WisdomTree | Nasdaq 100 | `index_etp_3x` | £350 |
| `LCO3` | XS2575914176 | GraniteShares | Coinbase Global Inc | `single_stock_etp_3x` | £250 |
| `3KOR` | XS2472196257 | Leverage Shares | iShares MSCI South Korea ETF | `index_etp_3x` | £350 — **not live-sizeable, see below** |
| `3KWE` | XS2800709128 | Leverage Shares | KraneShares CSI China Internet ETF | `index_etp_3x` | £350 — **not live-sizeable, see below** |

**`3KOR` and `3KWE` cannot actually be sized for a live trade today.** ADR-0018's [2026-08-27 amendment (#903)](../adr/0018-intraday-thresholds-sizing-and-the-signal-bar.md) widened `index_etp_3x` past what was measured on SPY, and marks four rows — `3KOR`, `3KWE`, `3VT`, `3XLE` — `subclass_envelope_measured: false` on the pool file (`server/providers/universe-pool/lse-etp-pool.ts`). `liveSizingSubclassFor()` (same file, ~line 1892) returns `undefined` for any row with that flag, and `resolveSubclassBracket()` (`server/pipeline/trader/subclass-bracket.ts:69`) then throws `SubclassBracketUnresolvableError` rather than sizing the row off the SPY-measured bracket. This is ADR-0018's Option 3 of three named for the interim (exclude, don't re-measure or split, for now) — exclusion is sizing-only and does not touch `tradeableUniverse()`'s screening count, which is why the function still returns these two rows. The £350 D5 figure above is `tradeableUniverse()`'s nominal per-row output and the value ADR-0018 D5 assigns the `index_etp_3x` subclass generally — it is **not** a size Execution can actually place for `3KOR`/`3KWE` under #903's current state. §4 and §6 below still measure both rows' holding cost, because #1434 asks for it per-ADR-0016-instrument regardless of live-sizing status, but the resulting figure should be read as **contingent on `index_etp_3x` being re-measured or split**, not as a finding about live exposure today.

Every figure below is fetched **per row**, against the row's own ISIN — not inferred from a same-issuer sibling. The pool file's own discipline (`lse-etp-pool.ts`'s `provenance` field: a URL actually fetched, not a search-result title) is followed here for the same reason it's followed there.

---

## 2. TER is the wrong name for the cost that matters

The issue's framing ("TER... accrues into the published price continuously") undersells the size of the real cost. A leveraged ETP's published all-in holding cost has up to three layers, and the aggregator-reported "TER" usually only names the first:

1. **Management/arranger fee** — the issuer's own charge, ~0.75%/yr across all three issuers here **[verified, §3 sources]**.
2. **Swap spread / index license fee** — for a swap-based (synthetic) structure, the counterparty's charge for providing the daily 3x return, which embeds that counterparty's own cost of financing the leveraged notional.
3. **Margin financing** — for a physically-replicated structure (buy the underlying, borrow the leveraged portion), the actual interest paid on the borrowed 2x notional. This is not a "TER" line at all on an aggregator page, but it is the largest of the three and is exactly what people mean when they say leveraged ETPs bleed.

Which layers apply depends on the row's replication method, which is **not the same across issuers even within this five-row universe**:

- **WisdomTree** (`3LUS`, `LQQ3`) — Fully Collateralised Swap. The published "Daily Swap Rate" already prices the counterparty's financing of the leverage; nothing further is embedded elsewhere.
- **GraniteShares** (`LCO3`) — swap-based, via Natixis. The factsheet's own "Total Ongoing Costs" line is explicitly `Arranger fee + Swap spread + Index license fee` — already all-in.
- **Leverage Shares** (`3KOR`, `3KWE`) — **physical replication with margin** ("It invests directly in the underlying... and uses margin (borrowing) to purchase additional shares"). The 0.75% "Annual Management Fee" the factsheet headlines is *not* all-in here — the margin financing on the borrowed 2x notional is a separate, uncapped, reconstructible-but-not-headlined cost.

## 3. Measured figures, per row

All fetched from the issuer's own factsheet/KID PDF for that row's ISIN (WebFetch's markdown conversion could not parse these PDFs' embedded tables; each was re-read directly as a PDF via the Read tool's native PDF support, and every figure below was checked against that rendering):

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

These annualised-equivalent figures are considerably larger than the aggregator "TER" figure a justETF-style search alone would have surfaced for these same ISINs — each factsheet above headlines the **0.75%/yr management/arranger fee** as its own "TER"-labelled or nearest-equivalent line **[verified, §3 sources]**, which is the number an aggregator page typically mirrors. **[inferred, not independently re-verified this pass]** A wider aggregator search across the same three issuers' product families surfaces headline figures up to roughly 0.99%, but the higher end of that range is not confirmed to belong to one of these five specific ISINs — it may be a different product in the same issuer's range (e.g. a GraniteShares line other than `LCO3`) rather than evidence of a uniform 0.75%–0.99% band across these rows. The load-bearing point stands regardless of that unresolved range: every one of these rows' **all-in** cost (above) is several multiples of its own 0.75%-or-similar headline figure, which is what confirms the issue's premise that "TER" under-names the real cost.

## 4. Per-trade cost against the round-trip and against the accuracy bar

**[derived, from the §3 all-in daily rates and ADR-0018's D5 sizes; the hold lengths below are an assumed input]** Two bounds, because how much of a day's accrual a same-day round trip actually bears is genuinely ambiguous without each issuer's swap-valuation methodology (continuous embedding in the published price vs. a single end-of-day reset): a **pessimistic, no-proration bound** (the full published daily rate charged once, regardless of hold length) and a **prorated bound**, scaled to a fraction of the 24-hour accrual day. The prorated bound uses the actual entry-to-flatten window this pipeline arms, not an assumed one: `londonEntryWindow()`'s shipped defaults (`server/providers/market-data-service/trading-calendar.ts:993-995`, #706) arm entries **14:30–15:45 London**, and the scheduled flatten is 16:25 London — so the **maximum** hold, on the earliest possible entry, is **1h55m** (14:30→16:25); the **minimum** hold, on the latest possible entry, is 40m (15:45→16:25); and the **mid-window** hold (entry at the window's midpoint, ~15:07:30) is **~1h18m**. Both are shown; an earlier draft of this table used an unsourced ~5.5-hour hold and a ×0.229 factor, which overstated the prorated bound by roughly 4x against the mid-window figure — corrected below.

| Row | D5 size | Pessimistic (full day) | Prorated, mid-window (~1h18m, ×0.0542) | Prorated, max hold (~1h55m, ×0.0799) |
|---|---|---|---|---|
| `3LUS` | £350 | £0.012 (0.34 bps) | £0.0006 (0.018 bps) | £0.0010 (0.027 bps) |
| `LQQ3` | £350 | £0.030 (0.86 bps) | £0.0016 (0.046 bps) | £0.0024 (0.068 bps) |
| `LCO3` | £250 | £0.130 (5.19 bps) | £0.0070 (0.281 bps) | £0.0104 (0.414 bps) |
| `3KOR`* | £350 | £0.115 (3.29 bps) | £0.0062 (0.178 bps) | £0.0092 (0.263 bps) |
| `3KWE`* | £350 | £0.115 (3.29 bps) | £0.0062 (0.178 bps) | £0.0092 (0.263 bps) |

\* Contingent figure — `3KOR`/`3KWE` are not live-sizeable today; see the scope note above.

**Against Saxo's own 16 bps round-trip commission** (ADR-0018's 2026-09-14 amendment, 0.08%/side flat, no minimum) — the cost term that already dominated the 2026-09-14 restatement of every break-even accuracy bar in this repo **[derived]**: the pessimistic, no-proration bound is at most **~32% of the commission alone** (`LCO3`, single-stock) and ranges down to ~2% (`3LUS`); the mid-window prorated bound is **~0.1%–1.8%** of the commission across all five rows. Against the fuller round-trip figure doc 54 uses (spread **and** commission — 34 bps index / 57 bps single-stock), the pessimistic bound is **1.0%–9.7%** of round trip and the mid-window prorated bound **0.05%–0.52%**.

**Converted to accuracy-bar terms** (doc 59 §3's own conversion: 4.16 bps costs 1.00 pp of required accuracy on the index bracket, 12.25 bps on the single-stock bracket, using the pessimistic no-proration bound as the conservative reading) **[derived]**: `3LUS` ≈0.08 pp, `LQQ3` ≈0.21 pp, `LCO3` ≈0.42 pp, and `3KOR`/`3KWE` (contingent, not live-sizeable) ≈0.79 pp each of index-bracket accuracy. None of these is negligible against the scale this repo already treats as material: [#1548](https://github.com/dd-jp/samurai-trading-system/issues/1548)'s 2026-09-14 amendment restated ADR-0018 D3's accuracy bars for Saxo's charged round trip by **+3.85 pp on the index bracket and +1.31 pp on the single-stock bracket**, and CLAUDE.md already treats a 1.58 pp (index) / 0.75 pp (single-stock) LLM-bill term as "not second order" at these same D5 sizes. Measured against that precedent rather than against an unclaimed "noise floor": `3LUS`, `LQQ3` and `LCO3` are each **2%–32% of #1548's own bar-restatement delta** on their bracket (0.08/3.85 ≈ 2%, 0.21/3.85 ≈ 5%, 0.42/1.31 ≈ 32%) — small relative to a restatement of this scale that the repo already absorbed without a `CostModel` change, but not zero — that comparison, not an independently-asserted noise floor, is the right frame for the judgment. `3KOR`/`3KWE`'s ≈0.79 pp (0.79/3.85 ≈ 21% of the index delta) is the largest of the five on this measure, but it is **not a live-sizing-relevant figure today** given the scope note above — it matters only if and when `index_etp_3x` is re-measured or split.

Two structural reasons keep even the largest of these as a recorded question rather than a modelled term: it is a **holding-duration cost, not a per-trade fixed cost** — it scales with how long a position is actually held, and this pipeline's D3 exit geometry truncates every position at the scheduled flatten regardless of TP/stop resolution (§5.1), bounding the realized hold to the 40m–1h55m window above on every non-carried trade, not a full day; and the mid-window prorated bound is under 2% of Saxo's commission alone on every row. If Leverage Shares' margin spread or the EFFR level rises materially from today's 3.63%, `3KOR`/`3KWE` is the pair to re-measure first — contingent on #903 being resolved either way.

**Conclusion: a bar-restatement-scale question for `3LUS`/`LQQ3`/`LCO3`, not a modelled term — record, don't model. `3KOR`/`3KWE`'s figure is additionally contingent on live-sizing status and should not be read as current exposure.** No `CostModel` seam is warranted for any of the five rows as things stand.

## 5. Decay exposure: the ADR-0016 premise is wrong, the conclusion is not

### 5.1 The decay term itself is second-order over a single reset

ADR-0016:37 dismisses daily-reset decay on the premise that "a flat-by-close strategy never holds one overnight." For a 3x daily-reset product, one day's return relative to 3× the underlying's return is, to leading order:

```
ETP day return ≈ 3r − 3σ²
```

where `r` is the underlying's day return and `σ` its intraday realised volatility **[derived, standard leveraged-ETP decomposition]** — the decay term is quadratic in volatility, the directional term is linear. For a volatile single name at `σ ≈ 1–2%` intraday, the decay term is `3σ² ≈ 3–12 bps`; the directional term `3r` for even a modest 1% day is `300 bps`, one to two orders of magnitude larger. **Decay compounds materially only over many resets** — it is not what a position exposed to *one* unintended overnight reset actually suffers.

`docs/research/52-exit-geometry-and-subclass-odds.md`'s regime note confirms the mechanism that would otherwise produce that unintended reset does not fire from a stop/target miss alone: the bar-by-bar simulation is "truncated at the 16:25 London flatten" **[verified]** regardless of whether TP or stop resolved first — a miss changes which exit produced the flatten, not whether one did. Of the three edge cases #1434 names, only a **failure of the flatten mechanism itself** — not a stop/target miss on its own — produces a real overnight hold.

### 5.2 The mechanism failures, and what they actually produce

**#1389 (flatten-window shortfall) — falsifies the premise, does not revive the decay dismissal.** The 2026-09-08 incident measured nine control-arm lots opened, of which two flattened normally (AAPL, QQQ) and a third (AMZN) produced a flatten intent at 19:59:56 that was **refused downstream** (Verdict gate 4 refusing a post-bell flatten, tracked separately as #1388) — so **6 of the 9 lots (NFLX, PLTR, RIOT, SMCI, UBER, MSTR) carried overnight with no flatten intent ever produced at all**, on the forward-only `sessionEnd` bug in `withinFlattenWindow`; the worst-case late arrival among the timestamped lots was UBER at 2:02 after the scheduled close **[verified, issue #1389 body]**. This is a direct empirical falsification of ADR-0016:37's stated premise: a flat-by-close strategy *did* hold overnight, repeatedly, on real control-arm lots.

The fix has since landed on `main` (`server/pipeline/trader/decide.ts`, `server/pipeline/trader/types.ts`): the flatten key coordinates on session close rather than lot anchor, a 5-minute `flatten_after_close_ms` grace window applies, an instrument-scoped in-flight guard prevents duplicate flattens, and a lot still open after the grace window raises the alert-only `lot_carried_past_session_close` diagnostic rather than silently vanishing **[verified]**. **5 of the 6 no-intent-produced lots have an arrival timestamp cited in #1389's body** — NFLX 20:00:16, SMCI 20:01:14, PLTR 20:01:26, RIOT 20:01:47, UBER 20:02:02 — all comfortably inside a 5-minute-from-close grace window, so those five would have flattened under the shipped fix **[verified, issue #1389 body]**. **The sixth, MSTR, has no arrival timestamp in the issue body**, so this document cannot independently verify it also would have cleared the grace window from the cited evidence alone; nothing in the record suggests it fell outside it, but the claim is not sourced to the same degree as the other five. Residual exposure is real but narrower regardless: a lot beyond the grace window is **alerted, not automatically pre-open-flattened** — "the pre-open flatten is a follow-up ticket" per #1389's own resolution comment **[verified]** — so a lot that clears the grace window still carries for real. No incident has been recorded against the shipped fix; the soak has run since 2026-09-14, too short a window to say the residual rate is zero rather than unobserved.

**#1215 (Saxo GTC leg vs. DayOrder expiry) — genuinely unmeasured, not estimated here.** Whether Saxo auto-cancels a `GoodTillCancel` protective leg when its `DayOrder` master expires unfilled is unverified; the probe needs a real overnight SIM session boundary and `SAXO_OPENAPI_TOKEN` has been empty in dev. A partial defense shipped in #1425 (the adapter no longer misreads a dormant leg as a phantom fill), but the core question — does the leg itself survive past the close — remains open, tracked separately, with no incident data either way **[verified, issue #1215]**. Per #1434's own instruction, this is reported as unmeasured rather than assigned a fabricated frequency.

### 5.3 What the edge cases actually expose is gap risk, not decay

Putting 5.1 and 5.2 together: the edge cases are real (a lot can and does carry past a scheduled flatten), but what a carried lot is exposed to overnight is **the underlying's overnight gap, levered 3x** — a first-order term — not the decay term ADR-0016 was dismissing, which stays second-order and immaterial over the one or two sessions any carry-so-far has lasted. Illustratively, **not measured** — no carried lot in the #1389 record has a realized overnight fill logged against it — a 3x levered overnight gap of 0.5%–3% on the underlying (a plausible range for a volatile single name or sector ETF, not a fitted or fetched figure) is **£4–£32 on a £250–£350 D5 position**, an order of magnitude above the TER figures in §4 and the actual hazard a carried lot bears. This hazard is already owned by #1389 (shipped, residual bounded to beyond-grace carries) and #1215 (open, unmeasured) — it does not need a new `CostModel` holding-cost term; it needs the flatten mechanism to keep working, which is what those two tickets are for.

## 6. Decision

**Do not model TER or decay in `CostModel`.** Every row's all-in holding-cost bound is small relative to Saxo's own 16 bps round-trip commission and to the #1548 bar-restatement scale (§4) — small enough to record rather than model, not zero — and the decay term proper is second-order over the one-or-two-session carries the mechanism failures actually produce; `3KOR`/`3KWE`'s figure is additionally contingent on live-sizing status ADR-0018's #903 amendment has not yet resolved. `docs/specs/cost-model-backtest-spec.md`'s existing #1178 amendment named both gaps as deferred to this ticket — that amendment text is updated by this same change to point at this landed measurement rather than continue asserting the pre-#1434 unaddressed/unmeasured state; no new `CostModel` seam is added for it to describe.

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
- GitHub issue [#1389](https://github.com/dd-jp/samurai-trading-system/issues/1389) (CLOSED) — 2026-09-08 flatten-window incident, 6/9 control lots carried overnight with no flatten intent ever produced (a 7th, AMZN, had an intent refused downstream, #1388), worst-case timestamped late arrival 2:02 after close (UBER)
- GitHub issue [#1215](https://github.com/dd-jp/samurai-trading-system/issues/1215) (OPEN) — Saxo GTC leg vs. DayOrder expiry, unverified, `SAXO_OPENAPI_TOKEN` unavailable in dev
- `server/pipeline/trader/decide.ts`, `server/pipeline/trader/types.ts` — shipped #1389 fix: session-close-keyed flatten, `flatten_after_close_ms` grace (default 5 min), `lot_carried_past_session_close` alert diagnostic
- `docs/research/52-exit-geometry-and-subclass-odds.md` — exit-geometry regime note, truncation at the 16:25 London flatten regardless of TP/stop resolution
- `docs/research/59-universe-tradeability-screen.md` §3 — accuracy-bar conversion (4.16 bps/pp index, 12.25 bps/pp single-stock)
- `docs/specs/cost-model-backtest-spec.md` User Story 4, #1178 amendment — TER and the edge cases deferred to #1434
