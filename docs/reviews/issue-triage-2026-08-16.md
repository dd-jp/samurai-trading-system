# Issue triage against the amended specs — 2026-08-16

All open issues judged against the specs **as amended by the intraday re-specification pass**, not as they stood. That ordering was deliberate: a ticket that looks stale under the old specs may be load-bearing under the new tick definition, and several were.

The pattern is [#631](https://github.com/dd-jp/samurai-trading-system/issues/631)'s own verdict on [#633](https://github.com/dd-jp/samurai-trading-system/issues/633) — *close on stale premise with the reason recorded, keep anything carrying a measurement*. Every close below carries its reason as a comment on the issue itself, not only here.

## The discriminators used

Applied mechanically, in this order:

| Test | Verdict |
| --- | --- |
| Assumes a crypto path | Close; label `future-crypto-system`; preserve the finding in the closing comment |
| Assumes `tick = one full pipeline pass` | **Re-scope, not close** — the work survives the split |
| Assumes the three-axis screener or a tuned weight | Close |
| Assumes the −0.5% stop, or per-instrument threshold fitting | Close |
| Assumes a per-analyst LLM | Close |
| Keys on `AssetClass` where `subclass` is now required | Re-scope |
| Cites doc 10's commitments | Close on stale premise |
| **Carries a measurement** | **Keep regardless of premise** |

That last row overrode the others twice, and is why nothing that produced a number was closed.

## Closed — 10

| # | Reason |
| --- | --- |
| [#631](https://github.com/dd-jp/samurai-trading-system/issues/631) | Map frontier resolved. Its one question — replace / wrap veto-only / neither — was answered "neither" by #632 and recorded in ADR-0014, including the "doc 10 needs a status saying so" clause. Closed per Standing Pipeline Rule 1. |
| [#633](https://github.com/dd-jp/samurai-trading-system/issues/633) | Stale premise, as #631 itself filed it. Veto-only presumed a trend rule generates and the LLM only refuses; under thesis (a) the LLM generates. |
| [#654](https://github.com/dd-jp/samurai-trading-system/issues/654) | Resolved by #704 and the ADR-0018 D3/D4 amendment. Also "per-asset-class levels" is superseded by per-**subclass** levels. Its break-even table used SPY's unlevered 0.30 bp spread, not the 0.18% round trip. |
| [#670](https://github.com/dd-jp/samurai-trading-system/issues/670) | Trigger fired (#617), τ=2min recorded. Doc 41's τ ≥ 3.69 min floor did not survive #617 — it presumed spend ∝ 1/τ. |
| [#673](https://github.com/dd-jp/samurai-trading-system/issues/673) | Crypto out of scope. Carried forward. |
| [#674](https://github.com/dd-jp/samurai-trading-system/issues/674) | Crypto out of scope — **and** it would have been a different study anyway: without a flatten there is no truncation term, so the neutral bijection is the whole answer rather than an approximation to it. |
| [#312](https://github.com/dd-jp/samurai-trading-system/issues/312) | ccxt path inert. Defect preserved verbatim in the closing comment — the fix is ordering, not error handling. |
| [#518](https://github.com/dd-jp/samurai-trading-system/issues/518) | ccxt path inert. The generalisable rule preserved: vendor text crossing into a durable audit row is untrusted input. |
| [#629](https://github.com/dd-jp/samurai-trading-system/issues/629) | Coinbase candle clients serve crypto only. Consolidating rather than deleting would *worsen* this repo's dominant bug class (tested mechanisms nothing calls). |
| [#590](https://github.com/dd-jp/samurai-trading-system/issues/590) | Duplicate of #504. Its premise grep cited `src/`, which no longer exists. |
| — | *(#655 was **not** closed — see below.)* |

## Re-scoped, kept open — 12

Each got a comment recording what the amendment changed. The ones that changed direction rather than detail:

- **[#664](https://github.com/dd-jp/samurai-trading-system/issues/664) — priority corrected upward.** An earlier read called it low-priority because R1/R2 run in Python outside the harness. True, and not a reason: it gates ADR-0017 **Gate 2** and every intraday backtest verdict the system can produce. Also newly scoped by the tick/decision split — a replay that only steps *decisions* cannot reproduce flat-by-close or the early exit.
- **[#687](https://github.com/dd-jp/samurai-trading-system/issues/687) — now an implementation ticket with a written fix**, and higher severity than filed. CV-21's four-part resolution. Verify by mutation; inspection cannot distinguish "the two derivations agree today" from "there is one authority."
- **[#696](https://github.com/dd-jp/samurai-trading-system/issues/696) — promoted.** The screener's 22:15 cadence is keyed to the next *trading* day and its staleness check is judged against the target session, so a calendar that cannot represent a holiday now has a screener consequence, not just a session-gate one. The workaround is explicitly forbidden: a second derivation inherits the bug.
- **[#642](https://github.com/dd-jp/samurai-trading-system/issues/642) — resolution direction now determined.** The analysts-spec determinism argument applies with *more* force at the Risk Manager than at an analyst, so the "no LLM" claims are the true ones and the binding critic is what re-specifies. **Do not resolve by deleting the "no LLM" lines.**
- **[#638](https://github.com/dd-jp/samurai-trading-system/issues/638) — worse, not better.** Per-subclass `risk_fraction` adds config surface to the same unclamped path. An unconverted `0.35` sizes to 16.2× equity and would pass any test that merely checks the config matches the ADR.
- **[#643](https://github.com/dd-jp/samurai-trading-system/issues/643) — CV-10's ruling is now available**, and points the *opposite* way from what the ticket assumed: under flat-by-close `exit` is mandatory every session, so trader-spec's un-phased scope is right about `exit` and orchestrator-spec's enter/hold-only boundary is the stale one. `scale_in` is the genuinely deferred piece.
- **[#655](https://github.com/dd-jp/samurai-trading-system/issues/655) — flagged as having no consumer, not closed.** ADR-0016 D2 bars catalyst-*gating* and the single-axis screener bars a catalyst *ranking*. One admissible shape survives — a hard eligibility gate with the cut declared in advance, the #707 pattern. Left open because it originates in a direct instruction from David; the recommendation to close is recorded on the issue for his call.
- [#636](https://github.com/dd-jp/samurai-trading-system/issues/636), [#238](https://github.com/dd-jp/samurai-trading-system/issues/238), [#683](https://github.com/dd-jp/samurai-trading-system/issues/683), [#645](https://github.com/dd-jp/samurai-trading-system/issues/645), [#514](https://github.com/dd-jp/samurai-trading-system/issues/514) — scope sharpened; see the issue comments.

## Two findings the triage produced

1. **#645 was partly done and nobody had measured the residual.** `8ef358e` closed the pipeline-directory half — zero hits remain for `src/pipeline`, `src/apps`, `src/providers`. The ~102 remaining citations are a *different population*, and about half of them **must not be repathed**: ADR-0012 describes `src/dashboard-web` precisely because it is the record of the split, and rewriting it would falsify the record. An ADR states what was true when decided.

2. **#683 sits on the critical path now, and #636 does not protect against it.** With the LLM removed from the analyst layer, the mediator is the *only* place a nondeterministic judgment enters. The falsifier control bypasses the debate stage — so a mediator-manufactured lean appears only in the live arm and would read as *the debate adding edge*.

## Left untouched

~45 issues covering code hygiene, flakes, infra, dashboard work and external blockers. The spec pass does not bear on them and inventing re-scopes would be noise. The external live blockers ([#665](https://github.com/dd-jp/samurai-trading-system/issues/665), [#666](https://github.com/dd-jp/samurai-trading-system/issues/666)) are unchanged and remain the real constraint on the live ramp — not code readiness.

---

## Addendum — the nine the first pass did not cover, plus the open PRs

*Run 2026-08-16 evening, after [#712](https://github.com/dd-jp/samurai-trading-system/pull/712) merged at `ebb501c`. Verdicts below were written as of 21:15Z; see the resolution note immediately following.*

> **Resolved since this run was written — 2026-08-16 22:18Z.** [#721](https://github.com/dd-jp/samurai-trading-system/issues/721) and [#724](https://github.com/dd-jp/samurai-trading-system/issues/724) are **CLOSED**, with both decisions recorded in map [#703](https://github.com/dd-jp/samurai-trading-system/issues/703)'s *Decisions so far*: caps bind on **notional** and the shipped `intent.size * intent.entry` gate is correct as-is; the stop is **frozen per subclass** at ADR-0018 D3's neutral bracket (−2.16% index, −6.25% single-stock), giving `risk_fraction` 0.00756 / 0.015625. The "escalated to grilling — 3" verdict below is left as written, because it was correct for the run it describes and a blended count makes both unauditable — but **only [#722](https://github.com/dd-jp/samurai-trading-system/issues/722) still gates implementation.** The grilling escalation worked: it is what produced those two decisions.

**The counts above are left exactly as they were.** They are correct for the run they describe, which closed at commit `77fa3ed`. This addendum carries its own counts rather than blending into theirs — a blended number would make both runs unauditable, and the first run's header has already been corrected once.

Nine issues were outside the first pass. Six ([#721](https://github.com/dd-jp/samurai-trading-system/issues/721), [#722](https://github.com/dd-jp/samurai-trading-system/issues/722), [#724](https://github.com/dd-jp/samurai-trading-system/issues/724), [#725](https://github.com/dd-jp/samurai-trading-system/issues/725), [#726](https://github.com/dd-jp/samurai-trading-system/issues/726), [#727](https://github.com/dd-jp/samurai-trading-system/issues/727)) were filed by #712's own review loop and post-date the triage commit. Three ([#718](https://github.com/dd-jp/samurai-trading-system/issues/718), [#719](https://github.com/dd-jp/samurai-trading-system/issues/719), [#720](https://github.com/dd-jp/samurai-trading-system/issues/720)) predate it and appear in no close or re-scope list — they were simply missed.

### Nothing closed — 0

The first pass's discriminators are all keyed on the intraday re-specification: a crypto path, `tick = one full pipeline pass`, the three-axis screener, the −0.5% stop, a per-analyst LLM. **Not one of the nine trips any of them.** Six are code-vs-spec drift found by reading the merged code, and three are wayfinder maps for work outside the intraday scope entirely. The overriding rule — *keep anything carrying a measurement* — would have protected #722 and #721 regardless.

### Escalated to grilling — 3 (two since resolved)

These are not re-scopes. They are decisions that need David, and writing a re-scope comment on them would have read as resolving a direction nobody chose.

| # | The question, in one line |
| --- | --- |
| [#721](https://github.com/dd-jp/samurai-trading-system/issues/721) | Does the per-subclass deployment cap measure **notional or leverage-adjusted exposure**? The shipped gate computes `intent.size * intent.entry` — notional — so at 3× a 35% cap is ~105% effective exposure. The two readings differ by 3× and nothing in the record settled which *at the time of this run*. **Settled 22:18Z: notional, cap a fraction of current equity — the shipped gate is correct as-is.** |
| [#724](https://github.com/dd-jp/samurai-trading-system/issues/724) | The Trader still sizes off the **withdrawn ATR stop** (`decide.ts:401-403`, `atr_k: 2.0`). Freezing the stop does not only change a level: `stop_distance` is the denominator of `size = (equity × risk_fraction) / stop_distance`, so freezing it removes the only mechanism by which size falls as volatility rises. That response then exists nowhere in the system. **Settled 22:18Z: freeze the stop per subclass; the volatility response becomes the existing binary halt, re-keyed from `AssetClass` to `subclass`, and is therefore discrete rather than continuous — accepted deliberately.** |
| [#722](https://github.com/dd-jp/samurai-trading-system/issues/722) | The live RSI is **Cutler's, not Wilder's**. Re-pointing `RSI_SPEC` reprices every technical opinion in the system in one commit — a decision about *when*, not a fix. |

**#721 and #724 should be grilled in the same sitting.** They are one question wearing two hats — *what unit does the cap/stop use* — and answering either alone risks a cap and a stop denominated differently, which is precisely the failure mode that produced the 46× sizing error this spec phase caught. **They were, and both closed 22:18Z in one sitting — the recorded arithmetic ties the notional cap and the frozen stop together as `risk_fraction = deployment × stop_pct`, which is exactly the joint answer separating them would have missed.**

**#722 must resolve before the B1 goldens freeze.** A fixture pinned to the current convention makes the convention the thing under test rather than the thing under decision. It carries the addendum's only measurement: median shift 4.6 RSI points, p90 12.0, and **18% of bars (25 of 141) flip the 70/30 classification**. Under the amended analyst design that is no longer a diagnostic number — with the LLM out of the analyst layer, the classification *is* the evidence handed to the debate.

### Kept open, scope narrowed — 3

- **[#726](https://github.com/dd-jp/samurai-trading-system/issues/726) — the obvious fix is the wrong one.** `perSubclassDeploymentCap` throwing on an unknown subclass is **correct and must stay**; softening it would convert a loud failure into a silent 100% deployment. The defect is the *missing audit row*: `riskLog.write` (`direct-bind.ts:439`) runs only after `Risk.evaluate()` returns, so the throw produces no `risk_log` row — loud to the process, silent to the audit trail, and the audit trail is what a live-money post-mortem reads. Also recorded so nobody re-derives it under pressure: this is **not** a stuck-position risk, because `evaluate()` returns at `intent.intent_type === 'exit'` before the entry-gate loop, so the flatten can never be blocked by it.
- **[#725](https://github.com/dd-jp/samurai-trading-system/issues/725) — batch with #722.** `rsi` returns 100 when `avgLoss === 0` without checking `avgGain`, so a flat tape reads maximally overbought at confidence 0.95. `direction` is safely `neutral`, so it produces no trade by itself — but a spuriously confident axis dilutes the `confidence = |net| / availableAxes` denominator. Same function, same warm-up path, and the degenerate case belongs in the B1 goldens anyway.
- **[#727](https://github.com/dd-jp/samurai-trading-system/issues/727) — defer to A2/A6.** `requireSubclass` is dead-but-tested, the harmless inverse of this repo's dominant bug class. Both sizing tickets are likely to give it a caller, so resolving it now spends a commit on a question they answer for free.

### Orthogonal, left as charted — 3

The three wayfinder maps ([#718](https://github.com/dd-jp/samurai-trading-system/issues/718) Skeptic Self-Review, [#719](https://github.com/dd-jp/samurai-trading-system/issues/719)/[#720](https://github.com/dd-jp/samurai-trading-system/issues/720) awesome-systematic-trading). Recorded explicitly rather than left absent, which is what happened on the first pass. Three premise corrections, all the `wayfinder-bodies-go-stale` shape:

1. **#718 cites `docs/specs/skeptic-self-review-spec.md` as its *spec*, and that file is not tracked in git.** It exists only as an untracked file in a local checkout, which is the `untracked-docs-diverge` shape — a reader cloning the repo, and CI, both see nothing. It is an output of the map, not an input; the only adjacent tracked document is `devils-advocate-spec.md`.
2. **#718 inserts a call into the `invalidation` stage, which is specced and not built.** The runtime chain is six stages, Trader → Risk. There is no call site — building it now is the dominant bug class by construction. In its favour, though: under the tick/decision split `invalidation` sits on the **decision** path, so the added LLM call is one per debate bar, not one per 2-minute tick — roughly 30× cheaper than the pre-split reading would suggest.
3. **#720's filter table needs two rows added and one corrected.** Added: ADR-0018 D4's **trial discipline** — a strategy yielding a hard eligibility gate with the cut declared in advance is admissible, one yielding a ranked axis or fitted weight is not, because the selection layer is deliberately at zero trials. This kills four of the seven families on a ground unrelated to their merit. Added: **no free LSE intraday history** (#656) — screening runs on the US underlying's bars, which *admits* strategies the table as written would reject. Corrected: crypto is not a filter to revisit; it left Samurai's scope entirely on 2026-08-16.

### The open PRs — six, verified against merged main

The question asked was whether each is still needed under the amended specs, and whether any references stale issues.

| PR | Verdict |
| --- | --- |
| [#723](https://github.com/dd-jp/samurai-trading-system/pull/723) | **Needed, priority up.** The re-specified screener runs at 22:15 keyed to the next *trading* day with staleness judged against the target session, so a calendar that cannot represent a holiday now has a screener consequence, not only a session-gate one. |
| [#715](https://github.com/dd-jp/samurai-trading-system/pull/715) | **Valid, unaffected.** Documentation and a rename. |
| [#711](https://github.com/dd-jp/samurai-trading-system/pull/711) | **Partly superseded — narrow it, and re-point the issue.** |
| [#710](https://github.com/dd-jp/samurai-trading-system/pull/710) | **Needed. Rebase and re-verify reachability.** |
| [#716](https://github.com/dd-jp/samurai-trading-system/pull/716), [#717](https://github.com/dd-jp/samurai-trading-system/pull/717) | **Valid as-is.** Independent files, no collision, merge whenever. |

Three findings worth more than the table row:

1. **#723 and #715 both edit `trading-calendar.ts`, and #712 already edited it.** GitHub reports all three MERGEABLE, because each is clean against *current* main — that flag says nothing about the pairwise conflict, which is certain. **Sequence, do not parallel-merge: #723 first**, because it rewrites the holiday representation and #715's rename rebases onto rewritten code far more cheaply than the reverse. On that rebase, #723's proper holiday model must **subsume and remove** the hard-coded date pins #712 added during its review loop — two holiday sources in one file is the second-derivation failure `universe-selector-spec.md` warns about, arriving by merge rather than by design.

2. **#711 is half-superseded and cites a closed issue.** Main now carries `production/stocks-tick-window.ts`, which asserts the *existence* invariant (the equity tick window is entry ∪ flatten tail). What survives, and is worth keeping, is the **stride** assertion — whether a tick actually *lands* in the tail at the configured interval, which is a different invariant nothing else checks. Its linked issue **#670 is closed**, by this very triage. Re-point the reference or the merge reads as closing something already closed for another reason.

3. **#710's rebase is the risky one.** It touches `production.ts`, `production/config.ts` and `production/direct-bind.ts`, all rewritten by #712. **It also touches `pipeline/trader/decide.ts` and `pipeline/trader/index.ts`** — and `decide.ts` is precisely where #724's now-recorded decision must land, replacing `atr_k × ATR` with the frozen per-subclass bracket. That is a second certain collision, on a file whose *arithmetic* is about to change rather than its wiring, so a clean textual merge is even less reassuring here. Merge #710 before the #724 implementation lands, or rebase it after — not concurrently. A clean *textual* merge over a rewritten composition root is exactly where a no-caller defect enters — the alert wiring survives while the thing that invokes it moves. After rebasing, verify the diagnostic is **reachable from the production composition root**, not merely constructed there. Separately: check the alert is keyed to the **decision**, not the tick, or the split makes it ~30× noisier and nobody reads it — which is the failure the PR exists to prevent, arriving through the front door.

### What this addendum leaves open

Nothing was closed by *this run*, so at 21:15Z the frontier had grown rather than shrunk: three items gated implementation and none was mine to resolve — **#721 and #724 together** (the sizing unit), and **#722** (the RSI convention, before B1's goldens freeze).

**As of 22:18Z, one remains: [#722](https://github.com/dd-jp/samurai-trading-system/issues/722).** #721 and #724 were grilled in one sitting, as recommended, and closed with their decisions in #703's *Decisions so far*. #722 is untouched and still gates B1.

**The three were labelled `wayfinder:grilling` and pointed at from map [#703](https://github.com/dd-jp/samurai-trading-system/issues/703), not left in this document.** Standing Pipeline Rule 1 makes the map the gating mechanism, so a blocker declared only in a review report is a blocker nobody can see. **Stated plainly, because it changes what actually did the gating: #703 was already closed at 18:09Z, three hours before this run.** A reader meets a closed map and never inspects its frontier at all, so the pointer comment is a record, not a gate — the `wayfinder:grilling` label is the only thing that surfaces #722 to a `/to-tickets` pass. Any future blocker attached to a closed map needs the label first and the comment second.

### What "complete" means here, and what it excludes

Checked rather than assumed, because two other background sessions were writing to this repo the same evening. `gh issue list --state open --search "created:>=2026-08-16"` returned nothing filed after #727 (20:56Z), so no issue arrived while these verdicts were being written. **One arrived after them: [#729](https://github.com/dd-jp/samurai-trading-system/issues/729) at 22:18Z** — ADR-0018 D5's drawdown envelope has no generator and its ladder cannot be re-derived by hand. It is out of this addendum's coverage by time, not by judgement, and it is already recorded on #703 as a follow-on.

Seven same-day issues are deliberately **not** covered and are not oversights: #707 and #708 are #703's own research children and are being worked as part of the map; #713 and #702 are GDELT work landing on its own track; #701 and #709 are test hygiene; #714 is a logger-robustness decision. All seven fall in the first pass's "left untouched" bucket for the reason stated there — the spec amendments do not bear on them, and inventing re-scopes would be noise. The three wayfinder maps (#718–#720) are recorded above rather than left silent only because a reader could reasonably expect the intraday pass to have judged them.

---

## Second addendum — 2026-08-16: the "left untouched" bucket, opened

**What prompted this.** Both passes above disposed of a large bucket with one sentence — *"~45 issues covering code hygiene, flakes, infra, dashboard work and external blockers. The spec pass does not bear on them."* That is a judgement about a **class**, and it was never tested against members. Asked directly whether all open issues are still valid after the amendments, the honest answer was that nobody had looked. This run looks.

**Coverage, stated precisely.** 52 open issues at the time of this run. Of those, 24 already carried an individual verdict from the two passes above or are active map children. This addendum individually inspected the **six whose subject matter the amendments could plausibly reach** — reading each body, not its title — and re-affirms the class judgement for the remaining 22, which are test flakes, review follow-ups, shim removals, dashboard work and logger robustness with no spec surface. **That is a narrower claim than "all 52 verified" and is stated as such.**

### Closed — 1

| # | Reason |
| --- | --- |
| [#182](https://github.com/dd-jp/samurai-trading-system/issues/182) | Stale on two independent grounds. Its precondition — *"once the WorldMonitor adapter is implemented and live"* — is a standing parking decision, and its subject moved: the asset universe it would correlate drawdowns against no longer exists (SPY/QQQ/BTC → LSE leveraged ETPs, crypto out of scope), and multi-day drawdown correlation is a weeks-to-months construct on a book that carries no overnight position. #173's real finding — WorldMonitor retains no historical CII series, only a ~24h snapshot — is preserved in the closing comment, because it is a property of the vendor and will still be true for whoever asks the intraday version of the question. |

### Priority raised — 3

- **[#562](https://github.com/dd-jp/samurai-trading-system/issues/562) — the live orchestrator has no OHLCV failover.** Filed against a 15-minute tick on 1h bars; the re-specified tick runs at **τ = 2 min** and now carries the bracket check, early exit and flatten. A single-vendor outage stopped meaning "stale view" and started meaning "cannot see the price of a position that must be flat by close." Two consequences neither the ticket nor #560 had to face before: the fallback is Polygon, which is **free tier at 5 req/min** and rate-limited far below a 2-minute tick across a 5–10 name watchlist (and is the path [#612](https://github.com/dd-jp/samurai-trading-system/issues/612) says must never become the source of record); and the ticket must now decide what a tick does when **no** source answers while a position is open — failing open silently suspends the bracket and early-exit checks, achieving by omission what `risk-manager-spec.md` forbids any breaker from doing.
- **[#504](https://github.com/dd-jp/samurai-trading-system/issues/504) — Polymarket macro/event ingestion.** The `news` bucket still has no writer, `fundamental` is mandatory for stocks, and that combination is what produced #625's measured 0.5478 conviction ceiling against a 0.55 floor. ADR-0014 moved news *inside* the edge mechanism, so this went from coverage gap to a gap in the claimed edge. **Scope correction that follows from the horizon:** macro/event contracts resolve over weeks and the book is flat by close, so this is standing context that keeps an analyst from being mute — not a same-session catalyst feed. Its staleness window is days, and a freshness check tuned for tick-rate data would mute it permanently. It also cannot be the coverage answer for LSE ETPs alone (no contract exists on 3USL), which makes the underlying-mapping an explicit decision rather than an assumption.
- **[#684](https://github.com/dd-jp/samurai-trading-system/issues/684) — source the US session table from Alpaca `/v2/calendar`.** Not a duplicate of #696/PR #723 but its **successor**: #723 lands a hand-maintained NYSE holiday table, and hand-maintained date tables rot in the dangerous direction — an unmodelled early close leaves a position unflattened, the overnight carry ADR-0014 forbids. Recorded so the stopgap does not become permanent. One constraint for whoever works it: `/v2/calendar` is a network call and the calendar now decides *when the book must be flat*, so it must be fetch-ahead-and-cache with the hand table as the offline floor — a calendar that fails open on a fetch error fails on exactly the days it exists to catch.

### Kept, with a cost recorded — 2

- **[#719](https://github.com/dd-jp/samurai-trading-system/issues/719) / [#720](https://github.com/dd-jp/samurai-trading-system/issues/720) — awesome-systematic-trading as a candidate-strategy feed.** Written after the pivot and already scoped against ADR-0014 and the LSE universe, so no re-scope. But it carries an unpriced cost that has to be named before the grilling runs: **a candidate-strategy feed is a search, and this record has a declared finite selection budget.** ADR-0018 D4 fixes the trial accounting; doc 13's terminal KILL is the standing demonstration that the number of things tried is itself a parameter. Three requirements recorded on the map: declare the trial count *before* the audit rather than reporting the survivor count as the trial count; state whether these trials are additive to D4's budget or share it; and run the constraint-based rejections (shorting, monthly rebalance, unavailable data) first, since they cost zero trials and their survivor count is the honest denominator. Also noted: [#637](https://github.com/dd-jp/samurai-trading-system/issues/637) has MinBTL's `E[SR]` hardcoded to 1.0 against a measured 0.71, so **the trial cap this would draw against is currently overstated** — resolve #637 first or the budget being spent is not the real one.
- **[#612](https://github.com/dd-jp/samurai-trading-system/issues/612) — Massive/Polygon derivative-works clause.** Kept as a licensing gate, priority down. The clause bites only if Massive bars are what an investment strategy is computed from, and they are not: Alpaca free SIP serves 10.6y and is the backfill source, while the Polygon key is free-tier fallback. Two named trigger conditions restore it to blocking. One cheap action now rather than at the trigger: mark the source fallback-only in code or config, because the real risk is not signing a bad contract — it is a backfill quietly running off the fallback on a day Alpaca is down and a threshold getting measured from it without anyone knowing which bars they were.

### What this addendum still does not claim

The 22 issues re-affirmed as a class were judged on subject, not read line by line. That is the right depth for test flakes and shim removals and the wrong depth if one of them turns out to encode a spec assumption — the failure this repo has already paid for under *"ticket bodies go stale."* The specific residual risk: **#513** (Risk Critic has no producer) and **#642** (the spec claims "no LLM" while specifying a binding LLM critic) are the same contradiction seen from two ends, and #642 already has a resolution direction from the first pass while #513 does not. They should be resolved together, and whichever is worked first should close the other rather than both being answered independently.
