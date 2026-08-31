# ADR-0018 — The intraday target: neutral brackets, volatility-constrained sizing, and the bar the signal must clear

- **Status:** Accepted
- **Date:** 2026-08-10
- **Decided by:** David, resolving [#653](https://github.com/dd-jp/samurai-trading-system/issues/653) under map [#631](https://github.com/dd-jp/samurai-trading-system/issues/631)
- **Evidence:** [`docs/research/18-intraday-instrument-physics.md`](../research/18-intraday-instrument-physics.md) Result 4; scripts `18-threshold-study.py`, `18-fetch-bars.py`, `18-fetch-earnings.py`
- **Amends:** [ADR-0016](0016-universe-leveraged-etps-ungated.md) (expectancy figures), `CONTEXT.md` drawdown target
- **Builds on:** [ADR-0014](0014-intraday-flat-by-close-horizon.md), [ADR-0015](0015-live-venue-account-and-book-split.md)

## Context

[ADR-0014](0014-intraday-flat-by-close-horizon.md) moved the product to an intraday horizon and superseded doc 10's target (0.04%/day, −23% pre-accepted drawdown). That left the system with **no return target and no drawdown commitment**. #653 was opened to derive both from history rather than from a desired number — satisfying doc 10 line 53's forbid on *"any return target set from desire rather than measurement."*

The measurement is over **10.6 years**, 2016-01-04 → 2026-07-31, Alpaca SIP: SPY 5-minute and TSLA 1-minute (1.92M bars), regular hours, underlying tape scaled by the ETP leverage factor.

## Decision 1 — the target is an **expectancy**, never a return number

```
E = P_win × Avg_win − P_loss × Avg_loss − Costs
```

`CONTEXT.md` already names expectancy as the north star, it is the form the validation gates consume, and a headline return number is exactly what doc 10 forbids. **No annualised percentage is a commitment of this system.**

## Decision 2 — thresholds are **pooled per asset-class subclass**, fitted to the **all-day** distribution

Not per-instrument, and **not event-conditioned**. The universe is scanned daily ([#635](https://github.com/dd-jp/samurai-trading-system/issues/635)), so there is no fixed instrument list to fit per-instrument studies to.

Event conditioning was tested directly rather than assumed away. Earnings-reaction sessions for TSLA, 43 across 10.6 years:

| strategy | expectancy/trade | n | t |
| --- | --- | --- | --- |
| pooled grid, every session | −0.4257% | 897 | −3.10 |
| earnings-reaction sessions only | **−1.4433%** | 15 | −4.54 |
| combination — event levels on event days | −0.4229% | 897 | −3.10 |

**Event days are 1.0378%/trade worse, t = −2.99**, and remain negative gross of cost with stops widened to −6%. An earnings reaction raises volatility without supplying direction, so a fixed stop is reached sooner while the take-profit is not.

**And events are 1.62% of sessions**, so event-conditioned levels cannot move the blended result whatever their sign. This is a structural argument, not a statistical one, and it does not weaken with more data.

> **Numbers re-measured 2026-08-18 by [#685](https://github.com/dd-jp/samurai-trading-system/issues/685); the decision is unchanged and was not re-argued.** This table read **46** events, event-only **−1.3267%** at n = 18, **t = −4.19**, combination −0.4282%, and a difference of **0.92%/trade at t = −2.66**. Those figures reproduce to the digit on the same data under the old labelling — the correction is attributable, not a different pull. **Sign and significance both survive**, and the event penalty widens. The event count falling to 43 makes the structural argument *stronger* (1.73% → 1.62%), which is why the decision needed no revisiting. Working in [doc 18 Result 4](../research/18-intraday-instrument-physics.md#event-conditioned-levels-are-worse-and-cannot-matter-anyway) and the run record [`2026-08-18-earnings-lookahead-rerun.txt`](../research/archive/raw/2026-08-18-earnings-lookahead-rerun.txt).

## Decision 3 — the levels are the **neutral bracket**

> **This is the live exit rule.** The 2026-08-16 amendment below replaced it with a tranche ladder; [#708](https://github.com/dd-jp/samurai-trading-system/issues/708) measured that ladder and rejected it, so **that amendment is withdrawn and Decision 3 stands unamended** — one frozen bracket per subclass, flat by close, as shipped in [#739](https://github.com/dd-jp/samurai-trading-system/issues/739).

**The rule, declared before fitting:** the bracket in which take-profit and stop are **equally likely to be hit first**, unconditionally. At that bracket the position is a fair coin, so the entry signal's only job is directional accuracy, and the edge it must supply is exactly the round-trip cost amortised over the bracket width.

| subclass | round trip | **take-profit** | **stop** | resolves at a level | accuracy edge required |
| --- | --- | --- | --- | --- | --- |
| **3× index ETP / ETC** | 0.18% | **+2.00%** | **−2.16%** | 48.8% | **+4.33 pp** |
| **3× single-stock ETP** | 0.41% | **+6.00%** | **−6.25%** | 71.6% | **+3.35 pp** |

In underlying terms: **+0.67% / −0.72%** on the index and **+2.00% / −2.08%** on the single name — ordinary intraday moves, which is the sanity check that matters.

**Why the single-stock bracket is wider despite higher volatility:** its cost is 2.3× larger, and cost is amortised over bracket width. Narrow brackets make the ladder fire often but demand a large edge (+8.9 pp at +1.0%); wide brackets need almost none but rarely fire, degenerating into hold-to-close (90.4% close-outs at +4.5%). These two sit at the widest point that still resolves a meaningful share of trades.

Both require **less** accuracy than the ~55% win rate (+5 pp) [ADR-0017](0017-validation-gates-paper-operational-thesis-expectancy.md) already assumes, so they carry margin against the project's own claim.

**Corollary that corrects ADR-0016's intuition:** it is **not leverage** that improves the economics — it is **bracket width relative to a fixed cost**. Leverage helps only by making a wide ETP-percentage bracket reachable within one session, and it raises the spread at the same time.

## Decision 4 — selection budget: **three configurations, selected once**

One pooled pair per subclass (index ETP, single-stock ETP, crypto). The levels follow from the declared neutral-bracket rule rather than from a search, so nothing is selected on and PBO has no set of alternatives to compute over. Doc 13's chain — PBO 0.85 against a 0.05 line, 3 of 24 surviving out-of-sample — is what this avoids.

**Re-selection versus re-calibration.** Re-running a grid and picking a new winner costs trials and happens **once**. Re-computing the *same declared rule* on a rolling window costs nothing, because no choice is made. **The frozen artefact is the rule, not the percentages** — freezing "+2.00%" and revisiting it later is re-selection under another name.

## Decision 5 — drawdown is a **sizing constraint**, not a target

Measured on a **drift-removed** series, so this is the pure volatility envelope with zero edge assumed:

> ⚠️ **Every figure in this decision — the table below, the 23.1% / 26.2% fractions, and the "1.2 pp overshoot" — is measured at a bracket this ADR does not declare, and is understated. Read the [#729](https://github.com/dd-jp/samurai-trading-system/issues/729) verification note at the end of D5 before lifting any of them.**

| subclass | per-trade sd | annualised vol | max drawdown at full £750 |
| --- | --- | --- | --- |
| 3× index ETP | 1.55% | 24.6% | **55.6%** |
| 3× single-stock ETP | 4.01% | 63.6% | **88.0%** |

`CONTEXT.md`'s recorded tolerance is **max ~20–25%**. Full deployment of the equity leg sits **2.2× to 3.5× outside it before any edge exists**, so the constraint binds regardless of how good the signal turns out to be.

**Now:** deploy a fixed fraction sized per subclass by measured volatility — **35% of the leg for index ETPs, 25% for single-stock ETPs**. At the pre-neutral grid these fractions measured **23.1%** and **26.2%** max drawdown; re-measured at the neutral brackets D3 actually declares, they measure **26.2%** and **41.8%** — see the #729 verification note immediately below, and the 2026-08-26 amendment at the end of this decision, which is where the choice between these two readings was settled. **The fraction is the rule; the cash figures (~£260 / ~£190) are illustrative at the £750 inception equity only** — see the sizing amendment below, which settles the basis as current equity rather than frozen cash (doc 18 Result 4's **"The volatility envelope, and why it fixes position size"** table).

**The single-stock fraction overshoots the tolerance, and the overshoot is now formally accepted rather than provisional.** At the declared brackets it measures **41.8%**, ~17 pp above the top of `CONTEXT.md`'s ~20–25% band; the index fraction (26.2%) overshoots too, by a smaller margin. [#798](https://github.com/dd-jp/samurai-trading-system/issues/798) decided 2026-08-26 to accept both rather than re-size or re-open the stop, because the envelope is measured **drift-removed with zero edge assumed** — a deliberately pessimistic reading — and because the single-stock subclass is the one whose bracket the cost argument depends on. `CONTEXT.md`'s Drawdown entry now states these figures directly as the operative tolerance, not a stale ~20–25% target.

> **Verification note — [#729](https://github.com/dd-jp/samurai-trading-system/issues/729), 2026-08-17. The table above is measured at a bracket this ADR does not declare, and D5's numbers are understated.** `docs/research/18-drawdown-envelope.py` is the generator these rows never had; it reproduces all eight published figures exactly, which pins both the definition (max drawdown of a drift-removed, fixed-fraction, **simple-compounded** equity curve over the 2,659-session bracketed series) and the inputs. The inputs are the **pre-neutral `SLS = {1.5, 3}` grid** — index at TP +3.0% / SL −1.50%, single-stock at TP +6.0% / **SL −3.00%** — not the neutral brackets D3 declares and #724 froze. Re-measured at the declared brackets: the index envelope moves 23.1% → **26.2%** at 35% deployment, and the single-stock envelope moves 26.2% → **41.8%** at 25%, because the frozen −6.25% stop is 2.08× the −3.00% measured (per-trade sd 4.01% → 5.36%). **The recorded 1.2 pp overshoot is really ~17 pp.** Holding the tolerance at the declared brackets needs f ≈ **0.332** (index) and f ≈ **0.142** (single-stock). This note records the measurement only — **decided 2026-08-26 by #798: the wider envelope is accepted, not sized or stopped away** — see the amendment at the end of this decision. Evidence and reproduction steps in `docs/research/18-intraday-instrument-physics.md`, Result 4.

**Target state:** volatility-targeted per-trade sizing, so each position contributes equal risk rather than equal cash. It is what the 20–25% number means operationally and what [#654](https://github.com/dd-jp/samurai-trading-system/issues/654)'s ladder will need. The Risk Manager has no such rule today.

> **Amendment — 2026-08-26, [#798](https://github.com/dd-jp/samurai-trading-system/issues/798): the wider envelope is accepted; the 35%/25% fractions and the neutral brackets are unchanged.**
>
> #729's re-measurement at the declared neutral brackets — **26.2% max drawdown for 3× index ETPs at 35% deployment, 41.8% for 3× single-stock ETPs at 25% deployment** — stood as an open question ("re-sizing, re-opening the stop, or accepting the wider envelope is an amendment not taken here") from 2026-08-17 until this ruling. David chose **accept**, against the other two options this decision weighed:
>
> - *Re-size* to f ≈ 0.332 (index) / f ≈ 0.142 (single-stock) to hold the original ~20–25% band — rejected. Costs deployment on exactly the single-stock leg the cost argument depends on, at £1,000 all-equity pushing the position toward the minimum-viable-notional floor #740 installed.
> - *Re-open the stop* (narrow the single-stock bracket to bring the envelope back inside 20–25%) — rejected. A required-edge table posted on #798 (out of sample, n = 897, neutral stop re-solved in sample at each take-profit level — not doc 52's own frozen-stop table, which uses a different methodology) priced this after the fact: narrowing to +3.00% TP roughly doubles the required accuracy edge per name (e.g. AAPL 1.20 pp → 4.40 pp), and it reopens Decision 3's frozen neutral bracket, whose 3.35 pp bar is exact by construction. [`docs/research/52-exit-geometry-and-subclass-odds.md`](../research/52-exit-geometry-and-subclass-odds.md) separately establishes the single-stock subclass stays resolved at narrow brackets (TSLA 96.7%, NVDA 88.7%, PLTR 98.2% at ±3%) — narrowing costs edge but does not degenerate the way the index leg would.
>
> **What this changes.** `CONTEXT.md`'s Drawdown glossary entry now states **~26% (index) / ~42% (single-stock)** directly as the live target, replacing the flat ~20–25% figure this decision's fractions were originally sized to hold — the ~20–25% figure is preserved there as history, not as the operative bound. Nothing in the 35%/25% fractions, the neutral brackets, or the shipped code changes as a result of this amendment; it is a tolerance-widening, not a re-sizing. [#729](https://github.com/dd-jp/samurai-trading-system/issues/729)'s own open point — that D5's envelope had no generator checked into the repo — is resolved by the same commit that produced these figures (`docs/research/18-drawdown-envelope.py`), independent of this acceptance decision.
>
> **What this does not settle.** Whether the fractions this envelope is measured at (35%/25%) actually reach a live order is [#886](https://github.com/dd-jp/samurai-trading-system/issues/886)'s question, decided the same day — equity-relative caps, D5-classified instruments exempt from the generic per-trade cap. **#886 alone did not close this** — writing its own acceptance-criteria test at a realistic (not full-envelope) ask size surfaced [#932](https://github.com/dd-jp/samurai-trading-system/issues/932): `per_asset_cap_fraction_of_equity` (10%) was never exempted by #886 and is tighter than either D5 fraction, so a full-conviction entry was still trimmed at the per-asset-exposure gate. #932 extends the same exemption to `per_asset_cap` for a D5-classified instrument, so only with #932 shipped do 41.8%/26.2% stop being figures the profile might never deploy and become the envelope the system will actually produce.

## Consequences

**The study's output is a bar, not a profit estimate.** At the neutral bracket the required edge is the cost itself: **+0.18%/trade for index ETPs, +0.41% for single-stock ETPs**, or equivalently **+4.33 and +3.35 percentage points of directional accuracy** over a coin flip. This is the first falsifiable statement of what the debate layer has to be worth.

**[#625](https://github.com/dd-jp/samurai-trading-system/issues/625) becomes the critical path.** A system that has produced 96 debates and 0 trades has never been measured against this bar, and nothing downstream of it can be.

**ADR-0015's £750/£750 split now means allocated, not deployed, capital** on the equity side. The split itself is unchanged.

> **The split is gone as of 2026-08-18** (ADR-0015's amendment of that date: the book is **£1,000, all equity**). The distinction this paragraph draws — allocated versus deployed — survives and is the reason the fractions, not the cash figures, are the rule. What changes is the base: D5's fractions now apply to the **whole account** unscaled, so ~£260/~£190 become **£350/£250**, and the single-stock row runs at the `f = 0.25` whose measured drawdown is the ~41.8% of the #729 note below — [#798](https://github.com/dd-jp/samurai-trading-system/issues/798)'s subject, now unavoidable rather than contingent.

**The crypto brackets are not set by this ADR.** #660's 4%/2% levels are unmeasured. The same engine applies — crypto 1-minute is free from 2021-01-04 per doc 33 — but "session" is undefined for crypto until [#667](https://github.com/dd-jp/samurai-trading-system/issues/667) fixes the flatten rule, so the measurement is blocked, not skipped.

## Amendment — 2026-08-16, WITHDRAWN 2026-08-17: the tranche ladder was declared, then measured and rejected

- **Amended:** Decision 3 (the neutral bracket as the exit *rule*) and Decision 4 (re-selection versus re-calibration)
- **Earned by:** [#704](https://github.com/dd-jp/samurai-trading-system/issues/704), grilled and resolved 2026-08-16 under map [#703](https://github.com/dd-jp/samurai-trading-system/issues/703)
- **Withdrawn by:** [#708](https://github.com/dd-jp/samurai-trading-system/issues/708)'s ladder rider, 2026-08-17; recorded by [#814](https://github.com/dd-jp/samurai-trading-system/issues/814)

> **THE LIVE EXIT RULE IS DECISION 3's SINGLE NEUTRAL BRACKET, ONE PER SUBCLASS — +2.00% / −2.16% on a 3× index ETP, +6.00% / −6.25% on a 3× single-stock ETP, flat by close. There is no tranche ladder on the trading path, and there is no deferred one.**
>
> This amendment declared the ladder as the exit rule and made that declaration *falsifiable* on #708's rider (see "The tranche vector is NOT set here" below, which pre-recorded this outcome as a result rather than a reversal). **The rider ran and the ladder did not clear.** Over the same 897 out-of-sample sessions with both arms truncated at the 16:25 London flatten ([`docs/research/50-entry-time-conditional-brackets.md`](../research/50-entry-time-conditional-brackets.md)): the 50/25/25 ladder requires **4.52 pp** of accuracy edge against the single bracket's **4.19 pp**, paired difference **−0.0022%/trade, SE 0.0106, t = −0.20 on n = 897** — indistinguishable, point estimate against the ladder, and under the cost model **most generous to it** (one round trip charged on full notional for what is physically three exits). Under #704's own stated terms a ladder that fails to beat the single bracket means the single bracket stands, so **the tranche vector is dead rather than deferred**.
>
> Shipped accordingly: [#739](https://github.com/dd-jp/samurai-trading-system/issues/739) (`f4e6b1c`) froze one bracket per subclass in `server/pipeline/trader/subclass-bracket.ts`, wired as `subclass_brackets: ADR_0018_SUBCLASS_BRACKETS`.
>
> **The section below is kept as the record of what was declared and why**, because its reasoning — the withdrawal of the 4.60 pp width formula, the truncation mechanism, and the neutral-stop bijection at "What is amended, and what is not" — remains correct and is why the ladder had to be measured at all. Read it as history, not as the rule.

**The declared exit rule changed from a single neutral bracket to a tranche ladder over one shared wide stop.** Decision 4 requires that a rule change be recorded as one rather than arriving as new percentages, and this was that record. **It has since been withdrawn — see the banner above.**

### The justification, and the one that was rejected

**Rejected: the width-formula argument.** The ladder was originally motivated by `required edge = cost / (take-profit + |stop|)` evaluated at a blended width — `0.18 / (1.75 + 2.16) = 4.60 pp`. **That figure is withdrawn.** The formula does not merely lose exactness away from neutrality; it does not model a ladder at all. It treats the ladder as one position that either wins a blended 1.75% or loses 2.16% on full size, and a ladder produces neither outcome: reach +1.0%, then reverse into the stop, and the result is +1.0% on half and −2.16% on half — a path the expression has no term for. Numerator and denominator are both wrong, so 4.60 pp is not a bound in either direction. An amendment resting on it would be precisely the silent re-selection Decision 4 forbids.

**Recorded instead: truncation under flat-by-close.**

> ADR-0014 forces a close at session end. **A truncated bracket is a different instrument from the one Decision 3 measured.**
>
> Decision 3's reach rates ask *"is the take-profit hit before the stop?"* over an untruncated path. Under a hard flatten — and inside the 14:30–15:45 entry window recorded on [#706](https://github.com/dd-jp/samurai-trading-system/issues/706), which leaves a last entry roughly 40 minutes — "has not reached the target yet" stops being a non-event and becomes a **realised outcome**: the position closes at market at whatever the tape offers, having paid the full round trip.
>
> So the single bracket's dominant failure mode at this horizon is not *stopped out*. It is **flattened at an arbitrary price** — an outcome absent from the derivation the bracket comes from. The ladder converts *"never reached +2%, closed at market"* into *"captured +1% on half the size"*.

The claim is **not** that a ladder improves expectancy at the bracket. Doc 11 found that a ladder neither creates nor destroys edge *inside a fixed bracket*, and that finding is not disputed — it tested trimming inside fixed geometry, not exit under truncation. The claim is that **under truncation, realising part of the move beats holding the whole position to an arbitrary close.**

Two properties make this admissible under Decision 4 where the formula argument was not. It is **falsifiable** — #708's rider measures truncated ladder outcomes against truncated single-bracket outcomes over the same tape. And it names a mechanism the original derivation **did not model**, which is re-derivation under a changed premise rather than re-selection of percentages under an unchanged one.

### What is amended, and what is not

**Amended, then withdrawn:** this declared the exit rule to be *a tranche ladder over one shared stop, flat by close*, in place of *the single neutral bracket*. **#708's rider rejected it at t = −0.20 (n = 897), so the amendment is withdrawn and the single neutral bracket per subclass is the live rule** — the banner at the head of this amendment carries the measurement and the shipped configuration. Nothing else in this amendment was ever the rule; the rest of this section is what survived it.

**Still standing — Decision 3's arithmetic, never amended and unaffected by the withdrawal:** the neutral-bracket levels, the 4.33 pp and 3.35 pp bars, and the bijection from take-profit to neutral stop (+1.0↔−1.03, +2.0↔−2.16, +3.0↔−3.35). That bijection is what makes the ladder's cost explicit: **one shared stop can be neutral for at most one tranche.** Against −2.16% the +2.0% tranche is neutral; +1.0% sits over a stop wider than its partner and +3.0% over one tighter, each carrying an `E_gross` term of opposite sign. This is stated rather than hidden, because it is exactly why the vector needs measuring.

**Not amended — Decision 4's discipline:** this is one rule change, recorded once, with its justification named. It does not license revisiting the percentages later without a further amendment.

### The tranche vector is NOT set here — and never will be

> **Resolved 2026-08-17.** The rider named below reported: the vector is **not adopted**. What follows is the pre-measurement statement, kept because its last paragraph is the clause that fired.

**Superseded — the rider reported; see the banner at the head of this amendment.** The candidate vector — 50%@+1.0% / 25%@+2.0% / 25%@+3.0% over a shared −2.16% stop — and **the bar the signal must clear** are both **pending #708's ladder rider**, which measures `E_gross` per tranche and computes `Δ = (cost − E_gross)/width` directly rather than assuming neutrality. They are deliberately absent from this amendment; #704 resolved the *rule* precisely because the map was grilled before the measurement ran.

**Superseded as a *pending* statement, but its figure stands.** *"Until the rider reports, the only exact bar is +4.33 pp on the neutral single bracket* (index; +3.35 pp single-stock). *That is the figure the screening axis, #708's own adopt condition, and the falsifier-arm comparison cite.* **Not 4.60.**" The rider has reported, and **+4.33 pp / +3.35 pp remain this ADR's declared bars** — they are Decision 3's, never amended. See the note at the end of this section for #708's truncated comparators, which do not replace them.

**Superseded — the build never gains tranches.** *"Consequence for implementation: the build ships the neutral single bracket +2.00 / −2.16 first — its bar is exact and needs no amendment — and gains tranches once they are priced."* The first half happened ([#739](https://github.com/dd-jp/samurai-trading-system/issues/739)); the second half is void, because pricing them is what killed them. **The frozen single bracket per subclass is the terminal exit rule of this ADR, not a first stage of one.**

**If the rider prices the ladder worse than the single bracket under truncation,** the truncation argument is falsified and the single bracket stands. Recorded up front so that outcome is a result rather than a reversal.

> **This is the clause that fired.** The rider priced the ladder no better than the single bracket (t = −0.20, n = 897), so the single bracket stands and **the build never gains tranches**. Separately, #708 measured that truncation moves the *index* bar from **+4.33 pp to +4.19 pp** and reports the truncated single-stock bar as **3.85 pp** — those are the truncated comparators, and they are the reference for the ladder-versus-bracket comparison above. They do not amend Decision 3's untruncated +4.33 pp / +3.35 pp, which remain this ADR's declared bars.

### Consequence of the same-day crypto ruling

Crypto left this system's scope on 2026-08-16 ([ADR-0014](0014-intraday-flat-by-close-horizon.md)'s companion amendment). Two follow-ons here:

- **Decision 4's selection budget drops from three configurations to two.** *"One pooled pair per subclass (index ETP, single-stock ETP, crypto)"* — the crypto pair is never selected, so the budget spent by this system is two. This tightens the trial accounting rather than loosening it, and is recorded so a later reader does not find a third pair unaccounted for.
- **The Consequences note on crypto brackets is now out of scope, not blocked.** #660's 4%/2% levels being unmeasured, and the measurement being blocked on #667's session definition, both move to the future crypto system's record.

### The −0.5% stop is dead, and that does not depend on any of the above

Two independent grounds, neither touching neutrality or truncation:

- **Width, restated 2026-08-16 where the formula is valid.** The earlier figures — ≥8.00 pp (3× index) and ≥18.2 pp (3× single-stock) — were **computed over the candidate tranches**, i.e. by running a ladder width through `cost / (TP + |stop|)`. That is the same misuse this ADR's amendment above withdrew 4.60 pp over — a withdrawal that **survives** that amendment's own 2026-08-17 withdrawal, since the formula misuse is wrong independently of whether the ladder was adopted — so **those two figures are withdrawn too**. The argument survives intact when made against the **single neutral bracket**, where the formula is exact: the bijection is monotone (+1.0 ↔ −1.03, +2.0 ↔ −2.16, +3.0 ↔ −3.35), so a −0.5% stop's neutral take-profit partner is strictly below +1.0% and the width strictly below 1.5%. The bar therefore floors at **>12 pp** (3× index) and **>27 pp** (3× single-stock) — stronger than the withdrawn figures, and derived rather than assumed.
- **Stop fidelity.** [`docs/research/41-tick-latency-economics.md`](../research/41-tick-latency-economics.md) Result 2 measures the conditional tail as `g(D) = 0.525%·√D` on a 3× equity ETP. **A −0.5% stop is smaller than its own execution error** at any cadence we can run — at τ=15 it delivers ≈−2.4%.

  *Where −2.4% comes from, since three review passes read it as a bare application of `g`.* It is the **delivered** stop, not the overshoot alone: the intended −0.5% **plus** the conditional overshoot at that cadence. Doc 41's measured row at D=15 is −1.97% (the `0.525%·√D` fit gives −2.03%, within its stated 3.5%), so −0.5% + −1.97% ≈ **−2.4%** — doc 41 Result 2's own wording, *"a −0.5% stop actually delivers about −2.4%, roughly five times its intended size."* Read as the overshoot term alone the figure would indeed be −2.0%, and the conclusion holds either way; the delivered figure is the one that makes "smaller than its own execution error" a comparison rather than an assertion.

## Amendment — 2026-08-16: the sizing unit, the cap basis, and the frozen stop

- **Amends:** Decision 5 (the sizing constraint's *form*, not its figures)
- **Source:** [#721](https://github.com/dd-jp/samurai-trading-system/issues/721) and [#724](https://github.com/dd-jp/samurai-trading-system/issues/724), grilled under map [#703](https://github.com/dd-jp/samurai-trading-system/issues/703)

Decision 5 stated the envelope but left three things underdetermined, each of which decides a live-money number.

**1. The cap binds on notional, and this is arithmetic rather than preference.** [`docs/research/18-intraday-instrument-physics.md`](../research/18-intraday-instrument-physics.md) scales the underlying US tape **by the ETP leverage factor**, so the per-trade sd in D5's table — 1.55% index, 4.01% single-stock — is the **ETP's own move, with the 3× already inside it**. Every figure in D5 is therefore denominated in ETP notional. Leverage-adjusting the cap a second time would count the 3× twice and size every position to roughly a third of what was measured.

**2. The cap is a fraction of *current* equity, not a frozen cash amount.** A fixed £262 is 34.9% of a £750 book, 43.7% of £600 and 58.2% of £450 — exposure rises as a fraction of equity exactly as equity falls, so a drawdown bound stops bounding at the first loss. The fractional form is self-correcting, and it makes the recorded envelope **conservative**: since exposure shrinks after a loss, cumulative loss under fixed-fractional sizing is strictly smaller than under the fixed-cash deployment doc 18's ladder rows describe. **23.1% and 26.2% are upper bounds for the implemented rule**, not estimates of it. Config carries the fraction; the composition root resolves it against the live equity read.

**3. The stop is frozen per subclass, and the conversion to `risk_fraction` is per subclass with it.** Sizing runs through the existing `size = (equity × risk_fraction) / stop_distance`, so under a frozen percentage stop `risk_fraction = deployment × stop_pct`. Decision 3's bracket table has **two rows**, so `stop_pct` differs by subclass:

| subclass | deployment (D5) | frozen `stop_pct` (D3) | `risk_fraction` |
| --- | --- | --- | --- |
| 3× index ETP | 35% | 2.16% | **0.00756** |
| 3× single-stock ETP | 25% | 6.25% | **0.015625** |

**Two distinct ways to get this wrong, both recorded because both are silent.** Storing the deployment fraction directly — `0.35` — sizes to **16.2× equity** and passes any test that checks the config against this ADR. Applying the *index* stop to the single-stock row gives `0.25 × 0.0216 = 0.00540`, which deploys 8.6% instead of 25%: it errs small, trips no gate, breaches no cap, and would survive a full soak, visible only as the single-stock leg hitting the minimum-viable-notional floor more often than intended. **The test must assert the resulting deployment — `size × entry ≈ 0.35 × equity` — never the config value**, since only that assertion fails on either error.

**What this does not change:** D5's figures, its drift-removed measurement, the single-stock overshoot recorded above, or the target state. Freezing the stop keeps each bar exact at its own neutral bracket (4.33 pp index, 3.35 pp single-stock) at the price of the response to volatility becoming **discrete** — the binary halt, re-keyed from `AssetClass` to `subclass`, is the only volatility-responsive mechanism until the stop floats.

**Open against this amendment:** [#729](https://github.com/dd-jp/samurai-trading-system/issues/729) — D5's envelope has no generator checked into the repo and its rows cannot be re-derived by hand. The conservatism argument in point 2 is what lets sizing be built against the fraction-of-equity form meanwhile; what stays unproven is that `CONTEXT.md`'s 20–25% tolerance is *met*.

## Amendment — 2026-08-27, [#903](https://github.com/dd-jp/samurai-trading-system/issues/903): `index_etp_3x` was widened past what Decisions 3 and 5 measured; the four widened rows are structurally excluded from live sizing

- **Amends:** Decisions 3 and 5 — the *membership* of `index_etp_3x`, not its figures.
- **Source:** [#903](https://github.com/dd-jp/samurai-trading-system/issues/903), against ground laid by [#813](https://github.com/dd-jp/samurai-trading-system/issues/813).

D3's frozen bracket (+2.00% / −2.16%, 48.8% resolve level) and D5's 35% deployment fraction for `index_etp_3x` were both measured with **SPY standing in for the whole subclass** — "two instruments, not the universe" (Known weaknesses, below). That stand-in held for as long as every `index_etp_3x` row in `lse-etp-pool.ts` was a broad-US-tracker line. [#813](https://github.com/dd-jp/samurai-trading-system/issues/813) (2026-08-19) broke that: it added four `index_etp_3x` rows — **3VT/VT** (all-world), **3KOR/EWY** (South Korea), **3KWE/KWEB** (China internet), **3XLE/XLE** (US energy sector) — none of which sits in 3x SPY's volatility envelope. `assertKnownSubclass` cannot catch this, because the subclass *string* is still recognised; only the *measurement* is stale for these four.

**Resolution (Option 3 of #903's three): exclude, don't re-measure or split, for now.** `LseEtpPoolRow` gained a `subclass_envelope_measured: boolean` field (`true` on 26 rows, `false` on exactly these four), and `liveSizingSubclassFor()` is the function any live-sizing consumer — chiefly [#751](https://github.com/dd-jp/samurai-trading-system/issues/751)'s `ActiveUniverseProvider`, not yet built — must call instead of reading `row.subclass` directly. It returns `undefined` for the four unmeasured rows, which `subclassOfUniverse` treats as "arm no per-subclass regime for this instrument" rather than "size it off the SPY-measured bracket", and `resolveSubclassBracket` then throws `SubclassBracketUnresolvableError` for any of them rather than sizing quietly. This was the cheapest safe option and it preserves #813's 26-underlying count, which #707's ranking precondition needs — the exclusion is sizing-only and does not touch screening.

**What this does not settle.** Whether `index_etp_3x` should be split into narrower subclasses (e.g. a separate bracket per single-country/sector/all-world grouping) or re-measured across its now-wider membership is still open; #903 records the interim state, not the final one. Until a split or a re-measurement is decided, these four rows can be ranked and screened but not sized under the per-subclass regime.

## Known weaknesses

**The baseline is an unconditional long at the open.** That is deliberately naive — it is the bar, not a prediction that the strategy loses money. It is also **long-only**; the short ETP lines are unmeasured.

**Underlying tape, not ETP tape.** No tracking error, no ETP spread beyond the assumed round trip, and **no GBP/USD leg** — the GBP lines sit on USD underlyings and hedging is unconfirmed. [#666](https://github.com/dd-jp/samurai-trading-system/issues/666) owns the real spreads per subclass; **both brackets and both bars move directly with them**, since each cost figure is currently a single quote.

**Two instruments, not the universe.** SPY and TSLA stand in for their subclasses.

**The earnings-day labelling was wrong, and is now corrected and re-measured — but not in the way the weakness was written.** Raised in review of [#676](https://github.com/dd-jp/samurai-trading-system/issues/676), fixed and re-run 2026-08-18 by [#685](https://github.com/dd-jp/samurai-trading-system/issues/685). **Decision 2's figures above are now measured, not indicative.**

The defect recorded here was a look-ahead — a release before 16:00 ET called a *same-session* reaction even when it landed *during* the session, ahead of which the study's 09:30 entry sits — plus one event counted as two reaction days. Both were real defects in `18-threshold-study.py` (not `18-fetch-earnings.py`, which classifies nothing; see [`docs/reviews/issue-triage-2026-08-17.md`](../reviews/issue-triage-2026-08-17.md)) and both are fixed. **Measured, neither moved a number**: every one of TSLA's 43 genuine releases in 10.6 years lands post-close, 16:01–17:14 ET, so no session was ever intraday-contaminated, and the old code's `(date, label)` set had already collapsed the double-count.

**The defect that did move the numbers was the matcher, and it was not the one recorded.** Accepting any headline with a quarter token and the letters `EPS` let four previews and commentary pieces — *"Analyst Predicts 6% Beat On Q2 EPS"*, *"Q3 Earnings Preview: … Expects EPS To Fall Below Estimates"* — mark reaction days of their own. Three fell on trading days, all out-of-sample: 46 = 43 + 3. The release matcher now requires a reported figure (`EPS $…`).

**The remaining weakness is real but smaller.** The classifier's pre-open and intraday branches are exercised only by a synthetic fixture, because TSLA never reports outside the post-close window; a name that reports pre-market would exercise them against real tape and none was measured. And the event-only row is still a 6-cell grid selected in-sample on 28 days and scored on 15, so it should be read as a sign and a significance, not as a precise level.
