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

## Closed — 11

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
