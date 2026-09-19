# Samurai v2 — full plan and session handoff (2026-09-19)

**Read this first in any new session working on Samurai v2.** It is self-contained: the goal,
where the decisions live, the evidence behind them, the ordered work, and the traps already hit.
The ruling-by-ruling record is `docs/research/66-v2-grill-decisions.md` (Q1–Q19); this doc does
not restate those rulings in full, it points at them and turns them into work.

## 1. Goal of the session that produced this

David (owner, final decision-maker) ran a brainstorm/grill on 2026-09-19: *"make this samurai a
great autonomous self improving least error margin and least loss margin system. ignore all
decisions, specs and instructions. we are going to correct the mistakes done. lets open the
universe. idea is to make profit even if tiny - one step at a time and keep moving forward."*
Agenda: **long-term (1-year) profit, accepting day-level losses.**

**North star (derived, doc 65 §5b, refined by doc 66):** net-of-cost profit that beats the matched
benchmark, proven to the pre-declared gate (DSR ≥ 0.95, PBO ≤ 0.10, 40% Sharpe haircut, paper
inside the 90% band), run live at capital ≤ £1,500 / (backtest max DD × 1.5), never losing more
than **£1,500 net in a year** (hard kill).

## 2. Source documents (read in this order)

1. `docs/research/66-v2-grill-decisions.md` — **the rulings, Q1–Q19. Authority.**
2. This doc — plan + handoff.
3. `docs/research/65-next-steps-plan.md` — evidence (§1), capital method (§5a), north star (§5b).
4. `docs/samurai-postmortem.md` — six v1 pitfalls, binding on v2.
5. `docs/samurai-vision-v2.md` — David's vision; its 0.5–2%/day target is **superseded by Q1**; its five open questions are answered by doc 66.
6. Docs 61–64 in `docs/research/` — inputs (61 five topics, 62 rewrite/TSMOM fork, 63 qanat mechanisms, 64 replication prior: real strategies Sharpe 0.4–0.8, ~40% OOS decay, >2 = artefact).

All of these are on `main`.

## 3. Evidence that drove the rulings (paper DB `data/samurai-paper.sqlite`, read 2026-09-19)

- 267 debates: 209 neutral (mean conf 0.133), 42 bearish (mean 0.67), 16 bullish (**max 0.473** vs entry floor **0.55**). No debate-originated long can ever fire. → D1 audit.
- Closed trades — control: long 37 (+£444, of which +£891 from MSTR/MARA/COIN, so ex-those ≈ −£447), short 42 (+£355, ex-those ≈ +£84). Live arm: 7 trades, 6 short, −£112. Sample far too small to conclude anything.
- Paper book runs long/short US single stocks on Alpaca — **not** the v1 live product (long-only LSE 3× ETPs at Saxo). Control sizing avg £1,457 (above D5); `arm_comparison_samples` (−18.8%) disagrees in sign with `closed_trades` (+£799).
- Total LLM spend $3.04 over 1,428 calls — the chassis/cost is not the constraint; the signal is.
- Every intraday research result is negative or underpowered. Momentum (doc 11) measured only +0.17 Sharpe over always-long, t = 0.15, on a different design — v2's momentum sleeve is untested.

## 4. The v2 system in one page (from doc 66)

- **Venues:** Saxo GIA → LSE 1× ETFs/ETCs. Alpaca live (GBP wired once, trade USD) → US large caps (+ US ETFs if UK access confirmed). No 3× ETPs, no UK single stocks, no CFDs.
- **Sleeves:** (1) **Momentum** — rules only, long/flat, LLM veto (Opus 5) only, 70% of live capital, benchmark = buy-and-hold of the same universe. (2) **Debate** — LLM entry (debaters Sonnet 5 + DeepSeek + GPT, judge Opus 5), swing (one debate/name/day pre-open, days–weeks hold, resting stop + time stop), may short bounded (Alpaca ETB large caps sized so +30% gap ≤ ~£150; Saxo via 1× inverse ETFs), 30%, benchmark = arm 2 no-LLM control, validated **forward only** (LLM look-ahead leak).
- **Loss budget:** net from start capital, both venues, GBP, marked-to-market. −£500 → ½ size, −£1,000 → ¼, −£1,500 → halt for the year. Daily ≈1% cap blocks entries. Profits never extend the limit. Loosening mid-year forbidden.
- **Self-improvement:** offline research loop over the trade journal/error log → walk-forward with global trial counter → gate → paper → David sign-off → live. Live frozen except pre-declared, backtested adaptation rules and risk-tightening.
- **Autonomy:** auto to paper; David signs anything touching live (one-page summary).
- **Host:** MacBook + external dead-man's switch + Saxo token-refresh/wake job; broker-resting stops. Cloud VM if any paper downtime fault.
- **Stack:** TypeScript only for everything that trades (backtest = live code). No LangGraph/CrewAI/LangSmith. Python sidecar = proposed, **not ruled**.
- **Tooling:** oxlint, biome, crap, fallow rules intact; fallow (not knip) for dead code.

## 5. Ordered work

Each step: `what => verify / kill line`. Steps 1 and 2 are £0, no LLM, and may start as soon as their own blockers in §5a are ruled (Q18: research, not build) — they do not wait for Step 0.

**Definition of done for every step (David, 2026-09-19: tests, lint, e2e, crap, mutation are built as each stage requires):** a step's PR ships its own unit tests, e2e tests where it touches a runtime path, passes oxlint + biome + fallow + the CRAP gate, and runs mutation testing on any risk, sizing or loss-budget code it adds. There is no separate "testing phase"; Step 4b is the cross-cutting pre-paper checklist on top of this, not a substitute for it.

### Step 0 — Doc rewrite (David asked for this explicitly; Q18/Q18a)

Do on a **new branch off fresh `origin/main`**, one PR, David merges.

1. `git tag v1-final origin/main && git push origin v1-final` => tag visible on origin.
2. Archive `data/samurai-paper.sqlite` (main checkout) to the location ruled in G14, outside git, with `sqlite3 <db> ".backup '<dest>'"` — never `cp` (WAL mode) => the copy opens with `sqlite3` and its row counts match.
3. Per ruling G8: delete all of `docs/specs/*` (20 files) and `docs/adr/*` (21 files) => `docs/specs/` is empty and `docs/adr/` holds only the new v2 ADR (item 4). v2 specs are written in later steps, not in this PR.
4. Write **`docs/adr/0001-samurai-v2.md`**: all doc-66 rulings as the decision; supersedes the entire v1 ADR set; restates the still-true v1 decisions one line each — money-math precision (old 0005), daily equity return series (old 0006), client/server layout + `contracts/` wire model (old 0012), dashboard hosting (old 0019), dashboard v3 rail (old 0021). Cite `v1-final` for the originals. <!-- cite-exempt: planned — created by Step 0 -->
5. Rewrite **`CONTEXT.md`** from scratch as the v2 glossary (sleeve, loss budget, gate, band, trial counter, arm 2, veto, venue-resting stop, research loop, promotion…). No implementation detail.
6. Rewrite **`CLAUDE.md`**. **Keep verbatim:** "Code Comments" section (with the effde735 precedent), "Rate Limit Rule — HARD STOP" (with the autoContinueAtUsageLimit paragraph), "graphify" section. **Add:** lint tooling rule — all oxlint, biome, crap and fallow rules stay intact and bind v2; fallow for dead code (what "crap" names is ruling G15); plus the per-step definition of done from §5. **Rewrite everything else** to doc 66: identity/goal/north star, venues/instruments, sleeves, loss budget, gate numbers, autonomy, host, language, process (Q18 lighter process replaces Standing Pipeline Rules 1/7), docs convention (specs/ADRs now v2-only), key constraints (resting stops, coverage invariants, per-disposal GBP tax log, paper ≠ edge).
7. Keep the `check:citations` CI step green (`.github/workflows/ci.yml` "Path citations resolve" → `server/tools/check-path-citations.ts`). Facts (verified 2026-09-19 by two reviews):
   - The checker scans backticked paths in all git-indexed `.md`/`.ts`/`.tsx` files, **except** `docs/adr/`, `docs/wayfinder/`, `docs/research/archive/`, `docs/reviews/`. Fenced code blocks, `.sql` files and TS string literals are **not** scanned — so migrations, `lse-etp-pool.ts`, `alert-catalogue.ts` + golden, `threshold-bounds.ts`, `smoke-run.ts` need **no** edits.
   - Backticked `docs/adr|specs` citations that break on deletion (~30): CONTEXT.md, CLAUDE.md (both rewritten anyway), README.md, research docs 16, 39, 40, 42, 43, 58, 59, 60, 61 and `docs/research/README.md`. Fix each, or mark it `<!-- cite-exempt: historical — … -->` on the same line (valid reasons: foreign, historical, planned, untracked). Also update the `package.json` "description".
   - The only runtime reader of a deleted doc is `server/shared/store/spec-schema-drift.test.ts` (reads `docs/specs/shared-sqlite-store-spec.md`) — handle per ruling G14.
   - `server/tools/check-path-citations.test.ts` and `server/tools/__fixtures__/path-citations/*` use made-up paths deliberately — do not touch.
   => `npx tsx server/tools/check-path-citations.ts` reports 0 violations; lint + typecheck + test + `npm run smoke` green locally. CI green on the PR only if Actions billing is fixed — otherwise say so in the PR.
8. **Rename files for maintenance/readability** (David, 2026-09-19: *"rename files if required, for maintenace and readbability concerns"*). Use `git mv` so history follows; update every reference in the same PR. Proposed:
   - `docs/samurai-postmortem.md` → docs/v1-postmortem.md; `docs/samurai-vision-v2.md` → docs/v2-vision.md (both on main). Renaming breaks CONTEXT.md's North Star link and docs 66–68 — update them in the same PR.
   - v2 docs named by what they are: `docs/adr/0001-samurai-v2.md`; specs `docs/specs/momentum-sleeve-spec.md`, `debate-sleeve-spec.md`, `loss-budget-spec.md` (written in later steps, not in the Step 0 PR). <!-- cite-exempt: planned — v2 docs not yet written -->
   - Keep the NN-slug numbering in `docs/research/` (cited by number); record any research rename in `docs/research/README.md`'s rename table.
   - Code renames that remove v1 vocabulary (intraday, flatten, ETP, D5, arm names) happen in Steps 3/5 as modules move into or out of the v2 root, not in the doc PR.
   => `grep -rn` for each old path returns nothing.
9. `graphify update .` after code edits.

### Step 1 — Momentum backtest (£0, no LLM)

Blocked by G9 (PBO bar), G10 (budget path dependence) and research R12–R15 (tax status and broker access shape the universe; data history; execution timing).

**First, propose and STOP for David:** strategy family (time-series trend vs cross-sectional), exact ETF list (not `lse-etp-pool.ts`, which is the 3× pool), the point-in-time S&P 500 dataset (URL), the delisted-name haircut size, LSE survivorship handling (Yahoo lacks delisted `.L` tickers), DSR on excess vs absolute returns, the parameter grid, and confirmation that the strategy is written as the module live code will import (one implementation everywhere, Q11).

Then: walk-forward, trial counter from trial #1, DSR/PBO via `server/tools/backtest/overfitting.ts` (note `server/tools/backtest/stage2-verdict.ts` hard-codes `KILL_LINE.maxPbo` 0.05 — use the G9 ruling), costs Saxo 0.08%/side no minimum; Alpaca spread-only (measure it). Include R4: every configuration run with and without the resting stop, counted as trials. Report the max drawdown (capital ceiling input).
=> **Kill:** does not beat risk-matched buy-and-hold of the same universe after the 40% haircut with DSR ≥ 0.95 and PBO ≤ the G9 bar. Record every trial.

### Step 2 — D1 debate audit/fix (£0, no LLM)

Offline replay of `debate_log` from `data/samurai-paper.sqlite` to find why bullish conviction caps at 0.473 < 0.55 (history: #625 stocks ceiling 0.5478, debate rounds moved conviction by zero, #683 mediator tie-break).
The floor is `conviction_floor` in `server/pipeline/trader/types.ts`. Also: explain doc 65's scoreboard defects (control-arm oversizing; `arm_comparison_samples` −18.8% vs `closed_trades` +£799 disagree in sign), and propose arm 2's entry rule for a daily swing horizon — the debate sleeve is judged against arm 2.
Caveat: v1 debates ran on hourly bars over the 3× ETP/single-stock book; a "long setups are weak" verdict may not transfer to daily swing — say so in the report.
=> If formula bug: fix, re-replay, bullish must be able to clear the floor. If no bug and long setups genuinely weak: debate sleeve becomes short-only or veto-only (David decides).

### Step 3 — v2 composition root (after 1–2)

New slim root in this repo; reuse Alpaca + Saxo adapters, providers, stores, debate core behind a real module interface (postmortem §5). Saxo **simulated paper adapter**: fills at Saxo bid/ask, live tariff 0.08%/side no min (Saxo SIM env has a 24h manual token + trial £8 tariff — don't use it for evaluation). Alpaca paper native. Wire only surviving sleeves. Stop the v1 paper soak (Q10). Build Anthropic + OpenRouter LLM clients (only Nous clients exist today) with pinned model versions for Sonnet 5, Opus 5, GPT and DeepSeek (Q16; R10). Separate paper book per sleeve (Q14). Blocked by G4, G5, G13, G16 and R1, R2, R3, R5, R6, R7, R8, R10, R17.
=> one v2 cycle end-to-end green as a **dry run with no orders submitted** — protection (Step 4) comes before any paper order (Q17).

### Step 3c — UI (G13)

Write a v2 UI spec, then build alongside Step 3: loss-budget gauge (−£500/−£1,000/−£1,500, current size step), halt/pause control and halt state, live-vs-backtest band chart, per-sleeve vs benchmark, positions and cash for both venues (GBP and USD, total in GBP), decision journal (entered/skipped/vetoed and why), research-loop view (proposals, trial count, promotions/demotions), sign-off screen if G13 puts sign-off in the UI, tax export (per disposal, GBP, share-matching). Step 5's teardown includes a client pass so the UI never reads deleted server fields.
=> each screen has component tests; e2e covers halt and sign-off.

### Step 4 — Protection before any paper trade

Broker-resting stops on every position; loss-budget machinery (Q6); daily cap; dead-man's switch; Saxo token refresh (live refresh token lives 3600 s); per-disposal GBP tax log with FX rate; LLM trace row (prompt version, inputs, output, cost) joined to trade.
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
| Resilience | Loss-budget rehearsal | Simulated −£500 / −£1,000 / −£1,500 on paper → ½ size / ¼ size / halt, and the daily cap blocks entries |
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
| Observability | v2 views | Loss budget left, live position within backtest band, sleeve vs benchmark, heartbeat, LLM spend |
| Observability | Daily report + alerting | Daily summary pushed to David; any fault alerts within minutes |

=> all rows green, then paper starts.

### Step 5 — v1 teardown (Q11, after step 3 runs)

fallow + graphify reachability from the v2 root → reviewed list → delete in per-area waves, CI green each. Rename surviving v1-named files/modules to v2 vocabulary in the same waves (Step 0 item 8). Known-dead list in doc 66 Q11.

### Step 6 — Paper soak to the gate (Q7/Q19), then research loop

Paper runs until **at least 10 rebalances and at least 8 weeks** (capped at 12 weeks; if 10 rebalances are not reached by then, report and ask David) inside band + 4 clean plumbing weeks → one-page summary → David sign-off → live at the floor. Research loop built once a journal exists.

### Also

- Open the **wayfinder map issue "Samurai v2"** (label `wayfinder-map`) with doc 66's rulings as closed decisions and one child ticket per §5a item (doc 68 Session W).

## 5a. Loose-ends register

IDs are stable: **G** = needs David's ruling (grilled one at a time, doc 68 Session G), **R** = research (doc 68 Session R). Every item names the **one** step it blocks. The v2 ADR (Step 0) records any item still open as "open — ticket #n" rather than waiting for it, unless the item is listed as blocking Step 0.

### G — rulings for David

| ID | Question | Recommendation | Blocks |
|---|---|---|---|
| G1 | **Debate sleeve go-live rule.** Q7's gate assumes a backtest band; the debate sleeve cannot have one (LLM look-ahead, Q15). | Forward paper vs arm 2 with a pre-declared minimum trade count (≥ 100) and a one-sided test at 95%; until met, its 30% stays in cash. | Debate sleeve live |
| G2 | **Intraday.** Q9's options were: A = debate sleeve swings, no intraday sleeve (ruled); C = keep intraday as a later third sleeve that must pass its own gate. Keep A or change to C? | Keep A. | Step 0 |
| G3 | **Python research sidecar** (TS runtime; optional offline Python crossing only via parquet/ONNX/strategy-spec files, with a TS parity test before paper). | Yes, as described; not built until needed. | Step 0 |
| G4 | **Debate universe.** Which names are debated daily? | A liquidity screen of US large caps plus the LSE ETF universe, capped at ~20 names/day by liquidity rank; not tied to momentum's picks. | Step 3 |
| G5 | **Veto measurement.** The LLM veto on momentum has the debate's look-ahead leak, so backtested momentum ≠ live momentum + veto; and the veto can erode returns. | Run a no-veto shadow book forward alongside; cap the veto rate (e.g. ≤ 10% of entries); drop the veto if the shadow beats it. | Step 3 |
| G6 | **Loss-budget scope.** £1,500 per calendar year (resets) or in total before stopping (doc 65's L)? Do deposits during the ramp rebase start capital? Do GBP/USD moves on the Alpaca balance count (hedge or not)? Exact daily cap (Q6 says ≈1%)? | Total before stopping (not reset); deposits do not rebase; FX counts, no hedge at this size; daily cap exactly 1.0% of start capital. | Step 0 |
| G7 | **Live demotion rule.** Exact thresholds that pull a live sleeve back to paper. | Demote when live return leaves the backtest's 95% band for 4 consecutive weeks, or drawdown exceeds 1.5× the backtest max. | Live |
| G8 | **ADRs: delete or keep?** Q11 says ADR-0014–0018 are "superseded, never deleted"; Q18 (later) says delete all 21. The citation checker treats `docs/adr/` as an immutable-record dir (`IMMUTABLE_RECORD_DIRS`). | Delete per Q18 (the later ruling); the `v1-final` tag preserves them; mark Q11's clause superseded in doc 66. | Step 0 |
| G9 | **PBO bar.** Q19 says ≤ 0.10. Code says 0.05: `server/apps/orchestrator/production.ts` throws at build when `max_pbo` > 0.05 (bound from `server/shared/threshold-bounds.ts`), also enforced in `server/pipeline/feedback-loop/sqlite-tuning-store.ts` and `server/pipeline/risk-manager/risk-thresholds.ts`; `server/tools/backtest/stage2-verdict.ts` hard-codes `KILL_LINE.maxPbo` 0.05. | Keep Q19's 0.10 for v2 and change the code bounds in the step that first uses them; or revert Q19 to 0.05. | Step 0 and Step 1 |
| G10 | **Budget path dependence.** At the £5,000 ceiling, −£500 is a 10% drawdown — ordinary for momentum — so half-size triggers inside normal behaviour and pushes paper/live out of the backtest band. | Backtest with the budget rules included, so the band already reflects them. | Step 1 |
| G11 | **Research-loop design** — which agents, what data, how proposals are generated. | Its own brainstorm session once a trade journal exists. | Research loop |
| G12 | **David unavailable** — default when a sign-off or pause gets no answer. | Hold: no promotion, no capital change, protective exits keep running, never loosen anything. | Paper start |
| G13 | **UI scope.** Keep the v3 Rail layout or rethink? Sign-off in the UI or on GitHub? Is the dashboard needed before paper, or is the daily report enough to start? | Keep Rail, add v2 screens (Step 3c); sign-off on GitHub (auditable); daily report enough to start paper, dashboard before live. | Step 3 |
| G14 | **Session A pre-answers.** Where is the paper DB archived? What happens to `server/shared/store/spec-schema-drift.test.ts` when its spec is deleted? | `~/samurai-archive/v1-final/samurai-paper.sqlite`, outside git; delete the test with the spec — migrations are the schema authority. | Step 0 |
| G15 | **What is "crap"?** No tool by that name is configured (package.json, oxlint, biome, fallow, CI). | The CRAP score gate (complexity × coverage), ticket #1649 — build it and make it bind. | Step 0 |
| G16 | **Macro event gate.** Should the debate sleeve skip or halve new entries on high-impact release days (FOMC, US CPI, NFP, BoE rate decisions, UK CPI)? Momentum rebalances weekly and is unaffected. | Yes for the debate sleeve only: no new entries on a high-impact day, exits unaffected; counted as a trial, measured against a no-gate shadow in paper. Source per R17. | Step 3 |
| G17 | **Parked market-intelligence code.** v2 uses only daily bars + news (Q9); WorldMonitor, Polymarket, social sentiment and X are unused, so Step 5's reachability teardown would delete them. Keep them parked in the tree, or delete and rebuild later if needed? | Delete (git and the v1-final tag keep them); bring a source back only when the research loop shows it adds edge, as a counted trial. Their tickets stay parked, not closed. | Step 5 |

### R — research (facts, primary sources)

| ID | Question | Blocks |
|---|---|---|
| R1 | **Trading vs investing (HMRC badges of trade).** Frequent automated trading may be taxed as trading income (income tax + NI), not CGT. Needs research and likely an accountant's view. | Step 3 |
| R2 | **Alpaca order limits.** Fractional quantities are refused for bracket/OCO/OTO orders (memory alpaca-fractional-bars-brackets); confirm whether a plain stop order on a fractional position is allowed. Also: whole-share **short** brackets (SPY 6, QQQ 7) were refused for an unknown reason — this bears directly on Q8's debate-sleeve shorts. | Step 3 |
| R3 | **Whole-share granularity.** At £1,000–£5,000 total and 70% to momentum (£700–£3,500) across ~25 ETFs, positions are ~£28–£140; LSE share prices of £50–100+ make target weights unreachable. Find the minimum viable capital per holdings count on both venues. | Step 3 |
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

### Summary of what blocks what

- **Step 0 (Session A):** G2, G3, G6, G8, G9, G14, G15 + the cross-verification (Session X).
- **Step 1 (Session B):** G9, G10, R12, R13, R14, R15.
- **Step 2 (Session C):** nothing — may start now.
- **Step 3:** G4, G5, G13, G16, R1, R2, R3, R5, R6, R7, R8, R10, R17.
- **Paper start:** Step 4 + 4b, G12, R9, R16.
- **Live:** G1 (debate sleeve), G7, R11, David's sign-off.
- **Step 5 (Session F):** G17.
- **Research loop:** G11.

## 6. Traps already hit (read before touching the repo)

- **Worktree-isolation hook** refuses Bash with shell variables in sqlite paths and base64 pipes. Use literal read-only URIs: `sqlite3 "file:/Users/ddjp/Documents/projects/samurai-trading-system/data/samurai-paper.sqlite?mode=ro" "..."`. Subagent Bash is refused under worktree isolation (memory subagent-bash-refused-in-worktree).
- Paper DB lives in the **main checkout's** `data/`, not the worktree's (memory service-reads-worktree-store).
- Doc numbers: 61–68 are taken. Pre-assigned to avoid parallel collisions: **69 = Session R, 70 = Session B, 71 = Session C**; anything else takes the next free number on `origin/main`.
- `Closes #N` / "closed #N" in a PR body auto-closes issues at merge — grep the body.
- Merges are David's. No live money until David is confident. Caveman-ultra style for chat replies to David; normal prose in docs/commits. Never commit secrets (Saxo live token is in `data/saxo-tokens/live.json`).
- Rate-limit hard stop rule applies.

## 7. Where this lives

All on `main` (docs 61–68, CONTEXT.md North Star). Session prompts are in `docs/research/68-fable-handoff.md`. Each step starts once its own blockers in §5a are resolved.
