# Papers With Backtest — replication prior, strategy-table critique, and ORB

**Status:** RESEARCHED 2026-09-19 — verification only, measures nothing. Complements
[`56-awesome-systematic-trading-compatibility-grill.md`](56-awesome-systematic-trading-compatibility-grill.md) (the
script-level grill of the same source repo); does not re-grill its 22 scripts.

**Source repo:** [`paperswithbacktest/awesome-systematic-trading`](https://github.com/paperswithbacktest/awesome-systematic-trading)
— 14.3k stars, 1.7k forks, 172 commits, last commit 2026-09-03, 15 contributors, monthly CI link-checker flagging
dormant/archived repos inline.

**Parent:** Obsidian `paperswithbacktest-awesome-systematic-trading-analysis.md`.

**Scope.** Doc 56 read the 22 checked-in QuantConnect scripts under `static/strategies`. This doc covers what that grill
did not: (1) the replication *record* and its headline methodology, (2) the README's 12-row equities strategy table
(which is a different artifact — published papers, not the scripts), (3) the Opening Range Breakout (ORB) paper and its
replication, and (4) the data-source / risk-lib / AI-comparator entries, verified for live-ness via the GitHub API.

**Horizon note.** All verdicts below are read against the ADR-0014 product: equities-only, intraday, flat-by-close,
long-only, LSE leveraged ETPs, Saxo GIA. The no-shorting and no-Python-dependency constraints from doc 56's filter
table (rows 6 and 8) still bind here.

---

## TL;DR

Nothing here is adoptable as Samurai alpha, and the most valuable output is **the replication prior, not any code**:

- The source repo's own methodology pages state the honest prior: a genuine tradeable strategy runs a **long-run Sharpe
  of 0.4–0.8**; any **out-of-sample Sharpe above ~2 is an artefact**; and the largest post-publication haircut lands
  where turnover is highest.
- The README's equities strategy table (Sharpe 1.89 → 1.28) is the **selection-biased, gross-of-cost, in-sample tail**
  of 1,687 replications — and several of its "strategies" are not strategies at all.
- ORB (Zarattini & Aziz 2025, claimed +1,484%) replicates at **Sharpe −0.06** full-sample; the gap is explained by
  backtest artefacts (after-hours fill leak, bar resolution), not by market decay.
- The data-source / risk-lib / AI-comparator entries verify as mostly live, but **none solve a Samurai blocker**:
  pwb-toolbox is paywalled, the risk libs are Python (filter 8), and the crypto feeds are out of scope.

This **validates** Samurai's own D4 posture — express bars as pre-declared pp-of-accuracy, measure out-of-sample, treat
published Sharpe as a hypothesis, not a fact — and does not re-open any doc-56 verdict.

---

## 1. The replication record — the only transferable asset

The source repo claims to have coded and run **4,843 published papers over their own full history**. Its own stated
aggregate (README, verified against `paperswithbacktest.com/wiki`):

| Statistic | Value |
|---|---|
| Median replication Sharpe | **0.37** |
| Fraction clearing t = 1.96 | **48%** (half the published record is indistinguishable from zero on its own sample) |
| Median test window | 34 years |
| Median beta to S&P 500 | **+0.17** |
| Median information ratio after de-beta | **0.21** |
| Post-publication decay | **none measurable**, once the market period is controlled for |

**Reading for Samurai.** The published strategy literature is mostly noise: the median "edge" is a Sharpe 0.37, and a
meaningful slice of even that is index beta rather than skill. This is the external, corpus-wide version of what Samurai's
own pre-registered measurements already found at the single-signal level (doc 51's underpowered rejection, doc 57's
wrong-sign spread). It does not change any existing verdict; it lowers the prior on *any* published strategy's effect size.

**The PWB wiki's own discipline pages** (`how-to-backtest-a-trading-strategy`) state the prior that survives contact with
the catalogue:

- "A genuine, diversified, tradeable strategy with a long-run Sharpe between **0.4 and 0.8** is a good outcome."
- "Any out-of-sample Sharpe above roughly 2 in a corpus like this is an artefact."
- "Treat any backtest promising a Sharpe above 2 as a description of the in-sample period rather than a forecast."
- "Expect a haircut, expect it to be largest where turnover is highest."
- "Cross-sectional momentum lost roughly 40% of its in-sample Sharpe" out of sample.

These are the source's *own* words undercutting its headline table. Samurai already encodes the same rule in its own
terms (ADR-0018 D3/D4: pp-of-directional-accuracy bars, restated 2026-09-14 by #1548 for Saxo's 16 bps round trip).

---

## 2. The strategy table is selection-biased, and several "strategies" are not

The README's "Strategies" section shows **61 of 1,687 replications**, chosen as "the strongest … that clear a t-statistic
of 1.96 over at least 10 years, up to 12 per asset class." Four methodological caveats are stated in its own footnote and
are load-bearing:

1. **Selection bias.** It shows the survivors of the whole catalogue, not a representative sample.
2. **Gross of trading costs.** The haircut is largest for high-turnover strategies — precisely the small-cap and momentum
   names at the *top* of the equities list.
3. **Own-window, not common calendar.** "Sharpe ratios are measured on each strategy's own active window," so rows are
   not comparable with one another.
4. **In-sample.** Publication-to-today windows for recent papers are only months long — noise.

The 12 equities rows were checked against their primary sources. They fall into three groups, and **none is a Samurai-shape
alpha source**:

**A — Academic factor papers (7):** the size effect (*Differences Between Large and Small Companies in Europe*), the
q-factor investment factor (*The Investment CAPM*, Hou–Xue–Zhang 2015), beta/size, value+size (*"Now You See It, Now You
Don't"* — the title admits instability), momentum, and frontier-market cross-sections. Long-only, yearly-rebalanced,
cross-sectional factor tilts. This is the same family doc 56 already read at script level and, bar the two momentum
sign-gates and the low-vol quantile gate, ruled DOA on filters 1/2/6.

**B — Portfolio-construction / sizing techniques (3), not strategies:** *Properties of the Most Diversified Portfolio*
(Choueifaty diversification ratio / MDP), *Kelly's Criterion* (position sizing), and *Covariance Cleaning with NNs*
(optimization). These are weighting/sizing tools, not entry signals, and have no per-trade directional-accuracy content.

**C — Not a strategy at all (1), the smoking gun:** *Important Characteristics, Weaknesses and Errors in German Equity
Data from Thomson* (Brückner 2013) is a **data-quality critique** ("we cannot recommend Datastream as the primary data
source before 1990"). PWB coded it as `GermanSizeEffectDatastreamCaveatsStrategy`, reports Sharpe 1.69, and its
"current positions" page now lists **US tickers** (AES, AMAT, AMD, AMP, APA, AXON, AZO, BAX …) for a "German size effect"
strategy. **Paper ≠ backtest, demonstrated on the source's own page.**

**Interaction with doc 56.** None of this re-grills the 22 scripts; it criticises the *catalogue's* headline table and
methodology. The only admissible candidates remain doc 56's four "viable-with-modification" survivors, and this doc's
replication-prior finding *lowers* confidence in their source-reported effect sizes (which doc 56 already scored
"low" to "medium-low"). No Stage 2 submission is authorised here, as in doc 56.

---

## 3. ORB — replication fails, and it is the wrong fit anyway

Opening Range Breakout: take the high/low of the first N minutes, long on a break above, short below, flat by close. The
most-cited recent paper is Zarattini, Barbon & Aziz (2024, SSRN 4729284) and Zarattini & Aziz (2025, *"Can Day Trading
Really Be Profitable?"*). Claimed: **+1,484% (2016–23)** vs QQQ's +169%, and a Sharpe-2.4 QuantConnect variant.

**The replication does not reproduce the claim** (paperswithbacktest.com, plus independent community re-runs):

| Measure | Value | Source |
|---|---|---|
| Paper headline | +1,484% (2016–23) | Zarattini & Aziz 2025 |
| QuantConnect variant | Sharpe 2.4 | Zarattini et al. 2024 |
| Full-sample replication | **Sharpe −0.06** (2010–26) | PWB |
| In-sample (paper's own window) | 0.16 — noise | PWB |
| Post-publication | −0.84 (11 months — too short to lean on) | PWB |
| Independent re-run (2016) | **−0.189** | QuantConnect community |
| Live paper, 6 months | **−50%, shut down** | IBKR paper trader |

PWB's defensible conclusion: *"the replication does not reproduce the paper's headline claim."*

**Why the gap — the artefacts, not decay.** Independent practitioners identified the mechanisms inflating the backtest:

1. **After-hours fill leak.** Stop buy/sell orders "feed through to after hours" — thin AH price action triggers false
   fills and lets winners run into extended hours. "Strip that out and the true intraday-only performance is much more
   marginal." This is the same class doc 14's backtest-pitfalls warnings target.
2. **Bar resolution.** Minute vs second resolution changes results dramatically — stops fill inside the same minute at
   the volatile open.
3. **Parameter fragility.** 5-/15-/1-minute ranges and universe size 500→2000 each move the Sharpe; if viability depends
   on the chosen N, it is a fitted artefact.
4. **Win rate 17%** — long left tail, spread-heavy. The paper leans on **TQQQ (3× leveraged)** to "work around leverage
   limits," a flag that raw returns are thin.

**Samurai fit — horizon-aligned, everything else fails.** ORB is intraday flat-by-close, so it is *not* the multi-month
factor shape doc 56 killed. But it fails on every other axis that matters:

- **Universe** (filter 3): US single stocks / QQQ via TQQQ, needs a 1000+ name universe and shorting; Samurai is
  long-only LSE leveraged ETPs over ~5 tradeable rows (doc 59).
- **Data** (filter 4): needs second-resolution intraday with real spread; Samurai's LSE intraday history is the doc-44
  surface, and spread is the binding scarcity.
- **Debate-as-edge**: ORB is a mechanical 3-line rule. There is no thesis for Analysts→Debate to contribute; it would
  bypass the entire pipeline Samurai's edge is built on.
- **Trial discipline** (filter 2): the winning variant is chosen *by search* over the range length and universe — the
  exact fitted-axis move ADR-0018 D4 forbids.

**Verdict: build nothing.** ORB is recorded here as a case study — a spectacular in-sample headline that collapses on
honest replication through fill-leak and resolution artefacts — not as a candidate. Its value is that it independently
confirms the prior in §1 and the discipline Samurai already applies in docs 51/57.

---

## 4. Data sources / risk libs / AI comparators (supplementary, cross-band)

Verified for live-ness via the GitHub API (stars, `pushed_at`, `archived`) on 2026-09-19. None solves a Samurai blocker.

### Data sources

| Repo | Stars | Status | Samurai read |
|---|---|---|---|
| OpenBB (renamed from OpenBBTerminal) | 73k | active | research platform; no LSE-intraday solve |
| Fincept Terminal | 32k | active | CLI research; same |
| yfinance | 25k | active | unofficial Yahoo scraper; already known-fragile (doc 31/34) |
| AkShare | 23k | active | China-only |
| FinanceDatabase | 9.1k | active | 300k-symbol reference; marginal (universe is doc 59's crisis, not symbol lookup) |
| FinanceToolkit | 5.4k | active | fundamentals via FMP/Yahoo |
| edgartools | 2.7k | active | SEC EDGAR, US-only |
| findatapy | 2.1k | 2mo stale | multi-vendor unified |
| **pwb-toolbox** | **77** | active | **owner's own; downloads gated behind $50/mo — paywalled, skip** |
| cryptofeed | 2.9k | active | crypto websocket feed — **out of scope** (ADR-0015 drops crypto) |
| Crypto Lake | 76 | ~10mo stale | effectively dormant |

The free 5y-equity-OHLCV question (doc 31 / map #482) is **not** advanced by this list; the sources already under review
there remain the ones that matter.

### Risk / analytics libs

| Repo | Stars | Status | Samurai read |
|---|---|---|---|
| quantstats | 7.6k | active | Python — filter 8, reference only |
| skfolio | 2.4k | active (today) | Python, sklearn-style portfolio opt — reference only |
| Riskfolio-Lib | 4.5k | active | Python — reference only |
| PyPortfolioOpt | 6.0k | active | Python — reference only |
| pyfolio | 6.4k | **dormant (Dec 2023)** | dead; the ecosystem's own replacement is quantstats |

**Correction to the pre-consolidation chat read:** "adopt quantstats for reporting" was wrong for Samurai — the system is
TypeScript (ADR-0001) and doc 56's filter 8 forbids a hard Python dependency. At most these are pattern references if a
portfolio-level reporting layer is ever built natively; none is a dependency, and Samurai's Risk gate is a deterministic
veto, not portfolio construction.

### AI-trading comparators

| Repo | Stars | Status | Read |
|---|---|---|---|
| ai-hedge-fund (virattt) | 63.5k | active | LLM investor-team + debate + backtest simulator; **educational**, no independent risk veto, no per-analyst feedback |
| QLib (microsoft) | 48.7k | active | ML research platform, not LLM-agent — skip |
| FinRL (AI4Finance) | 16.3k | active | reinforcement learning, not debate — skip |
| intelligent-trading-bot (asavinov) | 1.9k | active | ML feature signals — skip |
| prism-insight (dragon1086) | 766 | active (today) | 13 specialized agents + KIS broker — structurally closest multi-analyst |
| tradesight (rmbell09-lang) | 170 | 2mo stale | RSI/MACD + Alpaca paper — small |

**Samurai's two differentiators remain unclaimed** by every comparator: (1) the deterministic Risk veto independent of the
debate outcome, and (2) the per-analyst Feedback loop with outcome attribution. ai-hedge-fund and prism-insight are
prior-art to track for debate-prompt structure only; nothing here is a build dependency.

---

## 5. Verdict — what Samurai takes

1. **Adopt nothing as alpha.** Doc 56's four "viable-with-modification" survivors remain the only admissible candidates,
   and this doc's replication-prior finding lowers confidence in their source-reported effect sizes further.
2. **Adopt the prior, not the code.** Genuine tradeable Sharpe 0.4–0.8; out-of-sample Sharpe >2 = in-sample artefact;
   largest haircut where turnover is highest. This is the corpus-wide confirmation of Samurai's D4 posture, not a new rule.
3. **ORB is recorded as a rejection case study**, not a candidate — horizon-aligned but mechanical, US-universe,
   short-dependent, and non-reproducing.
4. **No vendor/lib/comparator adoption.** pwb-toolbox is paywalled; the risk libs are Python (filter 8); crypto feeds are
   out of scope; the AI comparators validate rather than threaten Samurai's differentiators.

No Stage 2 submission, no paper/live trade, no porting is authorised by this doc.
