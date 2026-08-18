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

**At the resolved notionals the bill stops being second-order on the index bracket.** 1.58 pp is more than
half of QQQ's 2.96 pp geometry bar and ~38% of SPY's 4.19 pp; including it, QQQ's break-even is **54.54%**,
not the 53.51% the £1,000 illustration gives. On the single-stock bracket it stays small — 0.75 pp against
bars of 1.29 (PLTR) to 7.16 (MSTR) — because the wider bracket and the larger `E_net` magnitudes both
dominate it. **The unqualified claim that the bill is second-order holds only at the £1,000-notional
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
notional D5 resolves to (£250 single-stock, £350 index) rather than at the £1,000 illustration. This is the replacement for the withdrawn *"catalyst days must deliver ≥ 0.312%/trade against the
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
   round trip (0.18% / 0.41%), both of which rest on a single quote until
   [#666](https://github.com/dd-jp/samurai-trading-system/issues/666) measures them.
   [`53-intraday-cost-calibration.md`](53-intraday-cost-calibration.md) calibrates the *backtest* cost model
   at 1-minute resolution on a US-equity proxy; it does not supply an LSE ETP round trip either, so it
   narrows nothing here.
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
