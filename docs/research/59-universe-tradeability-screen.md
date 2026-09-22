# 59 — A tradeability screen for the LSE leveraged-ETP pool

**Status:** DESIGNED (2026-09-03) — research for [#1002](https://github.com/dd-jp/samurai-trading-system/issues/1002), a wayfinder research ticket. This document designs and justifies a screen and sets up the decisions; it builds nothing. The gate itself is [#1054](https://github.com/dd-jp/samurai-trading-system/issues/1054).

**Label convention.** Every quantitative claim below is marked **[verified]** (read directly out of a repo artifact or a cited external page), **[derived]** (arithmetic on verified inputs, shown), **[inferred]** (a reading not stated in those words by any artifact), or **[assumed]** (a modelling choice, named as such). Unlabelled prose is argument, not evidence.

---

## 1. Question and scope

[#1002](https://github.com/dd-jp/samurai-trading-system/issues/1002) asks whether the LSE leveraged-ETP pool — 30 rows when #1002 was filed, **31 today** — should be screened for *tradeability* before anything ranks or trades it, and if so on what criteria. This document answers the design half: what the criteria are, what each needs, which are evaluable today, what thresholds follow from ADR-0018's geometry, and what David must decide. The implementation half — where the gate lives, what the pool file gains, what the selector refuses — belongs to sibling ticket [#1054](https://github.com/dd-jp/samurai-trading-system/issues/1054) and is not designed here beyond a recommendation in §8.

**The split, explicitly:** this doc proposes; #1054 disposes. No code, no pool edit, no ADR amendment is written here.

### 1.1 What this document may and may not use as evidence

Two collection paths this project has used before are now closed:

- **Yahoo Finance** — `docs/research/34-lse-mark-source-options.md` §5 records that Yahoo's terms bar automated collection.
- **The public londonstockexchange.com pages** — [#999](https://github.com/dd-jp/samurai-trading-system/issues/999) and [#1036](https://github.com/dd-jp/samurai-trading-system/issues/1036) record that LSE public-site Terms §8 bar programmatic access.

No data was collected from either path for this document, and no capture script was run (see §9).

Consequently:

- **The doc 58 F2b / F2c / F6 quote capture is treated as retracted** ([#1036](https://github.com/dd-jp/samurai-trading-system/issues/1036) is retracting it) and **not one figure from it is carried forward or relied on**, including the figures #1002's own body quotes. Where #1002's argument rests on those numbers, the argument is restated below from its structure alone.
- **Doc 58 F3** (the daily-bar history screen) and **doc 34 §3.3** (within-session print gaps) are cited here under a status: **the shape of these results survives, the numbers rest on a source the repo has ruled it cannot collect from again, and they cannot be re-measured on that path.** Every figure drawn from them below is marked *recorded 2026-08-19 / 2026-09-02, not re-measurable*. Doc 34 §3.3 carries a second caveat in its own text: Yahoo's 1-minute history reaches back about seven days, so even a permissible re-run would measure different sessions and reproduce the ordering, not the decimals.

  **This is a deliberate disagreement with [#1054](https://github.com/dd-jp/samurai-trading-system/issues/1054), and it should be read as one.** #1054's body says both halves of #1002's evidence "cannot be cited until re-measured", and its acceptance criteria say no figure from Yahoo-collected daily bars is cited as live evidence; F3 and doc 34 §3.3 are Yahoo-collected. The position taken here is narrower: [#1036](https://github.com/dd-jp/samurai-trading-system/issues/1036)'s retraction scope names F2b, F2c and F6 only, and the Yahoo bar in doc 34 §5 is a bar on **collection**, which this document did not do — a recorded measurement does not become false because the path that produced it is now closed to re-collection. If David or #1054's owner prefers the stricter reading, the mitigation is that **the headline conclusion does not depend on it**: D5's under-25 finding fires on criterion (e) alone — **19 sterling rows / 18 distinct underlyings** (3LUS duplicates 3SPY's SPY underlying, so the row count and the distinct-underlying count diverge by one), read straight off the pool file's `currency` field with no Yahoo data anywhere in the chain **[verified]** — and §5.2's combined-screen result (**zero** survivors, once [#1035](https://github.com/dd-jp/samurai-trading-system/issues/1035)'s per-line spread is folded in) is reachable on (b) and (e) alone, with no F3 input at all, **under the worst-case-entry reading of (b) that this document treats as governing (§3.2's canonical table)**.

  **Why worst-case entry, and what the weaker readings show instead.** ADR-0014's flat-by-close mandate fixes the *exit* leg of every round trip in the close bucket by construction — every position is flattened there regardless of when it was opened. The *entry* leg is not fixed: this is a static, entry-timing-unaware screen (§4), so at screen time the entry bucket is unknown. §3.2 sets out the full three-reading table (worst-case per instrument, modal/mid entry, best-case close entry) and the mechanical justification for reading each candidate on its own worst case rather than its best or most probable one — in short, (b) is a refusal gate, and refusing on a best-case reading lets negative-expectancy trades through, which a refusal gate must not do. **The result of that reading: none of the 12 sterling single-stock rows clears 36.1 bps on its own worst-case entry bucket** (closest are 3AAP at 44.2 bps and 3AMZ at 51.3 bps; full figures in §3.2), so the governing 0-survivor conclusion is F3-independent — it never needs (d) at all. One honest exception, stated plainly rather than hedged into a parenthetical: on the **modal** entry bucket (mid, 7 of 8.5 session hours — the most probable single reading, not the worst-case one) 3AAP's blended round trip falls to 35.0 bps, inside the ceiling, and only (d)/F3 removes it — so F3-dependence is real under that reading. And on the **close**-bucket entry (every row's best case, not a plausible typical case), 3AMZ's round trip looked like a tie with the ceiling at 1-dp display: doc 46's `close_rt` prints as **36.1 bps**, matching the ceiling's own 1-dp display (52.1 − 16). Recomputed directly from the archived DMD cache at full float precision (the same 480 two-sided close-bucket rows behind doc 46's `n_close`), 3AMZ's true `close_rt` is **36.101 bps**, against the ceiling's own unrounded value **36.0625 bps** (52.0625 − 16, not the displayed 52.1 — see §3.1 finding 2) — a **fail**, not a tie: two independently-rounded 1-dp figures matched by coincidence, not evidence of an exact tie at the underlying precision. 3AMZ is therefore not a (b)∩(d)∩(e) survivor under any tested reading — its own worst case (open-bucket entry) already fails at 51.3 bps, and the corrected close-bucket reading now fails too, at 36.10 bps.

---

## 2. Why this is a universe question, not a cost question

[#1002](https://github.com/dd-jp/samurai-trading-system/issues/1002) makes four arguments for putting the test in the universe rather than in the cost model. Restated, each tied to its artifact, and stripped of the retracted numbers:

**2.1 A cost model prices a trade; it does not refuse one.** The pipeline charges a modelled cost and proceeds. ADR-0018's brackets are fixed geometry — TP and SL are a fixed percentage of entry — so a line whose round-trip cost exceeds the bracket's budget does not produce a smaller trade, it produces a *negative-expectancy* trade every time. The correct action is refusal, and refusal is a universe act. This is the same structural point `docs/specs/universe-selector-spec.md` story 16 already makes in requiring a hard liquidity gate *before* any scoring. <!-- cite-exempt: historical — v1 record; the file was deleted per ruling G8 and is preserved at tag v1-final -->

**2.2 The binding constraint is arithmetic, stable, and knowable in advance — as a form of argument.** The minimum price increment on a venue puts a hard floor under the quoted spread: a book can be no tighter than one tick. Because a round trip crosses the book once in each direction, and the half-spread paid per side is at least half a tick when the book is at its minimum width:

```
round-trip spread cost (fraction of price)  >=  min_tick / price
```

**[derived]** — this is the minimum-width case; a wider book costs more, never less. So a cheap-in-pence line with a coarse tick is *structurally* expensive, and no amount of flow fixes it. That floor does not vary with the day's liquidity, which is what makes it a static universe property rather than a cost-model input.

**What the applicable tick table says.** UK MiFID RTS 11 (Commission Delegated Regulation (EU) 2017/588, as onshored) sets the tick regime. FCA Handbook Article 2 **[verified, retrieved 2026-09-03]** scopes it to *shares, depositary receipts and exchange-traded funds*, requires that trading venues "apply to orders in exchange-traded funds a tick size which is equal to or greater than the one corresponding to the liquidity band in the table in the Annex corresponding to the highest average daily number of transactions" — i.e. ETFs always take the *finest* column — and applies that limb **only where the underlying assets consist solely of equities "subject to the tick size regime under paragraph 1 or a basket of such equities"**.

The finest-band column of the Annex **[verified, legislation.gov.uk, retrieved 2026-09-03]**, denominated in the quotation currency's major unit:

| Price (currency units) | Tick | Price (currency units) | Tick |
| --- | --- | --- | --- |
| < 0.1 | 0.0001 | 50 – 100 | 0.01 |
| 0.1 – 0.2 | 0.0001 | 100 – 200 | 0.02 |
| 0.2 – 0.5 | 0.0001 | 200 – 500 | 0.05 |
| 0.5 – 1 | 0.0001 | 500 – 1 000 | 0.1 |
| 1 – 2 | 0.0002 | 1 000 – 2 000 | 0.2 |
| 2 – 5 | 0.0005 | 2 000 – 5 000 | 0.5 |
| 5 – 10 | 0.001 | 5 000 – 10 000 | 1 |
| 10 – 20 | 0.002 | 10 000 – 20 000 | 2 |
| 20 – 50 | 0.005 | 20 000 – 50 000 | 5 |

Less-liquid bands take **larger** ticks than this column; only the finest column was retrieved, so the direction of any error is known (every other band is worse) and its magnitude is not.

**The unit trap, stated before the arithmetic.** The table is denominated in the **major unit of the quotation currency**. 18 of 31 pool rows declare `GBX` **[verified, `server/providers/universe-pool/lse-etp-pool.ts`]** — pence — so a line quoted at 45p is price = **0.45 GBP**, which sits in the 0.2–0.5 band at a tick of 0.0001 GBP (= 0.01p). Reading the same line as "price 45" puts it in the 20–50 band at a tick of 0.005: the two readings differ by 100x in the price, land in different bands, and yield different ticks and different floors. `docs/research/34-lse-mark-source-options.md` §3.2 records this exact 100x hazard live in this pool: the file declares `GBP` for 3AAP where the venue reports `GBp`. Any implementation of criterion (a) must normalise to one unit first.

Worked illustration, finest band, prices **hypothetical** (the pool file carries no price field and no permissible price source is established — see §2.5):

| Hypothetical price | Tick | `tick / price` = round-trip floor |
| --- | --- | --- |
| 0.05 GBP (5p) | 0.0001 | 20.0 bps **[derived]** |
| 0.10 GBP (10p) | 0.0001 | 10.0 bps **[derived]** |
| 0.25 GBP | 0.0001 | 4.0 bps **[derived]** |
| 0.50 GBP | 0.0001 | 2.0 bps **[derived]** |
| 1.00 GBP | 0.0002 | 2.0 bps **[derived]** |
| 2.00 GBP | 0.0005 | 2.5 bps **[derived]** |

Read the other way: against the 36.1 bps ceiling derived in §3.1, the finest-band tick binds only below about **2.8p** (0.0001 / 0.00361) **[derived]**, and at 0.50 GBP and above every band in that column carries a floor of under 3 bps **[derived]**. On the finest band the tick floor is therefore not the binding constraint at any plausible price — which is precisely why establishing *which* band these lines sit in matters.

**2.3 Where the argument stops.** Whether RTS 11's ETF limb reaches *these* instruments is **not established**. The pool's 31 rows come from Leverage Shares (15), GraniteShares (13) and WisdomTree (3) **[verified, pool file]**; the issuer's own product page describes them only as "Exchange Traded Products (ETPs)" and directs the reader to the prospectus and KIID for structure **[verified, leverageshares.com, retrieved 2026-09-03]** — it does not state whether they are funds or secured notes. If they are notes rather than ETFs, the Article 2 limb does not reach them at all; and even for a fund, the limb requires underlyings "solely equities subject to the share tick size regime", which US-listed underlyings are not. **What would establish it:** [#1032](https://github.com/dd-jp/samurai-trading-system/issues/1032) (the Saxo instrument list, which carries per-instrument tick and price increments) or [#1035](https://github.com/dd-jp/samurai-trading-system/issues/1035) (LSEG Delayed Market Data). So #1002's tick argument survives **as a form of argument** and fails **as an established fact about these lines**.

**2.4 The pool is already screened on one property, badly.** `docs/specs/universe-selector-spec.md` records that the only gate today is the static `t212_isa` flag, and calls it a known weakness: a name that is tradeable but expensive currently passes the gate **[verified]**. All but one of the pool's 31 rows carry `t212_isa: true` **[verified, pool file]** — 3LUS is the sole `t212_isa: false` exception — so the gate as shipped discriminates almost nothing, and it is keyed to a venue the project has since barred (ADR-0015's 2026-08-30 amendment; [#896](https://github.com/dd-jp/samurai-trading-system/issues/896)). The screen designed here replaces a flag that is both nearly inert and obsolete. <!-- cite-exempt: historical — v1 record; the file was deleted per ruling G8 and is preserved at tag v1-final -->

**2.5 The pool file has no price, no spread and no liquidity field.** Its per-row payload is ticker, screening instrument, subclass, currency, `t212_isa`, `subclass_envelope_measured`, and a provenance block **[verified, pool file]**. Everything a tradeability screen wants to test is therefore either (i) already-recorded research, (ii) a static declaration, or (iii) absent and gated on a vendor. §3 marks which is which for each criterion.

---

## 3. The candidate criteria

Thresholds are derived from ADR-0018's bracket geometry and `docs/research/54-capital-economics-vs-signal-accuracy.md`'s break-even identity. The derivation is set out once, here, then applied.

### 3.0 The exchange rate between cost and required accuracy

Doc 54 §2's identity **[verified]**: `E(p) = (p − 0.5) × width + E_net`, with `E_net = E_gross − cost`. Setting **`E_gross = 0` is a modelling choice [assumed]**, not a measurement — it credits the instrument with no intrinsic drift over the session — and §3.1 shows it decides the *sign* of one headline, so it is flagged again there. With `E_gross = 0` the required directional edge above a coin flip is

```
required edge (pp)  =  round-trip cost (%) / bracket width (%) x 100
```

ADR-0018 D3 **[verified]**: the index bracket is TP +2.00% / SL −2.16% (width **4.16%**) with an assumed round trip of 0.18% and a stated bar of **4.33 pp**; the single-stock bracket is TP +6.00% / SL −6.25% (width **12.25%**) with 0.41% and **3.35 pp**. The formula reproduces both to the digit — 0.18/4.16 = 4.33, 0.41/12.25 = 3.35 **[derived]** — so the exchange rate is exact:

> **1.00 pp of required accuracy = 4.16 bps of round-trip cost on the index bracket, and 12.25 bps on the single-stock bracket. [derived]**

The index bracket is **~3x more cost-sensitive per basis point** than the single-stock bracket, because it is ~3x narrower.

**What ADR-0018's 0.18% / 0.41% do and do not include. [inferred]** They are *spread* quotes: ADR-0016 sources the leveraged-ETP case to an observed spread quote, and doc 58 F4 records that the cost model's `commissionRate` is **0** for stocks — correctly, since Alpaca US equities are commission-free — leaving only the 1 bp-per-side `STRUCTURAL_MIN_COMMISSION_RATE` floor, i.e. **~2 bps of commission round trip against Saxo's 16** **[verified]**. No document states in those words that the D3 figures exclude venue commission; this is an inference from those two facts, and it is the single load-bearing inference in §3. **Saxo charges 8 bps per side with no per-order minimum (`docs/adr/0015-live-venue-account-and-book-split.md`), i.e. 16 bps round trip [verified] — a cost ADR-0018's bar never charged.** Doc 54 §2's 2026-09-14 amendment (`#1218`) reaches the same per-name figures as this section's earlier cross-check — reproducing them, not an independent derivation — and it does not discharge this `[inferred]` tag, only reproduces it; see doc 54 §2's amendment for the full alignment note. <!-- cite-exempt: historical — v1 record; the file was deleted per ruling G8 and is preserved at tag v1-final -->

### 3.1 The accuracy budget, and the spread ceiling that falls out of it

`docs/adr/0017-validation-gates-paper-operational-thesis-expectancy.md` sizes its gates against "a strategy claiming a ~55% win rate" **[verified]** — i.e. **+5.00 pp** over a coin flip. **Treating that figure as the whole accuracy budget the system is allowed to spend is [assumed], not verified**: in ADR-0017 it is a *claimed* win rate feeding a statistical-power calculation for gate sizing, not an allowance the system is entitled to. It is used here because it is the only edge figure the project has committed to in writing, and §3.1's table shows what happens under other assumptions. Doc 54 §5 charges the LLM bill against it at the ADR-0018 D5-resolved notionals (£350 index / £250 single-stock out of the £1,000 book): **1.58 pp (index) / 0.75 pp (single-stock) [verified]**. What remains buys execution cost: <!-- cite-exempt: historical — v1 record; the file was deleted per ruling G8 and is preserved at tag v1-final -->

```
max total round-trip cost (bps) = (assumed edge pp − LLM bill pp) x bps-per-pp
max quoted spread (bps)         = that − 16 bps Saxo commission
```

| Assumed edge | Index: total cost ceiling | Index: spread ceiling | Single-stock: total | Single-stock: spread ceiling |
| --- | --- | --- | --- | --- |
| +4.0 pp | 10.1 bps | **−5.9 bps** | 39.8 bps | 23.8 bps |
| **+5.0 pp (ADR-0017)** | **14.2 bps** | **−1.8 bps** | **52.1 bps** | **36.1 bps** |
| +6.0 pp | 18.4 bps | +2.4 bps | 64.3 bps | 48.3 bps |
| +7.0 pp | 22.6 bps | +6.5 bps | 76.6 bps | 60.6 bps |

All **[derived]** from the verified inputs above. Published as a function of the assumed edge deliberately: a single headline number would be a hand-fitted coefficient, and the sensitivity is the point.

**Two findings fall straight out.**

1. **At ADR-0017's own assumed win rate the index bracket has a non-positive spread budget: −1.8 bps.** Saxo's commission alone (16 bps) exceeds the 14.2 bps of total cost the index bracket can afford. The index leg does not fail on any *instrument's* spread — it fails on venue commission before a spread is quoted. It needs an assumed edge above **+5.42 pp [derived]** merely to reach a zero spread budget.

   **The sign of this finding depends on the `E_gross = 0` choice [assumed], and on QQQ it flips.** Doc 54's table implies a positive `E_gross` for each name (`E_gross = cost + E_net`): QQQ's is **+5.69 bps** (0.18 − 0.1231), larger than the 1.8 bps deficit, so crediting it gives the index bracket **+3.9 bps** on QQQ (20.8 − 6.57 + 5.69 − 16) **[derived]** — and QQQ is the underlying of LQQ3, the one index line in the (d)∩(e) candidate set (§5.2), though it still fails criterion (b) by construction (§3.1 finding 1; a non-positive spread budget rejects every index row regardless of measured spread). SPY's `E_gross` is only **+0.55 bps**, so SPY stays negative either way **[derived]**. The conclusion is not rescued by this, because §3.2's independent route reaches it without the assumption: doc 54's own QQQ bar plus commission plus the LLM bill requires **58.4% accuracy**, against ADR-0017's ~55%. Read finding 1 as *"the index bracket has no meaningful spread budget"* rather than as a precise negative number.
2. **The single-stock bracket's ceiling is 36.1 bps of round-trip quoted spread at 1-dp display** at the same assumption — real, but not generous. The exact, unrounded figure is **36.0625 bps** (52.0625 − 16, from §3.0's identity before rounding to the 52.1 bps shown in §3.1's table) — 36.1 is a display convention, not the binding threshold, and the two can diverge: doc 46's 1-dp `close_rt` for 3AMZ also displays as 36.1 bps, which reads as an exact tie against the displayed ceiling but is a **fail** against the true 36.0625 bps ceiling once both sides are read at full precision (§1.1, §5.2). Ties at the true, unrounded threshold pass — every other threshold in this document is inclusive (`>= 250`, `<= 2%`) — but a bare 1-dp match between two independently-rounded figures is not evidence of an exact tie, only of rounding to the same digit. `<= 36.0625 bps` is the canonical threshold; `<= 36.1 bps` remains a safe working figure everywhere the measured spread clears it by more than rounding error (every comparison in this document except 3AMZ's close-bucket reading, corrected above).

**This is the subclass-level budget the per-line screen is read against.** As of 2026-09-15, [#1035](https://github.com/dd-jp/samurai-trading-system/issues/1035)'s `46-lseg-dmd-pretrade-surface.md` supplies a permissibly-collected per-line round-trip spread for 30 of 31 pool rows, so criterion (b) **is now evaluable per line** — see §3.2's table below for the result.

### 3.2 The criteria, one table

| # | Criterion | What it measures | Why it matters at ADR-0018 scale | Data needed | Permissibly available today? | Proposed threshold |
| --- | --- | --- | --- | --- | --- | --- |
| (a) | **Tick/price floor** | Structural minimum round-trip cost, `min_tick / price` | A floor above the §3.1 ceiling makes every trade negative-expectancy regardless of signal quality | Per-line tick increment and price, in one unit | **No.** No price field in the pool; no permissible price source; and the applicable tick regime for these ETPs is not established (§2.3) | `tick / price <= 36.1 bps` single-stock; the index bracket has no positive budget to spend. **Not evaluable — gated on #1032 / #1035** |
| (b) | **Max quoted round-trip spread** | The half-spread actually paid, both sides | Consumes the accuracy budget directly at 4.16 / 12.25 bps per pp | Live or delayed bid/ask per line | **Yes, per-line, as of 2026-09-15** — [#1035](https://github.com/dd-jp/samurai-trading-system/issues/1035)'s `46-lseg-dmd-pretrade-surface.md` measures this threshold directly from permissibly-collected LSEG Delayed Market Data for 30 of 31 pool rows; doc 58's retracted capture (#1036) is superseded, not the source any more | `<= 36.1 bps` round trip (single-stock, +5 pp, §3.1); index `<= 0` bps, i.e. unsatisfiable as bracketed. See the canonical worst-case table below for the governing count |
| (c) | **Print frequency / max within-session gap** | Whether the line trades often enough to mark, enter, and — under flat-by-close — exit | ADR-0014 flattens at 16:25 London regardless; a line that goes forty minutes without a print cannot be exited on demand | Within-session print times | **Partly.** `docs/research/34-lse-mark-source-options.md` §3.3, **11 of 31 rows only**, *recorded 2026-08-19, not re-measurable* | `<= 10%` of within-session print gaps exceed the 15-minute `max_mark_age` bound |
| (d) | **Minimum usable price history** | Whether the line has enough non-degenerate daily bars to be measured at all | A line returning one bar in two years cannot be screened, sized, or evaluated by any downstream research | Daily OHLCV, two years | **Recorded only.** `docs/research/58-cost-floor-sizing-and-per-instrument-spread.md` F3, *recorded 2026-09-02, not re-measurable* | `usable_pairs >= 250` **and** `flat_days / bars <= 2%` (F3's own declared screen) |
| (e) | **Quotation currency** | Whether the line is sterling, per [#659](https://github.com/dd-jp/samurai-trading-system/issues/659)'s GBP LSE restriction | A USD line inside a GBP GIA adds an FX conversion on both legs, costed nowhere in the model | The pool's `currency` field, venue-confirmed | **Yes** for the declaration; venue confirmation partial (doc 34 §3.2 covers 11 rows) | `currency` in `{GBP, GBX}` |

**Threshold derivations, one line each.**

- **(a)** and **(b)** come from §3.1's table read at ADR-0017's +5.00 pp: the total ceiling, minus Saxo's verified 16 bps round trip.
- **(c)** is not derived from ADR-0018 — it is inherited from the existing 15-minute `max_mark_age` bound and doc 34 §3.3's finding that a last-trade mark fails on illiquidity alone. The 10% allowance is **[assumed]**, chosen as roughly one over-long gap per session on a normal print count, and is the one threshold here with no arithmetic behind it.
- **(d)** is F3's own pre-declared screen, adopted unchanged rather than re-fitted to a preferred answer. Note that its two limbs measure different things: `usable_pairs >= 250` is **vendor coverage** (did the source return bars?), while `flat_days <= 2%` is **instrument behaviour** (did the price move?). A line returning one daily bar in two years is at least as likely a vendor artifact as a fact about the instrument — which is an argument for gating such a row with a recorded reason rather than deleting it (D3), since the reason may dissolve when #1035 arrives.
- **(e)** is #659's restriction, not a new threshold.

**Criterion (b), in full: the entry-bucket problem and the canonical count.** Doc 46 measures round-trip spread separately in three intraday buckets (open 07:05–07:59, mid 08:00–14:59, close 15:00–15:30 UTC) and states the identity `round-trip == 2x half-spread` throughout. A single-bucket reading of (b) — e.g. "measure everything in the open bucket, since that is doc 46's own headline" — is a modelling choice, not a fact about the instrument, and §1.1's earlier drafts of this document picked the reading that happened to preserve a 0-survivor result without saying why that reading was the right one. The correct model follows from ADR-0014's flat-by-close mandate directly: every position is exited in the **close** bucket by construction, regardless of when it was opened, so the exit leg of the round trip is fixed; the **entry** leg is not — this is a static, entry-timing-unaware screen (§4), so at screen time the entry bucket is unknown. The mechanically-justified blended round trip is therefore `entry_hs(bucket X) + close_hs`, evaluated once per instrument for whichever reading of X is being tested.

**Why the screen must use each instrument's own worst-case entry bucket, not its best or most probable one.** (b) is a *refusal* gate (§2.1): it exists to stop a line whose realised cost will exceed the accuracy budget from ever being traded. Screening a candidate on its best-case entry reading lets through trades that will, on a worse but equally reachable entry, be negative-expectancy — the gate fails exactly the way it is meant not to. Screening on each instrument's own worst-case *bucket* can only over-refuse relative to picking a different bucket, never under-refuse along that dimension — it never misses a case a better-bucket reading would have refused. That is not an absolute guarantee against under-refusal: each bucket figure is itself a **median** of quote-update ticks (`46-lseg-dmd-pretrade-surface.md:244-247`), so on any given entry inside even the worst bucket, roughly half the ticks are wider than the reported figure and could still let a genuinely negative-expectancy trade through. For a refusal gate the two error directions along the bucket-choice dimension are not symmetric, so worst-case-per-instrument is the correct reading independently of which entry bucket happens to be *most probable* — even though, separately, mid is in fact the modal bucket (7 of 8.5 session hours), which is why it is also reported below.

The three readings, run over all 12 covered sterling `single_stock_etp_3x` rows (the full (e)-passing single-stock candidate set, not pre-filtered by (d) — see §5.2 for why that matters) **[derived, from doc 46's `open_hs`/`mid_hs`/`close_hs` columns]**:

| Entry-bucket reading | (b) passers among the 12 sterling single-stock rows | Combined (b)∩(d)∩(e) survivors | Does the result depend on (d)/F3? |
| --- | --- | --- | --- |
| **Worst-case per instrument** (the screen's governing rule) | **none** — closest are 3AAP (44.2 bps) and 3AMZ (51.3 bps) | **0** | **No** — reached on (b)∩(e) alone |
| Mid / modal entry (7 of 8.5 session hours, the single most probable bucket) | 3AAP (35.0 bps) | 0 | **Yes** — 3AAP is removed only by (d); F3 fails it |
| Close entry (every row's *best* case, not a plausible typical case) | 3AAP (28.8 bps) only — 3AMZ displays as 36.1 bps at 1-dp but is **36.10 bps at full precision**, against the true 36.0625 bps ceiling (§3.1 finding 2): a fail, not a tie | **{}** — empty | Moot — both fail (b); 3AAP also fails (d) regardless |

Per-instrument worst-case figures (worst-case entry bucket, always open except where noted; worst blended = worst entry `_hs` + close `_hs`) **[derived, doc 46]**: 3AAP 29.8+14.4=44.2; 3AMZ 33.2+18.1=51.3; 3FB 32.6+20.2=52.8; 3ARM 85.8+43.1=128.9; 3LNP 93.5+54.1=147.6; LAM3 84.3+78.5=162.8; LAA3 109.4+63.4=172.8; 3RAC 88.5+87.0=175.5; 3UBR 132.2+67.4=199.6; LPP3 157.9+69.4=227.3; 3LIP 333.3+133.4=466.7; **LCO3 322.6(mid)+285.7=608.3 — its worst entry bucket is *mid*, not open**, the one exception among the 12 and the concrete proof that "worst case" has to be checked per instrument rather than assumed to always be the open bucket. All 12 fail 36.1 bps under their own worst case.

**The governing conclusion is the worst-case row: the true worst-case-robust survivor count is 0, reached on (b)∩(e) alone, with no F3 input at all.** This is a strictly stronger claim than earlier drafts of this document made (which scoped the F3-independent 0-result to an unargued open-bucket-only reading). A close-bucket exception for 3AMZ was reported in an earlier draft on a 1-dp tie; recomputed at full precision it is a fail, not a tie (§1.1, §3.1 finding 2, §5.2) — the close-bucket reading, like the worst-case reading, has zero survivors.

**Doc 54's per-name break-evens, with Saxo commission added [derived]** — an independent cross-check that these numbers bite. Doc 54's published bars **[verified]**: QQQ 2.96 pp and SPY 4.19 pp on the index bracket; PLTR 1.29 pp and MSTR 7.16 pp on the single-stock bracket. Those bars charge ADR-0018's own 0.18% / 0.41% round trip **[verified, doc 54 §2]** — the same spread-only figures §3.0 discusses, not the pipeline's ~4 bps modelled cost — so adding Saxo's full 16 bps double-counts nothing. On a **commission-only** basis (16/4.16 = 3.85 pp index; 16/12.25 = 1.31 pp single-stock) the required accuracy becomes about **56.8% (QQQ)**, **58.0% (SPY)**, **52.6% (PLTR)** and **58.5% (MSTR)** **[derived]**; charging the LLM bill as well adds 1.58 pp to the index pair and 0.75 pp to the single-stock pair (**58.4% / 59.6% / 53.4% / 59.2%**) **[derived]**. On either basis, consistently applied, both index names are already the wrong side of ADR-0017's ~55% before any spread is quoted.

---

## 4. Static screen or live screen?

**A static screen** evaluates each pool row once, or on a periodic review, and refuses entries in failing lines. **A live screen** evaluates the current quote in-session and refuses — or exits — on breach.

**The live option is unimplementable today.** It needs a permissible in-session quote source, and there is none: [#895](https://github.com/dd-jp/samurai-trading-system/issues/895) has not provided a vendor, [#999](https://github.com/dd-jp/samurai-trading-system/issues/999) closed at the terms gate, and [#1035](https://github.com/dd-jp/samurai-trading-system/issues/1035)'s LSEG Delayed Market Data is 15 minutes delayed and not yet registered.

**The stronger objection is structural, and survives a vendor arriving.** Ask what a live screen *does* when an open position's line breaches mid-session, under ADR-0014's flat-by-close rule:

- **Exit immediately** — the position is liquidated into exactly the conditions the screen exists to avoid, paying the widened spread at the worst possible moment and converting a cost signal into a realised loss.
- **Hold to the 16:25 flatten** — which is what the system does anyway. The screen changed nothing.
- **Drop the line from the universe while still holding it** — the system now holds a position in an instrument it has declared untradeable, with no rule covering it.

None of the three is an improvement. **A live screen's only coherent action is refusing new entries — which is exactly what a static screen already does, without a vendor.**

**Recommendation: static, applied at entry only, reviewed periodically** (quarterly, or whenever the pool file changes) rather than per tick.

**One implementation constraint for [#1054](https://github.com/dd-jp/samurai-trading-system/issues/1054), stated because this repo has shipped the bug before:** the gate must be **entry-only by construction**. A guard placed above an early return has already, once, blocked exits and the flat-by-close flatten as well as entries. A tradeability gate that can refuse an exit is worse than no gate at all.

---

## 5. What happens to the failing lines — and how many are left

Three options for a line that fails: **removed** from the pool; **retained with a prohibitive per-instrument cost**, so the pipeline prices it out; or **retained but gated**, with a flag the selector honours.

Retention-with-prohibitive-cost is the weakest of the three: it re-introduces the §2.1 problem (a priced trade is still a permitted trade), and doc 58 F5 already records that the cost floors are module-private constants rather than a per-instrument table, so there is nowhere clean to put it. The real choice is between **removed** and **retained-but-gated**; retained-but-gated preserves the provenance block and the reason, which matters because most failures here are *"not established yet"* rather than *"proven bad"*.

### 5.1 Count per criterion

The pool today: **31 rows / 26 distinct screening instruments**, 9 `index_etp_3x` and 22 `single_stock_etp_3x`, issuers Leverage Shares 15 / GraniteShares 13 / WisdomTree 3, and **zero ETCs** despite ADR-0016 defining the universe as leveraged index ETPs "plus commodity ETCs" **[verified, pool file]**.

| Criterion | Rows evaluable | Rows passing | Note |
| --- | --- | --- | --- |
| (a) tick/price | **0 of 31** | — | No price field, no permissible price source, tick regime not established (§2.3) |
| (b) spread ceiling | **30 of 31** | **1** on the open-bucket single-snapshot reading — NVD3; **2 pool-wide** on the governing worst-case reading (§3.2's metric applied to all 30 covered rows) — NVD3 (21.9 bps) and PLT3 (31.6 bps) | Doc 46, *permissibly collected, 2026-09-15*; index rows fail by construction (§3.1); §3.2's own 12-row table correctly shows 0 of the *sterling* single-stock rows passing the worst-case reading — NVD3 and PLT3 pass only because both are USD-declared and fall outside that sterling-only set, so both are eliminated by criterion (e) regardless; MST3 is the one uncovered row |
| (c) print gaps | **11 of 31** | **2** — LQQ3 (3.2%), PLT3 (7.3%) | Doc 34 §3.3, *recorded 2026-08-19, not re-measurable*; NVD3 fails narrowly at 11.5%; 3LPA printed four times in five whole sessions; 20 rows never probed |
| (d) usable history | **30 of 31** | **10** — 3USL, LQQ3, NVD3, 3LNV, MST3, PLT3, LCO3, 3AMZ, 3FB, 3ARM | Doc 58 F3, *recorded 2026-09-02, not re-measurable*; 3LUS is the one row F3 never evaluated |
| (e) sterling | **31 of 31** | **19** | 18 `GBX` + 1 `GBP` as declared; 20 if doc 34 §3.2's venue reading of 3QQQ as `GBp` is preferred over the file's `USD` |

### 5.2 The combined count

(b), (d) and (e) are now all evaluable across the whole pool; the combined screen is their intersection, and it is **empty** — governed by the worst-case-entry reading of (b) that §3.2 sets out and justifies.

**The governing reading — worst-case entry, per instrument — reaches zero on (b) and (e) alone, with no F3 input at all.** §3.2's canonical table shows none of the 12 covered sterling `single_stock_etp_3x` rows clears 36.1 bps on its own worst-case entry bucket, so the combined screen is empty before (d) is ever consulted. Every `index_etp_3x` row fails (b) separately, by construction (§3.1) — its subclass's spread budget is non-positive regardless of measured spread or entry bucket. That leaves the full sterling single-stock candidate set below, not just the five that happened to already pass (d) under the earlier open-bucket-only approach:

| Line | Underlying | Worst-case entry bucket | Worst-case blended round trip | vs. 36.1 bps ceiling | (d)/F3 |
| --- | --- | --- | --- | --- | --- |
| 3AAP | AAPL | open | 44.2 bps | fail | fail |
| 3AMZ | AMZN | open | 51.3 bps | fail | pass |
| 3FB | META | open | 52.8 bps | fail | pass |
| 3ARM | ARM | open | 128.9 bps | fail | pass |
| 3LNP | NFLX | open | 147.6 bps | fail | fail |
| LAM3 | AMD | open | 162.8 bps | fail | fail |
| LAA3 | BABA | open | 172.8 bps | fail | fail |
| 3RAC | RACE | open | 175.5 bps | fail | fail |
| 3UBR | UBER | open | 199.6 bps | fail | fail |
| LPP3 | PYPL | open | 227.3 bps | fail | fail |
| 3LIP | NIO | open | 466.7 bps | fail | fail |
| LCO3 | COIN | **mid** | 608.3 bps | fail | pass |

**0 rows / 0 distinct underlyings survive the combined (b)∩(d)∩(e) screen under the governing worst-case reading. [derived]** All 12 sterling single-stock rows fail (b) on their own worst case, so (d)'s pass/fail column above is informational, not load-bearing — the result does not turn on F3 at all. LQQ3 (index, QQQ) fails separately and by construction, the same as every other `index_etp_3x` row. NVD3 and PLT3, the pool's two governing-worst-case-reading (b)-passers (§5.1, §3.2's metric applied to all 30 covered rows), are both USD-declared and fail (e) regardless.

**One weaker reading exists and is reported honestly, not folded into the headline.** §3.2's table gives the modal-entry reading (mid bucket, the single most probable one, 7 of 8.5 session hours): there, 3AAP's blended round trip falls to 35.0 bps, inside the ceiling, and only (d)/F3 removes it — so under that specific reading the "no F3 needed" claim does not hold, though 3AAP is still not a survivor (it fails (d)). A close-bucket (best-case-only) reading was previously read as giving 3AMZ a genuine survivor at an exact 36.1 bps tie; recomputed at full precision directly from the archived DMD cache, 3AMZ's true close-bucket round trip is 36.10 bps against the ceiling's own unrounded 36.0625 bps (§3.1 finding 2) — a fail, not a tie, so the close-bucket reading also yields zero survivors. Neither weaker reading changes the governing worst-case conclusion, and the close-bucket reading no longer produces any exception at all (§3.2 gives the full reasoning).

**What this means.** The screen this document set out to build — history, currency and now a measured spread ceiling — has no survivors in the current pool under its governing (worst-case) reading. Every sterling single-stock candidate fails (b) on its own worst-case entry, and the pool's one open-bucket-reading (b)-passer fails (e). This is not a data gap closing in on an answer — it is an answer: the pool as composed has zero rows that are simultaneously priced within budget on their own worst case, long enough history to screen, and sterling-denominated.

Layering the partially-measurable criterion (c) on top changes nothing: it can only remove rows, and there are none left to remove. (c) is therefore moot for this result — worth noting only because criterion (c) was, in an earlier draft of this document, the tie-breaker for a non-empty survivor set that no longer exists.

### 5.3 The no-ranking clause fires, unambiguously

`docs/specs/universe-selector-spec.md` records: "If the pool lands under ~25 rows, ship without the ranking and trade the whole pool", and record that as the reason **[verified]**. Today the rankable count is **26 distinct screening instruments** — just over the line. Under the combined screen it is **0**. <!-- cite-exempt: historical — v1 record; the file was deleted per ruling G8 and is preserved at tag v1-final -->

**The clause does not fire marginally; it fires absolutely.** Any threshold set drawn from §3 — indeed criterion (e) on its own, at 18 distinct underlyings across 19 sterling rows — puts the pool under 25, and the combined screen leaves nothing at all. There is no plausible reading of the permissible evidence in which a ranked selection over this pool is worth building. That should be recorded as the reason, exactly as the spec asks.

One consequence worth putting in front of David: this is not primarily a currency or history problem, it is a **spread** problem. Every `index_etp_3x` row fails (b) by construction — §3.1 says the index bracket has no meaningful spread budget at ADR-0017's assumed win rate, non-positive under the `E_gross = 0` choice **[assumed]**, and about +3.9 bps if QQQ's implied `E_gross` is credited, still less than a quarter of the single-stock bracket's — and every covered *sterling* `single_stock_etp_3x` row fails its own, more generous ceiling on its own worst-case entry bucket (§3.2). Two non-sterling single-stock rows, NVD3 and PLT3, do clear it — but both are USD-declared and fail criterion (e) instead, so the combined screen result is unchanged. A pool with a non-empty combined screen needs either a materially wider accuracy budget (§3.1), or sterling single-stock lines actually measured inside 36.1 bps on their worst case, or both.

---

## 6. Does ADR-0016 need amending?

ADR-0016 already carries an explicit known-weakness section recording that **the entire leveraged-ETP case rests on one observed 0.18% spread quote for 3USL** **[verified]**. Nothing in this document contradicts the ADR; it sharpens what that weakness costs. The options, none of them written here:

1. **No amendment.** The weakness is already recorded in the ADR's own words, and the two things this document adds — Saxo's 16 bps, and the absence of per-line evidence — belong to ADR-0015 and to #1035/#1032 respectively. Defer until a permissible per-line spread exists.
2. **Narrow the universe**, amending the ADR's definition from the whole LSE leveraged-ETP pool to the screened subset, citing the screen.
3. **Delete the unencoded ETC leg.** The ADR defines the universe as leveraged index ETPs "plus commodity ETCs"; the pool contains **zero ETCs** **[verified]**. The ADR describes a universe the code has never had.
4. **Record the index-bracket budget finding** (§3.1) — though it is arguably ADR-0018's to record, since it is that ADR's bracket widths that produce it.

Recommendation in §8. Option 1 is stronger than it looks, precisely because the ADR already says the thing.

---

## 7. Decidable now vs waiting on a vendor

**Decidable now, on permissible evidence:**

- Whether a tradeability screen gates the pool at all (§2).
- Static vs live, and the entry-only construction (§4).
- The fate of failing lines: removed / prohibitive-cost / gated (§5).
- Criterion (e), currency — the field is in the file today; 19 of 31 pass.
- Criterion (d), history — F3's screen is recorded; 10 of 30 pass.
- That the under-25 no-ranking clause fires (§5.3).
- The *form* of criterion (a), and both criteria's thresholds as a function of the assumed edge (§3.1).
- Criterion (b) evaluated per line, and the combined screen it yields. **#1035 reported 2026-09-15**
  (`46-lseg-dmd-pretrade-surface.md`) supplies a permissibly-collected round-trip spread for **30 of 31
  pool rows** (MST3 confirmed absent from LSEG's SI feed) — a retrospective research aggregate, not the
  live path #895 still owes for production consumption, but sufficient to evaluate (b) now: on the
  governing worst-case-entry reading (§3.2), 0 of the 19 sterling rows clear their subclass's threshold
  (two non-sterling `single_stock_etp_3x` rows, NVD3 and PLT3, do clear it but are removed by criterion
  (e) instead), and the combined (b)∩(d)∩(e) screen is empty on that reading with no F3 input at all
  (§5.2).
- That the index bracket's spread budget is non-positive at ADR-0017's assumed win rate — this needs no per-line data at all.

**Waiting on a vendor or a venue list:**

- Criterion (a) evaluated per line — needs price and tick increment: **#1032** (Saxo instrument list) or **#1035** (LSEG DMD).
- Whether RTS 11's ETF tick limb reaches these ETPs at all — **not established**; #1032 settles it operationally by publishing the actual increments.
- Criterion (b) as a **production/live** input rather than a retrospective one — needs #895's mark-vendor choice resolved, not just a permissible spread figure.
- Criterion (c) for the 19 unprobed rows, and refreshed for the 11 — needs an in-session print source: **#1035 / #895**.
- Whether Saxo lists each surviving line at all, and its FX treatment on non-sterling lines: **#1032**.
- Whether 8 bps per side is the final commission figure for this account tier: **#1032**.

---

## 8. Decisions for David

Each is one question, answerable yes/no or by picking a listed option. Recommendations are advisory; this is a wayfinder research ticket and the decisions are his.

**D1. Does the pool gain a tradeability screen as a hard gate, evaluated before any ranking or scoring?** (yes / no)
*Recommendation: yes.* Evidence: **strong, structural** — §2.1 and the selector spec's own story 16; depends on no retracted number.

**D2. Static screen, or static plus an in-session live check?** (a: static only, entry-only / b: static plus live)
*Recommendation: (a).* Evidence: **strong** — (b) is unimplementable today for want of a permissible quote source, and §4 shows it has no coherent action even once one exists.

**D3. What happens to a line that fails the screen?** (a: removed from the pool / b: retained with a prohibitive per-instrument cost / c: retained with a `tradeable: false` flag and a recorded reason, honoured by the selector)
*Recommendation: (c).* Evidence: **medium** — a design judgement, not a measurement. Most failures here are "not established yet", and deleting the row deletes the provenance and the reason with it.

**D4. Is [#659](https://github.com/dd-jp/samurai-trading-system/issues/659)'s GBP restriction enforced by dropping the 12 non-sterling rows, or relaxed to permit USD/EUR lines with an explicit FX cost?** (a: enforce, drop them / b: relax, and cost the FX)
*Recommendation: (a) for now.* Evidence: **strong on the counts** (19 of 31 sterling, verified in the file), **weak on the alternative** — no FX cost is modelled anywhere, and Saxo's FX treatment is unconfirmed until #1032.

**D5. The combined screen now leaves zero rows, not the five this question was originally framed around — "trade the whole surviving pool" has no referent to accept or decline.** Do we accept the universe-selector spec's under-25 clause on that basis (0 of 26, criterion (e) alone already gets under 25 without touching either not-re-measurable figure), and treat the real decision as §6's amendment question — does ADR-0016's universe change, or does the pool stay declared with every row gated `tradeable: false` per D3? (yes, the clause fires / no)
*Recommendation: yes, the clause fires.* Evidence: **strong** — the arithmetic that used to require accepting a 5-row exception now requires nothing be accepted at all; nothing survives to rank. Where this decision actually bites is D6 and §6, not here.

**D6. The index bracket's spread budget is non-positive once Saxo's 16 bps commission is charged. Which way?** (a: drop `index_etp_3x` from the live universe / b: re-derive ADR-0018's index bracket wider under a new ticket / c: accept it, and let the required signal accuracy rise above ADR-0017's assumption)
Option (a) costs nothing that the combined screen has not already removed: every `index_etp_3x` row already fails (b), so dropping the subclass changes no line's tradeability outcome today — it only narrows ADR-0016's declared universe going forward, so it lands in §6's amendment question too. Option (b) is not a free parameter, on two counts. Mechanically, widening the bracket lowers cost-sensitivity (bps per pp scales with width) but also lowers the probability the take-profit is reached inside the session, and ADR-0018 D3's widths were set against measured reach. Procedurally, **ADR-0018's 2026-08-17 amendment calls the single neutral bracket "the terminal exit rule of this ADR", frozen by #724/#739 and encoded in `server/pipeline/trader/subclass-bracket.ts`** — so choosing (b) means amending an ADR that pre-declared this question closed. That is a reason to be sure of §3.0's inference first, not a reason the option is unavailable.
*Recommendation: (b).* Evidence: **derived, resting on one inference** — that ADR-0018's 0.18% / 0.41% exclude venue commission (§3.0). If that inference is wrong, D6 dissolves; it should be checked against #1032's confirmed commission schedule before anything is acted on.

**D7. Amend ADR-0016 now, or defer until #1035/#1032 supply per-line evidence?** (a: amend now, picking from §6's options / b: defer)
*Recommendation: (b), with one exception* — §6 option 3, the never-encoded commodity-ETC leg, is a plain documentation error verified against the pool file and can be corrected independently of any vendor.

**D8. Where does the gate live — a `tradeable` field on each pool row, or a screening function in the selector that derives it?** (a: field on the row / b: derived in the selector)
*Recommendation: (a), as guidance to [#1054](https://github.com/dd-jp/samurai-trading-system/issues/1054).* Evidence: **medium** — a row-level field with a reason string is inspectable and reviewable in the diff, whereas a derived predicate would have to invent data the pool does not carry. This is #1054's call to make, not this document's.

---

## 9. Provenance

**No data was collected from Yahoo Finance, and no data was collected from any londonstockexchange.com page, for this document.** No capture or measurement script was run: not `58-lse-quote-snapshot.py`, not `58-spread-estimator.py`, not `34-print-gap-measurement.py`, and no equivalent was written. No figure from doc 58 F2b, F2c or F6 is carried forward or relied on.

**External pages consulted, by ordinary reading:**

| Source | URL | Retrieved | Used for |
| --- | --- | --- | --- |
| FCA Handbook, RTS 11 Article 2 | https://handbook.fca.org.uk/technical-standards/provision/s118c1029sn0p1541 | 2026-09-03 | Tick-regime scope; the ETF "highest average daily number of transactions" band rule; the "solely equities" limitation |
| legislation.gov.uk, RTS 11 Annex | https://www.legislation.gov.uk/eur/2017/588/annex | 2026-09-03 | The price-band / tick-size table reproduced in §2.2 |
| Leverage Shares, ETP overview | https://leverageshares.com/en/etps/ | 2026-09-03 | Product structure (**not established** — the page says only "Exchange Traded Products" and defers to the prospectus and KIID) and LSE listing |

**Repo artifacts cited:** `server/providers/universe-pool/lse-etp-pool.ts` (row count, subclass split, currencies, issuers, `t212_isa`, the absence of a price field); `docs/adr/0018-intraday-thresholds-sizing-and-the-signal-bar.md` (D3 brackets, D5 fractions); `docs/adr/0017-validation-gates-paper-operational-thesis-expectancy.md` (the ~55% win rate); `docs/adr/0016-universe-leveraged-etps-ungated.md` (the known-weakness section, the ETC leg); `docs/adr/0015-live-venue-account-and-book-split.md` (Saxo, 8 bps per side); `docs/adr/0014-intraday-flat-by-close-horizon.md` (flat by close); `docs/research/54-capital-economics-vs-signal-accuracy.md` (the identity, the break-even table, the notional-scaled LLM bill); `docs/research/58-cost-floor-sizing-and-per-instrument-spread.md` — **F3, F4 and F5 only**; `docs/research/34-lse-mark-source-options.md` §3.2, §3.3 and §5; `docs/specs/universe-selector-spec.md` (story 16, the `t212_isa` weakness, the under-25 clause). <!-- cite-exempt: historical — v1 record; the file was deleted per ruling G8 and is preserved at tag v1-final -->

**Not established, and what would establish it:** the tick regime applicable to these ETPs and their per-line tick increments (**#1032**, or **#1035**); per-line current price (**#1032 / #1035**); per-line quoted spread (**#1035**, or **#895**'s vendor choice); print frequency for the 19 rows doc 34 never probed (**#1035 / #895**); the legal structure of the pool's ETPs (issuer prospectus or KIID, or **#1032**'s instrument metadata); Saxo's FX treatment of non-sterling LSE lines, and the final commission tier (**#1032**).
