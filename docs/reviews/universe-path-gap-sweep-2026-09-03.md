# Gap and contradiction sweep — the universe/screener path — 2026-09-03

**Scope: targeted, not a full folder audit.** Chartered by David's question *"do we need a ticket to identify high beta movers on a regular basis or is it covered?"* and its follow-up *"identify such gaps and contradictions that exist today."* The sweep runs two shapes, taken from the two gaps that answered the original question:

1. **An acceptance criterion or spec clause whose input has no delivering owner.**
2. **A measured finding with no fix ticket.**

Plus contradictions against rulings landed **after 2026-08-16**, which is the last full spec+ADR pass (`spec-adr-kimi-k3-review-2026-08-16.md`). Everything since — the £1,000 book (08-18), GIA-not-ISA (08-26), #798's acceptance (08-26), the Saxo venue (08-30), the invalidation-stage decline (09-02) — has had only targeted passes.

Artifacts read: `docs/specs/universe-selector-spec.md`, `server/providers/universe-pool/lse-etp-pool.ts`, `CLAUDE.md`, `CONTEXT.md` (drawdown block), `docs/specs/risk-manager-spec.md` (sizing/breaker sections), `docs/specs/cross-spec-contracts.md`, **ADR-0014 through ADR-0018** (the six the briefing requires before touching the trading path), issues #750, #751, #875, #928, #1002, #1032, #1034, #1035, #1036, and the `blocked_by` dependency graph for #750/#751/#1035.

## What this report does not re-litigate

Per `docs/reviews/README.md` ("prior findings are referenced rather than re-filed"):

- **`issue-triage-2026-08-17-pass2.md`** — six specs still carry crypto as a live requirement against `cross-spec-contracts.md` CV-25, and `CLAUDE.md`/`CONTEXT.md` still require the falsifier arm to replicate the tranche ladder #814 withdrew. Both stand; not re-filed.
- **`spec-adr-kimi-k3-review-2026-08-16.md`** — its recommended action 1 is explicitly refused there and was **not** re-attempted.
- **`cross-verify-2026-08-26.md`** and its 08-27 addendum — the earnings-filter findings (GAP-L, the Alpha Vantage demo-key hazard, pool-size interaction with the exclusion, the `timeOfTheDay` coarsening, the shared-calendar hazard) are all dispositioned. Only its stale row count is picked up, as F9.
- **#1032** items 1–5 (Saxo adapter, `MarketState.venue`, pool-vs-Saxo evidence, OpenAPI idempotency, the £7/mo L1 entitlement). F1 is adjacent to item 3 but is a different defect — see F1.

## Findings

Ranked by consequence. Every finding carries a `file:line`, a command and its output, or an issue state.

---

### F1 — HIGH — the screener's only hard filter excludes nothing, and is keyed to a barred venue

`universe-selector-spec.md` story 16 requires *"a hard liquidity gate applied before any scoring, so that a name too thin to trade never competes for a slot."* The spec resolves it to the pool's static `t212_isa` flag; #750 AC7 restates it as *"the pool file's ISA flag, cited as interim pending #666."*

```
$ grep -c 't212_isa: true'  server/providers/universe-pool/lse-etp-pool.ts   # 30
$ grep -c 't212_isa: false' server/providers/universe-pool/lse-etp-pool.ts   #  0
```

**All 30 tradeable rows are `true`.** The gate is a constant, so **as specced** it excludes nothing and story 16's invariant is documented rather than enforced — this repo's dominant defect class. Nothing is currently mis-filtering at runtime: `server/pipeline/universe-selector/` does not exist and the spec carries `cite-exempt: planned`. The defect is that #750 would be built to this clause, so it is cheaper to fix now than after the module ships.

Three compounding facts:

1. **The flag does not mean what the gate needs.** Its own doc comment (`lse-etp-pool.ts:305`): *"Every `true` here means only 'T212 lists the instrument' — not 'tradeable', not 'the spread is tradeable', and not anything about Saxo, which this field has never checked."* The gate is keyed on listing at a venue Samurai is **barred from** (#896/#912) under a **wrapper that no longer applies** (GIA, not ISA, 2026-08-26).
2. **Its interim owner is closed.** "Interim pending #666" — #666 closed 2026-08-27 without delivering. The interim has no end condition.
3. `lse-etp-pool.ts:69` already anticipates the fix (*"add a parallel `saxo_tradeable`-style field or retire `t212_isa` — not this [ticket]"*) and assigns it to nobody.

**Distinct from #1032 item 3**, which owns the *row evidence's* provenance. This owns the *screener's gate*. Fixing the evidence without arming the gate leaves a no-op filter with better documentation.

**Filed: [#1054](https://github.com/dd-jp/samurai-trading-system/issues/1054)**, wired `blocks` → #750.

---

### F2 — HIGH — #750's ranked axis has no sort key, and nothing on the board said so

#750 ranks on **measured round-trip cost per tradeable pool line, ascending**, and its AC1 forbids the fallback: the cost must be *"sourced from #666's measurement — **not** from `round_trip_cost_pct`, which is a per-subclass constant and would return the pool's declaration order."*

#666 closed 2026-08-27 without delivering it. `universe-selector-spec.md` states the consequence in plain text: *"no open ticket currently delivers it."*

```
$ gh api repos/dd-jp/samurai-trading-system/issues/750/dependencies/blocked_by
[]                     # before this sweep
```

So the screener's ranking step was **unstartable while rendering as takable** — the failure mode where a map records blocking in prose and the board shows a green light. #751 inherits the block and was likewise unwired.

**#1035 does not close this.** It is a `wayfinder:research` feasibility probe (*can* DMD reproduce half-spread?), itself blocked by #1034, and **it can answer no**. A ticket that may return "this source cannot do it" is not a ticket that delivers a cost vector.

**Filed: [#1053](https://github.com/dd-jp/samurai-trading-system/issues/1053)**. Edges now wired and verified: `#1035 → #1053 → #750 → #751`, plus `#1054 → #750`.

---

### F3 — HIGH — `CLAUDE.md`'s stated live-ramp gate is a closed issue, and cites a tolerance `CONTEXT.md` has replaced

`CLAUDE.md:11`:

> **The live consequence is #798: single-stock `f = 0.25` unscaled measures ~41.8% max drawdown against `CONTEXT.md`'s 20-25% tolerance** — the ruling picked the branch where that overshoot is real, so **#798 must be decided before the live ramp**.

Two independent falsifications:

```
$ gh issue view 798 --json state    # CLOSED
```

- **#798 was decided 2026-08-26** — David chose *accept*. It is closed. The briefing every session reads still names it as an open gate on going live.
- **`CONTEXT.md` no longer states a 20-25% tolerance.** `CONTEXT.md:72` now reads *"subclass-specific since #798's 2026-08-26 ruling — ~26% for 3× index ETPs, ~42% for 3× single-stock ETPs"*, and says explicitly *"This replaces the flat ~20–25% band."* So `CLAUDE.md` measures an overshoot against a figure the document it cites has withdrawn — and there is no overshoot any more: 41.8% **is** the stated tolerance.

This is the widest-blast-radius staleness class in the repo, and its specific danger here is the inverse of the usual one: a *closed* issue standing as an operator-facing safety gate can never be satisfied by working the backlog, because nothing is left to work.

**And the ADR says it too.** `docs/adr/0015-live-venue-account-and-book-split.md:139`, inside the 2026-08-18 amendment: *"**The ruling picks the branch on which the overshoot is real**, so #798 is now a required decision before the live ramp, not a contingent one."* ADR-0015 is otherwise carefully signposted — it carries `ANSWERED`/`SUPERSEDED` pointers at `:57`, `:119` and `:147` — but none of them reaches this sentence, so the ADR of record and the briefing agree with each other and disagree with the issue tracker.

**Fix:** rewrite `CLAUDE.md:11`'s last two sentences and add an `ANSWERED 2026-08-26` pointer to ADR-0015's 08-18 amendment: record #798 as decided-accept, restate the tolerance as 26.2%/41.8%, and re-point the live-ramp gate at the open successors (#925 shipped the 0.45 clamp re-siting; #932). No ticket filed — a two-paragraph edit, not a work item.

---

### F4 — MEDIUM — `fallback_default` is required by the spec, absent from the code, and owned by nobody

`universe-selector-spec.md` is unambiguous:

> `fallback_default` **is a required boolean, and it is what makes the story-12 fallback a real artifact rather than a name** … **The loader rejects a pool where no row carries it.** A pool that cannot answer "what do we trade when the screener fails" is a pool that fails silently on the one day it matters, and the failure presents as a healthy no-trade session.

The spec names it in the row schema, and invariant 3 makes it load-bearing: with story 26 (always-present crypto) withdrawn, this fallback is *"the **only** thing standing between a bad screener run and a fully dark session."*

In the tree:

```
$ grep -rn "fallback_default" server contracts
server/providers/universe-pool/lse-etp-pool.ts:46: * `fallback_default` ... is likewise NOT part of this file —
                                                    the fallback watchlist is #751's ... concern, not this pool's.
```

One comment, no field. `LseEtpPoolRow` (`lse-etp-pool.ts:272`) has ten fields and none is it; `assertValidPool` (`:1256`) checks `subclass`, `lse_ticker`, `screening_instrument` and their distinctness — there is no such rejection rule.

**And #751 does not carry it either.** Its body never uses the word `fallback_default`; its only fallback reference is Open Question 1 (*"where the watchlist lives … the staleness check and the fallback trigger are both defined against whichever is chosen"*), which is about storage, not about the declared default subset.

So the pool says "#751 owns it", #751 does not mention it, and the spec's loader rejection exists in no loader. The invariant fails the way the spec predicts: as a healthy-looking no-trade session.

**Fix:** move it onto the pool row with the loader rejection the spec specifies. Not #751: the fallback exists to work *when the screener has failed*, so it cannot be derived from anything the screener produces or consumes — not last known ranking (the spec's own third constraint), and not the per-instrument liquidity and cost #1035 → #1053 will deliver. It has to be statically declared in a checked-in artifact. #751 owns the fallback's *behaviour*, which is why its body never names the field.

**Applied 2026-09-03** (`ea0f35c`), on David's instruction, as the one finding in this report whose fix landed with it. `fallback_default` is now a required field on all 30 rows, six of them `true`, and `assertValidPool` carries three rules: at least one row (the spec's), no more than `FALLBACK_DEFAULT_MAX_ROWS = 10` (the spec's "Not the full pool", which is also the tick budget), and — **this module's own invariant, not the spec's, and labelled as such in the throw** — no two fallback rows on one `screening_instrument`, because SPY/QQQ/PLTR/NVDA each carry two ETP lines and a fallback holding both is doubled exposure to one name in the mode with no screener to notice. The spec's 5–10 *floor* is deliberately not enforced: the only loader rule the spec states is the zero case, and a hard floor of 5 would reject a legitimately small future pool. The `lse-etp-pool.ts:46` text quoted above is replaced in the same commit — leaving it would ship a file whose doc contradicts its own schema.

**Two things about the subset worth reading before revising it.** First, the mixed index/single-stock membership is a **bind, not a preference**: excluding the four rows whose subclass envelope was never measured (#903 — 3VT/3KOR/3KWE/3XLE, and degraded mode is the worst place to discover an unmeasured envelope) leaves exactly four index rows on two underlyings, so an index-only fallback cannot reach the spec's 5–10 range at all. It is emphatically *not* justified by F14's £250-vs-£600 throughput arithmetic — in a mode where the screener has failed, more deployable capital is not better. Second, **no row is included because it ranked well in doc 52.** #750's own body warns that "an axis picked because it topped a table in doc 52 would inherit that doc's 126 trials", and a checked-in artifact seeded from the same leaderboard inherits them identically. The two exclusions are structural rather than positional — MSTR because at 3× "the tape bleeds before any bracket is reached", AAPL because a 9.5% resolve rate means D3's frozen brackets never act.

**What the fix does not do:** the spec asks for a subset that is "liquid and `t212_isa: true`", and neither half is available. `t212_isa` is `true` on 30/30 rows so it filters nothing, and it names a barred venue — F1 and #1054. No spread or volume measurement exists until #1035 → #1053 land. The subset is declared pending that measurement, and the module doc says so rather than implying a screen that did not happen. Consuming the field is still #751's, unbuilt.

---

### F5 — MEDIUM — `CONTEXT.md`'s "Still outstanding" note is stale, and its second half is contradicted two paragraphs above it

`CONTEXT.md:80`:

> **Still outstanding:** `docs/specs/risk-manager-spec.md` repeats the pre-#798 figure under its own sizing section and needs the same update; no Risk Manager rule enforces the per-subclass fractions.

Both halves are false, and the second is falsified by `CONTEXT.md` itself.

- **The spec was updated.** `risk-manager-spec.md:34` and `:235` both carry *"26.2% index ETPs / 41.8% single-stock … re-measured by #729 and accepted by #798 — this replaces the older 23.1%/26.2% pair."*
- **The rule exists, and it is armed at exactly those fractions.** `perSubclassDeploymentCap` is implemented in `server/pipeline/risk-manager/index.ts` (`:484`, `:521`), typed as `SubclassDeploymentCap` at `risk-manager/types.ts:363`, and `buildStartingProfileConfigs` populates `per_subclass_deployment_cap.cap_fraction_of_equity` in the **shipped paper profile** — pinned by `d5-trader-cap-agreement.test.ts:227` asserting equality against `D5_INDEX_ETP_DEPLOYMENT_FRACTION` and `D5_SINGLE_STOCK_ETP_DEPLOYMENT_FRACTION`. Only the `equity_ceiling` sub-field is live-only, and that is deliberate (#888: paper is unbounded to the book so classified entries do not refuse against Alpaca's simulated ~$100,000 balance).

The decisive evidence is two paragraphs earlier in the same file. `CONTEXT.md:78`, added **2026-09-03 by #897**, states: *"the Risk Manager's `per_subclass_deployment_cap` is deliberately left at the full 35%/25%."* A block written today asserts the cap is configured; a block eight lines down says no such rule exists. This is not a citer lagging a ruling — it is one file disagreeing with itself, which is why it is listed separately from the F3/F10/F11 cluster.

**The residual the note should carry instead** is narrower and real: the cap binds only on an instrument the pool has classified into a subclass, and `lse-etp-pool.ts:40-44` records that the pool *"is deliberately not wired into any `UniverseInstrument[]` a running profile reads"* pending #800. So the rule is enforcing, but on today's unclassified default universe it has nothing to bind against.

**Fix:** replace the note with "the rule exists and is armed (`perSubclassDeploymentCap`, D5 fractions, pinned by test); it binds only once the classified pool is wired in — #800/#751."

---
### F6 — MEDIUM — a live risk threshold is justified by a figure that no longer exists

`risk-manager-spec.md:34` justifies the hard drawdown breaker's re-arm edge:

> the re-arm edge sits at **the top of CONTEXT.md's "~20-25%" design target**, so the book resumes only once it is back inside the drawdown it was originally sized for.

`CONTEXT.md:72` withdrew that band (see F3). The number `recovery_drawdown_pct: 0.20` is unchanged and shipped; what is gone is its stated reason. Note the same paragraph is otherwise current — it correctly cites 26.2%/41.8% for the *trip* edge and records #925's 2026-08-31 re-siting of the clamp ceiling to 0.45. So the paragraph updated its trip justification against #798 and left its re-arm justification pointing at the superseded band.

Not cosmetic: 0.20 is now well **below** the accepted single-stock tolerance of 41.8% rather than at the top of a 20-25% target, so the re-arm is far more conservative than the sentence claims, and nothing records whether that was chosen or inherited.

**Fix:** restate the re-arm edge's basis against the post-#798 envelope, or record explicitly that 0.20 is retained deliberately as a conservative floor and is no longer tied to the design target.

---

### F7 — MEDIUM — a real tradeability floor likely fires the spec's own "do not rank" clause, mooting #750

`universe-selector-spec.md`:

> **"If the pool lands under ~25 rows, ship without the ranking and trade the whole pool"**, and record that as the reason rather than building a selector that selects nothing.

`countRankableUnderlyings(LSE_ETP_POOL)` (`lse-etp-pool.ts:1185`) counts distinct `screening_instrument`: **26 today.** One above the line.

Any real tradeability floor takes it below: #1002's shape says a large minority of lines are unpriceable, and #928's earnings-day exclusion can remove several of the 20 single-stock rows simultaneously (the 08-27 addendum flagged that interaction for pool sizing, but not for this clause).

So the sequencing is wrong today: #750 builds a ranked axis while the spec's own escape clause is one row away from firing, and no one has evaluated it. **Prune first, count second, then decide whether the ranked axis is warranted.** Captured as an acceptance criterion on #1054.

---

### F8 — MEDIUM — #1036 retracts half of #1002's evidence and leaves the other half standing on the same defect

#1036 retracts doc 58's F2b/F2c/F6 as **impermissibly collected** — LSE public-site Terms §8 bars *"programmatic, scripted or other mechanical means"* — and names the downstream: *"#1002 rests its spread half on this capture."*

But #1002's **other** half — *"Free daily bars (2y, Yahoo) — 20 of 30 cannot be priced at all"* — rests on Yahoo, and #1036's own body says *"Doc 34 §5 disqualified Yahoo on the same ground."* `docs/research/34-lse-mark-source-options.md:290` states it directly: *"ToS bars automated collection and commercial use; no official API at all."*

So the retraction's scope covers one source and leaves a second, disqualified on the identical ground, cited as live evidence. **Both halves of #1002's evidence rest on sources this repo has ruled it cannot collect from.** The *shape* of the finding survives — some pool lines are untradeable at any signal accuracy — but no number in it is currently citable.

**Fix:** extend #1036's scope to state the Yahoo-collected half's status, or record explicitly why the two are treated differently. Reflected in #1053's and #1054's acceptance criteria so neither re-cites a retracted figure.

---

### F9 — LOW — a review's pool row count never matched the tree

`cross-verify-2026-08-26.md`'s 08-27 addendum: *"The checked-in pool (**32 rows** / 26 distinct `screening_instrument`, 20 single-stock and exclusion-eligible)."*

The pool has **30** rows, and has since #813 landed in `178ede1` on **2026-08-19** — eight days before that addendum. `lse-etp-pool.ts:99` and `:150` both say so in the file's own doc (*"this pool is now 30 rows"*), and #1002/#1035 both use 30.

The 26-distinct and 20-single-stock figures are correct; only the row count is wrong. Low consequence because nothing computes against it — but it is the count a reader would use to check whether the ~25-row clause in F7 has fired, which is the one place the difference between 30 and 32 changes an answer.

**Fix:** one-word correction in the addendum.

---

### F10 — MEDIUM — a live-money sizing guard is conditioned on an account that will never exist

ADR-0015's 2026-08-18 amendment deletes `EQUITY_LEG_FRACTION_OF_CAPITAL = 0.5`, so ADR-0018 D5's fractions reach `RiskPortfolioView.equity` unscaled. That deletion is explicitly conditional (`0015:135`):

> **The precondition the deletion rests on, stated because it is a live-money sizing path.** … Removing it is correct **exactly while the funded equity read equals the book.** **If the Trading 212 ISA is ever funded above £1,000**, `0.35 × equity` sizes against the account rather than the book — £525 on a £1,500 account, not £350 — and the correct repair is then a `book / equity` conversion resolved live.

The reasoning is right and the hazard is real. The **trigger is unfalsifiable**: there is no Trading 212 ISA and there never will be one — T212 is barred by its own terms (#896/#912) and the wrapper is a GIA, not an ISA (2026-08-26). A guard whose condition names an account that cannot exist never fires, so the £525-on-a-£1,500-account failure would arrive unannounced on the **Saxo GIA** instead.

ADR-0015 carries supersession pointers at `:57` (scoping "the Decision section above") and `:147` (scoping the "What this does not change" section). Neither reaches `:135`, which sits between them inside the 08-18 amendment's "What follows mechanically". #946 shipped the documentation half of the venue change and #1032 owns the code half; neither names this line.

**Fix:** restate the precondition against the Saxo GIA. One-line edit, but it is on the live-money sizing path, which is why it is not filed as cosmetic naming fallout under #1032.

---

### F11 — MEDIUM — ADR-0014 leaves open a capital question that was answered two days later

`0014:77`, in "The price, recorded rather than argued away":

> **ADR-0015's £750/£750 split collapses to a single equity book.** … Whether the equity leg now takes the full £1,500 is a **capital decision that is not taken here** and needs its own record.

It got its own record: ADR-0015's **2026-08-18** amendment re-based the book to **£1,000, all equity** — and it is neither of the two options this sentence frames. ADR-0015 handled the same open question correctly, stamping `:119` with *"ANSWERED 2026-08-18 — see the amendment below … do not quote the £750/£1,500 options as live."* ADR-0014 received no companion pointer, so it still reads as an open capital decision and still quotes £1,500 as a live option.

Consequence is narrow but real: ADR-0014 is one of the six ADRs `CLAUDE.md` requires reading before touching the trading path, and a reader who starts there finds an open question whose answer is two documents away.

**Fix:** add the same `ANSWERED 2026-08-18` pointer to `0014:77`.

---

### F12 — LOW — ADR-0017's withdrawn ramp clause is still readable as live in its own body

`0017:35` reads, unmarked:

> Equity leg only, **£100–200**, with paper running in parallel for comparison. **Crypto stays in paper until the full £750 can deploy at once.**

`0017:47`'s 2026-08-16 amendment withdraws exactly this — *"The ramp clause at line 35 is **withdrawn rather than amended**. It sequenced a crypto deployment this system will not make"* — and cites it by line number, which is better than most. But the sentence itself is unstruck, so a reader who stops at the Decision section gets the withdrawn rule.

This is the pattern `universe-selector-spec.md` names and refuses when it deletes its own banner: *"a banner over a stale body is a note that the body lies, and a reader following the body gets the old rule."* Rated LOW rather than MEDIUM only because the amendment's line-number citation is precise and the crypto scope ruling is stated in four other places.

**Fix:** strike the clause in place with its replacement adjacent, per the convention the spec pass already applied.

### F13 — MEDIUM — ADR-0008 owns the spend cap and still reports its utilisation from a crypto-in-scope measurement

`CLAUDE.md` states that *"every £/yr LLM figure in ADR-0016 **and ADR-0008 §2** … was measured at a 15-minute cadence with crypto in scope"*, restated equities-only by [#840](https://github.com/dd-jp/samurai-trading-system/issues/840) on 2026-08-18 to **~£58/yr**.

ADR-0016 complied. Its `:49` banner withdraws the `£252`/`£89` bill, the `~£12`/`~£5` pair and the 28:1 ratio by name, and its `:128` amendment records #840 in full.

**ADR-0008 carries no #840 pointer and no crypto-scope withdrawal at all.** Its `:122` correction box still reads as the standing measurement:

> Measured against the soak's actual `llm_spend` (1,151 calls over 42.6h), real spend at this cadence is **$0.878/day**, not $3.00 — **25% of the cap, not 84%**.

That is the same soak measurement ADR-0016 withdraws — and ADR-0016:45 prices crypto at **86% of that bill**. So the "25% of the cap" utilisation figure, in the ADR that *owns* the cap, overstates equities-only consumption by roughly 7×. An operator reading ADR-0008 to judge headroom under `llmBudgetUsd: 50` is reading a number for a system that no longer exists.

Two things that are **not** wrong here, and should not be swept up in the fix:

- **The τ = 2 min cadence survives.** The `:110` amendment derives it from exit resolution on a 3× equity ETP (doc 41 Result 2: a stop overshoot of ≈−1.97% at τ = 15 falling to ≈−0.72% at τ = 2), not from any crypto pass count. The crypto-inclusive `2 × 1,440 + 4 × 390` arithmetic at `:161` sits *below* the superseded box.
- **The cap itself is unaffected.** A cap that binds less often is not a wrong cap.

The gap is scope, not cadence: `:110`'s box supersedes the section on **cadence** and explicitly preserves everything below it as "the record of how the number was chosen", so a reader has no signal that the cost arithmetic is separately void on scope.

**Fix:** add a one-paragraph 2026-08-18 scope amendment to ADR-0008 §2 pointing at #840 and ADR-0016's `:128`, stating the equities-only bill (~£58/yr) and that the `$0.878/day` → "25% of the cap" utilisation is a crypto-in-scope figure kept for provenance.


### F14 — HIGH — #750 ranks on round-trip cost, but the objective divides cost by width; the axis selects the *harder* subclass

The screener's ranked axis was changed on 2026-08-17 from reach rate (falsified out of sample) to **measured round-trip cost, ascending**. The reasoning was sound in kind — one axis is a sort, a sort is zero trials against ADR-0018 D4's selection budget, and cost is the only movable term that does not require predicting returns. The axis is nevertheless measuring the wrong quantity.

`docs/research/52-exit-geometry-and-subclass-odds.md:27` defines the bar the signal must clear:

> `edge_pp = (cost − E_gross) / width × 100`

**Cost does not enter the objective. Cost ÷ width does.** And `width` is not a free parameter — ADR-0018 D3 freezes it per subclass: index `+2.00 / −2.16` → **4.16**, single-stock `+6.00 / −6.25` → **12.25**. With ADR-0015's declared round trips (0.18% index, 0.41% single-stock), the cost-only contribution to the bar is:

| Subclass | Round trip | Width (D3) | Cost-only bar |
|---|---|---|---|
| Index ETP | 0.18% | 4.16 | **4.33 pp** |
| Single-stock ETP | 0.41% | 12.25 | **3.35 pp** |

Ascending cost ranks every index row above every single-stock row. But the index row is **~0.98 pp harder** to clear. The specced axis is anti-correlated with the objective it exists to serve — it is not merely imprecise, it is pointed the wrong way.

**This is the same error that killed the reach-rate axis, one level up.** Reach rate was withdrawn because it read `tp%` without its paired `sl%`. Cost-ascending reads cost without its paired width. Both take one half of a ratio and sort on it.

Empirically over the seven names doc 52 measures out of sample (n = 897/name): cost-ascending's top two are QQQ and SPY, bars **2.96** and **4.19** (mean 3.58). Bar-ordered, the two best non-degenerate names are PLTR (**1.29**) and NVDA (**2.84**), mean 2.07 — both single-stock. (AAPL's 0.98 is excluded: doc 52:90 records it as degenerate, only 9.5% of sessions resolve.)

**The fix costs nothing.** Sort on `cost / width`. Width is a frozen constant read from ADR-0018 D3, not a fitted or measured value, so the corrected axis is *exactly* as trial-free as the current one — still one sort, still zero trials, still no return prediction. It is strictly the same design with the denominator restored.

**Corroboration that the project already reasons this way:** ADR-0015:166 evaluated venues *"against a bar-inflation ceiling (1.0 pp added to the required-accuracy bar per subclass)"* — explicitly **rather than a flat round-trip %**. Its published ceilings reproduce exactly as `baseline cost + width/100`: index `0.18 + 4.16/100 = 0.2216` → the stated **0.22%**; single-stock `0.41 + 12.25/100 = 0.5325` → the stated **0.53%**. The venue decision was made on cost-per-unit-width. The screener next to it sorts on raw cost.

**Two consequences to price before adopting the corrected axis** — it is not free of side effects, only free of trials:

1. **It inverts the book.** On subclass-level cost data alone, `cost/width` is constant within a subclass, so the corrected axis sorts all 22 single-stock rows above all 9 index rows — the exact inverse of the current axis's all-index watchlist. The two axes produce **disjoint** watchlists. `perSubclassDeploymentCap` is **netted across the subclass, not per position** (`risk-manager/index.ts:584`, "Netted across the subclass"), so an all-single-stock watchlist caps *total* deployment at D5's 25% — £250 of the £1,000 book — where a mixed watchlist can hold 35% + 25% = £600 across the two buckets. That throughput difference is plausibly larger than the ~1 pp bar improvement, and it is a reason to blend subclasses rather than to keep the wrong axis.
2. **Every selected name then runs the 41.8% envelope** rather than 26.2%. #798 accepted that tolerance, so this is not a violation — but a uniformly single-stock book is not the mix that ruling was priced against.

**The axis's ceiling is bounded, and worth stating.** Because `cost/width` is constant within a subclass, the corrected axis still cannot separate MSTR (bar **7.16**) from PLTR (bar **1.29**) — a **5.87 pp** spread, versus the ~1 pp the subclass choice is worth. That dispersion lives entirely in `E_gross`, the return-predicting term the single-axis design deliberately forbids. The larger prize is therefore not in the ranking at all: doc 52:101 records MSTR's `E_gross` at **−0.4672%/session**, i.e. *"at 3× the tape bleeds before any bracket is reached"* — a structural property of a 3× ETP on a high-volatility underlying, not a fitted threshold. Removing such a name is a static, one-time pool decision, not a per-session rank. **TSLA's −0.0619 is not in that category** — it is inside noise, and pruning on it would be a fitted threshold wearing a sign test.

**Reach limit:** doc 52 measures 7 of the pool's 26 distinct `screening_instrument`s. Nineteen have no bar measurement at all, so any `E_gross`-based prune acts on 7 names today and the ranking question is unresolved for the rest — which is a further argument for #1035 → #1053 delivering per-instrument cost before #750 is built.

**Fix:** amend #750's ranking AC to sort on `round_trip_cost / subclass_width`, citing ADR-0018 D3 for the widths and doc 52:27 for why; state the subclass-mix consequence so the watchlist is not silently all-single-stock. Track the MSTR-class static prune separately — it is a pool-membership decision, not a screener rank.

**Relation to F7:** distinct. F7 is a *tradeability* prune (can we trade the row at all); this is the axis's *correctness* given whatever rows survive.


## Summary

| ID | Sev | Finding | Disposition |
|---|---|---|---|
| F1 | HIGH | Liquidity gate is `t212_isa`, `true` on 30/30 — excludes nothing, keyed to a barred venue | **#1054 filed**, blocks #750 |
| F2 | HIGH | #750's cost sort key has no delivering owner; `blocked_by` was empty | **#1053 filed**, edges wired |
| F3 | HIGH | `CLAUDE.md:11` **and** `ADR-0015:139` name closed #798 as the live-ramp gate, vs a tolerance `CONTEXT.md` replaced | Briefing + ADR edit |
| F4 | MED | `fallback_default` required by spec, absent from code, unowned by #751 | **Applied `ea0f35c`** — field on the pool row + 3 loader rules |
| F5 | MED | `CONTEXT.md:80` false on both claims — and its second half is contradicted by `CONTEXT.md:78`, written the same day | Restate: rule exists, armed, pinned by test |
| F6 | MED | Re-arm edge 0.20 justified by a withdrawn design target | Restate basis |
| F7 | MED | 26 rankable underlyings vs the "<~25 → do not rank" clause; a prune moots #750 | AC on #1054 |
| F8 | MED | #1036 retracts #1002's LSE half, leaves its Yahoo half on the same defect | Extend #1036 scope |
| F9 | LOW | 08-27 addendum says 32 pool rows; tree has 30 | One-word correction |
| F10 | MED | ADR-0015's live-money sizing guard triggers on "the Trading 212 ISA" — an account that cannot exist | Restate against the Saxo GIA |
| F11 | MED | ADR-0014:77 still asks a capital question ADR-0015 answered 2026-08-18 | Add the `ANSWERED` pointer |
| F12 | LOW | ADR-0017:35's withdrawn crypto ramp clause is unstruck in the body | Strike in place |
| F13 | MED | ADR-0008 §2 reports "25% of the cap" from a crypto-in-scope soak ADR-0016 withdrew; ~7× overstated equities-only | Add a #840 scope amendment |
| F14 | HIGH | #750 sorts on raw round-trip cost; the bar divides cost by width, so ascending cost picks the ~0.98 pp *harder* subclass | Sort on `cost / width` (same trial cost) |

**Three of fourteen are the same disease**: a clause, field, or gate declared load-bearing, assigned to a ticket or file that does not carry it, with nothing that fails when it is missing (F1, F2, F4). **Six more are one ruling landing in one document and not its citers** (F3, F6, F8, F11, F12, F13) — the post-2026-08-16 decisions (#798's acceptance, the £1,000 book, the Saxo/GIA venue, the terms-based retractions) are each recorded correctly *somewhere* and stale *somewhere else*. F10 is the sharpest instance because the stale citer is a live-money sizing guard rather than prose; F13 is the second-sharpest, because the stale figure is the utilisation of a live spend cap and it is wrong by ~7×. F5 is the degenerate case — not a citer lagging at all, but one file contradicting itself on the same day. **F14 belongs to neither cluster**: it is not a stale citation but a live design error in an unbuilt module — the screener's ranked axis measures cost where its own objective measures cost per unit of bracket width, which is why it is cheapest to fix before #750 is written.

**The pattern worth acting on:** every one of those six was written by an author who *did* update the document they were editing. What is missing is the reverse index — nothing enumerates who cites a figure when that figure changes. That is a process gap, not nine independent oversights.

**No new HIGH contradiction with `cross-spec-contracts.md`** — the frozen registry was read and none of the above touches a type with two or more cross-spec consumers.

## Open questions for David

Both questions David raised on the first pass are answered below from the artifacts, with the residual decision named. Neither answer required new measurement.

### 1. F7 — prune or rank? **The dichotomy is false; build the axis, and fix it first (F14).**

The premise was that a tradeability prune could take the pool under the spec's *"if the pool lands under ~25 rows, ship without the ranking and trade the whole pool"* clause (`universe-selector-spec.md:231`) and thereby moot #750. It cannot, because the same document refutes it two lines later (`:233`):

> **"Trade the whole pool" does not lift the active-list cap.** The 5–10 watchlist size is not a property of the ranking — it is the **tick budget**, set by τ = 2 min against the instrument-pass cost, and it binds whatever produced the list.

So "don't rank" does not mean *trade 30 names*. It means *take the first N of the pool in checked-in file order, N = the same configured cap*. Both branches select 5–10 rows from the same pool; the only difference is whether the 5–10 are chosen by a cost-ordered sort or by the arbitrary order rows happen to sit in the file. **The sort becomes an identity at N (≈10), not at 25** — the `~25` threshold and its "close to a rename" rationale are inconsistent with line 233's own argument, and `:231` should be corrected to say so.

Consequence: a tradeability prune moots #750 only if it takes the pool to **≤ ~10 rows**, not ≤ 25. That is a far stronger claim than F7 assumed, and nothing in evidence today suggests the floor is that aggressive. **F7 stays a real finding** — the gate must still filter on something that filters (#1054) — but it no longer has authority over whether #750 is built.

The live question is therefore not *whether* to rank but *on what*, which is **F14**: the specced axis sorts on raw round-trip cost while the objective divides cost by width, so it selects the ~0.98 pp harder subclass. Correcting it to `cost / width` costs no additional trials.

**Residual for David** (a genuine trade-off, not a defect): the corrected axis produces an all-single-stock watchlist on today's subclass-level data, and `perSubclassDeploymentCap` nets across the subclass, so that caps deployment at £250 of the £1,000 book against £600 for a mixed list. Ranking within a per-subclass quota, rather than globally, keeps both the corrected axis and the throughput — but that is a design choice #750 should make explicitly rather than inherit.

**Recorded on #750, 2026-09-03, on David's instruction.** The ticket's ranking AC now reads `cost / width` rather than raw cost, with a dated banner carrying the derivation and the zero-trial argument (width is a frozen D3 constant, so the corrected axis is still one sort and no trials). Three ACs were added: a test that the axis is `cost / width` and not `cost`, with widths read through the shared bracket path rather than re-declared; the per-subclass quota, stated as a quota on the ranking and explicitly not a second ranked axis, so the zero-trial property survives; and an explicit non-goal — this ticket does not prune pool membership, since `cost / width` is constant within a subclass and cannot separate MSTR from PLTR. The dead `#666` source is repointed to #1053 in both the AC and the blocked-by list, with doc 52's reach limit (7 of 26 underlyings measured) named there.

### 2. F4 — who owns `fallback_default`? **The pool file, and the spec already says so twice.**

The code comment at `lse-etp-pool.ts:46` disclaims the field as *"#751's active-list/rotation concern, not this pool's"*. That conflates the **data** with the **behaviour**:

- The **spec puts the field in the pool schema** (`:204`, a required boolean) and puts its enforcement **at pool load**: *"a pool with no `fallback_default` row is rejected at load, not at fallback time"* (`:319`). A load-time rejection can only live where loading happens.
- **#751 owns the behaviour** — when the fallback triggers, the alert, returning the list. Its body names "fallback" once (the staleness/trigger definition) and never names `fallback_default`; no AC covers it. So #751 is the correct owner of *when*, and was never the owner of *which rows*.
- **Nothing enforces it anywhere today.** `assertValidPool` (`lse-etp-pool.ts:1256`) checks subclass validity, non-empty `lse_ticker`, non-empty `screening_instrument`, and that the two are not the same identity — nothing about `fallback_default`. The spec's *"only thing standing between a bad screener run and a fully dark session"* has no failing test and no failing load.

**The reason this is not merely tidier — and the thing worth adding to the answer:** the fallback exists to work *when the screener has failed*. If `fallback_default` were derived from screener inputs — liquidity, measured cost, the very data #1035/#1053 will deliver — it would be unavailable in exactly the scenario it exists for. It must be **statically declared** in a checked-in artifact. That is a correctness argument for the pool file, independent of ownership convention.

Note the spec's own constraint on the subset (`:207`): *not* the full pool — sized to the watchlist range (5–10 names), liquid. And its `t212_isa: true` qualifier there inherits F1/#1054's defect, so the fallback subset must be re-qualified against Saxo when that gate is fixed.

**Fix — applied 2026-09-03 (`ea0f35c`), on David's instruction.** `fallback_default: boolean` is now a required field on all 30 rows with six marked, `assertValidPool` rejects a pool with zero of them and one with more than `FALLBACK_DEFAULT_MAX_ROWS = 10`, and the `:46` disclaimer is replaced by the ownership reason above. A third rule — no two fallback rows on one `screening_instrument` — is **this module's invariant rather than the spec's**, and says so in its own throw message so it can be removed without hunting for a document that required it. #751 still owns trigger and alert, and consuming the field remains its job. See F4 above for the subset's declared criteria, the two structural exclusions, and the liquidity claim the fix deliberately does **not** make.
