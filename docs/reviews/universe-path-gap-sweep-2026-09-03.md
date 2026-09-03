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

**All 30 tradeable rows are `true`.** The gate is a constant, so it is a no-op in front of the sort and story 16's invariant is documented rather than enforced — this repo's dominant defect class.

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

**Fix:** add `fallback_default` to #751's acceptance criteria explicitly, or move it back onto the pool row with the loader rejection the spec specifies. Either is fine; the current state — declared required, owned by neither — is not.

---

### F5 — MEDIUM — `CONTEXT.md`'s "Still outstanding" note is stale on both of its claims

`CONTEXT.md:80`:

> **Still outstanding:** `docs/specs/risk-manager-spec.md` repeats the pre-#798 figure under its own sizing section and needs the same update; no Risk Manager rule enforces the per-subclass fractions.

Both halves are now false:

- **The spec was updated.** `risk-manager-spec.md:34` and `:235` both carry *"26.2% index ETPs / 41.8% single-stock … re-measured by #729 and accepted by #798 — this replaces the older 23.1%/26.2% pair."*
- **The rule exists.** `perSubclassDeploymentCap` is implemented in `server/pipeline/risk-manager/index.ts` (see `:484`, `:521`), with `SubclassDeploymentCap` at `risk-manager/types.ts:363` and a dedicated test file.

The accurate statement is narrower and more useful: **the rule exists and is unarmed.** `lse-etp-pool.ts:40-44` records that the pool *"is deliberately not wired into any `UniverseInstrument[]` a running profile reads"* because #800 is open and unresolved, and `types.ts:196` gates behaviour on `isD5ArmedWithNumericFraction`. A reader acting on the current note would go build a rule that already exists instead of arming the one that does.

**Fix:** replace the note with "the rule exists (`perSubclassDeploymentCap`) and is unarmed pending #800/#751."

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

## Summary

| ID | Sev | Finding | Disposition |
|---|---|---|---|
| F1 | HIGH | Liquidity gate is `t212_isa`, `true` on 30/30 — excludes nothing, keyed to a barred venue | **#1054 filed**, blocks #750 |
| F2 | HIGH | #750's cost sort key has no delivering owner; `blocked_by` was empty | **#1053 filed**, edges wired |
| F3 | HIGH | `CLAUDE.md:11` **and** `ADR-0015:139` name closed #798 as the live-ramp gate, vs a tolerance `CONTEXT.md` replaced | Briefing + ADR edit |
| F4 | MED | `fallback_default` required by spec, absent from code, unowned by #751 | Add to #751 AC or to the pool row |
| F5 | MED | `CONTEXT.md:80`'s outstanding-work note false on both claims | Restate as "exists, unarmed pending #800" |
| F6 | MED | Re-arm edge 0.20 justified by a withdrawn design target | Restate basis |
| F7 | MED | 26 rankable underlyings vs the "<~25 → do not rank" clause; a prune moots #750 | AC on #1054 |
| F8 | MED | #1036 retracts #1002's LSE half, leaves its Yahoo half on the same defect | Extend #1036 scope |
| F9 | LOW | 08-27 addendum says 32 pool rows; tree has 30 | One-word correction |
| F10 | MED | ADR-0015's live-money sizing guard triggers on "the Trading 212 ISA" — an account that cannot exist | Restate against the Saxo GIA |
| F11 | MED | ADR-0014:77 still asks a capital question ADR-0015 answered 2026-08-18 | Add the `ANSWERED` pointer |
| F12 | LOW | ADR-0017:35's withdrawn crypto ramp clause is unstruck in the body | Strike in place |

**Three of twelve are the same disease**: a clause, field, or gate declared load-bearing, assigned to a ticket or file that does not carry it, with nothing that fails when it is missing (F1, F2, F4). **Six more are one ruling landing in one document and not its citers** (F3, F5, F6, F8, F11, F12) — the post-2026-08-16 decisions (#798's acceptance, the £1,000 book, the Saxo/GIA venue, the terms-based retractions) are each recorded correctly *somewhere* and stale *somewhere else*. F10 is the sharpest instance because the stale citer is a live-money sizing guard rather than prose.

**The pattern worth acting on:** every one of those six was written by an author who *did* update the document they were editing. What is missing is the reverse index — nothing enumerates who cites a figure when that figure changes. That is a process gap, not nine independent oversights.

**No new HIGH contradiction with `cross-spec-contracts.md`** — the frozen registry was read and none of the above touches a type with two or more cross-spec consumers.

## Open questions for David

1. **F7 is a product decision, not a cleanup.** If a real tradeability floor takes the pool under ~25 rankable underlyings, the spec says ship unranked and trade the whole pool — which deletes #750's reason to exist. Prune first and let the count decide, or keep the ranked axis regardless?
2. **F4's ownership.** `fallback_default` on the pool row (with the loader rejection the spec specifies), or as part of #751's watchlist artifact? The spec says the former; the code comment asserts the latter.
