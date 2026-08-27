# awesome-systematic-trading strategy compatibility grill

**Ticket:** [Grill: awesome-systematic-trading strategies for Samurai compatibility (#720)](https://github.com/dd-jp/samurai-trading-system/issues/720), child of map [Wayfinder: awesome-systematic-trading strategies as candidate strategy research feed (#719)](https://github.com/dd-jp/samurai-trading-system/issues/719).

**Repo under review:** [`paperswithbacktest/awesome-systematic-trading`](https://github.com/paperswithbacktest/awesome-systematic-trading/tree/main/static/strategies) — 22 scripts read in full (all files named across the ticket's 8 clusters, including `pairs-trading-with-stocks`, which turned out to be a single extensionless file, not a directory as the ticket assumed).

**Scope correction on the way in.** The ticket's body (2026-08-18) states the checked-in pool is 11 `lse_ticker` rows over 7 `screening_instrument` values, 5 of them US single stocks. `server/providers/universe-pool/lse-etp-pool.ts` grew again on 2026-08-19 (#813): it is now **30 rows over 26 distinct `screening_instrument` values, 20 of which are US single stocks** (AAPL, AMD, AMZN, ARM, BABA, COIN, GOOG, META, MRNA, MSFT, MSTR, NFLX, NIO, NVDA×2, PLTR×2, PYPL, RACE, TSLA, UBER) against 6 index/sector/country trackers (SPY×2, QQQ×2, EWY, KWEB, VT, XLE). Single-stock screening is now the dominant case, not a minority one — this makes filter 3's "US single stocks are explicitly in scope" the load-bearing clause of the whole grill, not a footnote.

## Filter table (as specified on #720, unchanged)

1. Signal computable intraday/EOD — no weekly/monthly rebalance
2. **Trial discipline** — admissible only as a hard eligibility gate with the cut declared in advance; a ranked axis or fitted weight is not (ADR-0018 D4)
3. **Universe** — DOA on universe only if it needs an instrument with no LSE ETP/ETC wrapper. US single stocks and major index/sector ETFs are explicitly in scope
4. **Data** — DOA if it needs LSE-native intraday history; fine if computed on the US underlying and read across
5. **Scale** — scale-free indicators (RSI, %B, %K, ADX, rank) read across near-identically to a 3× wrapper; scale-dependent ones (ATR%, bandwidth) must be rescaled ×3
6. No shorting or long-short portfolios (T212 ISA)
7. No corporate fundamentals Samurai cannot source at low latency
8. TypeScript/Node implementable, no hard Python runtime dependency
9. Crypto is out of scope permanently
10. **Cost** — any "viable" verdict states a required-edge number in **percentage points (pp)** of directional accuracy over a coin flip, never a Sharpe. Per ADR-0018 Decision 3: **+3.35 pp** for the 3× single-stock subclass (+6.00% TP / −6.25% stop), **+4.33 pp** for the 3× index subclass (+2.00% TP / −2.16% stop).

Row 3's wording question (whether "no commodities outright" excludes commodity ETCs) was resolved live on the ticket 2026-08-27: it means futures/spot, not the ETC wrapper — commodity ETCs stay in scope, evaluated below in family 8.

---

## Family 1 — Time-series / cross-sectional momentum

| Script | Verdict | Deciding filter(s) |
|---|---|---|
| `momentum-factor-effect-in-stocks.py` | DOA as coded / **viable with modification** as a sign-gate | 2, 6 |
| `consistent-momentum-strategy.py` | DOA | 1, 2, 6 |
| `trend-following-effect-in-stocks.py` | **Viable with modification** | 1 (horizon reinterpretation), 5 (scale) |

**`momentum-factor-effect-in-stocks.py`.** As coded: 252-day return, quintile long/short, equal-weighted both legs — dead on filter 2 (cross-sectional rank driving both eligibility and construction) and filter 6 (explicit short leg). Note: the script's docstring claims a 12-1 skip-month convention; the code computes the full 252-day return with no skip — a docstring/implementation mismatch, flagged for anyone citing the original paper's numbers against this code. **Modification:** collapse to a binary sign gate — trailing-N-day return (optionally skip-month) > 0 ⇒ long-eligible, else flat; drop the short leg and the quintile sort. This is a declared-in-advance threshold at zero, not a rank.
- Stage 2 readiness: needs reimplementation (rank/weight machinery fully stripped).
- Confidence: high (mechanism), high (universe — single stock, in scope).
- Required edge: **+3.35 pp** (single-stock subclass). Momentum's academic effect is measured as a cross-sectional monthly-holding spread, not per-trade directional accuracy — plausible the sign has a same-direction intraday edge, but this is a genuine extrapolation, not a measured transfer. **Effect-size confidence: low.**

**`consistent-momentum-strategy.py`.** Double-decile intersection across two overlapping 6-7 month formation windows, 6-month hold. DOA on filter 1 (structurally a multi-month hold, no intraday analog for "consistency across two windows") independent of filter 2/6. A sign-gate collapse degenerates to plain 7-month momentum, duplicating the script above at more complexity — not carried forward separately.

**`trend-following-effect-in-stocks.py`.** Entry: today's close ≥ all-time high (a genuinely clean per-stock binary gate, no cross-sectional rank at all — the strongest filter-2 pass in the whole review). Exit: 10-period ATR trailing stop. Filter 6 clean (long-only). **Filter 1 is the real problem**: the paper's measured edge accrues over the multi-week follow-through after breakout, not on the breakout day itself; flattening by close tests a different, unmeasured hypothesis ("does a new-high day have same-day drift?"). **Filter 5**: raw-dollar ATR is scale-dependent and must be rescaled ×3 (or recomputed as ATR% on the underlying) before use on the wrapper — cannot reuse the underlying's raw ATR dollar value directly.
- Stage 2 readiness: entry gate is already Stage-2-shaped; exit must be replaced entirely with ADR-0018's neutral bracket, which changes what's being measured versus the paper.
- Confidence: medium-high (mechanism), high (universe).
- Required edge: **+3.35 pp**. No Sharpe/CAGR given in-script; multi-week breakout/trend literature nets modest Sharpes after cost, and there is no precedent at all for a same-day-only slice. **Judged unlikely to clear the bar; effect-size confidence: low.**

---

## Family 2 — 52-week high / 12-month cycle

| Script | Verdict | Deciding filter(s) |
|---|---|---|
| `52-weeks-high-effect-in-stocks.py` | DOA | 1, 2, 6 |
| `12-month-cycle-in-cross-section-of-stocks-returns.py` | DOA | 1, 2 |

**`52-weeks-high-effect-in-stocks.py`** is not the single-stock George-Hwang effect the ticket's family description implied — it's an **industry-rotation** variant (20 Morningstar industry groups ranked on average proximity-to-high, top-6 long / bottom-6 short, 3-month tranched hold). No single-gate collapse preserves the industry-relative-ranking mechanism; a market-cap classification dependency (filter 7-adjacent) is also present but moot given 1/2/6 already kill it. **Flagged, not scored:** the individual-stock proximity-to-52-week-high signal (a different script than what's in this repo) could plausibly collapse to a declared gate ("price ≥ 95% of 252-day high") — worth its own research pass if this family is revisited, but out of scope here since this script doesn't implement it.

**`12-month-cycle-in-cross-section-of-stocks-returns.py`** — same-calendar-month-last-year seasonal signal, decile sort, value-weighted, monthly rebalance. DOA on filter 1: a same-month-last-year effect has no meaningful shorter-window analog (recomputing it intraday tests a different, unstated claim), independent of filter 2's decile rank-and-weight kill.

**Family 2: both DOA. No survivors.**

---

## Family 3 — Value factors

| Script | Verdict | Deciding filter(s) |
|---|---|---|
| `value-book-to-market-factor.py` | DOA | 1, 2, 6, 7 |
| `value-factor-effect-within-countries.py` | DOA | 1, 3, 7 |
| `small-capitalization-stocks-premium-anomaly.py` | DOA | 2, 3, 6 |

All three DOA, independently overdetermined — fundamentals dependency (filter 7: book value, CAPE), slow cadence (filter 1: book value/CAPE update quarterly-to-annually at best), and rank-and-weight construction (filter 2) stack on top of each other, so no modification effort rescues any of them.

Two findings worth recording alongside the verdict:
- **`value-book-to-market-factor.py`'s `Selection()` logic actually fires annually, not monthly** as its own comment claims (`self.month == 12` gates a counter that increments once per `MonthEnd` call, wrapping 1→12) — the same bug appears in `small-capitalization-stocks-premium-anomaly.py`. Reinforces the horizon kill; doesn't change it.
- **`small-capitalization-stocks-premium-anomaly.py` is DOA on universe for a structural reason, not just a data-availability one.** The SMB premium's economic story is about small/micro-cap, illiquid names; Samurai's checked-in pool is, by construction, mega-cap liquid names that support a leveraged wrapper at all. None of Samurai's tradable underlyings would ever land in this factor's "small" decile — they sit in its *short* leg, a different and much weaker proposition than the long leg the paper measures. There is no universe on which this signal is coherent for Samurai.

---

## Family 4 — Low-vol / anomaly overlays

| Script | Verdict | Deciding filter(s) |
|---|---|---|
| `low-volatility-factor-effect-in-stocks.py` | **Viable with modification** | none on construction; effect-size doubt only |
| `volatility-risk-premium-effect.py` | DOA (structural) | 3, 8 — no options capability, no directional mechanism |
| `short-term-reversal-in-stocks.py` | **Viable with modification** | none on construction; effect-size doubt only |

**`low-volatility-factor-effect-in-stocks.py`.** Bottom-quartile-by-trailing-volatility, long-only, equal-weighted — this is the cleanest filter-2 pass in the review: a declared quantile screen used purely for eligibility, flat sizing among eligible names, exactly the shape filter 2 calls out as admissible. Filter 6 clean (long-only). Note: docstring claims a 3-year vol window; the code uses 252 trading days (~1 year) — another docstring/code mismatch. Filter 5: vol is scale-dependent but used only for cross-sectional rank on the (unlevered) underlying series, so the leverage-scaling risk is low if computed consistently.
- Stage 2 readiness: already essentially gate-shaped; lookback window needs justifying/shortening for the intraday horizon.
- Confidence: high (mechanism), high (universe).
- Required edge: **+3.35 pp**. The low-vol anomaly's academic edge is a portfolio-construction effect (better risk-adjusted compounding over years via smaller drawdowns), not a per-trade directional signal — translating that into +3.35 pp of same-day directional accuracy is a large stretch. **Effect-size confidence: low.**

**`volatility-risk-premium-effect.py`** sells a monthly ATM SPX straddle + buys an OTM tail put — an options-selling carry strategy, not a directional stock signal. DOA structurally: no LSE-wrapper equivalent of selling a straddle exists, a T212 ISA cannot trade options at all, and the strategy has no "directional accuracy edge" to state in the first place (filter 10 doesn't apply — it's not comparable on that basis).

**`short-term-reversal-in-stocks.py`.** Top-100-mega-cap universe, long lowest-prior-week-return decile / short highest-prior-month-return decile, weekly reformation. Filter 2: restates cleanly as a declared percentile screen with flat weighting. Filter 6: drop the short leg (rubric's blanket no-shorting rule; the long-side "buy recent losers" gate survives alone). **Filter 1 is the strongest horizon fit found anywhere in this grill** — the paper's own construction is already weekly, and short-term reversal is documented in the literature down to daily/intraday microstructure horizons, so recomputing this at 1h-debate-bar granularity is a direct extrapolation of the paper's own mechanism, not a reach. Universe (top-100 mega-cap) matches Samurai's pool directly.
- Stage 2 readiness: needs the short leg dropped and the window shortened; core mechanism is already close to admissible shape.
- Confidence: high (mechanism), high (universe).
- Required edge: **+3.35 pp**. Important caveat: the academic short-term-reversal literature (Jegadeesh 1990, Lehmann 1990, and successors) finds the effect concentrated in small/illiquid names and largely evaporates or reverses in large-cap liquid stocks under realistic costs — usually read as compensation for liquidity provision, not free alpha. Samurai's tradable universe is, by construction, exactly the large-cap liquid segment where this literature says the effect is weakest. **This is the cleanest filter-table pass in the whole review, but the qualitative read is marginal-to-doubtful on effect size. Effect-size confidence: medium-low.**

---

## Family 5 — Pairs / dispersion

| Script | Verdict | Deciding filter(s) |
|---|---|---|
| `pairs-trading-with-stocks` | DOA | 5, 2 |
| `pairs-trading-with-country-etfs.py` | DOA | 5, 2 |
| `dispersion-trading.py` | DOA | 5 (+ no options capability) |

**Correction to the ticket's premise:** `pairs-trading-with-stocks` is a single extensionless file (one `QCAlgorithm` class), not a directory as the ticket's family description assumed.

All three DOA on filter 5 (T212 ISA — no shorting) independent of anything else: distance-metric pair selection is inherently simultaneous long-one/short-the-other, and dispersion trading is inherently long-stock-vol/short-index-vol. `dispersion-trading.py` is doubly DOA: Samurai has no options execution capability, so even setting filter 5 aside, an options overlay isn't expressible on this stack at all. The distance-ranking construction (filter 2) is an independent kill on the first two even before filter 5 is applied.

**Answer to the ticket's question:** the T212 ISA venue constraint kills all three outright. Whether pair correlation/hedge-ratio stability holds up across a 3× leveraged wrapper is not a coherent follow-on question — it's moot once the strategy is dead on shorting.

---

## Family 6 — Calendar / seasonality

| Script | Verdict | Deciding filter(s) |
|---|---|---|
| `january-barometer.py` | DOA | 1 |
| `turn-of-the-month-in-equity-indexes.py` | DOA as written | overnight-carry horizon (filter 8 blocks any reformation) |
| `option-expiration-week-effect.py` | DOA as written | overnight-carry horizon (filter 8 blocks any reformation) |

A calendar cut is naturally filter-2-clean (declared in advance), which the ticket anticipated — but all three fail on a different axis: **the measured effect in every case accrues from a multi-session overnight-carry hold, which ADR-0014's flat-by-close horizon flatly prohibits.**

**`january-barometer.py`**: unconditional January entry, then an ~11-month hold gated by January's sign. DOA on filter 1 alone — the thesis is explicitly about 11-month persistence, no intraday analog exists.

**`turn-of-the-month-in-equity-indexes.py`** and **`option-expiration-week-effect.py`**: both satisfy filter 1's literal wording (a calendar date is trivially computable every session), but their entire measured edge is built from a 3-5 session hold spanning multiple overnights. A flat-by-close reformation ("open→close on each qualifying day, independent sessions, calendar gate declared in advance") is filter-2/3/4/6/7-clean — but neither script, nor the literature they cite, provides any evidence for what the same-session-only slice of turn-of-month or opex-week drift looks like in isolation. **DOA as written; a reformed version would be an unmeasured, freshly-backtested strategy, not a reuse of either script.**

---

## Family 7 — FX carry / cross-asset

| Script | Verdict | Deciding filter(s) |
|---|---|---|
| `fx-carry-trade.py` | DOA | 3, 5, 1 |
| `currency-momentum-factor.py` | DOA | 3, 5, 1, 2 |
| `asset-class-momentum-rotational-system.py` | DOA | 1, 2, 3 |

**`fx-carry-trade.py`** and **`currency-momentum-factor.py`**: both trade FX-currency futures crosses directly. Confirmed as anticipated — **no LSE-listed leveraged ETP/ETC wrapper exists in Samurai's declared universe for any FX currency cross**, so filter 3 kills both outright; each is independently dead on filter 5 (explicit long-top-3/short-bottom-3 book) and filter 1 (carry is a rate-differential accrual return, not a same-day price signal — doesn't reduce to intraday). `currency-momentum-factor.py` also independently fails filter 2 (12-month ROC ranking drives sizing).

**`asset-class-momentum-rotational-system.py`** is *not* fundamentally an FX/rates strategy — it rotates across 5 US-listed ETFs (SPY/EFA/IEF/VNQ/GSG: equities/intl-equities/bonds/REITs/commodities), long-only, no shorting. But it's still DOA on three independent grounds: filter 1 (monthly rebalance on 12-month trailing momentum, structurally slow), filter 2 (ranked-axis selection driving equal-weight sizing), and filter 3 (only SPY, of the 5 legs, has an in-scope wrapper — EFA/IEF/VNQ/GSG don't). No clean separable single-instrument version exists: the ranking needs all 5 legs' momentum every month just to determine whether SPY is even in the top 3.

---

## Family 8 — Commodity term structure / WTI-Brent spread

| Script | Verdict | Deciding filter(s) |
|---|---|---|
| `term-structure-effect-in-commodities.py` | DOA | 5, 2, 3 (+ 1 on the only constructible reformation) |
| `trading-wti-brent-spread.py` | DOA | 5 |

Per the ticket's resolved wording question, commodity ETCs stay in scope, so neither script is DOA on universe grounds alone the way an FX pair is.

**`trading-wti-brent-spread.py`**: 20-day-SMA mean-reversion signal on the WTI-Brent spread, both legs individually in-scope (WTI and Brent leveraged LSE ETCs both plausibly exist), and the entry rule is filter-2-clean. None of that survives filter 5 — the strategy is, by construction, always long one leg and short the other simultaneously. This is the textbook two-leg spread case filter 5 exists to exclude; there is no reformation that removes the short leg without producing a different strategy.

**`term-structure-effect-in-commodities.py`** — 21-commodity cross-section, roll-return quintile long/short, monthly rebalance. As written: DOA on filter 5 (explicit cross-sectional long-short), filter 2 (quintile rank driving sizing), and filter 3 (21-name universe is almost entirely grains/meats/metals/softs, outside Samurai's declared commodity-ETC scope; only oil-type names are in scope). **The one constructible reformation, checked explicitly per the ticket's question:** the roll-yield calculation only needs two-maturity *price data* (front/next-month), not multi-maturity *positions* — so a single-commodity (WTI ETC), long-or-flat, declared-threshold gate ("backwardation beyond X → long, else flat") is mechanically buildable and clears filters 2/3/4/5/6/7. It still fails **filter 1**: roll yield is a carry return earned by holding through the roll, structurally the same kind of return as FX carry, not a same-day directional signal — there is no basis in this script or its literature to expect an intraday directional analog. **DOA on both the as-written version and the only in-scope reformation.**

---

## Summary

22 scripts evaluated across 8 families. **4 reach "viable with modification"; 18 are dead on arrival.** No script reached an unconditional "viable" — every survivor needs its short leg (or ranked axis, or exit rule) stripped before it's admissible, and every survivor still carries an open, qualitatively-judged effect-size doubt because none of the source papers report per-trade directional accuracy, only portfolio-level Sharpe/CAGR over long-short or long-only cross-sectional constructions.

| # | Script | Verdict | Required edge | Effect-size confidence |
|---|---|---|---|---|
| 1 | `momentum-factor-effect-in-stocks.py` (as sign-gate) | Viable with modification | +3.35 pp | Low |
| 1 | `trend-following-effect-in-stocks.py` | Viable with modification | +3.35 pp | Low |
| 4 | `low-volatility-factor-effect-in-stocks.py` | Viable with modification | +3.35 pp | Low |
| 4 | `short-term-reversal-in-stocks.py` | Viable with modification | +3.35 pp | Medium-low (cleanest filter-table pass, weakest literature support in a large-cap universe) |

**Deciding-filter tally across all 18 DOA verdicts:** filter 2 (trial discipline / ranked axis) is cited on 11 of 18, confirming #719's 2026-08-16 comment that it "kills more candidates than any of the existing rows." Filter 5 (no shorting) is cited on 8 of 18 — the second-largest killer, concentrated entirely in family 5 and the cross-asset scripts of families 7-8. Filter 1 (horizon) is cited on 10 of 18, frequently stacked with filter 2 rather than standing alone.

**Stage 2 readiness.** None of the 4 survivors is Stage-2-ready as coded — each needs its ranking/weighting or short leg physically removed, and (for the two family-1 survivors) the exit rule replaced with ADR-0018's neutral bracket, which changes what's being measured relative to the source paper. None should be read as "backtested and ready"; each is "structurally admissible, not yet measured at Samurai's horizon."

**No Stage 2 submission is authorized by this ticket** — per #720's non-goals, this is a compatibility grill only. If any of the 4 survivors is carried forward, it enters ADR-0018 D4's selection budget as its own declared trial (or shares the two-pooled-pair budget per subclass), a decision this doc does not make.

---

## Non-goals (unchanged from the ticket)

- No porting to TypeScript in this doc.
- No backtests run.
- No authorization for paper or live trade.
- No crypto family evaluated.
