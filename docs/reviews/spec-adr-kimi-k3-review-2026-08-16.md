# Samurai — Spec/ADR Review via Kimi K3 Lens

**Date:** 2026-08-16  
**Reviewer framing:** hostile, live-money-first, consistency across specs/ADRs, falsifiability, implementation risk.  
**Scope:** `CONTEXT.md`, ADR-0001/0002/0003/0004/0005/0007/0008/0009/0010/0013/0014/0015/0016/0017/0018`, `docs/specs/*.md`, `docs/specs/cross-spec-contracts.md`.

---

## S-Tier findings (live-money or pipeline-blocking)

### 1) The system still cannot trade stocks in the recorded strategy
**Where:** ADR-0016 amendment + ADR-0018 amendment.  
**What:** Unconditionally entered long at the open is negative expectancy for both 3× index ETPs (−0.135%/trade) and 3× single-stock ETPs (−0.463%/trade). ADR-0018 replaces the old profit claim with a bar the signal must clear, but no selector has ever produced a trade: #625 measured 96 debates and 0 trades. The recorded thesis' falsifier arm 1/2 cannot be evaluated.  
**Risk:** The entire edge claim is unevaluated. Any live-money ramp is tuition without evidence.

### 2) #625 is still the critical path; nothing downstream can be validated
**Where:** ADR-0014 §Stated open risk, ADR-0016 §known weakness, ADR-0018 §Known weaknesses, debate-engine-spec, trader-spec, feedback-loop-spec.  
**What:** Every downstream mechanism — conviction scoring, cosine precedent, attribution, FL weight tuning — is either unexercised or measured against zero trades. The repo is ~2900 tests green, but all three validation gates (Stage 2 harness, paper operational gate, paper thesis gate at ~126 trades) are blocked on the same upstream failure: no `OrderIntent` ever reaches Risk.  
**Risk:** A green test suite gives false confidence. The system is tested as components, not as a strategy.

### 3) Crypto.com Exchange geo eligibility and CRO tier are unconfirmed
**Where:** ADR-0015 §Still open, docs/research/19-crypto-venue-fees.md.  
**What:** The £750/£750 split, the fee-tier cliff, and the 365-trade/yr calendar argument all rest on two unverified facts: UK resident can open Crypto.com Exchange, and 5,000 CRO gives 0.0725% flat. If either fails, the branch falls to Coinbase Advanced maker-only, which couples directly to the exit ladder (#654) as a hard constraint.  
**Risk:** The crypto leg's entire expectancy model is conditional on facts that may not hold. The decision rule is recorded, but implementation should not assume the preferred branch.

### 4) ADR-0018's earnings-day labeling is materially wrong
**Where:** ADR-0018 §Known weaknesses, tracked as #685.  
**What:** Earnings releases during the session are classified as same-session reactions, meaning entry precedes the event it is meant to react to. Same-date pre-market and post-close headlines double-count one event. The event-day figure (−1.3267%/trade, t = −4.19) is indicative, not measured, and the structural argument (events are 1.73% of sessions) is what saves Decision 2 — not the magnitude.  
**Risk:** If #685 re-runs and the structural share argument weakens, the "no gating" decision needs re-derivation. The bar ADR-0018 sets is unaffected; the gating arithmetic is.

### 5) Market Intelligence still ingests `[]` on every refresh in production
**Where:** market-intelligence-spec banner (2026-08-15 rework), ADR-0009, #552.  
**What:** The #552 rework fixes the architecture (archive + scoring separated), but the as-built Grok agent has never returned a real item. The sentiment/fundamental analysts are effectively muted until the new fetchers ship and produce scored items. #625's 0.5478 ceiling was caused by muted analysts; fixing the formula alone reproduced it.  
**Risk:** The paper soak cannot evaluate the full debate pipeline until MI delivers real `.news`. The soak is therefore testing a degraded system, not the recorded thesis.

---

## A-Tier findings (high severity, correctable before /to-tickets)

### 6) The kill-switch auto-rearm is unspecced
**Where:** risk-manager-spec §Circuit Breakers, ADR-0013 banner.  
**What:** ADR-0013 removed every human gate. #634 auto-rearmed the hard drawdown breaker but explicitly did not specify the kill-switch's release condition, because nothing currently engages it. The kill-switch's `releaseKillSwitch()` is still the only release path.  
**Risk:** Under full automation, a kill-switch engagement with no auto-release is operationally hazardous — it is permanent until someone notices. The spec should either define the release condition or mark the kill-switch as non-operational until a producer exists.

### 7) Cross-spec contracts registry has 13 live findings, 3 HIGH
**Where:** cross-spec-contracts.md §Live findings register.  
**What:** CV-15 (unclamped numeric thresholds under full automation), CV-4/5 (Risk Critic contradicts "no LLM"), CV-19 (~180 dead path citations across 44 docs), CV-21 (Trader's decision bar drifts from debate's bar), plus 9 MEDIUM/LOW items.  
**Risk:** These are not style issues. CV-15 is a live-money control gap; CV-4/5 is a contract contradiction in the billed "must be trusted absolutely" stage; CV-21 can suppress mandatory exits.

### 8) Trader-spec still carries "pending re-specification" banners for the exit model and execution venue
**Where:** trader-spec §Read before the rest.  
**What:** The exit model is now [#654]'s tranche ladder with per-asset-class levels. The execution venue for live equities is T212 ISA, with no `Trading212Adapter`. The spec acknowledges both but neither is resolved in this document.  
**Risk:** Implementation tickets derived from this spec will either inherit stale exit assumptions or have to re-derive sizing and bracket construction from tickets.

### 9) Universe Selector's watchlist persistence location is still open
**Where:** universe-selector-spec §Open Questions Q1.  
**What:** Two defensible shapes (SQLite row vs generated JSON file) with no decision. The spec says this gates the implementation ticket.  
**Risk:** Every downstream consumer (Orchestrator active list, routing map, alerts) is waiting on a storage decision that should have been made on the map.

### 10) Fee-tier cliff arithmetic assumes 365 crypto trades/yr, which #667 has not decided
**Where:** ADR-0015 §The book, #667.  
**What:** At 252 crypto trades/yr (equity-session calendar), the leg clears only $40K/month and misses the $50K tier. The 365-trade assumption is the premise of the £750/£750 split's fee rationale.  
**Risk:** If crypto follows equity session hours, the fee advantage collapses and the crypto leg's expectancy turns negative at base-tier costs.

---

## B-Tier findings (medium severity, structural)

### 11) The Skeptic Self-Review spec adds an LLM call inside invalidation with no producer
**Where:** skeptic-self-review-spec.md, devils-advocate-spec.md.  
**What:** The invalidation stage is itself not built (#625's upstream blocker). The skeptic call would be the second LLM call in the invalidation path, doubling latency for a stage that has no proven throughput headroom.  
**Risk:** A latency-bound stage with no measured budget gets a free additional LLM call. The spec says it is first-truncated, but no budget measurement exists.

### 12) Stage 2's proxy strategy verdict is terminal, but the actual Stage 2 gate for the recorded thesis has never been run
**Where:** stage2-validation-execution-spec.md §Verdict recorded.  
**What:** The dual-SMA proxy was killed (PBO 0.35/0.40, DSR 0.153/0.805). The recorded thesis — debate-as-edge at intraday horizon — has never been through Stage 2. The falsifier arms in ADR-0014/CONTEXT.md cannot be evaluated until the system produces trades.  
**Risk:** Stage 3/paper-trading is starting without Stage 2 clearance for the strategy actually claimed. The proxy verdict is not transferable.

### 13) The feedback-loop-spec's `strategy_params` is dead at both ends, intentionally
**Where:** feedback-loop-spec.md §Phasing of the three dials.  
**What:** `strategy_params` tuning is frozen because no proposer exists, and the Trader reads static config. This is honest documentation — but the spec still lists it as a user story (#6) and an implementation decision, giving the impression it is a live mechanism.  
**Risk:** A reader derives that strategy params are tunable when they are not. The asymmetry with weights (live) and risk thresholds (live) is intentional but invisible without reading §Phasing carefully.

### 14) Execution spec is not in the reviewed set; cross-spec contracts depend on it
**Where:** cross-spec-contracts.md §4, cross-spec §OPEN-GAP-E/F/G fixes.  
**What:** `ClosedTrade`, `Fill`, `OpenPosition`, `BrokerAdapter`, and the Execution store are defined in `execution-spec.md`, which was not in the spec list reviewed. The cross-spec contracts assume it is authoritative, but it was not loaded.  
**Risk:** Findings #6/#7/#8/#10/#11/#12/#13 in cross-spec-contracts.md all depend on Execution's contract being correct. If execution-spec.md has drifted, all consumers are unverified.

---

## C-Tier findings (lower severity, worth noting)

### 15) ADR-0009's debate-model measurement is load-bearing but stale
**Where:** ADR-0009 §Why haiku for the debate.  
**What:** The 15s crypto budget was measured 2026-08-06 against 8 samples each of 4 models. The Nous portal's latency drifts over minutes; two rounds disagreed by 2× on the same model. Haiku's tail was essentially flat at 2962ms max.  
**Risk:** This is one day's measurement. A portal load spike or a model version change can move the tail. The 4×-max budget headroom is thin. Any change to the debate prompt length or tool use would require re-measurement.

### 16) Market Data Service spec assumes Alpaca market-data API for the MVP universe
**Where:** market-data-service-spec.md §Module: Ingestion & Sources, ADR-0001 appendix.  
**What:** Alpaca's free Basic tier serves historical SIP but withholds the most recent ~15 minutes. The spec correctly distinguishes screener use (completed daily bars, out of hours) from live tick use.  
**Risk:** The live tick path's mark feed depends on `latest_mark` being fresh. If Alpaca Basic throttles or degrades, the feed-staleness gate (#641) will fire on equities, halting entries. No fallback mark source is specced for equities.

### 17) The Universe Selector's ATR dependency has a documented workaround
**Where:** universe-selector-spec.md §Axis computation.  
**What:** `atr()` is module-private; the public surface is `computeIndicator(bars, spec)`. The spec correctly prefers reusing the existing implementation.  
**Risk:** Low, but the implementation ticket must assert this choice — reimplementing ATR would drift the screener's volatility axis from the Trader's ATR-based stop, silently changing what the selector ranks on.

### 18) Cross-spec §8's invalidation narrowing rule has a prompt-safety consequence
**Where:** cross-spec-contracts.md §8.  
**What:** Risk cannot distinguish `evaluated` from `no_conditions`/`unavailable` — both arrive as `undefined`. The distinction survives in `invalidation_log` and the warn/alert path only.  
**Risk:** If the warn/alert path is ever silenced or missed, a system that is not evaluating invalidation conditions at all presents as healthy. This is a monitoring blind spot, not a logic bug.

### 19) The cost-model spec's pybroker paragraph is superseded but retained
**Where:** cost-model-backtest-spec.md §Validation Library.  
**What:** The paragraph states pybroker is the eval executor. The spec notes this is superseded — pybroker was never imported, and the TS-native `eval-executor.ts` replaced it.  
**Risk:** A reader of this section would design tickets around pybroker. The superseded notice is buried in a blockquote.

### 20) CONTEXT.md's drawdown tolerance is restated by ADR-0018 but risk-manager-spec.md repeats the old figure
**Where:** CONTEXT.md §Drawdown, risk-manager-spec.md banner, risk-manager-spec.md §Circuit Breakers.  
**What:** CONTEXT.md says "max ~20–25%" and notes the spec repeats the figure with an "inherited, not re-validated" caveat. ADR-0018 Decision 5 gives per-subclass sizing fractions that hold drawdown at 23.1% (index) and 26.2% (single-stock). Risk-manager-spec.md trips at 30% and re-arms at 20%.  
**Risk:** The 20–25% band in CONTEXT.md and the 30/20 hysteresis in risk-manager-spec.md describe different things (tolerance vs breaker), but the proximity invites confusion. The CONTEXT.md note says the risk-manager-spec repetition is still outstanding.

---

## Summary verdict

| Tier | Count | Theme |
|---|---|---|
| S | 5 | Live-money path blocked on unevaluated edge; MI empty; geo/fee assumptions unconfirmed; earnings labeling wrong |
| A | 5 | Cross-spec registry has 3 HIGH findings; kill-switch unspecced; trader-spec stale; watchlist persistence open; fee cliff conditional |
| B | 4 | Skeptic latency unmeasured; Stage 2 proxy ≠ recorded thesis; strategy_params dead; execution-spec not reviewed |
| C | 6 | Stale measurements, silent blind spots, superseded paragraphs, naming collisions |

**Bottom line:** The architecture is internally consistent and the spec/ADR set is substantially stronger than the pre-August corpus. The S-tier cluster — zero trades, muted MI, unconfirmed venue facts — is the genuine blocker. Nothing downstream of #625 can be meaningfully validated until it is resolved. The A-tier cross-spec findings are correctable in the current review cycle and should be closed before `/to-tickets`.

**Recommended next actions:**
1. Close CV-15, CV-4/5, CV-19, CV-21 in cross-spec-contracts.md (they are spec-level, not implementation-level).
2. Resolve watchlist persistence (#399's open Q1) so the Universe Selector implementation ticket is unblocked.
3. Add a `releaseKillSwitch()` condition to risk-manager-spec.md or mark the kill-switch non-operational.
4. Update `strategy_params` wording in feedback-loop-spec.md to match its dead-at-both-ends reality.
5. Load `execution-spec.md` into the next review pass — the cross-spec contracts depend on it.

---

## Disposition pass — 2026-08-17

Every finding above was re-read against the cited file before any edit. **The review was written against a snapshot and five of its twenty findings were already resolved in the current text** — those are recorded as already-addressed with the line that addresses them, not re-fixed. Six produced doc edits. Nine map to open issues or to facts this repo cannot settle from a keyboard.

**Recommended action 1 was NOT executed, and should not be.** It asks to close CV-15, CV-4/5, CV-19 and CV-21 in `cross-spec-contracts.md` as "spec-level". The registry itself contradicts all four: CV-15 (#638) is recorded as **"this pass does not clear it"**, with ADR-0018's new per-subclass `risk_fraction` values named as *more* unclamped surface; CV-4/5 (#642) as **"untouched"**; CV-21 (#687) as **"SPECIFIED, NOT BUILT"** — in a row that exists because an earlier revision claimed it had landed when it had not; and CV-19 (#645) is a ~180-citation sweep across 44 docs, which is work, not a status flip. Marking them closed would reproduce exactly the falsification the registry was rewritten to prevent. The rows are left as they are.

| # | Tier | Finding | Disposition |
|---|---|---|---|
| 1 | S | Cannot trade stocks in the recorded strategy | **Tracked — [#625](https://github.com/dd-jp/samurai-trading-system/issues/625).** Not doc-fixable; the specs already state it as the blocker. |
| 2 | S | #625 is the critical path, nothing downstream validatable | **Tracked — #625.** Correctly recorded in ADR-0014/0016/0018 and three specs already. |
| 3 | S | Crypto.com geo eligibility + CRO tier unconfirmed | **Out of scope.** Needs real-world venue confirmation, not an edit. ADR-0015 §Still open already records the decision rule and the fallback branch. |
| 4 | S | ADR-0018 earnings-day labeling wrong | **Tracked — [#685](https://github.com/dd-jp/samurai-trading-system/issues/685)**, which the finding itself cites. ADR-0018 already marks the figure indicative. |
| 5 | S | MI ingests `[]` on every refresh | **Tracked — [#552](https://github.com/dd-jp/samurai-trading-system/issues/552).** The spec banner already states it. |
| 6 | A | Kill-switch auto-rearm unspecced | **Already addressed.** `risk-manager-spec.md:36` (banner) and `:306` both already state the kill-switch has no producer, cannot currently trip, and that #634 deliberately did not invent a release condition for an unknown trigger. That is the review's "mark non-operational" ask, already satisfied. |
| 7 | A | Cross-spec registry: 13 live findings, 3 HIGH | **Tracked — #638 / #642 / #645 / #687.** See the note above on why these are not closed. |
| 8 | A | Trader-spec "pending re-specification" banners | **Already addressed.** The banner was deleted and all four items resolved in-body on 2026-08-16: the exit model is #704's tranche ladder over a wide stop (−0.5% stop withdrawn), and `Trading212Adapter`'s absence is stated as a build gap under #659, not a spec gap. |
| 9 | A | Watchlist persistence location open | **Already addressed.** `universe-selector-spec.md:312` — Open Question 1 is **CLOSED: a row in the shared SQLite store.** |
| 10 | A | Fee-tier cliff assumes 365 crypto trades/yr | **Tracked — [#667](https://github.com/dd-jp/samurai-trading-system/issues/667).** Also partly overtaken: ADR-0014's 2026-08-16 amendment puts crypto out of Samurai's scope. |
| 11 | B | Skeptic adds an LLM call with no measured budget | **FIXED** — `skeptic-self-review-spec.md` §Latency. "The stage's existing latency budget" is now stated as a forward reference, not a number: invalidation is unbuilt and has no measured throughput, the budget must be derived (tail, not median) before the skeptic is enabled, the two calls are sequential so their latency sums, and first-truncation must be logged as its own status or a permanently-truncated skeptic reads as a permanently-clean one. |
| 12 | B | Stage 2 proxy verdict ≠ the recorded thesis | **Tracked — blocked on #625.** The spec already records the proxy KILL as non-transferable. |
| 13 | B | `strategy_params` dead but presented as live | **FIXED** — `feedback-loop-spec.md` user story 6 now carries the amendment inline; §Phasing already had the honest version. |
| 14 | B | `execution-spec.md` not in the reviewed set | **Out of scope — next review pass**, per the review's own action 5. |
| 15 | C | ADR-0009 debate-model measurement stale | **FIXED** — ADR-0009 now states the table is one day's weather, that the 11.8s-vs-15s headroom absorbs one slow call rather than a shifted distribution, and names the four re-measurement triggers plus the operational tell (a timeout-cancelled debate). |
| 16 | C | No fallback mark source for equities | **FIXED (spec), and ESCALATED — the finding understates it.** Recorded in `market-data-service-spec.md` §Ingestion and flagged on [#562](https://github.com/dd-jp/samurai-trading-system/issues/562). The review reads this as "one source, no fallback, so a degraded feed halts entries". Checking the routing map makes it worse: none of the three specced `DataSource` implementations serves the LSE, and under ADR-0016 the traded instrument is the `lse_ticker` while Alpaca serves only the `screening_instrument` (the US underlying, per #656's finding that no free LSE intraday history exists). **The live equity leg therefore has no mark source at all** — the #641/#640 gates do not fire intermittently, they never pass, and marking an LSE leveraged ETP off its US underlying is not an admissible substitute. This is a precondition of the live leg, not a hardening task. **This row is the one place in this pass where a C-tier finding should be read as higher-tier.** |
| 17 | C | ATR must reuse `computeIndicator` | **Already addressed.** `universe-selector-spec.md:33` and `:176` both assert it, and `:176` states the reimplementation-drift consequence explicitly. |
| 18 | C | Invalidation narrowing rule's monitoring blind spot | **FIXED** — `cross-spec-contracts.md` §8 now states the blind spot and what it makes mandatory: log the status on every tick including non-`evaluated`, and treat the sustained-`unavailable` alert as first-class rather than a log line. |
| 19 | C | pybroker paragraph superseded but retained | **FIXED** — `cost-model-backtest-spec.md`: the supersession is now inline in both section leads rather than only in the preceding blockquote, with an explicit instruction not to derive a Python-dependency ticket. |
| 20 | C | Drawdown figures: CONTEXT.md vs risk-manager-spec | **Already addressed.** `risk-manager-spec.md:233` already reconciles them in as many words — CONTEXT.md's ~20–25% is the design envelope, which is why it is the **re-arm** edge and not the halt line, against the 30% trip. |

**Counts:** 6 fixed · 5 already addressed · 7 tracked on open issues · 2 out of scope.

**One item needs David, not an edit.** Nothing in this pass is blocked, but finding 9's underlying question is closed in the spec while the review believed it open — worth confirming that closure (SQLite row) is the intended one, since it was the item the review named as gating the Universe Selector implementation ticket.
