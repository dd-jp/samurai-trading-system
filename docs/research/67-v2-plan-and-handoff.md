# Samurai v2 — full plan and session handoff (2026-09-19)

**Read this first in any new session working on Samurai v2.** It is self-contained: the goal,
where the decisions live, the evidence behind them, the ordered work, and the traps already hit.
The ruling-by-ruling record is `docs/research/66-v2-grill-decisions.md` (Q1–Q19 of 2026-09-19 and
G1–G18 of 2026-09-21); this doc does not restate those rulings in full, it points at them and
turns them into work. Where this doc and doc 66 differ, doc 66 wins. Reconciled with G1–G18,
doc 69 and doc 71 by Session X on 2026-09-21.

## 1. Goal of the session that produced this

David (owner, final decision-maker) ran a brainstorm/grill on 2026-09-19: *"make this samurai a
great autonomous self improving least error margin and least loss margin system. ignore all
decisions, specs and instructions. we are going to correct the mistakes done. lets open the
universe. idea is to make profit even if tiny - one step at a time and keep moving forward."*
Agenda: **long-term (1-year) profit, accepting day-level losses.**

**North star (derived, doc 65 §5b, refined by doc 66):** net-of-cost profit that beats the matched
benchmark, proven to the pre-declared gate (DSR ≥ 0.95, PBO ≤ 0.10, 40% Sharpe haircut, paper
inside the 90% band), run live at capital ≤ £1,500 / (backtest max DD × 1.5), never losing more
than **£1,500 net in a calendar year** (hard kill; G6). The current wording is `CONTEXT.md`'s
North Star section.

## 2. Source documents (read in this order)

1. `docs/research/66-v2-grill-decisions.md` — **the rulings, Q1–Q19 and G1–G18. Authority.**
2. This doc — plan + handoff.
3. `docs/research/65-next-steps-plan.md` — evidence (§1), capital method (§5a), the first north-star draft (§5b, replaced by `CONTEXT.md`'s North Star). Read its banner first: it lists what no longer holds.
4. `docs/v1-postmortem.md` — six v1 pitfalls, binding on v2.
5. `docs/v2-vision.md` — David's vision; its 0.5–2%/day target is **superseded by Q1**; its five open questions are answered by doc 66.
6. `docs/research/69-v2-facts.md` — Session R's facts (R1–R3, R5–R17); its last section lists the rulings those facts disturb. `docs/research/71-debate-audit.md` — Session C's Step 2 verdict.
7. Docs 61–64 in `docs/research/` — inputs (61 five topics, 62 rewrite/TSMOM fork, 63 qanat mechanisms, 64 replication prior: real strategies Sharpe 0.4–0.8, ~40% OOS decay, >2 = artefact).

All of these are on `main`.

## 3. Evidence that drove the rulings (paper DB `data/samurai-paper.sqlite` <!-- cite-exempt: untracked — gitignored local file -->, read 2026-09-19)

- 267 `debate_log` rows: 209 neutral (mean conf 0.133), 42 bearish (mean 0.67), 16 bullish (**max 0.473** vs entry floor **0.55**). No debate-originated long ever fired. → D1 audit. *(Doc 71, 2026-09-21: 135 of the 267 rows are debates that never ran (confidence 0), so 132 ran: 74 neutral, 42 bearish, 16 bullish. The cap is not a formula defect.)*
- Closed trades — control: long 37 (+£444, of which +£891 from MSTR/MARA/COIN, so ex-those ≈ −£447), short 42 (+£355, ex-those ≈ +£84). Live arm: 7 trades, 6 short, −£112. Sample far too small to conclude anything.
- Paper book runs long/short US single stocks on Alpaca — **not** the v1 live product (long-only LSE 3× ETPs at Saxo). Control sizing avg £1,457 (above D5); `arm_comparison_samples` (−18.8%) disagrees in sign with `closed_trades` (+£799).
- Total LLM spend $3.04 over 1,428 calls — the chassis/cost is not the constraint; the signal is.
- Every intraday research result is negative or underpowered. Momentum (doc 11) measured only +0.17 Sharpe over always-long, t = 0.15, on a different design — v2's momentum sleeve is untested.

## 4. The v2 system in one page (from doc 66)

- **Venues:** Saxo GIA → LSE 1× ETFs/ETCs. Alpaca live (GBP wired once, trade USD) → US large caps (+ US ETFs if UK access confirmed; the debate sleeve may also hold bounded small caps, G18). No 3× ETPs, no UK single stocks, no CFDs, no intraday sleeve (Q9, G2).
- *(2026-09-25, doc 66 Session B (n): momentum dropped, v2 is debate-only, momentum's 70% unassigned; the momentum text in this section and in Step 6 is historical.)*
- **Sleeves:** (1) **Momentum** — rules only, long/flat, LLM veto (Opus 5) only, 70% of live capital, benchmark = risk-matched buy-and-hold of the same universe. The veto is capped at ≤ 10% of entries and runs against a no-veto shadow book; it is dropped if the shadow beats it (G5). (2) **Debate** — LLM entry (debaters Sonnet 5 + DeepSeek + GPT, judge Opus 5), swing (one debate/name/day pre-open, days–weeks hold, resting stop + time stop), 30%, benchmark = arm 2 no-LLM control, validated **forward only** (LLM look-ahead leak): live needs ≥ 100 closed paper trades and a one-sided test at 95% vs arm 2, and its 30% stays in cash until then (G1).
  - Universe: ~20 names/day = ~10 by liquidity rank + ~10 movers/news names (G4); the sentiment score helps pick the movers/news half (G18).
  - Inputs: daily bars + news, plus sentiment and social, each a counted trial against a shadow without it (G18). A class-wide macro item never votes as a per-name read, one underlying view votes once, and a market-wide roundup is not scored once per tagged name (G18 (3)).
  - Shorts, bounded (Q8): Alpaca easy-to-borrow large caps sized so a +30% gap costs ≤ ~£150; Saxo via 1× inverse ETFs. Small caps are long-only, half a large-cap trade's risk, capped at a fixed share of the sleeve, floors exclude micro-caps (G18).
  - High-impact macro days (FOMC, US CPI, NFP, BoE rate decision, UK CPI): new entries at **half size**, not zero; exits unaffected; a counted trial against a no-gate shadow (G16).
- **Loss budget (Q6 as amended by G6):** net trading loss from start capital, both venues, GBP, open positions marked to market; GBP/USD moves on the Alpaca balance are excluded. £1,500 per calendar year, resets each year; deposits do not rebase start capital. −£500 → ½ size, −£1,000 → ¼, −£1,500 → halt for the year. Daily cap = exactly 1.0% of start capital, blocks new entries (exits still run). Profits never extend the limit. Loosening mid-year forbidden. The backtest runs with these rules inside it (G10).
- **Self-improvement:** offline research loop over the trade journal/error log → walk-forward with global trial counter → gate → paper → approval request (G12) → live. Live frozen except pre-declared, backtested adaptation rules and risk-tightening. The loop's design is not ruled (G11, ticket #1717 open).
- **Autonomy (G12, G13):** fully autonomous. Auto to paper. Anything reaching live (new sleeve, changed rule, capital increase) first passes the gate, then the system sends David an approval request on Telegram with the one-page summary; "no" blocks it; no reply in 24 hours approves it. The request, the reply or timeout, and the summary are written to a GitHub issue. There is no mandatory sign-off and no sign-off screen.
- **Demotion (G7):** a live sleeve returns to paper when live return leaves the backtest's 95% band for 4 consecutive weeks, or drawdown exceeds 1.5× the backtest max.
- **Host:** MacBook + external dead-man's switch + Saxo token-refresh/wake job; broker-resting stops. Cloud VM if any paper downtime fault.
- **Stack:** TypeScript only for everything that trades (backtest = live code). No LangGraph/CrewAI/LangSmith. An optional offline Python research sidecar is allowed (G3): it crosses only via parquet/ONNX/strategy-spec files, needs a TS parity test before paper, and is not built until needed.
- **Tooling:** oxlint, biome, crap, fallow rules intact; "crap" = the CRAP score gate, ticket #1649, to be built (G15); fallow (not knip) for dead code.
- **UI (G13):** a v2 dashboard with a rethought layout (the v3 Rail is not carried forward), required before paper starts.

## 5. Ordered work

Each step: `what => verify / kill line`. Steps 1 and 2 are £0, no LLM, and may start as soon as their own blockers in §5a are ruled (Q18: research, not build) — they do not wait for Step 0.

**Definition of done for every step (David, 2026-09-19: tests, lint, e2e, crap, mutation are built as each stage requires):** a step's PR ships its own unit tests, e2e tests where it touches a runtime path, passes oxlint + biome + fallow + the CRAP gate, and runs mutation testing on any risk, sizing or loss-budget code it adds. There is no separate "testing phase"; Step 4b is the cross-cutting pre-paper checklist on top of this, not a substitute for it.

### Step 0 — Doc rewrite (David asked for this explicitly; Q18/Q18a)

Do on a **new branch off fresh `origin/main`**, one PR, David merges.

**Status 2026-09-22: done by Session A (ticket #1741, branch docs/v2-session-a).** Tag `v1-final` = `38ee499d`; the paper DB archive is at `~/samurai-archive/v1-final/samurai-paper.sqlite` (integrity_check ok, 267 `debate_log` rows, 86 `closed_trades`); `docs/v1-postmortem.md` and `docs/v2-vision.md` are the renamed files. The evidence per item is in that PR's body.

1. `git tag v1-final origin/main && git push origin v1-final` => tag visible on origin.
2. Archive `data/samurai-paper.sqlite` <!-- cite-exempt: untracked — gitignored local file --> (main checkout) to the location ruled in G14, outside git, with `sqlite3 <db> ".backup '<dest>'"` — never `cp` (WAL mode) => the copy opens with `sqlite3` and its row counts match.
3. Per ruling G8: delete all of `docs/specs/*` (20 files) and `docs/adr/*` (21 files) => `docs/specs/` is empty and `docs/adr/` holds only the new v2 ADR (item 4). v2 specs are written in later steps, not in this PR. <!-- cite-exempt: historical — v1 record; the file was deleted per ruling G8 and is preserved at tag v1-final -->
4. Write **`docs/adr/0001-samurai-v2.md`**: all doc-66 rulings as the decision; supersedes the entire v1 ADR set; restates the still-true v1 decisions one line each — money-math precision (old 0005), daily equity return series (old 0006), client/server layout + `contracts/` wire model (old 0012), dashboard hosting (old 0019). Old 0021 (dashboard v3 rail) is **not** restated: G13 rethinks the layout. Record every still-open item (§5a, and doc 66 "Still open") as "open — ticket #n", never as decided. Cite `v1-final` for the originals.
5. Rewrite **`CONTEXT.md`** from scratch as the v2 glossary (sleeve, loss budget, gate, band, trial counter, arm 2, veto, venue-resting stop, research loop, promotion…). No implementation detail.
6. Rewrite **`CLAUDE.md`**. **Keep verbatim:** "Code Comments" section (with the effde735 precedent), "Rate Limit Rule — HARD STOP" (with the autoContinueAtUsageLimit paragraph), "graphify" section. **Add:** lint tooling rule — all oxlint, biome, crap and fallow rules stay intact and bind v2; fallow for dead code (what "crap" names is ruling G15); plus the per-step definition of done from §5. **Rewrite everything else** to doc 66: identity/goal/north star, venues/instruments, sleeves, loss budget, gate numbers, autonomy, host, language, process (Q18 lighter process replaces Standing Pipeline Rules 1/7), docs convention (specs/ADRs now v2-only), key constraints (resting stops, coverage invariants, per-disposal GBP tax log, paper ≠ edge).
7. Keep the `check:citations` CI step green (`.github/workflows/ci.yml` "Path citations resolve" → `server/tools/check-path-citations.ts`). Facts (verified 2026-09-19 by two reviews):
   - The checker scans backticked paths in all git-indexed `.md`/`.ts`/`.tsx` files, **except** `docs/adr/`, `docs/wayfinder/`, `docs/research/archive/`, `docs/reviews/`. Fenced code blocks, `.sql` files and TS string literals are **not** scanned — so migrations, `lse-etp-pool.ts`, `alert-catalogue.ts` + golden, `threshold-bounds.ts`, `smoke-run.ts` need **no** edits.
   - Backticked `docs/adr|specs` citations that break on deletion (~30): CONTEXT.md, CLAUDE.md (both rewritten anyway), README.md, research docs 16, 39, 40, 42, 43, 58, 59, 60, 61, 71 and `docs/research/README.md` (re-grep before editing; the list was last checked 2026-09-21). Fix each, or mark it `<!-- cite-exempt: historical — … -->` on the same line (valid reasons: foreign, historical, planned, untracked). Also update the `package.json` "description".
   - The only runtime reader of a deleted doc is `server/shared/store/spec-schema-drift.test.ts` (reads `docs/specs/shared-sqlite-store-spec.md`) — handle per ruling G14. <!-- cite-exempt: historical — v1 record; the file was deleted per ruling G8 and is preserved at tag v1-final -->
   - `server/tools/check-path-citations.test.ts` and `server/tools/__fixtures__/path-citations/*` use made-up paths deliberately — do not touch.
   => `npx tsx server/tools/check-path-citations.ts` reports 0 violations; lint + typecheck + test + `npm run smoke` green locally. CI green on the PR only if Actions billing is fixed — otherwise say so in the PR.
8. **Rename files for maintenance/readability** (David, 2026-09-19: *"rename files if required, for maintenace and readbability concerns"*). Use `git mv` so history follows; update every reference in the same PR. Proposed:
   - `docs/v1-postmortem.md` and `docs/v2-vision.md` (renamed in this PR from their `samurai-`-prefixed names). Renaming breaks CONTEXT.md's North Star link, docs 66–68, and the two files' links to each other — updated in the same PR.
   - v2 docs named by what they are: `docs/adr/0001-samurai-v2.md` (written in this PR).
   - Specs `debate-sleeve-spec.md`, `loss-budget-spec.md`, plus the Step 3c UI spec that G13 adds to Q18's list (written in later steps, not in the Step 0 PR). <!-- cite-exempt: planned — v2 specs not yet written -->
   - Keep the NN-slug numbering in `docs/research/` (cited by number); record any research rename in `docs/research/README.md`'s rename table.
   - Code renames that remove v1 vocabulary (intraday, flatten, ETP, D5, arm names) happen in Steps 3/5 as modules move into or out of the v2 root, not in the doc PR.
   => `grep -rn` for each old path returns nothing.
9. `graphify update .` after code edits.

### Step 1 — Momentum backtest (£0, no LLM)

Was blocked by G9 (PBO bar), G10 (budget path dependence) and research R12–R15; all are resolved (doc 66, doc 69). History: 10y+ (Q7, Q17).

**First, propose and STOP for David:** strategy family (time-series trend vs cross-sectional), exact ETF list (not `lse-etp-pool.ts`, which is the 3× pool), the point-in-time S&P 500 dataset (URL), the delisted-name haircut size, LSE survivorship handling, DSR on excess vs absolute returns, the parameter grid, and confirmation that the strategy is written as the module live code will import (one implementation everywhere, doc 66's Language row). The **LSE price-history source** is ruled (Q15 re-ruled 2026-09-22, doc 66): Yahoo `.L` and Stooq are out (R14); probe Saxo `chart/v3` history depth on David's account first — if it holds 10y for the ETF list, use it at £0; if not, STOP and report vendor cost/depth for David to pick. The proposal must also put these doc 69 facts to David, because each disturbs a ruling and none is decided: the **reporting-fund gate** (R12: SPY is not a reporting fund), whether to model **Saxo's 0.12%/yr custody fee** (R13 q5), and the **whole-share price rule** `price ≤ C/(5N)` (R3).

Then: walk-forward, trial counter from trial #1, DSR/PBO via `server/tools/backtest/overfitting.ts` (G9 ruled the bar **0.10**: this step changes `KILL_LINE.maxPbo` in `server/tools/backtest/stage2-verdict.ts` and the `max_pbo` bound in `server/shared/threshold-bounds.ts`, both 0.05 today), costs Saxo 0.08%/side no minimum; Alpaca spread-only (measure it). Include R4: every configuration run with and without the resting stop, counted as trials. Run the loss-budget rules inside the backtest (G10: size steps, daily cap, G6 yearly reset). Report the max drawdown (capital ceiling input).
=> **Kill:** does not beat risk-matched buy-and-hold of the same universe after the 40% haircut with DSR ≥ 0.95 and PBO ≤ 0.10 (G9). Record every trial.

**Status 2026-09-25:** US sub-book FAIL on all four passes (doc 70 §9.1; PRs #1759–#1762). David ruled LSE-only (doc 66, Session B (m)): no second US grid. **LSE sub-book run 2026-09-25 (PR #1766, doc 70 §10): FAIL on all four passes on 22 of 24 lines, provisional** — the sibling-Uic splice for IHCU/CMFP (IUHC, COMF) exceeded the pre-declared 1 bp/day overlap tolerance (15–16 bp/day), so both lines are excluded and EODHD was not bought (doc 70 §10.3). Combined Step 1 verdict (doc 70 §10.8): no momentum sub-book is wired into Step 3; Session D (#1767) composed the debate sleeve alone. Open for David, doc 70 §10.6: (1) IHCU/CMFP route — accept the splice, buy EODHD, or let the 22-line verdict stand; (2) whether the provisional FAIL stands as the Step 1 LSE verdict; (3) Acc-class swap for the 11 distributing lines; (4) whether momentum continues at all (a second LSE grid would reach MinBTL 16). **Ruled 2026-09-25 (doc 66, Session B (n)): "drop momentum, go debate only" — the FAIL stands; Step 1 is closed.**

### Step 2 — D1 debate audit/fix (£0, no LLM)

Offline replay of `debate_log` from `data/samurai-paper.sqlite` <!-- cite-exempt: untracked — gitignored local file --> to find why bullish conviction caps at 0.473 < 0.55 (history: #625 stocks ceiling 0.5478, debate rounds moved conviction by zero, #683 mediator tie-break).
The floor is `conviction_floor` in `server/pipeline/trader/types.ts`. Also: explain doc 65's scoreboard defects (control-arm oversizing; `arm_comparison_samples` −18.8% vs `closed_trades` +£799 disagree in sign), and propose arm 2's entry rule for a daily swing horizon — the debate sleeve is judged against arm 2.
Caveat: v1 debates ran on hourly bars over the 3× ETP/single-stock book; a "long setups are weak" verdict may not transfer to daily swing — say so in the report.
=> If formula bug: fix, re-replay, bullish must be able to clear the floor. If no bug and long setups genuinely weak: debate sleeve becomes short-only or veto-only (David decides).

**Status 2026-09-21: done — `docs/research/71-debate-audit.md`.** Not a formula defect; the cap came from v1's desk inputs and a mediator that never sided with a bullish-leaning desk. **Verdict ruled 2026-09-22 (doc 66, #1743 closed):** "Long and short, measured separately" — the debate sleeve can call either side, each side its own counted trial vs arm 2; shorts large-cap easy-to-borrow only (Q8); the Alpaca $2,000 equity floor must be resolved before any short (still open). Neither short-only nor veto-only.

### Step 3 — v2 composition root (after 1–2)

New slim root in this repo; reuse Alpaca + Saxo adapters, providers, stores, debate core behind a real module interface (postmortem §5). Saxo **simulated paper adapter**: fills at Saxo bid/ask, live tariff 0.08%/side no min (Saxo SIM env has a 24h manual token + trial £8 tariff — don't use it for evaluation). Alpaca paper native. Wire only surviving sleeves. Stop the v1 paper soak (Q10). Build Anthropic + OpenRouter HTTP transports (the debate core's `AnthropicLlmClient` in `server/pipeline/debate-engine/llm/anthropic-client.ts` already exists, but its only concrete transport today is the Nous one, `nous-messages-client.ts` in the same directory) with pinned model versions for Sonnet 5, Opus 5, GPT and DeepSeek (Q16; R10). Separate paper book per sleeve (Q14), plus the shadow books the rulings require: no-veto (G5), no-macro-gate (G16), and one per counted input trial (G18: without sentiment, without social, large-cap-only). Debate universe per G4 + G18. Debate sleeve: long and short, each side a counted trial vs arm 2 (Q17 ruled 2026-09-22); shorts large-cap easy-to-borrow only (Q8) and none until the Alpaca $2,000 equity floor is resolved. Blocked by G4, G5, G13, G16, G18 and R1, R2, R3, R5, R6, R7, R8, R10, R17 — all resolved except G18's open parts (ticket #1753) and the doc 69 facts listed in doc 66 "Still open".
=> one v2 cycle end-to-end green as a **dry run with no orders submitted** — protection (Step 4) comes before any paper order (Q17).

### Step 3c — UI (G13)

G13: the layout is rethought in this spec (the v3 Rail is not carried forward); approvals are answered on Telegram and recorded to a GitHub issue, so there is **no sign-off screen**; the dashboard must exist **before paper starts** (Step 6 is blocked by this step).

Write a v2 UI spec, then build alongside Step 3: loss-budget gauge (−£500/−£1,000/−£1,500, current size step), halt/pause control and halt state, live-vs-backtest band chart, per-sleeve vs benchmark, positions and cash for both venues (GBP and USD, total in GBP), decision journal (entered/skipped/vetoed and why), research-loop view (proposals, trial count, promotions/demotions), tax export (per disposal, GBP, share-matching). Step 5's teardown includes a client pass so the UI never reads deleted server fields.
=> each screen has component tests; e2e covers halt.

### Step 4 — Protection before any paper trade

Broker-resting stops on every position (doc 69 R2: a fractional Alpaca position cannot hold a GTC stop; whole-share-only is proposed, David's ruling open); loss-budget machinery (Q6 as amended by G6); daily cap (1.0% of start capital); the approval channel (G12/G13: Telegram request with the one-page summary, 24-hour auto-approve timer, a "no" blocks, the gate must pass before any request is sent, every request/answer/timeout written to a GitHub issue); dead-man's switch; Saxo token refresh (live refresh token lives 3600 s); per-disposal GBP tax log with FX rate; LLM trace row (prompt version, inputs, output, cost) joined to trade.
=> fault-injection: kill the process mid-position → stop still rests at broker; budget breach → entries halt.

### Step 4b — Assurance checklist (David, 2026-09-19) — **no paper trade until every item passes**

Each item needs an automated test or a recorded drill with its pass condition. Build as tests in the v2 tree, not as one-off scripts.

| Area | Item | Pass condition |
|---|---|---|
| Backtest | Look-ahead canary | Shifting the signal one bar later collapses the edge; a random-signal run lands inside the null distribution |
| Backtest | Cost stress | Result reported at 1× and 2× modelled cost; 2× must not flip the sign, or the sleeve is flagged |
| Backtest | Regime split | Per-period table (incl. 2020 crash, 2022 drawdown); no single period carries the result alone |
| Backtest | Locked final holdout | A final time slice the research loop can never read; read once, at promotion |
| Backtest | Data sanity | Coverage invariant per series (postmortem §2); adjusted-price jumps, gaps, zero-volume days flagged |
| Logging | Decision journal | Every decision incl. no-entry, veto, cap and skip, with its inputs and reason, append-only |
| Logging | Deterministic replay | Any past day re-runs from logs to identical decisions (LLM outputs replayed from the trace, not re-called) |
| Logging | Order-level fidelity | Paper's orders for a day match a backtest replay of the same day (the band test alone is low-power) |
| Logging | Realised vs modelled cost | Per-trade realised cost recorded; paper costs within ±25% of modelled (Q19) |
| Resilience | Plumbing-fault ledger | Every missed stop, reconcile mismatch or stuck order logged; the gate counts 4 consecutive zero-fault weeks from it (Q7) |
| Resilience | Fault matrix | Drills pass for: broker API down, partial fill, rejected order, stale data, clock/DST, holiday, duplicate run (idempotent), crash mid-order, Mac asleep |
| Resilience | Reconcile every run | Broker positions/cash vs store each run; any mismatch halts entries and alerts |
| Resilience | Loss-budget rehearsal | Simulated −£500 / −£1,000 / −£1,500 on paper → ½ size / ¼ size / halt, and the daily cap (1.0% of start capital) blocks entries; a GBP/USD move alone does not change the budget; the budget resets on 1 January; a deposit does not rebase it (G6) |
| Resilience | Approval-flow drill | A request with no reply approves itself at 24 hours; a "no" blocks it; no request can be sent while any gate condition fails; request, answer or timeout, and summary land in a GitHub issue (G12, G13) |
| Resilience | Never-loosen guard | Any attempt to raise the £1,500 limit or the daily cap mid-year is refused by code, not by convention (Q13) |
| Resilience | Separate sleeve books | Each sleeve's paper book is isolated; one sleeve's loss cannot size the other (Q14) |
| Security | Keys and egress | Broker keys trade-only, withdrawals disabled, IP-restricted where offered; test that no account data or key leaves in any LLM request (Q16) |
| Cost | LLM spend cap | ~$30/month cap enforced across providers; breach stops LLM calls, never trading exits (Q16) |
| Self-learning | Model swap = new trial | Changing any pinned model version resets that sleeve's paper evaluation (Q16) |
| Self-learning | Trial counter | Append-only, tamper-evident; every backtest run increments it |
| Self-learning | Promotion dry run | One full proposal → gate → paper-promotion cycle on a dummy change before the first real one |
| Adaptability | Rule scenarios | Scenario tests prove each pre-declared rule fires (vol spike, trend break, sleeve slump → demotion) |
| Adaptability | Drift monitor | Live-vs-backtest distribution drift with pre-committed thresholds (#1516) |
| Engineering | CI alive | GitHub Actions billing fixed; CI enforces oxlint, biome, crap, fallow, tests |
| Engineering | Property tests | Money math, loss budget, sizing |
| Engineering | Mutation testing | Risk and loss-budget code via `server/tools/mutation-local.ts` |
| Engineering | Broker contract tests | Order/position shapes: automated against Alpaca paper; a recorded drill against Saxo SIM (its token is manual and lasts 24h, so it cannot run in CI) |
| Observability | v2 dashboard (G13: required before paper) | Loss budget left, live position within backtest band, sleeve vs benchmark, heartbeat, LLM spend |
| Observability | Daily report + alerting | Daily summary pushed to David; any fault alerts within minutes |

=> all rows green, then paper starts.

### Step 5 — v1 teardown (Q11, after step 3 runs)

fallow + graphify reachability from the v2 root → reviewed list → delete in per-area waves, CI green each. Parked market-intelligence code (WorldMonitor, Polymarket) is deleted (G17); the X/social code is **not** deleted while its G18 trial runs. Rename surviving v1-named files/modules to v2 vocabulary in the same waves (Step 0 item 8). Known-dead list in doc 66 Q11.

### Step 6 — Paper soak to the gate (Q7/Q19), then research loop

Blocked by Step 4, Step 4b and Step 3c (G13: the v2 dashboard comes before paper).

Momentum sleeve: paper runs until **at least 10 rebalances and at least 8 weeks** (capped at 12 weeks; if 10 rebalances are not reached by then, report and ask David) inside band + 4 clean plumbing weeks. *(The 10-rebalance minimum is this plan's addition to Q7's "8–12 weeks", not a ruling; it is listed in doc 66 "Still open" for David to confirm.)* Debate sleeve: forward paper vs arm 2 until ≥ 100 closed trades and a one-sided test at 95% (G1); its 30% stays in cash until then. When a sleeve's conditions are met → one-page summary → Telegram approval request (G12: "no" blocks, no reply in 24 hours approves; recorded to a GitHub issue, G13) → live at the floor. Research loop built once a journal exists and G11 is ruled.

### Also

- The **wayfinder map issue "Samurai v2"** is [#1706](https://github.com/dd-jp/samurai-trading-system/issues/1706) (opened by doc 68 Session W, 2026-09-21): doc 66's rulings as closed decisions, one child ticket per §5a item and per step.

## 5a. Loose-ends register

IDs are stable: **G** = needs David's ruling (grilled one at a time, doc 68 Session G), **R** = research (doc 68 Session R). **Status 2026-09-21: every G item is ruled except G11 (deferred, ticket #1717 open) and the open parts of G18 (ticket #1753 open); every R item is answered in `docs/research/69-v2-facts.md`.** Every item names the **one** step it blocks, except G18, which was added later and blocks two (Step 3 and Step 5). The v2 ADR (Step 0) records any item still open as "open — ticket #n" rather than waiting for it, unless the item is listed as blocking Step 0.

### G — rulings for David

The **Question** and **Recommendation** columns are what was asked and proposed before the grill, kept as the record; a premise in them may since have been overtaken (G17's "v2 uses only daily bars + news" is no longer true under G18). Neither is the ruling. The **Ruled** column is a short pointer; the full ruling is the same ID's row in doc 66, which wins. David departed from the recommendation on G4, G6, G12, G13 and G16.

| ID | Question | Recommendation (not the ruling) | Blocks | Ruled (doc 66) |
|---|---|---|---|---|
| G1 | **Debate sleeve go-live rule.** Q7's gate assumes a backtest band; the debate sleeve cannot have one (LLM look-ahead, Q15). | Forward paper vs arm 2 with a pre-declared minimum trade count (≥ 100) and a one-sided test at 95%; until met, its 30% stays in cash. | Debate sleeve live | As recommended: ≥ 100 closed trades, one-sided 95%. |
| G2 | **Intraday.** Q9's options were: A = debate sleeve swings, no intraday sleeve (ruled); C = keep intraday as a later third sleeve that must pass its own gate. Keep A or change to C? | Keep A. | Step 0 | Keep A: no intraday sleeve. |
| G3 | **Python research sidecar** (TS runtime; optional offline Python crossing only via parquet/ONNX/strategy-spec files, with a TS parity test before paper). | Yes, as described; not built until needed. | Step 0 | Yes, as described. |
| G4 | **Debate universe.** Which names are debated daily? | A liquidity screen of US large caps plus the LSE ETF universe, capped at ~20 names/day by liquidity rank; not tied to momentum's picks. | Step 3 | **Differs:** ~10 by liquidity + ~10 movers/news; widened by G18. |
| G5 | **Veto measurement.** The LLM veto on momentum has the debate's look-ahead leak, so backtested momentum ≠ live momentum + veto; and the veto can erode returns. | Run a no-veto shadow book forward alongside; cap the veto rate (e.g. ≤ 10% of entries); drop the veto if the shadow beats it. | Step 3 | As recommended; cap ≤ 10%. |
| G6 | **Loss-budget scope.** £1,500 per calendar year (resets) or in total before stopping (doc 65's L)? Do deposits during the ramp rebase start capital? Do GBP/USD moves on the Alpaca balance count (hedge or not)? Exact daily cap (Q6 says ≈1%)? | Total before stopping (not reset); deposits do not rebase; FX counts, no hedge at this size; daily cap exactly 1.0% of start capital. | Step 0 | **Differs:** per calendar year, resets; deposits do not rebase; FX moves **excluded**; daily cap exactly 1.0%. |
| G7 | **Live demotion rule.** Exact thresholds that pull a live sleeve back to paper. | Demote when live return leaves the backtest's 95% band for 4 consecutive weeks, or drawdown exceeds 1.5× the backtest max. | Live | As recommended. |
| G8 | **ADRs: delete or keep?** Q11 says ADR-0014–0018 are "superseded, never deleted"; Q18 (later) says delete all 21. The citation checker treats `docs/adr/` as an immutable-record dir (`IMMUTABLE_RECORD_DIRS`). | Delete per Q18 (the later ruling); the `v1-final` tag preserves them; mark Q11's clause superseded in doc 66. | Step 0 | Delete all 21. |
| G9 | **PBO bar.** Q19 says ≤ 0.10. Code says 0.05: `server/apps/orchestrator/production.ts` throws at build when `max_pbo` > 0.05 (bound from `server/shared/threshold-bounds.ts`), also enforced in `server/pipeline/feedback-loop/sqlite-tuning-store.ts` and `server/pipeline/risk-manager/risk-thresholds.ts`; `server/tools/backtest/stage2-verdict.ts` hard-codes `KILL_LINE.maxPbo` 0.05. | Keep Q19's 0.10 for v2 and change the code bounds in the step that first uses them; or revert Q19 to 0.05. | Step 0 and Step 1 | 0.10; code bounds change in Step 1. |
| G10 | **Budget path dependence.** At the £5,000 ceiling, −£500 is a 10% drawdown — ordinary for momentum — so half-size triggers inside normal behaviour and pushes paper/live out of the backtest band. | Backtest with the budget rules included, so the band already reflects them. | Step 1 | As recommended, including the G6 yearly reset. |
| G11 | **Research-loop design** — which agents, what data, how proposals are generated. | Its own brainstorm session once a trade journal exists. | Research loop | **Not ruled** — deferred, ticket #1717 open. |
| G12 | **David unavailable** — default when a sign-off or pause gets no answer. | Hold: no promotion, no capital change, protective exits keep running, never loosen anything. | Paper start | **Differs:** fully autonomous; Telegram request; no reply in 24 hours approves, live money included; "no" blocks. |
| G13 | **UI scope.** Keep the v3 Rail layout or rethink? Sign-off in the UI or on GitHub? Is the dashboard needed before paper, or is the daily report enough to start? | Keep Rail, add v2 screens (Step 3c); sign-off on GitHub (auditable); daily report enough to start paper, dashboard before live. | Step 3 | **Differs:** layout rethought, Rail not carried forward; approvals on Telegram, recorded to a GitHub issue, no sign-off screen; dashboard required **before paper**. |
| G14 | **Session A pre-answers.** Where is the paper DB archived? What happens to `server/shared/store/spec-schema-drift.test.ts` when its spec is deleted? | `~/samurai-archive/v1-final/samurai-paper.sqlite`, outside git; delete the test with the spec — migrations are the schema authority. | Step 0 | As recommended. | <!-- cite-exempt: historical — v1 record; the file was deleted per ruling G8 and is preserved at tag v1-final -->
| G15 | **What is "crap"?** No tool by that name is configured (package.json, oxlint, biome, fallow, CI). | The CRAP score gate (complexity × coverage), ticket #1649 — build it and make it bind. | Step 0 | As recommended. |
| G16 | **Macro event gate.** Should the debate sleeve skip or halve new entries on high-impact release days (FOMC, US CPI, NFP, BoE rate decisions, UK CPI)? Momentum rebalances weekly and is unaffected. | Yes for the debate sleeve only: no new entries on a high-impact day, exits unaffected; counted as a trial, measured against a no-gate shadow in paper. Source per R17. | Step 3 | **Differs:** new entries at **half size**, not zero. |
| G17 | **Parked market-intelligence code.** v2 uses only daily bars + news (Q9); WorldMonitor, Polymarket, social sentiment and X are unused, so Step 5's reachability teardown would delete them. Keep them parked in the tree, or delete and rebuild later if needed? | Delete (git and the v1-final tag keep them); bring a source back only when the research loop shows it adds edge, as a counted trial. Their tickets stay parked, not closed. | Step 5 | Delete in Step 5; amended by G18 (X/social code stays while its trial runs). |
| G18 | **Sentiment and social inputs** (added 2026-09-21, after this register was written). What role do they play in v2, from which sources, how validated? | None was written; brainstormed directly. | Step 3 and Step 5 | Partly ruled, ticket #1753 open: both enter as counted trials; sentiment score also picks names; bounded long-only small caps; v1's class-wide-vote and roundup defects bind the v2 input design. Open: social source and cost, floor and cap numbers, overlap with the fundamental analyst. |

### R — research (facts, primary sources)

| ID | Question | Blocks |
|---|---|---|
| R1 | **Trading vs investing (HMRC badges of trade).** Frequent automated trading may be taxed as trading income (income tax + NI), not CGT. Needs research and likely an accountant's view. | Step 3 |
| R2 | **Alpaca order limits.** Fractional quantities are refused for bracket/OCO/OTO orders (memory alpaca-fractional-bars-brackets); confirm whether a plain stop order on a fractional position is allowed. Also: whole-share **short** brackets (SPY 6, QQQ 7) were refused for an unknown reason — this bears directly on Q8's debate-sleeve shorts. | Step 3 |
| R3 | **Whole-share granularity.** At £1,000–£5,000 total and 70% to momentum (£700–£3,500; momentum dropped, doc 66 (n)) across ~25 ETFs, positions are ~£28–£140; LSE share prices of £50–100+ make target weights unreachable. Find the minimum viable capital per holdings count on both venues. | Step 3 |
| R5 | **Evidence that an LLM news/debate signal works at a daily horizon,** from academic studies free of look-ahead (tested after the model's training cutoff). If none, the debate sleeve rests on hope. | Step 3 |
| R6 | **News source for LSE ETFs** for the debate (Alpaca news is US-only; Saxo news is unreachable over OpenAPI, memory saxo-platform-oapi-vs-openapi). | Step 3 |
| R7 | **Live end-of-day price source for LSE** that permits automated use (Yahoo terms; Saxo is 15-min delayed). | Step 3 |
| R8 | **Dividends and corporate actions:** accumulating vs distributing ETFs, backtest vs live treatment, ex-dividend drops tripping stops. | Step 3 |
| R9 | **Holiday calendars** for US and UK, and their expiry. | Paper start |
| R10 | **LLM providers:** can GPT and DeepSeek versions be pinned via OpenRouter; data-retention/privacy terms (DeepSeek especially); rate limits. | Step 3 |
| R11 | **Funding Alpaca from the UK:** wire fees, Wise support, conversion cost. | Live |
| R12 | **UK tax on funds:** offshore-fund rules (gains on non-reporting funds taxed as income, not CGT; most US-listed ETFs are non-reporting; screen LSE ETFs for HMRC reporting-fund status); share matching (same-day and 30-day rules) under weekly rebalances, which the tax log must implement. | Step 1 |
| R13 | **Broker access:** Alpaca margin for UK residents, US-ETF access (PRIIPs/KID), borrow fees, PDT-removal implementation date; Saxo FX conversion fee; availability of 1× inverse ETFs on LSE. | Step 1 |
| R14 | **Data:** how many LSE ETFs have 10+ years of history; Yahoo/Stooq terms for automated use. | Step 1 |
| R15 | **Execution timing:** rebalance at the open, the close, or the LSE closing auction, and the slippage model for each. | Step 1 |
| R16 | **Security:** withdrawals disabled, IP allow-lists, token storage for both venues. | Paper start |
| R17 | **Macro event calendar source** that permits automated use: official schedules (Federal Reserve FOMC calendar, BLS release schedule, Bank of England and ONS release calendars, FRED releases API) — dates, times, how far ahead they publish, and machine-readable access. Forex Factory was considered and rejected (FX-focused, no API, terms for automated use unchecked). | Step 3 |

(R4 — do stops help momentum? — is not research: it is run inside Step 1 as counted trials.)

The questions above are kept as asked. The answers are in `docs/research/69-v2-facts.md`; some premises were wrong (R2: the whole-share short refusals were sub-penny bracket prices, already fixed; R7/R14: Yahoo's terms bar automated use). Doc 69's last section lists the rulings its facts disturb; those are David's to rule and are tracked in doc 66 "Still open".

### Summary of what blocks what

- **Step 0 (Session A):** G2, G3, G6, G8, G9, G14, G15 (all ruled) + the cross-verification (Session X).
- **Step 1 (Session B):** G9, G10, R12, R13, R14, R15 (all resolved; doc 69's disturbed rulings go to David inside Session B's proposal).
- **Step 2 (Session C):** nothing — done (doc 71); verdict ruled 2026-09-22 (long and short, each side a counted trial vs arm 2; #1743 closed).
- **Step 3:** G4, G5, G13, G16, G18, R1, R2, R3, R5, R6, R7, R8, R10, R17 (G18's ticket #1753 is still open).
- **Paper start (Step 6):** Step 4 + 4b, Step 3c (G13), G12, R9, R16.
- **Live:** G1 (debate sleeve), G7, R11, and the G12 approval request (gate passes → Telegram → "no" blocks, no reply in 24 hours approves).
- **Step 5 (Session F):** G17, G18.
- **Research loop:** G11 (open).

## 6. Traps already hit (read before touching the repo)

- **Worktree-isolation hook** refuses Bash with shell variables in sqlite paths and base64 pipes. Use literal read-only URIs: `sqlite3 "file:/Users/ddjp/Documents/projects/samurai-trading-system/data/samurai-paper.sqlite?mode=ro" "..."`. Subagent Bash is refused under worktree isolation (memory subagent-bash-refused-in-worktree).
- Paper DB lives in the **main checkout's** `data/`, not the worktree's (memory service-reads-worktree-store).
- Doc numbers: 61–68 are taken. Pre-assigned to avoid parallel collisions: **69 = Session R (on main), 70 = Session B, 71 = Session C (on main)**; anything else takes the next free number on `origin/main`.
- `Closes #N` / "closed #N" in a PR body auto-closes issues at merge — grep the body.
- Merges follow doc 66's merge-authority ruling (2026-09-25). No live money until the gate passes and the G12 approval request has run its course; paper only until then. Caveman-ultra style for chat replies to David; normal prose in docs/commits. Never commit secrets (Saxo live token is in `data/saxo-tokens/live.json` <!-- cite-exempt: untracked — gitignored local file -->).
- Rate-limit hard stop rule applies.

## 7. Where this lives

All on `main` (docs 61–69 and 71, CONTEXT.md North Star). Session prompts are in `docs/research/68-fable-handoff.md`. Each step starts once its own blockers in §5a are resolved.
