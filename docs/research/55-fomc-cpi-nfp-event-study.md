# FOMC/CPI/NFP event-study: partial run, and a structural finding that changes the trial

**Measured 2026-08-26 for [#915](https://github.com/dd-jp/samurai-trading-system/issues/915), the event-study [#655](https://github.com/dd-jp/samurai-trading-system/issues/655)'s resolution declared.** Script: [`55-fomc-cpi-nfp-event-study.py`](55-fomc-cpi-nfp-event-study.py).

## Headline

**The FOMC arm of the declared trial cannot be measured — not from lack of power, but because this system's exit rule structurally excludes it.** The neutral bracket flattens at ~11:25–12:25 ET (the 16:25 London flatten, ADR-0018 D3). The FOMC statement releases at 14:00 ET. On **every one of the 84 scheduled FOMC decisions from 2016-01-27 to 2026-07-29**, the release lands after the position is already flat. `p_catalyst` for FOMC is undefined, not merely underpowered: there is no session in the sample where this system's bracket is open when an FOMC decision lands.

**CPI and NFP could not be run this pass.** Both release at 08:30 ET, before the open — unlike FOMC, they *would* fall inside the exposure window if their dates were available. But bls.gov, alfred.stlouisfed.org, and fred.stlouisfed.org all returned HTTP 403 to the available fetch tool on every path tried (schedule pages, archived-release pages, and the ALFRED/FRED release-dates download endpoints). No FRED/BLS API key is provisioned in this environment — doc 21's proposed calendar-spine ingestion (`docs/research/21-mi-ingestion-architecture.md`) was specced and never built, which is exactly the gap that bit this ticket. Per #915's own instruction ("do not fabricate dates … reduce the sample window"), CPI/NFP dates were not compiled from training recall.

**This is not the declared trial.** #655 declared FOMC/CPI/NFP pooled as one family statistic. This run delivers one of three members, and that member turns out to be structurally inert. The pooled statistic #658/ADR-0016 need still does not exist.

## What was measured

- **Data:** Alpaca SIP, 5-minute bars, SPY and QQQ (the pool's only two index-subclass underlyings — see "Correction to #915's declaration" below), 2016-01-04 through 2026-08-14. 490,111 SPY bars, 474,736 QQQ bars.
- **FOMC dates:** all 84 regularly scheduled meeting decision days, 2016–2026, from federalreserve.gov's own historical calendar pages (primary source, not blocked). The 2020 emergency actions (unscheduled cuts, notation votes) are excluded for consistency with every other year's "scheduled meeting" population.
- **Bracket:** ADR-0018 D3's frozen neutral single bracket, index subclass — TP +2.00% / SL −2.16%, 3× leverage, 0.18% round-trip cost, entry at 09:30 ET open, exit at the first of TP/SL/flatten.
- **Statistic:** win rate (TP hit before SL) as the accuracy proxy `p`, matching the `50% + bar` framing ADR-0016's 2026-08-18 amendment and doc 54 use for this bracket.

## The exposure-window check

Original earnings-study convention (`18-threshold-study.py`'s `classify()`/`reaction_dates()`) uses the full 09:30–16:00 session as the exposure window and treats an intraday release as contaminating that session, pushing "reaction" to the next day. That convention is wrong for this system: the actual exposure window is 09:30 to the London flatten, not 09:30 to close. Re-run with the correct window boundary:

| release timing vs. this system's exposure window | FOMC (84 events) |
| --- | --- |
| before open (`< 09:30 ET`) — full-session exposure | 0 |
| inside window (`09:30 ET` to flatten) — contaminates, excluded | 0 |
| **after flatten (`14:00 ET` > flatten)** — **no exposure at all** | **84** |

Every FOMC event falls in the third row, on both names, across all 10 years. `flatten_at()` sits between 11:25 and 12:25 ET depending on the week's London/NY DST alignment; FOMC's 14:00 ET release is never close.

**A placebo check, not the declared statistic:** treating the FOMC calendar day itself as a naive "catalyst day" label (ignoring that there's no true exposure), the pooled SPY+QQQ win rate on FOMC days is **40.7%** (n=167) against **52.5%** on all days (n=5,336) — delta −11.8pp, naive t = −3.05. This is a real, separately interesting finding (FOMC-morning sessions are more range-bound / less likely to hit a directional TP than an average morning, plausibly pre-announcement positioning caution), but it is **not** an answer to "does directional accuracy improve on catalyst days" — the bracket that measures it closes hours before the catalyst it's supposedly reacting to. Flag for a future ticket if pre-announcement morning behavior becomes its own question; it isn't this one.

## Detectability floor, recomputed as #915 required

#915's body correctly flagged that the Earnings study's ~0.63%-at-2-SE floor doesn't transfer to a market-wide family — FOMC/CPI/NFP move every index name on the same day, so the pooling unit is the event-day, not the name-event, and cross-sectional correlation has to be measured, not assumed away.

Measured: **ρ(SPY, QQQ same-session return) = 0.883** across 2,667 common sessions. Under equal-correlation pooling of two series, `Var(mean of 2) = (1+ρ)/2 × Var(single)`, so the effective independent-N multiplier from pooling SPY and QQQ is **2/(1+ρ) = 1.062×** — not the 2.0× a naive independent-N formula would assume. **Pooling the index subclass's two names buys almost no extra power over measuring one name alone.** This would have been the binding constraint on CPI/NFP power too, had those events been available to test.

## Correction to #915's declaration

#915's body describes pooling "across the pool's 7 distinct `screening_instrument` values" while also declaring "index only." Those two statements conflict. The 7-underlying figure is doc 52's original ADR-0018 study pool (SPY, QQQ index; TSLA, NVDA, AAPL, MSTR, PLTR single-stock) — of which only **SPY and QQQ are index subclass**. The 26-underlying figure in `lse-etp-pool.ts` is the current live-trading pool (post-#813), not the ADR-0018 study pool, and doesn't have a clean index/single-stock breakdown checked here. This run pools SPY+QQQ only, consistent with "index only." The ρ = 0.883 result above is exactly why this correction matters: an index-only trial has at most 2 names to pool in the study-pool frame, and they're nearly collinear.

## What this means for #658 and ADR-0016

1. **FOMC is not a usable member of the declared trial under the current exit rule.** This isn't a power problem a bigger sample fixes — it's structural, and it holds for as long as the flatten stays where D3 put it. If FOMC-reaction is something worth trading on, it requires either a later flatten (which ADR-0018 D3/#708's ladder rider already closed off — see ADR-0018's tranche-ladder withdrawal) or accepting FOMC is permanently out of reach for this system's intraday shape.
2. **CPI and NFP remain live candidates** — both release before the open, so both would fall inside the exposure window if their dates were available. This ticket did not get to test them; a follow-up needs either a FRED API key (free, per doc 21) or a human to compile the dates by hand.
3. **The declared trial (#655) may need revisiting**, not just re-running. If FOMC can never be measured, "FOMC/CPI/NFP pooled as one family statistic" is really "CPI/NFP pooled, FOMC void" — a different, narrower trial than what David declared. That's a decision for #658's grilling, not this ticket to make unilaterally.

## Limitations

- FOMC dates: primary-sourced, high confidence (federalreserve.gov, all 84 events, cross-checked year-by-year).
- CPI/NFP dates: not compiled. Tooling in this environment could not reach bls.gov, alfred.stlouisfed.org, or fred.stlouisfed.org (403 on every path). This is an environment/access gap, not a data-does-not-exist gap.
- The placebo FOMC-day delta (−11.8pp) is reported for the record and future reference, not as a validated finding — it wasn't a hypothesis declared in advance, and no adversarial check was run on it.
- Full sample (2016–2026, not split in/out-of-sample) was used throughout, since the bracket is ADR-0018's frozen declared constant, not fit on this data — nothing here is selected on.
- Break-even-bar sweep across [#886](https://github.com/dd-jp/samurai-trading-system/issues/886)'s disputed notionals was not produced: there is no `p_catalyst` to sweep for FOMC, and CPI/NFP never ran. #886 is still open regardless.
