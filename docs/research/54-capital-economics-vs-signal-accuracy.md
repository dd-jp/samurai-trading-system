# Capital economics restated as a function of signal accuracy

**Resolution of [#840](https://github.com/dd-jp/samurai-trading-system/issues/840), written 2026-08-18.** Consumes
[`52-exit-geometry-and-subclass-odds.md`](52-exit-geometry-and-subclass-odds.md); measures nothing new and
re-runs no script.

> **This selects nothing and proposes nothing.** It restates
> [#658](https://github.com/dd-jp/samurai-trading-system/issues/658)'s capital arithmetic against a measured
> per-trade expectancy, in the terms ADR-0018 requires. **Trials inherited: doc 52's 126 configurations
> (§10).** Every figure below is taken from doc 52's **declared-bracket** row — the pre-committed geometry —
> and never from a re-solved, best-split, or width-swept column, because reaching for a best-of column would
> be selecting on measured performance.

## 1. Why #658 had to be restated

#658 ruled **(a) no catalyst-gating** on this argument: gating gives up ~£141/yr of gross edge to save ~£5/yr
of LLM spend, a 28:1 loss. The £141 term is `96 trades × +0.195%/trade`, and that `+0.195%` is ADR-0016's,
**withdrawn by [ADR-0018](../adr/0018-intraday-thresholds-sizing-and-the-signal-bar.md) as wrong in sign** —
it was inferred from reach rates (touch counts) rather than simulated over the actual exit rule.

Doc 52 supplies the replacement: bar-by-bar simulation of the declared bracket, out of sample
(in sample `< 2023`, scored `>= 2023`, **n = 897 sessions per name**).

**Term alignment, recorded rather than re-derived.** #658's £141/yr is described there as *gross edge*
compared against the *LLM spend* — so "gross" means gross **of LLM spend** and already net of trading costs.
That is doc 52's **`E_net`**, not `E_gross`. The distinction decides the sign: `E_gross` is positive on five
of seven names, `E_net` is negative on all seven.

## 2. The two numbers this rests on

Doc 52's required accuracy edge is defined as

```
edge_pp = (cost − E_gross) / width × 100          width = take-profit + |stop|
```

so per-trade expectancy at directional accuracy `p` is, in percent of position notional per session:

```
E(p) = (p − 0.5) × width + E_net                  E_net = E_gross − cost
```

Both identities reproduce doc 52 exactly at the declared brackets — index `+2.00 / −2.16` (width 4.16,
round trip 0.18%), single-stock `+6.00 / −6.25` (width 12.25, round trip 0.41%):

- SPY: `(0.18 − 0.0055) / 4.16 × 100 = 4.19 pp` ✓
- AAPL: `(0.41 − 0.2899) / 12.25 × 100 = 0.98 pp` ✓

**So the break-even accuracy needs no derivation — it is `50% + bar`:**

| name | subclass | `E_net` %/session | bar (pp) | **break-even accuracy** |
| --- | --- | --- | --- | --- |
| AAPL | single | −0.1201 | 0.98 | 50.98% *(degenerate — 9.5% resolve)* |
| PLTR | single | −0.1584 | 1.29 | **51.29%** |
| NVDA | single | −0.3478 | 2.84 | **52.84%** |
| QQQ | index | −0.1231 | 2.96 | **52.96%** |
| TSLA | single | −0.4719 | 3.85 | 53.85% |
| SPY | index | −0.1745 | 4.19 | 54.19% |
| MSTR | single | −0.8772 | 7.16 | 57.16% |

AAPL's row is read per doc 52 §5: at a 9.5% resolve rate the bracket is a time exit wearing a bracket, and
the bar stops describing the job the signal is being asked to do. **The identity behind this table assumes the
bracket resolves, so every row is a lower bound that loosens as its resolve rate falls — see §6.6.**

> **Amended 2026-09-14 by [#1218](https://github.com/dd-jp/samurai-trading-system/issues/1218): the round trips
> above are SPREAD ONLY and carry no commission, so every bar in this table is understated by Saxo's 16 bps.**
>
> **This restates, it does not discover.** [`59-universe-tradeability-screen.md`](59-universe-tradeability-screen.md)
> §3 reached the same per-name figures on 2026-09-03 as a cross-check on its own accuracy budget, and this
> amendment reproduces them rather than competing with them. **Doc 59 §3.0's `[inferred]` tag on the spread-only
> premise still stands**, and this amendment inherits it rather than discharging it. §3.0's caveat is that "no
> document states in those words that the D3 figures **exclude venue commission**"; what the sources establish
> is the weaker premise that the figures are **spread quotes** — doc 18's Known weaknesses for the index leg
> (*"one observed **0.18% spread** quote for 3USL"*) and ADR-0016's open-items paragraph for both (*"real LSE
> ETP **spreads** per subclass have not been measured … the 0.18% and 0.41% figures are each a single quote"*).
> Getting from there to "excludes commission" is still the inference doc 59 flagged. Nor is ADR-0016 new
> evidence: doc 59 §3.0 already cites it as its own input. All it adds here is **coverage of the single-stock
> 0.41 leg**, which doc 18's 3USL quote does not reach — a narrowing of the inference, not its removal.
> Aligning the two documents' tags is carried by
> [#1548](https://github.com/dd-jp/samurai-trading-system/issues/1548). Doc 59's separate `[assumed]` on
> ADR-0017's ~55% as an accuracy *budget* is untouched by this and likewise stands.
>
> Doc 52's `COST = {index: 0.18, single: 0.41}` is ADR-0018 D3's, and D3's is doc 18's and ADR-0016's, per the
> two quotes above. It is a spread, not a blended total. Saxo's live GIA commission was measured 2026-09-14 at
> **0.08%/side flat, no per-order minimum** (ADR-0015's amendment, `1d155b7e`), which is **0.16% round trip** and
> additive to it — doc 59 §3 states the same non-double-counting explicitly (*"adding Saxo's full 16 bps
> double-counts nothing"*). So `cost' = cost + 0.16`:
> **0.34% index, 0.57% single-stock.**
>
> **Nothing needs re-simulating.** In `52-exit-geometry-and-subclass-odds.py` cost enters only as a terminal
> subtraction (`out.append(res - cost_pct)`), and the declared bracket is an ADR-0018 constant frozen by #739
> rather than re-solved, so hit rates, resolve rates, widths and `E_gross` are all cost-invariant. The two
> identities then give the restatement in closed form:
>
> ```
> E_net' = E_net − 0.16              bar' = bar + 0.16 / width × 100
> ```
>
> i.e. **+3.85 pp on every index bar** (0.16 / 4.16 × 100) and **+1.31 pp on every single-stock bar**
> (0.16 / 12.25 × 100).
>
> | name | subclass | `E_net` %/session | bar (pp) | **break-even accuracy** |
> | --- | --- | --- | --- | --- |
> | AAPL | single | −0.2801 | 2.29 | 52.29% *(degenerate — 9.5% resolve)* |
> | PLTR | single | −0.3184 | 2.60 | **52.60%** |
> | NVDA | single | −0.5078 | 4.15 | **54.15%** |
> | TSLA | single | −0.6319 | 5.16 | 55.16% |
> | QQQ | index | −0.2831 | 6.81 | **56.81%** |
> | SPY | index | −0.3345 | 8.04 | 58.04% |
> | MSTR | single | −1.0372 | 8.47 | 58.47% |
>
> **The substantive consequence is a widened subclass separation, not a reordering.** A flat commission charged
> against a **4.16-wide** bracket costs 2.9x what it costs against a **12.25-wide** one, so the index penalty is
> 2.9x the single-stock one: the index mean bar goes 3.58 → **7.43 pp** while the single-stock mean goes 3.22 →
> **4.53 pp**. **The narrow bracket is the one commission punishes**, and §2's "narrow brackets demand a large
> edge" trade-off is sharper than doc 52 measured it. Be precise about what does *not* change: the ranking is
> almost unmoved — SPY was already the second-hardest name before the restatement, and the only rank change is
> **QQQ overtaking TSLA**. Nor do the index rows separate cleanly at subclass level: they sat inside the
> single-stock range (below MSTR) before and still do. This is a widening, not an inversion.
>
> **This is a floor, not the charge.** The FX conversion margin on USD-quoted settlement is unmodelled — a
> recorded deferral (#1220, David's 2026-09-08 ruling, which excluded non-sterling lines rather than pricing
> them) and not an oversight — and the LSE ETP's own spread is still the single unmeasured 3USL quote that
> §6.3 and #1053 describe. Both push the same way. Nothing here re-opens #666's measurement; it adds the one
> cost component that *is* now measured.

## 3. The LLM bill, rebuilt equities-only

**#658's £864/yr, the corrected £252/yr, the post-#617 £89/yr and the £12/£5 equity-leg figures are all
withdrawn here.** Each is a 15-minute-cadence, crypto-in-scope number, and crypto left scope on 2026-08-16
(ADR-0015's amendment). Rebuilt from the measured unit instead:

- **$0.0060 per debate run**, 4 calls, ~13s — ADR-0008 §2's #657 amendment, measured over 1,151 calls.
- **Spend no longer scales with the tick.** Post-#617 the debate is keyed to `DEBATE_BAR_TIMEFRAME_MS = 1h`
  (`server/pipeline/debate-engine/debate-log-store.ts:144`), so τ = 2 min buys exit resolution, not debates.
- Runs/day = *instruments debated* × *hourly bars in the session* ≈ **7 × 7 = 49**, i.e. **$0.294/day**.

**Both factors are labelled assumptions, not settled facts.** Seven is doc 52's underlying count and the
#749 pool's distinct `screening_instrument` count (11 tickers over 7 underlyings); how many are debated per
day is [#751](https://github.com/dd-jp/samurai-trading-system/issues/751)'s active-list question and the pool
is deliberately unwired. Seven hourly bars is a US-session count.

**≈ $74/yr ≈ £58/yr** over 252 sessions, at the $1.27/£ rate the earlier figures were converted at.

> **Amended 2026-09-03 by [#969](https://github.com/dd-jp/samurai-trading-system/issues/969): this bill is
> the DEBATE leg only, and the market-intelligence leg has stopped being negligible.** The $0.0060/run unit
> above is unchanged. What changed is that the sentiment stage now *retrieves* — the server-side `x_search`
> tool, behind `SAMURAI_SENTIMENT_RETRIEVAL=on` — and a retrieving call carries its search results in the
> **prompt**, so it costs roughly **$0.02** at the default 3 results (measured **$0.089** at 10) against the
> ~$0.001 a recall-only sentiment call cost.
>
> **Buckets are session-derived, which is the first thing to check and the thing a first pass of this
> amendment got wrong.** `UniverseScheduler.nextTick` returns an **empty** instrument list whenever the
> calendar says closed, so the sentiment refresh never fires outside the session: a 6.5h US session touches
> **4** two-hour buckets, not the 12 a 24-hour day gives. On the same 7-instrument, 252-session basis:
> 7 x 4 x 252 ≈ **7,100 calls/yr ≈ $141/yr ≈ £111/yr** at the default 3 search results. (An earlier draft
> of this box said £330/yr off a 12-bucket calendar reading. Same error class as the one #969 exists to
> correct: a downstream conclusion computed from a premise nobody checked against the code.)
>
> **The other multiplier is universe width, and it is NOT the 7 used here.** This section's 7 is the live
> LSE pool's underlying count, which is the right basis for a live-bill estimate. The *paper* universe is
> 20 names since [#1051](https://github.com/dd-jp/samurai-trading-system/issues/1051), where the same
> arithmetic gives ~$16 of MI spend per 14-day soak against a ~$8.40 debate leg — i.e. **the sentiment leg
> outweighs the debate leg**, which is not true at any figure this document computed before. Read the two
> bases separately and do not average them.
>
> **What that does to this section's conclusion.** The total bill goes from **£58/yr to ~£169/yr — roughly
> triple**, with MI now the larger leg. That is not "second-order" in the sense of ignorable, but neither
> does it overturn the section: the break-even accuracy thresholds in §4 shift by the ratio of the bill to
> the trading term, and at 10 search results (~£495/yr at 7 instruments) they shift materially further.
> **Recompute §4's thresholds against the actual bill before quoting them for a universe running
> retrieval** — do not carry the £58 figure across.
>
> Three things follow, and none of them is "spend more". **(1)** Retrieval defaults **off**; it is a dated,
> deliberate switch, not an operator default. **(2)** The soak IS where this binds, on the 20-name paper
> universe: 20 x 4 x 10 = ~800 calls, ~$16 at 3 results and ~$71 at 10, against a $50 cap shared with a
> ~$8.40 debate leg. (An earlier draft of this bullet said the opposite, off the pre-#1051 3-name universe.)
> **(3)** The figures here are a **range, not a point** (output tokens were never measured at 3 results,
> and reasoning tokens do not scale down with result count), *and the call count is a derived assumption on
> the same footing*, descending from the scheduler and `GROK_REFRESH_MS`. The reconciliation against the
> provider's invoice is what replaces both. [ADR-0020](../adr/0020-x-retrieval-through-nous.md) carries the
> regime; ADR-0008 §2's 2026-09-03 amendment carries the cap arithmetic.

## 4. The restatement

Annual net, per **£1,000 of position notional**, at accuracy `p` over `N` sessions traded:

```
net_£/yr = N × E(p)/100 × notional − bill
```

**Position notional, not the book.** Every figure below is per **£1,000 of position notional** — the cash
in a *single position* — which is not the book. Under [ADR-0018](../adr/0018-intraday-thresholds-sizing-and-the-signal-bar.md)
D5's fractions a £1,000 book funds one position at **£350 (index) or £250 (single-stock)**
(`server/apps/orchestrator/paper-profile.ts:381,391`), so book and notional differ by that fraction and must
never be read as the same number.

**Capital is deliberately not substituted.** #658's £500–1,000, and the later £750 equity leg, are both
superseded. Multiply through by the notional once the deployment fraction is settled.

> **Half of that resolved on 2026-08-18, after this doc was written.** David re-based the book to **£1,000,
> all equity** (ADR-0015's 2026-08-18 amendment, closing
> [#800](https://github.com/dd-jp/samurai-trading-system/issues/800)), so the **book size is settled**.
> **That does not make the £1,000 column below the operative one.** Corrected 2026-08-19 in review: an
> earlier draft of this note read the £1,000 column as the book and concluded the 0.55 pp cost-in-accuracy
> figure "applies as written". The columns are *position notional*, and D5 funds one position at £350/£250
> out of a £1,000 book — so both the £1,000 and £5,000 columns remain illustrative, and at the resolved
> notionals the bill costs **1.58 pp (index)** and **0.75 pp (single-stock)**, not 0.55 pp. See §4. The deployment fraction remains open under
> [#798](https://github.com/dd-jp/samurai-trading-system/issues/798), which the same ruling made *harder*:
> single-stock `f = 0.25` now applies unscaled, at a measured ~41.8% drawdown. Note the two move in opposite
> directions for this doc's purposes — a **smaller** book raises the bill's share of accuracy, while a
> **larger** deployment fraction raises the notional each trade earns on. Neither figure here is re-derived;
> nothing in the identities depends on the book size.

**At `p = 0.5` — no signal, which is what doc 52 measures — the trading term dwarfs the bill.** QQQ, 252
sessions, £1,000 notional: `252 × −0.1231% × £1,000 = −£310/yr` against a £58/yr bill. **That is #658's
premise inverted.** #658 was written when the bill was believed to be ~£864/yr against a positive edge; the
bill is now ~£58/yr against a trading term that is negative and roughly 5× larger.

**Expressed as accuracy, the bill's weight is entirely a function of the notional.** Carrying it costs

```
Δp (pp) = bill × 10⁴ / (N × notional × width)      e.g. 58 × 10⁴ / (252 × 1000 × 4.16) = 0.55 pp
```

The whole £58 bill is charged against a **single** position stream throughout — the attribution the £1,000
column already used — so every figure here is an upper bound if more than one position runs concurrently.

| position notional | index (width 4.16) | single-stock (width 12.25) |
| --- | --- | --- |
| £5,000 | 0.11 pp | 0.04 pp |
| £1,000 | 0.55 pp | 0.19 pp |
| **£350 / £250 — D5's fractions of the £1,000 book** | **1.58 pp** | **0.75 pp** |

> **And it is not settled that D5's envelope is what funds the position.**
> [#886](https://github.com/dd-jp/samurai-trading-system/issues/886) (BLOCKING, filed 2026-08-19) records that
> `per_trade_size_cap` can trim a D5-sized ask: a full-conviction £350 index entry against a 5% cap is handed
> back **£50**. Two bounds on that, both recorded rather than resolved here. `decide.ts:575` stacks a
> conviction multiplier on D5's fraction, so £350 is a full-conviction *ceiling* and a low-conviction ask can
> land under the cap untrimmed. And `per_trade_size_cap` is a **static cash** figure derived from the boot
> ceiling (`server/pipeline/risk-manager/index.ts:365`, `server/apps/orchestrator/live-profile.ts:66`) while
> D5 is a live fraction of `portfolio.equity` (`risk-manager/index.ts:515`) — so which one binds depends on
> how far equity sits below that ceiling, and the two are not comparable as fractions at all.
> **The range matters more than the resolution:** across a £50–£350 index notional the bill costs **11.1 pp
> down to 1.58 pp**, i.e. from dominating every geometry bar in §2 to sitting at half of QQQ's. Nothing here
> decides which cap should win; the point is that the bill's weight stays unsettled by ~7x until #886 is.

**At the resolved notionals the bill stops being second-order on the index bracket.** 1.58 pp is more than
half of QQQ's 2.96 pp geometry bar and ~38% of SPY's 4.19 pp; including it, QQQ's break-even is **54.54%**,
not the 53.51% the £1,000 illustration gives. On the single-stock bracket it stays small — 0.75 pp against
bars of 1.29 (PLTR) to 7.16 (MSTR) — because the wider bracket and the larger `E_net` magnitudes both
dominate it.

> **Amended 2026-09-14 by [#1218](https://github.com/dd-jp/samurai-trading-system/issues/1218).** The Δp table
> and the 1.58/0.75 pp figures are **unchanged** — they divide the bill by `N × notional × width`, and the
> commission restatement in §2 moves none of those three. What changes is the geometry bar each is compared
> *against*. Against §2's restated bars the bill is now a **smaller** share, not a larger one: 1.58 pp against
> QQQ's 6.81 pp rather than its 2.96 pp, and ~20% of SPY's 8.04 pp rather than ~38% of 4.19 pp. **QQQ's
> break-even including the bill becomes 58.39%** (56.81 + 1.58), not 54.54%. The claim that the bill is not
> second-order on the index bracket survives, but it is no longer the largest correction on that bracket —
> commission is, by roughly 2.4x. **The unqualified claim that the bill is second-order holds only at the £1,000-notional
illustration, and not at the notional D5 actually resolves to.**

## 5. What this says about gating — and what it cannot say

Let `g` be the fraction of sessions kept by a catalyst gate. Debate spend is **per debate run**, so a gate
that removes trading days removes the debates on them: **both terms scale with `g`**.

```
net(g) = g × [ N × E(p_g)/100 × notional − bill ]
```

**The 28:1 argument dissolves — it is not a smaller number, it is a comparison that no longer exists.** #658
weighed a fixed £141 of forgone gross against a fixed £5 of saved spend; with the bill proportional to days
traded, the bracketed term is common to both arms and the whole question reduces to:

> **Is directional accuracy on catalyst days higher than on all days — `p_g > p_u`?**

Two things follow, and one explicitly does not.

**Follows.** At unconditional entry (`p = 0.5`) every name has negative `E_net`, so *any* reduction in
sessions traded reduces the loss. #658's (a) ruling loses the support it was given.

**Follows.** The absolute bar is unchanged by gating: whatever `g` is, the system needs
`p ≥ 50% + bar + Δp` to make money at all — **51.3% (PLTR) to 57.2% (MSTR)** before the bill, and
**~52.0% (PLTR) to ~57.9% (MSTR)** with it, alongside **~54.5% on QQQ**, each carrying the bill at the
notional D5 resolves to (£250 single-stock, £350 index) rather than at the £1,000 illustration.
**Restated 2026-09-14 by [#1218](https://github.com/dd-jp/samurai-trading-system/issues/1218) for Saxo's 16 bps
round-trip commission (§2's amendment): 52.6% (PLTR) to 58.5% (MSTR) before the bill, ~53.4% to ~59.2% with it,
and ~58.4% on QQQ. The shape of the argument below is unaffected — the bar rises, and it is still a bar rather
than a cost trade.** This is the replacement for the withdrawn *"catalyst days must deliver ≥ 0.312%/trade against the
0.195% all-day average — a 60% uplift"* bar handed to
[#655](https://github.com/dd-jp/samurai-trading-system/issues/655). **The shape is different: the old bar was
a percentage uplift over a positive average; the anchor is negative, so the replacement is an accuracy
threshold, and the gating question is a comparison of two accuracies rather than a cost trade.**

**Does not follow.** That catalyst-gating is right. Doc 52 §2 and §9.1 are explicit: there is no signal in
any of it, `E_gross` is the instrument's drift over the holding pattern, and *"no figure here says the system
is profitable or unprofitable."* `p_u` and `p_g` are both unmeasured because the signal does not exist yet.
**Nothing in this document decides #658 or #655; it states what each would have to measure.**

## 6. Limitations inherited

1. **Trials.** Doc 52 priced 126 configurations and adopted none; this restatement reaches for its `E_net`
   column and inherits them. Only the declared-bracket row is used.
2. **The LSE proxy gap (doc 52 §9.2).** The tape is the **US underlying scaled by the leverage factor** —
   no specced DataSource serves the LSE ([#734](https://github.com/dd-jp/samurai-trading-system/issues/734)).
   Real ETP tracking error, LSE-hours liquidity and the ETPs' own spreads are absent. #658 is a question
   about the live equity leg, so these are anchors with a stated proxy gap.
3. **Costs are per-subclass, not per-instrument (doc 52 §9.3).** Every £/yr figure here inherits a subclass
   round trip (0.18% / 0.41%), both of which rest on a single quote:
   [#666](https://github.com/dd-jp/samurai-trading-system/issues/666), which would have measured
   them, closed 2026-08-27 out of scope without delivering that measurement;
   [#750](https://github.com/dd-jp/samurai-trading-system/issues/750) now gates on it instead, and
   [#1053](https://github.com/dd-jp/samurai-trading-system/issues/1053) (open) owns delivering it.
   [`53-intraday-cost-calibration.md`](53-intraday-cost-calibration.md) calibrates the *backtest* cost model
   at 1-minute resolution on a US-equity proxy; it does not supply an LSE ETP round trip either, so it
   narrows nothing here. **Narrowed in part 2026-09-14 by
   [#1218](https://github.com/dd-jp/samurai-trading-system/issues/1218): the SPREAD half is still a single
   unmeasured quote and #1053 still owns it, but the COMMISSION half is now measured rather than assumed —
   0.08%/side flat at Saxo, additive to both subclass round trips, and applied in §2's amendment. The two
   halves are separable precisely because one is a venue rate and the other is an instrument property.**
4. **Deployment is open** ([#798](https://github.com/dd-jp/samurai-trading-system/issues/798)) — hence
   per-£1,000 throughout, with the D5-resolved £350/£250 row alongside it. The book itself is no longer open:
   #800 settled it at £1,000, all equity.
5. **The bill's two factors are assumptions** (§3): instruments debated per day and bars per session.
6. **The `E(p)` identity assumes the bracket resolves.** `E(p) = (p − 0.5) × width + E_net` prices a win at
   `+tp` and a loss at `−|sl|`, i.e. it puts no mass on sessions that reach neither leg and exit flat-by-close
   at whatever the drift left. It is exact only as the resolve rate approaches 100%, and it degrades
   continuously as that rate falls — so `50% + bar` is a *lower* bound on the accuracy actually required,
   loosest where resolves are thinnest. Doc 52's declared-bracket resolve rates span **9.5% (AAPL) to 83.1%
   (MSTR)**. This is why AAPL's row is flagged degenerate rather than merely noisy, and it is a caution on
   SPY (21.2%) too; PLTR, TSLA and MSTR (61–83%) are the rows the identity describes best.
